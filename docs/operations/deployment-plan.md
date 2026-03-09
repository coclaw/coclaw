# CoClaw Deployment Plan (Server + UI)

Last updated: 2026-02-23 18:22 (Asia/Shanghai)
Status: Draft (discussion in progress)

## Scope

- In scope: `server`, `ui`
- Out of scope (for now): `openclaw-plugins` deployment

## Confirmed Decisions

1. Deployment shape: **single-host, same-domain reverse proxy**
   - Rationale: aligns with current single-instance MVP and in-memory ws-ticket/ws hub design.
2. Delivery method: **Docker containers + `docker-compose.yaml`**
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
13. Deploy directory layout (confirmed):
    - `deploy/docker-compose.yaml`
    - `deploy/nginx/` (nginx config)
    - `deploy/static/` (www/ui/admin static assets)
    - `deploy/certbot/` (acme/challenge + cert data mountpoints)
    - `deploy/env/` (runtime env files)
14. Env strategy (confirmed): **hybrid mode (revised)**
    - one compose-level `.env` at `deploy/.env` for docker-compose interpolation
    - service env files: `deploy/env/server.env` and `deploy/env/mysql.env`
    - certbot uses a dedicated env file: `deploy/env/certbot.env` (separate concern from app runtime)
    - keep phase-1 minimal while preserving clear ownership boundaries
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
    - upload and extract into `deploy/static/ui/releases/<version>/`
    - switch `deploy/static/ui/current` symlink to new release atomically
    - rollback by repointing `current` symlink to previous release
22. Nginx `error_log` baseline (confirmed):
    - initial default can be either `warn` or `info` (both acceptable for current stage)
    - if troubleshooting requires deeper detail, temporarily raise log verbosity and revert after issue resolution
23. ACME challenge mode (confirmed):
    - use Let's Encrypt HTTP-01 challenge
    - keep `:80` for challenge handling and HTTP->HTTPS redirect coexistence
    - implement explicit exception for `/.well-known/acme-challenge/` before generic redirect rules
24. Production MySQL storage strategy (confirmed):
    - primary: use Docker named volume for MySQL data persistence
    - preferred placement: map that named volume to a dedicated high-IO disk path (volume-level targeting)
    - rationale: avoid moving global Docker `data-root` to high-IO disk to prevent wasting premium storage on non-DB artifacts (images/layers)
    - secondary fallback: host bind mount to high-IO disk path if volume-level targeting is not feasible
25. Container naming convention (confirmed):
    - use unified `coclaw-` prefix for project containers on shared hosts
    - recommended implementation: set compose project name to `coclaw` (or explicit `container_name` with `coclaw-*` where necessary)
    - note: avoid overusing fixed `container_name` unless needed, to preserve compose flexibility
26. Nginx connection protocol policy (confirmed):
    - enable HTTP/2 on HTTPS listeners
    - keep HTTP/1.1 compatibility for clients/proxies that do not negotiate HTTP/2
    - enable keep-alive
    - keepalive timeout baseline: `65s` (balanced for mixed static + API + websocket workload in this project)
    - note: websocket upgrades are handled separately and are not governed by normal HTTP keepalive timeout semantics
27. Temporary app domain before ICP completion (confirmed):
    - use `im.coclaw.net` as app host
    - keep website hosts configured as `coclaw.net` / `www.coclaw.net`
28. Build-time proxy support (confirmed):
    - support HTTP/HTTPS proxy via `i.coclaw.net:8080`
    - support SOCKS5 proxy via `i.coclaw.net:1080`
    - expose build proxy settings through compose interpolation vars (`BUILD_HTTP_PROXY`, `BUILD_HTTPS_PROXY`, `BUILD_ALL_PROXY`, `BUILD_NO_PROXY`)
29. Server image build policy (confirmed):
    - multi-stage Dockerfile
    - base image: `node:22-slim`
    - include `curl` in runtime image for diagnostics/health checks
    - use provided USTC apt mirrors in Dockerfile for apt operations

## Current Architecture Constraints (must respect)

- Server session: `express-session` (cookie based)
- WS path: `/api/v1/bots/stream`
- DB schema invariant: `Bot.tokenHash = BINARY(32)`
- Current server ws-ticket/ws routing state is in-process memory (single instance friendly)

## Open Questions (to be decided)

1. None (current planning round closed)

## Dev/Prod Compatibility Assessment (recorded for follow-up)

Goal: keep local development smooth while enforcing stronger production defaults.

### A) HTTP/HTTPS behavior

- Local dev: allow HTTP for direct Vite/Express iteration.
- Production: enforce HTTPS at edge (Nginx 80->443 redirect).
- Note: backend app-level HTTPS-only rejection is optional; if enabled, gate by env and trusted proxy headers to avoid breaking local/dev tools.

Recommended follow-up:
1. In server, add environment-aware request policy:
   - `development`: allow HTTP
   - `production`: if direct external HTTP is somehow reachable, reject or redirect based on `X-Forwarded-Proto`/proxy trust config.
2. Keep final TLS enforcement at Nginx as primary control.

### B) UI API/WS base resolution

- Requirement already confirmed: one UI build artifact should run on arbitrary HTTPS domains.
- Current risk: fallback to `http://127.0.0.1:3000` in UI services.

Recommended follow-up:
1. Switch UI runtime defaults to same-origin relative paths (`/api/...`) and ws derived from `window.location`.
2. Keep optional env override only for local debugging if needed.

### C) Cookie/session behavior by environment

- Current server cookie config already uses `secure` in production only.
- Need to ensure proxy/trust settings are explicit so secure-cookie behavior is reliable behind Nginx.

Recommended follow-up:
1. Confirm Express `trust proxy` strategy for production behind Nginx.
2. Verify session login works in both:
   - local HTTP dev
   - production HTTPS via reverse proxy.

### D) Nginx strictness split

- Dev/test should avoid over-restrictive headers/rules that slow iteration.
- Production should tighten headers according to hardening gate.

Recommended follow-up:
1. Keep `phase-1` headers minimal in current plan.
2. Promote to hardened headers only after explicit pre-launch confirmation.

### E) Config profile separation

Recommended follow-up:
1. Keep separate env profiles/files for local vs production values.
2. Add a simple validation checklist to prevent mixing local settings into production deploys.

## Code Adaptation TODO (plan only, no implementation in this round)

### Server-side TODO

1. **Explicit proxy trust strategy**
   - File: `server/src/app.js`
   - Add env-aware `trust proxy` setup for production behind Nginx.
   - Goal: secure-cookie and proto detection behave correctly through reverse proxy.

2. **Optional production HTTP guard (app-level defense in depth)**
   - File: `server/src/app.js` (middleware near top)
   - Behavior:
     - `development`: allow HTTP
     - `production`: when request is effectively non-HTTPS (considering forwarded proto), reject/redirect per policy
   - Note: keep Nginx redirect as primary enforcement; app guard is secondary hardening.

3. **Operational health checks remain stable across envs**
   - File: `server/src/app.js`
   - Ensure `/healthz` behavior is deterministic and unaffected by auth/session middlewares.

4. **Session/cookie env assertions**
   - File: `server/src/app.js`
   - Verify `cookie.secure`, `sameSite`, and session secret requirements are environment-appropriate.
   - Optional: startup warning/error if production uses weak/default secret.

### UI-side TODO

1. **Remove hardcoded fallback base URL**
   - Files:
     - `ui/src/services/auth.api.js`
     - `ui/src/services/bots.api.js`
     - `ui/src/services/gateway.ws.js`
   - Current risk: fallback to `http://127.0.0.1:3000`.
   - Target: same-origin relative API/WS defaults.

2. **WS URL derivation from current origin**
   - File: `ui/src/services/gateway.ws.js`
   - Build ws/wss endpoint from `window.location` and path convention.
   - Keep optional override for local special debugging only.

3. **Env contract docs for UI**
   - File: `ui/README.md` and/or `ui/STATUS.md`
   - Document that production build should not require domain hardcoding.

### Cross-env Validation TODO (manual checklist)

1. Local dev (HTTP):
   - UI login/logout/session works
   - bot ws ticket + stream path works
2. Production-like (HTTPS via Nginx):
   - cookies/session behave correctly
   - API + WS proxy works for `app.coclaw.net`
   - optional `/api` from `www` host behaves as expected
3. Security gate before broad rollout:
   - HSTS and tightening checklist executed after developer confirmation.

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
- `DB_URL=mysql://<user>:<pass>@mysql:3306/coclaw`
- `SHADOW_DB_URL` is not required in production runtime

### ui

- Goal: one build artifact can run under any HTTPS domain
- Decision: **do not hardcode domain into UI build-time API base**
- Use same-origin relative requests/proxy paths (`/api/...` and websocket upgrade on same host)
- Note: current code has a fallback to `http://127.0.0.1:3000`; before rollout, adjust to origin-relative fallback to satisfy this requirement

## Discussion Log

- 2026-02-23 18:22: Confirmed scheme = single-host same-domain reverse proxy + Docker Compose.
- 2026-02-23 18:55: Reverse proxy selected: Nginx.
- 2026-02-23 18:58: TLS selected: Let's Encrypt via Nginx + Certbot dual-container; note future single-container option (custom Nginx image bundling Certbot).
- 2026-02-23 21:27: Confirmed public HTTPS-only policy (80->443 redirect), compose services (`nginx`,`certbot`,`ui`,`server`,`mysql`), required WebSocket proxy config on Nginx, and MySQL default internal-only with optional localhost-only bind for testing.
- 2026-02-23 21:29: Release strategy selected: short maintenance-window deploy (brief downtime acceptable).
- 2026-02-23 21:38: UI phase-1 delivery selected: build on developer machine, upload `dist`, and serve by Nginx; CI/server build pipeline deferred to a later phase.
- 2026-02-23 21:47: Env contract confirmed with adjustments: production DB name = `coclaw` (no `_prod` suffix); UI should avoid domain hardcoding and use same-origin relative API/WS paths so one build artifact can run on arbitrary HTTPS domains.
- 2026-02-23 22:19: Static path convention confirmed: keep Nginx default `/usr/share/nginx/html` and organize by `www/ui` subdirs (future `admin`); host uses `static/` root mapped as one mount.
- 2026-02-23 22:37: Env strategy selected: hybrid mode (`deploy/.env` for compose interpolation + `deploy/env/server.env` + `deploy/env/mysql.env`).
- 2026-02-23 22:41: Revised env strategy: certbot moved to dedicated `deploy/env/certbot.env` due to separate concern.
- 2026-02-23 22:41: Q10 confirmed domain mapping: `coclaw.net` + `www.coclaw.net` -> `www` root, `app.coclaw.net` -> `ui` root; keep `/api` and websocket proxy available across these hostnames for future registration/login evolution.
- 2026-02-23 22:44: Q11 selected cert renewal mode = compose-managed long-running sidecar (no host cron required).
- 2026-02-23 22:45: Q12 selected observability mode = simple baseline (`docker compose logs` + restart policy + health checks), without centralized logging stack for phase-1.
- 2026-02-23 22:46: Q13 confirmed security core rule: only Nginx (`80/443`) is publicly exposed; all other services remain internal (with optional temporary localhost-only MySQL mapping for debugging).
- 2026-02-23 23:03: Adopted nginx preference refinements: keep `client_max_body_size=128M`; keep per-request access logging; and avoid path-hardcoding websocket proxy rules during active route evolution.
- 2026-02-23 23:05: Security header strategy selected by assistant per project stage: enable `nosniff`/`SAMEORIGIN`/`Referrer-Policy` now; defer HSTS to pre-launch hardening to avoid introducing test-phase friction. Tightening requirement documented.
- 2026-02-23 23:08: Q15 confirmed reusable WS include strategy; apply per location as routes evolve, with 900s WS timeouts and WS-only buffering disable.
- 2026-02-23 23:12: Q16 confirmed UI artifact flow: versioned tarball upload, release directory extraction, atomic `current` symlink switch, and symlink-based rollback.
- 2026-02-23 23:17: Finalized remaining items: nginx error_log can start at `warn` or `info` and be adjusted during troubleshooting; ACME uses HTTP-01 with explicit challenge-path exception on :80 alongside redirect policy; pre-launch tightening is executed by assistant only after explicit developer confirmation.
- 2026-02-23 23:28: Completed phase-1 code adaptations that can be done/tested locally: UI API/WS base switched to same-origin-first resolution; server added production proxy trust + SESSION_SECRET guard + optional HTTPS enforcement middleware. Server/UI test suites pass.
- 2026-02-23 23:44: Completed phase-2 local adaptation checks: added server env-behavior tests (`app.env-adaptation.test.js`) and documented `ENFORCE_HTTPS` in `.env.example`; server test suite still fully green.
- 2026-02-24 00:35: Pre-deploy implementation batch completed: added deploy scaffold (`deploy/docker-compose.yaml`, nginx configs/includes, certbot renew/init setup, env templates), introduced temporary app domain `coclaw.qidianchat.com`, added build proxy support via `i.coclaw.net` proxy endpoints, and added server multi-stage Dockerfile (`node:22-slim` + curl + USTC apt mirrors).
- 2026-03-04: 部署修复批次完成：(1) `deploy-common.sh` 的 `sync_repo` 新增 `--exclude 'deploy/.env'` 和 `--exclude 'deploy/env/*.env'`，防止 rsync `--delete` 删除远端手动维护的 env 文件；(2) nginx `coclaw.conf` 证书路径由 `live/coclaw.net/` 改为 `live/coclaw.qidianchat.com/`（与实际签发证书一致），注释掉 `coclaw.net`/`www.coclaw.net` HTTPS server block（ICP 待完成），HTTP server_name 收窄为仅 `coclaw.qidianchat.com`，移除 `app.coclaw.net`，修复 nginx 1.27 弃用语法 `listen 443 ssl http2` 为 `listen 443 ssl` + `http2 on`；(3) 远端 MySQL 数据卷重建并以新凭据初始化（一次性运维操作）；(4) 远端从 `.example` 模板创建了 `deploy/.env`、`deploy/env/server.env`、`deploy/env/mysql.env`、`deploy/env/certbot.env`。
