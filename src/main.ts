import { startApi } from './api/app.js';
import { createRuntime } from './runtime.js';
import { createCallbackWorker } from './workers/callback.js';
import { createCrawlWorker } from './workers/crawl.js';

const runtime = createRuntime();
const role = process.env.ROLE || 'api';

if (role === 'api') await startApi(runtime);
else if (role === 'worker') createCrawlWorker(runtime);
else createCallbackWorker(runtime);
