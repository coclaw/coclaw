---
"@coclaw/ui": patch
---

RPC over DataChannel response timeout tuning for weak-network safety:

- `coclaw.info` (plugin version check): drop explicit 10s, fall back to default 30s — first-call path waits on plugin `waitForSessionsReady` and 10s was tight under slow-start conditions.
- Dashboard 7-call fan-out (`status` / `models.list` / `usage.cost` / `sessions.list` / `tts.status` / `channels.status` / `tools.catalog`): raise from default 30s to 180s — calls are `Promise.allSettled` in parallel, so the bump only changes the failure ceiling, not the happy-path latency; gives `tools.catalog` room for multi-agent responses.
- `chat.history` (both loadMessages sessionId lookup and per-agent sessions batch): raise from default 30s to 60s for weak-network headroom.
- `coclaw.topics.create` / `coclaw.topics.delete` / `coclaw.topics.update`: raise from default 30s to 60s — write operations benefit from extra margin to reduce client-timeout / server-committed state-drift windows.
- `coclaw.files.mkdir` / `coclaw.files.create`: add explicit 60s to align with `coclaw.files.list` / `coclaw.files.delete` in the same file; prior omission meant the mkdir→create upload sequence had half the headroom of list/delete.
