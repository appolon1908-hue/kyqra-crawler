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

Bearer authentication: `Authorization: Bearer <API_KEY>`. Public unauthenticated probes: `GET /health` and `GET /api/v1/health`.

- `POST /api/v1/jobs`
- `GET /api/v1/jobs/:id`
- `GET /api/v1/jobs/:id/results?format=csv`
- `POST /api/v1/jobs/:id/cancel`
- `GET /api/v1/stats`
- `POST /api/v1/webhooks/test`

Job fields: `startUrls` (1–1000 HTTPS/HTTP URLs), `mode`, `maxPages` (1–10000), `maxDepth` (0–10), `browser`, `extract`, `includePatterns`, `excludePatterns`, `callbackUrl`, and `requestsPerSecond`.

### Current v1.1 capability status

The API currently accepts several values that are retained for compatibility
but are **not implemented**. Do not rely on them until a later milestone is
recorded as proven in `docs/ACCEPTANCE.md`.

| Field or value | Current behavior |
| --- | --- |
| `extract` | **NOT IMPLEMENTED** — accepted but ignored. |
| `mode=list` | **NOT IMPLEMENTED** — currently behaves like `domain`. |
| `mode=discovery` | **NOT IMPLEMENTED** — currently behaves like `domain`; no search or sitemap discovery occurs. |
| `browser=auto` | **NOT IMPLEMENTED** — currently selects the HTTP crawler and does not auto-escalate to Playwright. |

Implemented paths are `mode=single`, `mode=domain`, `browser=http`, and
`browser=playwright`. Request Playwright explicitly for rendered pages.

Callbacks are allowlisted by `CALLBACK_ALLOWLIST`, retried six times with exponential delay, include job ID and timestamp, use `x-api-key`, and have `x-kyqra-signature: sha256=<HMAC-SHA256 body>`. Configure `MIDDLEWARE_API_KEY` before production callback testing.

## Limits and retention

HTTP concurrency 15, browser concurrency 3, two job slots, 8 GiB browser cap, 4 GiB HTTP cap, 1 GiB API, 3 GiB Redis, 2 GiB PostgreSQL. Completed job records expire after 30 days. Backups retain 14 days. Docker logs use host rotation defaults; Nginx uses logrotate.

## Security and monitoring

UFW exposes only rate-limited SSH plus 80/443. Fail2ban and unattended upgrades are active. Databases and Chromium debugging ports are not published. TLS renews through certbot.timer. Detailed container health: `docker compose ps`; host metrics listen only on 127.0.0.1:9100.

## Backup/restore

Backups are gzip SQL files in `backups/`. Restore into an empty database with: `gunzip -c FILE | docker compose exec -T postgres psql -U crawler crawler`. Back up `.env`, Compose, source, Nginx config, and certificates separately using access-controlled infrastructure.

## Troubleshooting

Check `docker compose logs SERVICE`, queue stats, disk/RAM, DNS, and `curl https://crawler.kyqra.com/health`. Failed queue items are bounded at three attempts. Never publish ports 5432/6379 or Docker socket.
