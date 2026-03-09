# OpenClaw IM Channel 交互机制研究报告

## 一、是否设计为类 IM 聊天方式？

**是的，OpenClaw 完全按照类 IM 聊天方式设计**，具备以下典型 IM 特征：

1. **实时双向通信**：基于 WebSocket 的全双工连接，用户发消息、bot 回消息都是实时流式的
2. **会话（Session）概念**：每个用户-agent 对话有独立 session，维护上下文连续性
3. **异步非阻塞**：用户不需要等 bot 完成才能发下一条消息
4. **多 Channel 统一抽象**：Telegram、WhatsApp、Slack、Discord、Signal 等 IM 平台通过统一的 `ChannelPlugin` 接口接入

## 二、用户在 Bot 执行任务期间发送新消息时，系统如何处理？

这是 OpenClaw 设计的核心亮点之一——**基于 Lane 的 FIFO 队列系统**。

### 队列机制

- **Per-session 序列化**：同一 session 同时只能有一个 agent run 在执行（写锁）
- **Global lane**：`main` 全局并发上限，默认 `maxConcurrent: 4`
- 新消息到达时，如果当前 session 正在执行 agent run，消息会进入队列

### 四种队列模式（可配置）

| 模式 | 行为 |
|------|------|
| `collect`（默认） | 将排队的消息合并为下一轮的上下文，当前 run 结束后一次性处理 |
| `steer` | 立即注入当前 run，取消正在等待的工具调用 |
| `followup` | 等当前 run 结束后，作为下一轮单独处理 |
| `interrupt` | 终止当前 run，用最新消息启动新 run |

### 防抖（Debounce）

- 用户快速连发的文本消息会被合并（默认 2s 窗口）
- 媒体/附件绕过防抖立即处理
- 控制命令（如 `/new`）也绕过防抖

### 配置示例

```json
{
  "messages": {
    "queue": {
      "mode": "collect",
      "debounceMs": 1000,
      "cap": 20,
      "drop": "summarize"
    }
  }
}
```

当排队消息超过 `cap`（默认 20），溢出策略为 `summarize`（将多余消息摘要化）。

## 三、Bot 执行过程中的信息是否推送给 IM？

**是的，OpenClaw 提供多层级的过程反馈机制：**

### 1. Typing 指示器（即时反馈）

- 消息入队时**立即发送** typing indicator（`sendChatAction()`）
- 即使消息在排队等待，用户也能看到 "正在输入..."
- 目的：掩盖队列延迟，给用户即时响应感

### 2. Block Streaming（分块流式推送）

- 配置项：`blockStreamingDefault: "on"`
- Agent 生成文本时，按完成的 block（段落/段）实时推送
- 分块策略：按段落 → 换行 → 句号 → 空格的优先级智能断句
- 控制参数：`minChars: 200`、`maxChars: 1000`
- 模拟人类节奏：`humanDelay: "natural"`（800-2500ms 间隔）

### 3. Preview Streaming（Telegram 特有）

- `streaming: "partial"`：单条预览消息持续更新最新文本
- `streaming: "block"`：分块式预览更新
- `streaming: "progress"`：执行过程中的状态更新
- DM 中使用 `sendMessageDraft()` API
- 群组中使用 `sendMessage()` + `editMessageText()`

### 4. Reasoning 可见性

- `/reasoning on|off|stream` 控制模型思考过程是否暴露给用户
- Telegram 支持 `stream` 模式：将推理过程写入预览气泡

### 5. 生命周期事件

- Gateway 通过 WebSocket 发送事件流：`start`（开始）→ `delta`（文本增量）→ `end`/`error`（完成/出错）
- 工具执行事件单独追踪

## 四、用户离开 IM 后，Bot 完成任务，用户返回时能看到结果吗？

**能看到。** 这取决于 IM 平台的消息投递机制。

### 消息投递流程

```
Agent 完成执行
  ↓
结果写入 session transcript（JSONL，append-only）
  ↓
Gateway 将回复发送到 IM 平台（Telegram/WhatsApp/Slack 等）
  ↓
消息存储在 IM 平台的服务器上
  ↓
用户打开 IM app → 从平台服务器拉取未读消息 → 看到 bot 的回复
```

### 关键设计要点

1. **Gateway 是 source of truth**：所有 session 状态和 transcript 都存储在 Gateway 所在主机上（`~/.openclaw/agents/<agentId>/sessions/`），不依赖客户端连接
2. **Bot 回复发送到 IM 平台**：不是缓存在本地，而是直接调用 Telegram/WhatsApp 等平台的 API 发送消息。消息一旦发送到平台，就由平台负责投递
3. **Agent 执行不依赖用户在线**：agent run 在 Gateway 进程中执行，与用户的 IM 连接状态无关
4. **Session 持续性**：用户回来后发新消息，系统自动恢复同一 session 的上下文

### Session 存储结构

```
~/.openclaw/agents/<agentId>/sessions/
  ├── sessions.json          # sessionKey → SessionEntry 映射
  └── <sessionId>.jsonl      # 完整对话记录（append-only）
```

- Transcript 是不可变的追加日志，每条消息/事件一行 JSON
- Session 元数据包含：`totalTokens`、`model`、`lastChannel`、`lastTo`、`updatedAt` 等

## 五、Gateway 架构概述

> Session 生命周期与 Session Key 命名规则详见 [rpc-and-session.md](rpc-and-session.md) 和 [channel-plugin-deep-analysis.md](channel-plugin-deep-analysis.md)。

### Gateway 的核心角色

Gateway 是**中央消息路由枢纽**，也是唯一允许持有 Channel 连接的进程。

- **单一入口/出口**：所有消息表面（WhatsApp、Telegram、Slack、Discord、Signal、iMessage、WebChat）的统一接入点
- **控制平面**：管理所有客户端（macOS app、CLI、Web UI、自动化、节点）
- **Session 和状态管理器**：维护对话状态
- **Agent 调度器**：接收入站消息并路由到 agent，然后将响应投递回 channel

### WebSocket 连接管理

```
Client              Gateway
   |                  |
   |—— connect ———————>|
   |                  |—— validate auth
   |<—— connect.challenge ——|
   |—— (challenge response) ——>|
   |<—— hello-ok (with snapshot) ——|
   |<—— presence event ———————>|
   |<—— tick event (heartbeat) ——>|
```

- **心跳机制**：Gateway 每 30s 发送 `tick` 事件
- **断线检测**：如果 tick 间隔 > 60s，客户端视为连接中断
- **慢消费者保护**：如果 socket `bufferedAmount` 超过阈值，关闭连接（code 1008）

### 连接恢复策略

- **事件不重放**：断线后客户端需刷新状态（`health`、`system-presence`）
- **序列号追踪**：事件携带 `seq` 字段，客户端检测间隙
- **指数退避重连**：初始 1000ms，自动重连

## 六、消息路由详细流程

```
入站 IM 消息（如 Telegram Update）
  ↓
[去重检查] - 通过 recentUpdates 缓存跳过重复 update_id
  ↓
[顺序键处理] - 按 chat_id/topic_id 路由，保持每会话有序
  ↓
[消息处理] - 提取文本/媒体内容、发送者验证、群组激活检查
  ↓
[路由解析] - resolveAgentRoute() 确定：
  - Agent ID（来自 bindings、guild/team/channel 配置）
  - Session key
  ↓
[Agent Run] - runEmbeddedPiAgent()：
  - 加载 session 上下文
  - 组装系统提示词
  - 调用 LLM 推理（流式）
  - 执行工具（如有）
  - 按 block 输出结果
  ↓
[响应发送] - sendMessageTelegram()：
  - 按 4000 字符限制分块
  - 处理 Markdown 格式
  - 应用回复线程
  - 支持流式预览
  ↓
用户在 IM 中看到回复
```

## 七、对 CoClaw 的启示

CoClaw 作为 OpenClaw 的远程 Channel 实现，需要注意以下几点：

1. **Tunnel 桥接存在离线投递缺口**：当 CoClaw server 与 Gateway 之间的 WebSocket 断开时，Gateway 发出的回复可能无法到达 CoClaw UI。这与原生 IM Channel（如 Telegram）不同——Telegram 消息发到 Telegram 平台后由平台保证投递，而 CoClaw 的 tunnel 没有这种平台级保障
2. **需要实现消息缓冲/重连机制**：确保 tunnel 断连期间的消息不丢失
3. **Queue mode 的选择**：CoClaw 可以根据产品需求选择合适的队列模式（建议默认 `collect`，未来可让用户配置）
4. **流式推送**：CoClaw UI 应实现类似 Telegram preview streaming 的实时反馈体验

## 八、关键配置参考

### 消息队列配置

```json
{
  "messages": {
    "queue": {
      "mode": "collect",
      "debounceMs": 1000,
      "cap": 20,
      "drop": "summarize"
    },
    "inbound": {
      "debounceMs": 2000
    }
  },
  "agents": {
    "defaults": {
      "maxConcurrent": 4
    }
  }
}
```

### 流式推送配置

```json
{
  "agents": {
    "defaults": {
      "blockStreamingDefault": "on",
      "blockStreamingBreak": "text_end",
      "blockStreamingChunk": {
        "minChars": 200,
        "maxChars": 1000
      },
      "humanDelay": "natural"
    }
  },
  "channels": {
    "telegram": {
      "blockStreaming": true,
      "streaming": "partial"
    }
  }
}
```

## 九、关键源码与文档位置

| 类别 | 路径 |
|------|------|
| Telegram 插件源码 | `openclaw-repo/extensions/telegram/src/` |
| Gateway 核心实现 | `openclaw-repo/src/gateway/` |
| Session 管理 | `openclaw-repo/src/gateway/session-utils.ts` |
| 消息路由 | `openclaw-repo/src/gateway/server-chat.ts` |
| Channel 生命周期 | `openclaw-repo/src/gateway/server-channels.ts` |
| 概念文档-Session | `openclaw/docs/concepts/session.md` |
| 概念文档-队列 | `openclaw/docs/concepts/queue.md` |
| 概念文档-流式 | `openclaw/docs/concepts/streaming.md` |
| 概念文档-Agent循环 | `openclaw/docs/concepts/agent-loop.md` |

---

*研究日期：2026-03-07*
*研究基于 OpenClaw 本地源码和官方文档*
