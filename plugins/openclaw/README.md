# @coclaw/openclaw-coclaw

CoClaw 的 OpenClaw 插件（npm: `@coclaw/openclaw-coclaw`，plugin id: `openclaw-coclaw`），包含：

- **transport bridge** — CoClaw server 与 OpenClaw gateway 之间的实时消息桥接
- **session-manager** — 会话列表/读取能力（`nativeui.sessions.listAll` / `nativeui.sessions.get`）

## 安装与模式切换

插件支持两种安装模式，可随时切换（脚本会自动处理卸载→重装）：

### 本地开发（link 模式，日常开发推荐）

```bash
pnpm run link
```

link 后代码更新只需 `openclaw gateway restart`，无需重新安装。

### 从 npm 安装

```bash
pnpm run install:npm
```

### 卸载

```bash
pnpm run unlink          # 卸载 link 模式
pnpm run uninstall:npm   # 卸载 npm 模式
```

卸载仅移除插件元数据和代码，不清理绑定信息（`bindings.json` 独立保留）。

## 预发布验证与发布

### 预发布验证

发布前验证 tarball 能正确安装到 OpenClaw 中：

```bash
pnpm run prerelease              # 全新安装验证（交互式，含手动功能验证）
pnpm run prerelease -- --upgrade # 升级验证（先装 npm 旧版，再用本地包覆盖）
```

### 发布到 npm

```bash
pnpm run release                 # 默认：verify → 发布 → 轮询确认
pnpm run release -- --prerelease # 含预发布验证（pack + 安装测试 + 发布）
```

### 检查发布状态

```bash
pnpm run release:check                     # 显示各 registry 最新版本
pnpm run release:check -- 0.1.7            # 对比指定版本
WAIT=1 pnpm run release:check -- 0.1.7     # 轮询直到版本生效
pnpm run release:versions                  # 显示所有已发布版本
```

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

覆盖率阈值：lines/statements/functions 100%，branches ≥ 95%。未通过禁止接入 gateway。
