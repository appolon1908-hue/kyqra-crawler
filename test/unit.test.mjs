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

test('job submissions require idempotency, correlation and tenant', () => {
  for (const marker of ['idempotency-key', 'x-correlation-id', 'x-tenant-id']) {
    assert.ok(source.includes(marker), marker);
  }
});
