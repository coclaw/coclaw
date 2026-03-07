# @coclaw/openclaw-coclaw

CoClaw 的 OpenClaw 插件（npm: `@coclaw/openclaw-coclaw`，plugin id: `coclaw`），包含：

- **transport bridge** — CoClaw server 与 OpenClaw gateway 之间的实时消息桥接
- **session-manager** — 会话列表/读取能力（`nativeui.sessions.listAll` / `nativeui.sessions.get`）

## 安装

### 从 npm 安装（生产推荐）

```bash
pnpm run plugin:npm:install
# 或手动：
openclaw plugins install @coclaw/openclaw-coclaw
openclaw gateway restart
```

### 本地开发安装（--link）

```bash
pnpm run plugin:dev:link
# 或手动：
openclaw plugins install --link /path/to/plugins/openclaw
openclaw gateway restart
```

安装后确认：

```bash
openclaw plugins doctor
openclaw gateway status
```

## 卸载

### npm 安装的卸载

```bash
pnpm run plugin:npm:uninstall
```

### 本地开发安装的卸载

```bash
pnpm run plugin:dev:unlink
```

卸载脚本会自动清理：
- `plugins.entries` / `plugins.installs` 等插件元数据
- `~/.openclaw/coclaw/bindings.json`（绑定信息）
- `openclaw.json` 中可能残留的 `channels.coclaw` 节点（旧版兼容）

## 绑定 / 解绑

绑定码从 CoClaw Web 端生成，有效期有限。

### 方式一：OpenClaw CLI 子命令（推荐）

```bash
openclaw coclaw bind <binding-code> [--server <url>]
openclaw coclaw unbind [--server <url>]
```

bind/unbind 成功后会通过 gateway RPC 通知插件刷新/停止 bridge 连接（无需重启 gateway）。若 gateway 未运行，通知会失败但不影响绑定结果。

### 方式二：IM 渠道命令

在已注册 CoClaw channel 的 IM 渠道中发送：

```
/coclaw bind <binding-code> [--server <url>]
/coclaw unbind [--server <url>]
```

需要 gateway 运行中。

### 方式三：独立 CLI（兼容）

```bash
node ~/.openclaw/extensions/coclaw/src/cli.js bind <binding-code> --server <url>
node ~/.openclaw/extensions/coclaw/src/cli.js unbind --server <url>
```

## 配置存储

绑定信息存储在 `~/.openclaw/coclaw/bindings.json`（通过 `resolveStateDir()` + channel ID 组合路径），**不存储在 `openclaw.json` 中**。

文件结构：

```json
{
  "default": {
    "serverUrl": "https://coclaw.net",
    "botId": "bot-xxx",
    "token": "token-xxx",
    "boundAt": "2026-03-05T..."
  }
}
```

说明：
- 这一设计是为了避免卸载插件后 `channels.coclaw` 节点残留导致 OpenClaw gateway schema 验证失败。
- `config.js` 是读写绑定信息的唯一入口。
- 首次读取时会自动从旧位置（`openclaw.json` 的 `channels.coclaw` / `.coclaw-tunnel.json`）迁移。
- 绑定时不提交 bot `name`；server 通过 gateway WebSocket 获取 OpenClaw 实例名。若未设置实例名，前端回退显示 `OpenClaw`。

## 运行与排障日志

### 日志级别建议

- 默认（生产推荐）：仅保留 `info/warn`，用于连接、绑定、解绑、鉴权失败等关键事件。
- 深度排障：开启 `COCLAW_WS_DEBUG=1`，输出 rpc/event 透传细节。

### 开启 `COCLAW_WS_DEBUG`

临时开启（当前 shell）：

```bash
COCLAW_WS_DEBUG=1 openclaw gateway start
```

若通过 systemd/user service 运行 gateway，可在服务环境中追加：

```ini
Environment=COCLAW_WS_DEBUG=1
```

然后重启 gateway 生效。

### 常用排障命令

```bash
# 看 plugin 与 server 连接状态
openclaw logs --limit 300 --plain | rg -n "realtime bridge|coclaw/ws|bind success|unbind success" -i

# 看 gateway 握手/协议问题
openclaw logs --limit 300 --plain | rg -n "gateway connect failed|protocol mismatch|closed before connect|auth failed" -i

# 看 rpc/event 透传（需先开启 COCLAW_WS_DEBUG=1）
openclaw logs --limit 300 --plain | rg -n "ui->server req|bot->server res|bot->server event|gateway req" -i
```

## 测试门禁

```bash
pnpm check       # lint + typecheck
pnpm test         # 全部单测
pnpm coverage     # 覆盖率检查
pnpm verify       # 完整验证（check → test:standalone → test:plugin → test → coverage）
```

覆盖率阈值：100%（lines/functions/branches/statements），未通过禁止接入 gateway。
