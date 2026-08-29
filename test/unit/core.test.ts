import { describe, expect, it } from 'vitest';

import { jobSpecSchema } from '../../src/config/schema.js';
import {
  browserConcurrency,
  httpConcurrency,
  jobConcurrency,
  redisConnectionOptions,
} from '../../src/config/env.js';
import {
  callbackSignatureInput,
  createPinnedCallbackAgent,
  isCallbackAllowed,
  isProhibitedAddress,
} from '../../src/delivery/security.js';
import { extractGenericData } from '../../src/extract/generic.js';
import { canonicalizeUrl, urlHash } from '../../src/frontier/canonicalize.js';

describe('crawler core behavior', () => {
  it('canonicalizes tracking URLs and hashes the canonical form', () => {
    const canonical = canonicalizeUrl('HTTPS://EXAMPLE.COM/path/?utm_source=test&b=2#fragment');
    expect(canonical).toBe('https://example.com/path?b=2');
    expect(urlHash('HTTPS://EXAMPLE.COM/path/?utm_source=test&b=2#fragment')).toHaveLength(64);
  });

  it('parses defaults and rejects unsafe job bounds', () => {
    const parsed = jobSpecSchema.parse({ startUrls: ['https://example.test'] });
    expect(parsed).toMatchObject({ mode: 'single', maxPages: 100, browser: 'auto' });
    expect(() =>
      jobSpecSchema.parse({ startUrls: ['https://example.test'], maxPages: 10_001 }),
    ).toThrow();
  });

  it('extracts generic contact and JSON-LD fields from fixture HTML', () => {
    const extracted = extractGenericData(
      `<html><head><title>Fixture</title><meta property="og:site_name" content="Fixture Co">
       <script type="application/ld+json">{"@type":"Organization"}</script></head>
       <body><p>SALES@FIXTURE.TEST +1 (555) 123-4567</p><address>Test Way</address></body></html>`,
      'https://fixture.test/about',
    );
    expect(extracted.business_name).toBe('Fixture Co');
    expect(extracted.email).toEqual(['sales@fixture.test']);
    expect(extracted.phone).toEqual(['+15551234567']);
    expect(extracted.schema_org).toEqual([{ '@type': 'Organization' }]);
    expect(extracted.source_url).toBe('https://fixture.test/about');
  });

  it('enforces callback allowlisting, IP denial, and stable HMAC input', () => {
    process.env.CALLBACK_ALLOWLIST = 'hooks.example.test,10.40.0.1';
    expect(isCallbackAllowed('https://hooks.example.test/events')).toBe(true);
    expect(isCallbackAllowed('https://evil.test/events')).toBe(false);
    expect(isCallbackAllowed('http://hooks.example.test/events')).toBe(false);
    expect(isProhibitedAddress('127.0.0.1')).toBe(true);
    expect(isProhibitedAddress('192.168.1.1')).toBe(true);
    expect(isProhibitedAddress('8.8.8.8')).toBe(false);
    expect(isProhibitedAddress('::1')).toBe(true);
    expect(isProhibitedAddress('2001:4860:4860::8888')).toBe(false);
    expect(callbackSignatureInput('post', '//events//done', '1', '2', 'kyqra', '{}')).toMatch(
      /^v1\nPOST\n\/events\/done\n1\n2\nkyqra\n[0-9a-f]{64}$/,
    );
  });

  it('pins the documented internal callback exception without making a request', async () => {
    process.env.CALLBACK_ALLOWLIST = '10.40.0.1';
    const agent = await createPinnedCallbackAgent('http://10.40.0.1/events');
    await agent.close();
    await expect(createPinnedCallbackAgent('https://evil.test/events')).rejects.toThrow(
      'callback_not_allowed',
    );
  });

  it('parses environment concurrency and Redis settings with safe defaults', () => {
    process.env.REDIS_HOST = 'fixture-redis';
    process.env.REDIS_PORT = '6380';
    process.env.HTTP_CONCURRENCY = '4';
    process.env.BROWSER_CONCURRENCY = '2';
    process.env.JOB_CONCURRENCY = 'invalid';
    expect(redisConnectionOptions()).toMatchObject({ host: 'fixture-redis', port: 6380 });
    expect(httpConcurrency()).toBe(4);
    expect(browserConcurrency()).toBe(2);
    expect(jobConcurrency()).toBe(2);
  });
});
