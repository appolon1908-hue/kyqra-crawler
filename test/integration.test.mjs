import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

test('safe liveness and readiness endpoints are registered', () => {
  assert.match(source, /a\.get\('\/healthz',\s*live\)/);
  assert.match(source, /a\.get\('\/readyz',\s*ready\)/);
});

test('readiness checks Redis and PostgreSQL without returning data', () => {
  assert.match(source, /redis\.ping\(\)/);
  assert.match(source, /db\.query\('select 1'\)/);
  assert.match(source, /status:\s*'ok',\s*redis:\s*'ok',\s*postgres:\s*'ok'/);
});
