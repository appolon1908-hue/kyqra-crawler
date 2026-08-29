import crypto from 'node:crypto';

import { Worker } from 'bullmq';
import { request } from 'undici';

import { callbackSignatureInput, createPinnedCallbackAgent } from '../delivery/security.js';
import type { CallbackJobData, Runtime } from '../types.js';

export const createCallbackWorker = (runtime: Runtime): Worker<CallbackJobData> =>
  new Worker<CallbackJobData>(
    'callbacks',
    async (job) => {
      const body = JSON.stringify(job.data.payload || {});
      const timestamp = String(Math.floor(Date.now() / 1000));
      const eventId = String(job.id || crypto.randomUUID());
      const target = new URL(job.data.url);
      const canonical = callbackSignatureInput(
        'POST',
        target.pathname,
        timestamp,
        eventId,
        'kyqra',
        body,
      );
      const signature = crypto
        .createHmac('sha256', process.env.KYQRA_WEBHOOK_SECRET || '')
        .update(canonical)
        .digest('hex');
      const dispatcher = await createPinnedCallbackAgent(job.data.url);
      try {
        const response = await request(job.data.url, {
          dispatcher,
          method: 'POST',
          headersTimeout: 15000,
          bodyTimeout: 15000,
          signal: AbortSignal.timeout(30000),
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${process.env.KYQRA_MIDDLEWARE_API_KEY || ''}`,
            'x-source-system': 'kyqra',
            'x-kyqra-signature-version': 'v1',
            'x-kyqra-timestamp': timestamp,
            'x-kyqra-event-id': eventId,
            'x-kyqra-signature': `sha256=${signature}`,
          },
          body,
        });
        await response.body.dump();
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new Error(`callback ${response.statusCode}`);
        }
      } finally {
        await dispatcher.close();
      }
    },
    { connection: runtime.redisConnection, concurrency: 3 },
  );
