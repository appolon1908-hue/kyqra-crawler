import type { JobSpec } from '../config/schema.js';
import { isCallbackAllowed } from '../delivery/security.js';
import { getJobMetadata, listResultsForCallbacks } from '../storage/postgres/repository.js';
import type { Runtime } from '../types.js';

export interface CompletionProgress {
  processed: number;
  records: number;
  failed: number;
}

export const storedCompletionProgress = (value: Record<string, unknown>): CompletionProgress => ({
  processed: Number.isSafeInteger(value.processed) ? Number(value.processed) : 0,
  records: Number.isSafeInteger(value.records) ? Number(value.records) : 0,
  failed: Number.isSafeInteger(value.failed) ? Number(value.failed) : 0,
});

export const queueCompletionCallbacks = async (
  runtime: Runtime,
  jobId: string,
  spec: JobSpec,
  progress: CompletionProgress,
): Promise<void> => {
  const middlewareBaseUrl = (process.env.MIDDLEWARE_BASE_URL || '').replace(/\/$/, '');
  const metadata = await getJobMetadata(runtime.db, jobId);
  if (middlewareBaseUrl) {
    const rows = await listResultsForCallbacks(runtime.db, jobId);
    for (const row of rows) {
      await runtime.callbackQueue.add(
        'result',
        {
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
        },
        { jobId: `kyqra-result-${jobId}-${row.id}` },
      );
    }
    await runtime.callbackQueue.add(
      'progress',
      {
        jobId,
        url: `${middlewareBaseUrl}/api/v1/kyqra/progress`,
        payload: {
          job_id: jobId,
          tenant_id: metadata?.tenant_id ?? null,
          correlation_id: metadata?.correlation_id ?? null,
          status: 'completed',
          ...progress,
        },
      },
      { jobId: `kyqra-progress-${jobId}` },
    );
  }
  if (spec.callbackUrl && isCallbackAllowed(spec.callbackUrl)) {
    await runtime.callbackQueue.add(
      'complete',
      {
        jobId,
        url: spec.callbackUrl,
        payload: { job_id: jobId, status: 'completed', ...progress },
      },
      { jobId: `kyqra-complete-${jobId}` },
    );
  }
};
