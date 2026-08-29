# Kyqra Crawler

Production Crawlee/Playwright service at https://crawler.kyqra.com.

## Architecture

Nginx TLS → Fastify API/dashboard → BullMQ/Redis → independent crawl and callback workers → PostgreSQL. Redis and PostgreSQL are internal-only. Results are sent only to allowlisted HTTPS middleware callbacks; Odoo is never accessed directly.

## Operations

```bash
cd /opt/kyqra-crawler
docker compose ps
docker compose logs -f
docker compose pull && docker compose build --pull && docker compose up -d
./scripts/backup.sh
```

Secrets are in mode-0600 `.env` and must never be committed. Rotate API_KEY and WEBHOOK_SECRET when distributing access.

## API

Base URL: `https://crawler.kyqra.com`. The following is an inventory of routes
registered by v1.1 source. It is not an end-to-end acceptance claim; behavioral
coverage is scheduled for M1 and proven capabilities are recorded in
`docs/ACCEPTANCE.md`.

### Public routes

| Method | Path             | Current behavior                                                                                       |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------------ |
| `GET`  | `/`              | Inline operator dashboard. Nginx Basic Auth is the only authentication in front of this Fastify route. |
| `GET`  | `/health`        | Deep dependency probe: Redis `PING` plus PostgreSQL `SELECT 1`.                                        |
| `GET`  | `/healthz`       | Shallow process liveness probe.                                                                        |
| `GET`  | `/readyz`        | Deep dependency readiness probe, equivalent to `/health`.                                              |
| `GET`  | `/api/v1/health` | Shallow process liveness probe.                                                                        |

All five routes bypass the Fastify bearer-authentication hook. In particular,
`/health` currently exposes an unauthenticated dependency probe; remediation is
tracked separately and is not claimed by M0.

### Authenticated routes

Send `Authorization: Bearer <API_KEY>`. Keys are SHA-256 matched against the
service-principals file using constant-time comparison. An optional
`X-Tenant-Id` must match the authenticated principal.

| Method | Path                       | Current behavior                                                                                                                                                             |
| ------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/v1/jobs`             | Requires `Idempotency-Key` and `X-Correlation-Id`; returns `202` when created, `200` for an identical replay, or `409` for a conflicting replay. Request body limit is 2 MB. |
| `GET`  | `/api/v1/jobs/:id`         | Returns the tenant-scoped job status, progress, error, and correlation ID.                                                                                                   |
| `GET`  | `/api/v1/jobs/:id/results` | Returns tenant-scoped JSON by default or CSV with `?format=csv`.                                                                                                             |
| `POST` | `/api/v1/jobs/:id/cancel`  | Removes queued work and marks the job cancelled; it does **not** stop an in-flight crawl.                                                                                    |
| `POST` | `/api/v1/jobs/:id/retry`   | Requeues the original payload under the same tenant-scoped job ID.                                                                                                           |
| `GET`  | `/api/v1/stats`            | Requires the principal's `operations` role; returns queue counts and configured worker concurrency.                                                                          |
| `POST` | `/api/v1/webhooks/test`    | Accepts `{ "url": "https://..." }`; the destination must pass `CALLBACK_ALLOWLIST`.                                                                                          |

Job fields: `startUrls` (1–1000 HTTPS/HTTP URLs), `mode`, `maxPages` (1–10000), `maxDepth` (0–10), `browser`, `extract`, `includePatterns`, `excludePatterns`, `callbackUrl`, and `requestsPerSecond`.

### Current v1.1 capability status

The API currently accepts several values that are retained for compatibility
but are **not implemented**. Do not rely on them until a later milestone is
recorded as proven in `docs/ACCEPTANCE.md`.

| Field or value   | Current behavior                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `extract`        | **NOT IMPLEMENTED** — accepted but ignored.                                                        |
| `mode=list`      | **NOT IMPLEMENTED** — currently behaves like `domain`.                                             |
| `mode=discovery` | **NOT IMPLEMENTED** — currently behaves like `domain`; no search or sitemap discovery occurs.      |
| `browser=auto`   | **NOT IMPLEMENTED** — currently selects the HTTP crawler and does not auto-escalate to Playwright. |

Implemented paths are `mode=single`, `mode=domain`, `browser=http`, and
`browser=playwright`. Request Playwright explicitly for rendered pages.

### Outbound callbacks

The callback worker sends:

| Method | Destination                                    | Current behavior                                       |
| ------ | ---------------------------------------------- | ------------------------------------------------------ |
| `POST` | `${MIDDLEWARE_BASE_URL}/api/v1/kyqra/results`  | Once per result row. This is not batched.              |
| `POST` | `${MIDDLEWARE_BASE_URL}/api/v1/kyqra/progress` | Once when a job completes.                             |
| `POST` | Job `callbackUrl`                              | Once when a job completes, after allowlist validation. |

Callbacks retry up to six times with exponential delay and carry
`Authorization: Bearer ${KYQRA_MIDDLEWARE_API_KEY}`, `x-source-system: kyqra`,
`x-kyqra-signature-version: v1`, `x-kyqra-timestamp`, `x-kyqra-event-id`, and
`x-kyqra-signature: sha256=<HMAC-SHA256 body>`. Configure
`KYQRA_MIDDLEWARE_API_KEY` and `KYQRA_WEBHOOK_SECRET` before production callback
testing.

There is currently no `/metrics`, OpenAPI document, or versioned discovery
route.

## Limits and retention

HTTP concurrency 15, browser concurrency 3, two job slots, 8 GiB browser cap, 4 GiB HTTP cap, 1 GiB API, 3 GiB Redis, 2 GiB PostgreSQL. Completed job records expire after 30 days. Backups retain 14 days. Docker logs use host rotation defaults; Nginx uses logrotate.

## Security and monitoring

UFW exposes only rate-limited SSH plus 80/443. Fail2ban and unattended upgrades are active. Databases and Chromium debugging ports are not published. TLS renews through certbot.timer. Detailed container health: `docker compose ps`; host metrics listen only on 127.0.0.1:9100.

## Backup/restore

Backups are gzip SQL files in `backups/`. Restore into an empty database with: `gunzip -c FILE | docker compose exec -T postgres psql -U crawler crawler`. Back up `.env`, Compose, source, Nginx config, and certificates separately using access-controlled infrastructure.

## Troubleshooting

Check `docker compose logs SERVICE`, queue stats, disk/RAM, DNS, and `curl https://crawler.kyqra.com/health`. Failed queue items are bounded at three attempts. Never publish ports 5432/6379 or Docker socket.
