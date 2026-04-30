---
"@coclaw/openclaw-coclaw": patch
"@coclaw/ui": patch
---

fix(plugin): preserve string type in rpc send queue to prevent silent drop on UI side

The plugin-side `RpcSendQueue` previously coerced non-chunked JSON strings into
`Buffer` when enqueuing under back-pressure (queue non-empty or
`bufferedAmount >= 1 MB`). On drain, those messages went out as binary frames
(SCTP PPID 53), but the UI reassembler treats binary frames strictly as chunked
fragments — the JSON's first byte (`{` = 0x7B) doesn't match BEGIN/MIDDLE/END
flags, so the frame was silently dropped at the UI. Symptoms: agent runs
appeared stuck on "task not finished" while the plugin run was still progressing
in the background, with no `agent.run.*` remote log because UI never registered
the run.

The queue now records each item as `{ data, isString, bytes }` and lets
`dc.send` dispatch the original type at drain time. Strings go out as string
frames (PPID 51), binary chunks remain binary. Byte accounting is unchanged.

Also adds a `chat.preAccept.error` remoteLog at the UI's pre-acceptance
catch-all branch so future similar wire-layer drops surface in remote
diagnostics instead of silently failing past the user-facing 180 s timeout.
