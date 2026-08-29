import { Job, Worker } from 'bullmq';
import { CheerioCrawler } from '@crawlee/cheerio';
import { RequestQueue, type Request, type RequestOptions } from '@crawlee/core';
import { PlaywrightCrawler } from '@crawlee/playwright';

import { browserConcurrency, httpConcurrency, jobConcurrency } from '../config/env.js';
import { jobSpecSchema, type JobSpec } from '../config/schema.js';
import { isCallbackAllowed } from '../delivery/security.js';
import { extractGenericData } from '../extract/generic.js';
import { canonicalizeUrl, urlHash } from '../frontier/canonicalize.js';
import { log } from '../observability/logger.js';
import {
  getJobMetadata,
  insertResult,
  listResultsForCallbacks,
  markJobCompleted,
  markJobFailed,
  markJobRunning,
} from '../storage/postgres/repository.js';
import type { Runtime } from '../types.js';

interface CrawlProgress {
  processed: number;
  records: number;
  failed: number;
}

interface PageRequestData {
  depth?: number;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const requestDepth = (request: Request): number => {
  const data = request.userData as PageRequestData;
  return typeof data.depth === 'number' ? data.depth : 0;
};

const shouldEnqueue = (url: string, roots: string[], spec: JobSpec): boolean =>
  roots.includes(new URL(url).hostname) &&
  !spec.excludePatterns.some((pattern) => url.includes(pattern)) &&
  (spec.includePatterns.length === 0 ||
    spec.includePatterns.some((pattern) => url.includes(pattern)));

const transformDiscoveredRequest = (
  request: RequestOptions,
  roots: string[],
  spec: JobSpec,
  depth: number,
): RequestOptions | false => {
  try {
    const normalized = canonicalizeUrl(request.url);
    if (!shouldEnqueue(normalized, roots, spec)) return false;
    request.url = normalized;
    request.userData = { depth: depth + 1 };
    return request;
  } catch {
    return false;
  }
};

const processPage = async (
  runtime: Runtime,
  job: Job<JobSpec>,
  jobId: string,
  request: Request,
  html: string,
  progress: CrawlProgress,
): Promise<void> => {
  progress.processed += 1;
  const sourceUrl = request.loadedUrl || request.url;
  const data = extractGenericData(html, sourceUrl);
  const provenance = Object.fromEntries(Object.keys(data).map((key) => [key, request.url]));
  progress.records += await insertResult(
    runtime.db,
    jobId,
    request.url,
    urlHash(request.url),
    data,
    provenance,
  );
  await job.updateProgress(progress);
};

const queueCompletionCallbacks = async (
  runtime: Runtime,
  jobId: string,
  spec: JobSpec,
  progress: CrawlProgress,
): Promise<void> => {
  const middlewareBaseUrl = (process.env.MIDDLEWARE_BASE_URL || '').replace(/\/$/, '');
  const metadata = await getJobMetadata(runtime.db, jobId);
  if (middlewareBaseUrl) {
    const rows = await listResultsForCallbacks(runtime.db, jobId);
    for (const row of rows) {
      await runtime.callbackQueue.add('result', {
        jobId,
        url: `${middlewareBaseUrl}/api/v1/kyqra/results`,
        payload: {
          job_id: jobId,
          tenant_id: metadata?.tenant_id ?? null,
          correlation_id: metadata?.correlation_id ?? null,
          record_id: row.id,
          ...row.data,
          category: row.data.category ?? null,
          confidence: row.data.confidence ?? null,
          provenance: row.provenance,
        },
      });
    }
    await runtime.callbackQueue.add('progress', {
      jobId,
      url: `${middlewareBaseUrl}/api/v1/kyqra/progress`,
      payload: {
        job_id: jobId,
        tenant_id: metadata?.tenant_id ?? null,
        correlation_id: metadata?.correlation_id ?? null,
        status: 'completed',
        ...progress,
      },
    });
  }
  if (spec.callbackUrl && isCallbackAllowed(spec.callbackUrl)) {
    await runtime.callbackQueue.add('complete', {
      jobId,
      url: spec.callbackUrl,
      payload: { job_id: jobId, status: 'completed', ...progress },
    });
  }
};

export const processCrawlJob = async (
  runtime: Runtime,
  job: Job<JobSpec>,
): Promise<CrawlProgress> => {
  const spec = jobSpecSchema.parse(job.data);
  const jobId = job.id;
  if (!jobId) throw new Error('job_id_required');
  const progress: CrawlProgress = { processed: 0, records: 0, failed: 0 };
  await markJobRunning(runtime.db, jobId);
  const roots = spec.startUrls.map((url) => new URL(url).hostname);
  const requestQueue = await RequestQueue.open(`job-${jobId}`);
  for (const url of spec.startUrls) {
    await requestQueue.addRequest({ url: canonicalizeUrl(url), userData: { depth: 0 } });
  }
  const useBrowser = spec.browser === 'playwright';
  const commonOptions = {
    requestQueue,
    maxRequestsPerCrawl: spec.maxPages,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 60,
    maxConcurrency: useBrowser ? browserConcurrency() : httpConcurrency(),
    sameDomainDelaySecs: 1 / spec.requestsPerSecond,
    failedRequestHandler: async ({ request }: { request: Request }) => {
      progress.failed += 1;
      log('warn', 'request_failed', { jobId, url: request.url });
    },
  };

  try {
    if (useBrowser) {
      await new PlaywrightCrawler({
        ...commonOptions,
        launchContext: {
          launchOptions: { headless: true, args: ['--disable-dev-shm-usage'] },
        },
        requestHandler: async (context) => {
          const depth = requestDepth(context.request);
          const html = await context.page.content();
          await processPage(runtime, job, jobId, context.request, html, progress);
          if (depth < spec.maxDepth && spec.mode !== 'single') {
            await context.enqueueLinks({
              strategy: 'same-hostname',
              transformRequestFunction: (request) =>
                transformDiscoveredRequest(request, roots, spec, depth),
            });
          }
        },
      }).run();
    } else {
      await new CheerioCrawler({
        ...commonOptions,
        requestHandler: async (context) => {
          const depth = requestDepth(context.request);
          const html = Buffer.isBuffer(context.body)
            ? context.body.toString('utf8')
            : String(context.body);
          await processPage(runtime, job, jobId, context.request, html, progress);
          if (depth < spec.maxDepth && spec.mode !== 'single') {
            await context.enqueueLinks({
              strategy: 'same-hostname',
              transformRequestFunction: (request) =>
                transformDiscoveredRequest(request, roots, spec, depth),
            });
          }
        },
      }).run();
    }
    await markJobCompleted(runtime.db, jobId, progress);
    await queueCompletionCallbacks(runtime, jobId, spec, progress);
    return progress;
  } catch (error: unknown) {
    await markJobFailed(runtime.db, jobId, errorMessage(error));
    throw error;
  }
};

export const createCrawlWorker = (runtime: Runtime): Worker<JobSpec> =>
  new Worker<JobSpec>('crawl', (job) => processCrawlJob(runtime, job), {
    connection: runtime.redisConnection,
    concurrency: jobConcurrency(),
  });
