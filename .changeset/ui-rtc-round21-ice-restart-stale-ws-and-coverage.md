---
"@coclaw/ui": patch
---

Close one ICE-restart staleness bug and lock several recovery contracts that were exercised at module level but lacked end-to-end test coverage.

1. **`__attemptRestart` skipped `sig.ensureConnected()` when `sig.state === 'connected'`** — the only `lastAliveAt > HB_TIMEOUT_MS → forceReconnect` staleness check lives inside `signaling-connection.js:ensureConnected`; `__sendRaw` and `sendSignaling` perform no freshness check. During a typeChanged window (Wi-Fi ↔ cellular) the underlying TCP can die silently while `sig.state` is still `'connected'` (heartbeat hasn't fired yet — up to 45s window). Under the previous early-skip, ICE restart pushed `rtc:offer` straight into the dead WebSocket. Fixed by removing the `sig.state !== 'connected'` early-skip — `__attemptRestart` now always `await sig.ensureConnected()`. The healthy-WS path inside `ensureConnected` is essentially free (one branch + return). All post-await guards (epoch / state / `__pc`) and the `resumingFromPause` revert path are preserved. The new flow-trace log line is at `debug` level (not `info`) since it now fires on every restart cycle; the two failure-branch logs stay `info`.

Tests (8 new groups, 9 new tests; baseline 3002 → final 3011):

- `webrtc-connection.test.js` — `triggerRestart from connected：始终 await ensureConnected（让陈旧 WS 检查有机会触发）`: locks fix 1 by asserting `mockEnsureConnected` is called exactly once even when `sig.state==='connected'`, and that `rtc:offer` is sent strictly after via `invocationCallOrder`.
- `webrtc-connection.test.js` — `dc.onerror 单独 fire 不动 state、不发 rtc:closed、不重建 PC`: locks the standalone-error log-only contract; reverse-asserts `state` / `__rpcChannel` / `__pc` / `__closed` / signaling / restart-timer all unchanged.
- `webrtc-connection.test.js` — `多 chunk 发送中 DC 关闭 → 整体 promise reject "DataChannel closed"，队列清空`: covers the previously uncovered `__enqueueSendMulti` rejection contract under DC close mid-flight; asserts `__sendQueue.length === 0` and `__rpcChannel === null` so no chunk leaks across rebuild.
- `webrtc-connection.test.js` — pair: `pauseRestart 后 createOffer reject → 不发 rtc:closed、保持 restarting + paused` and `pauseRestart 后 setLocalDescription reject → 不发 rtc:closed、保持 restarting + paused`: pair to round-15's resolve-side tests; covers the reject branch through the paused / epoch guard so a late reject does not get mis-treated as `failed` and does not push `rtc:closed`.
- `claws.store.test.js` — `sig offline + __fullInit rollback 之后再调一次 → 每次都重新尝试 fullInit (锁现状)`: locks current behavior under SSE storms — repeated `updateClawOnline(true)` calls each re-attempt full init after rollback. JSDoc notes this is a current-behavior lock, not a permanent contract.
- `claws.store.test.js` — `B4: 同一 id 在 snapshot 内出现两次 (true 后 false) → 锁当前 quirk: 触发 handleClawGoOffline，不触发 resumeOnline`: locks the known B4 `prevOnlineMap` post-assign quirk in the reverse direction; JSDoc references the B4 backlog so a future fix will rightly fail this test.
- `claws.store.test.js` — `sig offline + manualRetryUnreachable → ensureRtc 入口 sig gate 拦住、initRtc 不被调；sig 恢复后由 resumeOnline 接手`: locks the UX contract — manual retry while sig is offline clears the retry counter but does not call `initRtc`; sig recovery routes through `__resumeAllClawsForSigOnline` → `__resumeOnline` to re-engage.
- `ChatPage.test.js` — `contract: online=false + dcReady=true → 显示离线 banner 但 ChatInput 仍允许输入`: locks the product contract — `connReady` deliberately ignores `claw.online` so input stays enabled even when the offline banner is shown. JSDoc documents this is a product-contract lock.

Structural review-adoptions (correctness + design-consistency reviews each independently flagged):

- New `ICE restart: ensureConnected check reason=` log downgraded from `info` to `debug` — it now fires on every restart cycle and is a flow trace, not a noteworthy event; failure-branch logs stay `info`.
- Misleading comment in chunked-send test (referenced `rtc.close` which the test never invokes) replaced with the actually-checked invariant — `dc.onclose` synchronously nulls `__rpcChannel`.

Review disposition (round 21, 12 suggestions from external agent):

- **Adopted (8): 1 code fix + 7 test-only adoptions** — fix 1 above; the seven test groups for items 2/4/5/7/8/10/11. Item 1 contributes both the code fix and the locking test.
- **Rejected (4)**:
  - `network:online(typeChanged=true)` cross-module integration test — made redundant by fix 1: `await sig.ensureConnected()` now acts as a synchronization point so subscriber-ordering between the claws-store and signaling-connection handlers can no longer race the offer through a stale WS. Existing per-module unit tests already cover the individual handlers.
  - `__resumeOnline` when `conn` is missing — already covered by the `G-04` test (typeChanged Set entry preserved, `triggerRestart`/`resumeRecovery` not called, `conn.rtc` untouched). The dashboard-sync vs retry-state asymmetry is intentional (dashboard display sync must run regardless of conn; retry timer doesn't need clearing because nothing was started). Adding belt-and-suspenders assertions has marginal value.
  - `__probeNow` "clear old keepalive timer" branch — structurally unreachable from real call sites: `__probeNow` is only called from `resumeRecovery`, which requires `__restartPaused === true`, and `pauseRestart` always synchronously clears `__keepaliveTimer`. The branch is a defensive guard against future call-site drift; testing it would require constructing an unreachable state.
  - logout/reset during in-flight sig resume / `__ensureRtc` — algebraically covered by existing tests: `__resetClawStoreInternals` clearing `_pendingTypeChangedRestartClaws` / `_rtcInitInProgress` / `_pendingForceRefreshOnRebuild` / `_sigOffline` is locked in the typeChanged + reset describe blocks; `__ensureRtc` post-await `removed` / `replaced` bails are locked in the round-20 Bug 2 describe block. A composite timeline test would be documentation only.
