---
"@coclaw/ui": patch
---

Two small follow-up fixes from round-9 external review:

- `claws.store.js` `__handleNetworkOnline` `state === 'restarting'` branch now mirrors the `state === 'connected' && restartPaused` branch: when `rtc.restartPaused` is true, skip `nudgeRestart()` and preserve the `_pendingTypeChangedRestartClaws` entry for later `__resumeOnline` consumption (which upgrades to `triggerRestart('online_resume')` — the sole reason that passes the paused gate at `webrtc-connection.js:975`). Previously this branch would both `delete` the Set entry and call `nudgeRestart()`, which `__attemptRestart('nudge')` drops when paused — net effect: restart not sent AND typeChanged signal permanently lost. Reachability in practice is narrow (the paused=true invariant normally implies `claw.online=false` OR `_sigOffline=true`, both of which are gated earlier in `__handleNetworkOnline`), but the defensive symmetry with the connected+paused branch is worth ~5 lines and blocks any future ordering surprise. Logs `claw.typeChanged claw=<id> paused_restarting defer_to_resume` via remoteLog.

- `webrtc-connection.test.js` cleans up three `no-unused-vars` lint warnings (`dc`/`pc` destructured but never used) introduced by earlier edits at L2181/L2273/L2595.

Tests: one new test `"#2 round9: 主循环 restarting+paused + typeChanged 不发 nudgeRestart，Set 保留给 resume 消费"` asserts (a) `nudgeRestart`/`triggerRestart` not called on the `__handleNetworkOnline(true)` call, (b) after a subsequent sig down/up cycle, `__resumeOnline` consumes the preserved Set entry and fires `triggerRestart('online_resume')`.
