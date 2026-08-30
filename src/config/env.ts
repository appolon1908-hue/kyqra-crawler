export interface RedisConnectionOptions {
  host: string;
  port: number;
  maxRetriesPerRequest: null;
}

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const redisConnectionOptions = (): RedisConnectionOptions => ({
  host: process.env.REDIS_HOST || 'redis',
  port: positiveInteger(process.env.REDIS_PORT, 6379),
  maxRetriesPerRequest: null,
});

export const httpConcurrency = (): number => positiveInteger(process.env.HTTP_CONCURRENCY, 15);

export const browserConcurrency = (): number => positiveInteger(process.env.BROWSER_CONCURRENCY, 3);

export const jobConcurrency = (): number => positiveInteger(process.env.JOB_CONCURRENCY, 2);
