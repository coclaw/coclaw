---
"@coclaw/ui": patch
---

Round 23 — 7 async-boundary / module-state-cleanup fixes + 11 new tests.

External-review-driven test hardening (round 23). Codex produced 14 candidate suggestions; 7 adopted as real bugs, 7 rejected (3 design-intent, 2 dead-code or already-covered, 2 unreachable-via-upstream-gate). Two reviewer subagents identified 4 non-blocking adoptions, all incorporated.

**Code fixes (7):**

1. `webrtc-connection.js:initRtc` — guard the late `httpClient.get('/api/v1/turn/creds').then(...)` chain. If the fallback timer fired (or `closeRtcForClaw` ran) **while** TURN was still pending, the close path cleared `rtcInstances[id]` + called `clawConn.clearRtc()` + settled `'failed'`, but the late `.then((resp) => rtc.connect(resp.data))` would still run on the (now closed) rtc, build a new PC, and emit a stray `rtc:offer` over signaling — an orphan PC not tracked by any store. Added `if (settled || rtcInstances.get(clawId) !== rtc) return;` at the `.then` entry. The `.catch` arm was already correct.

2. `agents.store.js:loadAgents` — the `finally(() => _loadingByClaw.delete(id))` after a stored in-flight promise unconditionally deleted the Map entry, even after `removeByClaw` cleared and re-bound a new claw with the same id and a NEW load was already stored. The stale finally would erase the NEW dedup entry, causing a third concurrent `loadAgents(id)` call to issue a third RPC instead of coalescing. Changed to `if (_loadingByClaw.get(id) === p) _loadingByClaw.delete(id)` (promise identity).

3. `sessions.store.js:loadSessionsForClaw` — same family as #2, applied to `_perClawLoading`.

4. `topics.store.js:loadTopicsForClaw` — same family as #2 / #3.

5. `claw-lifecycle.js:refreshClawResources` — was `function` firing all four loaders in parallel; `useSessionsStore().loadSessionsForClaw(id)` reads agents from `agentsStore.getAgentsByClaw(clawId)` and falls back to `['main']` when empty. On RTC reconnect refill, sessions for non-`main` agents added during the disconnect window were missed. Aligned with `initClawResources`: made `async`, `await loadAgents(id).catch(() => {})` first, then fire-and-forget the other three with `.catch(() => {})`. The single caller (`claws.store.js __refreshIfStale`) was updated to chain `.catch(() => {})` for unhandled-rejection symmetry with the adjacent `checkPluginVersion` chain.

6. `sessions.store.js:__doLoadAll` — `__fetchSessionsForClaw` returns `[]` on `getReadyConn(clawId)` null. If a claw's conn vanished mid-`Promise.allSettled` (e.g., synchronous SSE `claw.unbound` during the await tick), the fulfilled `[]` would leave the claw in `queriedClawIds` and the merge step would purge the claw's still-valid old sessions. Added a result-time `getReadyConn(cid)` re-check that drops the claw from `queriedClawIds` (preserving old sessions). The `getReadyConn(id)` early-return inside `__fetchSessionsForClaw` is unchanged.

7. `chat-store-manager.js:__evictTopics` — `dispose(key)` was called bare (unlike `disposeAll` which wraps each in try/catch). A throwing victim's `dispose` propagated up through `get(storeKey)` after the new entry had already been inserted in `instances` and `topicLru`. Added per-iteration try/catch. Because `dispose()` throwing leaves the victim still in `instances` and `topicLru`, the outer `while` would re-pick the same victim and infinite-loop, so the catch handler manually `instances.delete(key)` + `topicLru.splice(...)` to advance, plus a guarded `store?.$dispose()` to release Pinia subscriptions the original `dispose()` skipped. Warn log format `evict dispose key=%s failed: %s` aligned with `disposeAll`'s `dispose key=%s failed: %s` (kept `warn` level — eviction silently leaks state, so severity is higher than `disposeAll` which iterates all).

**Test changes (11 new tests, baseline 3024 → 3035; electron 152 unchanged; coverage gates green):**

- `webrtc-connection.test.js` — `initRtc — RTC 建连` describe (3 tests):
  - `fallbackTimer fire 后晚到的 TURN creds 不调 rtc.connect 也不创建 orphan PC`
  - `外部 closeRtcForClaw 后晚到的 TURN creds 不调 rtc.connect`
  - `TURN creds 在 fallbackTimer 之前正常 resolve 时仍调 rtc.connect 一次` (reverse)
- `agents.store.test.js` — 同 id 重绑：旧 loadAgents 的 stale finally 不删替换 promise
- `sessions.store.test.js` — 同 id 重绑：旧 loadSessionsForClaw 的 stale finally 不删替换 promise
- `sessions.store.test.js` — `__doLoadAll：fetch 期间 conn 消失，已有 sessions 不被清空`
- `sessions.store.test.js` — `__doLoadAll：conn 健康但远端真空 sessions 时旧 sessions 仍被清空（反向断言）` (review-adopted reverse assertion)
- `topics.store.test.js` — 同 id 重绑：旧 loadTopicsForClaw 的 stale finally 不删替换 promise
- `claw-lifecycle.test.js` — `refreshClawResources：先 await loadAgents 再 fire-and-forget 其他三个`
- `claw-lifecycle.test.js` — `loadAgents reject 时其他三个仍 fire（catch 吞掉）`
- `chat-store-manager.test.js` — `__evictTopics：受害者 dispose 抛异常被隔离，不影响新 topic 创建`

Three pre-existing tests in `claws.store.test.js` (`__refreshIfStale` block) were bumped to `async` because Fix 5 changed `refreshClawResources` from sync to async; assertions unchanged, only added `await Promise.resolve()` flushes between trigger and assertion.

**Review disposition:**

Adopted (11): 7 code fixes + 4 test-only adoptions (1 reverse assertion + 3 from non-blocking review feedback: `claws.store.js` caller `.catch`, `__evictTopics` log format alignment, `__evictTopics` `$dispose` cleanup safety, `__evictTopics` `failed: %s` format).

Rejected (7): #1 `chat.store __reconcileMessages` (dead code, 0 production callers); #7 `topics __doLoadAll` index drift (synchronous filter, no async boundary); #9 `setupNetworkListener` offline cancel pending online (debounce intentionally absorbs flips); #10 initial `getStatus` race (microtask-level, consumers self-correct); #11 signaling `connect` timer (only login caller, timer cannot be pending); #12 `claw-connection __handleRpcResponse` callback throw (reassembler outer try/catch + RPC_TIMEOUT timer already provide isolation); #14 `__evictTopics` settling streamingMsgs eviction (already locked as 契约锁 test).

Backlog: none new this round.
