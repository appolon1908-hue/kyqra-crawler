import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { kyqraOpenApi } from '../../src/api/openapi.js';
import { validateCrawlTarget } from '../../src/delivery/security.js';

describe('canonical production API contract', () => {
  it('documents every required Kyqra API family', () => {
    const required: Array<[string, keyof typeof kyqraOpenApi.paths]> = [
      ['get', '/v1/me'],
      ['get', '/v1/capabilities'],
      ['post', '/v1/jobs'],
      ['get', '/v1/jobs'],
      ['get', '/v1/jobs/{id}'],
      ['post', '/v1/jobs/{id}/cancel'],
      ['post', '/v1/jobs/{id}/retry'],
      ['get', '/v1/jobs/{id}/results'],
      ['get', '/v1/jobs/{id}/events'],
      ['get', '/v1/callbacks'],
      ['post', '/v1/callbacks'],
      ['get', '/v1/callbacks/{id}'],
      ['get', '/v1/operations'],
      ['get', '/v1/operations/{id}'],
      ['get', '/v1/operations/{id}/events'],
      ['get', '/v1/operations/{id}/attempts'],
      ['post', '/v1/operations/{id}/cancel'],
      ['post', '/v1/operations/{id}/reconcile'],
      ['get', '/health/live'],
      ['get', '/health/ready'],
      ['get', '/metrics'],
      ['get', '/v1/system/readiness'],
    ];
    for (const [method, path] of required) expect(method in kyqraOpenApi.paths[path]).toBe(true);
  });

  it('denies loopback and cloud metadata crawl targets by default', async () => {
    delete process.env.KYQRA_ALLOW_TEST_TARGETS;
    await expect(validateCrawlTarget('http://127.0.0.1/')).rejects.toThrow('private_address');
    await expect(validateCrawlTarget('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      'private_address',
    );
    await expect(validateCrawlTarget('http://metadata.google.internal/')).rejects.toThrow('denied');
  });

  it('ships explicit reversible schema migrations', () => {
    const migration = fs.readFileSync('migrations/0003_canonical_operations.sql', 'utf8');
    expect(migration).toContain('CREATE TABLE job_events');
    expect(migration).toContain('CREATE TABLE callback_configs');
    expect(migration).toContain('-- Down Migration');
  });
});
