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

export const initializeSchema = async (db: Pool): Promise<void> => {
  await db.query(
    `CREATE TABLE IF NOT EXISTS jobs(id uuid primary key,status text,payload jsonb,progress jsonb default '{}',error text,created_at timestamptz default now(),updated_at timestamptz default now());CREATE TABLE IF NOT EXISTS results(id bigserial primary key,job_id uuid references jobs(id) on delete cascade,url text,url_hash text,data jsonb,provenance jsonb,created_at timestamptz default now(),unique(job_id,url_hash));CREATE TABLE IF NOT EXISTS job_requests(job_id uuid primary key references jobs(id) on delete cascade,idempotency_key text not null,request_hash text not null,correlation_id text not null,tenant_id text not null);ALTER TABLE job_requests ADD COLUMN IF NOT EXISTS tenant_id text;ALTER TABLE job_requests ALTER COLUMN tenant_id SET NOT NULL;ALTER TABLE job_requests DROP CONSTRAINT IF EXISTS job_requests_idempotency_key_key;CREATE UNIQUE INDEX IF NOT EXISTS job_requests_tenant_idempotency ON job_requests(tenant_id,idempotency_key);CREATE INDEX IF NOT EXISTS results_job ON results(job_id)`,
  );
};

export const markJobRunning = async (db: Pool, jobId: string): Promise<void> => {
  await db.query("update jobs set status='running',updated_at=now() where id=$1", [jobId]);
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
  await db.query("update jobs set status='completed',progress=$2,updated_at=now() where id=$1", [
    jobId,
    progress,
  ]);
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
  await db.query("update jobs set status='failed',error=$2 where id=$1", [jobId, error]);
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
    await client.query("insert into jobs(id,status,payload) values($1,'queued',$2)", [
      jobId,
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
    'select j.payload from jobs j join job_requests m on m.job_id=j.id where j.id=$1 and m.tenant_id=$2',
    [jobId, tenantId],
  );
  return result.rows[0]?.payload ?? null;
};

export const resetJobQueued = async (db: Pool, jobId: string): Promise<void> => {
  await db.query("update jobs set status='queued',error=null,updated_at=now() where id=$1", [
    jobId,
  ]);
};
