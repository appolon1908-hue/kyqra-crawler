import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const privateNginx = readFileSync(
  new URL('../config/nginx/kyqra-private-mtls.conf.template', import.meta.url),
  'utf8',
);
const sudoers = readFileSync(
  new URL('../config/codestra-kyqra-remediation.sudoers', import.meta.url),
  'utf8',
);
const installer = readFileSync(
  new URL('../scripts/codestra-kyqra-remediation-admin.in', import.meta.url),
  'utf8',
);

test('backend is loopback-only and data stores are unpublished', () => {
  assert.match(compose, /127\.0\.0\.1:3100:3000/);
  assert.doesNotMatch(compose, /10\.40\.0\.4:3100:3000|0\.0\.0\.0:3100|3100:3000"\]/);
  assert.doesNotMatch(compose, /ports:\s*\[[^\]]*(5432|6379)/);
});

test('api receives tenant-bound principals through a read-only Docker secret', () => {
  assert.match(compose, /KYQRA_SERVICE_PRINCIPALS_FILE: \/run\/secrets\/kyqra_service_principals/);
  assert.match(compose, /secrets: \[kyqra_service_principals\]/);
  assert.doesNotMatch(compose, /API_KEY:/);
});

test('container is non-root and every image reference is immutable', () => {
  assert.match(dockerfile, /USER pwuser/);
  assert.match(dockerfile, /FROM .*@sha256:[0-9a-f]{64}/);
  for (const line of compose.split('\n').filter((line) => line.trim().startsWith('image:'))) {
    assert.match(line, /@sha256|KYQRA_IMAGE/);
  }
});

test('private gateway requires exact client identity and modern TLS', () => {
  assert.match(privateNginx, /ssl_verify_client on/);
  assert.match(privateNginx, /CN=middleware-kyqra-client/);
  assert.match(privateNginx, /ssl_client_serial/);
  assert.match(privateNginx, /ssl_protocols TLSv1\.2 TLSv1\.3/);
  assert.match(privateNginx, /proxy_pass http:\/\/127\.0\.0\.1:3100/);
});

test('repository contains no private key file', () => {
  const files = readdirSync(new URL('../', import.meta.url), { recursive: true }).filter(
    (name) => !String(name).startsWith('node_modules/') && !String(name).startsWith('.git/'),
  );
  assert.equal(
    files.some((name) => /(^|\/)(id_rsa|id_ed25519|.*\.key|\.env)$/.test(String(name))),
    false,
  );
});

test('sudo policy grants only fixed installer subcommands', () => {
  assert.doesNotMatch(sudoers, /NOPASSWD:\s*ALL|\/bin\/(ba)?sh|sudoedit|docker \*|ufw \*/);
  for (const op of [
    'status',
    'preflight',
    'install',
    'validate',
    'verify',
    'rollback',
    'cleanup-staging',
  ]) {
    assert.match(sudoers, new RegExp(`codestra-kyqra-remediation-admin ${op}`));
  }
});

test('installer fixes managed paths and rejects arbitrary arguments', () => {
  assert.match(installer, /\[\[ \$# -eq 1 \]\]/);
  assert.match(installer, /INVALID_SUBCOMMAND/);
  assert.match(installer, /RELEASE_SYMLINK_DENIED/);
  assert.match(installer, /RELEASE_SIGNATURE_INVALID/);
  assert.match(installer, /automatic-rollback/);
});
