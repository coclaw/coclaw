---
"@coclaw/ui": patch
---

Two RTC recovery fixes exposed by an external review pass over the previously-shipped `pauseRestart` double-gate (commit 68d9f99). The review surfaced 14 observations; after triage, 8 were adopted (2 real bugs + 6 test-only hardenings); 5 were rejected and 1 was deferred to the backlog.

- **`__attemptRestart` catch block ignores paused/epoch, closes PC after pauseRestart** (`webrtc-connection.js:__attemptRestart`) — The resolve path guards `createOffer`/`setLocalDescription` awaits with both `__restartPaused` and `__restartEpoch` checks, but the catch block only checks `state`. If `pauseRestart` fires while `createOffer`/SLD is in flight and the returned promise later rejects (either because the browser aborted the operation or due to an unrelated error), the catch runs `this.close({ asFailed: true })`, violating the "paused = PC preserved until explicit resume" contract. Symptomatic leaks: offline-intensive environments would see otherwise-paused claws occasionally transition to `failed` and require a full rebuild on resume. Fix: mirror the resolve-path guards — if `__restartPaused` is set or the epoch has rotated (`__clearRestartState` path), drop the reject as tail-of-old-epoch noise and keep the PC.

- **`online_resume` fails to revert `__restartPaused` when `ensureConnected` rejects** (`webrtc-connection.js:__attemptRestart`) — When an `online_resume` call arrives while signaling is still down, `__attemptRestart` clears `__restartPaused` at the entry and then awaits `sig.ensureConnected()`. If that await rejects (persistent sig down), the original handler just returned, leaving `__restartPaused=false`. Subsequent automatic paths (`__onIceFailed`, keepalive, periodic recovery) would then pass the gate and burn through `ICE_RESTART_TIMEOUT_MS` until the PC was force-closed as failed — directly contradicting the design intent that a paused PC be preserved indefinitely. Fix: if the entry was a resume-from-paused (`resumingFromPause===true`), the epoch has not rotated, and state is still `restarting`, revert `__restartPaused=true`, zero out `__restartStartTime` so the next `online_resume` restarts the time budget cleanly, and stop the restart timer + poll (mirroring `pauseRestart`'s shutdown) to eliminate stale-interval noise during the paused window.

Test hardening (6 groups, 7 new tests total; baseline 2936 → 2943 UI tests, all green):

- **`__ensureRtc` post-await `removed` bail** (`claws.store.test.js`) — Covers the third branch of the post-await recheck trio (`offline` / `sig_offline` already covered): deleting `store.byId[id]` mid-await triggers `closeRtcForClaw` + `conn.clearRtc` recovery, and the in-progress lock is cleared so re-adding the claw can re-fire `initRtc`.
- **`updateClawOnline` same-value idempotence** (`claws.store.test.js`) — Two new tests: (a) consecutive `updateClawOnline(id, false)` calls emit only one `claw.online` `remoteLog` and invoke `rtc.pauseRestart` only once; (b) consecutive `updateClawOnline(id, true)` with `initialized=true` does not repeatedly invoke `__resumeOnline`.
- **`ensureConnected` under offline gate** (`signaling-connection.test.js`) — With `navigator.onLine=false`, `ensureConnected({ timeoutMs: 3000 })` creates no `MockWebSocket`, sets `__pausedOffline=true`, and rejects when the timer elapses.
- **`network:online` preempts offline-retry timer** (`signaling-connection.test.js`) — Toggling offline→online + dispatching `network:online` clears `__reconnectTimer` and creates a new WebSocket immediately (no 40s wait); `sig.reconnect resumed` log is emitted exactly once.
- **ChatPage connReady steady-state chatStore switch** (`ChatPage.test.js`) — With `dcReady=true` stable, switching `chatStore` from A (with `loadMessages` stuck on a never-resolving promise) to B does not let the A pending call block B: B's `loadMessages` fires via `__onConnReady`'s deduplication logic.
- **`__resumeOnline` handles `rtc.state='closed'`** (`claws.store.test.js`) — Completes the state matrix for the rebuild branch (`null` / `failed` already covered): `closed` also takes the `_pendingForceRefreshOnRebuild.add` + `__ensureRtc` fallback path and does not trigger `triggerRestart`; force-refresh propagates through to loaders.

**Review disposition** (14 observations total):

*Rejected (5):*
- `addOrUpdateClaw` pre-`fetched` sig-gate interaction — both `__freezeAllClawsForSigOffline` and `__resumeAllClawsForSigOnline` early-return when `fetched=false`, so there is no code path that can touch a just-added claw during the pre-snapshot window.
- `network:online(typeChanged=true)` mid-`__ensureRtc` init — the `_pendingTypeChangedRestartClaws` accounting + `__resumeOnline` consumption is already covered by the existing `typeChanged cross-gate integration` describe block (per-claw isolation, paused consumption, post-await ordering).
- Symmetry between `__resumeOnline` rebuild and `__handleNetworkOnline` rebuild w.r.t. `_pendingForceRefreshOnRebuild` — deliberate design: `__handleNetworkOnline`'s failed/closed branch is guaranteed to have a stamped `disconnectedAt` (from `onRtcStateChange('failed')`) so gap-aware `__refreshIfStale` handles it, while `__resumeOnline`'s DC-continuous branch has no such stamp and needs the explicit force marker.
- Extra malformed-id types for snapshot filtering (boolean/Symbol/array/numeric 0) — already blocked by the single `typeof !== 'string' && typeof !== 'number'` line that is exhaustively exercised by existing `{}` / `null` / `undefined` test cases.
- `manualRetryUnreachable` not checking `_sigOffline` directly — already logged as a UX backlog item in the previous round (`ui-rtc-paused-gate-stale-signaling` changeset); the behavior is benign (backoff clears + remoteLog fires but `__ensureRtc` no-ops under the sig gate), the wart is visual-feedback only.

*Backlog (1):*
- `rtc:restart-rejected` protocol lacks a generation id, so a stale reject arriving while the new restart is still in the `restarting` state cannot be distinguished from a current-generation reject. This is a protocol-design question (UI connId + `__restartEpoch` routing vs. a dedicated attempt id) rather than a test-coverage gap; testing around the current ambiguity would just get invalidated by whichever design direction is chosen. Deferred pending that decision.

*Adopted (8):* 2 code fixes + 6 test groups, as documented above.
