---
'@coclaw/ui': patch
---

fix(ui): harden logout against active-state leaks and single-step cleanup failures

Second pass on logout state cleanup — covering the "user logs out while something is active" scenarios that the previous static-resource pass did not address.

- `auth.store.logout()`: the 13-step cleanup chain had no error isolation — any single step throwing (e.g. Capacitor permission edge case, polyfill oddity, third-party blob URL) would skip every subsequent step and leak WebRTC PCs, WS, SSE, timers, and blob URLs across users. Each step is now wrapped in a `safeRun(label, fn)` helper; failures degrade to a debug log and the chain keeps going.
- `webrtc-connection.js`: expose `closeAllRtcInstances()` (production name for the previously test-only `__resetRtcInstances`) and call it from logout. `clawConnection.disconnect()` only handles already-`setRtc`'d rtc instances, so an RTC whose init was still in progress (`clawConn.__rtc === null`) was orphaned in the module-level `rtcInstances` Map. A same-`clawId` re-login within the 15s fallback-timer window would reuse the old rtc Promise whose `onReady` closure points at the previous user's `clawConn`. `initRtc`'s `onStateChange` also now treats `'closed'` identically to `'failed'` so the in-closure `fallbackTimer` is cleared on external close — otherwise the stale 15s timer would fire after `closeAllRtcInstances` and call `rtcInstances.delete(clawId)` on the next user's fresh entry.
- `chatStoreManager.disposeAll`, `agentRunsStore.resetAll`, `clawConnectionManager.disconnectAll`: each now wraps the per-item cleanup call in a try/catch so a single failure does not halt the loop and leak the remaining items' timers / DC / blob URLs. `disconnectAll` additionally calls `__connections.clear()` at the end so an exception-skipped entry cannot be reused across users.
- `signaling-connection.js`: `disconnect()` now clears `__connIds` and `__connIdToClawId` maps. Normally each `clawConn.disconnect()` releases its own connId, but the new per-item try/catch above could swallow a failure and leave stale mappings on the singleton; the explicit clear guarantees fresh connIds for the next user.
- `chat.store.cleanup`: if cleanup runs while a slash command is still in flight (dispose path — events already missed, timer no longer relevant), actively settle `__slashCommandResolve` before nulling it instead of leaving the caller's await permanently pending.

Ordering-wise, `closeAllRtcInstances` is inserted between `disconnectAll` and `signaling.disconnect` so the existing dependency chain (`files.cancelAll` → `disconnectAll` → `signaling.disconnect`) is preserved and `rtc:closed` signaling frames can still reach the gateway.
