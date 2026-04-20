---
'@coclaw/ui': patch
---

Fix disconnected timer lifecycle across app:background/foreground transitions. Previously `__disconnectedTimer` was not cleared on background, allowing it to fire during suspension and trigger `setLocalDescription` (which replaces ICE credentials, preventing original-pair auto-recovery). On long backgrounds, the resulting `__restartStartTime` would be recorded while suspended, causing the foreground `nudgeRestart` to hit the "time budget exhausted → rebuild" bad path. Now:

- `__onAppBackground` clears the disconnected timer and records the background timestamp.
- `__onAppForeground` re-arms the timer only if PC is still `disconnected`, with a two-tier timeout based on background duration: < 25s uses the standard 5s self-heal window; ≥ 25s uses 1.5s (enough for browser/WebView internal state to settle, not for self-healing). Long backgrounds typically surface as `connectionState='failed'` events that trigger restart immediately, bypassing this timer.
- Removes dead code in `claws.store.js` `__checkAndRecover` that branched on `rtc.state === 'disconnected'` — `WebRtcConnection.__state` is never `'disconnected'` (the PC's `connectionState` is a separate machine).
