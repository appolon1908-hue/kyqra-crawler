import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { FastifyInstance } from 'fastify';
import request, { type SuperTest, type Test } from 'supertest';
import type { Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApi } from '../../src/api/app.js';
import { closeRuntime, createRuntime } from '../../src/runtime.js';
import type { JobSpec } from '../../src/config/schema.js';
import { migrateDatabase } from '../../src/storage/postgres/migrate.js';
import type { Runtime } from '../../src/types.js';
import { createCrawlWorker } from '../../src/workers/crawl.js';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/server.js';

const POSTGRES_IMAGE =
  'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';
const REDIS_IMAGE =
  'redis:7.4-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2';
const API_TOKEN = 'fixture-api-key-not-production';
const READONLY_TOKEN = 'fixture-readonly-key-not-production';

const waitForCompleted = async (client: SuperTest<Test>, jobId: string): Promise<void> => {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const response = await client
      .get(`/api/v1/jobs/${jobId}`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    if (response.body.status === 'completed') return;
    if (response.body.status === 'failed') {
      throw new Error(`crawl failed: ${String(response.body.error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('crawl_completion_timeout');
};

describe('HTTP job submission through real Redis and Postgres', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let fixture: FixtureSite;
  let runtime: Runtime;
  let app: FastifyInstance;
  let crawlWorker: Worker<JobSpec>;
  let client: SuperTest<Test>;
  let fixtureDirectory: string;

  beforeAll(async () => {
    [postgres, redis, fixture] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase('crawler')
        .withUsername('crawler')
        .withPassword('fixture-only-not-production')
        .start(),
      new RedisContainer(REDIS_IMAGE).start(),
      startFixtureSite(),
    ]);
    fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kyqra-m1-'));
    const principalPath = path.join(fixtureDirectory, 'principals.json');
    fs.writeFileSync(
      principalPath,
      JSON.stringify({
        principals: [
          {
            key_sha256: crypto.createHash('sha256').update(API_TOKEN).digest('hex'),
            tenant_id: 'fixture-tenant',
            client_id: 'fixture-client',
            roles: ['operations'],
            enabled: true,
          },
          {
            key_sha256: crypto.createHash('sha256').update(READONLY_TOKEN).digest('hex'),
            tenant_id: 'fixture-tenant',
            client_id: 'fixture-readonly',
            roles: [],
            enabled: true,
          },
        ],
      }),
    );
    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.REDIS_HOST = redis.getHost();
    process.env.REDIS_PORT = String(redis.getPort());
    process.env.KYQRA_SERVICE_PRINCIPALS_FILE = principalPath;
    process.env.MIDDLEWARE_BASE_URL = '';
    process.env.KYQRA_ALLOW_TEST_TARGETS = 'true';
    process.env.HTTP_CONCURRENCY = '2';
    await migrateDatabase(postgres.getConnectionUri(), 'up');
    runtime = createRuntime();
    app = await buildApi(runtime);
    await app.ready();
    crawlWorker = createCrawlWorker(runtime);
    await crawlWorker.waitUntilReady();
    client = request(app.server);
  });

  afterAll(async () => {
    await app?.close();
    await crawlWorker?.close(true);
    if (runtime) await closeRuntime(runtime);
    await fixture?.close();
    await Promise.all([postgres?.stop(), redis?.stop()]);
    if (fixtureDirectory) fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  it('submits over HTTP, crawls the fixture, and persists tenant-scoped results', async () => {
    expect((await client.get('/')).status).toBe(200);
    expect((await client.get('/healthz')).body).toEqual({ status: 'ok' });
    expect((await client.get('/readyz')).body).toEqual({
      status: 'ok',
      redis: 'ok',
      postgres: 'ok',
    });
    expect((await client.get('/api/v1/stats')).status).toBe(401);
    expect(
      (await client.get('/api/v1/stats').set('Authorization', `Bearer ${READONLY_TOKEN}`)).status,
    ).toBe(403);
    expect(
      (
        await client
          .get('/api/v1/stats')
          .set('Authorization', `Bearer ${API_TOKEN}`)
          .set('X-Tenant-Id', 'wrong-tenant')
      ).status,
    ).toBe(403);
    expect(
      (
        await client
          .post('/api/v1/jobs')
          .set('Authorization', `Bearer ${API_TOKEN}`)
          .set('Idempotency-Key', 'invalid-job')
          .set('X-Correlation-Id', 'invalid-job')
          .send({ startUrls: [] })
      ).status,
    ).toBe(400);
    expect(
      (
        await client
          .post('/api/v1/jobs')
          .set('Authorization', `Bearer ${API_TOKEN}`)
          .send({ startUrls: [`${fixture.baseUrl}/static`] })
      ).body.error,
    ).toBe('idempotency_and_correlation_required');
    expect(
      (
        await client
          .post('/api/v1/jobs')
          .set('Authorization', `Bearer ${API_TOKEN}`)
          .set('Idempotency-Key', 'unsafe-callback')
          .set('X-Correlation-Id', 'unsafe-callback')
          .send({
            startUrls: [`${fixture.baseUrl}/static`],
            callbackUrl: 'https://unapproved.example.test/events',
          })
      ).body.error,
    ).toBe('callback_not_allowed');

    const submission = await client
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'fixture-static-1')
      .set('X-Correlation-Id', 'fixture-correlation-1')
      .send({
        startUrls: [`${fixture.baseUrl}/static`],
        mode: 'single',
        maxPages: 1,
        maxDepth: 0,
        browser: 'http',
      });
    expect(submission.status).toBe(202);
    expect(submission.body.status).toBe('queued');
    const jobId = String(submission.body.id);
    await waitForCompleted(client, jobId);

    const status = await client
      .get(`/api/v1/jobs/${jobId}`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(status.body).toMatchObject({ id: jobId, status: 'completed' });

    const results = await client
      .get(`/api/v1/jobs/${jobId}/results`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(results.status).toBe(200);
    expect(results.body.correlation_id).toBe('fixture-correlation-1');
    expect(results.body.count).toBe(1);
    expect(results.body.results[0].data).toMatchObject({
      business_name: 'Fixture Industries',
      email: ['hello@fixture.test'],
      address: '100 Test Avenue',
      source_url: `${fixture.baseUrl}/static`,
    });
    const stored = await runtime.db.query<{ count: string }>(
      'select count(*)::text as count from results where job_id=$1',
      [jobId],
    );
    expect(stored.rows[0]?.count).toBe('1');
    const csv = await client
      .get(`/api/v1/jobs/${jobId}/results?format=csv`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Fixture Industries');

    const replay = await client
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'fixture-static-1')
      .set('X-Correlation-Id', 'fixture-correlation-1')
      .send({
        startUrls: [`${fixture.baseUrl}/static`],
        mode: 'single',
        maxPages: 1,
        maxDepth: 0,
        browser: 'http',
      });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ id: jobId, duplicate: true });

    const conflict = await client
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'fixture-static-1')
      .set('X-Correlation-Id', 'fixture-correlation-1')
      .send({
        startUrls: [`${fixture.baseUrl}/json-ld`],
        mode: 'single',
        maxPages: 1,
        maxDepth: 0,
        browser: 'http',
      });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('idempotency_conflict');

    const stats = await client.get('/api/v1/stats').set('Authorization', `Bearer ${API_TOKEN}`);
    expect(stats.status).toBe(200);
    expect(stats.body.workers).toEqual({ http: 2, browser: 3 });

    const jobs = await client.get('/v1/jobs').set('Authorization', `Bearer ${API_TOKEN}`);
    expect(jobs.status).toBe(200);
    expect(jobs.body.items.some(({ id }: { id: string }) => id === jobId)).toBe(true);
    const events = await client
      .get(`/v1/jobs/${jobId}/events`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(events.status).toBe(200);
    expect(events.body.items.map(({ status }: { status: string }) => status)).toEqual(
      expect.arrayContaining(['queued', 'running', 'completed']),
    );
    const operation = await client
      .get(`/v1/operations/${jobId}`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(operation.body).toMatchObject({ operation_id: jobId, status: 'SUCCEEDED' });
    expect(
      (await client.get('/metrics').set('Authorization', `Bearer ${READONLY_TOKEN}`)).status,
    ).toBe(403);
    expect((await client.get('/metrics').set('Authorization', `Bearer ${API_TOKEN}`)).status).toBe(
      200,
    );
    expect((await client.get('/openapi.json')).body.paths['/api/v1/jobs']).toBeDefined();

    expect((await client.get('/health/live')).body).toEqual({ status: 'live' });
    expect((await client.get('/health/ready')).body).toEqual({
      status: 'ready',
      redis: 'ok',
      postgres: 'ok',
    });
    const identity = await client.get('/v1/me').set('Authorization', `Bearer ${API_TOKEN}`);
    expect(identity.body).toMatchObject({
      tenant_id: 'fixture-tenant',
      client_id: 'fixture-client',
      roles: ['operations'],
    });
    expect(
      (await client.get('/v1/capabilities').set('Authorization', `Bearer ${API_TOKEN}`)).body
        .capabilities,
    ).toEqual(['crawl.jobs', 'crawl.results', 'callbacks', 'operations']);
    expect(
      (await client.get('/v1/system/readiness').set('Authorization', `Bearer ${API_TOKEN}`)).body,
    ).toMatchObject({ status: 'ready', redis: 'ok', postgres: 'ok' });
    expect(
      (await client.get(`/v1/jobs/${jobId}/results`).set('Authorization', `Bearer ${API_TOKEN}`))
        .body.count,
    ).toBe(1);
    expect(
      (await client.get('/v1/operations').set('Authorization', `Bearer ${API_TOKEN}`)).body.items,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ operation_id: jobId })]));
    expect(
      (
        await client
          .get(`/v1/operations/${jobId}/events`)
          .set('Authorization', `Bearer ${API_TOKEN}`)
      ).body.items.length,
    ).toBeGreaterThan(0);
    expect(
      (
        await client
          .get(`/v1/operations/${jobId}/attempts`)
          .set('Authorization', `Bearer ${API_TOKEN}`)
      ).body.items.length,
    ).toBeGreaterThan(0);

    const callback = await client
      .post('/v1/callbacks')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'callback-create-1')
      .set('X-Correlation-Id', 'callback-create-1')
      .send({ url: 'http://10.40.0.1/callback', events: ['job.completed'] });
    expect(callback.status).toBe(201);
    const callbackId = String(callback.body.id);
    expect(
      (await client.get(`/v1/callbacks/${callbackId}`).set('Authorization', `Bearer ${API_TOKEN}`))
        .body,
    ).toMatchObject({ id: callbackId, events: ['job.completed'] });
    expect(
      (await client.get('/v1/callbacks').set('Authorization', `Bearer ${API_TOKEN}`)).body.items,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: callbackId })]));
    const callbackReplay = await client
      .post('/v1/callbacks')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'callback-create-1')
      .set('X-Correlation-Id', 'callback-create-1')
      .send({ url: 'http://10.40.0.1/callback', events: ['job.completed'] });
    expect(callbackReplay.status).toBe(201);
    expect(callbackReplay.body.id).toBe(callbackId);

    const canonicalCancel = await client
      .post(`/v1/jobs/${jobId}/cancel`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'canonical-cancel-1')
      .set('X-Correlation-Id', 'canonical-cancel-1');
    expect(canonicalCancel.status).toBe(409);
    expect(canonicalCancel.body.error).toBe('job_terminal');
    const reconciled = await client
      .post(`/v1/operations/${jobId}/reconcile`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'canonical-reconcile-1')
      .set('X-Correlation-Id', 'canonical-reconcile-1');
    expect(reconciled.status).toBe(200);
    expect(reconciled.body).toMatchObject({
      operation_id: jobId,
      status: 'completed',
      reconciliation_required: false,
    });

    const cancelled = await client
      .post(`/api/v1/jobs/${jobId}/cancel`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'terminal-cancel-1')
      .set('X-Correlation-Id', 'terminal-cancel-1');
    expect(cancelled.status).toBe(409);
    expect(cancelled.body).toEqual({ id: jobId, error: 'job_terminal' });
    const cancelledReplay = await client
      .post(`/api/v1/jobs/${jobId}/cancel`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'terminal-cancel-1')
      .set('X-Correlation-Id', 'terminal-cancel-1');
    expect(cancelledReplay.status).toBe(409);
    expect(cancelledReplay.body).toEqual(cancelled.body);

    const completedRetry = await client
      .post(`/api/v1/jobs/${jobId}/retry`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .set('Idempotency-Key', 'terminal-cancel-1')
      .set('X-Correlation-Id', 'terminal-retry-1');
    expect(completedRetry.status).toBe(409);
    expect(completedRetry.body.error).toBe('job_not_retryable');

    for (const endpoint of [
      `/api/v1/jobs/${crypto.randomUUID()}`,
      `/api/v1/jobs/${crypto.randomUUID()}/results`,
    ]) {
      expect((await client.get(endpoint).set('Authorization', `Bearer ${API_TOKEN}`)).status).toBe(
        404,
      );
    }
    expect(
      (
        await client
          .post(`/api/v1/jobs/${crypto.randomUUID()}/cancel`)
          .set('Authorization', `Bearer ${API_TOKEN}`)
      ).status,
    ).toBe(404);
    expect(
      (
        await client
          .post(`/api/v1/jobs/${crypto.randomUUID()}/retry`)
          .set('Authorization', `Bearer ${API_TOKEN}`)
      ).status,
    ).toBe(404);
    expect(
      (
        await client
          .post('/api/v1/webhooks/test')
          .set('Authorization', `Bearer ${API_TOKEN}`)
          .send({ url: 'https://unapproved.example.test/events' })
      ).status,
    ).toBe(400);
  });
});
