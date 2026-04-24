---
"@coclaw/ui": patch
---

Harden the `pauseRestart` gate so it cannot be bypassed by stale ICE restart signaling (`rtc:answer` / `rtc:ice` / `rtc:restart-rejected`). The earlier implementation only gated *outgoing* restart attempts (`__attemptRestart` entry), leaving the *incoming* signaling path unguarded: once `pauseRestart()` had been called (by `__handleClawGoOffline` or `__freezeAllClawsForSigOffline`), three leak paths could still defeat the freeze:

1. **Late `rtc:answer`** — `__onSignaling` called `pcAtAnswer?.setRemoteDescription(...)` unconditionally. With a fresh remote SDP applied, ICE could complete naturally, `onconnectionstatechange('connected')` would then fire → `__clearRestartState()` → `__restartPaused` cleared + `__setState('connected')` + `__startKeepalive()`. The freeze was silently undone by the peer's callback.
2. **Late `rtc:ice`** — `__onSignaling` called `__pc?.addIceCandidate(...)` unconditionally. Same end result as (1): helps ICE complete and reach connected.
3. **Late `rtc:restart-rejected`** — the existing `if (this.__state !== 'restarting')` guard was insufficient because `pauseRestart()` deliberately leaves `__state === 'restarting'` (it only flips `__restartPaused=true` and bumps `__restartEpoch`). A stale reject from an older restart round would pass the guard and call `this.close({ asFailed: true })`, killing the PC, emitting `rtc:closed` to the plugin, and clearing `__restartPaused` via `__clearRestartState`.

Fix is a single guard at the top of `__onSignaling(msg)` — when `__restartPaused` is true, drop the message at debug level and return. All three branches (`rtc:answer` / `rtc:ice` / `rtc:restart-rejected`) are covered uniformly. Resume paths (`resumeRecovery` / `triggerRestart('online_resume')`) both clear `__restartPaused` before they issue new signaling, so new-generation messages are not affected. The existing stale-state guard inside `rtc:restart-rejected` is preserved (two independent staleness criteria: `state !== 'restarting'` vs `__restartPaused`). The `__restartEpoch` / `__clearRestartState` mechanism stays — it guards *in-flight awaits* inside `__attemptRestart`, which is a different concern from entry-level signaling drops.

Updated `pauseRestart` JSDoc to document the two-sided gate (outgoing `__attemptRestart` entry + incoming `__onSignaling` entry).

Tests: added `describe('paused gate 抗迟到 signaling')` with 5 tests — three for `restarting + paused` (covering all three message types) and two for `connected + paused` (covering `answer` / `ice`; `restart-rejected` is already dropped by the independent stale-state guard in the connected case). Each test uses precise `toHaveBeenCalledTimes(0)` / state assertions (not just `.not.toHaveBeenCalled()`). All 245 tests in `webrtc-connection.test.js` pass; full `pnpm test`: 2931 → 2936 UI passing, 152 electron unchanged, 0 skipped.

Evaluated 15 test-gap suggestions from an external review in the process; this commit acts on the 2 that exposed real bugs (the stale signaling leaks above). The remaining 13 suggestions were verified as already covered, orthogonal design intent, or server-contract guarantees that don't warrant defensive tests — detailed rationale in the commit that introduced this changeset.

Out of scope (backlog): `manualRetryUnreachable()` does not check `_sigOffline` directly, which is a UX wart rather than a correctness bug — clicking "retry" while signaling is down produces a `claw.manualRetry` remote log and clears the backoff counter but does not initiate a rebuild (blocked by `__ensureRtc`'s sig gate). Deferred for a separate UX pass.
