import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import type { JobSpec } from './config/schema.js';
import type { RedisConnectionOptions } from './config/env.js';

export interface ServicePrincipal {
  key_sha256: string;
  tenant_id: string;
  client_id: string;
  roles?: string[];
  enabled: boolean;
}

export interface CallbackJobData {
  jobId: string;
  url: string;
  payload?: Record<string, unknown>;
  event?: string;
}

export interface Runtime {
  db: Pool;
  redis: Redis;
  crawlQueue: Queue<JobSpec>;
  callbackQueue: Queue<CallbackJobData>;
  redisConnection: RedisConnectionOptions;
}
