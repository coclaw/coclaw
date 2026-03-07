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
- `src/session-manager/` — 会话读取能力（`nativeui.sessions.listAll/get`）
- `src/common/` — 共享逻辑
  - `bot-binding.js` — bind/unbind 核心逻辑
  - `errors.js` — 错误码与消息映射

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
- 禁止将绑定信息写入 `openclaw.json` 的 `channels.coclaw` 或 `plugins.entries.coclaw.config`。
- `config.js` 是读写绑定信息的唯一入口，禁止在其他模块中直接操作 bindings 文件。
- 环境变量 `COCLAW_SERVER_URL` 可覆盖 serverUrl（运行时覆盖，不影响存储）。

## 约束

- 所有 bind/unbind 核心逻辑必须集中在共享层，CLI 与插件命令层只做参数解析和错误映射。
- gateway methods（`coclaw.refreshBridge` / `coclaw.stopBridge` / `nativeui.sessions.listAll/get`）仅由本插件提供，禁止重复注册同名方法。
- realtime bridge 必须通过 `api.registerService()` 注册为 gateway service，**禁止在 `register()` 中直接启动**。原因：`register()` 在 CLI 上下文（如 `openclaw plugins install/uninstall`）也会被调用，直接启动会创建 WebSocket 连接导致进程无法退出。
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
- branches 100%
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
- 详细流程与故障恢复见：`plugins/openclaw/docs/local-plugin-update-sop.md`。
