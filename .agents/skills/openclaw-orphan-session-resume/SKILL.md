---
name: openclaw-orphan-session-resume
description: Resume conversation on historical/orphan OpenClaw sessions (sessionId no longer indexed by sessions.json). Use when you need to continue a past transcript by sessionId, especially when chat.send with UUID-as-sessionKey does not append to the old jsonl.
---

# Resume Orphan Session by `sessionId`

用于处理这种场景：
- 历史 transcript 还在 `<state-dir>/agents/<agentId>/sessions/<sessionId>.jsonl`（state-dir 默认 `~/.openclaw`，可被 `OPENCLAW_STATE_DIR` 覆盖）
- 但该 `sessionId` 已不再被 `sessions.json` 当前 key 映射引用（orphan）

## 核心结论

- **正确路径**：走 Gateway WS `method: "agent"`，传 `params.sessionId`——上游对自带 sessionId 的请求不做 freshness 轮转，run 会一直追加到 `<sessionId>.jsonl`
- **不推荐路径**：`chat.send` 把 UUID 当 `sessionKey`，不会续写原 orphan transcript
- **时效**：OpenClaw 默认保洁两阶段硬删闲置正文（约 30 天归档成 `.deleted.<ts>` 变体、再约 30 天真删）；显式 reset 会把正文归档成 `.reset.<ts>` 变体。裸名文件不在时先找 `<sessionId>.jsonl.reset.<ts>` / `.deleted.<ts>` 归档变体确认正文是否尚存；归档变体能否被 `agent(sessionId)` 直接续写**未验证**，别默认能

## 协议前置（连不上先看这节）

Gateway WS **第一帧必须是 `connect` 握手请求**（带协议范围与 auth），之后才能发 `agent` 等请求；裸发会收到 `INVALID_REQUEST`（invalid handshake）并被 close(1008)。要点：

- 默认端口 **18789**；URL 上带 `?role=...` 之类 query 没有意义（role 只在 connect params 里，合法值 `operator`/`node`）
- 默认鉴权是 **token 模式，本机 loopback 也不豁免**。token 来源优先级同上游顺序（config-first）：OpenClaw 配置 `gateway.auth.token`（`$OPENCLAW_CONFIG_PATH` 指定的文件，或 `<state-dir>/openclaw.json`）优先，env `OPENCLAW_GATEWAY_TOKEN` 兜底。注意上游配置本身支持 JSON5 写法、token 可为 SecretRef 对象——手写读取时别只按严格 JSON + 字符串假设
- operator 角色带有效共享 token 时可不带 `device` 字段完成握手（已实测）；协议范围与本仓插件保持同步（`plugins/openclaw/src/realtime-bridge.js` 的 min/maxProtocol）。OpenClaw 升协议号后握手被拒时先对齐那边

帧序：

```
→ req  connect {minProtocol, maxProtocol, role:"operator", auth:{token}, ...}
← res  ok=true（hello-ok：协商后的 protocol、server 信息）
→ req  agent {agentId, sessionId, message, idempotencyKey, deliver:false}
← res  ok=true, payload.status="accepted", payload.runId        （中间态）
← event chat ...（流式；state 终态只有 'final' / 'error'，没有 'aborted'）
← res  终态（两阶段语义详见 gateway-agent-rpc skill）
```

`deliver:false`：结果只落 transcript / 回给调用方，不向外部 channel 投递。

## 一键脚本（推荐）

`.agents/skills/openclaw-orphan-session-resume/scripts/resume-orphan-session.mjs`（已内置 connect 握手与两阶段等待；`ws` 依赖从 workspace 包解析，需先在仓库根 `pnpm install`）：

```bash
node .agents/skills/openclaw-orphan-session-resume/scripts/resume-orphan-session.mjs \
  --sessionId <uuid> \
  --message "继续这个历史会话" \
  [--url ws://127.0.0.1:18789] [--token <gateway-token>] [--agentId main] [--timeoutSec 300]
```

`--token` 省略时依次取 OpenClaw 配置 `gateway.auth.token`、env `OPENCLAW_GATEWAY_TOKEN`（config-first，同上游顺序）。配置侧脚本只支持"严格 JSON + 字符串 token"的常见形态：配置是 JSON5 写法或 token 是 SecretRef 时读不出，会打 stderr 警告并回退 env——此时显式传 `--token`。`--agentId` 同时用于定位 transcript 和传给网关。输出 JSON，关键字段：`ok / grew / markerFound / acceptedSeen / finalStatus / finalSeen / runId`。长跑 run 用 `--timeoutSec` 调大；等终态超时不代表 run 失败，可事后看 transcript 是否续写。

## 验证步骤（手工）

1. 发送前记录目标 `<sessionId>.jsonl` 文件大小
2. 发起 `agent(sessionId=...)`
3. 等待同 id 终态 res（或 chat 事件 `state==='final'`）
4. 再次检查文件大小与 tail 是否包含本次 marker

## 常见误区

- `sessions.resolve(sessionId)` 失败，不代表不能通过 `agent(sessionId)` 续写。
- `chat.send` 需要 `sessionKey` 语义；UUID 文本不等同"恢复旧 transcript"。

## 排障提示

- 一连上就被断开（close 1008/1002）：握手问题——第一帧不是 connect、token 不对、或协议范围不含网关当前版本号。
- 长时间无动作：先确认 gateway 在线（`openclaw gateway status`），再换新 `idempotencyKey` 重试。
- 怀疑写入失败时看：同 id 终态 res 的 ok/status、chat 事件是否到 `final`/`error`、目标 `.jsonl` 是否增长、tail 是否出现本轮 marker。
