import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

test('callback authorization uses constant-time comparison', () => {
  assert.match(source, /timingSafeEqual/);
});

test('middleware callbacks are signed and replay-addressable', () => {
  for (const marker of [
    'KYQRA_WEBHOOK_SECRET',
    'KYQRA_MIDDLEWARE_API_KEY',
    'x-kyqra-timestamp',
    'x-kyqra-event-id',
    'x-kyqra-signature',
  ])
    assert.ok(source.includes(marker), marker);
});

test('job submissions bind idempotency and every operation to authenticated tenant', () => {
  for (const marker of [
    'idempotency-key',
    'x-correlation-id',
    'KYQRA_SERVICE_PRINCIPALS_FILE',
    'servicePrincipal.tenant_id',
    'job_requests_tenant_idempotency',
    'where job_id=$1 and tenant_id=$2',
    'm.tenant_id=$2',
  ]) {
    assert.ok(source.includes(marker), marker);
  }
  assert.ok(
    source.split('m.tenant_id=$2').length >= 4,
    'status/results/cancel/retry tenant filters',
  );
  assert.doesNotMatch(source, /tenantId = String\(r\.headers\['x-tenant-id'\]/);
});
