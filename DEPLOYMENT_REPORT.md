# Deployment Report — 2026-08-15

- Server: 37.27.128.39 (user-authorized replacement for initially supplied scraper IP)
- Public URLs: https://crawler.kyqra.com/ (dashboard), https://crawler.kyqra.com/api/v1, https://crawler.kyqra.com/health
- DNS: A record resolves to 37.27.128.39
- TLS: Let's Encrypt issued; expires 2026-11-13; automated renewal enabled
- Services: Nginx, API, HTTP worker, browser worker, callback worker, Redis 7.4, PostgreSQL 17, Fail2ban, UFW, unattended upgrades, node exporter
- Runtime: Node 22, TypeScript 5.9, Crawlee 3.15, Playwright/Chromium 1.55
- Isolation: API published only at 127.0.0.1:3100; Redis/PostgreSQL internal Docker network only
- Limits: HTTP 15, browser 3, job concurrency 2; container caps total 18.5 GiB versus 62 GiB host RAM
- Authentication: constant-time Bearer API key check; dashboard uses Nginx Basic Auth plus the API key for operations; webhook HMAC + API key + allowlist
- Functional tests passed: DNS, HTTP→HTTPS, valid TLS, health, Redis/PostgreSQL health, unauthenticated 401, authenticated submission/status/results, real HTTP crawl, real Chromium crawl, extraction/provenance, JSON and CSV route, bounded failure/retry, database isolation, Redis isolation, firewall, restart policies
- Middleware: network reachability exists publicly but authenticated callback is NOT claimed because MIDDLEWARE_API_KEY and an exact receiving endpoint were not supplied
- Benchmark: safe single-page HTTP ~0.7 s and Chromium ~1.3 s after warm-up. A 100-page benchmark was not run against third-party sites without an approved 100-page test target.
- Outstanding: supply middleware callback URL/API key; rotate/distribute API key securely; provide an approved benchmark target; configure off-host encrypted backup destination. A full 25-case acceptance run (including reboot, callback receiver/replay validation, browser crash injection, pause/resend UI, and robots-policy enforcement) remains pending and is not claimed as passed.
- Existing Telnexa services were not modified.
