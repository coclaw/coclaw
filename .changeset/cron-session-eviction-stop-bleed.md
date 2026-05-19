---
'@coclaw/openclaw-coclaw': patch
---

Best-effort tracking of cron-driven main-session eviction so an evicted user
session no longer ends up as an invisible head entry in chat-history.

OpenClaw cron jobs configured with `sessionTarget: "current"` (or an explicit
`session:<sessionKey>`) rotate the target chat's current `sessionId` whenever
the freshness window has elapsed (default daily, 04:00 boundary). That code
path does not emit `session_start` hooks and does not broadcast
`sessions.changed reason=create`, so before this change the chat-history
pipeline never learned about the rotation — the evicted user session ended up
as a head entry with no `archivedAt`, and the chat-history UI filtered it out.

Three complementary, idempotent paths now keep chat-history in sync; any one
of them is sufficient for routine cases:

- **`cron_changed` hook (primary).** The plugin listens for `cron_changed`
  hook events (available since OpenClaw v2026.4.29). On
  `action === 'finished'` events that carry both a `sessionKey` and a
  `sessionId`, the rotation is routed through the same
  `recordSessionTransition` helper used by `session_start`. The `agentId` is
  derived from `sessionKey` (`agent:<agentId>:<channel>`) because older hook
  payloads do not expose `event.agentId`. Main-mode cron events (which only
  `enqueueSystemEvent` and never launch a run) carry no `sessionId` and are
  filtered out by an early return.
- **Startup reconciliation (gap coverage).** During `register()` (full mode
  only), after `ChatHistoryManager.load('main')` settles, the plugin calls
  `sessionManager.listAllEntries('main')` and feeds the result into
  `ChatHistoryManager.reconcileAll(agentId, entries)`. This covers the
  window when both the plugin and gateway were down: the gateway does not
  replay successfully-finished cron events on restart, so without a startup
  pass an overnight rotation that completes while the gateway is offline
  would never reach `recordSessionTransition`. The existing idempotency
  (head-already-current is a no-op) absorbs the reconciliation cost when
  there is nothing to fix.
- **Persist-time sanitize guard (self-heal).** Every write through
  `ChatHistoryManager.__persist` runs `__sanitizeAllSessionKeys(store,
  agentId)`, which walks every `sessionKey`'s `list[1..]` and forces
  `archivedAt = Date.now()` on any non-tail entry still missing it. Each
  coercion logs a local `warn` and a `chat-history.sanitize-coerce`
  `remoteLog` so the signal is observable. Pre-existing dirty files (from
  earlier cron evictions, abnormal-process races, or older plugin versions)
  are repaired the next time a write occurs.

`sessions.changed phase=message` is **not** used as a fallback channel: the
`cron_changed` hook is sufficient for the cron eviction case, and routing
every transcript message append through chat-history would impose a
disk-reload cost on every chat for a problem that only matters for cron
rotation. UI-only paths (`sessions.compact`, `compaction.branch`,
`compaction.restore`) that mutate `sessionId` without emitting
`session_start` are similarly out of scope — the chat-history UI tolerates a
brief mismatch on the next message append.

Robustness hardening:

- `recordSessionTransition` and the `handleSessionCreated` entry point both
  reject non-string `sessionKey` / `sessionId` / `archivedSessionId` so a
  malformed hook payload cannot persist garbage values.
- `classifyChatHistorySessionKey` (the shared guard used by both the event
  path and `reconcileAll`) matches the upstream
  `isCronSessionKey` schema by requiring `cron` to appear at the third
  segment, not any later segment. Without this, an IM per-account DM
  sessionKey such as `agent:main:telegram:cron:direct:<peer>`
  (`accountId === "cron"`, which the upstream account-id regex permits)
  would be skipped from chat-history.
- `__persist` evicts the in-memory cache for the affected `agentId` when the
  atomic write fails, so the next `recordSessionTransition` re-reads the
  on-disk state instead of persisting the speculative in-memory mutations
  from the failed attempt.

Supporting addition on the session-manager side:

- `createSessionManager()` returns a new `listAllEntries(agentId)` thin
  wrapper that reads `sessions.json` and returns
  `[{ sessionKey, sessionId }]`. It skips entries whose `sessionId` is
  missing or not a non-empty string, returns `[]` if `sessions.json` is
  missing, corrupt, or stored as an array, and skips entries with empty
  string `sessionKey`. It does not read transcripts or stat files, so it is
  safe to call eagerly from startup.

The historical `A→B→C` triple-rotate double-source race documented in
`plugins/openclaw/src/chat-history-manager/manager.test.js`
(`REPRO 双源乱序`) remains out of scope; the repro test is left skipped
pending a separate root-cause fix tracked in `plugins/openclaw/TODO.md`.
