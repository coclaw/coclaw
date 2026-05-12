# 远程日志通道设计

> 创建时间：2026-03-30
> 状态：已实施。Plugin 走 bot WS、UI 走独立 HTTP 通道（详见 [ui-remote-log-http-channel.md](./ui-remote-log-http-channel.md)）
> 范围：Plugin / UI → Server 的诊断日志推送

---

## 一、背景与动机

### 现状

OpenClaw 运行在用户的远端环境，Plugin 在其中作为 gateway 扩展运行。当遇到连接建立、断开、恢复等问题时，开发者无法直接访问远端日志，排查困难。UI 侧同样缺乏将关键诊断信息集中收集的手段。

### 目标

- Plugin 和 UI 的重要诊断信息推送到 Server，统一通过 Server 日志输出
- Server 作为透传层，不解析日志内容，仅补全连接上下文前缀后落盘
- 各端日志格式由各端自行定义和演化，与 Server 解耦

---

## 二、整体方案

```
Plugin ── bot WS ──────────────────► Server ──► logger.info(...)
                                        ▲
UI ──── HTTP POST /api/v1/log/ui ───────┘
        (per-batch, ordered, dedup)
```

- Plugin 通过已有 bot WS 通道发送 `type: 'log'` 消息
- UI 通过独立 HTTP 通道发送批次日志（替代原先的 RTC signaling WS 通道）—— 详见 [ui-remote-log-http-channel.md](./ui-remote-log-http-channel.md)
- 两端通道独立演化；Plugin 端不变，UI 端切换原因见 UI 通道设计文档

---

## 三、消息格式

### Plugin → Server（bot WS）

```js
{
  type: 'log',
  logs: [
    { ts: 1711774918450, text: 'ws.connected peer=server rtt=23ms' },
    { ts: 1711774919100, text: 'session.restored id=abc dur=1200ms' },
    // ...
  ]
}
```

- `logs`：对象数组，每条包含 `ts`（毫秒时间戳，`Date.now()`）和 `text`（可读文本）
- `ts` 为 UTC 毫秒时间戳，无时区歧义
- 不传 botId、source 等路由信息——Server 从连接上下文获取

### UI → Server（HTTP POST）

UI 端协议结构相近，单条 entry 仍是 `{ ts, text }`，外层显式带 `uiId` + `seq` 用于去重：

```js
POST /api/v1/log/ui
Body: {
  uiId: "<nanoid>",
  seq: 5,
  logs: [ { ts, text }, ... ]
}
```

详细字段说明、去重机制、顺序发送、登录态处理（不强制鉴权）等参见 [ui-remote-log-http-channel.md](./ui-remote-log-http-channel.md)。

### Server 日志输出

```
2026-03-30T14:02:03.120756891Z [remote][plugin][claw:abc123][ts=2026-03-30T14:01:58.450Z] ws.connected peer=server rtt=23ms
↑ docker -t：server 接收时刻（UTC, RFC3339Nano）            ↑ 客户端事件时刻（UTC, ISO8601 ms）
```

- Server 将 `ts` 渲染为 `[ts=<ISO_UTC>]` 字段，紧贴前缀块尾（无空格），与正文 `text` 间一个空格分隔
- 缺失/异常 ts 输出占位 `[ts=??]`
- 两个 ts 都是 UTC，agent 排序优先用行内 `[ts=...]`（事件发生时刻），docker `-t` 当辅助（server 接收时刻）
- Server 从连接上下文补全 `[plugin/ui]`、`[claw:xxx]` / `[user:xxx]` 前缀
- `text` 原样输出，Server 不解析其内容

---

## 四、客户端设计

### 公共 API

各端均暴露一个全局函数：

```js
remoteLog('ws.connected peer=server rtt=23ms');
```

调用方只需提供纯文本描述；函数内部记录时间戳、组装 entry、推入缓冲区。

### Plugin 端

- 缓冲区上限：**1000 条**（超出时丢弃最旧条目）
- 批量大小：**20 条/批**
- 触发时机：
  - 缓冲区积累达到批量大小时
  - 连接可用时 flush 积压日志
- 发送节奏：每发送一批后 `setTimeout(0)` 让出 CPU，避免阻塞业务消息

```js
async function flush() {
  while (buffer.length > 0) {
    const batch = buffer.splice(0, 20);
    send({ type: 'log', logs: batch });
    await new Promise(r => setTimeout(r, 0));
  }
}
```

连接不可用时日志仅在缓冲区累积，连接恢复后自动 flush。缓冲区满时丢弃最旧条目（保留最新状态）。

### UI 端

UI 端采用独立 HTTP 通道，触发条件、批量大小、顺序发送、去重等机制有专门设计，详见 [ui-remote-log-http-channel.md](./ui-remote-log-http-channel.md)。

关键差异概览（相对 Plugin 端）：

| 维度 | Plugin (bot WS) | UI (HTTP) |
|------|----------------|-----------|
| 批量大小 | 20 条 | 100 条 |
| 时间触发 | 无（仅大小触发） | 5 秒 |
| 顺序约束 | 无（WS 自身可靠有序） | 同时 1 batch in-flight |
| 去重 | 不需要（WS 可靠传输） | 单调 seq by uiId |
| 身份标识 | botId / clawId 来自 WS 上下文 | 显式字段 `uiId` + `seq` |
| 登录态门控 | WS 已登录态 | 不强制（端点接受 anon 上报） |

---

## 五、Server 侧处理

Server 端 log 渲染规则统一（无论 plugin 还是 UI），核心是把 entry 渲染成 `console.info` 一行：

```
[remote][<source>][<ctx>][ts=<ISO_UTC>] <text>
```

- `<source>` = `plugin` / `ui`
- `<ctx>` = `claw:<clawId>` 或 `user:<userId>` 或 `anon`（视来源 + 路径补全；UI 通道允许未登录上报）
- `fmtRemoteLogTs(ts)`：将毫秒时间戳渲染为 `[ts=<ISO_UTC>]`；无效输入返回占位 `[ts=??]`。统一 UTC（字典序=时间序，agent 排序便利）

按来源的入口路径：

| 来源 | 入口 | 上下文补全 | 额外处理 |
|------|------|-----------|---------|
| Plugin | `claw-ws-hub.js` 的 `type: 'log'` 分支 | `[claw:<clawId>]` | 无 |
| UI | HTTP `POST /api/v1/log/ui` | `[user:<userId>\|anon][batch=<uiId 尾部 8 字符>:<seq>]` | schema 校验 + 单调 seq 去重；不强制登录态；Origin 沿用 server 全局 CORS（详见 UI 通道设计文档）|

不做存储、不做聚合，依赖现有日志基础设施（文件 / stdout）。

---

## 六、推荐记录的事件

以下为建议的初始事件清单，各端按需扩展：

### Plugin 侧

| 事件 | 示例 |
|------|------|
| WS 连接建立/断开 | `ws.connected peer=server` / `ws.disconnected reason=close code=1006` |
| WS 重连 | `ws.reconnecting attempt=3 delay=4000ms` |
| Session 创建/恢复/reset | `session.created id=abc` / `session.reset old=abc new=def` |
| RTC 连接状态变化 | `rtc.state connected→disconnected` |
| Bridge 启动/停止 | `bridge.started` / `bridge.stopped reason=unbound` |
| 关键错误 | `error.transport msg="connection refused"` |

### UI 侧

| 事件 | 示例 |
|------|------|
| 启动锚点 | `ui.start uiId=<...> version=<...> platform=<...> ua="<...>"`（每个 UI 实例只发一次，详见 UI 通道设计文档）|
| SSE 连接/断开/重连 | `sse.connected` / `sse.reconnecting attempt=2` |
| RTC signaling WS 连接/断开 | `sigws.connected` / `sigws.disconnected code=1006` |
| RTC PeerConnection 状态变化 | `rtc.state bot=abc connected→failed` |
| DataChannel 开启/关闭 | `dc.open bot=abc` / `dc.closed bot=abc` |

---

## 七、安全约束

- 禁止传输消息内容、token、凭据等敏感信息
- 日志仅包含连接/状态元数据
- Server 侧日志遵循现有脱敏规范
