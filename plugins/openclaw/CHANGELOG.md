# @coclaw/openclaw-coclaw

## 0.17.6

### Patch Changes

- fa201f2: Throttle rpc DC queue-full drop logs to state transitions only.

  When a UI instance disconnects and ICE fails, the plugin-side rpc DataChannel can stay technically open while its application-layer send queue stays permanently full — `bufferedamountlow` never fires, so `__drain` never runs, and the queue never returns below `MAX_QUEUE_BYTES`. Every subsequent `send()` from gateway then takes the queue-full branch. Previously this branch emitted a `logger.warn('drop reason=queue-full ...')` line on every drop, while only `remoteLog overflow-start` was state-gated. In practice one stuck connection produced 1641 warn lines over 5+ hours, swamping the gateway log.

  Both `logger` and `remoteLog` now fire only on the false→true and true→false transitions of `queueOverflowActive`. Drops while already in overflow are silently counted into `droppedCount` / `droppedBytes`; the cumulative numbers are reported on the next state flip (`overflow-end`, with matching `info` and remoteLog) or on `close()` (existing summary). `single-msg-oversize` drops still warn on every occurrence — they reflect application bugs rather than queue pressure, and aren't gated by `queueOverflowActive`. The 10 MB drop threshold and existing drain semantics are unchanged.

## 0.17.5

### Patch Changes

- cfef3aa: Raise pion-ipc request timeout from 10s to 20s and stream pion-node internal logs to the plugin's local logger in addition to `remoteLog`. Severe events (IPC `request timeout` and `orphan response`) are logged at `error` level locally so operators can spot them immediately during on-host debugging; other messages go to `info`. Also renames the preloader option `startTimeout` to `ipcRequestTimeout` (same value controls both the startup ping and every subsequent IPC request, so the old name was misleading).

  Motivation: a production incident on 0.17.3 surfaced a `dc.send` IPC timeout whose details were only visible server-side via `remoteLog`, making local diagnosis difficult. The longer window provides a safety margin against rare process-wide stalls without changing any IPC semantics.

- a4aa32a: Make stale upgrade-lock cleanup failures observable (local warn + remoteLog upstream).

  Previously every `fs.rm` call that cleaned a stale `upgrade.lock` swallowed errors with `.catch(() => {})`. Since `{ force: true }` already suppresses "file not found", any error reaching the catch is a real system-level failure — permission denied, read-only filesystem, lock path replaced by a directory, etc. Swallowing it was dangerous: if the cleanup failure co-occurs with a `writeUpgradeLock` failure (same underlying fault), the lock file retains the stale (expired) contents forever. Every subsequent hourly scheduler check then re-enters the same "judge as expired → fail to remove → spawn parallel worker" loop, piling up workers that race against each other on the same backup directory and state files. Before this change there was no local warn log and no remote signal, so the issue could only be diagnosed post-mortem.

  Three stale-lock branches (`missing-pid`, `ttl-exceeded`, `pid-dead`) are now routed through a single `removeStaleLock(lockPath, reason, logger)` helper. On success it logs an info line as before; on failure it logs a `warn` with the reason and error message, and emits `upgrade.lock-cleanup-failed reason=<reason> msg=<err>` via `remoteLog` so server-side observability sees it. The helper itself does not throw, so the gateway-stability guarantee of `isUpgradeLocked` is preserved. The `reason` values are short tokens (no spaces) so they work as `key=value` fields in the remote-log wire format and are easy to bucket.

  Incidental fix: the old code emitted `Stale lock removed` before attempting the removal, which meant the log claimed success even when the removal had actually failed. The new helper logs only on actual success.

- 07d1fc7: Add a 110-minute TTL to the auto-upgrade worker lock so the scheduler cannot be permanently blocked.

  The lock (`~/.openclaw/coclaw/upgrade.lock`) previously relied solely on `process.kill(pid, 0)` liveness checks. Two rare-but-real scenarios could leave the lock forever "held": (1) the worker is killed by `SIGKILL` / OOM / power loss and never cleans up; (2) the OS recycles the dead worker's PID to an unrelated long-lived process (e.g. the gateway itself, or a system daemon), so `kill(pid, 0)` keeps succeeding. Under either scenario every subsequent hourly check short-circuits and auto-upgrade stays disabled until someone manually removes the lock file. The recent rollback-timeout widening (worst-case worker run ~36 min) makes the exposure window noticeably larger.

  Fix: `isUpgradeLocked` now treats any lock whose recorded `ts` is older than 110 minutes — or whose `ts` is missing/unparseable — as stale and removes it. No process is killed; we only drop the lock file, because at TTL expiry the owning PID is almost always either already dead (current code path handles it) or has been reassigned to an unrelated process that we must not harm.

  The TTL is ~3× the worst-case worker runtime, so a worker that genuinely runs long does not trip the cleanup. 110 min is deliberately chosen over an even 120 min: the scheduler polls every 60 min, and if the TTL landed on an integer multiple of that interval the lock age would sit right on the "not yet expired" boundary at the Nth poll (due to second-level jitter between lock write and poll), forcing the scheduler to wait an extra full hour until the N+1th poll. 110 min guarantees the 2nd poll after a stuck worker clears the lock. In the vanishingly unlikely event a real worker is still alive past 110 min, the scheduler will launch a parallel worker; any concurrent `plugins update` conflicts surface as install/rollback errors rather than permanent plugin damage — an acceptable price for regaining autonomous recovery. Lock ownership remains with the gateway (scheduler writes/reads/removes); the worker still does not touch the lock, preserving single-owner mental model.

- 5f2c94d: Tighten two leftover edges in the auto-upgrade worker:

  - **Rollback fallback install timeout raised from 120 s to 10 min** (aligned with the forward `plugins update` timeout). The fallback path is only reached when the local backup is missing, so the situation is already anomalous; giving npm download the same budget it has on the upgrade path makes recovery far more likely to actually succeed instead of tripping the timer. Trade-off: the fallback flow uninstalls the plugin before reinstalling the old version, and the final `gateway restart` only fires after install completes. This widens the "uninstalled in `openclaw.json` but old code still live in the gateway process" inconsistency window from ~2 min to ~10 min — accepted as the lesser evil than aborting recovery halfway. Scheduler's hourly check honors the existing PID-keyed `upgrade.lock`, so no concurrent worker is spawned during this window.
  - **Removed the `?? toVersion` fallback** when recording the installed version into `lastUpgrade.to` / `upgrade-log.jsonl`. Under the current `pollUpgradeHealth` contract `result.version` is guaranteed to be a string whenever `result.ok` is true, so the fallback was dead code. Worse, if that contract were ever broken, the fallback would silently paper the break over with the scheduled target version — turning a "verify succeeded without a version" bug into an invisible one. With the fallback gone, such a break would surface as `undefined` in state/logs, which is exactly what we want during diagnosis.

- 378f0da: Auto-upgrade verification now accepts any installed version that is **greater than or equal to** the originally scheduled `toVersion`, not only a strict string match. Also records the **actually installed** version in `upgrade-state.json.lastUpgrade.to` (and `upgrade-log.jsonl`) instead of the scheduled target.

  Motivation: between the moment the scheduler observes `latest=x` on the npm registry and the moment the worker actually runs `openclaw plugins update`, the dist-tag can advance to `x+1`. Under the old strict-equal verification this was reported as "version mismatch", triggering a rollback and permanently skipping `x` — even though the install had succeeded and produced an even newer version. The plugin would be stuck on the prior version until the next manual intervention.

  The worker now uses the same semver comparison as the scheduler (locally duplicated to avoid cross-process imports from the gateway), and reports `version-too-old got=X want>=Y` as the failure reason when the observed version is still older than the target. Documentation in `docs/auto-upgrade.md` has been brought back in sync with the current single-path (upgradeHealth polling) verification flow.

## 0.17.4

### Patch Changes

- 6abcc8e: Harden upgrade worker's post-restart verification. Replace the `openclaw gateway status` polling plus `openclaw plugins list` stdout substring match with a single poll loop on the `coclaw.upgradeHealth` RPC, requiring the returned version to strictly equal `toVersion`. The old check could falsely report success when `plugins update` silently no-op'd (upgradeHealth returned an old version that still satisfied the truthy-only check) and could falsely fail when the CLI table wrapped the plugin id across lines. Poll window extended to 5 minutes to accommodate cold-start delays (AWS probes, ollama detection, plugin bootstrap). On-disk `package.json` version is read for diagnostic logging only and does not gate the decision.

## 0.17.3

### Patch Changes

- cffb8e4: Stop shipping `src/homedir-mock.helper.js` in the published npm tarball. The file is a test-only helper referenced exclusively by `*.test.js` and was leaking into the published package as dead code. Added as an explicit entry alongside the existing `!src/mock-server.helper.js` exclusion. No runtime behavior change.

  Explicit per-file exclusion is intentional — business modules may legitimately use the `.helper.js` suffix in the future, so a broad `!src/**/*.helper.js` glob would risk silently dropping them from the tarball.

- 8fa21ab: Bound plugin→gateway handshake retry with exponential backoff (5s/10s/20s/20s/20s, max 5 retries) and add v3→legacy fallback within the same WebSocket. Fixes log flooding where a persistent handshake failure (e.g., `device signature invalid`) could emit hundreds of `ws.connect-failed` / `ws.disconnected` lines per minute to the CoClaw server, drowning out unrelated diagnostics.

  - On `connect.challenge`, the plugin still sends v3 (with `device` field) by default. If the response is `ok:false` and the error message matches `/signature|device|scope|protocol/i`, the plugin retries once with a legacy (no-device) handshake on the **same WebSocket** — no new connection, no counted failure. The learned legacy preference is cached in memory and used for subsequent WebSockets (reset on plugin/gateway restart).
  - Handshake failures that are not signature/protocol-related — or legacy retries that also fail — close the WebSocket and schedule the next attempt per the backoff table. After 5 retries are exhausted (6 total attempts, ~75s), the bridge enters a terminal `gave-up` state and does not attempt gateway reconnection again until the plugin or gateway restarts.
  - Duplicated `ws.disconnected peer=gateway` log is suppressed when the close was a direct consequence of a just-reported `ws.connect-failed`, collapsing two lines into one per failed attempt. Genuine "connected then dropped" disconnects still log as before.
  - The existing successful-handshake path is byte-identical for modern OpenClaw gateways: no v3 regression.

## 0.17.2

### Patch Changes

- f29dfd6: Add `FileBackedQueue` utility in `src/utils/file-backed-queue.js` — generic string queue with memory-first storage that spills to a JSONL file when the memory budget is exceeded. Internal module only; not yet wired into the plugin.
- b3d3443: Shrink `rtc.dump` file channel summary on disconnect/failed.

  `__dumpSessionState` previously concatenated `<label>=<readyState>` for every tracked file DC (up to the FIFO cap of 20). On long-lived PCs that accumulated many already-closed file transfers, the line grew to ~1KB and was duplicated into remoteLog. The dump now aggregates by `readyState`: closed channels collapse to a single count (`closed:N`), and only non-closed states list their labels (e.g. `open:1(file:abc)`). This keeps the diagnostic value — labels of DCs that failed to close cleanly — while bounding the line size regardless of session age.

- 1ea9523: Cap pion SCTP RTO backoff at 10s and emit SCTP diagnostic samples on disconnect/recovery.

  - Pass `settings: { sctpRtoMax: 10000 }` to the pion PeerConnection so that post-background-wake retransmission backoff is bounded by 10s instead of pion's 60s default. This lets the UI's 15s READY_TIMEOUT window cover the recovery path, fixing the "chat/topic spinner" symptom after long APK backgrounds.
  - Add `__dumpSctpStats` that, on pion-impl sessions, samples `getSctpStats()` and emits a separate `rtc.sctp conn=... state=... cwnd=... srtt=...ms sent=... recv=... mtu=...` remoteLog line alongside `rtc.dump` (or `sctp=none` before the association is up, `error=<msg>` on rejection). Triggers piggyback on the existing `__dumpSessionState` call sites (ICE restart recovery + disconnected/failed), so `cwnd` collapsing to ~1×MTU with flat `bytesSent` is now observable.
  - Both changes are gated by `__impl === 'pion'`; werift fallback is untouched. Bumps `@coclaw/pion-node` to `^0.3.0`.

## 0.17.1

### Patch Changes

- 39cd433: fix(rtc): filter gateway admin-broadcast events from DC forwarding + expand ICE gathering diagnostics

  Two small, complementary changes on the plugin side:

  **Gateway event filter (`realtime-bridge.js`)**

  The bridge currently forwards every `res` / `event` frame from the
  gateway WS to every open rpc DataChannel. Two gateway-maintenance events
  carry no business meaning for WebChat / plugin clients but are pushed
  unconditionally on a timer:

  - `health` — a full state snapshot (~3 KB: channels, every agent,
    recent sessions, stateVersion) broadcast on a 60 s tick and again on
    every client-issued `health` RPC. Intended for the Admin UI
    dashboard.
  - `tick` — gateway WS keepalive, emitted every 30 s. The DC side
    already has its own transport probe (`probe` / `plugin-probe`) so
    the UI does not need it, and it is piggy-backed through the DC for
    no purpose.

  When the Android APK is backgrounded the WebView stops draining the
  DC; these two streams alone fill the plugin's 10 MB app-layer send
  queue in ~1–2 h, after which real events start being dropped. The
  upstream gateway has no subscription mechanism for filtering event
  broadcasts per client (not in `EVENT_SCOPE_GUARDS`), so until that is
  added we drop both event names at the bridge before they reach
  `webrtcPeer.broadcast`. `res` frames and all other events are
  forwarded unchanged.

  **ICE gathering diagnostics (`webrtc-peer.js`)**

  Under pion-node the existing `rtc.ice-gathered` summary never emits
  because pion does not fire `onicecandidate(null)` at gather-complete.
  Install an `onicegatheringstatechange` handler as a fallback: on the
  `complete` state transition we flush the same summary, guarded against
  double-emission when the null-candidate path fires too (e.g. werift).
  The summary now also includes a `hosts=addr:port,...` list for each
  host candidate so we can observe whether pion is gathering docker /
  bridge / loopback interfaces as host candidates. The `gathering` state
  resets the flag so ICE restart cycles also get a fresh summary.

  **Diagnostic logs in `rpc-send-queue.js`**

  Commented-out `info` payload dumps left in place (one on every queued
  message, one on queue-full drop) so they can be temporarily enabled to
  sample what the gateway is still pushing without editing the release
  build.

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

## 0.17.0

### Minor Changes

- f32b8e5: Harden plugin auto-upgrade against slow npm downloads and registry-side throttling, fixing the upgrade loop observed on slow / firewalled networks.

  - Raise the `openclaw plugins update` execution timeout from 2 minutes to 10 minutes, so first-time installs of native deps (e.g. `node-datachannel`) no longer get killed mid-download.
  - Add a one-shot reverse-mirror retry: if the first attempt fails (timeout / 429 / network error), the worker reads the user's current `npm config get registry` and retries once with the opposite side — `npmjs.org` users fall back to `registry.npmmirror.com`, and `npmmirror` users fall back to `registry.npmjs.org`. Either side being healthy is enough to escape the failure.
  - Increase the scheduler's first-check delay from 5 minutes to 60 minutes (effective range 60-120 minutes random). Prevents the failed-upgrade → gateway-restart → re-check cycle from disturbing gateway availability every few minutes when an upgrade keeps failing.
  - Preserve the original `skipVersion: false` semantics on update-command failures: failures are still treated as transient and re-attempted on the next cycle (now an hour later, not minutes).

### Patch Changes

- 88e1b46: Drop the `node-datachannel` dependency and its `vendor/ndc-prebuilds/**` publish entry to shrink the npm tarball from ~50 MB to ~82 kB, removing the main source of auto-upgrade stalls on slow networks.

  - Pion has been validated as the reliable primary WebRTC implementation; werift remains as the runtime fallback when pion fails to load.
  - `src/webrtc/ndc-preloader.js` is deliberately left in place during this transition. With the package missing, `require.resolve('node-datachannel')` throws synchronously and the preloader's existing `try/catch` falls through to werift via the unchanged fallback path — no consumer ever reaches an ndc-only code path.
  - No change to gateway RPC methods, plugin events, or binding protocol.

- 42b37e8: Add `credRemain` field to all ICE restart remoteLog lines on the plugin side.

  `credRemain` reports the seconds remaining until the embedded TURN credential expires (negative when already expired, `none` when no creds or unparseable). Helps diagnose whether ICE restart failures correlate with stale credentials (PC lifetime > 24h cred TTL window). Pure telemetry — no behavior change. Plugin reads it from `msg.turnCreds.username`.

- 87e953c: Tighten WebRTC peer session limits to cut idle resource usage.

  - `MAX_SESSIONS`: 20 → 10 — caps active + failed PeerConnections per peer. Eviction policy unchanged: only the oldest failed session is reclaimed; connected sessions are never evicted, and when none is failed the new offer still proceeds with a warning.
  - `FAILED_SESSION_TTL_MS`: 24h → 12h — failed sessions reclaim their IPC listeners and Go-side resources sooner. ICE restart after foreground resume still works within the new window; beyond it the UI falls back to a fresh offer/answer.

## 0.16.0

### Minor Changes

- bea05ad: claws 页面中继连接展示两段链路协议（浏览器 ↔coturn↔plugin），避免仅显示浏览器侧协议导致的误导。

  - Plugin（`@coclaw/openclaw-coclaw`）：pion 路径下新增 `coclaw.rtc.peerTransport` DC 事件单播。rpc DC 建立时和 ICE 选中 pair 变化时，把本端 candidate 的 `{ candidateType, protocol, relayProtocol }` 推送给对应 UI；签名去重避免重复发送，`queueMicrotask` 避让竞态，`sendTo` 失败回滚签名允许后续重试。顺手增强 `__logNominatedPair` 远程日志，带出 protocol 和 relayProtocol。werift 路径保持不变（其 candidate 对象无 relayProtocol，UI 自动走降级兜底）。
  - UI（`@coclaw/ui`）：`claws.store` 监听新事件更新 `claw.rtcPeerTransportInfo`（与 `rtcTransportInfo` 字段解耦，避免被浏览器 getStats 轮询整体覆盖）；`failed/closed` 时清空。`ManageClawsPage.connLabel` 在 relay 分支合并双端信息：两端协议相同时简化为 `中继·UDP`，不同时展示 `UDP ↔ 中继 ↔ TCP`；详情面板新增"对端候选/对端中继协议"一行。新增 i18n keys `rtcRelayBothSides` / `peerCandidate` / `peerRelayProtocol`，12 语言全同步。
  - 兼容性：依赖 `@coclaw/pion-node` 0.1.3+（新增 `relayProtocol` 字段透传）。老 plugin / 老 pion-ipc 二进制下事件不发，UI 自动回退老文案，不报错。

### Patch Changes

- 8ce4cbb: Bump `@coclaw/pion-node` dependency from `^0.1.2` to `^0.1.3`.

  The plugin's WebRTC layer (`webrtc-peer.js` — `__sendPeerTransport` /
  `__logNominatedPair`) reads `selectedCandidatePair.local.relayProtocol`
  to surface the plugin-side relay protocol for the `coclaw.rtc.peerTransport`
  DC event and nominated-pair logs. This field is only populated starting
  from pion-node 0.1.3 (which exposes pion-ipc's `RelayProtocol` passthrough
  on the local candidate). Under 0.1.2 the field was always `undefined`, so
  relay connections showed only the browser-side protocol in the UI. Pinning
  the floor to 0.1.3 makes the behavior reliable.

## 0.15.0

### Minor Changes

- 1eedb69: plugin: 扩展 coclaw.info.updated payload

  - `__pushInstanceName` 改名为 `__pushInstanceInfo`
  - 事件 payload 新增 `pluginVersion`（从 `plugin-version.js` 获取）和 `agentModels`（agent × 有效主模型，通过 `agents.list` RPC 采集）
  - 新增 `__collectAgentModels` 方法；采集失败时 `agentModels` 为 null，不影响其它字段上报

## 0.14.1

### Patch Changes

- b2da826: chore(plugin): trim cancel-related diag log noise

  阶段 2.5 上线后实测发现取消相关日志噪音过大：注册空窗期内 UI 每 500ms 重试 `coclaw.agent.abort`，每次都打 `request` / `result not-found` / `not-found diag` 三条，单次取消可累积数十行；且 `installAbortRegistryDiag` 默认 patch 4 个 Map（其中 `reply.*` 在当前 OpenClaw 版本根本不暴露）+ 启动时每 label 一条 `installed ${label} patch (size=N)`。

  清理方案：

  - 删除已注释的 `[coclaw.agent.abort] request` info + `abort.request` remoteLog 行
  - `[coclaw.agent.abort] result` 在 `reason=not-found` 时跳过；`ok=true` / `not-supported` / `abort-threw` 仍 info
  - 删除 `agent-abort.js` 的 `not-found diag` 块 + `describeReplyRunRegistry` 助手 + 不再使用的 `logger` 形参
  - `PATCH_LABELS` 缩到只剩 `embedded.activeRuns`（取消路径实际读取的就是这张表；`sessionIdsByKey` 与之 1:1 同步触发，冗余；`reply.*` 当前 OpenClaw 不存在）
  - `patchMapLogging` 删掉 `clear` 包装（实测从未触发）+ 启动时的 `[coclaw.diag] installed ${label} patch` 日志（与 `abort.patch installed=` remoteLog 重复）

  最终噪音模型：每次 run 2 条 info（`embedded.activeRuns.set` + `.delete`）；取消成功 1 条 info + 1 条 remoteLog；`not-found` 重试期间完全静默。

  RPC 契约不变。

- 9c3833d: feat(plugin): add coclaw.env diag log with platform/version info on ws connect

  插件间接依赖平台相关二进制（`@coclaw/pion-ipc-*` 的 npm 平台子包），诊断问题时需要快速获取 claw 端的运行环境。新增 `coclaw.env` 单行诊断日志，覆盖 webrtc 选型 + 插件/OpenClaw 版本 + OS/arch/CPU/内存：

  ```
  coclaw.env impl=pion plugin=0.14.0 openclaw=4.5.0 platform=linux arch=x64 node=v22.22.0 osrel=6.6.87 cpu="AMD Ryzen 7 8745H" cores=8 mem=11.7GB
  ```

  **输出时机**：

  - `bridge.start()` 完成后：**只本地** `logger.info` 一次（gateway 日志可见，便于本地排查）
  - 每次 `ws.open`（首次连接 + 每次重连）：**只远程** `remoteLog` 一次

  两端互不重复：ws.open 是唯一的远程来源，避免 "start 入 buffer + ws.open 再发" 的重复问题；server 重启重连后能立即看到当前 claw 的环境信息。

  **关键设计**：

  - `getPlatformInfoLine()` 纯缓存的同步轻量调用（`process.*` 常量 + `os.release/cpus/totalmem`），模块级缓存一次后零开销，可被 ws 重连路径放心频繁调用
  - 显式避免 `process.report.getReport()`（重量级同步调用，曾怀疑与 native 模块初始化期产生时序冲突）
  - `ws.open` 内**先 `setRemoteLogSender` 再 `remoteLog(envLine)`**：保证环境信息随当前 sock 立即 flush；sender 闭包仅 `sock.send`，不回调 `remoteLog`，无循环依赖
  - 每字段独立 `try/catch` 尽力而为：单项失败不影响其它字段；CPU model 的控制字符（C0 + DEL）被清洗为空格以保证 `key="value"` 解析格式

  RPC 契约不变；gateway 方法注册不变；仅新增一条 remoteLog 日志。

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

- 397b36f: fix(ui,plugin): review followups for agent run cancellation

  deep review 发现的一致性/稳健性改进：

  - **ui**: 触屏"按住说话"按钮 gating 与 textarea / "+" 按钮对齐，改为仅受 `disabled` 控制（`sending` 单独禁用违反"accepted 后允许准备下次消息附件"的设计意图）
  - **ui**: `cancelSend` accepted 分支新增 settling(cancel) 守卫，避免双击 STOP / watcher 重入（如 `isClawOffline`）导致重复 `coclaw.agent.abort` RPC
  - **plugin**: `agent-abort.js` 增加 `typeof handle.abort !== 'function'` shape 守卫，归类为 `not-supported`（而非 `abort-threw`），让 UI notify 显示"升级 OpenClaw"而不是"执行失败"
  - **ui**: `POST_ACCEPT_TIMEOUT_MS` 注释修正 —— 这是客户端侧 fallback 上限，非与后端 run 生命周期对齐
  - 文档：`docs/architecture/communication-model.md` 超时表同步到最新值（agent post-accept 30min → 24h；generateTitle 300s → 600s，含层级说明）
  - 测试：补 `conn=null` 降级、双击 STOP 守卫、`title-gen.js` 传递 `timeoutMs=300_000` 断言、触屏语音按钮 gating

## 0.14.0

### Minor Changes

- 3d21a5e: feat(plugin): 新增 `coclaw.agent.abort` RPC，通过 OpenClaw 全局 symbol 侧门真正终止 embedded agent run

  该 RPC 接受 `{ sessionId: string }`，通过 `globalThis[Symbol.for('openclaw.embeddedRunState')].activeRuns.get(sessionId)?.abort()` 触发 OpenClaw 底层 `AbortController`，停止 LLM、工具调用和 compaction。

  响应语义是"请求是否被接纳"，并非"run 是否已终止"：

  - `{ ok: true }`：handle.abort 已调用，取消是否真生效由随后的 `lifecycle:end` 事件反映
  - `{ ok: false, reason: 'not-supported' }`：侧门不存在（OpenClaw < v2026.3.12）
  - `{ ok: false, reason: 'not-found' }`：sessionId 未在 activeRuns 中（已完成 / 从未开始 / 竞态）
  - `{ ok: false, reason: 'abort-threw', error }`：handle.abort 抛异常（不期望但防御）

  侧门访问封装在新文件 `src/agent-abort.js`，未来上游若提供正式 `agent.abort` RPC 或在 `api.runtime.agent` 暴露 abort 家族可集中替换。

  详见 `docs/designs/agent-run-cancellation.md` 阶段 2。

- 1aa1345: feat(plugin): 为 rpc DC 引入应用层发送流控（RpcSendQueue）

  - 每条 rpc DC 绑定一个 `RpcSendQueue` 实例，`broadcast` / files RPC sendFn 经此出口
  - 阈值：HIGH=1MB / LOW=256KB 水位背压；队列软上限 10MB（单条可溢出）；单条硬上限 50MB
  - 溢出静默丢弃（logger.warn 每次；remoteLog 仅状态转换汇总）
  - probe-ack 故意绕过 queue，独立测量传输层健康
  - 避免 pion/webrtc Go 侧 SCTP pendingQueue 无界堆积导致 gateway OOM

### Patch Changes

- ecebf2a: bump @coclaw/pion-node to ^0.1.2（新增 linux-arm 平台二进制支持）
- 3f9c0ef: fix(plugin): topic 标题生成内部 agentRpc 超时 60s → 5min

  原 60s 在慢模型 / 复杂对话下普遍超时，导致 `coclaw.topics.generateTitle` 失败。调高到 300s 给 LLM 足够的推理时间。`acceptTimeoutMs` 保持 10s（accept 阶段一般秒级完成）。

- 6dddcf9: fix(plugin): rpc DC 生命周期与诊断收尾（深度 review followups）

  - `closeByConnId`：显式关闭 `RpcSendQueue`（避免 `dc.onclose` 路径因 session 已 delete 而短路，导致 drop 汇总 remoteLog 缺失）
  - ICE restart：重协商 SDP 后同步刷新 `remoteMaxMessageSize` 与 queue 分片阈值（避免 renegotiation 变更 `a=max-message-size` 时新消息按旧值错误分片）
  - `rtc.dump` 诊断增加 `queueLen/queueBytes/dropped` 字段，便于定位队列积压
  - `agent-abort`：`activeRuns.get()` 也纳入 try/catch，duck-typed 实现抛出时归入 `abort-threw`（原先仅保护 `handle.abort()`）

## 0.13.2

### Patch Changes

- fix(plugin): 修复 PionIpc listener 泄漏并添加 failed session 清理机制

  - failed 状态的 session 增加 24h TTL 定时器，超时后自动回收释放 IPC listeners 和 Go 侧资源
  - session 总数上限 20，溢出时淘汰最旧的 failed session
  - closed 状态通过 closeByConnId 完整释放资源（此前仅删除 Map 条目）

## 0.13.1

### Patch Changes

- 优化 ICE restart 恢复时序与实现门控

## 0.13.0

### Minor Changes

- feat: pion-ipc WebRTC 实现 + ICE restart 恢复策略 + 文件传输诊断增强

  - 新增 pion-ipc preloader（autoRestart watchdog），WebRTC 优先级：pion → ndc → werift
  - ICE restart-first 连接恢复：断连时优先 ICE restart，失败发送 restart-rejected 由 UI 驱动 full rebuild
  - connectionState failed 保留 session 以支持 ICE restart 恢复
  - 文件传输增加 dc.onerror 处理（兼容 pion 异步 send 错误）、进度日志、诊断 dump
  - dc.close() 改为 await（pion graceful close 支持）
  - 分片阈值取 min(远端 max-message-size, 本地 maxMessageSize)
  - pion-node 依赖升级至 ^0.1.1

## 0.12.3

### Patch Changes

- fix: improve Windows compat for auto-upgrade subprocess calls; use ws package for WebSocket to bypass undici proxy dispatcher

## 0.12.2

### Patch Changes

- Register libdatachannel initLogger to capture native ICE/DTLS/SCTP diagnostics via remoteLog

## 0.12.1

### Patch Changes

- fix: upgrade node-datachannel to v0.32.2, add backpressure and diagnostic logging to DC file upload

## 0.12.0

### Minor Changes

- refactor: rename bot→claw in API paths, config persistence, WS messages, and internal identifiers

## 0.11.6

### Patch Changes

- fix(plugin): 修正 ndc-preloader 的 pluginRoot 路径计算（`..` → `../..`），修复 npm 安装用户无法加载 vendor 预编译包导致 fallback 到 werift 的问题

## 0.11.5

### Patch Changes

- 77afc35: feat(plugin): 启动时 remoteLog 插件版本号；自动升级检测到结果时远程上报（成功/回滚/跳过）

## 0.11.4

### Patch Changes

- fix(plugin): stop() 不调用 ndc.cleanup() 避免阻塞事件循环 10s+ 导致 bind/unbind 超时；修复 callGatewayMethod 未传递 --timeout 给 openclaw gateway call 的问题

## 0.11.3

### Patch Changes

- fix: percent-encode TURN credentials for node-datachannel

## 0.11.2

### Patch Changes

- fix: support turns: URL scheme in ICE server credential mapping

## 0.11.1

### Patch Changes

- ui: add cloud deploy guide, debug build variant, reconnection optimization, remove per-bot inline loading
  server: simplify coverage config, raise test coverage to 90%+

## 0.11.0

### Minor Changes

- feat: add claw instance naming support

  - New `coclaw.info.get` / `coclaw.info.patch` gateway methods for reading/setting claw name
  - Claw name stored in `~/.openclaw/coclaw/settings.json`, independent of bindings
  - `coclaw.info.updated` event broadcast to server (persists bot.name) and UI instances (DC)
  - `coclaw.info` response now includes `name` and `hostName` fields

## 0.10.0

### Minor Changes

- Integrate node-datachannel as primary WebRTC implementation with werift fallback

  - Add ndc-preloader module with vendor prebuild deployment, timeout protection, and graceful fallback
  - Unify PeerConnection resolution: preloader provides implementation, webrtc-peer requires it
  - Await preload before WS connection to eliminate RTC timing gap
  - Add self-explanatory diagnostic logging for WebRTC implementation selection
  - Include precompiled binaries for linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64

## 0.9.2

### Patch Changes

- fix: WebRTC init race condition + reconnect unhandled rejection

## 0.9.1

### Patch Changes

- fix: add error listener on spawned upgrade worker to prevent gateway crash

## 0.9.0

### Minor Changes

- 4152fcd: 文件管理协议升级：采用 HTTP 动词语义（GET/PUT/POST），新增 POST 附件上传（唯一文件名生成）、mkdir/create RPC、force delete 非空目录支持

## 0.8.2

### Patch Changes

- feat(rtc): DataChannel 应用层分片/重组，消除 SCTP maxMessageSize 限制，所有 RPC 消息统一走 DataChannel

## 0.8.1

### Patch Changes

- fix(webrtc): correct ICE restart handling and fix session cleanup race

## 0.8.0

### Minor Changes

- feat: implement file management via WebRTC DataChannel (list/delete/read/write with path security, backpressure flow control, and temp file cleanup)

## 0.7.1

### Patch Changes

- fix: rename internal function to avoid OpenClaw install-time security scanner warning

## 0.6.2

### Patch Changes

- Delegate bind/unbind to gateway RPC, harden config I/O with atomic writes and mutex, improve error handling in realtime bridge

## 0.6.1

### Patch Changes

- e2528cc: coclaw.info RPC 新增 clawVersion 字段，返回 OpenClaw 版本号（当上游 resolveVersion() 可用时）

## 0.6.0

### Minor Changes

- Add claim-bind (enroll) flow for OpenClaw-initiated binding; align gateway method error response format with OpenClaw protocol; fix shell mangling JSON params in gateway RPC calls

## 0.5.2

### Patch Changes

- fix(bridge): 从环境变量 OPENCLAW_GATEWAY_PORT 自动检测 gateway 端口，不再硬编码 18789。修复非默认端口的 OpenClaw 实例绑定后所有 RPC 失败（"Gateway is offline"）的问题。

## 0.5.1

### Patch Changes

- fix(plugin): coclaw.info 等待 ensureAllAgentSessions 完成后再响应，修复新 OC 实例首次连接时空 session 导致无法进入对话页面的问题

## 0.5.0

### Minor Changes

- 新增 chat 历史追踪与统一消息加载能力：
  - ChatHistoryManager：通过 session_start 钩子追踪 chat reset 产生的孤儿 session，持久化到 coclaw-chat-history.json
  - coclaw.chatHistory.list RPC：供 UI 查询指定 chat 的孤儿 session 链
  - coclaw.sessions.getById RPC：按 sessionId 返回完整 JSONL 行级消息（type + id + message），替代 nativeui.sessions.get
  - coclaw.info capabilities 新增 chatHistory
  - 修复 recordArchived 竞态：在 mutex 内先从磁盘重载，防止 list() 无锁覆写缓存导致数据丢失

## 0.4.1

### Patch Changes

- 新增 coclaw.topics.update gateway 方法，支持通过 RPC 更新 topic 标题；修复 changes 不含有效字段时静默成功的问题

## 0.4.0

### Minor Changes

- feat(plugin): add Topic management support

  - New `src/topic-manager/` module with `TopicManager` class (in-memory model + `coclaw-topics.json` persistence per agentId, using mutex + atomicWriteJsonFile)
  - New `src/topic-manager/title-gen.js` for AI-powered title generation (copy `.jsonl` transcript, invoke agent via gateway WS two-phase RPC, clean title text, update topic metadata, cleanup temp files)
  - Extended `realtime-bridge.js` with `__gatewayAgentRpc` method supporting agent() two-phase response protocol (accepted -> final), exposed via singleton `gatewayAgentRpc()`
  - Registered 7 new gateway methods: `coclaw.info`, `coclaw.topics.create`, `coclaw.topics.list`, `coclaw.topics.get`, `coclaw.topics.getHistory`, `coclaw.topics.generateTitle`, `coclaw.topics.delete`
  - `coclaw.info` returns plugin version and capabilities list for UI version/feature checking
  - Topic data stored at `~/.openclaw/agents/<agentId>/sessions/coclaw-topics.json`, leveraging OpenClaw's per-agent sessions directory isolation

## 0.3.2

### Patch Changes

- fix: declare tool-events capability for gateway connection, enabling tool call streaming events

## 0.3.1

### Patch Changes

- fix: bind 后 OpenClaw 始终离线的回归问题（需重启 gateway 才能上线）

## 0.3.0

### Minor Changes

- feat: add multi-agent session ensure support for OpenClaw nativeui.sessions.ensure gateway method

## 0.2.4

### Patch Changes

- 4f89f91: fix(plugin): add device identity to gateway WS connection for OpenClaw 3.12+ scope enforcement

  OpenClaw 3.12 introduced a security fix (CVE GHSA-rqpp-rjj8-7wv8) that strips scopes from WS connections without device identity. This caused `nativeui.sessions.listAll` and `agent.identity.get` calls to fail with "missing scope" errors.

  - Add `src/device-identity.js`: Ed25519 key pair generation, storage (`~/.openclaw/coclaw/device-identity.json`), and v3 auth payload signing
  - Modify `realtime-bridge.js`: capture nonce from `connect.challenge`, build signed `device` field in connect params
  - Device identity is auto-generated on first connection and cached for subsequent reconnects
  - Backward compatible with OpenClaw >= 2026.2.19

## 0.2.3

### Patch Changes

- realtime-bridge 心跳超时改为连续 miss 计数策略（4 次 ~3 分钟），避免大消息传输期间误断连

## 0.2.1

### Patch Changes

- fix: auto-upgrade logger 兼容 gateway pino 风格，修复 "log is not a function" 导致升级流程中断的问题

## 0.1.7

### Patch Changes

- - fix: prevent bot.unbound race condition and fix bridge reconnect after rebind
  - feat: auto-rebind on bind and add request timeouts
  - fix: strip operator-configured policy prefix in derivedTitle
  - fix: enhance derivedTitle cleaning for cron time and untrusted context
  - refactor: architecture cleanup before auto-upgrade feature

## 0.1.6

### Patch Changes

- fix: unbind 时无论 server 通知是否成功，都清理本地绑定信息，避免用户陷入无法 unbind 也无法 bind 的死锁状态

## 0.1.5

### Patch Changes

- Fix server URL resolution: correct plugin entries key, default to im.coclaw.net, unbind and realtime-bridge use bindings.json as authoritative source

## 0.1.4

### Patch Changes

- fix(plugin): session get returns empty messages instead of throwing when transcript file missing

## 0.1.3

### Patch Changes

- fix(plugin): handle missing .jsonl for agent:main:main sessionKey and ensure it exists on startup

## 0.1.2

### Patch Changes

- fix(plugin): align plugin id with npm package name (openclaw-coclaw)
