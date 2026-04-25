---
"@coclaw/ui": patch
---

One real recovery bug surfaced by an external review pass and 4 test groups (5 new tests, 2 reverse-assertion strengthenings). Review covered 12 observations; after triage, 6 were adopted (1 code fix + 5 test/doc improvements); 4 were rejected, 2 were deferred to backlog.

- **`__checkAndRecover` post-probe `failed`/`closed` path is silently dropped** (`claws.store.js:__checkAndRecover`) — When `probe()` rejects/times out and the PC has dropped to `failed`/`closed` *during* the probe wait, the original code called `rtcAfter.triggerRestart('probe_failed')`. But `WebRtcConnection.triggerRestart` only enters `__attemptRestart` when `state === 'restarting' || 'connected'` and silently no-ops on `failed`/`closed` — recovery is dropped on the floor. The pre-probe path of the same function correctly routes `failed`/`closed` to a full `__ensureRtc` rebuild; the post-probe path was asymmetric. Symptom in production: a claw whose PC died during the brief probe window stays unreachable until the next `__checkAndRecover` tick (typically the next `app:foreground` event), incurring a multi-second user-visible gap on top of the probe timeout. Fix: mirror the pre-probe path — when `rtcAfter.state === 'failed' || 'closed'`, mark `rtcPhase = 'recovering'`, `__clearRetry`, and fire `__ensureRtc` rebuild. Other `rtcAfter` states (`restarting` / `idle` / `connecting`) keep the existing `triggerRestart('probe_failed')` path. The remoteLog now also carries `source=` for diagnostic continuity with the pre-probe log.

Test changes (4 groups, 5 new tests + 2 reverse-assertion strengthenings; baseline 2943 → 2947 UI tests, all green):

- **`__checkAndRecover` post-probe path symmetry** (`claws.store.test.js`) — Three previously-existing tests that locked the buggy `triggerRestart` behavior were rewritten to assert the correct rebuild behavior (`closeRtcForBot` + `initRtc` called, `triggerRestart` not called). One new test added (`probe 失败 + PC 变 restarting → triggerRestart('probe_failed')`) to keep the transient-state path covered against future regressions.
- **`addOrUpdateClaw` + `fetched=false` + sig disconnect** (`claws.store.test.js`) — Locks the design intent of `__freezeAllClawsForSigOffline`'s `!fetched` early-return: a claw added via `addOrUpdateClaw` before snapshot completes (so `fetched` is still false) is intentionally not paused on sig disconnect. Anchor for "filter logout / pre-snapshot sig noise events" semantics; if someone removes the gate, this test catches it.
- **SSE error / heartbeat timeout reverse assertions** (`use-claw-status-sse.test.js`) — Added 4 reverse assertions (`applySnapshot` / `updateClawOnline` / `addOrUpdateClaw` / `removeClawById` not called) to both the existing `should set connected=false on error` and `heartbeat timeout should restart SSE` tests. Locks the contract that SSE channel faults are a transport-level concern only; they must never be conflated with claw presence mutations.
- **ChatPage topic mode DC rebuild smoke** (`ChatPage.test.js`) — Topic-route mount with `topic:sess-1` chatStore (`topicMode === true`): on DC rebuild (dcReady false→true), exactly one silent `loadMessages({ silent: true })` fires and `__loadChatHistory` is not called. Mirrors the existing session-mode coverage and locks the topic branch of `__onConnReady`'s deduplication.
- **`applySnapshot` duplicate id last-wins** (`claws.store.test.js`) — Locks the contract that `applySnapshot([{id:'d1', ...}, {id:'d1', ...}])` produces a single `byId['d1']` entry with the second item's data, and that `manager.syncConnections` is called exactly once (not N times for N duplicates). Manager-level dedup is its own responsibility, asserted by its own tests.
- **`setClaws` JSDoc as test-only** (`claws.store.js`) — Added an `@internal Test-only.` JSDoc block above the `setClaws` action with a one-line warning: it bypasses the `fetched` gate and lifecycle side-effects, must not be used in production code paths. Documents an existing convention (the action has no production callers) without renaming.

**Review disposition** (12 observations total):

*Rejected (4):*
- `__resumeOnline` returns early when `_sigOffline` and skips dashboard sync — by design (presence and dashboard decouple under environmental fault; sig-resume path runs `__resumeAllClawsForSigOnline → __resumeOnline` to backfill). Already covered by existing test `__resumeOnline _sigOffline=true 入口早退`.
- Repeated `updateClawOnline(false)` idempotence — already covered by round 15 (commit `fa42501`).
- `__resumeOnline` when `initialized=true` but `getConn()` returns null — already covered by existing `conn 不存在 → 安全返回` test; the no-rebuild + no-force-refresh branch is by design (the conn-missing window is a teardown race; rebuild is left to the next resume tick rather than queueing a stale `_pendingForceRefreshOnRebuild` entry).
- Multi-claw freeze/resume isolation against per-claw exceptions — `pauseRestart` is pure assignment + timer-stop on stable RTC objects, cannot throw under any production-reachable state; robustness coverage value too low to justify the test mass.

*Backlog (2):*
- Files store cache (`useFilesStore.dirCache`) is not invalidated on rebuild via `refreshClawResources` — by design (lazy invalidation: `FileManagerPage` always force-refreshes `loadDir` on `connReady`, the cache is just a cross-page transition fallback). Worth noting in the lifecycle doc next time we touch it; not a test gap.
- `manualRetryUnreachable` under sig offline silently no-ops via downstream `__ensureRtc` gate — same UX wart already noted in round 15's backlog (`ui-rtc-paused-gate-stale-signaling` changeset). Deferred pending a UX redesign (button disabled state or toast); behavior is benign.

*Adopted (6):* 1 code fix + 4 test groups + 1 doc, as documented above.
