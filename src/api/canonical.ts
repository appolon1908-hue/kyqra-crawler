import crypto from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { jobSpecSchema } from '../config/schema.js';
import { isCallbackAllowed, validateCrawlTarget } from '../delivery/security.js';
import {
  cancelJob,
  createCallback,
  createJob,
  findIdempotentJob,
  getCallback,
  getJobEvents,
  getJobPayload,
  getJobResults,
  getJobStatus,
  listCallbacks,
  listJobs,
  ownsJob,
  resetJobQueued,
} from '../storage/postgres/repository.js';
import type { Runtime } from '../types.js';
import { kyqraOpenApi } from './openapi.js';

interface IdParams {
  id: string;
}
interface ResultsQuery {
  format?: string;
}
interface CallbackBody {
  url?: string;
  events?: string[];
}

const notFound = (reply: FastifyReply): FastifyReply =>
  reply.code(404).send({ error: 'not_found' });
const semanticHash = (value: unknown): string =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

const requireCommandHeaders = (request: FastifyRequest, reply: FastifyReply) => {
  const idempotencyKey = String(request.headers['idempotency-key'] || '');
  const correlationId = String(request.headers['x-correlation-id'] || '');
  if (idempotencyKey.length < 8 || correlationId.length < 8) {
    reply.code(400).send({ error: 'idempotency_and_correlation_required' });
    return null;
  }
  return { idempotencyKey, correlationId };
};

const enforceRate = async (runtime: Runtime, tenantId: string): Promise<void> => {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `kyqra:rate:${tenantId}:${minute}`;
  const value = await runtime.redis.incr(key);
  if (value === 1) await runtime.redis.expire(key, 120);
  const limit = Number(process.env.KYQRA_JOBS_PER_MINUTE || 30);
  if (value > (Number.isSafeInteger(limit) && limit > 0 ? limit : 30)) {
    throw new Error('rate_limit_exceeded');
  }
};

export const registerCanonicalApi = (app: FastifyInstance, runtime: Runtime): void => {
  app.get('/health/live', async () => ({ status: 'live' }));
  app.get('/health/ready', async () => {
    await runtime.redis.ping();
    await runtime.db.query('select 1');
    return { status: 'ready', redis: 'ok', postgres: 'ok' };
  });
  app.get('/openapi.json', async () => kyqraOpenApi);

  app.get('/v1/me', async (request) => ({
    tenant_id: request.servicePrincipal.tenant_id,
    client_id: request.servicePrincipal.client_id,
    roles: request.servicePrincipal.roles || [],
  }));
  app.get('/v1/capabilities', async (request) => ({
    tenant_id: request.servicePrincipal.tenant_id,
    capabilities: ['crawl.jobs', 'crawl.results', 'callbacks', 'operations'],
  }));

  app.post('/v1/jobs', async (request, reply) => {
    const parsed = jobSpecSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid_job', details: parsed.error.issues });
    const headers = requireCommandHeaders(request, reply);
    if (!headers) return;
    try {
      await Promise.all(parsed.data.startUrls.map((url) => validateCrawlTarget(url)));
      await enforceRate(runtime, request.servicePrincipal.tenant_id);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'target_rejected';
      return reply.code(message === 'rate_limit_exceeded' ? 429 : 400).send({ error: message });
    }
    if (parsed.data.callbackUrl && !isCallbackAllowed(parsed.data.callbackUrl)) {
      return reply.code(400).send({ error: 'callback_not_allowed' });
    }
    const tenantId = request.servicePrincipal.tenant_id;
    const requestHash = semanticHash(parsed.data);
    const prior = await findIdempotentJob(runtime.db, tenantId, headers.idempotencyKey);
    if (prior) {
      if (prior.request_hash !== requestHash)
        return reply.code(409).send({ error: 'idempotency_conflict' });
      return {
        id: prior.job_id,
        operation_id: prior.job_id,
        status: 'queued',
        duplicate: true,
        correlation_id: prior.correlation_id,
      };
    }
    const id = crypto.randomUUID();
    await createJob(
      runtime.db,
      id,
      parsed.data,
      headers.idempotencyKey,
      requestHash,
      headers.correlationId,
      tenantId,
    );
    await runtime.crawlQueue.add('crawl', parsed.data, { jobId: id });
    return reply.code(202).send({
      id,
      operation_id: id,
      status: 'queued',
      duplicate: false,
      correlation_id: headers.correlationId,
    });
  });

  app.get('/v1/jobs', async (request) => ({
    items: await listJobs(runtime.db, request.servicePrincipal.tenant_id, 200),
  }));
  app.get<{ Params: IdParams }>(
    '/v1/jobs/:id',
    async (request, reply) =>
      (await getJobStatus(runtime.db, request.params.id, request.servicePrincipal.tenant_id)) ??
      notFound(reply),
  );
  app.get<{ Params: IdParams; Querystring: ResultsQuery }>(
    '/v1/jobs/:id/results',
    async (request, reply) => {
      const result = await getJobResults(
        runtime.db,
        request.params.id,
        request.servicePrincipal.tenant_id,
      );
      if (!result) return notFound(reply);
      if (request.query.format === 'csv') {
        const header = 'source_url,business_name,website,phone,email,address\n';
        const lines = result.rows.map(({ data }) =>
          [
            data.source_url,
            data.business_name,
            data.website,
            data.phone.join(';'),
            data.email.join(';'),
            data.address,
          ]
            .map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`)
            .join(','),
        );
        return reply.type('text/csv').send(header + lines.join('\n'));
      }
      return {
        count: result.rows.length,
        correlation_id: result.correlationId,
        results: result.rows,
      };
    },
  );
  app.get<{ Params: IdParams }>('/v1/jobs/:id/events', async (request, reply) => {
    if (!(await ownsJob(runtime.db, request.params.id, request.servicePrincipal.tenant_id)))
      return notFound(reply);
    return {
      job_id: request.params.id,
      items: await getJobEvents(runtime.db, request.params.id, request.servicePrincipal.tenant_id),
    };
  });
  app.post<{ Params: IdParams }>('/v1/jobs/:id/cancel', async (request, reply) => {
    const current = await getJobStatus(
      runtime.db,
      request.params.id,
      request.servicePrincipal.tenant_id,
    );
    if (!current) return notFound(reply);
    if (['completed', 'failed', 'cancelled'].includes(current.status))
      return reply.code(409).send({ error: 'job_terminal' });
    const queued = await runtime.crawlQueue.getJob(request.params.id);
    if (queued) await queued.remove().catch(() => undefined);
    await cancelJob(runtime.db, request.params.id, request.servicePrincipal.tenant_id);
    return { id: request.params.id, status: 'cancelled' };
  });
  app.post<{ Params: IdParams }>('/v1/jobs/:id/retry', async (request, reply) => {
    const payload = await getJobPayload(
      runtime.db,
      request.params.id,
      request.servicePrincipal.tenant_id,
    );
    if (!payload) return notFound(reply);
    const queued = await runtime.crawlQueue.getJob(request.params.id);
    if (queued) await queued.remove().catch(() => undefined);
    await resetJobQueued(runtime.db, request.params.id);
    await runtime.crawlQueue.add('crawl', payload, { jobId: request.params.id });
    return reply.code(202).send({ id: request.params.id, status: 'queued' });
  });

  app.get('/v1/callbacks', async (request) => ({
    items: await listCallbacks(runtime.db, request.servicePrincipal.tenant_id),
  }));
  app.post<{ Body: CallbackBody }>('/v1/callbacks', async (request, reply) => {
    const headers = requireCommandHeaders(request, reply);
    if (!headers) return;
    if (!request.body?.url || !isCallbackAllowed(request.body.url))
      return reply.code(400).send({ error: 'callback_not_allowed' });
    const events = [...new Set(request.body.events || ['job.completed', 'job.failed'])].sort();
    if (events.length === 0 || events.length > 20)
      return reply.code(400).send({ error: 'invalid_callback_events' });
    try {
      const result = await createCallback(runtime.db, {
        id: crypto.randomUUID(),
        tenantId: request.servicePrincipal.tenant_id,
        url: request.body.url,
        events,
        idempotencyKey: headers.idempotencyKey,
        requestHash: semanticHash({ url: request.body.url, events }),
      });
      return reply.code(result.duplicate ? 200 : 201).send({
        ...result.row,
        duplicate: result.duplicate,
        correlation_id: headers.correlationId,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'idempotency_conflict')
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
  app.get<{ Params: IdParams }>(
    '/v1/callbacks/:id',
    async (request, reply) =>
      (await getCallback(runtime.db, request.params.id, request.servicePrincipal.tenant_id)) ??
      notFound(reply),
  );

  app.get('/v1/operations', async (request) => ({
    items: await listJobs(runtime.db, request.servicePrincipal.tenant_id, 200),
  }));
  app.get<{ Params: IdParams }>(
    '/v1/operations/:id',
    async (request, reply) =>
      (await getJobStatus(runtime.db, request.params.id, request.servicePrincipal.tenant_id)) ??
      notFound(reply),
  );
  app.get<{ Params: IdParams }>('/v1/operations/:id/events', async (request, reply) => {
    if (!(await ownsJob(runtime.db, request.params.id, request.servicePrincipal.tenant_id)))
      return notFound(reply);
    return {
      operation_id: request.params.id,
      items: await getJobEvents(runtime.db, request.params.id, request.servicePrincipal.tenant_id),
    };
  });
  app.get<{ Params: IdParams }>('/v1/operations/:id/attempts', async (request, reply) => {
    if (!(await ownsJob(runtime.db, request.params.id, request.servicePrincipal.tenant_id)))
      return notFound(reply);
    const events = await getJobEvents(
      runtime.db,
      request.params.id,
      request.servicePrincipal.tenant_id,
    );
    return {
      operation_id: request.params.id,
      items: events.filter(({ status }) => ['running', 'failed', 'completed'].includes(status)),
    };
  });
  app.post<{ Params: IdParams }>('/v1/operations/:id/cancel', async (request, reply) => {
    const current = await getJobStatus(
      runtime.db,
      request.params.id,
      request.servicePrincipal.tenant_id,
    );
    if (!current) return notFound(reply);
    if (['completed', 'failed', 'cancelled'].includes(current.status))
      return reply.code(409).send({ error: 'operation_terminal' });
    if (!(await cancelJob(runtime.db, request.params.id, request.servicePrincipal.tenant_id)))
      return notFound(reply);
    return { operation_id: request.params.id, status: 'cancelled' };
  });
  app.post<{ Params: IdParams }>('/v1/operations/:id/reconcile', async (request, reply) => {
    const job = await getJobStatus(
      runtime.db,
      request.params.id,
      request.servicePrincipal.tenant_id,
    );
    if (!job) return notFound(reply);
    if (!['failed', 'cancelled'].includes(job.status))
      return { operation_id: job.id, status: job.status, reconciliation_required: false };
    const payload = await getJobPayload(runtime.db, job.id, request.servicePrincipal.tenant_id);
    if (!payload) return notFound(reply);
    await resetJobQueued(runtime.db, job.id);
    await runtime.crawlQueue.add('crawl', payload, { jobId: job.id });
    return reply
      .code(202)
      .send({ operation_id: job.id, status: 'queued', reconciliation_required: false });
  });

  app.get('/metrics', async (_request, reply) => {
    const counts = await runtime.db.query<{ status: string; count: string }>(
      'select status,count(*)::text as count from jobs group by status',
    );
    const body =
      [
        '# HELP kyqra_jobs Jobs by durable state',
        '# TYPE kyqra_jobs gauge',
        ...counts.rows.map(
          ({ status, count }) => `kyqra_jobs{status="${status.replaceAll('"', '')}"} ${count}`,
        ),
      ].join('\n') + '\n';
    return reply.type('text/plain; version=0.0.4').send(body);
  });
  app.get('/v1/system/readiness', async () => {
    await runtime.redis.ping();
    await runtime.db.query('select 1');
    return {
      status: 'ready',
      redis: 'ok',
      postgres: 'ok',
      source_sha: process.env.SOURCE_SHA || 'development',
    };
  });
};
