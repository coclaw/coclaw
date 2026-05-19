---
'@coclaw/openclaw-coclaw': patch
---

Stop-bleed for cron-driven main-session eviction: detect and reconcile
chat-history when a scheduled `agentTurn` cron rotates the main session's
`sessionId`.

OpenClaw cron jobs configured with `sessionTarget: "current"` (or an explicit
`session:<sessionKey>`) rotate the target chat's current `sessionId` whenever
the freshness window has elapsed (default daily, 04:00 boundary). That code
path does not emit `session_start` hooks and does not broadcast
`sessions.changed reason=create`, so the previous chat-history pipeline never
learned about the rotation. The evicted user session ended up as a head entry
with no `archivedAt`, and the chat-history UI filtered it out — making the
turn invisible even though the JSONL transcript was still on disk.

This change adds four complementary, idempotent reconciliation paths:

- **`cron_changed` hook (primary).** The plugin now listens for
  `cron_changed` hook events (available from OpenClaw v2026.5.7). On
  `action === 'finished'` events that carry both a `sessionKey` and a
  `sessionId`, it routes the rotation through the same
  `recordSessionTransition` helper used by `session_start`. The `agentId`
  is derived from `sessionKey` (`agent:<agentId>:<channel>`) because the
  v2026.5.7 hook payload does not yet expose `event.agentId`. Main-mode
  cron events (which only `enqueueSystemEvent` and never launch a run)
  carry no `sessionId` and are filtered out by an early return.
- **`sessions.changed phase=message` (fallback).** The realtime bridge's
  `sessions.changed` filter now also accepts `payload.phase === 'message'`
  in addition to `payload.reason === 'create'`. Every cron-run message
  emits a `phase=message` event, providing a fallback signal when the
  primary hook is missed. The event is dispatched through the existing
  `__onSessionCreated` callback (with the same `if (!sk || !sid) return`
  guard). The `dropIfSlow: true` flag on the WS broadcast means slow
  consumers may still miss this; it is a best-effort fallback, not a
  guarantee.
- **Startup reconciliation (gap coverage).** During `register()` (full
  mode only), after `ChatHistoryManager.load('main')` settles, the plugin
  now calls `sessionManager.listAllEntries('main')` and feeds the result
  into a new `ChatHistoryManager.reconcileAll(agentId, entries)`. This
  covers the window when both the plugin and gateway were down: the
  gateway does not replay successfully-finished cron events on restart,
  so without a startup pass, an overnight rotation that completes while
  the gateway is offline would never reach `recordSessionTransition`.
  `reconcileAll` invokes `recordSessionTransition` per entry — the
  existing idempotency (head-already-current is a no-op) absorbs the
  reconciliation cost when there is nothing to fix.
- **Persist-time sanitize guard (self-heal).** Every write through
  `ChatHistoryManager.__persist` now runs a new
  `__sanitizeAllSessionKeys(store, agentId)` pass that walks every
  `sessionKey`'s `list[1..]` and forces `archivedAt = Date.now()` on any
  non-tail entry still missing it. Each coercion logs a local
  `warn` and a `chat-history.sanitize-coerce` `remoteLog` so the signal
  is observable. Pre-existing dirty files (from earlier cron evictions,
  abnormal-process races, or older plugin versions) are repaired in
  place the next time a write occurs. New writers are protected
  automatically because the guard lives inside `__persist`.

Two supporting additions on the session-manager side:

- `createSessionManager()` returns a new `listAllEntries(agentId)` thin
  wrapper that reads `sessions.json` and returns
  `[{ sessionKey, sessionId }]`. It skips entries whose `sessionId` is
  missing or not a non-empty string, and returns `[]` if `sessions.json`
  is missing or unreadable. It does not read transcripts or stat files,
  so it is safe to call eagerly from startup.

Test coverage:

- `chat-history-manager`: sanitize coerces non-tail unarchived entries,
  preserves existing `archivedAt`, and no-ops on clean lists or
  single-item lists. `reconcileAll` triggers transitions when the
  recorded head differs from the `sessions.json` current `sessionId`,
  is idempotent when they agree, ignores non-array / null input, and
  skips malformed entry objects without aborting the loop.
- `index.js`: cron handler routes finished events with both ids,
  early-returns when `action !== 'finished'` or `sessionId` /
  `sessionKey` are missing, derives the target `agentId` from the
  `sessionKey`, and is skipped entirely when `api.on` is not provided
  by the host. The startup reconcile pass is verified end-to-end by
  pre-seeding a divergent `sessions.json` / `coclaw-chat-history.json`
  pair and asserting that the on-disk chat-history is rewritten with
  the new head archived and the new `sessionId` at the front after
  registration settles.
- `realtime-bridge`: `phase=message` invokes `onSessionCreated` without
  broadcasting, in addition to the existing `reason=create` path.

Non-cron `sessions.changed phase=message` events flow through the same
callback, but the new `classifyChatHistorySessionKey` guard makes them
no-ops in `handleSessionCreated` for any chat sessionKey already at the
correct head (idempotent via the existing reload-then-compare logic in
`recordSessionTransition`). The historical `A→B→C` triple-rotate
double-source race documented in
`plugins/openclaw/src/chat-history-manager/manager.test.js`
(`REPRO 双源乱序`) remains out of scope for this change; the repro test
is left skipped pending a separate root-cause fix tracked in
`plugins/openclaw/TODO.md`.
