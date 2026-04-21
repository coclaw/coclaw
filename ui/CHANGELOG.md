# @coclaw/ui

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
