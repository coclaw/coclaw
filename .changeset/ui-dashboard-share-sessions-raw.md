---
"@coclaw/ui": patch
---

Eliminate duplicate `sessions.list` RPC on first screen. Dashboard no longer fetches its own copy; it now reads raw session metadata from `sessions.store` via a new `getRawSessionsForClaw(clawId, { force })` action, which keeps a per-claw raw cache alongside the existing folded `SessionItem[]` (same fetch, same lifecycle — written only after the claw still exists post-fetch; preserved on failure for visual continuity with `MainList`).

`loadDashboard(clawId, { force })` gains a `force` flag so reconnect-recovery (`refreshClawResources`) and explicit user refresh (entering `ManageClawsPage`, `app:foreground` after the 60s freshness gate) bypass the cache and re-pull through `sessions.store`. To make `force` actually guarantee a fresh fetch, both `dashboard.store._loadingByClaw` and `sessions.store._perClawLoading` now track per-flight `{ p, force }`: a `force: true` caller that lands on a non-force in-flight request chains after it and starts a new round, instead of being silently coalesced into the older flight; two `force: true` callers still coalesce, as do any non-force callers (any running fetch is fresh enough for them).

The dashboard's own per-claw in-flight guard is retained for the remaining 5+N RPCs (`status` / `models.list` / `usage.cost` / `tts.status` / `channels.status` / `tools.catalog × agents`).
