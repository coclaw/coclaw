# @coclaw/ui

## 0.17.5

### Patch Changes

- 39051af: fix(ui): wait for OpenClaw transcript persistence before dropping streaming overlay

  Bug 1 surfaced as agent replies showing "task incomplete" until the user
  left and re-entered the chat. Root cause is a timing race in the OpenClaw
  gateway: the `lifecycle:end` event is emitted before the `await
persistCliTurnTranscript` call that writes the final assistant message
  to the session transcript file (which `chat.history` reads). UI had four
  OR-gated `endRun` signals with first-wins semantics, and `lifecycle`
  typically beat the `rpc` two-phase response. So the post-accepted
  `runPromise.then(...)` hook tore down the streaming overlay and reloaded
  chat history while the transcript was still mid-write — the latest
  assistant lacked `stopReason`, `resultText` resolved to null, and the
  component fell back to the "task incomplete" branch.

  `chat.store` now distinguishes `endReason === 'rpc'` (upstream guarantees
  transcript is already flushed at that point — async/await chain in
  `agent-command.ts` runs persist before responding) from the rest. The
  fast path drops the overlay immediately; other paths wait 1s, reload,
  verify the latest assistant after the run anchor carries a non-`toolUse`
  `stopReason`, then retry once after another 2s if still missing. If both
  attempts come back without `stopReason`, the UI falls back to the legacy
  behavior (drop overlay even though display will degrade) and emits a
  single `agent.run.persist-stale` remote log so the rare upstream
  persistence failures stay visible. Silent loadMessages failures still
  preserve the overlay and rely on the existing 24h watchdog and
  re-entry/reconnect reload paths.

- ae58392: Lock in ChatPage `connReady` watcher contracts across claw/sig offline-online gating + RTC rebuild / ICE restart paths with a new regression suite (6 tests, no production-code changes).

  ChatPage already reconciles messages after rebuild via its `connReady` watcher (`ChatPage.vue` `watch.connReady.handler` → `__onConnReady` → `chatStore.loadMessages({silent:true})`), driven purely by `claw.dcReady` flips. The prior test file covered the happy-path flips (online→true, first-mount, sending-skip, chatStore re-activate) but not the subtler invariants around the dual gate (claw presence / signaling WS) introduced across rounds 11-14 and now codified in `__handleClawGoOffline` / `__freezeAllClawsForSigOffline`. Those two gates deliberately leave `dcReady` / `rtcPhase` untouched (presence + environmental-fault are orthogonal to DC lifecycle — see `docs/architecture/communication-model.md` §5.5 / §5.5.1), so the UI's reconcile is meant to stay quiet across both gates and only react to the underlying DC state.

  Added `describe('ChatPage recovery watchers')` at the bottom of `src/views/ChatPage.test.js`:

  - **T1** — `claw.online=true→false` (via `updateClawOnline`) does not touch `dcReady`; `connReady` stays true and the silent-reload watcher does not re-fire. Locks "`__handleClawGoOffline` is presence-only".
  - **T2** — After claw offline the DC eventually closes (`dcReady=false` / `rtcPhase='failed'`), `connReady` flips false, and when online returns with a new DC (`dcReady=true`) `loadMessages({silent:true})` is called exactly once. Full cycle via `dcReady` flip.
  - **T3** — ICE restart with DC continuity: `rtcPhase` bounces `ready → restarting → ready` while `dcReady` stays true throughout; `connReady` stays true and no silent reload fires. Locks "short RTC jitter does not churn data" (per `claws.store.js` `__rtcCallbacks` state=`connected` wasDisconnected=false branch).
  - **T4** — ICE restart that forces a DC rebuild: `dcReady` goes `true → false → true`; exactly one silent reload fires after the rebuild.
  - **T5** — `__freezeAllClawsForSigOffline` leaves `dcReady` untouched (only invokes `__clearRetry` + `pauseRestart`); `connReady` stays true and no reload fires. Sets `clawsStore.fetched=true` explicitly so the freeze body actually executes (`setClaws` doesn't set `fetched`; the early-return at the top of the freeze action would otherwise make the assertion vacuous).
  - **T6** — First mount during sig-offline with `dcReady=false` (`__fullInit` blocked by sig gate): `connReady` starts false and immediate watcher early-returns; once sig recovers and the full init completes (`dcReady=true`), the watcher fires `loadMessages()` (first-load path, non-silent).

  Each test has ≥3 precise assertions (exact call counts + exact argument shapes where applicable, not just `toHaveBeenCalled`). No business-code or other-test-file changes. `pnpm test` UI: 2925 → 2931 passing, 0 skipped. `pnpm check`: 0 errors.

- d10bbe4: fix(ui): unify claw id whitespace normalization across applySnapshot and addOrUpdateClaw

  `__validateClawId` already trims and rejects empty / sentinel ids, but
  `applySnapshot` was discarding the trimmed return value and using
  `String(b.id)` as the `byId` key, so an id like `'  bot-1 '` from the
  snapshot path landed under a different key than the same id arriving
  through `addOrUpdateClaw`. Snapshot now consumes the validated id as both
  the `byId` key and the `createClawState` input, and `addOrUpdateClaw` now
  also passes the validated id into `createClawState` so `state.id` matches
  the `byId` key on the insert path.

- 4a05074: Decouple `dcReady` from `claw.online` presence. `dcReady` is now strictly a reactive mirror of the real DataChannel readyState (`rtc.isReady`); offline events no longer write it. Dashboard/agents/sessions/topics refresh on presence recovery is triggered explicitly by `__resumeOnline` (split by `rtc.state` into immediate vs after-rebuild), so pending RPCs are not fast-failed during offline and can resume via SCTP once ICE restart succeeds.

  Also fixes two pre-existing issues: `dc.onclose` now escalates to `close({asFailed:true})` in both `restarting` and `connected` states (previously only `restarting`), so `store.dcReady` stays in sync with the real DC; `onRtcStateChange('connected')` clears `disconnectedAt` even on the `wasDisconnected=false` branch, preventing stale stamp accumulation across successive ICE restarts.

- 30d5344: fix(ui): only bump network baseline counter when normalized type written

  The Capacitor network listener bumped `_networkEventCount` on every event,
  including offline (`connected:false, type:'none'`) ones. That counter is also
  the gate that decides whether a slow `Network.getStatus()` may write the
  initial `_lastConnectionType` baseline. So the cold-boot sequence
  "offline event → slow getStatus resolves wifi → real wifi→cellular switch"
  ended with `_lastConnectionType` still null, the cellular event computed
  `typeChanged=false`, and the store layer skipped the ICE restart that should
  have fired. Move the counter bump inside the `connected && normalized` branch
  so only baseline-writing events count, leaving offline events out of the way.

- 5417b9f: Gate RTC recovery actions on `claw.online`: when SSE reports the plugin as offline, pause the in-flight ICE restart (reset its 90s budget, keep the PC), cancel pending backoff retries, and skip probe/restart/rebuild attempts. When the plugin comes back online, resume via a fresh ICE restart if the PC was paused in `restarting`, otherwise rebuild from scratch. Avoids burning recovery budget while the plugin is known-unreachable, while still leveraging ICE restart's fast-path on return.
- 8c87df5: fix(ui): parallelize refreshClawResources sub-loads, gate only sessions on agents

  After RTC reconnect recovery, `refreshClawResources` used to await `loadAgents`
  before firing topics, sessions, and dashboard. Only sessions actually depends
  on the agent list (the fallback `['main']` would miss non-main agents added
  during the disconnect window) — topics is hard-coded to `agentId='main'` and
  dashboard runs its own internal `loadAgents`. Fire all three immediately and
  keep the agents promise as a gate only for sessions, removing one round-trip
  from every reconnect-recovery refresh.

- 08678c6: Round 23 — 7 async-boundary / module-state-cleanup fixes + 11 new tests.

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

- e2d248b: fix(ui): collapse "wait for persistence" into agent-runs source via rpc grace window

  The Bug 1 follow-up review surfaced a fast-follow-up regression in the
  prior `chat.store` fix: when the user sent a second message inside the
  3s persist-wait window of the first, the second run's
  `hasTerminalAssistantAfter(messages, anchorId)` check could match the
  first run's just-persisted final assistant (it sits after the second
  run's anchor by construction) and prematurely drop the second overlay
  before its transcript was flushed. Root cause: the predicate had no
  runId/turn discriminator, so any terminal assistant after the anchor
  counted.

  Move the "wait for persistence" responsibility from `chat.store` (which
  can't reliably distinguish runs) to the source state machine
  (`agent-runs.store`), which has authoritative `runId` context. When
  `lifecycle:end` or `agent.wait` terminal status arrives, we no longer
  fire `__endRun` immediately — we schedule a `RPC_GRACE_MS` (default 2s)
  pending and wait for the `rpc` two-phase response (the only signal that
  guarantees transcript is already flushed via the upstream synchronous
  await chain). If the `rpc` response arrives within the window, we clear
  the pending and run finishes as `endReason='rpc'`. If the window
  elapses, we fall back to the originally-recorded reason. The `failed`
  signal (DC closed / RPC error) skips the grace and ends immediately
  since the second-phase response can't possibly arrive.

  `chat.store.__awaitPersistAndDrop` is simplified accordingly: the
  endReason-based slow/fast path split, the 1s + 2s sleep + retry, the
  `hasTerminalAssistantAfter` predicate, and the `agent.run.persist-stale`
  fallback log are all removed. The function now does a single
  `loadMessages → dropRun`, identical for every endReason. Silent
  loadMessages failures still preserve the overlay (24h watchdog +
  activate/reconnect reload still cover the rare double-failure case).

  A diagnostic `agent.run.rpc-grace-elapsed runId=… reason=lifecycle|wait`
  remoteLog is emitted when the grace timer expires without an `rpc`
  signal — this replaces the removed `persist-stale` log so we retain the
  ability to observe upstream rpc-2nd-phase delivery anomalies and tune
  `RPC_GRACE_MS` if needed.

  The fast follow-up bug is eliminated because the source-side grace
  delays `runPromise` resolve by up to 2s, during which `isRunning`
  remains true and the user cannot send a new message — the timing window
  that produced the predicate confusion never opens. The user-visible
  cost is at most a 2s extension of the "thinking" overlay on slow rpc
  paths; when rpc arrives early (the common case) the grace clears
  immediately and overlay teardown is unchanged.

- 447b29e: RPC over DataChannel response timeout tuning for weak-network safety:

  - `coclaw.info` (plugin version check): drop explicit 10s, fall back to default 30s — first-call path waits on plugin `waitForSessionsReady` and 10s was tight under slow-start conditions.
  - Dashboard 7-call fan-out (`status` / `models.list` / `usage.cost` / `sessions.list` / `tts.status` / `channels.status` / `tools.catalog`): raise from default 30s to 180s — calls are `Promise.allSettled` in parallel, so the bump only changes the failure ceiling, not the happy-path latency; gives `tools.catalog` room for multi-agent responses.
  - `chat.history` (both loadMessages sessionId lookup and per-agent sessions batch): raise from default 30s to 60s for weak-network headroom.
  - `coclaw.topics.create` / `coclaw.topics.delete` / `coclaw.topics.update`: raise from default 30s to 60s — write operations benefit from extra margin to reduce client-timeout / server-committed state-drift windows.
  - `coclaw.files.mkdir` / `coclaw.files.create`: add explicit 60s to align with `coclaw.files.list` / `coclaw.files.delete` in the same file; prior omission meant the mkdir→create upload sequence had half the headroom of list/delete.

- 6d04df2: Three real bugs surfaced by an external review pass plus 6 test groups (17 new tests). Review covered 15 observations; after triage, 9 were adopted (3 code fixes + 5 test groups + 1 defensive contract lock); 5 were rejected, 1 was deferred to backlog.

  - **`addOrUpdateClaw` weak id validation lets ghost ids through** (`claws.store.js:addOrUpdateClaw`) — The truthy check `if (!claw?.id) return;` accepts `{id: {}}`, `{id: []}`, `{id: 'null'}`, `{id: '[object Object]'}`, etc. After `String(claw.id)` runs, those become ghost ids that get written into `byId` and trigger `manager.connect(id)`, burning ICE/TURN credits and polluting the dashboard. The sister entry `applySnapshot` already filters these via a stricter rule, so SSE incremental events (`claw.bound`, `claw.nameUpdated`) bypassed the snapshot's protection. Fix: extract `__validateClawId` (rejects nullish/empty/whitespace, non-string/number, non-finite numbers, and the ghost literals `'null'`/`'undefined'`/`'[object Object]'`) and route both entries through it. `removeClawById` and `updateClawOnline` are intentionally not gated — the former is a no-op for unknown ids and the latter requires `byId[id]` lookup, so neither can create ghosts.

  - **`__buildPeerConnection` has no abort guard across awaits** (`webrtc-connection.js:__buildPeerConnection`) — Three awaits (`ensureConnected`, `createOffer`, `setLocalDescription`) had no protection against an external `close()` arriving while pending. On late resolve the build continued: `setState('connecting')` revived state from `closed`, a fresh `PeerConnection` was created, and `rtc:offer` was sent on a logically-already-closed instance. On late reject (browser throwing `InvalidStateError` against a closed pc), the error propagated to `initRtc`'s `.then(rtc.connect).catch` and was misclassified as a real connection failure, triggering `clearRtc` and a redundant backoff. Fix: introduce `__closeEpoch` (incremented on every `close()`); `__buildPeerConnection` snapshots it before the first await and bails out after each await if the epoch changed or `__pc` was replaced. `createOffer` / `setLocalDescription` are wrapped in try/catch that swallows the error if the abort guard would fire (treats it as tail-of-old-build noise) but rethrows otherwise so genuine hardware/SDP failures still surface. The `__closeEpoch` and `__restartEpoch` are independent counters with non-overlapping use sites: the former only halts in-flight `connect()` builds, the latter only halts in-flight ICE restarts.

  - **`close()` ordering causes synchronous `dc.onclose` re-entry** (`webrtc-connection.js:close`) — In real browsers, `pc.close()` synchronously fires `dc.onclose`. The original sequence was `sendSignaling('rtc:closed') → pc.close() → __pc=null → __rpcChannel=null → setState`, which meant the synchronous `dc.onclose` saw `__rpcChannel === dc` and `state === 'connected'` still both true, hit the unexpected-close branch, and re-entered `close({asFailed: true})` — sending `rtc:closed` a second time and flipping state through `'failed'` before the outer call overwrote it back to `'closed'`. Symptoms: duplicate `rtc:closed` signal noise on every clean teardown, and a one-frame `'failed'` blip in any state subscriber. Fix: move `__rpcChannel = null` before `pc.close()`. The synchronous re-entry now sees `__rpcChannel !== dc` and short-circuits cleanly. Since the dc.onclose path was the only place calling `__rejectAllPending` for the close case, `close()` now invokes a thin tolerant helper `__rejectClawConnPending` at the top level so pending RPCs still reject promptly. The helper falls back gracefully when test mocks lack the method; production `ClawConnection` always implements it.

  Test changes (6 groups, 17 new tests; baseline 2947 → 2964 UI tests, all green):

  - **`P0-4: connect 跨 await close 防护`** (`webrtc-connection.test.js`) — Three tests covering each await abort path. (a) `ensureConnected` pending → close → late resolve: asserts no new `PeerConnection` is created, no `rtc:offer` is sent, state stays `closed`, `__pc === null`. (b) `createOffer` pending → close → late resolve: asserts `setLocalDescription` is not called, no `rtc:offer` is sent. (c) `createOffer` pending → close → late reject `InvalidStateError`: asserts the `connect()` promise does not reject, no side effects propagate (`__pc === null`, no `rtc:offer`).
  - **`P0-5: 主动 close 同步 dc.onclose 不重入`** (`webrtc-connection.test.js`) — Three tests using a mock `pc.close()` that synchronously fires `dc.onclose` to reproduce browser behavior. (a) `asFailed=false`: asserts `rtc:closed` is sent exactly once and final state is `'closed'` (not the transient `'failed'`). (b) `asFailed=true`: same assertions for the failure-tagged path. (c) Asserts `__rejectAllPending` is invoked exactly once from the top-level helper, proving the dc.onclose short-circuit doesn't drop pending RPC reject responsibility.
  - **`P1-3: sig offline 重复 updateClawOnline 防回归`** (`claws.store.test.js`) — Mirrors the snapshot-side `P1-2` for the SSE incremental path. With `_sigOffline=true` and an uninitialized claw, three consecutive `updateClawOnline(id, true)` calls fire only one `__fullInit` (subsequent calls short-circuit on `claw.initialized=true` set synchronously) and zero `initRtc` calls (sig gate inside `__ensureRtc` blocks). Locks the contract that SSE replay storms during sig flapping don't induce N concurrent fullInits.
  - **`network:online + typeChanged + _rtcInitInProgress` tail assertion** (`claws.store.test.js`) — Extended an existing test: after init resolves and `__ensureRtc`'s success path consumes the `_pendingTypeChangedRestartClaws` marker, a subsequent `sig disconnected → connected` cycle does _not_ upgrade `__resumeOnline` to `triggerRestart('online_resume')`. Locks the marker-lifecycle invariant against a stale-marker false-positive.
  - **`P2-3: applySnapshot dup-id online conflict`** (`claws.store.test.js`) — Snapshot containing `[{id:'d1', online:false}, {id:'d1', online:true}]` against an existing `online:true` claw: asserts last-wins semantics (`online === true`), `__handleClawGoOffline` is not called (final online is true), and `__resumeOnline` is called exactly once thanks to Phase 3's `Set` dedup. Side note: Phase 1's `prevOnlineMap.set` reading `existing.online` after the prior iteration's `Object.assign` causes the dup-id path to compute `prev` from a mid-state value rather than the true pre-snapshot state — see backlog entry below.
  - **`P2-3: malformed-only snapshot against non-empty byId`** (`claws.store.test.js`) — Defensive lock for the contract "all-malformed snapshot ≡ empty snapshot": with two existing claws, `applySnapshot([{id:null}, {id:'[object Object]'}])` clears `byId` to empty, calls `closeRtcForClaw` once per existing id, and invokes `manager.syncConnections([])` once. Test comment explicitly notes that flipping this to "preserve old state on all-malformed" requires an explicit product decision and a synchronized test update.
  - **`P2-4: malformed addOrUpdateClaw id 防御`** (`claws.store.test.js`) — One test exercising 12 malformed shapes (`{id: {}}`, `{id: []}`, `{id: ['x']}`, `{id: null}`, `{id: 'null'}`, `{id: 'undefined'}`, `{id: '[object Object]'}`, `{id: '   '}`, `{id: ''}`, `{id: NaN}`, `{id: true}`) — all dropped, `byId` stays empty, `manager.connect` not called. One sanity test confirming legal string and numeric ids still upsert correctly.
  - **File transfer mid-flight ICE restart** (`file-transfer.test.js`) — Three tests in `file-transfer – 跨 ICE restart 集成场景`: (a) download with DC already open and partial chunks received, restart succeeds (DC stays open) → transfer completes; (b) same setup but restart fails (DC closes) → reject `TRANSFER_INTERRUPTED`; (c) upload symmetric to (a).
  - **Upload/post abort during sendChunks backpressure** (`file-transfer.test.js`) — Two tests covering the previously-uncovered "DC open + chunks already sent + buffer full + external abort" path. Asserts `ERR_CANCELED` rejection, DC `close()` is called, listeners are removed.

  **Review disposition** (15 observations total):

  _Rejected (5):_

  - Old-generation signaling messages polluting new generation — already covered by `P0-3: stale rtc:answer/ice across rebuild` and the `rtc:restart-rejected` stale-state guard.
  - Repeated `app:foreground` events with stale `_backgroundAt` — by design (probe path is idempotent and cheap; "stale bgAt always triggers probe" is the intended safety net for cases where the OS suspended without firing a `bg` event).
  - Claw recovers online but signaling still offline — already covered by sig-gate tests; presence (`byId[id].online`) updates immediately while RTC recovery defers, and dashboard cache is replayed by `__resumeAllClawsForSigOnline` when sig returns.
  - `signaling-connection.disconnect()` during offline `ensureConnected` wait — already covered by `__waitForConnected`'s `__intentionalClose` branch (existing `等待期间 disconnect → 立即 reject` test).
  - Send/post operations gated by `claw.online` — by design (presence is decoupled from DC readiness; existing reverse assertions in `ChatPage.test.js` already lock this).

  _Backlog (1):_

  - `applySnapshot` Phase 1 `prevOnlineMap` reads `existing.online` _after_ the in-loop `Object.assign`, so dup-id snapshots compute `prev` from an intermediate value rather than the true pre-snapshot state. Side effect: `[mid online=false, final online=true]` dup-id path computes `prev=false→true` (one spurious `__resumeOnline`) instead of `prev=true→true` (no-op). Server contract does not produce dup-id snapshots, so production impact is zero, but the underlying logic is brittle. Deferred — fix should snapshot `prevOnlineMap` from the pre-Phase-1 byId state, paired with a test flip from "transition once" to "transition zero times". Locked by current test as a known quirk.

  _Adopted (9):_ 3 code fixes + 5 test groups + 1 defensive lock, as documented above.

- fa42501: Two RTC recovery fixes exposed by an external review pass over the previously-shipped `pauseRestart` double-gate (commit 68d9f99). The review surfaced 14 observations; after triage, 8 were adopted (2 real bugs + 6 test-only hardenings); 5 were rejected and 1 was deferred to the backlog.

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

  _Rejected (5):_

  - `addOrUpdateClaw` pre-`fetched` sig-gate interaction — both `__freezeAllClawsForSigOffline` and `__resumeAllClawsForSigOnline` early-return when `fetched=false`, so there is no code path that can touch a just-added claw during the pre-snapshot window.
  - `network:online(typeChanged=true)` mid-`__ensureRtc` init — the `_pendingTypeChangedRestartClaws` accounting + `__resumeOnline` consumption is already covered by the existing `typeChanged cross-gate integration` describe block (per-claw isolation, paused consumption, post-await ordering).
  - Symmetry between `__resumeOnline` rebuild and `__handleNetworkOnline` rebuild w.r.t. `_pendingForceRefreshOnRebuild` — deliberate design: `__handleNetworkOnline`'s failed/closed branch is guaranteed to have a stamped `disconnectedAt` (from `onRtcStateChange('failed')`) so gap-aware `__refreshIfStale` handles it, while `__resumeOnline`'s DC-continuous branch has no such stamp and needs the explicit force marker.
  - Extra malformed-id types for snapshot filtering (boolean/Symbol/array/numeric 0) — already blocked by the single `typeof !== 'string' && typeof !== 'number'` line that is exhaustively exercised by existing `{}` / `null` / `undefined` test cases.
  - `manualRetryUnreachable` not checking `_sigOffline` directly — already logged as a UX backlog item in the previous round (`ui-rtc-paused-gate-stale-signaling` changeset); the behavior is benign (backoff clears + remoteLog fires but `__ensureRtc` no-ops under the sig gate), the wart is visual-feedback only.

  _Backlog (1):_

  - `rtc:restart-rejected` protocol lacks a generation id, so a stale reject arriving while the new restart is still in the `restarting` state cannot be distinguished from a current-generation reject. This is a protocol-design question (UI connId + `__restartEpoch` routing vs. a dedicated attempt id) rather than a test-coverage gap; testing around the current ambiguity would just get invalidated by whichever design direction is chosen. Deferred pending that decision.

  _Adopted (8):_ 2 code fixes + 6 test groups, as documented above.

- 68d9f99: Harden the `pauseRestart` gate so it cannot be bypassed by stale ICE restart signaling (`rtc:answer` / `rtc:ice` / `rtc:restart-rejected`). The earlier implementation only gated _outgoing_ restart attempts (`__attemptRestart` entry), leaving the _incoming_ signaling path unguarded: once `pauseRestart()` had been called (by `__handleClawGoOffline` or `__freezeAllClawsForSigOffline`), three leak paths could still defeat the freeze:

  1. **Late `rtc:answer`** — `__onSignaling` called `pcAtAnswer?.setRemoteDescription(...)` unconditionally. With a fresh remote SDP applied, ICE could complete naturally, `onconnectionstatechange('connected')` would then fire → `__clearRestartState()` → `__restartPaused` cleared + `__setState('connected')` + `__startKeepalive()`. The freeze was silently undone by the peer's callback.
  2. **Late `rtc:ice`** — `__onSignaling` called `__pc?.addIceCandidate(...)` unconditionally. Same end result as (1): helps ICE complete and reach connected.
  3. **Late `rtc:restart-rejected`** — the existing `if (this.__state !== 'restarting')` guard was insufficient because `pauseRestart()` deliberately leaves `__state === 'restarting'` (it only flips `__restartPaused=true` and bumps `__restartEpoch`). A stale reject from an older restart round would pass the guard and call `this.close({ asFailed: true })`, killing the PC, emitting `rtc:closed` to the plugin, and clearing `__restartPaused` via `__clearRestartState`.

  Fix is a single guard at the top of `__onSignaling(msg)` — when `__restartPaused` is true, drop the message at debug level and return. All three branches (`rtc:answer` / `rtc:ice` / `rtc:restart-rejected`) are covered uniformly. Resume paths (`resumeRecovery` / `triggerRestart('online_resume')`) both clear `__restartPaused` before they issue new signaling, so new-generation messages are not affected. The existing stale-state guard inside `rtc:restart-rejected` is preserved (two independent staleness criteria: `state !== 'restarting'` vs `__restartPaused`). The `__restartEpoch` / `__clearRestartState` mechanism stays — it guards _in-flight awaits_ inside `__attemptRestart`, which is a different concern from entry-level signaling drops.

  Updated `pauseRestart` JSDoc to document the two-sided gate (outgoing `__attemptRestart` entry + incoming `__onSignaling` entry).

  Tests: added `describe('paused gate 抗迟到 signaling')` with 5 tests — three for `restarting + paused` (covering all three message types) and two for `connected + paused` (covering `answer` / `ice`; `restart-rejected` is already dropped by the independent stale-state guard in the connected case). Each test uses precise `toHaveBeenCalledTimes(0)` / state assertions (not just `.not.toHaveBeenCalled()`). All 245 tests in `webrtc-connection.test.js` pass; full `pnpm test`: 2931 → 2936 UI passing, 152 electron unchanged, 0 skipped.

  Evaluated 15 test-gap suggestions from an external review in the process; this commit acts on the 2 that exposed real bugs (the stale signaling leaks above). The remaining 13 suggestions were verified as already covered, orthogonal design intent, or server-contract guarantees that don't warrant defensive tests — detailed rationale in the commit that introduced this changeset.

  Out of scope (backlog): `manualRetryUnreachable()` does not check `_sigOffline` directly, which is a UX wart rather than a correctness bug — clicking "retry" while signaling is down produces a `claw.manualRetry` remote log and clears the backoff counter but does not initiate a rebuild (blocked by `__ensureRtc`'s sig gate). Deferred for a separate UX pass.

- fd5aca4: One real recovery bug surfaced by an external review pass and 4 test groups (5 new tests, 2 reverse-assertion strengthenings). Review covered 12 observations; after triage, 6 were adopted (1 code fix + 5 test/doc improvements); 4 were rejected, 2 were deferred to backlog.

  - **`__checkAndRecover` post-probe `failed`/`closed` path is silently dropped** (`claws.store.js:__checkAndRecover`) — When `probe()` rejects/times out and the PC has dropped to `failed`/`closed` _during_ the probe wait, the original code called `rtcAfter.triggerRestart('probe_failed')`. But `WebRtcConnection.triggerRestart` only enters `__attemptRestart` when `state === 'restarting' || 'connected'` and silently no-ops on `failed`/`closed` — recovery is dropped on the floor. The pre-probe path of the same function correctly routes `failed`/`closed` to a full `__ensureRtc` rebuild; the post-probe path was asymmetric. Symptom in production: a claw whose PC died during the brief probe window stays unreachable until the next `__checkAndRecover` tick (typically the next `app:foreground` event), incurring a multi-second user-visible gap on top of the probe timeout. Fix: mirror the pre-probe path — when `rtcAfter.state === 'failed' || 'closed'`, mark `rtcPhase = 'recovering'`, `__clearRetry`, and fire `__ensureRtc` rebuild. Other `rtcAfter` states (`restarting` / `idle` / `connecting`) keep the existing `triggerRestart('probe_failed')` path. The remoteLog now also carries `source=` for diagnostic continuity with the pre-probe log.

  Test changes (4 groups, 5 new tests + 2 reverse-assertion strengthenings; baseline 2943 → 2947 UI tests, all green):

  - **`__checkAndRecover` post-probe path symmetry** (`claws.store.test.js`) — Three previously-existing tests that locked the buggy `triggerRestart` behavior were rewritten to assert the correct rebuild behavior (`closeRtcForBot` + `initRtc` called, `triggerRestart` not called). One new test added (`probe 失败 + PC 变 restarting → triggerRestart('probe_failed')`) to keep the transient-state path covered against future regressions.
  - **`addOrUpdateClaw` + `fetched=false` + sig disconnect** (`claws.store.test.js`) — Locks the design intent of `__freezeAllClawsForSigOffline`'s `!fetched` early-return: a claw added via `addOrUpdateClaw` before snapshot completes (so `fetched` is still false) is intentionally not paused on sig disconnect. Anchor for "filter logout / pre-snapshot sig noise events" semantics; if someone removes the gate, this test catches it.
  - **SSE error / heartbeat timeout reverse assertions** (`use-claw-status-sse.test.js`) — Added 4 reverse assertions (`applySnapshot` / `updateClawOnline` / `addOrUpdateClaw` / `removeClawById` not called) to both the existing `should set connected=false on error` and `heartbeat timeout should restart SSE` tests. Locks the contract that SSE channel faults are a transport-level concern only; they must never be conflated with claw presence mutations.
  - **ChatPage topic mode DC rebuild smoke** (`ChatPage.test.js`) — Topic-route mount with `topic:sess-1` chatStore (`topicMode === true`): on DC rebuild (dcReady false→true), exactly one silent `loadMessages({ silent: true })` fires and `__loadChatHistory` is not called. Mirrors the existing session-mode coverage and locks the topic branch of `__onConnReady`'s deduplication.
  - **`applySnapshot` duplicate id last-wins** (`claws.store.test.js`) — Locks the contract that `applySnapshot([{id:'d1', ...}, {id:'d1', ...}])` produces a single `byId['d1']` entry with the second item's data, and that `manager.syncConnections` is called exactly once (not N times for N duplicates). Manager-level dedup is its own responsibility, asserted by its own tests.
  - **`setClaws` JSDoc as test-only** (`claws.store.js`) — Added an `@internal Test-only.` JSDoc block above the `setClaws` action with a one-line warning: it bypasses the `fetched` gate and lifecycle side-effects, must not be used in production code paths. Documents an existing convention (the action has no production callers) without renaming.

  **Review disposition** (12 observations total):

  _Rejected (4):_

  - `__resumeOnline` returns early when `_sigOffline` and skips dashboard sync — by design (presence and dashboard decouple under environmental fault; sig-resume path runs `__resumeAllClawsForSigOnline → __resumeOnline` to backfill). Already covered by existing test `__resumeOnline _sigOffline=true 入口早退`.
  - Repeated `updateClawOnline(false)` idempotence — already covered by round 15 (commit `fa42501`).
  - `__resumeOnline` when `initialized=true` but `getConn()` returns null — already covered by existing `conn 不存在 → 安全返回` test; the no-rebuild + no-force-refresh branch is by design (the conn-missing window is a teardown race; rebuild is left to the next resume tick rather than queueing a stale `_pendingForceRefreshOnRebuild` entry).
  - Multi-claw freeze/resume isolation against per-claw exceptions — `pauseRestart` is pure assignment + timer-stop on stable RTC objects, cannot throw under any production-reachable state; robustness coverage value too low to justify the test mass.

  _Backlog (2):_

  - Files store cache (`useFilesStore.dirCache`) is not invalidated on rebuild via `refreshClawResources` — by design (lazy invalidation: `FileManagerPage` always force-refreshes `loadDir` on `connReady`, the cache is just a cross-page transition fallback). Worth noting in the lifecycle doc next time we touch it; not a test gap.
  - `manualRetryUnreachable` under sig offline silently no-ops via downstream `__ensureRtc` gate — same UX wart already noted in round 15's backlog (`ui-rtc-paused-gate-stale-signaling` changeset). Deferred pending a UX redesign (button disabled state or toast); behavior is benign.

  _Adopted (6):_ 1 code fix + 4 test groups + 1 doc, as documented above.

- 4ae005e: Four real bugs surfaced by an external review pass plus 12 test groups (17 new tests). Review covered 22 observations; after triage, 12 were adopted (4 code fixes — each paired with a regression test group — and 8 test-only adoptions), 9 were rejected, 1 was deferred to backlog.

  - **`removeClawById` leaks `_probeInProgress` guard across remove→re-add of the same id** (`claws.store.js:removeClawById`) — When `__checkAndRecover` had set `_probeInProgress.set(id, true)` and was awaiting `rtc.probe()`, a remove (manual delete or SSE-driven) followed by an immediate re-add of the same id (e.g. user re-binds a claw, or a snapshot reshuffles) would land the new claw object under the same id while the old probe was still pending. The next `__checkAndRecover` for the new claw bailed at the `_probeInProgress.get(id) → return` gate; even worse, the old probe could late-resolve and write success/failure decisions against a stale claw object. Fix: `removeClawById` now also calls `_probeInProgress.delete(id)`. The symmetric branch inside `applySnapshot` (where a snapshot drops a claw not in the new list) gets the same delete to keep both deletion entry points aligned.

  - **`rtc:answer` setRemoteDescription `.then` lacks paused/pc-replace guard** (`webrtc-connection.js:__onSignaling`) — The `.then` chain after `pc.setRemoteDescription(...)` had no abort guard against `pauseRestart()` arriving (or PC being replaced) while the SDP set was in-flight. If pause happened mid-await, the resolve still fired `__remoteDescSet = true` and drained `__pendingCandidates` into `pc.addIceCandidate(...)`, advancing ICE on a logically-frozen connection. The synchronous `__onSignaling` paused-gate at the entry only catches signals that arrive _after_ `pauseRestart()` — it doesn't help signals already past the entry check. Fix: snapshot `pcAtAnswer` and check `this.__pc !== pcAtAnswer || this.__restartPaused` inside the `.then` body before the success branch runs. Late resolves are logged (`debug`, matching the entry-level paused gate) and dropped.

  - **`updateClawOnline` same-value online + `rtcPhase=failed` had no rescue path** (`claws.store.js:updateClawOnline`) — `applySnapshot` Phase 3 already had a rescue rule (`claw.online && rtcPhase === 'failed' → toResume.add`) for the case where server-side restart killed local RTC but presence stayed `online=true`. The SSE incremental path (`updateClawOnline`) only fired `__resumeOnline` on `prev === false` transitions, so a server-emitted same-value `claw.status` update could leave a dead RTC unrecovered until either the next snapshot landed or app:foreground/network:online tickled `__checkAndRecover`. Fix: add the `else if (claw.rtcPhase === 'failed')` branch after the `prev === false` branch. The `__resumeOnline` entry guard (`_sigOffline` early-return) keeps the rescue safe under sig flap; idempotent re-entry is harmless.

  - **`ChatPage.__onConnReady` doesn't roll back `__connReadyStore` guard on reject/mid-switch** (`ChatPage.vue:__onConnReady`) — The dedup guard (`if (this.__connReadyStore === this.chatStore) return`) was set _before_ the `await loadMessages()`. If `loadMessages` rejected (RPC error / timeout), the guard stayed pointed at the failed store. The narrow but real corner case: user navigates away to another chat then comes back to the same `chatStore` — guard still matched, dedup blocked the re-entry, and the chat never ran first-load again. Fix: wrap the reconcile + await + `$nextTick` block in `try/finally`. A `succeeded` boolean is set at the end of the try; the finally rolls back `__connReadyStore` to `null` if it didn't reach the success marker (covers reject _and_ mid-switch where `this.chatStore !== targetStore`). Refactor uses a local `targetStore` to avoid `this.chatStore` flipping mid-await. Existing semantics preserved: first-load awaits, subsequent loads stay fire-and-forget silent.

  Test changes (12 groups, 17 new tests; baseline 2964 → 2983 UI tests, all green):

  - **`removeClawById` \_probeInProgress cleanup** (`claws.store.test.js`) — Two tests. (a) White-box: probe pending → `_probeInProgress.has(id)` is `true` → `removeClawById(id)` → guard map is empty. Uses `__test__._probeInProgress` accessor. (b) End-to-end: probe pending → `removeClawById` → re-add same id with a fresh `conn` → second `__checkAndRecover` fires `probe` exactly once on the new rtc (would have been blocked by the stale guard before the fix). Asserts `closeRtcForBot` not invoked, proving the late-resolved old probe didn't trigger rebuild on the new claw.
  - **P0-5 `rtc:answer` setRemoteDescription pause guard** (`webrtc-connection.test.js`, `paused gate 抗迟到 signaling` describe) — Two tests. (a) Manually controllable `setRemoteDescription` promise: drive into `restarting`, fire `rtc:answer`, `pauseRestart()`, then resolve the SDP — asserts `__remoteDescSet` stays `false`, `__pendingCandidates` is not drained, `addIceCandidate` is never called. (b) Sanity check: same setup minus the pause — assertions flip (drain happens, `__remoteDescSet=true`, `addIceCandidate` called once), proving the guard doesn't false-positive on the normal path.
  - **P0-6 `online_resume` + `ensureConnected` rejection → revert to paused** (`webrtc-connection.test.js`, new `P0-6` describe) — Two tests covering the round-15 fix `fa42501`. (a) Drive to `restarting + paused`, `mockEnsureConnected.mockRejectedValueOnce`, `triggerRestart('online_resume')` → asserts `__restartPaused === true`, `__restartTimer === null`, `__restartPollTimer === null`, `__restartStartTime === 0`, no `rtc:offer` sent. (b) Sequential second call with `mockEnsureConnected.mockResolvedValueOnce` after the revert → `rtc:offer` with `iceRestart: true` is sent exactly once. Proves the from-paused restart path remains live.
  - **P1-3 same-value online + rtcPhase=failed rescue** (`claws.store.test.js`, `updateClawOnline` describe) — Two tests. (a) `claw.online=true` + `rtcPhase='failed'` → `updateClawOnline(id, true)` → `__resumeOnline` invoked exactly once. (b) Control: same setup with `rtcPhase='ready'` → `__resumeOnline` not invoked (same-value healthy still idempotent).
  - **P1-1 `__resumeOnline` idle / connecting branches** (`claws.store.test.js`, `__resumeOnline helper` describe) — Two tests mirroring the existing null/closed/failed cases: `rtc.state='idle'` and `rtc.state='connecting'` both route to the rebuild branch via `__ensureRtc` (`mockInitRtc` invoked). `triggerRestart` not called (proves both are not in the restart-paused branch).
  - **P1-2 dashboard double-lock under sig offline** (`claws.store.test.js`, `sig gate (signaling WS 冻结闸)` describe) — One test exercising the full dashboard-online sync state machine across the two locks: claw offline (`syncDashboardOffline` writes `instance.online=false`) → sig offline (no dashboard side-effect) → same claw flipped `online=true` while sig still offline (`__resumeOnline` entry sig-gate early-returns; dashboard stays `false`) → sig recovers (`__resumeAllClawsForSigOnline` calls `__resumeOnline` for online claws → `syncDashboardOnline` writes `instance.online=true`). Catches any regression where one of the two gates becomes asymmetric.
  - **P1-8 `__onConnReady` reject rollback + resolve no-rollback** (`ChatPage.test.js`, `recovery watchers` describe) — Two tests. (a) `mockRejectedValueOnce` + first-load (`__messagesLoaded=false`) → after reject, `__connReadyStore` is `null`; subsequent `__onConnReady()` invocation with `mockResolvedValueOnce` re-fires `loadMessages` (would have been deduped without the rollback). After success the guard re-points at the chatStore. (b) `mockResolvedValue` normal path → `__connReadyStore` ends pointed at the chatStore, second call deduped (`loadMessages` total stays at 1).
  - **P1-6 `connReady` driven by agents fetched flip** (`ChatPage.test.js`, `recovery watchers` describe) — One test. Mounts with `dcReady=true` but `agents.byClaw['bot-1'].fetched=false` (empty list) → `connReady=false`, `loadMessages` not invoked. Then writes `agents.byClaw['bot-1'] = { agents: [...], fetched: true, ... }` → `agentVerified` flips → `connReady` flips false→true → `__onConnReady` fires `loadMessages` exactly once. Locks the contract that agent verification gates first-load just like dcReady does.
  - **P1-9 `ensureConnected` resolve before timeout via online + network:online** (`signaling-connection.test.js`, `offline 闸` describe) — One test. `setOnLine(false)` + `ensureConnected({ timeoutMs: 10_000 })` (promise pending). Switch `setOnLine(true)` + dispatch `network:online` → new WS instance is created, `simulateOpen()` → promise resolves within 1s (well below 10s timeoutMs). Locks the offline-→-online fast path: ensureConnected pending callers are unblocked by the network:online handler's immediate-reconnect branch.
  - **P1-10 probe in-flight + `network:online` typeChanged=true → `forceReconnect` once, no double-fire** (`signaling-connection.test.js`, new `probe + network:online 互动` describe) — One test. `makeConnected()` + `probe()` (probeTimer set) + `__handleForegroundResume('network:online', { typeChanged: true })` → `forceReconnect` spy called once, MockWebSocket count +1, `__probeTimer` cleared. Fast-forward 5s (well past the 2.5s probe timeout) → `forceReconnect` still called only once. Locks the contract that `forceReconnect` clears the stale probe timer so a separate probe-timeout-fire doesn't double-trigger reconnect.
  - **P2-2 dashboard reload reject field semantics** (`dashboard.store.test.js`) — One test that locks the _current_ implementation behavior: `entry.instance` is unconditionally rebuilt as a fresh object on every `loadDashboard` call; reject fields get written as `null` (not preserved from the previous successful load). Test comment explicitly notes this is a behavior lock — if the product wants "preserve last-good value on transient RPC failure", both `dashboard.store.js` and this test must change together.
  - **P2-3 `checkPluginVersion` default 30s timeout contract** (`plugin-version.test.js`) — Two tests. (a) Weak-network simulated by `mockConnError(new Error('RPC_TIMEOUT'))` → `checkPluginVersion` returns `{ ok: false, version: null, ... }` via the catch branch. (b) Static contract: `conn.request` is invoked with method `'coclaw.info'`, params `{}`, and **no third options arg** (i.e. `callArgs[2] === undefined`) — locking round-15's removal of the explicit 10s timeout in favor of conn.request's default.

  **Review disposition** (22 observations total):

  _Rejected (9):_

  - P0-1 `typeChanged` + `_rtcInitInProgress` race — already covered by an existing test (`network:online + typeChanged + _rtcInitInProgress` integration in `claws.store.test.js`).
  - P0-2 `connected` but DC not ready early-return — by design: `state=connected + isReady=false` is a transient gap covered by `dc.onopen` / `dc.onclose` event handlers; long DC inactivity triggers keepalive-driven restart.
  - P0-4 old-`ClawConnection` event pollution in new claw — already covered by `G-03: _bridgedConns remove→re-add conn identity switch`.
  - P0-7 `onRtcStateChange` + `claw.online=false` — by design: store writes truth so a subsequent `online=true` flip routes through the rebuild branch; retry layer already has its own offline gate.
  - P1-4 `_pendingTypeChangedRestartClaws` cleared by `__ensureRtc` success path — already covered by the `network:online + typeChanged + _rtcInitInProgress completion` integration test.
  - P1-5 `request` / `waitReady` budget burn under claw/sig offline — by design: ClawConnection layer doesn't observe sig state; gating is centralized at the store layer.
  - P1-7 `connReady=false` chatStore switch — already covered: the `connReady` watcher's `!ready` branch explicitly resets `__connReadyStore=null`.
  - P2-1 `postFile` across ICE restart — by design: `postFile` is a thin wrapper over `uploadFile` differing only in HTTP method, so no new test coverage adds value beyond the existing `uploadFile` mid-flight ICE restart suite.
  - P2-4 SSE `app:foreground` + `network:online` throttle — already covered by `use-claw-status-sse.test.js`'s `restart 节流` describe.

  _Backlog (1):_

  - P2-5 `isConnectingRtc` / `unreachableClaws` getter semantics during `sig offline + rtcPhase=building/recovering` — UX-layer enhancement deferred until the global `SignalingBanner`-style indicator unifies sig-flap presentation. Same root cause as round-15's `manualRetryUnreachable` backlog entry. Locked by current behavior; no production impact (presence + dcReady remain authoritative for send-button enable/disable).

  _Adopted (12):_ 4 code fixes (each paired with a regression test group) + 8 test-only adoptions, as documented above.

- 23908c8: Test-only patch covering coverage gaps surfaced by an external review pass plus one documentation drift fix. Review covered 10 observations; after triage, 5 were adopted (4 test groups + 1 doc fix); 4 were rejected as already covered by existing test families; 1 was deferred (already-known UX backlog).

  No code behavior changes; this round adds regression locks for branches that recent rounds left implicit.

  Test changes (4 groups, 6 new tests; baseline 2983 → 2989 UI tests, all green; electron 152 unchanged):

  - **`P0-4: setLocalDescription 跨 await close`** (`webrtc-connection.test.js`) — Two tests extending the round 17 P0-4 family to cover `__buildPeerConnection`'s third await. (a) `setLocalDescription` pending → `close()` → late resolve: asserts `pcInstances.length` unchanged, no `rtc:offer` sent, state stays `closed`, `__pc === null`. (b) `setLocalDescription` pending → `close()` → late reject `InvalidStateError`: asserts `connect()` promise does not reject (the SLD try/catch + epoch guard swallows the abort-tail noise) and no side effects propagate. With this round `__buildPeerConnection`'s three awaits (`ensureConnected`, `createOffer`, `setLocalDescription`) are all covered for both late-resolve and late-reject under close.

  - **`typeChanged cross-gate: !initialized claw + Set 自动消费`** (`claws.store.test.js`) — One test in the existing `typeChanged cross-gate integration` describe. Locks the contract that `__resumeAllClawsForSigOnline`'s `!initialized` branch actively `_pendingTypeChangedRestartClaws.delete(id)` when running `__fullInit`. Three-stage construction: (1) sig down + `network:online typeChanged=true` records the !initialized claw into the Set; (2) sig up routes the claw through `__fullInit` (not `__resumeOnline`); (3) reverse-fact: a second sig cycle with no `network:online` and the claw now `connected+paused` runs `resumeRecovery` (would upgrade to `triggerRestart('online_resume')` if Set residue from stage 1 leaked through). If the explicit `_pendingTypeChangedRestartClaws.delete(id)` in the !initialized branch is removed, stage 3's reverse-fact assertion fires.

  - **`G-01b: offline bail 残留清理`** (`claws.store.test.js`, in `_pendingForceRefreshOnRebuild bail 残留清理` describe — renamed from the previous `sig_offline bail` since it now covers both bail reasons) — One test mirroring the existing `sig_offline bail` test for the `offline` bail path. Covers: (a) rebuild starts → `_pendingForceRefreshOnRebuild.add('1')`; (b) `__ensureRtc` post-await sees `claw.online=false`, bails with `reason=offline`, sets `rtcPhase='failed'` and clears the Set; (c) a subsequent independent `__ensureRtc` rebuild sees the Set empty, runs with `force=false`, and `__refreshIfStale` short-circuits on the `gap<BRIEF_DISCONNECT_MS` gate (loaders not called, no `force_refresh=1` log line). Test comment explicitly notes the offline bail path does **not** restore the previous `disconnectedAt` (unlike `sig_offline`), so the gap-gate is what protects against spurious force-refresh — verified by an explicit `disconnectedAt > 0` assertion at stage 2.

  - **`__onConnReady await 后 unmount/store 切走 guard`** (`ChatPage.test.js`) — Two tests locking the round 18 `try/finally + succeeded flag` rollback contract. (a) Component unmounts during `await loadMessages()`: late resolve hits the `__unmounted` guard, skips `__loadChatHistory`, finally rolls back `__connReadyStore = null`. (b) `chatStore` switches during `await loadMessages()`: late resolve hits the `this.chatStore !== targetStore` guard, skips `__loadChatHistory` on the old store, rolls back guard, and a subsequent re-entry on the original store proceeds normally (verifying the dedup guard does not lock out future entries on rollback).

  Documentation:

  - **`docs/designs/ice-restart-recovery.md`** — Updated §4.1 (`createDataChannel` row in "其他联动修改") and §6.7 (large-file upload during network switch) to reflect the current implementation: `createDataChannel()` is permitted during `restarting`, the new DC parks in `connecting` and opens itself once ICE is rebuilt; rejection only when `!__pc || state in {'closed','failed'}`. The previous "restarting 时返回 null" wording dated to before commit `9e24cbe fix(ui): allow file DC creation during ICE restart` and would have misled future review of the file-transfer recovery model.

  **Review disposition** (10 observations):

  _Adopted (5):_ 4 test groups + 1 doc fix, as documented above.

  _Rejected (4):_

  - `sig offline + 异步重复 updateClawOnline(id, true)` — already covered by `P1-3: sig offline 重复 updateClawOnline 防回归` (synchronous burst form); the proposed async-repeat path's only side effect is one fullInit log + one try/catch warn, with `__ensureRtc` sig gate blocking ICE/TURN. Not a coverage gap.
  - `applySnapshot 在 _sigOffline=true 下的 online transition` — `true→false` is presence-only via `__handleClawGoOffline` (already covered by `online true→false + initialized → __handleClawGoOffline`); `false→true` is gated by `__resumeOnline` entry sig-gate (already covered by `SSE ordering: rtcPhase=failed no-op snapshot during sig offline → resume 被 sig gate 拦截`).
  - `getReadyConn online/dcReady 解耦直接测试` — the helper's body reads only `byId[id]?.dcReady` and the connection table; existing `get-ready-conn.test.js` 5 cases never reference `online` (implicit independence assertion); a redundant explicit case adds no signal.
  - `applySnapshot duplicate existing id + online 冲突` — already covered by `P2-3: applySnapshot dup-id online conflict` which locks last-write-wins online, single `__resumeOnline` call (Phase 3 Set dedup), and `__handleClawGoOffline` not called.

  _Backlog (1):_

  - `manualRetryUnreachable() 在 _sigOffline=true 时点击是 UX 假反馈` — already on the backlog from rounds 15-16 (button visible but `__ensureRtc` sig gate silently no-ops). Behavior is benign; will be addressed alongside the planned global SignalingBanner UX work, not as a standalone test addition.

- 9f22e3b: Two round-6 external review fixes to the RTC recovery gate:

  - `__resumeOnline` forceRestart skip condition was too broad. Round 5 skipped `__refreshIfStale` for **any** forceRestartOnConnected=true case, but that collapsed two scenarios that need different treatment: the "PC is connected/restarting → ICE restart keeps SCTP continuous → no refresh needed" case (correct to skip), and the "PC is failed/closed/null/idle/connecting → rebuild path → brand-new PC + brand-new SCTP" case (must refresh because the plugin may have replaced its process). The skip condition is now tightened to `canRefreshNow && forceRestartOnConnected`; the rebuild sub-case now correctly adds to `_pendingForceRefreshOnRebuild` and gets a force refresh when `__ensureRtc` succeeds. Without this, a claw that went offline then came back online on a replaced plugin process could leave UI data stale indefinitely.

  - `__ensureRtc` gained a post-await gate recheck. The loop-head `online` and `_sigOffline` checks only cover "before `await initRtc`", but `initRtc` can take seconds (ICE gathering, DTLS handshake). If offline/sig_offline fires during that window, `__handleClawGoOffline` can only call `conn.rtc?.pauseRestart()` — and since `conn.rtc` is still `null` until `initRtc` resolves, the pause becomes a no-op. Without the recheck, the successful RTC then sails past the closed gate, sets `dcReady=true`, clears retry, and triggers refresh — violating the "budgets frozen while gate closed" invariant. The fix reuses the existing `bailedOut`/`bailReason` machinery so `closeRtcForClaw` + `conn.clearRtc` happen uniformly with the loop-internal bails. For `sig_offline` bail specifically, we snapshot `rtcPhase` before `closeRtcForClaw` and restore it after, because `closeRtcForClaw` → `rtc.close()` → `onStateChange('closed')` synchronously fires the store callback which would otherwise write `rtcPhase='failed'` — violating the "sig is an environmental fault, not a claw unreachable" intent and spuriously triggering the UI warn banner.

  - Updated `communication-model.md` §5.5, `ice-restart-recovery.md` §6.5, and `state-recovery.md` to reflect the tightened skip condition and the new post-await recheck bullet. Added three unit tests: forceRestart + rebuild path goes through pending refresh; `__ensureRtc` post-await offline bails with rtcPhase=failed; post-await sig_offline bails without changing rtcPhase.

- bfc9be9: Skip immediate refresh in `__resumeOnline` forceRestart branch to avoid wasting RPC on a failing ICE path, and tighten `addOrUpdateClaw` to refuse `online` overrides.

  Two hardening fixes from external review round 5:

  - `__resumeOnline` refresh dispatch refactored to three branches. When `forceRestartOnConnected` is true (typeChanged per-claw Set consumed or explicit opts), skip the immediate `__refreshIfStale({force:true})` entirely — the old ICE path is known to be failing (WiFi↔cellular IP change), so the RPC would only burn 30s of application-layer timeout on a dead SCTP path. ICE restart itself keeps SCTP continuous, and `onRtcStateChange('connected')`'s `wasDisconnected=false` branch already skips refresh by design, so there is nothing to recover after restart — by design, not a bug. Non-forceRestart `connected`/`restarting` still refresh immediately; rebuild paths still defer via `_pendingForceRefreshOnRebuild`.
  - Introduce `GATED_FIELDS = new Set(['online'])` to explicitly reject `online` overrides from `addOrUpdateClaw`. Currently server `claw.bound` / `claw.nameUpdated` payloads do not carry `online`, but that is an implicit contract — UI-side `online` transitions must go through `updateClawOnline` / `applySnapshot`'s diff to trigger pause/resume/retry gate side-effects. `online` is deliberately **not** added to `RUNTIME_FIELDS`, because `applySnapshot` Phase 2 must let snapshot's authoritative `online` override `existing.online` for Phase 3's true↔false diff to work.
  - Updated `docs/architecture/communication-model.md` §5.5, `docs/designs/ice-restart-recovery.md` §6.5, and `ui/docs/state-recovery.md` RTC 前台恢复策略 to reflect the three-branch refresh dispatch.
  - Added two unit tests covering the new forceRestart skip path (immediate refresh bypassed, pending rebuild Set not polluted) and the `addOrUpdateClaw` online rejection.

- 2989ed5: Fix signal loss in `connected + restartPaused + typeChanged` path introduced by the per-claw Set refactor.

  `WebRtcConnection.__attemptRestart`'s paused gate only accepts `reason === 'online_resume'`; all other reasons (including `'network_type_changed'`) are dropped. The previous per-claw Set implementation unconditionally `delete`d the Set entry and called `triggerRestart('network_type_changed')` in `__handleNetworkOnline`'s main loop for any `connected + typeChanged` claw. When the claw was also paused, this combination produced a silent signal loss: the restart was dropped and the record keeping was cleared, so the subsequent `__resumeOnline` had no way to know it should force a restart.

  - `__handleNetworkOnline` main loop's `connected + typeChanged` branch now splits on `rtc.restartPaused`: paused claws skip the `triggerRestart` call and preserve the Set entry, so the eventual `__resumeOnline` consumer upgrades the recovery to `triggerRestart('online_resume')` (the only reason that bypasses the paused gate). Non-paused claws behave as before (`delete` + `triggerRestart('network_type_changed')`).
  - `__ensureRtc` success path now calls `_pendingTypeChangedRestartClaws.delete(id)` — rebuild produces a fresh ICE path, so any pending typeChanged bookkeeping on that claw is stale and should not cause a spurious `triggerRestart('online_resume')` on the next resume event. Symmetric with the existing cleanup in the `!initialized` branches and `applySnapshot` / `removeClawById`.
  - Rewrite the round-2 self-review test that asserted the buggy `triggerRestart('network_type_changed')` behavior, and add a control-group test for the non-paused path.
  - `docs/architecture/communication-model.md` §5.5.1: document the paused-branch defer rule and enumerate all Set cleanup sites for future reviewers.

- 72eef19: RTC recovery path gating — post-review fixes:

  - **Boot-race recovery**: when SSE snapshot arrives before the signaling WS handshake completes, `__fullInit` is blocked by the sig gate and `initialized` rolls back to `false`. On sig reconnect, `__resumeAllClawsForSigOnline` now re-runs `__fullInit` for online-but-uninitialized claws, replicating the `updateClawOnline` `!initialized` branch (previously the flow left the claw half-initialized).
  - **typeChanged cross-gate bookkeeping**: `network:online(typeChanged=true)` no longer lost when sig is offline. A module-level `_pendingTypeChangedRestart` flag is set at `__handleNetworkOnline` entry and consumed by `__resumeAllClawsForSigOnline`, which escalates `connected+paused` claws to `triggerRestart('online_resume')` (previous behavior `resumeRecovery()` left stale ICE path after WiFi↔cellular switch → ~30s consent timeout before passive restart).
  - `pauseRestart()` log text: drop `(claw offline)` qualifier — the function is now shared by both claw-offline and sig-offline freeze paths, and callers already log the reason.
  - `ui/docs/state-recovery.md`: sync to current `__handleClawGoOffline` behavior (removes stale mention of clearing `dcReady` / stamping `disconnectedAt` — the `4a05074` principle is that presence does not pollute DC lifecycle).
  - `docs/architecture/communication-model.md` §5.5.1: append mental-model paragraph reframing the signaling WS as an end-to-end reachability probe rather than a business dependency, plus a description of the `_pendingTypeChangedRestart` bookkeeping.

- 45ee089: Three fixes from the 11th-round external review:

  - **`resumeRecovery` immediate probe (P2 → latency win)** — `webrtc-connection.js` `resumeRecovery()` on the `connected + PC healthy` path previously called `__startKeepalive()`, which only schedules the next `__doKeepalive` after the full `DC_KEEPALIVE_INTERVAL_MS` (30s). If the underlying SCTP was already dead at resume time but `pc.connectionState` had not yet flipped to `failed`/`disconnected` (common during WiFi↔cellular switching or long background-suspension where ICE consent cadence lags), the UI would keep `dcReady=true` with a DC that silently drops outbound RPC — user-visible "send stalls" for 30-40s (30s interval + 10s probe timeout) until `__onIceFailed` finally fires. Round 10 only covered the case where the browser had already marked the PC dead; this round covers the intermediate window. New private method `__probeNow()` clears any pending keepalive timer, bumps `__keepaliveGen` to invalidate stale callbacks, and fires `__doKeepalive` immediately — reusing the existing `__onIceFailed` pipeline. Compresses the blackout window from 30-40s to ~1-3s (one probe timeout). `__state === 'connected'` guard inherited from round 10 still applies. `__probeNow` explicitly resets `__lastDcActivityAt = 0` to bypass the 20s activity-grace window — without that, short-pause scenarios (<20s) where DC inbound events have stopped updating the timestamp would let grace erroneously protect the failed probe and defer escalation, regressing the win to ~45s. Activity-grace is preserved for genuine SCTP-congestion cases, which never enter the paused state (so the reset has no side-effects on congestion detection).

  - **`__resumeOnline` restores `dashboard.instance.online=true` (P1 user-visible stale state)** — `claws.store.js` `__handleClawGoOffline` calls `syncDashboardOffline(id)` which hard-writes `dashboardStore.byClaw[id].instance.online = false`. On DC-continuity resume paths (`connected`/`restarting`, i.e. most short network blips), `refreshClawResources` is never triggered (correctly — the "only rebuild refreshes" principle saves flow), so that `instance.online=false` persists indefinitely until an unrelated `app:foreground` or manual navigation to ManageClawsPage. The review's core insight: "symmetric with agents/topics" was the wrong justification — `MainList.vue`'s `clawListKey` watcher reacts on `online` flip independently of DC state, so agents/topics naturally refresh on DC-continuity resume; dashboard has no equivalent path. Minimal fix: new `syncDashboardOnline(id)` hook in `claw-lifecycle.js` (mirrors `syncDashboardOffline`), invoked unconditionally at `__resumeOnline` entry (after sig gate, before type-changed accounting consumption). Display-field sync only — does not refresh aggregate data, preserving "only rebuild refreshes" for RPC-heavy loads.

  - **`updateClawOnline(true)` orders conn-lookup before `initialized=true`** — `claws.store.js:264-277` `updateClawOnline`'s `!initialized` branch historically set `claw.initialized = true` _before_ calling `useClawConnections().get(id)`, relying on the `if (conn)` guard to skip `__fullInit`. If the conn was not yet bridged (SSE event timing can in edge cases deliver `claw.online=true` before `addOrUpdateClaw`/`applySnapshot` bridges the conn), the claw would be stranded at `initialized=true + dcReady=false + no __fullInit fired` — the exact stranded-claw state class fixed in round 10 via the `applySnapshot` Phase 3 rescue. The other two rescue branches (`applySnapshot:362` and `__resumeAllClawsForSigOnline:623`) already use the correct order (lookup → null-guard → set). This reorders `updateClawOnline` to match, eliminating a fragile event-order dependency. Zero behavior change when conn is bridged (the common path).

  Tests: two new/updated cases for `resumeRecovery` (immediate probe happy path with `probe-ack`; probe-timeout path upgrading to `__onIceFailed → triggerRestart`); two new cases in `updateClawOnline` (conn-missing → `initialized` stays false; DC-continuity resume → `instance.online` restored to true + aggregate data not refreshed).

- ab2217b: Two fixes exposed by a test-coverage hardening pass on the RTC recovery gating module (following 11 earlier review rounds). Together with the associated test hardening, this pass increases the module's test count from 2845 to 2877 (+32 net tests, 0 skipped).

  - **`__ensureRtc` bail 分支清 `_pendingForceRefreshOnRebuild` (P0 signal leak)** — `claws.store.js` `__ensureRtc` 的三种 bail 分支（`removed`/`offline`/`sig_offline`）此前仅 snapshot+restore `rtcPhase` 和 `disconnectedAt`，漏掉对 `_pendingForceRefreshOnRebuild` 的清理。`__resumeOnline` 走 rebuild 分支时会把 id 写入该 Set；一旦 `__ensureRtc` 在 post-await 阶段 bail（特别是 `sig_offline`），残留条目会被任何后续由**非 `__resumeOnline` 路径**触发的 `__ensureRtc` 成功分支消费——比如 `conn.__onTriggerReconnect` 直驱、retry timer 落地、`app:foreground` 的 `__checkAndRecover`、`manualRetryUnreachable` 按钮。结果：对一条通过 DC 延续自然恢复的健康 PC 误 `force_refresh=1`，打出冗余 agents/sessions/topics/dashboard 刷新流量。修法：在 `bailedOut` 条件块内加 `_pendingForceRefreshOnRebuild.delete(id)`，与成功分支 L933 消费处对称。三种 reason 都清（`removed` 兼顾清僵尸 id、`offline` 在下次 online→true 走 rebuild 时会 re-add、`sig_offline` 是核心漏网场景）。

  - **`__resumeOnline` 把 `_pendingTypeChangedRestartClaws.delete` 延后到 conn 检查之后 (P1 signal loss + log drift)** — 原实现顺序：`syncDashboardOnline` → **`Set.delete(id)` 消费** → `const conn = manager.get(id)` → `if (!conn) return`。当 conn 在 sig 恢复瞬间恰好缺失（manager.disconnect 竞态 / rebridge 未完 / snapshot 删重建窗口）时，Set 条目已被消费但 `forceRestartOnConnected` 没处用，早退前也没归还信号——同一 sig cycle 内 typeChanged 记账永久丢失，下次 conn 回来再走 `__resumeOnline` 时 Set 已空，连带 `connected+paused` 分派降级为 `resumeRecovery`（轻量解冻，不发 ICE restart offer）。用户侧表现：WiFi↔ 蜂窝 IP 变化后 plugin 侧 DC 看似继续工作但旧 ICE 路径实际失效，需要等 30s keepalive 探测或下一次 typeChanged 事件才能恢复。修法：把 Set.delete 移到 `if (!conn) return` 之后，conn 缺失早退时 Set 条目保留供后续 resume 消费。`__resumeAllClawsForSigOnline` 的 `forceRestartCount` 日志仍按 `Set.has` 预计数（潜在数，非实发数），这是已知 trade-off，引入返回值改动面更大，暂不推进。

  **Scope note**: This round was driven by a dedicated test-coverage pass (Phase A symmetric test + Phase B×4 store-level integration scenarios + Phase B+ ×7 targeted gap tests). G-01 / G-04 exposed real bugs and are fixed here. G-02 / G-05-B / G-05-C initially exposed apparent bugs but follow-up audit concluded they are either production-unreachable (G-02: `rtc.state='connecting'` only exists alongside `_rtcInitInProgress=true` and its success path L930 already clears the Set) or mock-induced false positives (G-05 B/C: test's `fakeRtc.close()` is no-op but real `WebRtcConnection.close()` synchronously fires `onRtcStateChange('closed')` → writes `rtcPhase='failed'`); those skip tests were removed rather than left as permanent `.skip` noise. G-07 confirmed a P2 log-storm under sig offline + repeated identical snapshots (Phase 3 rescue re-fires `__fullInit` per snapshot since entry sig gate returns before `_rtcInitInProgress.set`); no functional impact, test left as observation fixture.

- df8c4d5: Three fixes exposed by a round-13 test-coverage hardening pass (following 12 earlier review rounds, driven by external-agent test suggestions). Together with the associated test hardening, this pass increases UI src test count from 2877 to 2915 (+38 net tests, 0 skipped).

  - **`__resumeOnline` connected+paused 分支对 `resumeRecovery` 自升级后的 restarting 状态加 early-return (P0 PC-close-race)** — `claws.store.js:__resumeOnline` L710-724 的 connected+paused 分支先调 `rtc.resumeRecovery()` 然后无 return 地 fall through 到 L724 `this.__ensureRtc(id)`。当 `resumeRecovery` 因 `pc.connectionState='failed' | 'disconnected'` 内部升级为 `triggerRestart('online_resume')`（`webrtc-connection.js:1200-1208`），`__attemptRestart` 同步 `__setState('restarting')`（`webrtc-connection.js:1033-1037`），rtc.state 立即翻转。随后 `__ensureRtc` 的 early-return 条件 L839 只认 `rtc.state==='connected'`，`'restarting'` 不命中 → 继续跑到 L858 `closeRtcForClaw(id)` 把刚升级的 restart PC 关掉，强制 rebuild。后果：刚发出的 ICE restart offer 白烧（浪费 ICE/TURN 预算），DC 不延续（新 SCTP 丢 plugin 侧 buffer），恢复延迟数秒到十几秒。生产触发路径典型：WiFi→ 蜂窝 IP 变化让 pc.connectionState 翻 disconnected，随后 SSE online 或 sig online 触发 `__resumeOnline`。修法：`rtc.resumeRecovery()` 之后加 `if (rtc.state === 'restarting') return;`，与 L702-708 restarting+paused 分支的 return 对称。

  - **`applySnapshot` Phase 3 rescue 入口加 `_sigOffline` 早退 (P2 log-storm)** — `claws.store.js:applySnapshot` 的 Phase 3 rescue 分支（对 online+!initialized claw 补跑 `__fullInit`）原本无 sig gate。sig offline 期间 SSE 仍能连推 snapshot（HTTP 通道），每次推同一份都会 fire `__fullInit`；`__ensureRtc` 入口的 sig gate 在 `_rtcInitInProgress.set` **之前** return（锁从未置位），内部双 gate 挡不住；`_rtcRetryState` 也因 `__fullInit` throw 早于 `__scheduleRetry` 路径，同样无法节流。结果：每次 snapshot 产出 `claw.fullInit` remoteLog + `fullInit (snapshot rescue) failed` warn 各一条，10 分钟断网可累积 40 条噪声。功能无影响（sig 恢复时 `__resumeAllClawsForSigOnline` 会补跑一次），但 P2 诊断日志噪声放大。修法：rescue 分支的 `if (claw?.online && !_rtcInitInProgress.get(id) && !_rtcRetryState.has(id))` 内部入口加 `if (_sigOffline) continue;`，与 `__ensureRtc` L823 对称；sig 恢复路径已覆盖首启竞态的合法 rescue 需求。

  - **`applySnapshot` 入口过滤 malformed claw id (P2 ghost connections)** — `claws.store.js:applySnapshot` 原实现对 Phase 1 仅 `String(b.id ?? '')` + `!id continue` 过滤，Phase 2 `arr.map(b => String(b.id))` 无任何过滤。server 合约虽不下发坏 id，但 proxy 篡改 / 序列化错误时 `null` / `undefined` / `{}` / 非 string-number 类型会被硬转成 `"null"` / `"undefined"` / `"[object Object]"` 送进 `manager.syncConnections`，建真实 `ClawConnection` 实例（ghost 连接）—— 烧 ICE/TURN 预算 + UI 列表脏数据 + 持续失败日志噪声。修法：在 `applySnapshot` 入口统一过滤一次，产出 `validArr`（白名单 `typeof === 'string' | 'number'` 且非空、且 String 化不落入 `null/undefined/[object Object]` 黑名单），Phase 1/2/3 共用；数字 id 保留 round 12 已建立的容忍契约不变。发现有 drop 时打 warn + remoteLog `claw.snapshotMalformed dropped=N received=M`，帮助定位上游脏数据源。

  **Scope note**: Round 13 was driven by external-agent test suggestions (P0×4 / P1×3 / P2×3 scenarios, E2E excluded). Of the 10 implemented scenarios, 7 found no bug (P0-2 pauseRestart during createOffer/SLD await, P0-3 stale rtc:answer/ice post-rebuild, P0-4 network:online multi-listener ordering, P1-1 probe during re-offline, P2-1 dashboard timeout assertions, P2-2 file transfer across ICE restart). The other three exposed real bugs; independent audit classified the first two as LOW risk (architectural-neutral one-liners) and the third (P2-3) as MEDIUM due to filter-contract edge decisions — user approved directly after confirming the change is pure filter + fallback with no architectural impact.

- 4779478: Five fixes from the 10th-round deep review (covers both the internal multi-subagent audit and an external review report):

  - **`applySnapshot` rescue for stranded `!initialized` claws (P1 user-visible stall)** — `claws.store.js` `applySnapshot` Phase 3 previously did `if (!claw?.initialized) continue`, which combined with `__bridgeConn`'s L458 short-circuit (`_bridgedConns` already holds the conn) to strand any claw that entered the map while offline (or had its initial `__fullInit` fail and roll back `initialized=false`). Subsequent snapshots would never re-fire `__fullInit`, and neither `__handleNetworkOnline` nor `__checkAndRecover` could recover it (both gate on `!initialized`/`!dcReady`). Only a fresh SSE `claw.status(true)` diff could unstick it — but the SSE reconnect path re-sends a full snapshot, not a diff. Phase 3 now has an explicit rescue branch that mirrors `__resumeAllClawsForSigOnline`'s `!initialized` handling: on `online=true && !initialized`, set `initialized=true`, fire `__fullInit(id, conn)` with catch-rollback. Double-gated against storm scenarios: skips when `_rtcInitInProgress` holds the lock (a prior rescue's `__ensureRtc` is still awaited) or when `_rtcRetryState.has(id)` (`__scheduleRetry` backoff is already queued) — otherwise repeated snapshots during pathological sig flap could drown `remoteLog` and bypass backoff throttling.

  - **`resumeRecovery` detects a dead PC and upgrades to ICE restart** — `webrtc-connection.js` `resumeRecovery()` previously only cleared `__restartPaused` and restarted keepalive, assuming the PC was healthy. But if `pc.connectionState` already went `failed`/`disconnected` during the pause (the ICE-failed event was dropped by the paused gate at L975 with no marker), the UI's `__state='connected'` was stale — recovery relied on the next probe/keepalive cycle failing (30–40s). Resume now reads `this.__pc?.connectionState` at entry **when `__state === 'connected'`** and, on `failed`/`disconnected`, calls `triggerRestart('online_resume')` (the sole paused-gate whitelist reason) to fire an ICE restart immediately. The `__state === 'connected'` guard is deliberate: `restarting+paused` already has an explicit `triggerRestart('online_resume')` dispatch path via `__resumeOnline`; auto-upgrading on `restarting` entry would change `resumeRecovery` semantics for a scenario that no caller actually uses today.

  - **Post-await bail also snapshots `disconnectedAt`** — `claws.store.js:__ensureRtc` sig_offline post-await bail previously only snapshot/restored `rtcPhase`. The `closeRtcForClaw` side-effect (`onRtcStateChange('closed')`) also writes `disconnectedAt=Date.now()`, which would then make the next sig-resume gap-aware refresh see a ~0ms gap and incorrectly skip the refresh. Now `disconnectedAt` is snapshot/restored alongside `rtcPhase` — consistent with the "sig is an environmental fault, do not pollute DC lifecycle/unreachable state" design intent.

  - **Remove redundant `claw.dcReady=true` in `__fullInit`** — `claws.store.js:__fullInit` used to explicitly write `claw.dcReady=true` after `await __ensureRtc(id)`, but the RTC state machine already writes it via `__ensureRtc` success-path (L881) and `onRtcStateChange('connected')` (L700). The business-layer write violated the "only the RTC state machine writes `dcReady`" decoupling invariant (though it was idempotent). Removed.

  - **Doc fix: `state-recovery.md` §7.x placeholder** — restored proper numbering (`§7.x` → `§7.2`, cascade-renumbered Deep Link → `§7.3`, Cold start → `§7.4`, KeepAlive → `§7.5`).

  Tests: seven new/updated cases cover the `applySnapshot` rescue path (happy path, "conn not yet bridged" edge, `_rtcInitInProgress` short-circuit, `_rtcRetryState` short-circuit), the post-await bail `disconnectedAt` restore, and the `resumeRecovery` pc-state-failed/disconnected upgrade (two sub-cases). Existing "resumeRecovery no-op in restarting+paused" test gains an explicit "no offer sent" assertion to lock the new conservative `__state === 'connected'` guard against future regression.

- 768aad8: RTC recovery — per-claw typeChanged restart bookkeeping:

  - Replace module-level boolean `_pendingTypeChangedRestart` with per-claw Set `_pendingTypeChangedRestartClaws`. The boolean was consumed in a single spot (`__resumeAllClawsForSigOnline`), which missed two real-world paths where the typeChanged signal would be silently dropped:
    - **sig online + claw offline + typeChanged**: main loop's `!claw.online continue` dropped the signal; subsequent `updateClawOnline(id, true)` default-resumed via `resumeRecovery()`, leaving the old (invalid) ICE path to hit ~30s consent timeout.
    - **sig offline + typeChanged + sig resume while claw still offline**: the boolean was consumed at sig resume and the signal was lost; later claw-online would default-resume on stale ICE.
  - `__handleNetworkOnline(typeChanged=true)` now records every claw that will NOT be immediately `triggerRestart`-ed by the main loop (offline / paused / restarting / failed / not initialized / sig offline). `__resumeOnline(id)` consumes the Set entry via `delete(id)` and treats a hit as `forceRestartOnConnected=true`.
  - Consistency: clean Set entries at all claw-lifecycle exit or recovery points to prevent stale entries from causing spurious `triggerRestart('online_resume')` on already-healthy connections:
    - `removeClawById` / `__resetClawStoreInternals` (logout) / `applySnapshot` cleanup loop
    - `updateClawOnline` `!initialized` branch (full init = fresh ICE path)
    - `__handleNetworkOnline` main loop success branches (`restarting → nudgeRestart`, `connected && typeChanged → triggerRestart('network_type_changed')`, `failed/closed → rebuild`)
    - `__resumeAllClawsForSigOnline` `!initialized` branch
  - `__resumeAllClawsForSigOnline` `force_restart` diagnostic counter moved to the `initialized` branch (the only path that actually consumes the Set via `__resumeOnline`), so `!initialized` claws no longer inflate the count.
  - `docs/architecture/communication-model.md` §5.5.1: rewrite the typeChanged bookkeeping paragraph to describe the per-claw Set and list the three newly covered paths.
  - `docs/designs/ice-restart-recovery.md` §6.5 and `ui/docs/state-recovery.md`: remove stale mentions of clearing `dcReady` / stamping `disconnectedAt` on offline (commit `4a05074` already made presence orthogonal to DC lifecycle; these doc lines had not been synced).

- 5921398: Two round-7 external review fixes to the RTC recovery gate:

  - `__resumeOnline` refresh rule simplified to a single clause: only PC rebuild triggers `force refresh`. All DC-continuous paths (`connected` / `restarting`, including the `forceRestartOnConnected` sub-case) now skip refresh uniformly. Rationale: as long as the PC is not rebuilt, the plugin-side DC send buffer survives ICE restart (SCTP persists); any rpc msg the plugin produced during the presence gap arrives naturally once ICE recovers. Only `rebuild` (failed / closed / idle / connecting / rtc=null) constructs a fresh SCTP — the old send buffer is lost and the plugin may have moved endpoints, so a force refresh is mandatory. Round 5/6 had a more complex three-way dispatch attempting to optimize the `forceRestart` case while keeping an "immediate refresh" clause for the non-forceRestart DC-continuous case — both of those cases collapse into the same rule now, removing one source of drift between `__resumeOnline` and the `wasDisconnected=false` branch of `onRtcStateChange('connected')` (which also does not refresh).

  - `webrtc-connection.js` `onAppForeground` handler now early-returns when `__restartPaused=true`. Previously, if a claw was frozen via `pauseRestart()` (claw.offline or sig_offline gate closed) and the app was sent to background and returned, foreground handler would re-arm the disconnected timer and restart keepalive despite the gate being closed. That would drive probe RPCs that plugin cannot receive (eventually dropped by the paused gate when probe failure tries to escalate to `triggerRestart`), silently violating the "recovery budget frozen while gate is closed" model. Now foreground handler respects the pause flag; explicit `resumeRecovery()` or `triggerRestart('online_resume')` remains the only way to unpause keepalive/timer.

  - Stale comments near `__bridgeConn` ("持续维护则不看 online") and `__checkAndRecover` ("不依赖 WS 指标") corrected to reflect the actual gate topology (both `claw.online` and `_sigOffline` now gate the maintenance paths).

  - Removed the `__resumeOnline` fall-through `.then(() => loadDashboardForClaw(id))` link. Prior to round 7 this link was masked by the wider force-refresh; after the round 7 simplification it became visible as an asymmetry — dashboard was still being loaded on DC-continuous paths while agents/sessions/topics were not. It also caused a redundant second `loadDashboard(id)` call on the rebuild path (one from `.then`, one from `refreshClawResources` consumed via `_pendingForceRefreshOnRebuild`; absorbed by `dashboard.store`'s in-flight dedup guard but still a source of reader confusion). Dashboard is now refreshed exclusively through the `_pendingForceRefreshOnRebuild` consume point on rebuild success, symmetric with the other three loaders. The now-orphan `loadDashboardForClaw` hook and its lifecycle registration were removed as dead code.

  - Updated `communication-model.md` §5.5, `ice-restart-recovery.md` §6.5, and `state-recovery.md` to match the rebuild-only refresh rule. Adjusted unit tests: DC-continuous paths (`connected` / `restarting+paused`) assert no refresh (including no dashboard load); new tests for `onAppForeground` paused guard covering both `PC disconnected` and `PC connected` post-background subcases.

- bd394fc: Three round-8 external review fixes covering pre-existing and current-branch gaps:

  - `webrtc-connection.js` `rtc:restart-rejected` handler now ignores the message unless the PC is currently in the `'restarting'` state. Rationale: the signaling `connId` is reused per claw (not per ICE restart generation); after a rebuild, the new `WebRtcConnection` instance's signaling listener still receives a late `rtc:restart-rejected` from the previous restart attempt. Without this guard the stale reject would call `close({ asFailed: true })` on the newly rebuilt PC, producing a spurious failed→rebuild cycle. The guard is UI-side only — no protocol change on plugin — and logs `rtc.restartRejectedStale` to remoteLog for diagnostics. This is a pre-existing gap (introduced with the ICE restart-first strategy in `db12a17`), surfaced by round-8 review; folded into this batch because the fix is small and self-contained.

  - `claws.store.js` `__handleNetworkOnline` now wakes up claws stuck in `rtc=null` + (`rtcPhase='failed'` or `!dcReady`). Previously these were skipped by the `if (!rtc) continue` early-out. After retry exhaustion the backoff timer is still scheduled, so recovery eventually happens — but the next scheduled retry typically uses an already-stale ICE path (WiFi↔cellular just changed), so waiting for the backoff window to elapse is pure lost time. The new branch clears retry state, flips `rtcPhase='recovering'`, and calls `__ensureRtc(id)` directly, cutting the recovery delay on network transitions. Defensive: if `rtc=null` but `rtcPhase='ready'` and `dcReady=true` (an inconsistent combination that shouldn't exist), the handler still skips.

  - `ui/docs/state-recovery.md` §7.x network debounce paragraph updated to describe the actual implementation (1200ms trailing-edge debounce with OR-aggregation on `typeChanged`) rather than the old 500ms leading-edge content-aware dedup. The code already has design-rationale comments in `src/utils/network-debounce.js`; this just re-syncs the doc.

  Tests: three new `__handleNetworkOnline` cases covering `rt=null + rtcPhase=failed`, `rt=null + !dcReady + rtcPhase=recovering`, and the defensive skip branch; one new `rtc:restart-rejected` test asserting the stale-message guard preserves a connected PC. The existing `rtc=null → 跳过` test description was clarified to reflect that `!initialized` is the short-circuit in that specific scenario.

- 54b609d: Close four RTC recovery edge cases around gate transitions on async / object-replacement boundaries, plus a defensive test-only addition for the offline gate retry steady state. All four fixes target the same family of symptoms — module-level state leaking past gate flips that happen during awaits, snapshot edges, or claw object identity changes.

  1. **`applySnapshot` fetched=false→true edge with stale `_sigOffline`** — previously, when the SSE-driven `addOrUpdateClaw` + `__fullInit` path built a live RTC before the first `applySnapshot` arrived and signaling dropped during that window, `__freezeAllClawsForSigOffline` early-returned on `!this.fetched` (intentional noise filter). When `applySnapshot` later flipped `fetched=true`, no path re-evaluated `_sigOffline`, leaving the live RTC active while signaling was already dead. Fixed by adding an edge-triggered catch-up: if `prevFetched === false && _sigOffline === true`, call `__freezeAllClawsForSigOffline()` once after `this.fetched = true`. Logged as `claw.sigOfflineCatchup count=N`.

  2. **`_rtcInitInProgress` leaking across remove + re-add same id** — `removeClawById` and `applySnapshot` Phase 1 cleanup already cleared `_probeInProgress` (round 18) but missed the symmetric `_rtcInitInProgress`. After remove, a new claw added with the same id had its `__ensureRtc` blocked at the entry lock until the in-flight old `await initRtc` resolved. When it did, the success path wrote `dcReady=true` / `rtcPhase='ready'` to the **new** claw object and consumed `_pendingForceRefreshOnRebuild` for the wrong instance. Fixed in two layers: (a) clear `_rtcInitInProgress.delete(id)` in `removeClawById` and the snapshot Phase 1 cleanup loop (symmetric with `_probeInProgress`); (b) capture `clawAtStart = this.byId[id]` before `await initRtc(...)` and add a new `'replaced'` post-await bail reason — when `cur !== clawAtStart`, only recycle the old conn's rtc (`closeRtcForClaw + conn.clearRtc`), do not write to the new claw's `rtcPhase` / `disconnectedAt`, and do not consume `_pendingForceRefreshOnRebuild` (the new claw enters its own Set entry via its own `__ensureRtc`). The `__ensureRtc` JSDoc now lists all four bail reasons (`removed` / `offline` / `sig_offline` / `replaced`) and their distinct semantics.

  3. **`__checkAndRecover` post-`probe` gate recheck missing** — after `await rtc.probe(...)`, the function only checked `byId[id]` existence and `rtc.state`, not `_sigOffline` or `claw.online`. If signaling dropped or the claw turned offline during the probe wait (typically 5s), the function still wrote `rtcPhase='recovering'` and called `triggerRestart('probe_failed')` (which has no sig gate at the rtc layer and would push signaling to a dead WS). Fixed by adding the `_sigOffline / !claw.online` recheck right after the existing `if (alive || !this.byId[id]) return` early-out, with `claw.recover claw=${id} reason=${kind}_post_probe source=${source}` logging.

  4. **`_pendingTypeChangedRestartClaws` early-consumed but `connected+!paused` path swallows the signal** — `__resumeOnline` consumed the Set entry at function entry and stored `forceRestartOnConnected=true`, but `forceRestartOnConnected` was only read inside the `connected + restartPaused` branch. When the new conn was `connected + !restartPaused` (typical scenario: `__handleNetworkOnline` records the per-claw flag while conn is missing or not yet initialized; later the conn becomes `connected + !paused`; sig comes back and triggers `__resumeAllClawsForSigOnline` → `__resumeOnline`), the entire paused branch was skipped, control fell through to `__ensureRtc`'s connected early-return, and the typeChanged signal was silently swallowed — the stale ICE path (built on the previous network) was never replaced. Fixed by switching to a "lookup, do not consume" mode at entry (`forceRestartOnConnected = forceRestartOnConnected || _pendingTypeChangedRestartClaws.has(id)`) and binding `_pendingTypeChangedRestartClaws.delete(id)` to each branch that actually fires `triggerRestart('online_resume')` (`restarting+paused`, `connected+paused+force`, and a new explicit upgrade branch for `connected+!paused+force`). The `restarting+!paused` path also gets a defensive `delete` (trusts the in-flight restart will use the new network). Doc sync in `docs/designs/ice-restart-recovery.md` documents the new lookup-vs-consume contract.

  5. **Test-only**: cover the previously missing "already-connected → WS close → OS goes offline → multi-round retry steady state" path in `signaling-connection.test.js`'s `offline 闸` describe block. The existing tests in this group all started from "未连接 + offline"; this one verifies that after a connected WS drops and the OS subsequently goes offline, the reconnect loop emits exactly one `paused` log and stays silent (no `delay=` logs) across 10+ retry cycles.

  Tests: `claws.store.test.js` UI test count 2989 → 3002 (+13 new tests across four `Round 20 Bug N` describe blocks plus the offline-gate steady-state test); electron 152 unchanged; `pnpm check` 0 errors / 2 pre-existing warnings unrelated to this change. One previously-existing test (`typeChanged cross-gate: rtcPhase=failed claw 记账消费后走 rebuild 分支`) was minimally adapted to await two microtasks to absorb the new "lookup-then-async-consume" timing of `_pendingTypeChangedRestartClaws` — assertion intent unchanged.

  Review disposition (round 20, 11 suggestions from external agent):

  - **Adopted (5): 4 code fixes + 1 test-only addition** — items 1, 2, 3, 4 above as code fixes; item 5 as test-only.
  - **Rejected (6)**:
    - `manualRetryUnreachable` while sig offline — already gated by `__ensureRtc` sig gate; sig recovery path takes over via `__resumeAllClawsForSigOnline`. UX wart was already filed in the prior round's backlog; not a correctness gap.
    - `applySnapshot` dup-id with `final online=false + initialized=false + sig offline` extreme combo — Phase 3 `!initialized` rescue gate already short-circuits on `!claw.online`, no new branches engaged; existing dup-id last-wins / online conflict tests cover the meaningful semantics.
    - `__bridgeConn`'s injected `__onTriggerReconnect` callback firing while sig/online gates are closed — gate enforcement is centralized at `__ensureRtc` entry; the callback path is already covered indirectly by the entry-gate test suite.
    - `file-transfer.js` upload symmetric "DC open + partial chunks + close → TRANSFER_INTERRUPTED" branch — defensive symmetry add of low value; existing upload close-during-waitForUploadAccept and backpressure-then-abort cases cover the meaningful close paths.
    - `ChatPage` silent reload promise reject — silent reload is fire-and-forget by design (`loadMessages({ silent: true })` is not awaited); the chat store's `doLoad` swallows errors and returns false. The `__connReadyStore` guard semantically tracks "first successful load"; silent reject reaching it would be by-design out-of-scope. The existing first-load reject rollback test already covers the meaningful case.
    - `__ensureRtc` connected early-return when `state==='connected' && !isReady` — flagged as suspicious bug, but verified that this state is a transient window during DTLS+SCTP handshake (between PC ICE-connected and DC.onopen). Adding a force-rebuild here risks thrashing during normal handshake. Deferred to backlog for deeper investigation in a future round (per round-18 lesson on transient-state early-returns).
  - **Backlog (1)**: `__ensureRtc` `state=connected + !isReady` corner — needs deeper analysis of whether `dc.onopen` reliably re-syncs `dcReady` via `__rtcCallbacks.onRtcStateChange` in all transient orderings, before deciding fix vs. lock-current-behavior test.

- 36baa42: Close one ICE-restart staleness bug and lock several recovery contracts that were exercised at module level but lacked end-to-end test coverage.

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

- 665f0e7: Close one chat-store streamingMsgs-loss bug, three same-id reuse races across per-claw stores, one RTC microtask race in `request()`, one falsy-as-success bug in remote log flushing, and lock three previously-uncovered contracts. All bugs surfaced from a round-22 external-agent review (9 suggestions, 9 adopted).

  1. **`chat.store.js: sendMessage` accepted branch dropped run even when silent reload failed** — after `endRun` the run-promise then-chain unconditionally called `dropRun(runKey, runId)` after `await loadMessages({ silent: true })`. `loadMessages` swallows network/conn errors and returns `false`, so under any silent-reload failure the streamingMsgs the user just watched would be wiped while the final message had not been fetched. Fixed by only calling `dropRun` when `loadMessages` returned truthy. Recovery paths: (a) next `activate` / `__onConnReady` triggers another silent `loadMessages` — on success, the same `if (ok) dropRun` branch fires; (b) on continued failure, `agent-runs.store.js`'s 24h `POST_ACCEPT_TIMEOUT_MS` timer is the eventual safety net (already covered by an existing test).

  2. **`agents.store.js: removeByClaw` did not clear `_loadingByClaw` (in-flight dedup map)** — when `claw.unbound` triggered `cleanupClawResources` → `agents.removeByClaw`, only `byClaw[id]` was deleted. If a new claw with the same id was bound during the in-flight window, a fresh `loadAgents(id)` coalesced onto the _old_ promise, which on resolve wrote onto a detached `entry` object — the new claw ended up with no agent data. Fixed by `_loadingByClaw.delete(String(clawId))` in `removeByClaw`, mirroring the round-18 `_probeInProgress` and round-20 `_rtcInitInProgress` symmetric cleanup pattern.

  3. **`sessions.store.js: removeSessionsByClawId` did not clear `_perClawLoading`** — identical pattern to fix 2. The `if (!clawsStore.byId[id])` guard at the end of `__doLoadForClaw` checks only that _some_ claw exists at that id, not whether it is the _same instance_ the fetch was started for. Without clearing the in-flight map, the new `loadSessionsForClaw` is dedup-coalesced onto the stale promise; when it resolves, the old fetch's results are written into the new claw's slot. Fixed by `_perClawLoading.delete(id)` in `removeSessionsByClawId`.

  4. **`topics.store.js: removeByClaw` did not clear `_perClawLoading`** — exact same shape as fix 3 (topics is parallel to sessions). Fixed identically.

  5. **`claw-connection.js: request → doSend` had a microtask race after `clearRtc`** — `waitReady → setRtc` synchronously resolves all waiters, and `doSend` enters as a microtask. If `clearRtc` runs in the same sync segment or an earlier microtask, `this.__rtc` becomes `null`. `doSend` then allocated id / pending entry / timer first and only afterwards dereferenced `this.__rtc.send(...)` → `TypeError`, escaping the `.then` chain as an unmapped rejection (NOT `RTC_LOST`). Fixed by re-checking `this.__rtc?.isReady` at the top of `doSend` before any allocation; on miss, reject with `RTC_LOST` using the same shape as the existing `clearRtc` reject path.

  6. **`remote-log.js: __flush` treated sender returning `false` as success** — `signaling-connection.js: __sendRaw` explicitly returns `false` when `__ws` is missing or not in `OPEN`, or when the synchronous `send()` call throws. The previous flush loop ignored the return value and immediately spliced the buffer, so in the narrow window between a `state==='connected'` signal and the WS actually breaking, a log batch was silently dropped. Fixed by capturing the sender return; if `=== false`, break the loop without splicing (preserving the buffer for the next `setSender(connected)` retry). `undefined` / `true` / any other non-false value is treated as success — no over-tightening for senders that don't return anything explicitly.

  Tests (9 new test groups, 13 new tests; baseline UI 3011 → final 3024; electron 152 unchanged; coverage stmts 98.43% / branches 93.1% / funcs 98.21% / lines 98.43%):

  - `chat.store.test.js` — pair: `accepted 后 silent loadMessages 失败：保留 run 与 streamingMsgs，不调 dropRun` and `accepted 后 silent loadMessages 成功：触发 dropRun`. Locks fix 1 from both directions; the failure-side test extends the wait to multiple microtasks + a macrotask after `sessions.get` is called, ensuring the then-chain settles past the `if (ok)` branch before assertions.
  - `agents.store.test.js` — `removeByClaw 期间清飞行中 dedup：同 id 重绑后新 loadAgents 走独立请求`: locks fix 2 by setting up a deferred RPC, calling `removeByClaw('a')`, then triggering `loadAgents('a')` again on a fresh conn — asserts the fresh conn's `request` is invoked (would fail if the in-flight dedup line were reverted).
  - `sessions.store.test.js` — `removeSessionsByClawId 期间清飞行中 dedup：同 id 重绑后新 loadForClaw 走独立请求`: locks fix 3 with the same shape as the agents test.
  - `topics.store.test.js` — `removeByClaw 期间清飞行中 dedup：同 id 重绑后新 loadForClaw 走独立请求`: locks fix 4 with the same shape.
  - `chat-store-manager.test.js` — `settling 状态（ended=true 但 streamingMsgs 非空）的 topic 仍被 LRU 淘汰（契约锁）`: locks the current LRU behavior under the settling window — since `runsStore.isRunning` only checks `!run.ended`, an ended-but-still-streaming topic is eligible for eviction. JSDoc cross-refs the chat.store accepted branch and notes this is a current-behavior lock, not a permanent contract.
  - `claw-connection.test.js` — pair: `setRtc resolve waiter 后 clearRtc，doSend 入口重核 → reject RTC_LOST 不泄漏 pending/timer` and `正常路径：waitReady 排队 → setRtc 后 doSend 仍能发送（行为锁）`: locks fix 5 from both directions; the race test asserts reject with `code: 'RTC_LOST'` AND no pending entry leaked AND `send` not called.
  - `remote-log.test.js` — `sender 返回 false 时不 splice，缓冲区保留供下次 flush`: locks fix 6 with content-level assertions on the preserved buffer entries; follow-up assertion confirms a working sender on the next setSender flushes successfully.
  - `capacitor-app-browser.test.js` (NEW file, 8 tests total) — split across three describes:
    - 4 visibility-bridge tests (cold-start `visibilityState=visible/hidden`, desktop / Capacitor-native skip).
    - 2 online/offline tests for the `wasOffline` gate: `未经过 offline 的 online 事件 → 不派发 network:online（冷启动 spurious 抑制）` and `先 offline 后 online → 派发 network:online + 写 remoteLog`.
    - 2 indirect locks for `setupAppStateChange` focusin handler attachment + INPUT/DIV branch safety. (See backlog note below for why direct callback invocation of `appStateChange` was not implemented.)
  - `capacitor-app.test.js` — single-line cross-ref comment added to the existing `'前台恢复时派发 app:foreground'` test pointing to the new browser file's focusin contract; the test body itself is unchanged (out of scope).

  Review disposition (round 22, 9 suggestions from external agent):

  - **Adopted (9): 6 code fixes + 3 test-only adoptions** — fixes 1–6 above (each contributes both the code fix and its locking test groups) plus three pure test additions: chat-store-manager LRU settling lock, capacitor-app browser online/offline wasOffline gate, capacitor-app `setupAppStateChange` focusin handler indirect lock.
  - **Rejected (0)** — all 9 suggestions verified by parallel opus subagents against current code; no false positives.

  Backlog (deferred from review):

  - **`setupAppStateChange` direct callback capture** — original Test-only-3 plan was to capture the `appStateChange` callback via the `@capacitor/app` mock and invoke `cb({isActive:true/false})` to lock the foreground/background dispatch + remoteLog + focus-restore branches end-to-end. Substituted with focusin handler indirect lock because of an existing-known limitation: the second dynamic `import('@capacitor/app')` from inside `setupAppStateChange` resolves to a different proxy than the first import (used by `setupBackButton`), and the test mock factory only intercepts the first. The codebase already documents this at `capacitor-app.test.js` lines 18–21 (pre-existing comment). A separate cleanup pass should investigate `vi.doMock` between dynamic imports or factor the `App` reference out for test injection — both out of scope for round 22.

  **Scope note**: round 22 is the highest-yield round in the test-hardening series so far — 9 of 9 suggestions adopted (100%), 6 of which are code fixes (P1 severity each per external agent's classification). The cluster is "module-level Map / coalesce-promise leaks across same-id remove + re-add" (fixes 2/3/4) and "async chain crosses a state boundary the caller does not re-check" (fixes 1/5/6). All three families have been swept in earlier rounds for `claws.store.js` and `webrtc-connection.js`; this round extends the same sweep to per-claw sub-stores and to chat / claw-connection / remote-log layers.

- 9ab962d: Five real bugs surfaced by an external review pass plus 7 test groups (19 new tests across UI + electron). Review covered 12 observations; after triage, 7 were adopted (5 code fixes + 2 test-only contract locks), 3 were rejected, 2 were deferred to backlog.

  - **`topics.store.__doLoadAll` zip-mismatch when conn vanishes during sync loop** (`src/stores/topics.store.js:__doLoadAll`) — Tasks were generated by a `for` loop that called `getReadyConn(claw.id)` synchronously and `continue`-d on null. The resulting `Promise.allSettled` results array could be shorter than `connectedClaws`, and the post-await loop indexed failures by `connectedClaws[i].id` — so a failed result for B got blamed on A, and B stayed in `queriedClawIds` causing its old topics to be wiped on merge. Fix: replace the loop with `connectedClaws.map(...)` so results are length-aligned, return a `null` sentinel when sync `getReadyConn` is null, and add a result-time `getReadyConn(cid)` re-check to drop the claw from `queriedClawIds` when conn vanished mid-await. Mirrors the `sessions.store.__doLoadAll` shape that round 23 fixed — this closes the last instance in the per-claw async-fetch family. Family signal: cross-store in-flight aggregation where downstream `if (!conn) continue` skips alongside upstream `Promise.allSettled` zipped by input index.

  - **`dashboard.store` in-flight Map asymmetric cleanup** (`src/stores/dashboard.store.js:loadDashboard,clearDashboard`) — The fourth (and last) per-claw store still missing the round-22/23 symmetric cleanup pair: (a) `loadDashboard.finally` did `_loadingByClaw.delete(id)` unconditionally, so an old promise's late finally would erase a NEW promise's dedup entry written after `clearDashboard + same-id rebind`; (b) `clearDashboard` only removed `byClaw[id]`, leaving the in-flight entry behind so a fresh `loadDashboard(id)` would coalesce onto the old promise (which then writes the previous claw's `instance` / `agents` into the new entry's slot). Fix: add the promise identity guard `if (_loadingByClaw.get(id) === p)` to the finally, and have `clearDashboard` synchronously delete the in-flight entry. The orphan-entry write that the old IIFE may still perform after `clearDashboard` lands on a closure-captured object that the store has already removed — invisible to consumers and GC-eligible (a clarifying comment was added at the entry-capture site to lock that contract for future maintainers).

  - **`capacitor-app.setupNetworkListener` getStatus race overrides newer live event** (`src/utils/capacitor-app.js:setupNetworkListener`) — `Network.getStatus().then(...)` unconditionally wrote `_lastConnectionType = normalized` whenever it eventually resolved. If the user switched networks during the in-flight init (live `networkStatusChange` already wrote `_lastConnectionType=cellular`), a slow getStatus returning the prior `wifi` would overwrite back to wifi, and the next live wifi event would then be wrongly classified as `typeChanged=true` — triggering an unnecessary ICE-restart cycle. Fix: introduce module-scoped monotonic counter `_networkEventCount` (incremented on every `networkStatusChange` fire); `setupNetworkListener` snapshots `eventCountBefore` at entry, and the `getStatus().then` only writes the initial value when the counter still equals the snapshot (no live event ran during init). Counter (rather than value comparison) is required because a coincidentally-equal value (e.g. live event also wrote `wifi`) must still mark "live event won".

  - **Three `setup*` functions silently dropped `import('@capacitor/app')` rejections** (`src/utils/capacitor-app.js:setupAppStateChange,setupDeepLink,setupBackButton`) — The dynamic imports for these three setup functions had no `.catch`. If `@capacitor/app` failed to load (native plugin missing in dev / partial-platform setup), the resulting unhandled rejection slipped past `initCapacitorApp`'s try/catch (which only catches sync throws, not deferred promise rejections), and all three listeners (foreground bridge / deep-link routing / Android back button) silently went unregistered. Fix: append `.catch((e) => console.warn(...))` to each, mirroring the existing pattern on `setupKeyboard` and `setupNetworkListener`. Family signal: sister functions inside the same module diverging on whether they `.catch` their dynamic imports.

  - **`electron` IPC handlers had no protocol allowlist on `shell:openExternal` / `download:start`** (`electron/ipc-handlers.js:registerIpcHandlers`) — The shell's `setWindowOpenHandler` and `will-navigate` already restrict navigation to http/https, but renderer-initiated IPC calls bypassed that defense entirely: a compromised renderer (or developer mistake) could call `shell.openExternal('file:///etc/passwd')` and have the OS handle a local-file URI, or `download:start('file:///...')` and have Chromium treat a local file as a download source. Fix: add `isAllowedExternalProtocol(url)` helper (rejects non-string, non-http(s), and unparseable URLs) and gate both handlers through it; rejected calls log a warn and return undefined. The two-layer defense (window-open layer + IPC layer) now mirrors each other symmetrically. Family signal: defense-in-depth at one transport layer (navigation) but not the symmetric layer (IPC) for the same downstream sink.

  Test changes (7 new test groups, 19 new tests across UI + electron; baseline 3035 → 3047 UI tests, 152 → 159 electron tests, all green):

  - **`topics.store __doLoadAll zip alignment`** (`src/stores/topics.store.test.js`) — Three tests in a new `__doLoadAll zip alignment` describe block. (a) Sync conn vanish: A's conn removed before sync loop; asserts A's old topics survive, B's new topics are written, and A's RPC is never sent (`toHaveBeenCalledTimes(0)` strong lock). (b) Result-time vanish: SSE `claw.unbound` clears conn during in-flight RPC; asserts result-time `getReadyConn` re-check drops the claw from `queriedClawIds` so old topics are preserved on merge. (c) Reverse assertion: healthy conn + remote really empty topics still wipes old (so the guard doesn't over-reach into "real-empty" cases).

  - **`dashboard.store` in-flight Map symmetry** (`src/stores/dashboard.store.test.js`) — Two tests. (a) `clearDashboard` synchronously clears the in-flight dedup entry; same-id rebind then issues an independent RPC batch (not coalesced onto the old deferred promise). (b) Stale finally identity check: an old `loadDashboard` that completes after `clearDashboard + same-id rebind + new loadDashboard` does NOT erase the new entry — verified by asserting a third same-id call still hits dedup (no extra RPC).

  - **`capacitor-app setupNetworkListener` getStatus race** (`src/utils/capacitor-app.test.js`) — One test using `mockImplementationOnce` to keep `getStatus` deferred during init, then fires a live `wifi` event before resolving `getStatus(cellular)`; asserts the next live `wifi` event detects `typeChanged=false` (proving `_lastConnectionType` stayed at `wifi` and was not overwritten by the slow getStatus).

  - **`parseDeepLinkPath` URL parsing branches** (`src/utils/capacitor-app.test.js`) — Four tests on the newly-exported pure function (extracted from `setupDeepLink` to bypass the known vitest dynamic-import mock limitation): `coclaw://chat/123 → /chat/123`, `coclaw:// → null` (root, no nav), `not a url → throws TypeError` (caller catches and warns), `coclaw://chat → /chat` (host-only no pathname).

  - **Three `setup*` `.catch` source-pattern lock** (`src/utils/capacitor-app.test.js`) — One test using `node:fs` to grep the source for the three `import('@capacitor/app').then(...).catch((e) => console.warn('[capacitor] <name> setup failed:'...))` patterns. The test name explicitly notes "源码 pattern lock，非行为测试，仅防漏 .catch" so future readers don't mistake it for a behavioral test. Justification (in test comment): vitest's documented limitation that the second dynamic import of the same mocked module returns a different proxy makes a true reject-behavior test infeasible without restructuring the dynamic-import strategy.

  - **`__enqueueSendMulti` fast-path partial throw** (`src/services/webrtc-connection.test.js`) — One test: forces 3-chunk fragmentation, lets `dc.send` throw on the 2nd chunk, asserts the entire promise rejects with the same error instance, `__sendQueue` stays empty (chunks weren't enqueued), `dc.send` was called exactly twice (`toHaveBeenCalledTimes(2)`), and `__rpcChannel` is unchanged. Distinguishes the fast-path sync-throw contract from the existing DC-close path that enqueues then `__rejectSendQueue`s.

  - **`shell:openExternal` / `download:start` protocol allowlist** (`electron/ipc-handlers.test.js`) — Seven tests across the two channels. shell: passes http/https through, rejects `file://`, rejects `javascript:`, rejects malformed URL, rejects non-string input. download: passes https through (existing test reused), rejects `file://`, rejects malformed URL. Each rejection asserts both `not.toHaveBeenCalled` on the downstream Electron API and `logMock.warn` containing the channel-specific reject message. `logMock.warn.mockClear()` was added to the existing `beforeEach` to make this assertion stable for future tests too.

  **Review disposition** (12 observations total):

  _Rejected (3):_

  - chat.store `activate()` re-entry while first activate is in-flight — appears to start a concurrent silent reload, but the silent path returns idempotent server data and `dropRun` is gated by `if (ok)` (round 22 fix), so the only observable effect is one extra `sessions.get` call. Existing test `重复调用 activate 时做静默刷新（不重复 init）` already locks the relevant invariant.
  - `webrtc-connection.__attemptRestart` action when TURN credentials expired — `credRemain<0` is logged as a diagnostic field but intentionally not branched on. By design: TURN creds are refreshed only at `initRtc`/rebuild time; restart phase always uses the existing creds. Existing test `ICE restart offer 日志 credRemain 为负（凭证已过期）` already locks this behavior.
  - `signaling-connection.releaseConnId` not checking `__sendRaw` return value — by design: client-side single-party release is the contract (server cleans up its own side on WS disconnect/timeout); waiting for server ack would risk client-side connId-slot leaks if WS is broken when release is called.

  _Backlog (2):_

  - `topics.store.createTopic` does not re-check `useClawsStore().byId[clawId]` after `await conn.request('coclaw.topics.create')`. If `removeByClaw` runs mid-await, a ghost topic is written to `byId` pointing at a now-removed claw. Self-healing path is clear (next `loadAllTopics` removes it via the `clawsStore.byId[bid]` check), so user-visible window is narrow (must navigate into the topic in the same frame as unbind). Different family from the per-claw fetch series — that one is "background fetch writes back stale data", this is "user-initiated create writes back". Deferred.
  - `claw-connection.setRtc` accepting a non-ready RTC: caller-side `webrtc-connection.onReady = () => ... setRtc(rtc)` only fires when `dc.onopen` triggers (so `isReady === true` is guaranteed in production). The defensive non-ready branch only logs a warn and the downstream `request → doSend` re-checks `__rtc?.isReady` (round 22 fix) and rejects `RTC_LOST`. Adding a contract test only locks an unreachable defensive net. Deferred.

  _Adopted (7):_ 5 code fixes + 2 test-only contract locks (UI `__enqueueSendMulti` fast-path partial throw + electron protocol allowlist), as documented above. Three deep-review structural recommendations were inlined: `dashboard.store` IIFE entry-capture comment, `electron/ipc-handlers.test.js` `logMock.warn.mockClear()` in beforeEach, and capacitor source-pattern lock test name annotation.

- 1e9a3ef: Two small follow-up fixes from round-9 external review:

  - `claws.store.js` `__handleNetworkOnline` `state === 'restarting'` branch now mirrors the `state === 'connected' && restartPaused` branch: when `rtc.restartPaused` is true, skip `nudgeRestart()` and preserve the `_pendingTypeChangedRestartClaws` entry for later `__resumeOnline` consumption (which upgrades to `triggerRestart('online_resume')` — the sole reason that passes the paused gate at `webrtc-connection.js:975`). Previously this branch would both `delete` the Set entry and call `nudgeRestart()`, which `__attemptRestart('nudge')` drops when paused — net effect: restart not sent AND typeChanged signal permanently lost. Reachability in practice is narrow (the paused=true invariant normally implies `claw.online=false` OR `_sigOffline=true`, both of which are gated earlier in `__handleNetworkOnline`), but the defensive symmetry with the connected+paused branch is worth ~5 lines and blocks any future ordering surprise. Logs `claw.typeChanged claw=<id> paused_restarting defer_to_resume` via remoteLog.

  - `webrtc-connection.test.js` cleans up three `no-unused-vars` lint warnings (`dc`/`pc` destructured but never used) introduced by earlier edits at L2181/L2273/L2595.

  Tests: one new test `"#2 round9: 主循环 restarting+paused + typeChanged 不发 nudgeRestart，Set 保留给 resume 消费"` asserts (a) `nudgeRestart`/`triggerRestart` not called on the `__handleNetworkOnline(true)` call, (b) after a subsequent sig down/up cycle, `__resumeOnline` consumes the preserved Set entry and fires `triggerRestart('online_resume')`.

- 5fc37d5: Freeze all claws' ICE restart / rebuild budget when the signaling WS is not connected (electric elevator, airplane mode, WiFi drop, server restart, etc.). Introduces a second lock (`_sigOffline`) parallel to the existing `claw.online` lock: recovery actions resume only when both locks are open. Frozen state keeps the PC and clears the per-claw retry budget; on WS reconnect, online claws are dispatched through the existing `__resumeOnline` path (ICE restart / rebuild / noop by PC state).
- 17b7ce9: fix(ui): override navigator.onLine in signaling \_\_doConnect when Capacitor reports online

  Android WebView occasionally reports `navigator.onLine === false` even when the
  device is connected. The signaling layer used to silently pause every recovery
  path in that case, leaving `sig.state` stuck at `disconnected` until the OS flag
  flipped back. Track a sticky `__nativeOnline` flag set whenever the
  `@capacitor/network` bridge fires `network:online`, and let it override the
  `navigator.onLine === false` gate so genuine connectivity is no longer masked
  by an OS-side false negative. Reset on `disconnect()` for clean session
  boundaries.

- 09ec618: Silence signaling WS reconnect log storm when device is truly offline. During real offline (airplane mode / WiFi off / cable unplugged), the WS reconnect loop previously fired 4 `log` events per cycle (`sig.reconnect delay=...`, `sig.state disconnected→connecting`, `sig.close code=...`, `sig.state connecting→disconnected`); these were consumed by `remote-log.js` and piled into its 1000-entry buffer (sender inactive while offline, so the buffer churned shift/push continuously). Over 10 minutes of offline this produced ~80 log events.

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

- c9205b3: fix(ui): topics \_\_doLoadAll skips fulfilled results whose claw conn vanished mid-fetch

  The first merge loop already preserves the old topics of any claw evicted
  from `queriedClawIds` (sync conn-vanish or fetch failure or post-fetch
  conn-vanish), but the second loop still walked every fulfilled result and
  inserted its `topics`, so a claw whose conn vanished after the request
  resolved would inject "ghost" topics into `byId` even though the claw is
  gone from the store. Skip evicted-claw fulfilled results in the second
  loop too, keeping the merge symmetric with the eviction set.

## 0.17.4

### Patch Changes

- 9e24cbe: Allow creating file-transfer DataChannels while the RTC is in `restarting` state.

  Previously `WebRtcConnection.createDataChannel()` rejected four states (`closed`, `failed`, `restarting`, no PC). `restarting` was added defensively when ICE-restart-first was introduced, but it contradicts that feature's own design goal ("file DC survives restart"): during ICE restart the SCTP/DTLS layers are preserved, so a newly created DC merely sits in `connecting` until the UDP path is re-nominated, then opens — exactly as the existing DCs do.

  The spurious reject manifested as broken images in chat/topic pages right after app foreground resume: many `ChatImg` components concurrently call `downloadFile` during the several-second `restarting` window; `waitReady` fast-paths (rpc DC is still `open`) but `createFileDC` is then shot down with `RTC_NOT_READY`, leaving `ChatImg` stuck in the error-card state (no auto-retry, and silent reload cannot heal it because the `src` prop value is unchanged).

  Fix: drop `restarting` from the reject list; `closed` / `failed` / no-PC still reject. Both download (`downloadFile`) and upload (`postFile` / `uploadFile`) benefit since they share the same `createFileDC` helper. The inverted unit test now asserts that a restart-time `createDataChannel` call returns a valid DC with `binaryType='arraybuffer'`.

## 0.17.3

### Patch Changes

- 617045a: Fix silent image corruption on file downloads when `dc.close` races ahead of the final `{ok:true,bytes}` JSON.

  `WebRtcConnection.createDataChannel` (the public entry point used for `file:<transferId>` DCs) was not setting `dc.binaryType`. The W3C WebRTC default is `'blob'`, which is what Firefox and Safari/WebKit use; Chromium has historically deviated but behavior across WebView versions is not guaranteed. Under `binaryType='blob'`, each incoming binary chunk in `file-transfer.js` was a `Blob` (which has `.size`, not `.byteLength`), so `receivedBytes += event.data.byteLength` accumulated `NaN` from the first chunk on.

  On the happy path (`{ok:true,bytes}` JSON arrives before `dc.close` fires), downloads still appeared to succeed — `new Blob(chunks)` transparently concatenates a mixed array of Blobs. The bug only surfaced on the `onclose`-first race (acknowledged by existing defensive comments on both ends — `plugins/openclaw/src/file-manager/handler.js` explicitly `await dc.close()` for graceful semantics, and `file-transfer.js` adds a `setTimeout(0)` macrotask to let queued `message` events drain first). In that branch the fallback checks `receivedBytes >= totalSize`, which with `NaN` is always `false`, rejecting the transfer as `TRANSFER_INTERRUPTED` even though every byte had in fact arrived and `chunks` held a valid payload. Users see a broken image; remounting the component (navigate away + back) usually wins the race the second time. The race is more likely during ICE restart recovery, app foreground resume, long list renders, or any main-thread pressure — precisely the moments aggressive topic/chat cache + silent background reload triggers batch downloads, so the defect compounds.

  Changes:

  - `webrtc-connection.js`: set `dc.binaryType = 'arraybuffer'` immediately after creating the DC in `createDataChannel`, before returning (mirrors the rpc DC setup at the private `__setupDataChannelEvents` path). Async Blob construction is removed from the binary-message dispatch path, shrinking the race window as a side benefit.
  - `file-transfer.js`: defensive `event.data.byteLength ?? event.data.size ?? 0` so that any future path which forgets to set `binaryType` cannot silently corrupt the byte counter.
  - `webrtc-connection.test.js`: mock PeerConnection's `createDataChannel` now exposes `binaryType: 'blob'` as the default (matching spec), and a new assertion verifies the public API flips it to `'arraybuffer'`.
  - `file-transfer.test.js`: new close/message race test where the binary chunk arrives as an actual `Blob` (no `byteLength`); the `onclose` fallback must still recognize the bytes are complete and resolve.

  No protocol or wire-format change.

- 2f1e57d: Fix disconnected timer lifecycle across app:background/foreground transitions. Previously `__disconnectedTimer` was not cleared on background, allowing it to fire during suspension and trigger `setLocalDescription` (which replaces ICE credentials, preventing original-pair auto-recovery). On long backgrounds, the resulting `__restartStartTime` would be recorded while suspended, causing the foreground `nudgeRestart` to hit the "time budget exhausted → rebuild" bad path. Now:

  - `__onAppBackground` clears the disconnected timer and records the background timestamp.
  - `__onAppForeground` re-arms the timer only if PC is still `disconnected`, with a two-tier timeout based on background duration: < 25s uses the standard 5s self-heal window; ≥ 25s uses 1.5s (enough for browser/WebView internal state to settle, not for self-healing). Long backgrounds typically surface as `connectionState='failed'` events that trigger restart immediately, bypassing this timer.
  - Removes dead code in `claws.store.js` `__checkAndRecover` that branched on `rtc.state === 'disconnected'` — `WebRtcConnection.__state` is never `'disconnected'` (the PC's `connectionState` is a separate machine).

- 835023e: Tighten ICE restart safety-net timer from 30s → 15s and add offer→answer RTT observability.

  The safety-net timer re-sends an `rtc:offer` when neither the `connectionState` event path nor the 500ms stats-poll path has detected recovery — the canonical remaining case is a lost `rtc:answer` in the return path. Previously the worst-case recovery latency in that scenario was 30s; now it is 15s. Normal offer→answer RTT sits in the 1–3s range, so 15s retains an order-of-magnitude safety margin.

  To ground future tuning in real data, this change records the timestamp at each `rtc:offer` send and, on arrival of the corresponding `rtc:answer` during `restarting`, emits both a local `__log('info', …)` entry and a structured `remoteLog('rtc.restartAnswer claw=… rtt=…ms attempt=…')` event.

  No API or behavior change outside the ICE restart retry cadence; the field `__restartOfferSentAt` is cleared in `__clearRestartState` alongside the existing restart-state fields.

- 3a7c1e5: Harden `SignalingConnection.ensureConnected` against stale WS states. Previously both `ensureConnected` and `__handleForegroundResume` trusted the JS-layer `__state` blindly — after long mobile backgrounds a `connected` state could mask a zombie TCP, and a `connecting` state could persist indefinitely after a stalled handshake. RTC would send offers into the void or wait up to 15s on a dead handshake.

  Now `ensureConnected` applies a freshness safety net:

  - `state === 'connected'` + `elapsed > HB_TIMEOUT_MS` (45s) → `forceReconnect()` then wait for new WS.
  - `state === 'connecting'` + state-duration > `CONNECT_TIMEOUT_MS` (15s) → `forceReconnect()` then wait.

  `__handleForegroundResume` applies the same staleness check in its `connecting` branch. The `verify` parameter, `VERIFY_COOLDOWN_MS` constant, and `__lastVerifiedAt` field are removed — their semantics are subsumed by the new unified freshness check. `webrtc-connection.js` rebuild path no longer passes `{verify:true}`; ICE restart path unchanged.

  Eliminates the implicit dependency on event-listener registration order (WS handler before RTC handler), making the recovery path robust to future refactors of the foreground-event dispatch.

- 6a0479b: Add AbortSignal support to RPC and file-transfer; extend connect timeouts to 120s to match RTC recovery window.

  Previously `waitReady` / `request()` used a 30s `connectTimeout` and `READY_TIMEOUT_MS` was 15s. But the underlying RTC recovery cycle can last up to ~3 minutes (ICE restart 90s + rebuild backoff), so application-level requests could reject with `CONNECT_TIMEOUT` while RTC was still quietly recovering — the user would see a stale error toast, then everything would work again seconds later.

  - `ClawConnection.request()` now accepts `options.signal` (AbortSignal). The signal covers both the `waitReady` queueing stage and the `pending` wait-for-response stage.
  - `downloadFile` / `uploadFile` / `postFile` now accept `opts.signal`. The signal covers the full three-stage lifecycle (waitReady → wait for response header → chunk send/receive), aligning with the fetch/axios mental model.
  - `handle.cancel()` on file transfers is kept as a backward-compatible API (internally equivalent to `controller.abort()`). Existing callers are unaffected.
  - Abort reject shape aligns with axios `CanceledError`: `err.name = 'CanceledError'`, `err.code = 'ERR_CANCELED'`. Check via `err.code === 'ERR_CANCELED'`.
  - `DEFAULT_CONNECT_TIMEOUT_MS`: 30s → 120s. `READY_TIMEOUT_MS`: 15s → 120s.
  - Existing call sites pass no signal — this is purely infrastructure groundwork. No behavioural change for callers that don't opt in.
  - Fixes a pre-existing latent bug: file-transfer `handle.cancel()` during the waitReady queueing stage used to defer the outer-promise reject until `waitReady` itself settled. Now the signal is threaded through `waitReady`, so cancel is immediate.

  Internal error code migration: file-transfer's cancellation error code changed from `CANCELLED` to `ERR_CANCELED`. Two call-site checks (`files.store.js`, `chat.store.js`) were updated in lockstep. No i18n changes required — the chat-store cancellation path early-returns before hitting UI notify.

## 0.17.2

### Patch Changes

- 502369b: fix(ui): debounce network:online to collapse Android WiFi toggle double-restart

  Android emits a brief wifi→cellular→wifi transition when the user toggles the
  WiFi switch; each transition is a distinct `typeChanged` event. The previous
  source-level dedup (500ms window, leading-edge) explicitly bypassed the window
  for `typeChanged=true`, so each transition fired a full ICE restart. Plugin
  logs showed two restart offers within the same second, and in rarer cases
  three offers collided mid-renegotiation, tripping pion's
  `have-remote-offer->SetRemote(offer)` guard and forcing a full PC rebuild.

  Replace the leading-edge dedup with a trailing-edge debounce (1200ms window)
  that merges all events in the window and OR-aggregates `typeChanged` — any
  transition within the window promotes the final dispatch to
  `typeChanged=true`, preserving the consumer's "strong signal → full restart"
  decision even when the final network type equals the starting type. The
  per-event `typeChanged` computation in the listener is unchanged
  (incremental comparison against `_lastConnectionType`), so wifi→cellular→wifi
  remains correctly classified as a type change end-to-end. Window size chosen
  from observed samples where the two events were 500-900ms apart.

  Additional hardening from a deep-review pass: extracted the debounce
  state/helpers into a standalone `network-debounce.js` module (no Capacitor /
  Nuxt UI deps), so the logout cleanup chain in `auth.store` can cancel any
  in-flight debounce timer without pulling heavy imports into tests that touch
  auth. Without the cancel, a logout happening inside a 1.2s debounce window
  would let the pending event fire 1.2s later against the already-reset
  environment — low real-world impact but trivial to eliminate at the source.

## 0.17.1

### Patch Changes

- d11cc40: feat(rtc): expand ICE restart diagnostics on both UI and plugin

  Investigating a reproducible failure where a backgrounded APK (~20 min) comes
  back foreground, the plugin's pion reports `ice connection state: connected`
  for every ICE restart, but the UI's RTCPeerConnection never fires another
  `connectionState=connected` and eventually gives up, forcing a full PC rebuild.
  Existing logs could not distinguish between "ICE agent never left checking",
  "new pair nominated but DTLS transport did not migrate", and "WS/signaling
  lost an ICE candidate". This change adds a minimal, low-noise set of log
  anchors plus a bidirectional plugin-initiated probe so the next reproduction
  can be diagnosed without further instrumentation.

  UI (`ui/src/services/webrtc-connection.js`):

  - Wire the previously absent `iceconnectionstatechange`, `icegatheringstatechange`,
    `signalingstatechange`, and `icecandidateerror` handlers; each emits a single
    `remoteLog` line on state change. `iceconnectionstatechange` exposes the
    ICE-only `checking/connected/failed` transitions that `connectionState` hides.
  - Classify each local ICE candidate by `typ` (host / srflx / relay / prflx) and
    emit a `iceGathered host=N srflx=N relay=N prflx=N` summary when gathering
    completes. Counters reset at each `gathering` entry (including ICE restart).
  - `__attemptRestart` now logs a `restart.trigger reason=... connState=...
iceState=... sigState=... dc=[...] dcIdleAgo=... attempt=N` snapshot on the
    first entry of each restart epoch, making it possible to distinguish "we
    fired restart while UI still believed itself connected" from "UI already
    went to failed".
  - New `__dumpStats(reason)` helper walks `getStats()` and emits one line
    summarising the nominated candidate-pair (state / nominated / bytes /
    RTT / STUN req-resp counts), DTLS+ICE transport state and bytes, and
    rpc DataChannel stats (state / messages / buffered). Called at four
    points: before the first restart offer, 3s after a restart-answer is
    applied, on restart-timeout (awaited before close), and 2s after a
    `connectionState=connected` restart-success.
  - New `plugin-probe` frame type on the rpc DC: when the plugin sends one,
    the UI echoes `plugin-probe-ack` (bypassing the send queue, same as the
    existing UI→plugin `probe-ack` path) and logs the echo.

  Plugin (`plugins/openclaw/src/webrtc/webrtc-peer.js`):

  - Wire `oniceconnectionstatechange` on pion PCs (guarded by `in pc` so werift
    is unaffected); emit `rtc.iceState conn=X <state>` on each transition, and
    detach the handler in `closeByConnId` alongside the other listeners.
  - Log `rtc.restart-answer-sent conn=X` after a successful ICE restart answer
    is emitted, mirroring the existing `rtc.ice-restart` on the receive side.
  - On `pion` PC transition to `connected` when the previous dump state was
    `disconnected`/`failed` (i.e. an ICE restart just recovered): run one
    `rtc.dump state=connected` snapshot of the current session, then schedule
    a `plugin-probe` on the rpc DC with a 500 ms delay. The probe is bypasses
    the send queue, tracks a single in-flight id per session, and logs the
    RTT on `plugin-probe-ack`, a `timeout` line after 5 s unref'd, or a
    `send-failed` line if `dc.send` throws. `closeByConnId` clears the
    in-flight probe timer so a late timeout does not fire after session
    teardown. The probe bypasses the send queue, mirroring the existing
    `probe-ack` fast-path. The branch is gated on `impl === 'pion'` so
    werift/ndc compatibility paths are untouched.

  No existing recovery/retry/rebuild behaviour is changed; this commit is
  purely additive instrumentation plus the symmetric probe plumbing.

- 39a400e: fix(ui): keep uploaded files visible in FileManagerPage the moment transfer completes

  Multi-file upload briefly lost freshly-uploaded files from the listing
  right after each transfer finished. Cause: the "uploading" placeholder
  was removed the instant the task flipped to `done`, while the real entry
  only appeared after the next `loadDir` round-trip (driven by a 500 ms
  poll). The poll window + RPC latency produced a noticeable gap where
  the file existed on disk but showed up nowhere in the UI — worst on
  file #1, intermittent on later files depending on poll phase.

  Switch to optimistic insertion: `enqueueUploads` now takes an optional
  `onDone` callback, fired on successful upload; `FileManagerPage` injects
  the just-uploaded file into its `entries` array (and `dirCache`) in the
  same synchronous tick that drops the placeholder. No more poll timer,
  no more `loadDir` round-trip after each file. Manual refresh and
  directory navigation still re-reconcile against the server.

  `beforeUnmount` also unbinds the instance-scoped `onDone` from any
  still-running tasks so that an in-flight large upload does not keep the
  unmounted component alive.

- 6a2de9d: fix(rtc): detect ICE restart success via getStats ufrag comparison

  On APK network switches (e.g., WiFi↔cellular) the UI triggers an ICE
  restart while the old candidate pair is still healthy. The restart
  completes cleanly end-to-end (plugin's pion reports the new pair as
  connected, stats show the new `relay/udp>prflx/udp` pair nominated and
  succeeded, DataChannel keeps flowing), but the browser's
  `connectionState` never leaves `connected` throughout, so
  `onconnectionstatechange` is never fired and the UI stays stuck in
  `restarting`, sending periodic offers until the 90s timeout and finally
  falling back to a full PC rebuild. The MainList spinner stays on the
  whole time despite chat continuing to work.

  Add a parallel stats-poll detection path. At restart trigger we
  snapshot the current selected pair's local-candidate `usernameFragment`
  via `getStats()` (per ICE spec each restart mints a new ufrag). While
  in `restarting`, a 500 ms `getStats()` poll looks for a nominated
  succeeded candidate-pair whose local ufrag differs from the snapshot —
  that is exactly the same invariant the browser uses to keep
  `connectionState=connected`, just observed via polling instead of
  waiting for a state-change event that will never fire. On match we
  declare `ICE restart succeeded via=stats` and run the usual transitions
  (`__clearRestartState`, `__setState('connected')`, `__startKeepalive`,
  `__resolveCandidateType`, `stats.post-restart-success` after 2s). The
  existing event path is untouched (now logs `via=event` for
  disambiguation) and handles the "old pair already failed" scenario as
  before. If `getStats()` cannot produce a pre-restart ufrag we disable
  the stats path for that cycle (no comparison baseline → no false
  positives).

  Additional hardening from a second deep-review pass:

  - `__checkRestartViaStats` now captures `epochAtEntry` and rejects
    cross-epoch late ticks after the `getStats` await (symmetric with
    the snap.then epoch guard). Closes a narrow TOCTOU where the event
    path wins a restart and an immediate `triggerRestart` opens a new
    epoch while the previous tick's getStats is still in flight.
  - Multi-nominated-pair handling: the check now aggregates **all**
    nominated+succeeded pairs' local candidates and declares success if
    **any** local ufrag differs from the snapshot. The earlier
    "first-match" loop could stay pinned on the stale pair during the
    short migration window when the browser reports both old and new
    pair as nominated+succeeded simultaneously.
  - SDP-ufrag fallback for cross-browser compatibility: when
    `RTCIceCandidateStats.usernameFragment` is unavailable (some Safari
    and older Firefox builds), both snapshot and check now fall back to
    parsing `a=ice-ufrag:` from `pc.localDescription.sdp`, which the SDP
    spec mandates. Snapshot captures the SDP ufrag synchronously before
    the `getStats` await, so it reflects the pre-restart SDP regardless
    of when the stats resolve.

- 72dfb9e: fix(ui): align MainList Capacitor header action buttons with ChatPage

  MainList's Capacitor-only header (logo + refresh + "+") rendered its
  icon buttons with `size="xl"` and relied on the header-level `gap-2`
  for all siblings, producing 24 px icons and an 8 px gap between the
  refresh icon and the "+" button. ChatPage's mobile header renders
  refresh/new-topic via `MobilePageHeader`'s actions slot — default
  `md` size (20 px icons) packed tightly with no inner gap.

  Drop `size="xl"` from the three action buttons (RTC connecting
  spinner, RTC unreachable warning, add-claw plus) and wrap them in a
  no-gap `<div class="flex shrink-0 items-center">` inside the header.
  The outer header keeps its `gap-2` so logo/title/actions-group stay
  separated, while the three action buttons are now flush with each
  other and sized identically to ChatPage's refresh/new-topic icons.

## 0.17.0

### Minor Changes

- a1e1b64: admin Dashboard 在线实例数实时化 —— SSE 作为在线状态的唯一事实源，消除 Dashboard 页与 Claws 列表页之间的不一致。

  - **server（API 响应结构调整）**：`GET /api/v1/admin/dashboard` 响应移除两个字段：`claws.online`（聚合在线数）与 `latestBoundClaws[].online`（每条布尔）。在线状态改由 `GET /api/v1/admin/stream`（已具备 `requireAdmin` 校验）独立提供。`/api/v1/admin/claws` 列表的 online 字段保留以作为 HTTP 首屏填充。旧版 UI 客户端访问新 server 时，Dashboard 在线数大卡片会显示空白而非数字，但不会崩溃。
  - **ui**：SSE 订阅从页面组件上移到 Pinia `admin` store（引用计数），新增 `onlineClawIds: Set<string>`、`hasOnlineSnapshot`、`onlineClawCount`、`isClawOnline(id)`；连接生命周期由新建的 `AdminLayout` 父路由薄壳在 `/admin/*` 挂载/卸载时自动启停。Dashboard 大卡片在 SSE snapshot 到达前显示 `—` 占位符，snapshot 到达后切换为实时数字；Top 10 绿点改读 store 派生值。AdminClawsPage 不再直接订阅 SSE。
  - **ui（权限守卫加固）**：路由 `beforeEach` 新增 `requiresAdmin` meta 校验，非 admin 用户访问 `/admin/*` 直接重定向到 `/home`，避免 AdminLayout 挂载后对 `/admin/stream` 发起无授权的 EventSource 握手。
  - **ui（SSE 握手熔断）**：`admin-stream.js` 在从未 `onopen` 成功的情况下连续 3 次 `onerror` 则停止重连，避免非授权环境下的死循环。握手成功后错误不计入熔断计数。
  - 保活机制不变（server 30s heartbeat / client 65s timeout）。

- 782ebd0: ChatPage header 右侧新增刷新按钮（移动端 + 桌面端），点击静默重新拉取当前 session 的消息。

  作为 agent-run 结束判定残留边界的人工兜底入口：当信号丢失或 loadMessages 静默失败等少见场景导致 UI 消息暂时不一致时，用户可以通过该按钮主动恢复。

  按钮同步反映全局 load 状态——后台 `connReady` watcher / `runPromise.then` / foreground 恢复等任意路径触发的 loadMessages 都会让按钮显示 spinner + disabled，帮助用户感知"后台也在同步"，也便于反馈问题时描述状态。

  成功刷新顺带清 `errorText` 残留，让按钮也成为"初始加载失败 → 手动重试"的恢复入口。

- 1ef6782: 解除 SSE `claw.online` 与 WebRTC DC 生命周期的耦合。

  此前 SSE 推来 `claw.online=false` 时，UI 会同步清空 `dcReady`、将 `rtcPhase` 拍回 `idle` 并清掉退避重试，这让已排队的 RPC 无法触发重连、只能等 30s 超时，对应生产环境"agent 状态冻结、重发才恢复"的体感。

  按通信模型设计意图，plugin↔server WS 与 UI↔plugin WebRTC DC 是两条独立通路。本次改动把 `claw.online` 降格为展示层字段，DC 生命周期只由 PC 自身状态驱动：

  - `updateClawOnline(false)` 不再动 `dcReady` / `rtcPhase` / 退避 retry；改为轻触发 `__checkAndRecover(id, 'sse_offline')` 让 DC 自检——健在则 probe 通过无副作用，真坏则秒级拉起 ICE restart 或 rebuild（避免等浏览器 consent 超时 20–35s）
  - `__ensureRtc` 内层循环、`__scheduleRetry`、`__handleNetworkOnline`、`__fullInit` 以及 `applySnapshot` 末尾的 "failed 重试" gate 均去掉 `!online` 守卫
  - `applySnapshot` 的 `preserveOnline` 兜底删除——presence 单一来源，DC 状态独立驱动
  - `ChatPage.connReady` 去掉 `claw.online`，只看 `dcReady`
  - `__bridgeConn` 首次 init 入口的 `online` 判断保留（首次建连成本不低，用 presence 作启动先验合理），加注释区分"首次"和"持续维护"

  文档同步：`docs/architecture/communication-model.md` §5.5 新增"claw.online 与 DC 生命周期的解耦"章节，`docs/designs/ice-restart-recovery.md` §6.5 重写，`ui/docs/state-recovery.md` 与 `ui/docs/chat-state-architecture.md` 对齐。

- b51e3c0: Electron 壳子对齐 Capacitor 无感更新策略，撤掉无业务消费的 renderer 桥接：

  - `updater.js` 改 `autoDownload: true`：发现新版本立即下载、下次退出时自动安装，与 Capacitor `/version.json` 路径一致；不再要求 renderer 弹窗确认
  - `electron-app.js` 移除 5 个 `electron:update-*` / 2 个 `electron:download-*` / 1 个 `electron:screenshot-trigger` 事件桥接（src 全局无任何 `addEventListener` 消费点）
  - `main.js` 移除 `globalShortcut.register(Ctrl+Shift+A)`：项目无截图业务，避免按键无反应的假象（preload 的 `getScreenSources` / `onScreenshotTrigger` API 保留作为预埋）
  - `electron-app.js` 在 window-focus / window-blur 调 `remoteLog`，对齐 Capacitor `app.stateChange` 上报埋点

  preload 公共 API 保持不变（onUpdate* / onDownload* / onScreenshotTrigger 等仍可订阅，调用方按需），仅 renderer 端的桥接订阅简化为 3 个（deep-link / window-focus / window-blur）。

- ca30e1a: Electron 壳子功能补完（Batch C）：

  - 屏幕共享体验：`setDisplayMediaRequestHandler` 传 `{ useSystemPicker: true }`，macOS 12.3+ / Windows 11 24H2+ 走 OS 原生 picker，用户可选屏/窗口/画面，隐私和体验都优于之前的"强行取第一屏"
  - macOS Dock 徽章：`window:setOverlayIcon` / `window:clearOverlayIcon` 在 macOS 上转调 `app.setBadgeCount`（此前 macOS 分支是 silent no-op，导致 Web 端未读提示在 macOS 上完全不显示）
  - 自动更新开关：用户可通过 `store.set('auto_update_enabled', false)` 关闭后台自动检查；关闭后不启动定时器、不订阅 powerMonitor，但手动的"检查更新"IPC 仍可用。默认 true，维持原行为
  - 休眠恢复检查：订阅 `powerMonitor.on('resume', ...)`，系统睡眠恢复后立即触发一次更新检查，比 4h 周期更及时抓到发布
  - `disposeUpdater` 同步移除 powerMonitor 监听，避免极端场景句柄泄漏

- 35e7e5d: Electron 壳子 preload 重构（Batch D）：

  - 所有 `onXxx(cb)` 返回 unsubscribe 函数，renderer 可主动取消订阅；防止 HMR / 组件 unmount/remount 时监听器累积
  - `electron-app.js` 追踪每个订阅的 unsub，新增 `disposeElectronApp()` 一键清理；`initElectronApp` 重复调用时先 dispose 再订阅，HMR 不再累积
  - preload 导出对象改为 `Object.freeze(...)`，防御 preload 自身未来扩展误改已暴露 API；contextBridge 对 renderer 侧再次隔离
  - 命名一致性：`download:progress` / `download:done` 两个事件通道改为 `download-progress` / `download-done`，与其它主 → 渲染事件（deep-link、update-\*、window-focus、screenshot-trigger）统一连字符风格

  preload 公共 API（方法名、参数、行为）保持不变，仅 `onXxx` 多了一个可选的返回值；内部 IPC channel 重命名对 renderer 透明（all plumbing in preload/main）。

- ef7c499: Electron 壳子深度加固与预埋补完：

  - 自动更新链路闭环：preload 补 `downloadUpdate`/`quitAndInstall`/`checkForUpdatesNow`/`getPendingUpdate`；主进程 forward `update-download-progress`/`update-downloaded`/`update-not-available`/`update-error` 事件并缓存早期 pending payload；portable 模式自动跳过 autoUpdater
  - Windows 冷启动 Deep Link：扫描 `process.argv` 中的 `coclaw://` URL 并在 `did-finish-load` 后 flush 补发
  - 安全加固：`will-navigate` 改为严格 origin 匹配（修子域名前缀绕过）；permissions 同步/异步 handler 统一采用 URL hostname 严格比对 + permission 名白名单（对齐设计文档 §5.4）
  - 用户体验：窗口 `show:false` + `ready-to-show` 防远程加载首屏白闪；窗口 `blur`/`hide` 事件桥接为 `app:background`
  - 渲染端预埋：新增 `src/utils/electron-app.js`，订阅 deep-link→router.push、window-focus/blur→`app:foreground`/`app:background`、update 全流程 →`electron:update-*` CustomEvent
  - 发布源切换：`publish.provider` 从指向不一致仓库的 github 改为 generic，按平台分子目录（`https://im.coclaw.net/releases/win/`、`/releases/mac/`），规避 GitHub Releases 国内访问不稳定；`electron-builder.yml` 重命名为 `.yaml` 与项目内 `compose.yaml` 风格一致
  - 测试闭环：新增 `test:electron` 脚本接通 `vitest.electron.config.js`（原 `tray.test.js` 此前从未被执行）；补 `permissions.test.js`/`deep-link.test.js`/`updater.test.js`/`electron-app.test.js` 共 ~60 个测试

### Patch Changes

- 9ab1849: 修复 agent run watcher 重构的两处清理边界 bug（deep-review 发现）。

  1. `__cleanupRun` 在 `register` 清旧 run 和 `removeByClaw` 路径下不触发 `onEnd`，导致 `runAgent` 的 `finalPromise` 悬挂、外层 `sendMessage` Promise 泄漏。现在两条路径分别按 `superseded` / `claw-removed` 原因 endRun 后再清理。
  2. `dropRun(runKey)` 通过 runKey 反查 runId，若旧 run 在 `await loadMessages` 期间被用户新发消息覆盖同一 runKey，老挂钩会误清新 run 的 streamingMsgs。`dropRun` 新增可选 `expectedRunId` 参数，`chat.store` 的 `runPromise.then` 与 24h 内存兜底均传入闭包 runId 校验。

- 7a783f9: 修复 agent run 卡"思考中"的高发 bug（约 30% 概率），同时让 gateway 重启场景能在数秒内被识别。

  把 agent run 的发起和生命周期管理收敛到 `agentRunsStore.runAgent`，引入 watcher 协调四路结束信号：

  - agent RPC 第二阶段 res（终态权威信号，原代码完全忽略）
  - `lifecycle:end` 事件
  - 事件流静默 30 秒后启动的长挂 `agent.wait` 兜底
  - 任何 RPC 错误 / DC 失败（异常结束，覆盖 gateway 重启场景）

  任一信号命中即触发 endRun，UI 立即退出"思考中"状态；之后由 `loadMessages` 拉服务端真实状态再 `dropRun` 释放 streamingMsgs（避免消息列表瞬间空白）。

- 7374a56: Bump `BRIEF_DISCONNECT_MS` from 5s to 30s to suppress refresh after short network jitter.

  `__refreshIfStale` 在 RTC DC 重建成功后按断连时长决定是否拉取 agents/sessions/topics/dashboard。原 5s 门槛过短，10s 量级的网络抖动也会触发全量刷新。

  抬到 30s 不会影响长后台恢复场景：`disconnectedAt` 是在 PC 进入 `restarting`/`failed`/`closed` 时打点，不是用户切回前台时打点；长后台时 PC 通常在切到后台不久就失败，gap 累计到回前台时远超 30s。中等时长断连（25–60s）数据漂移很小，跳过刷新可接受，下一轮真断连或手动刷新会兜底。

- cadb403: 修复 pre-accept 窗口点取消的"假取消"bug。

  之前在 chat/topic 发消息后、服务端回 accepted 之前点 STOP：本地气泡瞬间消失看起来取消成功，但服务端的 agent run 实际会跑到底（onAccepted 仍到达 → `register` → 流式输出继续到自然结束）。

  改为：pre-accept 点 STOP 时挂起 `__pendingCancelIntent` 标记——不清乐观气泡、不 reject sendMessage，让 STOP 按钮转"取消中"禁用态；等 `onAccepted` 到达后在 sendMessage 的 onAccepted 回调末尾立刻转交 accepted 分支，由已有的 `coclaw.agent.abort` 轮询协调真正终止 run。`isCancelling` getter 把挂意图纳入，UI 绑定无需改动。

  上传阶段取消走原路径不变（中断 upload handle + sendMessage CANCELLED catch 分支清理）。cleanup / superseded / catch 均同步清意图避免残留。

- ff3b1db: claws 页面的 WebRTC 连接状态 label 重构：文案头部统一加 `WebRTC:` 前缀，中段文案与 `rtcPhase` 精确一一对应。

  - 原实现把 `building / recovering / idle` 混显示为"连接中…"，把 `restarting` 与 `ready` 混显示为同一套传输详情；现按阶段分别呈现 `空闲 / 连接中 / 恢复中 / ICE 重启中 / P2P|LAN|中继 / 连接失败…` 共 6 档语义明确的文案。
  - label 与 `claw.online` 解耦：依据通信模型，claw 在线与否由 server 反馈，与 WebRTC 连接状态是两条独立路径；label 现只反映 `rtcPhase` / `rtcTransportInfo`，不再受 online 门控。离线但有 RTC 历史的 claw 仍能查看 WebRTC 状态与详情。
  - 新增/修改 i18n key：`rtcIdle / rtcBuilding / rtcRecovering / rtcRestarting`（新增），`rtcLan{Proto} / rtcP2P{Proto} / rtcRelay{Proto} / rtcRetrying / rtcRetryExhausted`（前缀改为 `WebRTC:`），删除不再使用的 `disconnected / rtcConnecting`。12 个语言包全部同步。
  - 状态圆点颜色逻辑保持不变。

- c84527a: 修复文件名含半角括号时 `coclaw-file:` 链接被截断导致下载失败的 bug。

  原因：`preprocessCoclawFileLinks` 与 `extractCoclawFileRefs` 的正则用 `[^)]+` 截取 URL，碰到文件名里的 `)` 就提前收尾，下载请求带着被截断的路径自然失败。

  修复：

  - Agent 提示词改为 `[文件名](<coclaw-file:文件路径>)` 形式（CommonMark 尖括号包裹），并明确声明"URL 必须用尖括号 < > 包裹"的硬约束
  - 两处解析逻辑统一合并为 `coclaw-file.js` 的 `findCoclawMarkdownLinks` 工具函数，同时支持尖括号形式与裸形式
  - **裸形式容错**：裸形式用字符扫描器追踪括号深度，支持平衡括号的路径（如 `a(2020)_(7).xlsx`）；不平衡开括号扫描到末尾自然失败，不影响其它链接。该容错层是防御性设计——提示词已要求 agent 用尖括号，但老消息回放或 agent 偶发不遵循时仍能正确解析
  - **跨行保护**：扫描遇 `\n`/`\r`/空白/`<>` 立即停止，避免一条坏链接吞掉后续多行合法内容
  - 尖括号形式同样在 `\r`/`\n` 处终止，避免 CR 字符注入 URL

- 7d2076a: Electron 壳子实施后的文档对齐 + 修 macOS 摄像头权限文案：

  - 设计文档 `docs/designs/electron-desktop-shell.md`：builder 配置样本、构建命令、自动更新流程、package.json 样本同步为实施态（ESM 主进程 + electron-store@11、generic publish 指向 im.coclaw.net/releases/、preload.cjs、electron-builder.yaml 重命名、Phase 1 仅 DMG 声明）
  - 根 `docs/versioning.md` 增 "Electron 壳子版本独立维护" 一节
  - `ui/CLAUDE.md` 增 "Electron 桌面壳子开发" 小节（`electron:dev` / 构建命令 / WSL2 Wine 依赖 / 测试命令）
  - `electron-builder.yaml` 的 `NSCameraUsageDescription` 改为 "CoClaw 需要使用摄像头拍摄图片用于对话"（去除不存在的视频通话描述，避免 App Store 审核被追问）

- ab00e89: Electron 把 `icon.ico` / `icon.icns` 加进 asar 包：

  `electron-builder.yaml` 的 `files` 白名单原本只包含 `icon.png` 和 `tray-icon*.png`，导致 `BrowserWindow.icon` 在 Windows 运行时按 `path.join(__dirname, '../build-resources/icon.ico')` 读到空 nativeImage（窗口栏 fallback 到 .exe 默认图标）。

  现把三种格式都显式列入 files，让 BrowserWindow.icon 在所有平台都能命中正确资源。

- 00fe79c: Electron 壳子小修（Batch F）：

  - `ipc-handlers.js` 加注册幂等守卫：重复调用 `registerIpcHandlers` 直接跳过，防御两类问题：(1) `ipcMain.handle` 对同一 channel 重复注册会抛错；(2) `session.on('will-download', ...)` 累积监听会导致每次下载重复发送 `download:progress` / `download:done` 事件
  - `main.js` 的 `console.warn`（截图快捷键注册失败分支）替换为 `electron-log` 的 `log.warn`，确保生产环境日志能落盘被 `electron-log` 统一收集

- 5d0fc0b: Electron IPC handler 错误处理对称：

  - `ipc-handlers.js` 抽出 `safeHandle(channel, fn)` 包装 `ipcMain.handle`，所有 handler 抛错时写 `electron-log` 后重抛（renderer 仍能感知失败，主进程多一份排查日志）。受益最大的是 `screenshot:getSources`（macOS 无屏幕录制权限时会抛）、`clipboard:writeImage`、`store:get/set` 等
  - `tray.js` 的 `disposeTray()` 加 `ipcMain.removeAllListeners('tray:setTooltip' / 'tray:setUnread')`，对称 `initTray` 中的 `ipcMain.on` 注册，避免测试场景重复注册或生产端口残留监听

  测试同步：ipc-handlers 加 3 个 safeHandle 错误路径用例；tray 在 disposeTray 用例验证 removeAllListeners 调用。

- 6abb3a4: Electron 壳子生命周期与窗口管理加固（Batch B）：

  - 托盘：`attachMainWindow(app, win)` 替代之前全量监听 `browser-window-created`，避免将来截图/模态子窗口被误绑 close→hide
  - 生命周期清理：新增 `disposeTray()` / `disposeUpdater()`，`will-quit` 统一调用，释放闪动 timer、托盘实例、自动更新的 30s + 4h 两个 timer 句柄
  - 主窗口图标：Windows 改用 `icon.ico`（多分辨率、200% DPI 不糊），其它平台继续 `icon.png`
  - 打包白名单：`electron-builder.yaml` 的 `files` 显式加入 `build-resources/icon.png`，非 Windows 平台 `BrowserWindow.icon` 不再指向打包外文件
  - 跨平台守卫：`app.on('activate')` 加 `process.platform !== 'darwin'` 早 return（其它平台不会触发，显式守卫提高可读性）
  - 本地化兜底：`tray:setTooltip` IPC 收到空文本时用 `getAppTitle()`（中文系统 "可虾"，英文系统 "CoClaw"），原先硬编码 "CoClaw"

- 130b896: Electron 壳子第三轮 deep-review 回归修复：

  - `updater.js` `autoDownload` 跟随 `auto_update_enabled` 开关：关闭自动更新时即便 renderer 主动调 `updater:checkForUpdates`，也不会意外触发静默下载
  - `main.js` 新增 `will-redirect` 对称拦截：与 `will-navigate` 共享 guard，防 3xx 重定向绕过 URL 白名单
  - `tray.js` `tray:setTooltip` 处理器加 `tray.isDestroyed()` 守卫：对齐 `tray:setUnread` 路径，规避 disposeTray 进程中的竞态
  - 测试稳健性：updater.test `autoDownload` 在 resetMocks 中复位；tray.test `disposeTray` 断言改为无序比较；ipc-handlers.test 在 `beforeEach` 清 `logMock.error`；url-guard.test 补 `allowDev=false` 显式语义 + `allowDev=true + 无效 URL` 边界
  - 文档同步：`docs/designs/electron-desktop-shell.md` 头部标"已实施，以代码为准"；修正 autoDownload / URL 白名单 / files 声明 / isNative 迁移 4 处过时示例

- 4c37bfc: Electron 托盘图标补 `@2x` 高分辨率版本：

  - 新增 `build-resources/tray-icon@2x.png` 和 `tray-icon-unread@2x.png`（64×64），由 `build-resources/icon.png`（512×512 产品 logo）下采样生成，红点参数与现有 32×32 版本对齐（RGB 255,59,48；中心 (52,12)；半径 11）
  - Electron 的 `nativeImage.createFromPath` 会按当前 DPI 自动选取 `@2x`——Windows 200% DPI、macOS Retina 下不再因强行放大 32×32 而糊
  - `electron-builder.yaml` 的 `files` glob `build-resources/tray-icon*.png` 已覆盖新文件，无需改配置
  - 无代码变更、无测试变更，仅资产追加

- e80e609: Electron URL 白名单生产模式收紧：

  `url-guard.js` 原本静态把 `localhost:5173` 加入 `TRUSTED_ORIGINS`，生产包亦然。攻击面虽小（要本地 5173 端口被恶意进程占用 + 用户被诱导点链接），但纵深防御角度应区分。

  API 调整：`isTrustedUrl(urlStr, { allowDev })` —— 默认仅信任远程业务域；`main.js` 在开发模式下传 `allowDev: isDev` 才放行 `localhost:5173`。

  测试同步补 4 个 allowDev=true 用例。

- b1c4233: Drop the "no messages" placeholder from the chat screen.

  Both new topics and freshly-loaded chats show a blank area above the composer, which is already a clearer "start typing here" cue than a system-style empty-state line. Removed the i18n key across all locales to keep strings honest.

- f1909f2: Add `credRemain` field to all ICE restart remoteLog lines on the UI side.

  `credRemain` reports the seconds remaining until the embedded TURN credential expires (negative when already expired, `none` when no creds or unparseable). Helps diagnose whether ICE restart failures correlate with stale credentials (PC lifetime > 24h cred TTL window). Pure telemetry — no behavior change. UI caches the parsed expiry on `__credExpireAt` at `__buildPeerConnection` time.

- 5a8cd53: Fix: per-claw 化 RTC 重连恢复 / 首次 init 的数据加载路径，消除多 claw 错峰恢复时的 RPC 风暴。

  `__refreshIfStale(id)` 与 `__fullInit(id)` 之前通过 `loadAllSessions()` / `loadAllTopics()` 横扫所有已连接 claw，单 claw 触发却拉所有 claw 的 sessions 与 topics。3 个 claw（每个 2 agent）错峰恢复时单轮可达 36 个 RPC，与用户反馈的"数据风暴"现象吻合。

  改为新增 `loadSessionsForClaw(id)` / `loadTopicsForClaw(id)` per-claw 加载方法（带 in-flight Map 合流），refresh / init 路径只刷当前 claw 的数据。3 claw 错峰恢复 RPC 数从 36 → 12，单 claw 恢复从 12 → 4。

  `loadAllSessions()` / `loadAllTopics()` 全量接口保留，仍用于 MainList 列表渲染等真正需要全量的场景。

- f899f65: 冷启动路由恢复扩展到 Electron：

  `router/index.js` 的 `app:background` 保存路由 + 启动时从 localStorage 恢复路由的逻辑此前用 `isNative`（仅 Capacitor）门控；改为 `isNativeShell`（Capacitor + Electron + 预留 Tauri）。

  效果：用户从托盘 Quit 或 `Cmd+Q` 退出 Electron 后再次启动，会自动回到上次访问的页面，与移动端体验一致。

- d3d3895: fix(ui): gate signaling WS and claw-status SSE by login state to stop connections when logged out.

  Previously `AuthedLayout` started the signaling WS and the claw-status SSE unconditionally on mount. Combined with the `/about` route being nested under `AuthedLayout` (while marked `requiresAuth: false`), this caused two issues:

  - Unauthenticated users visiting `/about` directly would immediately open a WS + SSE to the server.
  - After logout, the app navigates to `/about`; since `AuthedLayout` stays mounted, the SSE never stopped and kept pushing snapshots that in turn re-triggered `claws.store` side effects.

  `AuthedLayout.setup` now drives both connections from `authStore.user?.id`: connect + start when a user id is present, disconnect + stop when it becomes null. `useClawStatusSse` gained an `{ autoStart: false }` option and its `stop()` is no longer a one-shot lock — the composable can be re-`start()`ed across login/logout cycles. Window listeners (`app:foreground`, `network:online`) move in and out of scope with `start`/`stop` so post-stop events can no longer resurrect the SSE.

  As a related cleanup, `auth.store.logout()` now clears the `remote-log` buffer (new exported `clearRemoteLogBuffer`) so unsent diagnostics from the previous user are not flushed onto the next user's signaling WS after re-login — previously this was a latent issue covered by a TODO; the new login/logout flow makes the reconnect path reliably trigger flush, so the fix is needed here.

- 7c38ed6: fix(ui): clear event listeners on ClawConnection.disconnect

  Chat store registers an `event:chat` handler on the per-claw ClawConnection.
  At logout, chat-store's cleanup path tries to `conn.off(...)` but the
  connection manager has already removed the conn, so `__getConnection()`
  returns null and the off path is skipped. The handler closure stays on
  `ClawConnection.__listeners`, pinning the chat store proxy (and its
  streaming buffers) until the ClawConnection itself is GC'd.

  Currently this still releases because disconnected ClawConnections have
  no other strong references, but the release is indirect and will break
  if someone later adds a self-referencing timer to ClawConnection.
  Clearing the listener map in `disconnect()` is a one-line defensive fix
  that makes the intent explicit and does not rely on GC timing.

- 48aae20: fix(ui): rebind claws-store window lifecycle listeners after logout+relogin

  `__bridgeLifecycle` guarded against duplicate registration with a
  `this.__lifecycleBridged` flag set on the Pinia store **instance** — not
  declared in `state()`. On logout, `__resetClawStoreInternals()` correctly
  removed the `app:background` / `app:foreground` / `network:online` window
  listeners, but `claws.$reset()` only restores declared state and left the
  instance flag set to `true`. On re-login in the same tab/app, `__bridgeConn`
  called `__bridgeLifecycle()`, the flag short-circuited, and listeners were
  never re-attached — silently breaking mobile RTC auto-recovery after
  background/foreground and Wi-Fi↔cellular transitions until a full page
  reload.

  Lift the flag to a module-level `_lifecycleBridged` variable next to
  `_lifecycleHandlers`, and reset both in the same logout cleanup helper.
  Add a regression test that logs out and re-bridges on the same store
  instance, asserting `app:foreground` probes fire in both cycles.

- d060718: fix(ui): complete logout state cleanup for agent runs, chat stores, dashboard, file transfers, admin SSE, and 401 throttle

  Previously logout left behind: per-run 24h timers and stream buffers (agent-runs),
  cached chat/topic store instances with their event handlers (chat-store-manager),
  per-claw dashboard data (dashboard), file transfer tasks with running async loops
  (files), admin SSE `EventSource` + its `app:foreground`/`network:online` listeners
  (admin store `$reset()` nulled the handle without calling `close()`), and the
  module-level 3s `auth:session-expired` throttle timestamp in `http.js` which
  could swallow the next user's first legitimate 401.

  Adds `agentRunsStore.resetAll()`, `chatStoreManager.disposeAll()`,
  `filesStore.cancelAll()`, `adminStore.teardownStream()` (forced close,
  independent of the refcounted `stopStream`), and `resetAuthExpiredThrottle()`
  in `http.js`. Wires them plus `dashboardStore.$reset()` into the logout
  cleanup chain. Order matters: files cancel runs before disconnecting
  the data channel so transfer-abort frames can be flushed; admin SSE teardown
  runs before `admin.$reset()` so the `EventSource` and its window listeners
  are actually released rather than orphaned.

- a14fae5: fix(ui): guard auth actions against user-data writes that await across a logout

  Follow-up to the `__logoutInflight` lock: the entry guard only prevents an action
  from starting while a logout is already in flight. It does not cover the window
  where an action has already passed the entry check and is awaiting its API
  response when a logout starts and completes.

  Concrete scenario: `visibilitychange` fires `refreshSession()` → checks
  `__logoutInflight` (null), calls `fetchSessionUser()` and awaits. The user
  then clicks Logout; the full logout cleanup runs and `__logoutInflight` returns
  to null. When `fetchSessionUser` finally resolves, `this.user = data` revives the
  just-cleared user — the AuthedLayout watch re-fires, WS/SSE reconnect, Pinia
  state is half-reset, half-populated. The same shape affects `login`,
  `register`, `updateProfile`, `updateSettings` (the latter two previously merged
  the response into `this.user = null`, reviving it as a partial object).

  Fix: add a module-level `__logoutEpoch` counter, bumped synchronously at the
  start of every `logout()` IIFE. Each of the five actions captures the epoch
  before its first `await`; after the await, if the epoch has changed, the
  action drops its result (both the success-path write and the catch-path
  `errorMessage`) without touching store state. This complements, not replaces,
  the existing entry guard.

- 5207fec: fix(ui): harden logout against active-state leaks and single-step cleanup failures

  Second pass on logout state cleanup — covering the "user logs out while something is active" scenarios that the previous static-resource pass did not address.

  - `auth.store.logout()`: the 13-step cleanup chain had no error isolation — any single step throwing (e.g. Capacitor permission edge case, polyfill oddity, third-party blob URL) would skip every subsequent step and leak WebRTC PCs, WS, SSE, timers, and blob URLs across users. Each step is now wrapped in a `safeRun(label, fn)` helper; failures degrade to a debug log and the chain keeps going.
  - `webrtc-connection.js`: expose `closeAllRtcInstances()` (production name for the previously test-only `__resetRtcInstances`) and call it from logout. `clawConnection.disconnect()` only handles already-`setRtc`'d rtc instances, so an RTC whose init was still in progress (`clawConn.__rtc === null`) was orphaned in the module-level `rtcInstances` Map. A same-`clawId` re-login within the 15s fallback-timer window would reuse the old rtc Promise whose `onReady` closure points at the previous user's `clawConn`. `initRtc`'s `onStateChange` also now treats `'closed'` identically to `'failed'` so the in-closure `fallbackTimer` is cleared on external close — otherwise the stale 15s timer would fire after `closeAllRtcInstances` and call `rtcInstances.delete(clawId)` on the next user's fresh entry.
  - `chatStoreManager.disposeAll`, `agentRunsStore.resetAll`, `clawConnectionManager.disconnectAll`: each now wraps the per-item cleanup call in a try/catch so a single failure does not halt the loop and leak the remaining items' timers / DC / blob URLs. `disconnectAll` additionally calls `__connections.clear()` at the end so an exception-skipped entry cannot be reused across users.
  - `signaling-connection.js`: `disconnect()` now clears `__connIds` and `__connIdToClawId` maps. Normally each `clawConn.disconnect()` releases its own connId, but the new per-item try/catch above could swallow a failure and leave stale mappings on the singleton; the explicit clear guarantees fresh connIds for the next user.
  - `chat.store.cleanup`: if cleanup runs while a slash command is still in flight (dispose path — events already missed, timer no longer relevant), actively settle `__slashCommandResolve` before nulling it instead of leaving the caller's await permanently pending.

  Ordering-wise, `closeAllRtcInstances` is inserted between `disconnectAll` and `signaling.disconnect` so the existing dependency chain (`files.cancelAll` → `disconnectAll` → `signaling.disconnect`) is preserved and `rtc:closed` signaling frames can still reach the gateway.

- ffd81f8: fix(ui): make logout idempotent and serialize auth actions against it

  Third pass on logout. Two related gaps:

  1. **401-during-logout double-cleanup.** When the POST `/logout` API itself returns 401 (common when the session has already expired), `http.js` synchronously dispatches `auth:session-expired`. `AuthedLayout.__onSessionExpired` saw `authStore.user` still populated (the first `logout()` had not yet written `user = null`) and called `authStore.logout()` a second time. Two cleanup chains then ran in parallel — `$reset`, `disconnectAll`, timer clears all invoked twice, and two competing `router.replace` calls landed on different targets.
  2. **No guarantee that a new login starts in a clean environment.** While existing call sites all `await authStore.logout()` before navigating, the invariant was not enforced at the store level. Any future trigger that forgot to `await` would race resource cleanup against a concurrent login.

  Fix: add a module-level `__logoutInflight` Promise lock in `auth.store.js`.

  - `logout()` is now idempotent: reentrant calls return the same in-flight Promise; the API call, the 20-step cleanup chain, and `router.replace` side-effects each run exactly once. The cleanup body is now an IIFE inside the `logout` action (not a separate `__doLogout` action), so external callers cannot bypass the lock; the IIFE has a dedicated `try/finally` around `this.loading` so UI loading state cannot get stuck even if a cleanup step throws a way `safeRun` does not catch.
  - `login()`, `register()`, `refreshSession()` each `await __logoutInflight` at their start (when non-null). New authentication requests never see residual WebRTC PCs, signaling WS, SSE handles, timers, or store state from the departing user.
  - `updateProfile()`, `updateSettings()`, `changePassword()` return early with an `errorMessage` set when a logout is in flight. Previously, a server response arriving during logout would re-merge into `this.user = null` and revive it as a partial object — e.g. `UserProfilePanel` would then show a "Name updated" success toast even though the API call never happened. Setting `errorMessage` pushes those UI paths into the error branch instead.
  - `AuthedLayout.__onSessionExpired` now checks `isLogoutInflight()` at entry and bails. When the current user is already running a logout flow (e.g. user-clicked logout whose API itself 401s), this stops the handler from kicking off a second cleanup and a conflicting `router.replace('/login')`.
  - Export `isLogoutInflight()` for callers that want a read-only check without touching the Promise, and `__resetAuthInternals()` for test cleanup.

  The lock is deliberately module-level (not Pinia state) so Promises stay non-reactive.

- 1aba02d: 修复 WebRtcConnection 失败路径的 PC 资源泄漏：4 处 `__setState('failed')` 入口（DC 在 restart 中关闭、ICE restart 超时、createOffer 抛异常、`rtc:restart-rejected`）原本只改状态字段，不释放底层 `RTCPeerConnection` 也不通知 plugin，需要等 3~120 秒的退避重试才延迟清理；5 轮退避耗尽后更会永久悬挂。

  改造：`close()` 方法新增 `{ asFailed }` 参数复用统一清理逻辑，4 处失败入口立即释放 native PC、清理定时器/监听器、并向 plugin 发 `rtc:closed` 信令。同时修复 `initRtc` 的 `state === 'failed'` 分支漏清 `rtcInstances` Map 的问题。

- 473c663: claws 页面 WebRTC 连接状态文案：zh-CN / zh-TW / ja 三个 CJK 语种把 `WebRTC:` 后的半角冒号改为全角 `WebRTC：`（无后空格），与同文件内已有的 `插件：` / `OpenClaw：` 排版风格保持一致；其他语种按各自主流排版保持原样（en/es/pt/de/hi/vi/ru/ko 半角 `: `，fr 法式 `:`）。

## 0.16.0

### Minor Changes

- bea05ad: claws 页面中继连接展示两段链路协议（浏览器 ↔coturn↔plugin），避免仅显示浏览器侧协议导致的误导。

  - Plugin（`@coclaw/openclaw-coclaw`）：pion 路径下新增 `coclaw.rtc.peerTransport` DC 事件单播。rpc DC 建立时和 ICE 选中 pair 变化时，把本端 candidate 的 `{ candidateType, protocol, relayProtocol }` 推送给对应 UI；签名去重避免重复发送，`queueMicrotask` 避让竞态，`sendTo` 失败回滚签名允许后续重试。顺手增强 `__logNominatedPair` 远程日志，带出 protocol 和 relayProtocol。werift 路径保持不变（其 candidate 对象无 relayProtocol，UI 自动走降级兜底）。
  - UI（`@coclaw/ui`）：`claws.store` 监听新事件更新 `claw.rtcPeerTransportInfo`（与 `rtcTransportInfo` 字段解耦，避免被浏览器 getStats 轮询整体覆盖）；`failed/closed` 时清空。`ManageClawsPage.connLabel` 在 relay 分支合并双端信息：两端协议相同时简化为 `中继·UDP`，不同时展示 `UDP ↔ 中继 ↔ TCP`；详情面板新增"对端候选/对端中继协议"一行。新增 i18n keys `rtcRelayBothSides` / `peerCandidate` / `peerRelayProtocol`，12 语言全同步。
  - 兼容性：依赖 `@coclaw/pion-node` 0.1.3+（新增 `relayProtocol` 字段透传）。老 plugin / 老 pion-ipc 二进制下事件不发，UI 自动回退老文案，不报错。

## 0.15.0

### Minor Changes

- 64f17a8: ui: admin 基础设施 + 仪表盘改造（实例维度 + 导航 tab）

  - 仪表盘顶部三卡片改为实例维度（总数/在线/今日新增），用户卡片降级到次级位置
  - 新增三条摘要列表（最近绑定实例 / 最近活跃用户 / 最新注册用户），每条带"查看全部 →"链接
  - 新增 `admin.store.js`（dashboard/claws/users 三块 state + 全部 actions 含 SSE 事件应用）
  - 新增 `admin-stream.js` SSE 客户端（心跳超时自动重连，响应 app:foreground / network:online）
  - `admin.api.js` 新增 `fetchAdminClaws` / `fetchAdminUsers` / `adminStreamUrl`
  - 新增桌面端 `AdminNavTabs` 组件（仪表盘 / 实例管理 / 用户管理）
  - 新增 `/admin/claws` 和 `/admin/users` 路由（含 placeholder 页面，S5/S6 填充）
  - i18n 从 `adminDashboard.*` 整体迁移到 `admin.{nav,common,dashboard,claws,users}.*`，12 语言同步（保留 `user.adminDashboard` 菜单入口 key）

- 9f0f380: ui: admin 实例管理页 AdminClawsPage

  - 新建 `AdminClawsPage.vue`：UTable 展示实例列表（name/online/user/pluginVersion/createdAt），`#expanded` 槽显示 agent × model 明细（null → 「信息暂不可用」；[] → 「无 Agent」）
  - 顶部搜索框按名称过滤，300ms 去抖；输入变化时 `resetClaws()` 并重新拉取
  - 底部「加载更多」按钮（cursor 分页），仅在存在 `nextCursor` 时渲染
  - mount 时连接 admin SSE，`snapshot` / `claw.statusChanged` / `claw.infoUpdated` 分别映射到 store 的 `applyOnlineSnapshot` / `updateClawStatus` / `updateClawInfo`；`beforeUnmount` 关闭连接
  - 移动端降级为卡片列表，点击卡片切换展开状态显示 agent 明细
  - i18n 新增 `admin.claws.{searchPlaceholder,columnName,columnStatus,columnUser,columnVersion,columnCreatedAt,expandAgentName,expandModel,noAgentModels,emptyAgents}`，12 语言同步

- 943bf24: ui: admin 用户管理页 AdminUsersPage

  - 新建 `AdminUsersPage.vue`（替换原占位实现）：UTable 展示用户列表（name/loginName/clawCount/createdAt/lastLoginAt）
  - 顶部搜索框按用户名或登录名过滤，300ms 去抖；输入变化时 `resetUsers()` 并重新拉取
  - 底部「加载更多」按钮（cursor 分页），仅在存在 `nextCursor` 时渲染
  - 移动端降级为卡片列表，展示用户名、@登录名、绑定实例数、注册时间、最近登录
  - i18n 新增 `admin.users.{searchPlaceholder,columnName,columnLoginName,columnClawCount,columnCreatedAt,columnLastLogin}`，12 语言同步
  - 清理 `admin.common.comingSoon`：仅原占位页引用，AdminUsersPage 完全落地后该 key 成孤儿

### Patch Changes

- c91a917: server/ui: `coclaw.info.updated` 改为 patch 语义，修复改名时清空 pluginVersion/agentModels

  **问题**：plugin 的 `coclaw.info.patch` handler 仅广播 `{ name, hostName }`（按其 patch 命名所暗示）；但 server `applyClawInfoUpdate` 此前按"missing-as-null"当全量处理，导致用户每次从 UI 改名 → DB 清空 pluginVersion + agentModels → admin 仪表盘该 claw 行立即显示 "—" / "信息暂不可用"，直到 bridge 重连才恢复。

  **修复**（方向：按事件命名的 patch 语义，修 server 而不是让 plugin 被迫发全量）：

  - `server/src/claw-ws-hub.js` `applyClawInfoUpdate`：用 `Object.hasOwn(payload, key)` 逐字段判定，仅更新 payload 中实际出现的列；缺失字段保留 DB 原值。name 列的 hostName 回退仅当 payload 同时含 hostName 时应用（与 plugin 两个触发源的实际形态吻合）。
  - `server/src/claw-status-sse.js` `handleInfoUpdatedEvent`：patch 不含 name 字段时直接返回，不下发冗余的 user-facing `claw.nameUpdated`/`bot.nameUpdated` 事件。
  - `server/src/admin-sse.js` `handleInfoUpdatedEvent`：按 payload 实际含有的字段透传，wire 不再携带未变更字段。
  - `ui/src/services/admin-stream.js`：去掉 `?? null` 的字段补齐，保留 patch 中字段的存在/缺失语义，交由 `admin.store.updateClawInfo` 的 "skip undefined" 逻辑只覆盖本次实际变更字段。
  - `ui/src/views/AdminClawsPage.vue`：onInfoUpdated 回调从解构重组改为 `({ clawId, ...patch })`，避免 undefined 字段污染 patch。

  不向 plugin 施加"必须发全量"的约束；`__pushInstanceInfo()`（bridge connect 时的全量上报）和 `coclaw.info.patch` handler（仅发变更字段）两种形态在 patch 语义下都正确工作。

- 92aa515: ui: 修复 admin 页面 review 发现的两处数据一致性问题

  - `AdminClawsPage` / `AdminUsersPage`：重入页面时从 `adminStore.claws.search` / `adminStore.users.search` 回显 searchInput，避免"输入框空 / 列表仍按旧 search 过滤"的不同步状态
  - `auth.store.logout()`：末尾补 `useAdminStore().$reset()`，防止上一位管理员的 dashboard / claws / users 聚合数据和搜索词残留到下一位登录的管理员会话

- 1ec7337: ui: admin 页面 review 微调（术语 / 视觉 / 交互）

  **i18n（12 个 locale）**：

  - `admin.nav.claws` / `admin.dashboard.totalClaws` / `admin.users.columnClawCount` / `admin.claws.columnName`：统一品牌化为 **Claws / Claw**（不再按各自语言翻译成"实例/Instance/インスタンス/…"）
  - `admin.claws.title` / `admin.dashboard.sectionLatestClaws`：句中 Instance/实例 → Claws
  - `admin.nav.dashboard`：本地化的"概览 / Overview / Übersicht / …"（原"工作台 / Dashboard"）
  - `admin.dashboard.title` / `admin.users.title`：保留原文（仍为"管理工作台 / Admin Console / 用户管理 / User Management"等），供 MobilePageHeader 和稳定桌面 h1 使用

  **AdminDashboardPage**：

  - 移动 header `#actions` 新增 Claws / Users 图标导航按钮（`i-lucide-server` / `i-lucide-users`），仅总览页提供子页跳转入口，避免子页间乱跳
  - 5 个卡片 `p-4 → p-3`，与移动优先间距一致
  - 次级三卡片 `bg-elevated/60 → bg-elevated`，与主卡片背景统一

  **AdminClawsPage**：

  - 桌面 h1 改用 `admin.dashboard.title`，页面切换由右侧 nav tabs 高亮指示（不随页面变化抖动）
  - 表格 `<md → <lg` 断点，让列宽更舒展
  - UTable 通过 `:ui` 收紧 `th/td` padding 到 `p-2`，行加 `data-[selectable=true]:cursor-pointer`
  - `:on-select="onRowSelect"` 让整行可点击展开（配合鼠标指针提示可点击）
  - name-cell 的 `<button>` 降级为 `<span>`，避免嵌套交互元素；展开行 `<div>` 去掉多余 `py-2`
  - `data().searchInput` 从 `adminStore.claws.search` 取 snapshot，替换原 mounted 里的 carriedSearch 赋值 + `clearTimeout` 兜底 dance，不再依赖 Vue watcher flush 时序

  **AdminUsersPage**：

  - 桌面 h1 改用 `admin.dashboard.title`（同 Claws 页）
  - UTable `:ui="{ th: 'p-2', td: 'p-2' }"`
  - `data().searchInput` 同样改为 store snapshot 初始化

  **搜索框（两页共享）**：

  - `size="md" → size="lg"` 更贴合移动优先触控目标
  - `:ui="{ base: 'leading-normal' }"` 覆盖 Nuxt UI `text-base/5` 硬编码的 20px 行高，恢复 Tailwind 默认 1.5（24px），中英文混排不再挤

## 0.14.0

### Minor Changes

- 17cc790: feat(ui): 取消已 accepted 的消息时调用 `coclaw.agent.abort` RPC 真正终止服务端 run

  阶段 1 仅在 UI 端进入 `settling(cancel)` 过渡态保留气泡，服务端 agent run 会继续执行到完成。本次在 `cancelSend` 已 accepted 分支增加 `conn.request('coclaw.agent.abort', { sessionId })` 调用：

  - sessionId 优先用 `this.sessionId`（topic 模式 UUID），其次 `this.currentSessionId`（chat 模式从 `chat.history` 获取），两者均不可知时跳过 RPC 静默降级到纯阶段 1 行为
  - RPC 失败（插件/OpenClaw 不支持、sessionId 未在 activeRuns 等）均通过 `.catch` 静默吞掉，UI 不暴露错误
  - abort 成功后 OpenClaw 的 `lifecycle:end` 会快速到达，`__settleWithTransition` 升级 reason 为 `'lifecycle'`，随后 `completeSettle` 清理 run → `isSending=false` → 输入框解锁

  `/compact` 进行中的 run 在服务端不可中断（OpenClaw 未注册到 `ACTIVE_EMBEDDED_RUNS`），UI 通过新增 `ChatInput` 的 `cancelDisabled` prop + `ChatPage` 绑定 `chatStore?.__slashCommandType === '/compact'` 禁用取消按钮，避免用户点击后 UI 状态与服务端不一致。

  详见 `docs/designs/agent-run-cancellation.md` 阶段 2。

- 1b8a47c: feat(ui): 取消 RPC 结果按 reason notify + 输入框守卫精细化

  **取消 RPC 结果 notify**

  `cancelSend` 现在返回一个 Promise（已 accepted 分支），永远 resolve 为 `{ ok, reason? }` shape；RPC reject 被收敛为 `{ ok:false, reason:'rpc-error' }` 避免 unhandled rejection。`ChatPage.onCancelSend` 根据 reason 分支 notify：

  - `not-supported`（侧门不存在，OpenClaw 版本过旧）→ `notify.warning` 提示升级 OpenClaw
  - `abort-threw`（OpenClaw abort 抛异常）→ `notify.error` + `console.error`
  - `not-found` / `rpc-error`（竞态或底层已 notify）→ 静默
  - `ok: true` → 静默

  新增 i18n keys `chat.cancelNotSupported` / `chat.cancelAbortFailed`（12 种语言同步）。

  **accepted 后允许准备下次消息的附件**

  `ChatInput` 的 "+" 文件按钮从 `:disabled="sending || disabled"` 改为 `:disabled="disabled"`，与 textarea 对齐：pre-accepted 期间被 `disabled` 禁用（`inputLocked=sending&&!__accepted`），accepted 后可点击添加文件。

  **pre-accepted 期间禁止拖放文件**

  `ChatPage` 的 `__onDragOver` / `__onDrop` 新增 `inputLocked` 守卫，pre-accepted 窗口拒绝拖入（不 `preventDefault`，不开启拖拽蒙层）；accepted 后继续允许拖入。

  **设计文档**

  修正 `docs/designs/agent-run-cancellation.md` 决策 1 中"取消后输入框守卫禁用"的不准确描述——实际仅发送按钮保持 STOP 状态，输入框在 `__accepted=true` 时始终启用。

- a9e209f: fix(ui,plugin): UI 主导的 cancel 协调状态机解决注册空窗期 race；插件诊断 patch 产品化 + remoteLog 触点

  阶段 2 上线后实测发现 topic "永远不能取消"、main chat "要等几秒才能取消"。根因：`agent()` RPC 的 `onAccepted` 帧毫秒级返回（UI 亮 STOP）但 OpenClaw 的 `setActiveEmbeddedRun`（`attempt.ts:1572`）要等 session/workspace/skills/provider 等异步准备完成才执行——main chat ~4s，topic 冷启 10-30s+。窗口内 `coclaw.agent.abort` 全部返回 not-found。

  阶段 2.5 实施 UI 主导 + 插件无状态方案：

  **UI 侧（`ui/src/stores/chat.store.js`）**

  - 新增 state `__cancelling = { sid, promise, resolve, tickTimer, tickSeq } | null`
  - 新增 getter `isCancelling`
  - 新增内部方法 `__startCancelCoordination(sid, conn)`：按 `CANCEL_TICK_MS = 500` 重试 `coclaw.agent.abort` RPC，**无 TTL**（生命期=run 生命期）
  - 终止信号：RPC ok=true → `{ok:true, aborted:'immediate'}`；RPC `not-supported` → 立即静默降级；每 tick 头检 `agentRunsStore.isRunning(runKey)`=false → `{ok:false, reason:'run-ended'}`；`sendMessage`/`sendSlashCommand` 入口 `__clearCancelling('superseded')` → `{ok:false, reason:'superseded'}`（deep-review 发现：缺此分支则 chat 模式同 sessionId 的新 run 会被残留 tick 误 abort）
  - `cancelSend` accepted 分支幂等：二次调用返回同一 promise（按钮已被 `cancelDisabled` 禁用）
  - `cleanup()` 同步清理 `tickTimer` 防止页面离开后继续重试
  - `ChatPage.vue` 的 `cancel-disabled` 集成 `isCancelling`——用户点 STOP 后按钮立刻禁用直到 run 结束
  - `onCancelSend` 简化：终态 `immediate`/`run-ended` 静默，仅 `not-supported` notify warning
  - UI remoteLog 触点：`cancel.start` / `cancel.immediate` / `cancel.not-supported` / `cancel.run-ended`

  **插件侧（`plugins/openclaw/`）**

  - `coclaw.agent.abort` 保持单次同步查询 + 现有 logger.info；新增 5 条 remoteLog 触点：`abort.request` / `abort.success` / `abort.not-supported` / `abort.patch installed=...` / `abort.patch-failed reason=...`
  - `installAbortRegistryDiag` 从 `/* c8 ignore */` 临时诊断**产品化**为常驻 patch：监控 `embedded.activeRuns` / `embedded.sessionIdsByKey` / `reply.activeRunsByKey` / `reply.activeKeysBySessionId` 四个 Map 的 `.set`/`.delete`/`.clear`，输出 `[coclaw.diag] <label>.set/delete/clear` 本地日志；installed/missing 列表上报 remoteLog 作为 OpenClaw 内部契约变更早期警报
  - `agent-abort.js` 的 `describeReplyRunRegistry` 与 not-found diag dump 同步产品化（去 c8 ignore + 补单测覆盖各种缺失/异常分支）

  **调研依据**：subagent 复核 OpenClaw 源码确认 sessionId → run 是 1:1（`runs.ts:359` 直接覆盖），run 中再发消息走 reply queue 4 模式但**无并发同 sid**；handle 不带 runId、`chat.abort` 的 runId 路径不覆盖 `agent()` RPC；故 CoClaw 维持 sid 粒度协调。queue 模式下 run A→B 转换由 lifecycle:end 自然清除 UI 协调状态，无残留意图误伤 B。

  详见 `docs/designs/agent-run-cancellation.md` 阶段 2.5、`docs/openclaw-research/agent-run-cancellation.md` §6.7。

### Patch Changes

- abad747: feat(ui): cancel button shows spinner + "Cancelling…" tooltip while in flight

  用户点 STOP 后按钮原先只是禁用（透明度变化），桌面端 tooltip 仍然显示 "Stop sending" 误导用户，移动端无 hover 反馈完全感知不到取消请求是否被记录。

  改进：

  - `ChatInput.vue` 新增 `cancelling` boolean prop（默认 false）。当 `cancelling=true` 时 STOP 按钮：
    - 图标 `i-lucide-square` → `i-lucide-loader-circle`，配合 Nuxt UI `:ui="{ leadingIcon: 'animate-spin' }"` 持续旋转（移动端清晰可见）
    - tooltip 切到 `chat.cancelling` = "正在取消…" / "Cancelling…" 等
    - `disabled` 仍由 `cancelDisabled` 控制（防重复触发），与 `cancelling` 解耦——slash 命令场景 `cancelDisabled=true` 但 `cancelling=false` 保持原 square 图标
  - `ChatPage.vue` 透传 `:cancelling="!!chatStore?.isCancelling"`
  - 12 个 locale 新增 `chat.cancelling` 翻译

  测试：ChatInput.test.js 覆盖 cancelling=true/false 两个分支的 icon/tooltip/ui prop；ChatPage.test.js 覆盖 isCancelling 状态透传。

- b7a8ad7: fix(ui): 文件下载串行队列 + pending 状态可视化 + 失败诊断日志

  - `files.store` 新增 `__runDownloadQueue`：同一 (claw, agent) 下载串行执行，避免多 DC 并发把插件 SCTP 缓冲灌满导致 UI READY_TIMEOUT。
  - `files.store` 新增 `logTaskFailure` helper，覆盖 file-transfer 之外的失败路径（saveBlobToFile / Capacitor 权限错误等），并区分 `DOWNLOAD_FAILED` / `SAVE_FAILED` 阶段；UI 出现 failed 时一定能在 console + remoteLog 找到诊断信息。
  - `FileListItem` 新增 pending 分支，渲染「等待中…」+ 取消按钮；删除按钮在 pending 时也隐藏，避免误删排队中的任务。修复了上一版下载入队后 UI 无任何反馈、用户误以为「点击被忽略」的问题。
  - `FileUploadItem` 取消按钮图标与下载侧统一为 `i-lucide-circle-stop`。

- 2bd7f3a: fix(ui): 取消已 accepted 的消息时保留气泡、等 lifecycle:end 自然收敛

  当用户在 `agent accepted` 后点取消，原来 `cancelSend` 硬清理 `streamingMsgs` 并立即 `reconcileMessages`，由于服务端 run 仍在执行、user message 尚未持久化，导致用户消息气泡消逝，直到 run 真正结束时才恢复（main-agent-chat / topic 必现）。

  本次修复：

  - `agent-runs.store` 新增 `settlingReason: 'lifecycle' | 'cancel'` 字段区分 settling 来源；新增公共方法 `settleWithTransitionByKey(runKey)` 进入 `settling(cancel)` 过渡态但保留 streamingMsgs 与 30min 兜底 timer，不主动调度 500ms fallback
  - `completeSettle` 仅处理 `settlingReason='lifecycle'` 的 run，防止 WS 闪断重连 / 前台恢复 / activate 重入等独立 loadMessages 路径误清 `settling(cancel)` 状态下的 streamingMsgs
  - `__settleWithTransition`（由 lifecycle:end 触发）把 reason 升级为 `'lifecycle'`，解锁后续 completeSettle 清理
  - `cancelSend` 已 accepted 分支改用新方法：不 reject 原 `agent()` RPC Promise、nullify `__cancelReject` 槽位避免后续 cleanup 误 reject、不立即 reload messages
  - 此阶段 `isSending` 仍为 true（`isRunning` 判 `!settled`），输入框保持禁用；真正"取消后立即解锁"将在阶段 2 通过插件 `coclaw.agent.abort` 驱动 `lifecycle:end` 快速到达实现

  详见 `docs/designs/agent-run-cancellation.md` 阶段 1。

- bf8ee23: fix(ui): 修复多 claw 共用同名 agent 时活跃 run 跨 claw 串显

  当用户连接多个 claw 且各自存在同名 agent（如默认 `main`）时，一个 claw 的 "思考中 N 秒" 计数和流式内容会同时出现在其它 claw 的 chat 页面。根因是 `agent-runs.store` 的 `runKeyIndex` 使用 `chatSessionKey`（形如 `agent:main:main`，不含 clawId）作为全局扁平 key，多 claw 同名 agent 在索引中发生碰撞，`register` 时甚至会互相驱逐对方的活跃 run。

  本次修复将 chat 模式的 runKey 改为 `${clawId}::${chatSessionKey}`，topic 模式仍沿用 sessionId（uuid 天然唯一）。同步修改 `AgentCard.vue`、`ManageClawsPage.vue` 中独立构造 runKey 的三处位置。

- 3f9c0ef: fix(ui): 拉长 agent run / 斜杠命令 / 标题生成超时，避免长任务被前端过早中断

  - **post-acceptance timeout**：30min → 24h（`POST_ACCEPT_TIMEOUT_MS`）。客户端等待 `lifecycle:end` 的 fallback 超时与 OpenClaw agent run 生命周期对齐；正常路径下 run 由事件驱动 settle，此 timer 只作 WS 丢事件 / OpenClaw 崩溃的兜底清理
  - **`/compact` 斜杠命令**：10min → 24h（`POST_ACCEPT_TIMEOUT_MS`）。`/compact` 触发服务端 LLM 摘要可跑很久，前端不应先于服务端超时；`/new` / `/reset` 保持 10min（sessions.reset 是秒级操作），其它斜杠命令保持 5min
  - **生成 topic 标题的 RPC 超时**：5min → 10min，给插件内部 agentRpc（同步提高到 5min）留足 buffer

  `POST_ACCEPT_TIMEOUT_MS` 从 `agent-runs.store.js` export，供 `chat.store.js` 复用；相关测试用该常量替换原硬编码 `30 * 60_000`。

- a0f4b5e: fix(ui): disable STOP for all slash commands & gate desktop mic button

  - 斜杠命令（`/new`、`/reset`、`/help` 等）无服务端取消通道，点击 STOP 仅清本地乐观消息而不会中断服务端命令。原先只 disable `/compact` 的 STOP，其它斜杠命令的 STOP 可点击但无效。现在统一：任何斜杠命令进行中 STOP 按钮禁用，避免"按了没用"的错觉。
  - 桌面麦克风按钮此前未跟随 `disabled` prop —— claw 离线 / 预 accepted 期间仍可点击开始录音。现在按钮绑定 `:disabled="disabled"`，`onStartDesktopRecording` 头部早退，与 textarea / `+` 按钮 / 触屏"按住说话"对齐。

- 698c838: fix(ui): 大文件上传中途被 keepalive 误杀（DC_CLOSED during flow control）

  `webrtc-connection.createDataChannel` 在 file DC 上新增 `bufferedamountlow` 监听，与现有 `message` 监听一起更新 `__lastDcActivityAt`。

  **Why**：keepalive 的活动宽限只在入向 `message` 时记账。上传场景下 file DC 几乎没有入站消息，rpc DC probe 又因 SCTP 出向被 file 数据塞满迟迟不返回 ack，宽限内没有活动证据 → keepalive 关闭整个 PC → 正在 await BAL 的 sendChunks 被强制 reject 为 `DC_CLOSED`。BAL 触发等价于"出向字节真实进入网络"——是上传时唯一可信的 SCTP liveness 信号，把它纳入活动统计即可消除误杀，且不削弱 keepalive 对真实 SCTP 假死的检测能力。

- 1eeb742: fix(ui): 修复僵尸 agent run 导致 UI 计时器空转、输出卡住 (#235)

  当 `lifecycle:end` 事件丢失时，agent run 进入僵尸态（unsettled），使 `isSending` 永远为 true，进而阻断所有可能触发 `reconcileAfterLoad` 的 `loadMessages` 路径，形成死锁。
  本次修复在 `agent-runs.store` 增加 `isRunIdle` 检测（事件流静默 ≥10s），并在三个入口（chat.store activate 重入、ChatPage **onConnReady 重连、**handleForegroundResume 前台恢复）放行强制静默刷新，由 `reconcileAfterLoad` 的双重安全检查（事件流静默 + 服务端确认完成）兜底防止误清理活跃 run。

- 61d28fe: refactor(ui): 统一进度指示为通用 ProgressRing 圆形组件

  - 新增 `src/components/ProgressRing.vue`:精确还原 Quasar `q-circular-progress` 几何公式(viewBox = 100/(1−thickness/2), radius = 50, strokeWidth = thickness/2 × viewBox);双模式(value 0~1 确定态 / null 不定态);Nuxt UI 语义色 + ARIA 1.2 属性
  - `ChatInput`:移除手写 SVG 进度圈,改用 `<ProgressRing>`;`__filePercent` → `__fileProgress`(直接传 0~1);轨道由 `stroke-muted/30` 升级为 `stroke-muted` 不透明,解决原"残缺感"
  - `FileUploadItem` / `FileListItem`:条形进度 → 圆形,与 action 按钮并列,对移动端更友好;FileListItem 下载新增中央百分比显示
  - 配套 32 个 ProgressRing 单元测试 + 联动测试断言更新
  - 后续改进项(a11y i18n、窄屏验证、测试增强等)登记于 `ui/TODO.md`

- 397b36f: fix(ui,plugin): review followups for agent run cancellation

  deep review 发现的一致性/稳健性改进：

  - **ui**: 触屏"按住说话"按钮 gating 与 textarea / "+" 按钮对齐，改为仅受 `disabled` 控制（`sending` 单独禁用违反"accepted 后允许准备下次消息附件"的设计意图）
  - **ui**: `cancelSend` accepted 分支新增 settling(cancel) 守卫，避免双击 STOP / watcher 重入（如 `isClawOffline`）导致重复 `coclaw.agent.abort` RPC
  - **plugin**: `agent-abort.js` 增加 `typeof handle.abort !== 'function'` shape 守卫，归类为 `not-supported`（而非 `abort-threw`），让 UI notify 显示"升级 OpenClaw"而不是"执行失败"
  - **ui**: `POST_ACCEPT_TIMEOUT_MS` 注释修正 —— 这是客户端侧 fallback 上限，非与后端 run 生命周期对齐
  - 文档：`docs/architecture/communication-model.md` 超时表同步到最新值（agent post-accept 30min → 24h；generateTitle 300s → 600s，含层级说明）
  - 测试：补 `conn=null` 降级、双击 STOP 守卫、`title-gen.js` 传递 `timeoutMs=300_000` 断言、触屏语音按钮 gating

## 0.11.3

### Patch Changes

- ui: add cloud deploy guide, debug build variant, reconnection optimization, remove per-bot inline loading
  server: simplify coverage config, raise test coverage to 90%+

## 0.9.4

### Patch Changes

- feat: 管理员仪表盘新增最新注册用户列表；服务端新增插件版本号返回及 loginName 查询
- fix: 管理员仪表盘修复版本号显示、用户名为空、在线数未展示、文案优化；Dashboard 频道名称显示及花费隐藏；统一 **APP_VERSION** 变量

## 0.9.0

### Minor Changes

- 7044e4f: feat: 机器人页面升级为 Agent Dashboard（Phase 1）

  - 新增实例总览卡片（InstanceOverview）：展示名称、在线状态、本月花费、频道状态、版本信息
  - 新增 Agent 卡片瀑布流（AgentCard）：展示身份、模型标签、能力矩阵、tokens/会话/最近活跃
  - 能力标签从 OpenClaw gateway tools.catalog 动态映射
  - 模型标签从 models.list 动态生成
  - 并行 RPC 聚合，部分失败优雅降级
  - 离线 bot 显示简化版 fallback header
  - 完善 i18n 支持（中文 + 英文）

## 0.1.1

### Patch Changes

- 0cf6cec: fix(ui,server): add WS heartbeat and improve chat disconnect resilience

  - UI WS client: 25s ping / 45s timeout heartbeat to detect silent disconnections on mobile
  - Server: respond to application-level ping/pong + WS protocol-level ping for UI connections
  - ChatPage: 30s pre-acceptance timeout to prevent infinite "thinking" state
  - ChatPage: suppress duplicate error toasts when timeout/lifecycle:end already handled
  - ChatPage: lifecycle:end uses fresh WS connection for refresh; preserves user message on failure

- fix(server,ui): accumulated fixes since changeset adoption

  - server: extend binding code expiry from 5 to 30 minutes
  - server,ui: push bot name update via SSE after bridge connects
  - ui: update plugin id to openclaw-coclaw and improve AddBot page layout
  - ui: distinguish bot offline from unbound in ChatPage notification
  - ui: remove redundant bind-success notify and guard unbind double-click
  - plugin,ui: fix new-chat failure and missing session for agent:main:main
