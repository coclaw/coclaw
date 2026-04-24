---
"@coclaw/ui": patch
---

Silence signaling WS reconnect log storm when device is truly offline. During real offline (airplane mode / WiFi off / cable unplugged), the WS reconnect loop previously fired 4 `log` events per cycle (`sig.reconnect delay=...`, `sig.state disconnected→connecting`, `sig.close code=...`, `sig.state connecting→disconnected`); these were consumed by `remote-log.js` and piled into its 1000-entry buffer (sender inactive while offline, so the buffer churned shift/push continuously). Over 10 minutes of offline this produced ~80 log events.

Fix is a localized edge-triggered gate inside `SignalingConnection`:

- `__doConnect()` entry now checks `typeof navigator !== 'undefined' && navigator.onLine === false` and, if true, skips `new WebSocket`, emits `sig.reconnect paused offline` **once** (via `__pausedOffline` boolean), and schedules the next retry normally.
- `__scheduleReconnect()` omits the per-schedule `sig.reconnect delay=...` `log` event while `__pausedOffline` is set (offline steady-state is now silent on remote-log).
- When a subsequent `__doConnect()` sees `navigator.onLine` is no longer false, it flips the flag back and emits `sig.reconnect resumed` **once**, then proceeds to the normal `__setState('connecting')` + WebSocket construction path.
- `disconnect()` resets `__pausedOffline` so a fresh `connect()` while still offline will log a new `paused offline` entry.

The flag is **only** used for log deduplication — it does not gate any business logic. Existing reconnect cadence (1s → 2s → 4s → … → 30s exponential backoff) and the `network:online` / `app:foreground` wake-up paths are unchanged. Other modules are unaware.

Rationale for the strict `=== false` comparison: modern baseline browsers / WebViews (Chrome/Edge 90+, Safari 15+, Firefox 90+, Android WebView, iOS WKWebView, Electron) reliably report `navigator.onLine=false` for true offline scenarios. False-positive offline reports (browser says offline but network is actually up) are rare and the scheme is fault-tolerant — the retry backoff continues, and `network:online` / `app:foreground` events break the backoff on recovery regardless of the gate state; worst case is a one-retry-cycle delay.

Not done (deliberate scope limits): no `window 'offline'` / `'online'` event subscription, no changes to `remote-log.js`, no changes to `claws.store.js` or other business modules. The communication model is unaffected.

Steady-state validation: 10-minute true offline now produces exactly 2 `log` events (one `paused offline` entering + one `resumed` on recovery), down from ~80.

Tests: +10 unit tests in `signaling-connection.test.js` covering entry, steady-state silence, resume on flag flip, online/offline toggles, `disconnect` reset, the `navigator.onLine===undefined` fallback (regression guard against `!navigator.onLine` being introduced), and `forceReconnect()` behavior under offline. An `afterEach` cleanup bug was also fixed (jsdom `navigator.onLine` is a prototype-chain property, `getOwnPropertyDescriptor` returns `undefined`, and the previous restore path leaked `defineProperty`-set values into subsequent tests — now `delete`d in that case).
