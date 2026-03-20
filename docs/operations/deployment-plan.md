# CoClaw Deployment Plan (Server + UI)

> **状态：已归档**
> 本文档是 2026-02 部署方案的设计决策记录（ADR），保留为历史参考。
> 当前部署指南请参见 [`deploy/README.md`](../../deploy/README.md)。
> 2026-03-20 完成部署基础设施整改后，以下内容中的部分路径和配置已过时。

Last updated: 2026-02-23 18:22 (Asia/Shanghai)

## Scope

- In scope: `server`, `ui`
- Out of scope (for now): `openclaw-plugins` deployment

## Confirmed Decisions

1. Deployment shape: **single-host, same-domain reverse proxy**
   - Rationale: aligns with current single-instance MVP and in-memory ws-ticket/ws hub design.
2. Delivery method: **Docker containers + `compose.yaml`**
3. Reverse proxy: **Nginx**
4. TLS strategy (phase-1): **Nginx + Certbot dual-container** (Let's Encrypt auto-issuance/renewal)
5. Future option: can migrate to a **single custom Nginx-based image bundling Certbot** when needed
6. Public traffic policy: **HTTP(80) only for redirect to HTTPS(443); public service is HTTPS-only**
7. Compose topology baseline confirmed: `nginx`, `certbot`, `server`, `mysql` (runtime)
   - `ui` is currently delivered as built static assets (`dist`) mounted/served by Nginx, not a required long-running runtime service in phase-1
8. WebSocket support is required and must be explicitly configured in Nginx for `/api/v1/bots/stream`
9. MySQL access policy:
   - default: docker network only (no public exposure)
   - testing/debug fallback: optional host-only bind (e.g. `127.0.0.1:3306:3306`)
10. Release strategy: **short maintenance-window deploy** (brief downtime acceptable)
11. UI delivery strategy (phase-1): **developer-machine build -> upload `dist` -> Nginx serves static files**
    - planned future evolution: move to server/CI-based reproducible build-and-release pipeline
12. Static path convention (confirmed):
    - Nginx container static root keeps default style: `/usr/share/nginx/html`
    - under it, split by site/app type: `/usr/share/nginx/html/www`, `/usr/share/nginx/html/ui` (and future `/usr/share/nginx/html/admin`)
    - host-side static root uses `static/` with parallel subdirs: `static/www`, `static/ui` (future `static/admin`)
    - mount one root: host `static/` -> container `/usr/share/nginx/html/`
13. Deploy directory layout: see `deploy/README.md` for current structure
14. Env strategy: **single `.env` file** (consolidated from original split into `env/server.env`, `env/mysql.env`, `env/certbot.env`)
15. Certbot renewal strategy: **compose-managed long-running renew sidecar loop** (no host cron dependency; Docker host can run full stack directly)
16. Observability baseline (phase-1): **simple mode**
    - use `docker compose logs` for operational troubleshooting
    - define container restart policies and health checks
    - no centralized log stack (ELK/Loki) in phase-1
17. Security baseline (core rule confirmed):
    - only Nginx exposes public ports (`80/443`)
    - `server`, `mysql`, `certbot` stay on docker internal network only
    - optional debug-only exception: temporary MySQL localhost bind (`127.0.0.1:3306:3306`)
18. Nginx baseline preferences (confirmed):
    - keep `client_max_body_size 128M` for future upload compatibility and reduced troubleshooting friction
    - keep request access logs enabled to include per-request basic information
    - websocket upgrade forwarding should be configured in a reusable/generic way (not hard-bound to one fixed path during current development phase)
19. Security headers policy (confirmed, phased to avoid dev/test friction):
    - phase-1 (current): enable low-risk headers
      - `X-Content-Type-Options: nosniff`
      - `X-Frame-Options: SAMEORIGIN`
      - `Referrer-Policy: strict-origin-when-cross-origin`
    - phase-1 keeps HSTS relaxed (not enabled yet) to avoid accidental subdomain lock-in during active testing
    - pre-launch tightening (required before broad public rollout):
      - enable HSTS: `Strict-Transport-Security: max-age=31536000; includeSubDomains`
      - evaluate optional `preload` only after domain-wide HTTPS policy is fully validated
20. WebSocket proxy config strategy (confirmed):
    - create reusable ws include config (upgrade headers + timeouts + buffering policy)
    - apply include to WS-related locations as needed (not hardcoded to one single route for current dev phase)
    - timeout baseline: `proxy_read_timeout=900s`, `proxy_send_timeout=900s`
    - keep normal API buffering defaults; set `proxy_buffering off` on WS locations only
    - use `map $http_upgrade $connection_upgrade` approach (avoid `if` for upgrade switching)
21. UI artifact delivery & rollback (phase-1, confirmed):
    - build UI on developer machine and package artifact with version label (e.g. `ui-YYYYMMDD-HHmm.tar.gz`)
    - upload and extract into `static/ui/releases/<version>/`
    - switch `static/ui/current` symlink to new release atomically
    - rollback by repointing `current` symlink to previous release
22. Nginx `error_log` baseline (confirmed):
    - initial default can be either `warn` or `info` (both acceptable for current stage)
    - if troubleshooting requires deeper detail, temporarily raise log verbosity and revert after issue resolution
23. ACME challenge mode (confirmed):
    - use Let's Encrypt HTTP-01 challenge
    - keep `:80` for challenge handling and HTTP->HTTPS redirect coexistence
    - implement explicit exception for `/.well-known/acme-challenge/` before generic redirect rules
24. Production MySQL storage strategy (confirmed):
    - primary: use Docker named volume with bind mount to host path
    - preferred placement: map to dedicated high-IO disk via symlink (`data/ -> /data`)
    - rationale: avoid moving global Docker `data-root` to high-IO disk to prevent wasting premium storage on non-DB artifacts (images/layers)
25. Container naming convention (confirmed):
    - use compose project name `coclaw` for automatic prefixing
    - avoid fixed `container_name` to preserve compose flexibility (e.g. scaling, multi-instance)
26. Nginx connection protocol policy (confirmed):
    - enable HTTP/2 on HTTPS listeners
    - keep HTTP/1.1 compatibility for clients/proxies that do not negotiate HTTP/2
    - enable keep-alive
    - keepalive timeout baseline: `65s`
27. App domain: `im.coclaw.net`
28. Build-time proxy support (confirmed):
    - support HTTP/HTTPS proxy via `i.coclaw.net:8080`
    - support SOCKS5 proxy via `i.coclaw.net:1080`
    - expose build proxy settings through compose interpolation vars
29. Server image build policy (confirmed):
    - multi-stage Dockerfile with `pnpm deploy --legacy --prod` for minimal production image
    - base image: `node:22-slim`
    - include `curl` in runtime image for health checks
    - server image published to GHCR (`ghcr.io/coclaw/server`), supporting `linux/amd64` + `linux/arm64`
    - entrypoint auto-runs `prisma migrate deploy` before starting server
30. Nginx domain parameterization (2026-03):
    - use `envsubst` template mechanism (nginx official image built-in)
    - `NGINX_ENVSUBST_FILTER: "APP_DOMAIN"` restricts substitution to `${APP_DOMAIN}` only
    - alternative templates (e.g. HTTP-only) must NOT be placed in `templates/` directory

## Current Architecture Constraints (must respect)

- Server session: `express-session` (cookie based)
- WS path: `/api/v1/bots/stream`
- DB schema invariant: `Bot.tokenHash = BINARY(32)`
- Current server ws-ticket/ws routing state is in-process memory (single instance friendly)

## Pre-launch Hardening Gate (must run before broad public rollout)

Owner/process (confirmed):
- Developer reviews and explicitly confirms hardening readiness.
- Assistant executes/configures the agreed tightening changes only after that explicit confirmation.

Required tightening checklist:
1. Enable HSTS (`Strict-Transport-Security: max-age=31536000; includeSubDomains`).
2. Re-evaluate optional HSTS `preload` eligibility only after full-domain HTTPS validation.
3. Re-check nginx log levels and retention according to traffic scale and incident needs.
4. Re-check public exposure policy remains `nginx:80/443` only.
5. Re-run end-to-end bind/unbind/session WS checks on production-like environment after tightening.

## Production Env Contract (confirmed)

### server

- `NODE_ENV=production`
- `PORT=3000` (container-internal)
- `SESSION_SECRET=<strong-random-secret>`
- `DB_URL=mysql://<user>:<pass>@mysql:3306/coclaw` (assembled by compose from individual MySQL vars)
- `SHADOW_DB_URL` is not required in production runtime

### ui

- Goal: one build artifact can run under any HTTPS domain
- Decision: **do not hardcode domain into UI build-time API base**
- Use same-origin relative requests/proxy paths (`/api/...` and websocket upgrade on same host)
