# 远程日志通道设计

> 创建时间：2026-03-30
> 状态：已实施（基础设施 + 各端已有连接诊断埋点）
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
Plugin ── bot WS ──────► Server ──► logger.info(...)
                           ▲
UI ──── RTC signaling WS ──┘
```

- Plugin 通过已有 bot WS 通道发送 `type: 'log'` 消息
- UI 通过已有 RTC signaling WS 通道发送 `type: 'log'` 消息
- 不新增连接或端点

---

## 三、消息格式

### WS 消息

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

### Server 日志输出

```
[2026-03-30 14:02:03.120] [remote][plugin][bot:abc123] 14:01:58.450 | ws.connected peer=server rtt=23ms
 ↑ server 接收时间                                    ↑ 客户端事件时间（已转为 server 本地时区）
```

- Server 将 `ts` 转换为本地时区的 `HH:mm:ss.SSS` 格式输出
- Server 从连接上下文补全 `[plugin/ui]`、`[bot:xxx]` / `[user:xxx]` 前缀
- `text` 原样输出，Server 不解析其内容

---

## 四、客户端设计

### 公共 API

每端暴露一个全局函数：

```js
remoteLog('ws.connected peer=server rtt=23ms');
```

调用方只需提供纯文本描述。函数内部：

1. 记录当前时间戳（`Date.now()`）
2. 组装为 `{ ts, text }` 对象，推入缓冲区

### 缓冲与批量发送

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

### 断连处理

连接不可用时日志仅在缓冲区累积，连接恢复后自动 flush。缓冲区满时丢弃最旧条目（保留最新状态）。

---

## 五、Server 侧处理

Server 对 `type: 'log'` 消息的处理逻辑极简：

```js
// bot WS (bot-ws-hub.js)
for (const { ts, text } of logs) {
  const time = fmtLocalTime(ts); // → HH:mm:ss.SSS（server 本地时区）
  console.info(`[remote][plugin][bot:${botId}] ${time} | ${text}`);
}

// RTC signaling WS (rtc-signal-hub.js)
for (const { ts, text } of logs) {
  const time = fmtLocalTime(ts);
  console.info(`[remote][ui][user:${userId}] ${time} | ${text}`);
}
```

- `fmtLocalTime(ts)`：将毫秒时间戳转换为 server 本地时区的 `HH:mm:ss.SSS`
- 不做存储、不做聚合。依赖现有日志基础设施（文件 / stdout）

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
| SSE 连接/断开/重连 | `sse.connected` / `sse.reconnecting attempt=2` |
| RTC signaling WS 连接/断开 | `sigws.connected` / `sigws.disconnected code=1006` |
| RTC PeerConnection 状态变化 | `rtc.state bot=abc connected→failed` |
| DataChannel 开启/关闭 | `dc.open bot=abc` / `dc.closed bot=abc` |

---

## 七、安全约束

- 禁止传输消息内容、token、凭据等敏感信息
- 日志仅包含连接/状态元数据
- Server 侧日志遵循现有脱敏规范
