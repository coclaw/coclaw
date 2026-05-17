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
the current active session. Both sources are idempotent (last-write-wins on
identical transitions, mutex-serialized).

The on-disk `coclaw-chat-history.json` is forward-compatible: existing
all-archived files migrate naturally on first new transition. The
`coclaw.chatHistory.list` RPC returns the raw array; UI is expected to filter
unarchived heads in client code.

The `chatHistoryManager.recordArchived(...)` method has been replaced with
`recordSessionTransition({ agentId, sessionKey, currentSessionId, archivedSessionId? })`.
Only the in-plugin hook handler called it, so the API change is internal.

**Gateway compatibility (degradation).** `sessions.subscribe` is supported by
OpenClaw gateway >= v2026.3.22. On older gateways the subscribe RPC returns
`method_not_found`; the plugin logs a warning on the first attempt and again
on the 5s retry (per handshake), then falls back to single-source (hook-only)
archival. On those gateways, sessions created via `agent.send` will still be
missed — this is the upstream defect being worked around, not a new
regression.

**UI counterpart.** The UI side filter for unarchived heads ships in commit
`2a00e56` (CoClaw UI). Without that UI change, the current active session
would appear at the top of the orphan-history list.

**Rollback warning.** Rolling back to plugin <= 0.21.5 requires either
clearing `coclaw-chat-history.json` (each agent's `sessions/` directory) or
migrating it to all-archived form. The old code passes the array through as
raw JSON, so it will not crash — but old UIs receiving the unarchived head
will display the current active session as an orphan history segment (same
symptom as the "UI counterpart" mismatch above).
