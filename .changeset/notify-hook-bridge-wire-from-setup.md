---
'@coclaw/ui': patch
---

refactor(ui): wire notifier from App.vue setup to silence dev `inject` warning

Previously `notify-hook-bridge.js` auto-registered on import and its hook called `useNotify()` lazily — i.e. inside the remote callback (`onRtcUnrecoverable`, far from any Vue setup). `capacitor-app.js` `handleShareReceived` had the same shape, calling `useNotify()` directly inside the share callback. Vue dev mode emits `inject() can only be used inside setup() or functional components` for both. Production builds are unaffected (the toast state is a plugin-level singleton with a graceful fallback), but the warning is dev-console noise.

Switch to explicit wiring:

- `notify-hook-bridge.js` exports `wireNotifyHooks(notifier)` (registers the store hook + remembers the notifier) and `getSharedNotifier()` (null-able accessor for non-setup callbacks).
- `App.vue` `setup()` calls `wireNotifyHooks(notify)` once, reusing the `useNotify()` it already invokes for `setGlobalErrorNotify`. This is the single legitimate-timing call.
- `main.js` drops the side-effect `import './stores/notify-hook-bridge.js';` (replaced by the explicit `wireNotifyHooks` invocation in App.vue setup).
- `capacitor-app.js` `handleShareReceived` uses `getSharedNotifier()?.info(...)` instead of calling `useNotify()` itself; the optional-chain handles the (impossible-in-prod) pre-wire window.

Behavior is identical: same toast color presets, durations, titles. `wireNotifyHooks` runs synchronously inside `app.mount()`, well before `initCapacitorApp()` and any RTC connection establishment, so callbacks never see a `null` shared notifier in practice.
