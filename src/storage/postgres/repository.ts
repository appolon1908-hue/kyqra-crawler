import type { Pool, PoolClient } from 'pg';

import type { JobSpec } from '../../config/schema.js';
import type { ExtractionData } from '../../extract/generic.js';

export interface JobMetadata {
  correlation_id: string;
  tenant_id: string;
}

export interface CallbackResultRow {
  id: string;
  data: ExtractionData;
  provenance: Record<string, string>;
}

export interface IdempotentJob {
  job_id: string;
  request_hash: string;
  correlation_id: string;
}

export interface JobStatusRow {
  id: string;
  status: string;
  progress: Record<string, unknown>;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  correlation_id: string;
}

export interface JobResultRow {
  data: ExtractionData;
  provenance: Record<string, string>;
}

export const checkPostgresReady = async (db: Pool): Promise<void> => {
  await db.query('select tenant_id,spec,budget from jobs limit 0');
};

export const markJobRunning = async (db: Pool, jobId: string): Promise<void> => {
  await db.query(
    "update jobs set status='running',started_at=coalesce(started_at,now()),updated_at=now() where id=$1",
    [jobId],
  );
};

export const insertResult = async (
  db: Pool,
  jobId: string,
  url: string,
  urlHash: string,
  data: ExtractionData,
  provenance: Record<string, string>,
): Promise<number> => {
  const result = await db.query(
    'insert into results(job_id,url,url_hash,data,provenance) values($1,$2,$3,$4,$5) on conflict do nothing returning id',
    [jobId, url, urlHash, data, provenance],
  );
  return result.rowCount ?? 0;
};

export const markJobCompleted = async (
  db: Pool,
  jobId: string,
  progress: { processed: number; records: number; failed: number },
): Promise<void> => {
  await db.query(
    "update jobs set status='completed',progress=$2,finished_at=now(),updated_at=now() where id=$1",
    [jobId, progress],
  );
};

export const getJobMetadata = async (db: Pool, jobId: string): Promise<JobMetadata | null> => {
  const result = await db.query<JobMetadata>(
    'select correlation_id,tenant_id from job_requests where job_id=$1',
    [jobId],
  );
  return result.rows[0] ?? null;
};

export const listResultsForCallbacks = async (
  db: Pool,
  jobId: string,
): Promise<CallbackResultRow[]> => {
  const result = await db.query<CallbackResultRow>(
    'select id::text,data,provenance from results where job_id=$1 order by id',
    [jobId],
  );
  return result.rows;
};

export const markJobFailed = async (db: Pool, jobId: string, error: string): Promise<void> => {
  await db.query("update jobs set status='failed',error=$2,finished_at=now() where id=$1", [
    jobId,
    error,
  ]);
};

export const findIdempotentJob = async (
  db: Pool,
  tenantId: string,
  idempotencyKey: string,
): Promise<IdempotentJob | null> => {
  const result = await db.query<IdempotentJob>(
    'select job_id,request_hash,correlation_id from job_requests where tenant_id=$1 and idempotency_key=$2',
    [tenantId, idempotencyKey],
  );
  return result.rows[0] ?? null;
};

const insertJobTransaction = async (
  client: PoolClient,
  jobId: string,
  payload: JobSpec,
  idempotencyKey: string,
  requestHash: string,
  correlationId: string,
  tenantId: string,
): Promise<void> => {
  await client.query('begin');
  try {
    await client.query("insert into jobs(id,tenant_id,status,spec) values($1,$2,'queued',$3)", [
      jobId,
      tenantId,
      payload,
    ]);
    await client.query(
      'insert into job_requests(job_id,idempotency_key,request_hash,correlation_id,tenant_id) values($1,$2,$3,$4,$5)',
      [jobId, idempotencyKey, requestHash, correlationId, tenantId],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  }
};

export const createJob = async (
  db: Pool,
  jobId: string,
  payload: JobSpec,
  idempotencyKey: string,
  requestHash: string,
  correlationId: string,
  tenantId: string,
): Promise<void> => {
  const client = await db.connect();
  try {
    await insertJobTransaction(
      client,
      jobId,
      payload,
      idempotencyKey,
      requestHash,
      correlationId,
      tenantId,
    );
  } finally {
    client.release();
  }
};

export const getJobStatus = async (
  db: Pool,
  jobId: string,
  tenantId: string,
): Promise<JobStatusRow | null> => {
  const result = await db.query<JobStatusRow>(
    'select j.id,j.status,j.progress,j.error,j.created_at,j.updated_at,m.correlation_id from jobs j join job_requests m on m.job_id=j.id where j.id=$1 and m.tenant_id=$2',
    [jobId, tenantId],
  );
  return result.rows[0] ?? null;
};

export const getJobResults = async (
  db: Pool,
  jobId: string,
  tenantId: string,
): Promise<{ correlationId: string; rows: JobResultRow[] } | null> => {
  const metadata = await db.query<{ correlation_id: string }>(
    'select correlation_id from job_requests where job_id=$1 and tenant_id=$2',
    [jobId, tenantId],
  );
  const correlationId = metadata.rows[0]?.correlation_id;
  if (!correlationId) return null;
  const results = await db.query<JobResultRow>(
    'select r.data,r.provenance from results r join job_requests m on m.job_id=r.job_id where r.job_id=$1 and m.tenant_id=$2 order by r.id',
    [jobId, tenantId],
  );
  return { correlationId, rows: results.rows };
};

export const ownsJob = async (db: Pool, jobId: string, tenantId: string): Promise<boolean> => {
  const result = await db.query('select 1 from job_requests where job_id=$1 and tenant_id=$2', [
    jobId,
    tenantId,
  ]);
  return (result.rowCount ?? 0) > 0;
};

export const cancelJob = async (db: Pool, jobId: string, tenantId: string): Promise<boolean> => {
  const result = await db.query(
    "update jobs j set status='cancelled',updated_at=now() from job_requests m where j.id=$1 and m.job_id=j.id and m.tenant_id=$2 returning j.id",
    [jobId, tenantId],
  );
  return (result.rowCount ?? 0) > 0;
};

export const getJobPayload = async (
  db: Pool,
  jobId: string,
  tenantId: string,
): Promise<JobSpec | null> => {
  const result = await db.query<{ payload: JobSpec }>(
    'select j.spec as payload from jobs j join job_requests m on m.job_id=j.id where j.id=$1 and m.tenant_id=$2',
    [jobId, tenantId],
  );
  return result.rows[0]?.payload ?? null;
};

export const resetJobQueued = async (db: Pool, jobId: string): Promise<void> => {
  await db.query(
    "update jobs set status='queued',error=null,started_at=null,finished_at=null,updated_at=now() where id=$1",
    [jobId],
  );
};
