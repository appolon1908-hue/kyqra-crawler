import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const routes = JSON.parse(readFileSync(new URL('../config/routes.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const publicNginx = readFileSync(
  new URL('../config/nginx/kyqra-public.conf', import.meta.url),
  'utf8',
);

test('verified source route inventory is complete', () => {
  for (const route of [...routes.public, ...routes.private_mtls_only]) {
    const path = route.path.replace(':id', '${id}');
    assert.ok(
      source.includes(route.path) || source.includes(path) || route.path === '/',
      route.path,
    );
  }
});

test('public edge denies all job and administrative route families', () => {
  assert.match(publicNginx, /\^\/api\/v1\/jobs/);
  assert.match(publicNginx, /location = \/api\/v1\/stats \{ return 404; \}/);
  assert.match(publicNginx, /\^\/api\/v1\/webhooks/);
});

test('public edge exposes only safe health and authenticated UI', () => {
  assert.match(publicNginx, /location = \/healthz/);
  assert.match(publicNginx, /location = \/readyz/);
  assert.match(publicNginx, /auth_basic "Kyqra Crawler"/);
  assert.match(publicNginx, /location \/ \{ return 404; \}/);
});
