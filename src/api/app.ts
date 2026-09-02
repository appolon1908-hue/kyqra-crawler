import crypto from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import { browserConcurrency, httpConcurrency } from '../config/env.js';
import { jobSpecSchema } from '../config/schema.js';
import { isCallbackAllowed } from '../delivery/security.js';
import {
  cancelJob,
  checkPostgresReady,
  createJob,
  findIdempotentJob,
  getJobPayload,
  getJobResults,
  getJobStatus,
  ownsJob,
  resetJobQueued,
  type JobResultRow,
} from '../storage/postgres/repository.js';
import type { Runtime } from '../types.js';
import { authenticate } from './auth.js';
import { registerCanonicalApi } from './canonical.js';
import { dashboardHtml } from './dashboard.js';

interface JobParams {
  id: string;
}

interface ResultsQuery {
  format?: string;
}

interface WebhookTestBody {
  url?: string;
}

const publicPaths = [
  '/',
  '/health',
  '/healthz',
  '/readyz',
  '/health/live',
  '/health/ready',
  '/api/v1/health',
  '/openapi.json',
];

const csvEscape = (value: unknown): string => `"${String(value ?? '').replaceAll('"', '""')}"`;

const resultsCsv = (rows: JobResultRow[]): string =>
  `source_url,business_name,website,phone,email,address\n${rows
    .map((row) =>
      [
        row.data.source_url,
        row.data.business_name,
        row.data.website,
        row.data.phone.join(';'),
        row.data.email.join(';'),
        row.data.address,
      ]
        .map(csvEscape)
        .join(','),
    )
    .join('\n')}`;

const removeQueuedJob = async (runtime: Runtime, jobId: string): Promise<void> => {
  const queuedJob = await runtime.crawlQueue.getJob(jobId);
  if (queuedJob) await queuedJob.remove().catch(() => undefined);
};

const notFound = (reply: FastifyReply): FastifyReply =>
  reply.code(404).send({ error: 'not_found' });

export const buildApi = async (runtime: Runtime): Promise<FastifyInstance> => {
  const app = Fastify({ bodyLimit: 2_000_000 });
  const live = async (): Promise<{ status: string }> => ({ status: 'ok' });
  const ready = async (): Promise<{ status: string; redis: string; postgres: string }> => {
    await runtime.redis.ping();
    await checkPostgresReady(runtime.db);
    return { status: 'ok', redis: 'ok', postgres: 'ok' };
  };

  app.get('/health', ready);
  app.get('/healthz', live);
  app.get('/readyz', ready);
  app.get('/api/v1/health', live);
  app.addHook('onRequest', (request, reply, done) => {
    if (publicPaths.includes(request.url)) done();
    else authenticate(request, reply, done);
  });

  app.post('/api/v1/jobs', async (request, reply) => {
    const parsed = jobSpecSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_job', details: parsed.error.issues });
    }
    if (parsed.data.callbackUrl && !isCallbackAllowed(parsed.data.callbackUrl)) {
      return reply.code(400).send({ error: 'callback_not_allowed' });
    }
    const idempotencyKey = String(request.headers['idempotency-key'] || '');
    const correlationId = String(request.headers['x-correlation-id'] || '');
    const tenantId = request.servicePrincipal.tenant_id;
    if (!idempotencyKey || !correlationId) {
      return reply.code(400).send({ error: 'idempotency_and_correlation_required' });
    }
    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(parsed.data))
      .digest('hex');
    const prior = await findIdempotentJob(runtime.db, tenantId, idempotencyKey);
    if (prior) {
      if (prior.request_hash !== requestHash) {
        return reply.code(409).send({ error: 'idempotency_conflict' });
      }
      return reply.code(200).send({
        id: prior.job_id,
        status: 'duplicate',
        duplicate: true,
        correlation_id: prior.correlation_id,
      });
    }
    const jobId = crypto.randomUUID();
    await createJob(
      runtime.db,
      jobId,
      parsed.data,
      idempotencyKey,
      requestHash,
      correlationId,
      tenantId,
    );
    await runtime.crawlQueue.add('crawl', parsed.data, { jobId });
    return reply.code(202).send({
      id: jobId,
      status: 'queued',
      duplicate: false,
      correlation_id: correlationId,
    });
  });

  app.get<{ Params: JobParams }>('/api/v1/jobs/:id', async (request, reply) => {
    const status = await getJobStatus(
      runtime.db,
      request.params.id,
      request.servicePrincipal.tenant_id,
    );
    return status ?? notFound(reply);
  });

  app.get<{ Params: JobParams; Querystring: ResultsQuery }>(
    '/api/v1/jobs/:id/results',
    async (request, reply) => {
      const results = await getJobResults(
        runtime.db,
        request.params.id,
        request.servicePrincipal.tenant_id,
      );
      if (!results) return notFound(reply);
      if (request.query.format === 'csv') {
        return reply.type('text/csv').send(resultsCsv(results.rows));
      }
      return {
        count: results.rows.length,
        correlation_id: results.correlationId,
        results: results.rows,
      };
    },
  );

  app.post<{ Params: JobParams }>('/api/v1/jobs/:id/cancel', async (request, reply) => {
    if (!(await ownsJob(runtime.db, request.params.id, request.servicePrincipal.tenant_id))) {
      return notFound(reply);
    }
    await removeQueuedJob(runtime, request.params.id);
    const cancelled = await cancelJob(
      runtime.db,
      request.params.id,
      request.servicePrincipal.tenant_id,
    );
    return cancelled ? { id: request.params.id, status: 'cancelled' } : notFound(reply);
  });

  app.post<{ Params: JobParams }>('/api/v1/jobs/:id/retry', async (request, reply) => {
    const payload = await getJobPayload(
      runtime.db,
      request.params.id,
      request.servicePrincipal.tenant_id,
    );
    if (!payload) return notFound(reply);
    await removeQueuedJob(runtime, request.params.id);
    await resetJobQueued(runtime.db, request.params.id);
    await runtime.crawlQueue.add('crawl', payload, { jobId: request.params.id });
    return reply.code(202).send({ id: request.params.id, status: 'accepted' });
  });

  app.get('/api/v1/stats', async (request, reply) => {
    if (!request.servicePrincipal.roles?.includes('operations')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    return {
      queue: await runtime.crawlQueue.getJobCounts(),
      workers: { http: httpConcurrency(), browser: browserConcurrency() },
    };
  });

  app.post<{ Body: WebhookTestBody }>('/api/v1/webhooks/test', async (request, reply) => {
    if (!request.body?.url || !isCallbackAllowed(request.body.url)) {
      return reply.code(400).send({ error: 'callback_not_allowed' });
    }
    await runtime.callbackQueue.add('test', {
      jobId: 'test',
      url: request.body.url,
      event: 'test',
    });
    return { queued: true };
  });

  registerCanonicalApi(app, runtime);

  app.get('/', async (_request, reply) => reply.type('text/html').send(dashboardHtml()));
  return app;
};

export const startApi = async (runtime: Runtime): Promise<FastifyInstance> => {
  const app = await buildApi(runtime);
  await app.listen({ host: '0.0.0.0', port: 3000 });
  return app;
};
