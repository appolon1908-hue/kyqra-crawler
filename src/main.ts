import Fastify from 'fastify';
import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import crypto from 'node:crypto';
import { CheerioCrawler } from '@crawlee/cheerio';
import { PlaywrightCrawler } from '@crawlee/playwright';
import { RequestQueue } from '@crawlee/core';
import { z } from 'zod';
const ro = { host: process.env.REDIS_HOST || 'redis', port: 6379, maxRetriesPerRequest: null };
const redis = new Redis(ro),
  db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = new Queue('crawl', {
  connection: ro,
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
});
const cq = new Queue('callbacks', {
  connection: ro,
  defaultJobOptions: { attempts: 6, backoff: { type: 'exponential', delay: 10000 } },
});
const S = z.object({
  startUrls: z.array(z.string().url()).min(1).max(1000),
  mode: z.enum(['single', 'domain', 'list', 'discovery']).default('single'),
  maxPages: z.number().int().min(1).max(10000).default(100),
  maxDepth: z.number().int().min(0).max(10).default(3),
  browser: z.enum(['auto', 'http', 'playwright']).default('auto'),
  extract: z.array(z.string()).default([]),
  includePatterns: z.array(z.string()).default([]),
  excludePatterns: z.array(z.string()).default([]),
  callbackUrl: z.string().url().optional(),
  requestsPerSecond: z.number().min(0.1).max(20).default(2),
});
const log = (level: string, msg: string, x: any = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...x }));
const norm = (s: string) => {
  let u = new URL(s);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  ['utm_source', 'utm_medium', 'utm_campaign', 'fbclid', 'gclid'].forEach((k) =>
    u.searchParams.delete(k),
  );
  if (u.pathname != '/') u.pathname = u.pathname.replace(/\/$/, '');
  return u.toString();
};
const allow = (s: string) => {
  let u = new URL(s),
    a = (process.env.CALLBACK_ALLOWLIST || 'kyqra.com,10.40.0.1').split(',');
  return (
    (u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '10.40.0.1')) &&
    a.some((x) => u.hostname === x || u.hostname.endsWith('.' + x))
  );
};
async function init() {
  await db.query(
    `CREATE TABLE IF NOT EXISTS jobs(id uuid primary key,status text,payload jsonb,progress jsonb default '{}',error text,created_at timestamptz default now(),updated_at timestamptz default now());CREATE TABLE IF NOT EXISTS results(id bigserial primary key,job_id uuid references jobs(id) on delete cascade,url text,url_hash text,data jsonb,provenance jsonb,created_at timestamptz default now(),unique(job_id,url_hash));CREATE TABLE IF NOT EXISTS job_requests(job_id uuid primary key references jobs(id) on delete cascade,idempotency_key text unique not null,request_hash text not null,correlation_id text not null,tenant_id text);ALTER TABLE job_requests ADD COLUMN IF NOT EXISTS tenant_id text;CREATE INDEX IF NOT EXISTS results_job ON results(job_id)`,
  );
}
function data($: any, url: string) {
  let t = $('body').text().replace(/\s+/g, ' ').trim(),
    emails = [...new Set(t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])].map((x: any) =>
      x.toLowerCase(),
    ),
    phones = [...new Set(t.match(/(?:\+?\d[\d .()\/-]{7,}\d)/g) || [])].map((x: any) =>
      x.replace(/[^\d+]/g, ''),
    ),
    ld: any[] = [];
  $('script[type="application/ld+json"]').each((_: any, e: any) => {
    try {
      ld.push(JSON.parse($(e).text()));
    } catch {}
  });
  let title = $('title').text().trim();
  return {
    business_name:
      $('meta[property="og:site_name"]').attr('content') || $('h1').first().text().trim() || title,
    website: new URL(url).origin,
    description: $('meta[name="description"]').attr('content') || '',
    phone: phones,
    email: emails,
    address: $('[itemprop="address"],address').first().text().replace(/\s+/g, ' ').trim(),
    page_title: title,
    schema_org: ld,
    source_url: url,
    crawl_timestamp: new Date().toISOString(),
  };
}
async function crawl(job: Job) {
  let p = S.parse(job.data),
    id = job.id!,
    seen = 0,
    records = 0,
    failed = 0;
  await db.query("update jobs set status='running',updated_at=now() where id=$1", [id]);
  let roots = p.startUrls.map((x) => new URL(x).hostname),
    rq = await RequestQueue.open('job-' + id);
  for (let u of p.startUrls) await rq.addRequest({ url: norm(u), userData: { depth: 0 } });
  let browser = p.browser === 'playwright';
  let opts: any = {
    requestQueue: rq,
    maxRequestsPerCrawl: p.maxPages,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 60,
    maxConcurrency: browser
      ? +(process.env.BROWSER_CONCURRENCY || 3)
      : +(process.env.HTTP_CONCURRENCY || 15),
    sameDomainDelaySecs: 1 / p.requestsPerSecond,
    failedRequestHandler: async ({ request }: any) => {
      failed++;
      log('warn', 'request_failed', { jobId: id, url: request.url });
    },
    requestHandler: async (c: any) => {
      let depth = c.request.userData.depth || 0;
      seen++;
      let jq = c.$ || (c.parseWithCheerio ? await c.parseWithCheerio() : undefined);
      let d = data(jq, c.request.loadedUrl || c.request.url),
        h = crypto.createHash('sha256').update(norm(c.request.url)).digest('hex'),
        prov = Object.fromEntries(Object.keys(d).map((k) => [k, c.request.url]));
      let r = await db.query(
        'insert into results(job_id,url,url_hash,data,provenance) values($1,$2,$3,$4,$5) on conflict do nothing returning id',
        [id, c.request.url, h, d, prov],
      );
      records += r.rowCount || 0;
      if (depth < p.maxDepth && p.mode !== 'single')
        await c.enqueueLinks({
          strategy: 'same-hostname',
          transformRequestFunction: (r: any) => {
            try {
              let n = norm(r.url);
              if (
                !roots.includes(new URL(n).hostname) ||
                p.excludePatterns.some((x) => n.includes(x)) ||
                (p.includePatterns.length && !p.includePatterns.some((x) => n.includes(x)))
              )
                return false;
              r.url = n;
              r.userData = { depth: depth + 1 };
              return r;
            } catch {
              return false;
            }
          },
        });
      await job.updateProgress({ processed: seen, records, failed });
    },
  };
  try {
    if (browser)
      await new PlaywrightCrawler({
        ...opts,
        launchContext: { launchOptions: { headless: true, args: ['--disable-dev-shm-usage'] } },
      }).run();
    else await new CheerioCrawler(opts).run();
    await db.query("update jobs set status='completed',progress=$2,updated_at=now() where id=$1", [
      id,
      { processed: seen, records, failed },
    ]);
    let base = (process.env.MIDDLEWARE_BASE_URL || '').replace(/\/$/, ''),
      meta = await db.query('select correlation_id,tenant_id from job_requests where job_id=$1', [
        id,
      ]),
      correlationId = meta.rows[0]?.correlation_id || null,
      tenantId = meta.rows[0]?.tenant_id || null;
    if (base) {
      let rows = await db.query(
        'select id,data,provenance from results where job_id=$1 order by id',
        [id],
      );
      for (let row of rows.rows)
        await cq.add('result', {
          jobId: id,
          url: base + '/api/v1/kyqra/results',
          payload: {
            job_id: id,
            tenant_id: tenantId,
            correlation_id: correlationId,
            record_id: String(row.id),
            ...row.data,
            category: row.data.category || null,
            confidence: row.data.confidence || null,
            provenance: row.provenance,
          },
        });
      await cq.add('progress', {
        jobId: id,
        url: base + '/api/v1/kyqra/progress',
        payload: {
          job_id: id,
          tenant_id: tenantId,
          correlation_id: correlationId,
          status: 'completed',
          processed: seen,
          records,
          failed,
        },
      });
    }
    if (p.callbackUrl && allow(p.callbackUrl))
      await cq.add('complete', {
        jobId: id,
        url: p.callbackUrl,
        payload: { job_id: id, status: 'completed', processed: seen, records, failed },
      });
    return { seen, records, failed };
  } catch (e: any) {
    await db.query("update jobs set status='failed',error=$2 where id=$1", [id, e.message]);
    throw e;
  }
}
const auth = (r: any, x: any, d: any) => {
  let v = String(r.headers.authorization || '').replace(/^Bearer /, ''),
    e = process.env.API_KEY || '';
  if (!e || v.length !== e.length || !crypto.timingSafeEqual(Buffer.from(v), Buffer.from(e)))
    return x.code(401).send({ error: 'unauthorized' });
  d();
};
async function api() {
  await init();
  let a = Fastify({ bodyLimit: 2e6 });
  const live = async () => ({ status: 'ok' });
  const ready = async () => {
    await redis.ping();
    await db.query('select 1');
    return { status: 'ok', redis: 'ok', postgres: 'ok' };
  };
  a.get('/health', ready);
  a.get('/healthz', live);
  a.get('/readyz', ready);
  a.get('/api/v1/health', live);
  a.addHook('onRequest', ((r: any, x: any, d: any) =>
    ['/', '/health', '/healthz', '/readyz', '/api/v1/health'].includes(r.url)
      ? d()
      : auth(r, x, d)) as any);
  a.post('/api/v1/jobs', async (r: any, x) => {
    let v = S.safeParse(r.body);
    if (!v.success) return x.code(400).send({ error: 'invalid_job', details: v.error.issues });
    if (v.data.callbackUrl && !allow(v.data.callbackUrl))
      return x.code(400).send({ error: 'callback_not_allowed' });
    let idempotencyKey = String(r.headers['idempotency-key'] || ''),
      correlationId = String(r.headers['x-correlation-id'] || ''),
      tenantId = String(r.headers['x-tenant-id'] || '');
    if (!idempotencyKey || !correlationId || !tenantId)
      return x.code(400).send({ error: 'idempotency_correlation_and_tenant_required' });
    let requestHash = crypto.createHash('sha256').update(JSON.stringify(v.data)).digest('hex'),
      prior = await db.query(
        'select job_id,request_hash,correlation_id from job_requests where idempotency_key=$1',
        [idempotencyKey],
      );
    if (prior.rowCount) {
      if (prior.rows[0].request_hash !== requestHash)
        return x.code(409).send({ error: 'idempotency_conflict' });
      return x.code(200).send({
        id: prior.rows[0].job_id,
        status: 'duplicate',
        duplicate: true,
        correlation_id: prior.rows[0].correlation_id,
      });
    }
    let id = crypto.randomUUID(),
      client = await db.connect();
    try {
      await client.query('begin');
      await client.query("insert into jobs(id,status,payload) values($1,'queued',$2)", [
        id,
        v.data,
      ]);
      await client.query(
        'insert into job_requests(job_id,idempotency_key,request_hash,correlation_id,tenant_id) values($1,$2,$3,$4,$5)',
        [id, idempotencyKey, requestHash, correlationId, tenantId],
      );
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
    await q.add('crawl', v.data, { jobId: id });
    return x
      .code(202)
      .send({ id, status: 'queued', duplicate: false, correlation_id: correlationId });
  });
  a.get('/api/v1/jobs/:id', async (r: any, x) => {
    let z = await db.query(
      'select j.id,j.status,j.progress,j.error,j.created_at,j.updated_at,m.correlation_id from jobs j left join job_requests m on m.job_id=j.id where j.id=$1',
      [r.params.id],
    );
    return z.rowCount ? z.rows[0] : x.code(404).send({ error: 'not_found' });
  });
  a.get('/api/v1/jobs/:id/results', async (r: any, x) => {
    let z = await db.query('select data,provenance from results where job_id=$1 order by id', [
        r.params.id,
      ]),
      m = await db.query('select correlation_id from job_requests where job_id=$1', [r.params.id]);
    if (r.query?.format === 'csv') {
      x.type('text/csv');
      let e = (v: any) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
      return (
        'source_url,business_name,website,phone,email,address\n' +
        z.rows
          .map((y) =>
            [
              y.data.source_url,
              y.data.business_name,
              y.data.website,
              y.data.phone?.join(';'),
              y.data.email?.join(';'),
              y.data.address,
            ]
              .map(e)
              .join(','),
          )
          .join('\n')
      );
    }
    return {
      count: z.rowCount,
      correlation_id: m.rows[0]?.correlation_id || null,
      results: z.rows,
    };
  });
  a.post('/api/v1/jobs/:id/cancel', async (r: any, x) => {
    let j = await q.getJob(r.params.id);
    if (j) await j.remove().catch(() => {});
    let z = await db.query(
      "update jobs set status='cancelled',updated_at=now() where id=$1 returning id",
      [r.params.id],
    );
    return z.rowCount
      ? { id: r.params.id, status: 'cancelled' }
      : x.code(404).send({ error: 'not_found' });
  });
  a.post('/api/v1/jobs/:id/retry', async (r: any, x) => {
    let z = await db.query('select payload from jobs where id=$1', [r.params.id]);
    if (!z.rowCount) return x.code(404).send({ error: 'not_found' });
    let old = await q.getJob(r.params.id);
    if (old) await old.remove().catch(() => {});
    await db.query("update jobs set status='queued',error=null,updated_at=now() where id=$1", [
      r.params.id,
    ]);
    await q.add('crawl', z.rows[0].payload, { jobId: r.params.id });
    return x.code(202).send({ id: r.params.id, status: 'accepted' });
  });
  a.get('/api/v1/stats', async () => ({
    queue: await q.getJobCounts(),
    workers: {
      http: +(process.env.HTTP_CONCURRENCY || 15),
      browser: +(process.env.BROWSER_CONCURRENCY || 3),
    },
  }));
  a.post('/api/v1/webhooks/test', async (r: any, x) => {
    if (!r.body?.url || !allow(r.body.url))
      return x.code(400).send({ error: 'callback_not_allowed' });
    await cq.add('test', { jobId: 'test', url: r.body.url, event: 'test' });
    return { queued: true };
  });
  a.get('/', async (_, x) => x.type('text/html').send(DASH));
  await a.listen({ host: '0.0.0.0', port: 3000 });
}
function callbacks() {
  new Worker(
    'callbacks',
    async (j) => {
      let body = JSON.stringify(j.data.payload || {}),
        timestamp = String(Math.floor(Date.now() / 1000)),
        eventId = String(j.id || crypto.randomUUID()),
        canonical = timestamp + '\n' + eventId + '\nkyqra\n' + body,
        sig = crypto
          .createHmac('sha256', process.env.KYQRA_WEBHOOK_SECRET || '')
          .update(canonical)
          .digest('hex'),
        r = await fetch(j.data.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + (process.env.KYQRA_MIDDLEWARE_API_KEY || ''),
            'x-source-system': 'kyqra',
            'x-kyqra-timestamp': timestamp,
            'x-kyqra-event-id': eventId,
            'x-kyqra-signature': 'sha256=' + sig,
          },
          body,
          signal: AbortSignal.timeout(15000),
        });
      if (!r.ok) throw Error('callback ' + r.status);
    },
    { connection: ro, concurrency: 3 },
  );
}
const DASH = `<!doctype html><html><head><meta charset=utf-8><title>Kyqra Crawler</title><style>body{font:16px system-ui;max-width:850px;margin:40px auto;background:#101827;color:#eee}input,select,button,textarea{padding:10px;margin:5px;width:100%;box-sizing:border-box}button{background:#22c55e;border:0}pre{background:#111;padding:15px;overflow:auto}</style></head><body><h1>Kyqra Crawler</h1><input id=k type=password placeholder="API key"><textarea id=u placeholder="URLs, one per line"></textarea><select id=m><option>single</option><option>domain</option><option>list</option><option>discovery</option></select><input id=p type=number value=100><input id=d type=number value=3><select id=b><option>auto</option><option>http</option><option>playwright</option></select><button onclick=go()>Start crawl</button><input id=j placeholder="Job ID"><button onclick=st()>Status/results</button><button onclick=cn()>Cancel</button><pre id=o></pre><script>let H=()=>({Authorization:'Bearer '+k.value,'content-type':'application/json'});async function go(){let r=await fetch('/api/v1/jobs',{method:'POST',headers:H(),body:JSON.stringify({startUrls:u.value.split(/\\n/).filter(Boolean),mode:m.value,maxPages:+p.value,maxDepth:+d.value,browser:b.value})});o.textContent=await r.text();try{j.value=JSON.parse(o.textContent).id}catch{}}async function st(){let a=await fetch('/api/v1/jobs/'+j.value,{headers:H()}),c=await fetch('/api/v1/jobs/'+j.value+'/results',{headers:H()});o.textContent=await a.text()+'\\n'+await c.text()}async function cn(){let r=await fetch('/api/v1/jobs/'+j.value+'/cancel',{method:'POST',headers:H()});o.textContent=await r.text()}</script></body></html>`;
let role = process.env.ROLE || 'api';
if (role === 'api') api();
else if (role === 'worker')
  new Worker('crawl', crawl, { connection: ro, concurrency: +(process.env.JOB_CONCURRENCY || 2) });
else callbacks();
