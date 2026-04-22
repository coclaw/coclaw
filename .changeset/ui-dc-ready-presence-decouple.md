---
"@coclaw/ui": patch
---

Decouple `dcReady` from `claw.online` presence. `dcReady` is now strictly a reactive mirror of the real DataChannel readyState (`rtc.isReady`); offline events no longer write it. Dashboard/agents/sessions/topics refresh on presence recovery is triggered explicitly by `__resumeOnline` (split by `rtc.state` into immediate vs after-rebuild), so pending RPCs are not fast-failed during offline and can resume via SCTP once ICE restart succeeds.

Also fixes two pre-existing issues: `dc.onclose` now escalates to `close({asFailed:true})` in both `restarting` and `connected` states (previously only `restarting`), so `store.dcReady` stays in sync with the real DC; `onRtcStateChange('connected')` clears `disconnectedAt` even on the `wasDisconnected=false` branch, preventing stale stamp accumulation across successive ICE restarts.
