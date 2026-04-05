# CoClaw OpenClaw 插件开发约定

> 适用范围：`coclaw/plugins/openclaw` 及其子目录。
> 本文件仅写相对上级 `coclaw/AGENTS.md` 与 `coclaw/plugins/AGENTS.md` 的增量规则。

## 当前结构

- `src/` 根 — 核心模块（平铺）
  - `channel-plugin.js` — channel 注册（OpenClaw channel 插件实现）
  - `realtime-bridge.js` — CoClaw server ↔ OpenClaw gateway WebSocket 桥接
  - `transport-adapter.js` — 消息收发适配层
  - `message-model.js` — 消息格式转换
  - `config.js` — 绑定信息读写（唯一入口）
  - `settings.js` — 插件设置读写（claw name 等，存储于 `~/.openclaw/coclaw/settings.json`）
  - `api.js` — CoClaw server HTTP API 封装
  - `cli-registrar.js` — OpenClaw `registerCli` 注册（`openclaw coclaw bind/unbind/enroll`）
  - `plugin-version.js` — 插件版本号读取（缓存）
  - `runtime.js` — OpenClaw runtime 引用管理
- `src/webrtc/` — WebRTC 传输层
  - `webrtc-peer.js` — 多 PeerConnection 管理（以 connId 为粒度，插件作为被叫方）
  - `ndc-preloader.js` — node-datachannel 预加载 + werift 回退
  - `dc-chunking.js` — DataChannel 应用层分片/重组协议
- `src/auto-upgrade/` — 自动升级模块（仅 npm 安装模式生效）
  - `updater.js` — 调度入口（延迟首次 + 周期轮询 + 升级锁）
  - `updater-check.js` — 版本检查（npm view）+ `getPackageInfo()`
  - `updater-spawn.js` — spawn detached worker 进程
  - `worker.js` — 独立进程：备份 → `openclaw plugins update` → 验证 → 回滚
  - `worker-backup.js` — 备份与恢复
  - `worker-verify.js` — 升级后验证（gateway + 插件 + health）
  - `state.js` — upgrade-state.json / upgrade-log.jsonl 读写
- `src/chat-history-manager/` — chat 历史追踪（session reset 产生的孤儿 session 链）
- `src/session-manager/` — 会话读取能力（`nativeui.sessions.listAll/get`、`coclaw.sessions.getById`）
- `src/file-manager/` — 文件操作（沙箱化，支持 WebRTC DC 和 WS 双路径）
- `src/utils/` — 通用工具（零外部依赖）
  - `atomic-write.js` — 原子文件写入（tmp+rename）
  - `mutex.js` — 进程内异步互斥锁（Promise 链 FIFO）
- `src/common/` — 共享逻辑
  - `claw-binding.js` — bind/unbind 核心逻辑
  - `errors.js` — 错误码与消息映射
  - `gateway-notify.js` — gateway RPC 通知（spawn `openclaw gateway call`）
  - `messages.js` — 用户提示文本

## 绑定信息存储

- 绑定信息存储在 **`~/.openclaw/coclaw/bindings.json`**（通过 `resolveStateDir()` + channel ID 组合路径），**不存储在 `openclaw.json` 中**。
- 这是为了避免卸载插件后 `channels.coclaw` 节点残留导致 OpenClaw gateway 无法启动。
- 文件结构为以 account ID 为 key 的对象，当前只使用 `default`：
  ```json
  {
    "default": {
      "serverUrl": "https://...",
      "clawId": "claw-xxx",
      "token": "token-xxx",
      "boundAt": "2026-03-04T..."
    }
  }
  ```
- 禁止将绑定信息写入 `openclaw.json` 的 `channels.coclaw` 或 `plugins.entries.openclaw-coclaw.config`。
- `config.js` 是读写绑定信息的唯一入口，禁止在其他模块中直接操作 bindings 文件。
- `settings.js` 是读写插件设置（claw name 等）的唯一入口，存储于同目录的 `settings.json`。设置独立于绑定信息，解绑后重新绑定不会丢失。
- 环境变量 `COCLAW_SERVER_URL` 可覆盖 serverUrl（运行时覆盖，不影响存储）。

## Logger 规范

- OpenClaw gateway 提供的 logger 是 pino 风格，有 `.info()` / `.warn()` / `.error()`，**没有 `.log()` 方法**。
- 插件代码中所有日志调用必须使用 `.info?.()` / `.warn?.()` / `.error?.()` 等带可选链的调用，**禁止使用 `.log()`**，也禁止将 logger 当函数直接调用（如 `logger('msg')`）。
- 可选链 `?.()` 确保即使 logger 缺少某方法或 logger 本身为 undefined，也不会抛异常中断正常流程。

## remoteLog 远程日志

- `remoteLog(text)` 函数（`src/remote-log.js`）用于将**重要诊断信息**推送到 CoClaw server，供开发者远程排查问题。
- 仅用于输出对远程诊断有价值的关键事件（如连接状态变更、ICE 候选汇总、认证失败等），**禁止用于高频/冗余日志**（如逐条消息收发、心跳计数等）。
- 工作原理：写入内存环形缓冲区，后台微任务通过 `RealtimeBridge` 的 WebSocket 连接发送到 server。
- **禁止在 auto-upgrade worker 进程中使用**：worker 是独立 spawn 的子进程，没有 bridge 连接。
- 日志格式约定：`<模块>.<事件> key=value key=value`，如 `rtc.state conn=abc123 connected`。

## 文件 I/O 安全规范

- **禁止裸 `fs.writeFile`**：写入插件自管文件时，必须使用 `atomicWriteFile` 或 `atomicWriteJsonFile`（`src/utils/atomic-write.js`），防止写入过程中崩溃导致文件损坏。
- **read-modify-write 必须加锁**：对同一文件的读取→修改→写回操作必须在同一个 `mutex.withLock()` 内完成（`src/utils/mutex.js`）。每个需要保护的文件应有独立的 mutex 实例，由使用侧创建和管理。
- **纯只读可不加锁**：仅读取、不基于结果做写入决策时，可以不加锁（最多读到略旧快照）。
- **fire-and-forget 必须 `.catch()`**：对 `withLock()` 返回的 Promise 若不 await，必须 `.catch()` 防止 unhandled rejection 导致 gateway 崩溃。
- **禁止嵌套同一把锁**：在 `withLock(fn)` 的 fn 内再调同一个 mutex 的 `withLock` 会死锁。
- **fn 应尽量短**：长时间持锁会阻塞后续操作。

## DataChannel 应用层分片/重组

插件通过 WebRTC DataChannel 传输 JSON-RPC 消息和文件数据。DataChannel 底层基于 SCTP，但**两个 WebRTC 库均不提供透明的应用层大消息分片**，因此插件自建了分片/重组协议（`src/webrtc/dc-chunking.js`）。

### 为什么不能依赖库的 SCTP 分片

- **node-datachannel**（主力）：`send()` 直通 libdatachannel 原生层。消息超过远端 SDP 声明的 `a=max-message-size` 时，libdatachannel 直接抛异常。SCTP 传输层的分片（将一条 SCTP 消息拆成多个 IP 包）是透明的，但 `max-message-size` 是应用层硬上限——超过即拒绝，不会自动切分。
- **werift**（回退）：SCTP 层确实按 1200 字节自动分片并透明重组，`send()` 可传任意大小消息。但它在 SDP 中声明 `max-message-size: 65536`，远端（浏览器或 node-datachannel）会按此限制拒收超大消息。即使 werift 侧不报错，远端仍会丢弃。

### 两条 DataChannel 路径的分片策略

- **rpc DC**（`label="rpc"`）：使用 `dc-chunking.js` 的 `chunkAndSend` / `createReassembler` 做应用层分片和重组。分片阈值取自远端 SDP 的 `a=max-message-size`（`webrtc-peer.js` 解析）。
- **file DC**（`label="file:<transferId>"`）：不经过 `dc-chunking`。每个文件传输使用独立的专用 DataChannel，由 `file-manager/handler.js` 实现流式传输 + 背压控制，不需要 JSON 消息的分片/重组。

### 维护约束

- `dc-chunking.js` 是必要组件，不可删除或替换为库内置能力——当前两个库均无此能力。
- 若未来升级 WebRTC 库版本，需重新验证其 `send()` 对超限消息的行为是否变更。
- 分片协议格式（5 字节头：1 flag + 4 msgId BE）需与 UI 端保持一致，变更须双端同步。

## Gateway RPC 方法命名

- OpenClaw 将方法名视为**扁平字符串 key**（无命名空间路由），"." 仅为约定分隔符，无特殊语义。唯一硬约束：不能为空、不能与已注册方法重名。
- 新注册的方法统一使用 **`coclaw.`** 前缀（符合 OpenClaw 官方约定 `pluginId.action`）。
- 历史方法 `nativeui.sessions.listAll` / `nativeui.sessions.get` 暂保留以兼容。

### Scope 与权限

- OpenClaw 对每个 gateway method 有 scope 分类（`method-scopes.ts`）。**未被分类的方法（包括所有插件注册的方法）默认要求 `operator.admin` scope**。
- 当前所有调用路径均持有 `operator.admin`：
  - bridge 自身的 gateway WS 连接（`realtime-bridge.js` 中显式声明 `scopes: ['operator.admin']`）
  - CLI `openclaw gateway call`（默认使用 `CLI_DEFAULT_OPERATOR_SCOPES`，含 `operator.admin`）
  - gateway 内部 synthetic client（含 `operator.admin`）
- 因此当前无 scope 问题。但若未来需要支持非 admin scope 的调用者直接调用插件方法，需向 OpenClaw 的 `METHOD_SCOPE_GROUPS` 表注册所需 scope，否则会被 fallback 到 admin 拦截。
- **已知设计特征**：bridge 以自身 `operator.admin` 身份转发 CoClaw server 发来的所有请求，server 实质拥有 admin 级 gateway 权限（设计预期，server 是受信方）。

## Hook 与 Gateway Method 的模块实例隔离

- OpenClaw 在 `--link` 安装模式下，`api.on()` 注册的 hook 回调和 `api.registerGatewayMethod()` 注册的 RPC handler **可能运行在不同的 ESM 模块实例中**（即使同一进程、同一 `register()` 调用）。原因是 symlink 导致 ESM 模块缓存命中不同 URL。
- **后果**：hook 和 RPC handler 闭包捕获的对象（如 Manager 实例）看似同一个，实际是两份独立的内存拷贝。hook 修改的内存状态对 RPC handler 不可见。
- **应对**：需要跨 hook/RPC 共享的状态，不能依赖纯内存缓存，必须通过磁盘文件中转。读取侧（如 RPC handler）每次调用前从磁盘重载。
- `api.on()` 在某些调用上下文（如 CLI 模式的 mock API）中可能不存在，注册时须加 `typeof api.on === 'function'` 防御。

## 约束

- bind/unbind/enroll 的 CLI 命令均为瘦 CLI：仅做参数解析 → `callGatewayMethod` RPC → 结果展示。核心逻辑在 gateway 内的 RPC handler 中执行。
- 所有 bind/unbind 核心逻辑必须集中在共享层（`common/claw-binding.js`），RPC handler 与斜杠命令 handler 共享同一内部函数（`doBind`/`doUnbind`）。
- gateway methods（`coclaw.bind` / `coclaw.unbind` / `coclaw.enroll` / `coclaw.upgradeHealth` / `coclaw.info` / `coclaw.info.get` / `coclaw.info.patch` / `nativeui.sessions.listAll/get` / `coclaw.topics.*` / `coclaw.chatHistory.list` / `coclaw.sessions.getById` / `coclaw.files.list` / `coclaw.files.delete` / `coclaw.files.mkdir` / `coclaw.files.create`）仅由本插件提供，禁止重复注册同名方法。
- gateway method 错误响应格式：`respond(false, undefined, { code, message })`。使用 `respondError(respond, err)` 处理异常，`respondInvalid(respond, message)` 处理参数校验失败。禁止使用旧格式 `respond(false, { error })`。
- realtime bridge（`coclaw-realtime-bridge`）和 auto-upgrade scheduler（`coclaw-auto-upgrade`）必须通过 `api.registerService()` 注册为 gateway service，**禁止在 `register()` 中直接启动**。原因：`register()` 在 CLI 上下文（如 `openclaw plugins install/uninstall`）也会被调用，直接启动会创建 WebSocket 连接或定时器导致进程无法退出。
- CLI bind/unbind 通过 gateway RPC（`coclaw.bind`/`coclaw.unbind`）执行，gateway 内部管理 bridge 生命周期，**禁止在 CLI 进程中直接操作 `bindings.json`**。
- unbind 是强制操作（非 best-effort）：server 不可达时 unbind 失败，不清理本地 config，避免产生孤儿 bot。server 返回 401/404/410 视为 bot 已不存在，允许继续。
- 插件运行在 gateway 进程中，严禁引入全局异常兜底（如 `process.on('uncaughtException'/'unhandledRejection')`）。

## Plugin 自发事件

插件可通过 `broadcastPluginEvent(event, payload)`（`realtime-bridge.js` 导出）向 server 和所有已连接的 UI DC 广播事件。事件帧格式与 gateway 事件一致：`{ type: 'event', event, payload }`。

当前注册的事件：

| 事件名 | 触发时机 | payload |
|--------|---------|---------|
| `coclaw.info.updated` | gateway connect 成功后 / `coclaw.info.patch` 修改 name 后 | `{ name: string\|null, hostName: string }` |

- Server 收到 `coclaw.info.updated` 后持久化 `bot.name`，不转发给 UI WS
- UI 通过 DC 直接收到事件，更新 `pluginInfo.name` / `pluginInfo.hostName`

## 测试门禁（强制）

执行顺序：
1. `pnpm check`（静态检查）
2. `pnpm test`（测试 + 覆盖率）

> `pnpm verify` = check + test，仅由 release 脚本内部调用，日常开发分步执行上述两条即可。

覆盖率阈值：
- lines 100%
- functions 100%
- branches 95%（`??` / `?.` fallback 分支不强制覆盖）
- statements 100%

覆盖率未通过，禁止安装到 gateway。

### 执行约束

- `pnpm test` **禁止以后台模式执行**，必须前台运行并设置充足超时（≥ 120s）
- 发起新一轮测试前，必须确认上一轮已结束；若超时，先 `ps aux | grep -E 'node.*test|vitest'` 检查并 kill 残留进程，再重试
- 禁止并发启动多个 test runner——并发执行会因资源竞争导致进程堆积、主机卡顿

## 文档同步

插件改动必须同步：
- `plugins/openclaw/STATUS.md`
- `plugins/openclaw/README.md`
- 以及 `docs/` 下相关决策文档

## 本地更新（简要）

- 本地开发采用 `plugins install --link` 一次性接入；后续代码更新默认只 `openclaw gateway restart`。
- 避免把 `uninstall + 删除 extensions + reinstall` 作为日常流程。
- **命名陷阱**：CLI 参数叫 `--link`，但 OpenClaw 在 `openclaw.json` 中记录的 `source` 值为 `"path"`（与普通目录安装相同），没有 `"link"` 值。区分方式是 `sourcePath === installPath` 表示 link 模式。脚本层（`scripts/_lib.sh` 的 `get_install_mode()`）已做转换，对外统一返回 `"link"`。
- 详细流程与故障恢复见：`plugins/openclaw/docs/local-plugin-update-sop.md`。
