---
"@coclaw/ui": patch
---

Test-only patch covering coverage gaps surfaced by an external review pass plus one documentation drift fix. Review covered 10 observations; after triage, 5 were adopted (4 test groups + 1 doc fix); 4 were rejected as already covered by existing test families; 1 was deferred (already-known UX backlog).

No code behavior changes; this round adds regression locks for branches that recent rounds left implicit.

Test changes (4 groups, 6 new tests; baseline 2983 → 2989 UI tests, all green; electron 152 unchanged):

- **`P0-4: setLocalDescription 跨 await close`** (`webrtc-connection.test.js`) — Two tests extending the round 17 P0-4 family to cover `__buildPeerConnection`'s third await. (a) `setLocalDescription` pending → `close()` → late resolve: asserts `pcInstances.length` unchanged, no `rtc:offer` sent, state stays `closed`, `__pc === null`. (b) `setLocalDescription` pending → `close()` → late reject `InvalidStateError`: asserts `connect()` promise does not reject (the SLD try/catch + epoch guard swallows the abort-tail noise) and no side effects propagate. With this round `__buildPeerConnection`'s three awaits (`ensureConnected`, `createOffer`, `setLocalDescription`) are all covered for both late-resolve and late-reject under close.

- **`typeChanged cross-gate: !initialized claw + Set 自动消费`** (`claws.store.test.js`) — One test in the existing `typeChanged cross-gate integration` describe. Locks the contract that `__resumeAllClawsForSigOnline`'s `!initialized` branch actively `_pendingTypeChangedRestartClaws.delete(id)` when running `__fullInit`. Three-stage construction: (1) sig down + `network:online typeChanged=true` records the !initialized claw into the Set; (2) sig up routes the claw through `__fullInit` (not `__resumeOnline`); (3) reverse-fact: a second sig cycle with no `network:online` and the claw now `connected+paused` runs `resumeRecovery` (would upgrade to `triggerRestart('online_resume')` if Set residue from stage 1 leaked through). If the explicit `_pendingTypeChangedRestartClaws.delete(id)` in the !initialized branch is removed, stage 3's reverse-fact assertion fires.

- **`G-01b: offline bail 残留清理`** (`claws.store.test.js`, in `_pendingForceRefreshOnRebuild bail 残留清理` describe — renamed from the previous `sig_offline bail` since it now covers both bail reasons) — One test mirroring the existing `sig_offline bail` test for the `offline` bail path. Covers: (a) rebuild starts → `_pendingForceRefreshOnRebuild.add('1')`; (b) `__ensureRtc` post-await sees `claw.online=false`, bails with `reason=offline`, sets `rtcPhase='failed'` and clears the Set; (c) a subsequent independent `__ensureRtc` rebuild sees the Set empty, runs with `force=false`, and `__refreshIfStale` short-circuits on the `gap<BRIEF_DISCONNECT_MS` gate (loaders not called, no `force_refresh=1` log line). Test comment explicitly notes the offline bail path does **not** restore the previous `disconnectedAt` (unlike `sig_offline`), so the gap-gate is what protects against spurious force-refresh — verified by an explicit `disconnectedAt > 0` assertion at stage 2.

- **`__onConnReady await 后 unmount/store 切走 guard`** (`ChatPage.test.js`) — Two tests locking the round 18 `try/finally + succeeded flag` rollback contract. (a) Component unmounts during `await loadMessages()`: late resolve hits the `__unmounted` guard, skips `__loadChatHistory`, finally rolls back `__connReadyStore = null`. (b) `chatStore` switches during `await loadMessages()`: late resolve hits the `this.chatStore !== targetStore` guard, skips `__loadChatHistory` on the old store, rolls back guard, and a subsequent re-entry on the original store proceeds normally (verifying the dedup guard does not lock out future entries on rollback).

Documentation:

- **`docs/designs/ice-restart-recovery.md`** — Updated §4.1 (`createDataChannel` row in "其他联动修改") and §6.7 (large-file upload during network switch) to reflect the current implementation: `createDataChannel()` is permitted during `restarting`, the new DC parks in `connecting` and opens itself once ICE is rebuilt; rejection only when `!__pc || state in {'closed','failed'}`. The previous "restarting 时返回 null" wording dated to before commit `9e24cbe fix(ui): allow file DC creation during ICE restart` and would have misled future review of the file-transfer recovery model.

**Review disposition** (10 observations):

*Adopted (5):* 4 test groups + 1 doc fix, as documented above.

*Rejected (4):*
- `sig offline + 异步重复 updateClawOnline(id, true)` — already covered by `P1-3: sig offline 重复 updateClawOnline 防回归` (synchronous burst form); the proposed async-repeat path's only side effect is one fullInit log + one try/catch warn, with `__ensureRtc` sig gate blocking ICE/TURN. Not a coverage gap.
- `applySnapshot 在 _sigOffline=true 下的 online transition` — `true→false` is presence-only via `__handleClawGoOffline` (already covered by `online true→false + initialized → __handleClawGoOffline`); `false→true` is gated by `__resumeOnline` entry sig-gate (already covered by `SSE ordering: rtcPhase=failed no-op snapshot during sig offline → resume 被 sig gate 拦截`).
- `getReadyConn online/dcReady 解耦直接测试` — the helper's body reads only `byId[id]?.dcReady` and the connection table; existing `get-ready-conn.test.js` 5 cases never reference `online` (implicit independence assertion); a redundant explicit case adds no signal.
- `applySnapshot duplicate existing id + online 冲突` — already covered by `P2-3: applySnapshot dup-id online conflict` which locks last-write-wins online, single `__resumeOnline` call (Phase 3 Set dedup), and `__handleClawGoOffline` not called.

*Backlog (1):*
- `manualRetryUnreachable() 在 _sigOffline=true 时点击是 UX 假反馈` — already on the backlog from rounds 15-16 (button visible but `__ensureRtc` sig gate silently no-ops). Behavior is benign; will be addressed alongside the planned global SignalingBanner UX work, not as a standalone test addition.
