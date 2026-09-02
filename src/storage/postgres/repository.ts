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

export interface CommandRequestRow {
  id: string;
  request_hash: string;
  correlation_id: string;
  status: 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  response_code: number | null;
  response: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface CallbackConfigRow {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export const checkPostgresReady = async (db: Pool): Promise<void> => {
  await db.query('select tenant_id,spec,budget from jobs limit 0');
  await db.query('select tenant_id,event_type,status from job_events limit 0');
  await db.query('select tenant_id,caller_id,action,status from command_requests limit 0');
  await db.query('select tenant_id,url,events from callback_configs limit 0');
};

export const markJobRunning = async (db: Pool, jobId: string): Promise<void> => {
  await db.query("select set_job_status($1,'running',$2)", [jobId, null]);
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
  await db.query("select set_job_status($1,'completed',$2)", [jobId, JSON.stringify(progress)]);
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
  await db.query("select set_job_status($1,'failed',$2)", [jobId, error.slice(0, 2000)]);
};

export const findIdempotentJob = async (
  db: Pool,
  tenantId: string,
  callerId: string,
  idempotencyKey: string,
): Promise<IdempotentJob | null> => {
  const result = await db.query<IdempotentJob>(
    `select job_id,request_hash,correlation_id from job_requests
      where tenant_id=$1 and caller_id=$2 and action='crawl.job.create'
        and api_version='api/v1' and resource='jobs' and idempotency_key=$3`,
    [tenantId, callerId, idempotencyKey],
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
  callerId: string,
): Promise<void> => {
  await client.query('begin');
  try {
    await client.query("insert into jobs(id,tenant_id,status,spec) values($1,$2,'queued',$3)", [
      jobId,
      tenantId,
      payload,
    ]);
    await client.query(
      `insert into job_requests(
         job_id,idempotency_key,request_hash,correlation_id,tenant_id,
         caller_id,action,api_version,resource
       ) values($1,$2,$3,$4,$5,$6,'crawl.job.create','api/v1','jobs')`,
      [jobId, idempotencyKey, requestHash, correlationId, tenantId, callerId],
    );
    await client.query(
      "insert into job_events(job_id,tenant_id,event_type,status,payload) values($1,$2,'job.queued','queued',$3)",
      [jobId, tenantId, { correlation_id: correlationId }],
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
  callerId: string,
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
      callerId,
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
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `update jobs j set status='cancelled',finished_at=now(),updated_at=now()
         from job_requests m
        where j.id=$1 and m.job_id=j.id and m.tenant_id=$2
          and j.status in ('queued','running') returning j.id`,
      [jobId, tenantId],
    );
    if ((result.rowCount ?? 0) === 0) {
      await client.query('rollback');
      return false;
    }
    await client.query(
      "insert into job_events(job_id,tenant_id,event_type,status,payload) values($1,$2,'job.cancelled','cancelled','{}')",
      [jobId, tenantId],
    );
    await client.query('commit');
    return true;
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
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

export const resetJobQueued = async (
  db: Pool,
  jobId: string,
  tenantId: string,
): Promise<boolean> => {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `update jobs set status='queued',error=null,started_at=null,finished_at=null,updated_at=now()
        where id=$1 and tenant_id=$2 and status in ('failed','cancelled') returning id`,
      [jobId, tenantId],
    );
    if ((result.rowCount ?? 0) === 0) {
      await client.query('rollback');
      return false;
    }
    await client.query(
      "insert into job_events(job_id,tenant_id,event_type,status,payload) values($1,$2,'job.queued','queued','{}')",
      [jobId, tenantId],
    );
    await client.query('commit');
    return true;
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};

export const listJobs = async (
  db: Pool,
  tenantId: string,
  limit: number,
): Promise<JobStatusRow[]> => {
  const result = await db.query<JobStatusRow>(
    `select j.id,j.status,j.progress,j.error,j.created_at,j.updated_at,m.correlation_id
       from jobs j join job_requests m on m.job_id=j.id
      where m.tenant_id=$1 order by j.created_at desc limit $2`,
    [tenantId, limit],
  );
  return result.rows;
};

export const getJobEvents = async (db: Pool, jobId: string, tenantId: string) => {
  const result = await db.query(
    `select id::text,event_type,status,payload,created_at
       from job_events where job_id=$1 and tenant_id=$2 order by id`,
    [jobId, tenantId],
  );
  return result.rows;
};

export const listCallbacks = async (db: Pool, tenantId: string): Promise<CallbackConfigRow[]> => {
  const result = await db.query<CallbackConfigRow>(
    'select id,url,events,enabled,created_at,updated_at from callback_configs where tenant_id=$1 order by created_at desc',
    [tenantId],
  );
  return result.rows;
};

export const getCallback = async (
  db: Pool,
  callbackId: string,
  tenantId: string,
): Promise<CallbackConfigRow | null> => {
  const result = await db.query<CallbackConfigRow>(
    'select id,url,events,enabled,created_at,updated_at from callback_configs where id=$1 and tenant_id=$2',
    [callbackId, tenantId],
  );
  return result.rows[0] ?? null;
};

export const createCallback = async (
  db: Pool,
  values: { id: string; tenantId: string; url: string; events: string[] },
): Promise<CallbackConfigRow> => {
  const result = await db.query<CallbackConfigRow>(
    `insert into callback_configs(id,tenant_id,url,events)
     values($1,$2,$3,$4)
     returning id,url,events,enabled,created_at,updated_at`,
    [values.id, values.tenantId, values.url, values.events],
  );
  const row = result.rows[0];
  if (!row) throw new Error('callback_insert_failed');
  return row;
};

export const beginCommand = async (
  db: Pool,
  values: {
    id: string;
    tenantId: string;
    callerId: string;
    action: string;
    resource: string;
    idempotencyKey: string;
    requestHash: string;
    correlationId: string;
  },
): Promise<{ row: CommandRequestRow; duplicate: boolean }> => {
  const inserted = await db.query<CommandRequestRow>(
    `insert into command_requests(
       id,tenant_id,caller_id,action,api_version,resource,idempotency_key,
       request_hash,correlation_id,status
     ) values($1,$2,$3,$4,'api/v1',$5,$6,$7,$8,'PROCESSING')
     on conflict (tenant_id,caller_id,action,api_version,resource,idempotency_key)
     do nothing
     returning id,request_hash,correlation_id,status,response_code,response,created_at,updated_at`,
    [
      values.id,
      values.tenantId,
      values.callerId,
      values.action,
      values.resource,
      values.idempotencyKey,
      values.requestHash,
      values.correlationId,
    ],
  );
  const created = inserted.rows[0];
  if (created) return { row: created, duplicate: false };
  const prior = await db.query<CommandRequestRow>(
    `select id,request_hash,correlation_id,status,response_code,response,created_at,updated_at
       from command_requests
      where tenant_id=$1 and caller_id=$2 and action=$3 and api_version='api/v1'
        and resource=$4 and idempotency_key=$5`,
    [values.tenantId, values.callerId, values.action, values.resource, values.idempotencyKey],
  );
  const existing = prior.rows[0];
  if (!existing) throw new Error('idempotency_readback_failed');
  if (existing.request_hash !== values.requestHash) {
    throw new Error('idempotency_conflict');
  }
  return { row: existing, duplicate: true };
};

export const completeCommand = async (
  db: Pool,
  commandId: string,
  responseCode: number,
  response: Record<string, unknown>,
): Promise<void> => {
  const result = await db.query(
    `update command_requests
        set status=$2,response_code=$3,response=$4,updated_at=now()
      where id=$1 and status='PROCESSING'`,
    [
      commandId,
      responseCode >= 200 && responseCode < 400 ? 'SUCCEEDED' : 'FAILED',
      responseCode,
      response,
    ],
  );
  if ((result.rowCount ?? 0) !== 1) throw new Error('command_completion_conflict');
};
