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
  - `api.js` — CoClaw server HTTP API 封装
  - `cli.js` — 独立 CLI（`coclaw bind/unbind`）
  - `cli-registrar.js` — OpenClaw `registerCli` 注册（`openclaw coclaw bind/unbind`）
  - `runtime.js` — OpenClaw runtime 引用管理
- `src/auto-upgrade/` — 自动升级模块（仅 npm 安装模式生效）
  - `updater.js` — 调度入口（延迟首次 + 周期轮询 + 升级锁）
  - `updater-check.js` — 版本检查（npm view）+ `getPackageInfo()`
  - `updater-spawn.js` — spawn detached worker 进程
  - `worker.js` — 独立进程：备份 → `openclaw plugins update` → 验证 → 回滚
  - `worker-backup.js` — 备份与恢复
  - `worker-verify.js` — 升级后验证（gateway + 插件 + health）
  - `state.js` — upgrade-state.json / upgrade-log.jsonl 读写
- `src/session-manager/` — 会话读取能力（`nativeui.sessions.listAll/get`）
- `src/common/` — 共享逻辑
  - `bot-binding.js` — bind/unbind 核心逻辑
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
      "botId": "bot-xxx",
      "token": "token-xxx",
      "boundAt": "2026-03-04T..."
    }
  }
  ```
- 禁止将绑定信息写入 `openclaw.json` 的 `channels.coclaw` 或 `plugins.entries.openclaw-coclaw.config`。
- `config.js` 是读写绑定信息的唯一入口，禁止在其他模块中直接操作 bindings 文件。
- 环境变量 `COCLAW_SERVER_URL` 可覆盖 serverUrl（运行时覆盖，不影响存储）。

## Logger 规范

- OpenClaw gateway 提供的 logger 是 pino 风格，有 `.info()` / `.warn()` / `.error()`，**没有 `.log()` 方法**。
- 插件代码中所有日志调用必须使用 `.info?.()` / `.warn?.()` / `.error?.()` 等带可选链的调用，**禁止使用 `.log()`**，也禁止将 logger 当函数直接调用（如 `logger('msg')`）。
- 可选链 `?.()` 确保即使 logger 缺少某方法或 logger 本身为 undefined，也不会抛异常中断正常流程。

## 约束

- 所有 bind/unbind 核心逻辑必须集中在共享层，CLI 与插件命令层只做参数解析和错误映射。
- gateway methods（`coclaw.refreshBridge` / `coclaw.stopBridge` / `coclaw.upgradeHealth` / `nativeui.sessions.listAll/get`）仅由本插件提供，禁止重复注册同名方法。
- realtime bridge（`coclaw-realtime-bridge`）和 auto-upgrade scheduler（`coclaw-auto-upgrade`）必须通过 `api.registerService()` 注册为 gateway service，**禁止在 `register()` 中直接启动**。原因：`register()` 在 CLI 上下文（如 `openclaw plugins install/uninstall`）也会被调用，直接启动会创建 WebSocket 连接或定时器导致进程无法退出。
- CLI bind/unbind 成功后通过 `openclaw gateway call coclaw.refreshBridge/stopBridge` 通知 gateway，**禁止使用 `openclaw gateway restart`**（代价过大）。
- 插件运行在 gateway 进程中，严禁引入全局异常兜底（如 `process.on('uncaughtException'/'unhandledRejection')`）。

## 测试门禁（强制）

执行顺序：
1. `pnpm check`
2. `pnpm test`
3. `pnpm coverage`
4. `pnpm verify`

覆盖率阈值：
- lines 100%
- functions 100%
- branches 95%（`??` / `?.` fallback 分支不强制覆盖）
- statements 100%

`verify` 未通过，禁止安装到 gateway。

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
