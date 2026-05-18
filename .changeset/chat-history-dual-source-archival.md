---
'@coclaw/openclaw-coclaw': minor
---

Fix chat-history session-archival gap on OpenClaw `agent.send` auto-reset paths.

Previously chat-history only tracked archives via the `session_start` plugin
hook, but OpenClaw 2026.5.7's `agent.send` RPC creates new sessions without
firing that hook — so the prior session was silently lost from the history
index.

This change adds a second listener path: the plugin now subscribes to gateway
`sessions.changed` events (reason=create) and archives the prior session
through the same code path as the hook. The chat-history file schema is
extended so the head item may be unarchived (no `archivedAt`), representing
the current active session. Both sources are idempotent: the second source
is a no-op when state is already settled, mutex-serialized per agent; stale
events (where `currentSessionId` already exists in the list) are dropped.

The on-disk `coclaw-chat-history.json` is forward-compatible: existing
all-archived files migrate naturally on first new transition. The
`coclaw.chatHistory.list` RPC returns the raw array; UI is expected to filter
unarchived heads in client code.

The `chatHistoryManager.recordArchived(...)` method has been replaced with
`recordSessionTransition({ agentId, sessionKey, currentSessionId, archivedSessionId? })`.
Only the in-plugin hook handler called it, so the API change is internal.

The `RealtimeBridge` `onSessionCreated` callback is now injected at the
constructor (`new RealtimeBridge({ onSessionCreated })`) instead of `start()`
options. `restartRealtimeBridge(opts)` forwards `opts.onSessionCreated` to the
new instance's deps on each restart; the callback is fixed for the instance's
lifetime (refresh()'s internal stop+start does not touch it).

**Gateway compatibility & reconnect.** The gateway-side `sessions.subscribe`
binding is per-WS (registered against the active connection's `connId`) and
is automatically released when the WS closes (see openclaw-repo
`src/gateway/server/ws-connection.ts:391`'s `unsubscribeAllSessionEvents`).
The plugin therefore (re-)sends `sessions.subscribe` on every successful
gateway handshake, without distinguishing first-time vs reconnect. The RPC
timeout is 60s, sized for gateway restarts that block the main thread for
seconds. Subscribe failures (only possible from transport-layer faults — the
gateway handler has no business-error branch) emit one warning + remoteLog
and otherwise no-op; the next handshake retries naturally. The plugin's
`minHostVersion` is `>=2026.3.22` (the version where the gateway
`sessions.subscribe` RPC first ships — see openclaw commit `7b61ca1b06`;
also ensures the `session_start` hook carries `sessionKey`, available since
`2026.3.2`); installation on older gateways is rejected by OpenClaw.

**UI counterpart.** The UI side filter for unarchived heads ships in commit
`2a00e56` (CoClaw UI). Without that UI change, the current active session
would appear at the top of the orphan-history list.

**Rollback compatibility.** Rolling back to plugin <= 0.21.5 is functionally
safe: the old code returns the raw array verbatim and does not crash on the
new schema, and the on-disk file remains valid. The only visible effect is
that an old UI will render the current active session as an extra orphan
entry at the top of the history list — a cosmetic blip that resolves on the
next session reset (which writes the entry as fully archived). Clearing or
migrating `coclaw-chat-history.json` is therefore only necessary if that
cosmetic correctness matters during the rollback window; it is not required
for data integrity.
