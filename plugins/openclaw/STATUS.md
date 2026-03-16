# OpenClaw Plugin STATUS

## 当前状态（2026-03-12）

- 插件工作区：`plugins/openclaw`，已稳定运行。
- 对外标识：
  - npm 包名：`@coclaw/openclaw-coclaw`；plugin id：`openclaw-coclaw`
  - channel：`coclaw`
  - CLI 子命令：`coclaw`（`openclaw coclaw bind/unbind`）
- 单一入口 `index.js` 同时注册：
  - channel（coclaw）
  - services：`coclaw-realtime-bridge`（WebSocket 桥接）、`coclaw-auto-upgrade`（自动升级调度）
  - command（`/coclaw bind/unbind`）
  - gateway methods（`coclaw.refreshBridge` / `coclaw.stopBridge` / `coclaw.upgradeHealth` / `nativeui.sessions.listAll` / `nativeui.sessions.get`）
  - CLI（`openclaw coclaw bind/unbind`）
- 绑定信息存储在 `~/.openclaw/coclaw/bindings.json`（独立于 `openclaw.json`）。
- 升级状态存储在 `~/.openclaw/coclaw/upgrade-state.json`，升级日志在 `upgrade-log.jsonl`。
- 测试门禁：`pnpm verify` 通过，覆盖率 lines/statements/functions 100%，branches ≥ 95%。

## 关键里程碑

### 原子文件操作基础设施（2026-03-16）
- 新增 `src/utils/` 目录，包含两个零依赖工具模块：
  - `atomic-write.js` — `atomicWriteFile(filePath, content, opts?)` / `atomicWriteJsonFile(filePath, value, opts?)`，基于 tmp+rename 模式防崩溃写损。
  - `mutex.js` — `createMutex()` 返回 `{ withLock(fn) }`，基于 Promise 链的进程内 FIFO 互斥锁，防 async 并发交错导致 lost update。
- 参照 OpenClaw `writeTextAtomic` / `createAsyncLock` 实现，为后续 topic 等功能的状态文件读写提供安全保障。
- 设计文档：`docs/atomic-file-ops.md`。
- CLAUDE.md 新增"文件 I/O 安全规范"章节。

### 自动升级功能（2026-03-12）
- 新增 `src/auto-upgrade/` 模块（7 个文件）：`state.js`、`updater.js`、`updater-check.js`、`updater-spawn.js`、`worker.js`、`worker-backup.js`、`worker-verify.js`。
- **调度**：gateway 启动后延迟 5~10 分钟首次检查，之后每 1 小时检查一次（通过 `npm view` 查询 registry）。
- **升级流程**：spawn detached node 进程执行 backup → `openclaw plugins update` → 验证 → 成功清理/失败回滚。
- **安全机制**：仅对 `source === "npm"` 的安装生效；link/archive 模式跳过。失败版本记入 `skippedVersions`，后续自动跳过。备份采用原子 rename。
- **验证标准**：gateway running + 插件已加载 + `coclaw.upgradeHealth` 可响应。
- **新增 gateway method**：`coclaw.upgradeHealth` — 返回当前插件版本号。
- **新增 service**：`coclaw-auto-upgrade` — 自动升级调度器生命周期管理。
- 详见设计文档 `docs/auto-upgrade.md`。

### 心跳高容忍改造（2026-03-13）
- **问题**：大消息（如含 base64 图片的 agent 请求）传输时，应用层心跳 ping/pong 被排在大消息后面（TCP FIFO），导致 45s 超时误判断连。Plugin 侧无法可靠感知"对方正在给我发大消息"（标准 WebSocket API 无此能力）。
- **方案**：将单次 45s 超时改为连续 miss 计数策略：每 45s 无消息计为 1 次 miss，连续 4 次（~3 分钟）才断连。收到任意消息立即重置 miss 计数。
- 新增常量 `SERVER_HB_MAX_MISS = 4`，新增方法 `__onServerHbMiss(sock)`，miss 期间补发 ping。
- 详见 `docs/architecture/websocket-heartbeat.md`。

### v0.2 整改 Stage 5（Plugin 心跳）（2026-03-11）
- `realtime-bridge.js` 新增应用层心跳：plugin→server WS 连接每 25s 发送 `{ type: "ping" }`，45s 无任何消息则判定超时并关闭连接。
- 新增方法：`__startServerHeartbeat(sock)` / `__resetServerHbTimeout(sock)` / `__clearServerHeartbeat()`。
- 心跳集成到 WS 生命周期：`open` → 启动，每条 `message` → 重置超时，`close`/`error`/`stop` → 清理。
- 覆盖率恢复达标：lines/statements/functions 100%，branches 97.02%（阈值 95%）。

### 脚本体系重建（2026-03-10）
- **重写 `scripts/` 目录**：删除全部旧脚本（不可靠），基于 OpenClaw 源码分析重新设计。
- **共享库 `_lib.sh`**：`get_install_mode()` 通过读取 `openclaw.json` 中 `plugins.installs` 的 `source` 字段检测安装模式（link/npm/archive/none），`ensure_uninstalled()` 安全卸载不清理 bindings。
- **模式切换脚本**：`link.sh` / `unlink.sh` / `install-npm.sh` / `uninstall-npm.sh`，支持从任意状态切换，自动处理卸载→重装→restart→验证。
- **预发布验证 `prerelease.sh`**：`npm pack` → 安装 tarball → 验证 → 恢复。支持 `--upgrade`（先装 npm 旧版再覆盖）和 `--auto`（非交互模式）。
- **发布脚本 `release.sh`**：集成预发布验证 + npm 发布 + 轮询确认生效。
- **版本检查 `release-check.sh`**：显示 npm/npmmirror 最新版本，支持 `WAIT=1` 轮询模式。
- **关键发现**：OpenClaw `plugins install/update/uninstall` CLI 本身不调用 gateway restart，但 gateway 通过 chokidar 监听 `openclaw.json` 变更，`plugins.*` 路径的变更会自动触发全量重启（`gateway.reload.mode` 默认 `"hybrid"`）。`install` 不支持覆盖已安装插件（需先 uninstall），`update` 仅支持 `source: "npm"` 的插件。脚本中保留显式 restart 作为保险。
- **OpenClaw 插件管理机制文档**：新增 `docs/openclaw-plugin-management.md`，记录三种安装模式、config 结构、install/uninstall/update 行为细节、gateway 自动重启机制。

### 架构梳理与代码清理（2026-03-10）
- **realtime-bridge 重构为 `RealtimeBridge` 类**：所有连接状态从模块级变量封装为实例属性，便于生命周期管理、测试和未来自动升级支持。对外模块 API（`restartRealtimeBridge` / `stopRealtimeBridge`）仅暴露两个操作。
- **移除 c8 ignore 整文件包裹**：realtime-bridge.js 不再整文件排除覆盖率统计，改为对具体防御性代码块使用精确 c8 ignore 注释。session-manager 保持现有方式。
- **移除旧配置迁移代码**：删除 `tryMigrateFromOldLocations()` / `cleanOldLocations()`（从 `openclaw.json channels.coclaw` / `.coclaw-tunnel.json` 迁移的逻辑），内测阶段已无旧格式残留。
- **移除 api.js 未使用导出**：删除 `listBotsWithServer` / `getBotSelfWithServer`（POC 残留，无生产代码调用）。
- **channel-plugin sendText 简化**：移除 transport-adapter 间接调用，sendText 直接返回 OpenClaw 期望的 `{ channel, messageId, to }` 格式（placeholder，实际消息通过 WebSocket 桥接发送）。
- **transport-adapter / message-model 标注为 placeholder**：保留代码和测试，明确注释其预留性质。
- **package.json scripts 清理**：`build` 从 TODO 改为明确的 "No build step needed"。
- **ensureMainSessionKey 文档更新**：`docs/ensure-main-session-bug-analysis.md` 更新为已修复状态（方案 A 简化判断逻辑）。
- **覆盖率门禁调整**：branches 从 100% 调整为 95%，因 `??` / `?.` 的 fallback 分支在单测中无需全部覆盖；lines/statements/functions 保持 100%。

### 绑定信息存储迁移（2026-03-04）
- 从 `openclaw.json` 的 `channels.coclaw.accounts.default` 迁移到独立文件 `~/.openclaw/coclaw/bindings.json`。
- 决策理由：避免卸载插件后残留 `channels.coclaw` 导致 gateway schema 验证失败。

### registerCli 双注册（2026-03-04）
- 新增 `src/cli-registrar.js`，通过 OpenClaw `registerCli` API 注册 `openclaw coclaw bind/unbind`。
- bind/unbind 成功后通过 gateway RPC 通知插件刷新/停止 bridge（见下）。

### CLI 通知改为 Gateway RPC & bridge 生命周期优化（2026-03-05）
- **问题 1**：`openclaw plugins install/uninstall` 进程不退出——因 `register()` 中直接启动 realtime bridge 创建了 WebSocket 连接。
- **修复**：将 bridge 启动改为通过 `api.registerService()` 注册，bridge 仅在 gateway daemon 启动时运行，CLI 上下文不启动。
- **问题 2**：bind/unbind 后 `openclaw gateway restart` 重启整个 gateway，耗时 ~20 秒。
- **修复**：注册 `coclaw.refreshBridge` / `coclaw.stopBridge` gateway methods，CLI 改为 `openclaw gateway call` 发送轻量 RPC 通知，耗时 <1 秒。
- **问题 3**：`openclaw gateway call` 完成 RPC 后进程不退出（WebSocket handle 未清理），`execSync` 10 秒超时 100% 误报失败。
- **修复**：将 `execSync` 替换为 `spawn`（异步），通过解析 stdout JSON 判断成功，检测到输出后延迟 2s kill 子进程。核心逻辑提取至 `src/common/gateway-notify.js`。
- 详见 `docs/cli-gateway-restart.md`。

### session-manager 增强（2026-03-01 ~ 2026-03-03）
- `listAll` 支持 reset 归档识别、deleted 排除、sessionId 去重。
- `listAll` 新增 `derivedTitle`（从首条 user message 生成截断标题）。
- `get` 优先读取 reset 归档。

### realtime bridge 重连策略加固（2026-02-28）
- 重连间隔 10s，连接建立超时 10s，error 事件主动重连。

### ensureMainSessionKey 修复（2026-03-10，原 2026-03-03 禁用）
- 原 bug：每次 WebSocket 重连误触 `sessions.reset`（响应路径错误 + `sessions.resolve` 不含 `entry`）。
- 修复方案（A）：以 `resolved.ok === true` 判断 sessionKey 存在，增加瞬态错误防御。
- 详见 `docs/ensure-main-session-bug-analysis.md`。

### 命名定稿 & npm 发布（2026-03-07）
- npm 包名：`@coclaw/openclaw-coclaw`（scoped to `@coclaw`）。
- plugin id：`openclaw-coclaw`（与 npm 包名去 scope 后一致，避免 idHint mismatch 警告）。
- 以源码形式发布。

### bot 命名策略（2026-02-28）
- 绑定阶段不提交 `name`，server 通过 gateway WebSocket 获取实例名，未设置时前端回退显示 `OpenClaw`。

## 待办

- **TODO**: `channel-plugin.js` 的 `status.defaultRuntime.running` 应反映 realtime-bridge 实际连接状态，当前硬编码 `true`。需分析 OpenClaw channel status 的使用场景后确认方案。

## 风险控制提醒

- 插件运行在 gateway 进程内，接入前必须先完成离线验证与全量单测。
- `pnpm verify` 未通过时，禁止安装到 OpenClaw gateway。
