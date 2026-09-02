import { readFileSync } from 'node:fs';

export interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
  maxRetriesPerRequest: null;
}

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const redisPassword = (): string | undefined => {
  const file = process.env.REDIS_PASSWORD_FILE?.trim();
  const direct = process.env.REDIS_PASSWORD?.trim();
  if (file && direct) throw new Error('configure only REDIS_PASSWORD_FILE or REDIS_PASSWORD');
  const value = file ? readFileSync(file, 'utf8').trim() : direct;
  if (value && !/^[A-Za-z0-9_-]{32,200}$/.test(value))
    throw new Error('Redis password must be a 32-200 character URL-safe token');
  return value || undefined;
};

export const redisConnectionOptions = (): RedisConnectionOptions => {
  const password = redisPassword();
  return {
    host: process.env.REDIS_HOST || 'redis',
    port: positiveInteger(process.env.REDIS_PORT, 6379),
    ...(password ? { password } : {}),
    maxRetriesPerRequest: null,
  };
};

export const httpConcurrency = (): number => positiveInteger(process.env.HTTP_CONCURRENCY, 15);

export const browserConcurrency = (): number => positiveInteger(process.env.BROWSER_CONCURRENCY, 3);

export const jobConcurrency = (): number => positiveInteger(process.env.JOB_CONCURRENCY, 2);
