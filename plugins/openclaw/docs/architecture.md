# Plugin 架构总览

> 给未来的 agent 看：这是一份"读 src 之前先读这个"的地图。
> 想看硬约束去 `../CLAUDE.md`；这里只讲 **谁是谁、谁连谁、状态在哪儿**。

## 一句话定位

CoClaw OpenClaw 插件运行在 **OpenClaw gateway 进程内**，把"远端 CoClaw server"和"本地 OpenClaw gateway/agent"双向桥起来——server 通过它远程调 OpenClaw RPC，UI 通过它直连 plugin 的 WebRTC DataChannel 走低延迟通道。

## 通信拓扑

```
   ┌──────────────────────┐
   │ CoClaw UI            │
   │ (web / mobile)       │
   └──┬────────┬──────────┘
      │        │
      │ HTTP/WS to server     │ WebRTC DataChannel
      │ (signaling, fallback) │ (rpc DC + file DC, P2P via TURN)
      ▼                       ▼
   ┌──────────────────────┐   ┌──────────────────────┐
   │ CoClaw server        │   │                      │
   │ (cloud)              │   │                      │
   └──┬───────────────────┘   │                      │
      │ server WS                                    │
      │ /api/v1/claws/stream  ◄──── plugin 主动发起 ──┘
      │ (token + device sig)        WebRTC offer/answer
      ▼                              转发也走这条
   ┌──────────────────────────────────────────────────┐
   │ realtime-bridge (插件内)                          │
   │ - 一头连 CoClaw server WS（远端）                  │
   │ - 一头连 OpenClaw gateway WS（本地 RPC + 事件流）  │
   │ - WebRtcPeer：管理多条 PeerConnection            │
   └──┬────────────────────────┬──────────────────────┘
      │ gateway RPC             │ DC frames
      │ /openclaw 内部 ws       │ rpc DC: JSON-RPC 帧
      ▼                         │ file DC: 字节流 (per-transfer)
   ┌──────────────────────┐    ▼
   │ OpenClaw gateway     │   ┌──────────────────────┐
   │ + embedded agent     │   │ DC 远端              │
   │ (同进程，本插件嵌入)   │   │ = CoClaw UI         │
   └──────────────────────┘   └──────────────────────┘
```

**关键事实**：
- 插件 = OpenClaw gateway 内的一个 channel plugin，**不独立成进程**；但 plugin 内的 server WS 是它"主动出去"的连接。
- WebRTC 信令走 server WS 转发，建好后 DC 直连 UI（P2P + TURN），plugin 是被叫方（UI 发 offer，plugin 回 answer）。
- gateway RPC 调用走的是另一条本地 WebSocket（plugin → gateway，同进程内 ws），不是直接函数调用——这是 OpenClaw 的设计。

## 模块地图（src/ 目录 → 职责）

| 目录/文件 | 职责 |
|---|---|
| `index.js` | 入口。register 模式分叉；启动 managers / bridge service / RPC handlers；patch `embeddedRunState.activeRuns` 做 abort 诊断 |
| `channel-plugin.js` | 向 OpenClaw 注册 channel `coclaw`。`outbound.sendText` 是**占位符**，真正消息走 realtime-bridge |
| `cli-registrar.js` | `/coclaw` IM 斜杠命令 + `openclaw coclaw …` 子命令。瘦 CLI，逻辑在 RPC handler / 共享层 |
| `realtime-bridge.js` | **核心**。双 WS 桥接 + WebRTC 信令路由 + 设备握手 + 心跳 + 退避重连 + agent run lag probe + plugin event 广播 |
| `runtime.js` | 暴露 `setRuntime` / `getRuntime` 单例，full 模式下注入 `api.runtime` |
| `api.js` | 与 server 的 REST 客户端封装（bind / unbind / claim-codes） |
| `config.js` / `settings.js` | bindings.json / settings.json 的唯一读写入口（每个独立的 mutex） |
| `device-identity.js` | ed25519 设备身份 + 握手负载签名（v3 握手） |
| `remote-log.js` | 关键诊断信息推送到 server（仅状态翻转点 / 关键事件） |
| `plugin-version.js` | 读取 `package.json` 拿 plugin 版本，握手 / `coclaw.info` / 升级判断都用 |
| `platform-info.js` | OS / 架构 / Node 版本组装为单行 string，握手携带 |
| `agent-abort.js` | 通过侧门（`Symbol.for('openclaw.embeddedRunState')`）真正取消正在跑的 run |
| `agent-cancel-heuristic.js` | abort 返回 `not-found` 时双闸启发式（runDuration ≥3min + abortDuration ≥1min）升格成 `gone` |
| `transport-adapter.js` | 占位预留（未来若改走 channel outbound 接口接收消息）。当前不在主路径 |
| `message-model.js` | inbound/outbound envelope 规范化。当前主要给 transport-adapter 用 |
| `common/claw-binding.js` | bind / unbind / enroll 的**共享层**——RPC handler + IM 命令共用 |
| `common/errors.js` | 错误归一化 + `respondError` / `respondInvalid` helper |
| `common/messages.js` | 用户可见的提示文案（i18n 字符串） |
| `common/gateway-notify.js` | 给 OpenClaw chat 注入系统消息（绑定成功提示等） |
| `session-manager/` | OpenClaw embedded session 的列表/查询封装（给 `nativeui.sessions.*`） |
| `topic-manager/` | CoClaw topic（独立对话）CRUD + 标题生成。每 agent 一份 `coclaw-topics.json` |
| `chat-history-manager/` | sessionKey 下的 session 流水。双源汇入（hook + sessions.changed reason=create），首位未归档 item = 当前活跃 session。详见数据流 §F |
| `file-manager/` | UI 文件浏览 + 上传 + 下载。per-agent workspace 沙箱 + 路径穿越校验 + 独立 file DC 流式传输 |
| `auto-upgrade/` | 每小时巡检 npm 新版，worker 子进程做 install + verify + gateway restart。锁文件防并发 |
| `webrtc/webrtc-peer.js` | 多 PeerConnection 管理（per connId）+ rpc DC / file DC 装配 + ICE restart 复用 |
| `webrtc/dc-chunking.js` | rpc DC 应用层分片/重组（5 字节头 = 1 flag + 4 msgId BE）。详见 `rpc-dc-send-queue.md` |
| `webrtc/memory-queue` (`utils/memory-queue.js`) | rpc DC 入队侧：admission（10MB 软上限） + drop 状态机 + bypassAdmission 白名单 |
| `webrtc/rpc-dc-sender.js` | rpc DC 出队侧：阻塞式 send（HWM/LWM 流控） + 分片协议适配 |
| `webrtc/agent-run-response.js` | 识别 agent run 类 RPC 响应，给 admission 白名单用 |
| `webrtc/rpc-drop-monitor.js` | drop 计数 + 翻转点上报 |
| `webrtc/pion-preloader.js` | pion-node SDK 初始化（主力实现） |
| `rpc-routing/run-event-routes.js` | runId → connId 路由表，`event:agent` 帧按发起方 DC 单播。详见 `rpc-routing.md` |
| `webrtc/ndc-preloader.js` | 历史路径，依赖已摘除，运行不命中（待清理） |
| `utils/atomic-write.js` | atomic 写文件：write to tmp → rename。所有插件文件 IO 必走 |
| `utils/mutex.js` | per-file 互斥锁（read-modify-write 必加锁） |
| `utils/memory-queue.js` / `utils/file-backed-queue.js` | 流控用的内存队列 / 磁盘回退队列（FBQ 已实现，rpc DC 集成待) |

## 三种"接入"模式（OpenClaw 调插件 register 的形态）

`api.registrationMode`：
- **`cli-metadata`**：CLI 启动时只问"有哪些根命令"。仅 `registerCli`，**不动副作用**。
- **discovery**（每 14s 一次）：channel + CLI 元信息采集；不应启 service / RPC。
- **`full`**：真正的 plugin 生命周期。所有 service / RPC handler / hook / managers / 磁盘 IO 在这里启。

`index.js` 的 `mode !== 'full'` early return 是关键守卫——同时也只有 full 模式调 `setRuntime(api.runtime)`，避免 discovery 的空 runtime 擦掉真 runtime。

## 数据流速查

**A. 用户从 UI 发消息**
```
UI -[server WS]→ server -[server WS]→ bridge
   bridge -[gateway WS RPC `chat.send`]→ OpenClaw gateway
   OpenClaw 触发 agent run, 事件流回 bridge
   bridge 把事件帧广播到所有 connected DC
UI ←[rpc DC]── bridge        (低延迟主路径)
UI ←[server WS]── server     (DC 不通时的兜底)
```

**B. UI 文件浏览**
```
UI -[rpc DC, JSON-RPC `coclaw.files.list`]→ bridge
   onFileRpc 转 fileHandler.handleRpcRequest
   fileHandler 读盘 → 回 res 帧
UI ←[rpc DC]── bridge        (server 完全不参与)
```

**C. 用户跑 bind**

两条入口都共享 `common/claw-binding.js` 里的 `doBind()`：

```
IM 斜杠命令 /coclaw bind <code>:
  registerCommand handler 直接调 doBind()
  → bindClaw() POST server REST → bindings.json 写入 → bridge restart

bash CLI `openclaw coclaw bind <code>`:
  cli-registrar 调 callGatewayMethod('coclaw.bind', ...)
  → gateway 内 RPC handler 调 doBind()
  → 同上
```

斜杠命令在 plugin 进程内直调 `doBind`（不经 RPC）；外部 CLI 必须经 gateway RPC，因为 CLI 进程不能直接动 bindings.json。

**D. agent run 取消**
```
UI -[STOP rpc]→ bridge `coclaw.agent.abort`
   abortAgentRun(sessionId) 走侧门 activeRuns.get(sessionId).abort()
   返回 ok / not-found / not-supported
   not-found 时叠 cancel-heuristic 双闸 → gone
```

**E. plugin 自发事件广播**
```
plugin 内某动作（如 coclaw.info.patch 改名）
   broadcastPluginEvent(event, payload)
   ├─ server WS 发 { type:'event', event, payload }
   └─ 所有 connected rpc DC 广播同形帧
server / UI 各自按 patch 语义更新本地缓存（未在 payload 出现的字段不动）
```
事件清单与字段约定见 `plugin-events.md`。

**F. chat-history 双源归档（session 流水追踪）**

session_start hook 与 gateway 推的 `sessions.changed (reason=create)` 是两条互补来源——`agent.send` 走自动 reset 触发新 session 时 OpenClaw 当前**只 emit 后者**（hook 漏），双源相加才能不漏归档。两条都汇入 `index.js#handleSessionCreated`，由 `chatHistoryManager.recordSessionTransition` 以幂等 + per-agent mutex 串行落盘。

```
[A] session_start hook              ──┐
    event = { sessionKey,             │
              sessionId(new),         │
              resumedFrom(old?) }     ├─→ handleSessionCreated(...)
    ctx.agentId（hook 路径优先）       │     ├─ recordSessionTransition({
                                      │     │     agentId, sessionKey,
[B] sessions.changed reason=create  ──┘     │     currentSessionId,
    bridge __sendSessionsSubscribe()        │     archivedSessionId? })
    握手成功后订阅，每次重连重订            ├─ mutex.withLock(agentId)
    onSessionCreated callback by index.js   ├─ __reloadFromDisk
                                            └─ atomic write
                                            (head=current 未归档；其后 archived 新→旧)
```

幂等 / 防错位：
- 完全 no-op：head 已是 currentSessionId 且无新 archivedSessionId 要追加。
- stale 防御：currentSessionId 已存在于 list 其他位置（已归档项）→ 视为晚到事件丢弃，不动 head（避免把当前活跃头错翻成归档 + sid 重复）。
- 双源到达顺序无关；mutex 串行 + per-write atomic write。

RPC 契约：`coclaw.chatHistory.list` **透传整个 list（含首位未归档头）**，不做服务端过滤。调用方（UI / 其它消费者）按 `archivedAt != null` 自行过滤当前活跃头与孤儿历史段。

失败处理与重连：
- gateway 端订阅按 connId 注册；WS close 时自动 `unsubscribeAllSessionEvents` → **每条新 WS 都必须重新发送 subscribe**。bridge 在每次握手成功分支调用一次，不区分首次 / 重连。
- 调用 timeout 60s（容忍 gateway 重启卡主线程的真实场景）。subscribe 失败仅 warn + remoteLog 一次（gateway handler 无业务失败分支，失败只可能源自传输层），同条 WS 内不重试；下次 WS 重连握手成功时自然再发——无 sticky 阻止。
- 上游事件源补充：topic 走 transcript-update 链路发的是 `sessions.changed phase=message`（**无 reason 字段**），与本路径严判 `payload.payload?.reason === 'create'` 不匹配会被过滤掉，不会污染 chat-history。

文件 schema：见 §"状态在哪儿"中 `coclaw-chat-history.json` 行。

版本要求与回滚警告详见 `.changeset/chat-history-dual-source-archival.md`（仓库根）。

## 状态在哪儿（持久化文件清单）

| 路径 | 内容 | 写入入口 |
|---|---|---|
| `~/.openclaw/coclaw/bindings.json` | server 绑定（token, clawId, serverUrl, boundAt） | `config.js` |
| `~/.openclaw/coclaw/settings.json` | 插件设置（claw name 等） | `settings.js` |
| `~/.openclaw/coclaw/device-identity.json` | ed25519 设备私钥 | `device-identity.js` |
| `~/.openclaw/coclaw/upgrade.lock` + `upgrade-state.json` | 自动升级锁 + 状态 | `auto-upgrade/state.js` |
| `~/.openclaw/agents/<agentId>/sessions/coclaw-topics.json` | topic 列表 | `topic-manager/manager.js` |
| `~/.openclaw/agents/<agentId>/sessions/coclaw-chat-history.json` | sessionKey 的 session 流水（首位未归档头 = 当前；其余按新→旧带 `archivedAt`） | `chat-history-manager/manager.js` |

**file workspace 不在插件管辖**——`file-manager` 操作的目录由 OpenClaw 通过 `agents.files.list` RPC 返回（`realtime-bridge.js __resolveWorkspace`）。具体路径取决于 OpenClaw 配置，不写死在插件里。

**state 目录解析**：上表 `~/.openclaw/coclaw/...` 是默认值。实际取自 `runtime.state.resolveStateDir()`（gateway 进程内）→ `OPENCLAW_STATE_DIR` env（worker 子进程）→ 兜底 `~/.openclaw`，再拼 `coclaw/<filename>`。见 `config.js` / `auto-upgrade/state.js`。

**bindings 为何不存 `openclaw.json`**：卸载插件后 `channels.coclaw` 节点会残留导致 schema 验证失败。详见 CLAUDE.md。

## 已停用 / 占位代码（别花时间去读）

未来 agent 扫到这些会以为是主路径，先在这里劝退一下：

- `webrtc/ndc-preloader.js`：node-datachannel 路径。npm 依赖 + vendor 预编译包 2026-04-19 已摘除，运行时必走 fallback 到 werift。代码保留只是"过渡期失败锚点"，待整体清理时一并删。判断 plugin 行为时**只考虑 pion + werift fallback**，不必再为 ndc 推算资源/兼容性。
- `transport-adapter.js` + `message-model.js`：预留给"未来通过 OpenClaw channel outbound 接口收发消息"的适配层。当前主路径**不经过它**——所有消息走 realtime-bridge 的 server WS。改 inbound/outbound 行为时不要在这里改。
- `channel-plugin.js` 的 `outbound.sendText`：占位符，仅满足 OpenClaw channel 注册要求。它返回的 messageId 用不上。

## 关键陷阱速查（具体见对应 doc 或 CLAUDE.md）

- **register 入口必须区分模式**——cli-metadata / discovery 不能启 service。
- **hook 与 RPC handler 在 `--link` 模式下是不同模块实例**——不能靠内存共享状态。
- **bridge 与 server WS 断连不应 closeAll WebRTC session**（DC 走 P2P 独立信令通道）。预存问题，见 `../TODO.md`。
- **rpc DC 必须自建分片**——pion / werift 都不提供透明的应用层大消息分片。
- **agent run 类 RPC 响应需绕过 admission 软上限**——否则网络降级时 UI 收不到 endRun 信号 → phantom run。

## 何时来读这份 doc

- **新增模块**前：先看模块地图，避免把职责放到错的层。
- **跨模块改动**前：先看通信拓扑 + 数据流，弄清边界。
- **加新 RPC method / 新 DC 帧类型**前：先看现有路径在哪一段处理，沿用相同套路。
- **写架构相关 commit message** 时：用本 doc 的术语保持一致。
