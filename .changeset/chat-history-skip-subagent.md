---
'@coclaw/openclaw-coclaw': patch
---

Skip subagent `sessionKey` shapes in chat-history tracking.

OpenClaw spawns subagents with the sessionKey shape `agent:<id>:subagent:<uuid>`
(and nested `:subagent:` segments for grand-subagents). Previously the plugin
treated every `sessions.changed reason=create` event the same and recorded
those subagent sessionKeys into `coclaw-chat-history.json`, causing
unbounded growth of orphan unarchived heads (subagents only emit `create`,
never an archive/end event).

`handleSessionCreated` now early-returns when `parts[2]` (or any later
position) equals `'subagent'`, dropping the entry from chat-history and
emitting `remoteLog('chat-history.skip-subagent ...')` for observability.
The judgement starts at `parts[2]` so an agent literally named `subagent`
(sessionKey `agent:subagent:main`) is not affected.

Rationale: chat-history is for human-machine conversation streams, not for
internal subagent runs. The parent agent's transcript already contains the
subagent's final output (re-injected as a user message on completion), so no
user-visible data is lost.

Other non-main shapes (cron, IM, etc.) remain recorded — they are still
human-machine conversation streams that the UI may surface later.

No behavior change on `agent:<id>:main` or any other recorded shape. Plugin
patch only; no upstream version requirement change.
