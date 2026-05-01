---
'@coclaw/ui': patch
---

fix(ui): notify user when ICE restart budget exhausts with active runs, and rename pre-accept diag logs

When ICE restart's 180s budget is exhausted and the WebRTC connection is about to be torn down for a rebuild, surface a one-shot toast (only when at least one agent run is still active for that claw) so users learn their tasks may be affected instead of silently seeing "task incomplete" later. Cold-start init failures and other `close({asFailed:true})` paths intentionally do not trigger this notification.

Also rename pre-acceptance diagnostic remote logs to land under the `agent.run.*` namespace, replacing the previous `chat.preAccept.error` (which collided semantically with the `chat.send` RPC method). New events: `rtc.unrecoverable`, `agent.run.registered`, `agent.run.preaccept-failed`, `agent.run.norun`, `agent.run.send-cancelled`, `agent.run.upload-cancelled`, `agent.run.send-retry`, `agent.run.send-failed`, plus per-pending `conn.rejectPending.detail` lines so future "task incomplete" reports can be located in the send path.
