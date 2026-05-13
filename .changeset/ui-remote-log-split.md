---
"@coclaw/ui": patch
---

Split `remote-log` internals to clarify responsibilities — no behavior change.

- New `utils/async-utils.js` exports `sleep(timeout, signal?)`. The `AbortSignal` is optional (degrades to a plain sleep when omitted) and the reject path uses `signal.reason` when available, falling back to a generic `Error('aborted')` for older browsers (baseline Safari 15.0–15.3 / Firefox 90).
- `utils/platform.js` now exposes `detectPlatformLabel()` (`'cap-android' | 'cap-ios' | 'electron-win' | 'electron-mac' | 'electron-linux' | 'electron' | 'web'`). The function reads `globalThis` on each call so tests can `vi.stubGlobal` without `resetModules`.
- New `services/env-snapshot.js` owns the one-shot diagnostic snapshot and `buildUiStartText(uiId)`. It uses `utils/platform.js` for the platform label rather than re-implementing platform detection.
- `services/remote-log.js` shrinks to a pure batching/retry channel: `buildUiStartText`, the inline `sleep` helper, and the `skipUiStart` opt are gone. `useRemoteLog()` no longer auto-enqueues `ui.start`.
- `main.js` now explicitly emits `ui.start` after creating the singleton: `const rl = useRemoteLog(); rl.log(buildUiStartText(rl.uiId));`.

Public API and observable behavior are unchanged: the first log sent to the server is still the `ui.start` line with the same field set; `remoteLog(text)` and the singleton shape are unaffected.
