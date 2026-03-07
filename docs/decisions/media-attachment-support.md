# OpenClaw 文件附件支持分析与 CoClaw 改造方案

> 日期：2026-03-06
> 状态：待讨论
> 涉及模块：plugins/openclaw, server, ui

## 一、问题背景

CoClaw 在将用户上传的语音文件传给 OpenClaw 时被静默丢弃。经分析，PDF、视频等非图片文件同样会被丢弃。根本原因在于当前消息走的是 gateway agent RPC 通路，而该通路在 OpenClaw 核心中只支持图片附件。

## 二、问题根因

CoClaw 当前架构是一个**透明 RPC 桥接**：

```
UI -> Server -> Plugin(realtime-bridge) -> Gateway WebSocket -> agent() RPC handler
```

`realtime-bridge.js:365-370` 直接将 UI 发来的 RPC 请求原封不动转发给 gateway WebSocket。gateway 收到后走 `agent()` 处理器，其中 `chat-attachments.ts` 的 `parseMessageWithAttachments()` 有一个硬编码过滤：

```typescript
// openclaw-repo/src/gateway/chat-attachments.ts:121-130
const sniffedMime = normalizeMime(await sniffMimeFromBase64(b64));
if (sniffedMime && !isImageMime(sniffedMime)) {
    log?.warn(`attachment ${label}: detected non-image (${sniffedMime}), dropping`);
    continue;  // 语音、PDF、视频全部在这里被静默丢弃
}
```

`isImageMime()` 只认 `image/*`，所有非图片附件都被丢弃。

## 三、Agent RPC vs Channel 两条消息通路对比

| 特性 | Agent RPC 通路 (当前) | Channel 消息通路 (Telegram 等) |
|------|----------------------|-------------------------------|
| 附件格式 | base64 -> `ImageContent[]` | 本地文件路径 `MediaPath/MediaPaths` |
| 图片 | 支持 | 支持 |
| 语音 | 被丢弃 | 支持（自动转写） |
| 视频 | 被丢弃 | 支持 |
| PDF/文档 | 被丢弃 | 支持（通过 input-files） |
| 媒体处理 | 无 | `applyMediaUnderstanding()` 全管线 |
| 类型定义 | `AgentCommandOpts.images?: ImageContent[]` | `MsgContext.MediaPath/MediaPaths/MediaTypes` |

**Channel 通路**通过 `applyMediaUnderstanding()` 管线支持 image / audio / video 三种能力，还能处理文本类文件（PDF、CSV 等）。语音消息甚至有 preflight 转写功能（`audio-preflight.ts`）。

### Agent RPC 关键类型定义

```typescript
// openclaw-repo/src/commands/agent/types.ts
type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

type AgentCommandOpts = {
  message: string;
  images?: ImageContent[];  // 仅图片
  // ...
};
```

### Channel 消息关键类型定义

```typescript
// plugin-sdk/auto-reply/templating.d.ts - MsgContext（节选）
type MsgContext = {
  Body?: string;
  From?: string;
  To?: string;
  SessionKey?: string;
  Provider?: string;
  WasMentioned?: boolean;
  MediaPath?: string;       // 单个媒体文件的本地路径
  MediaUrl?: string;        // 单个媒体文件的远程 URL
  MediaType?: string;       // 单个媒体文件的 MIME 类型
  MediaPaths?: string[];    // 多个媒体文件的本地路径
  MediaUrls?: string[];     // 多个媒体文件的远程 URL
  MediaTypes?: string[];    // 多个媒体文件的 MIME 类型
  // ...
};
```

## 四、关键发现：Plugin SDK 提供 `dispatchInboundMessage`

```typescript
// plugin-sdk/auto-reply/dispatch.d.ts
export declare function dispatchInboundMessage(params: {
    ctx: MsgContext | FinalizedMsgContext;
    cfg: OpenClawConfig;
    dispatcher: ReplyDispatcher;
    replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
}): Promise<DispatchInboundResult>;

// 还有带 buffered dispatcher 的变体
export declare function dispatchInboundMessageWithBufferedDispatcher(params: {
    ctx: MsgContext | FinalizedMsgContext;
    cfg: OpenClawConfig;
    dispatcherOptions: ReplyDispatcherWithTypingOptions;
    replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
}): Promise<DispatchInboundResult>;
```

这是 OpenClaw Plugin SDK 暴露给 channel 插件的核心 API。Channel 插件可以：

1. 构建 `MsgContext`（含 `MediaPath`/`MediaType` 等媒体字段）
2. 调用 `dispatchInboundMessage()` 进入完整的 auto-reply 管线
3. 管线内部自动执行 media-understanding（语音转写、图像理解、视频分析）
4. 通过 `ReplyDispatcher` 回调获取 agent 响应

### Telegram 的参考实现

Telegram 插件的处理流程：

1. 收到消息，识别媒体类型（photo/voice/video/document/audio）
2. 下载文件到本地，构建 `TelegramMediaRef { path, contentType }`
3. 通过 `buildTelegramMessageContext()` 构建完整 `MsgContext`（含 `MediaPaths`/`MediaTypes`）
4. 对语音消息进行 preflight 转写（`transcribeFirstAudio()`）
5. 调用 `dispatchReplyWithBufferedBlockDispatcher()` 进入 auto-reply 管线
6. 管线内 `applyMediaUnderstanding()` 自动处理所有媒体类型
7. 回复通过 `deliver` 回调发送

关键文件：
- `openclaw-repo/src/telegram/bot-handlers.ts` - 消息接收与分发
- `openclaw-repo/src/telegram/bot-message-context.ts` - MsgContext 构建
- `openclaw-repo/src/telegram/bot-message-dispatch.ts` - 回复分发
- `openclaw-repo/src/media-understanding/apply.ts` - 媒体理解管线入口

## 五、CoClaw 当前架构的结构性问题

CoClaw 的插件虽然注册为 channel（`id: 'coclaw'`），但实际上**没有使用 channel 消息管线**：

- `channel-plugin.js:28` 声明 `media: false`
- `realtime-bridge.js` 只做 WebSocket 消息透传，不构建 `MsgContext`
- 消息直接走 gateway RPC -> 被 image-only 过滤器截断

## 六、改造方案

### 方案概述

对于**含非图片附件的消息**，不再走 gateway RPC 转发，而是在插件内部：

1. 接收 UI 上传的附件（base64）
2. 将附件保存为本地临时文件
3. 构建 `MsgContext`（包含 `MediaPath`/`MediaPaths`/`MediaType`/`MediaTypes`）
4. 调用 `dispatchInboundMessage()` 进入 auto-reply 管线
5. 通过 `ReplyDispatcher` 回调将响应推回 CoClaw Server -> UI

### 具体改动点

#### 1. 插件层 (`plugins/openclaw`)

- **channel-plugin.js**: `media: false` -> `media: true`
- **realtime-bridge.js**: 新增消息分流逻辑
  - 纯文本/仅图片消息：可继续走原有 RPC 桥接（兼容，最小变更）
  - 含语音/视频/文档的消息：走新的 channel 处理路径
- **新增 `inbound-handler.js`**（或类似模块）：
  - 从 base64 解码并写入临时文件
  - 构建 `MsgContext`（`Body`, `From`, `To`, `SessionKey`, `MediaPath`, `MediaType`, `Provider: 'coclaw'`, `WasMentioned: true` 等）
  - 调用 `dispatchInboundMessage()` / `dispatchInboundMessageWithBufferedDispatcher()`
  - 实现 `ReplyDispatcher`，将 agent 回复推回 server WebSocket
- **outbound 适配**: 当前 `sendText` 只处理文本回复；如果 agent 回复含媒体（如语音转写后的 TTS、生成的图片），需要增加 `sendMedia` 适配器

#### 2. Server 层 (`server`)

- **bot-ws-hub.js**: 可能需要适配新的响应格式（如果从 channel 管线返回的响应结构与 RPC 响应不同）
- **文件上传**: 考虑是否需要 HTTP 上传通道（替代 base64 over WebSocket），用于大文件场景

#### 3. UI 层 (`ui`)

- 改动最小，当前 `ChatPage.vue` 的附件构建逻辑（base64 编码）基本可复用
- 可能需要适配响应格式差异

#### 4. 协议/接口层

- 需要定义消息是走 RPC 还是 channel 路径的判定规则
- 可能需要新增一种消息类型或在现有 `agent` RPC 参数中增加标识

### 实施策略

#### 策略 A：渐进式（推荐）

- 保留现有 RPC 桥接作为默认路径
- 仅当消息包含非图片附件时，切换到 channel 管线
- 优点：最小风险、增量改动、可逐步验证
- 缺点：存在两条路径，增加维护复杂度

#### 策略 B：全面切换

- 所有消息都走 channel 管线（`dispatchInboundMessage`）
- 彻底弃用 RPC 桥接
- 优点：架构统一，长期更干净
- 缺点：影响面大，需要完整的响应格式适配（包括 streaming、two-phase RPC 等），风险高

### 关键技术挑战

1. **临时文件管理**：base64 -> 本地文件的生命周期管理（写入、清理）
2. **响应流转方式差异**：当前 RPC 桥是请求-响应模式（含 streaming events），channel 管线的 `ReplyDispatcher` 是回调模式，需要桥接两种范式
3. **Session 兼容性**：channel 管线使用 `MsgContext.SessionKey` 路由 session，需要与现有的 session 管理机制对齐
4. **大文件传输**：base64 编码膨胀约 33%，大文件（视频等）可能需要 HTTP multipart 上传通道替代 WebSocket

### 完成后支持的文件类型

| 类型 | 示例格式 | OpenClaw 处理方式 |
|------|---------|------------------|
| 图片 | PNG, JPEG, WebP, GIF | Vision 模型分析 |
| 语音 | WebM, OGG, MP3, WAV | 自动转写（Whisper/Deepgram/Google） |
| 视频 | MP4, WebM | 视频理解管线 |
| 文档 | PDF, TXT, CSV, MD | input-files 提取文本内容 |

## 七、关键源码参考

### OpenClaw 核心

| 文件 | 说明 |
|------|------|
| `openclaw-repo/src/gateway/chat-attachments.ts` | image-only 过滤器（问题根源） |
| `openclaw-repo/src/gateway/server-methods/agent.ts` | agent RPC 处理器 |
| `openclaw-repo/src/commands/agent/types.ts` | `AgentCommandOpts` / `ImageContent` 定义 |
| `openclaw-repo/src/media-understanding/apply.ts` | 媒体理解管线入口 |
| `openclaw-repo/src/media-understanding/runner.ts` | 媒体理解执行器（image/audio/video） |
| `openclaw-repo/src/auto-reply/reply/get-reply.ts` | auto-reply 核心（调用 media-understanding） |

### OpenClaw Plugin SDK

| 文件 | 说明 |
|------|------|
| `plugin-sdk/auto-reply/dispatch.d.ts` | `dispatchInboundMessage()` API |
| `plugin-sdk/auto-reply/templating.d.ts` | `MsgContext` 类型定义 |
| `plugin-sdk/channels/dock.d.ts` | `ChannelDock` 类型 |
| `plugin-sdk/channels/plugins/types.adapters.d.ts` | `ChannelOutboundAdapter` |
| `plugin-sdk/plugin-sdk/agent-media-payload.d.ts` | `AgentMediaPayload` |

### OpenClaw Telegram 插件（最佳参考实现）

| 文件 | 说明 |
|------|------|
| `openclaw-repo/src/telegram/bot-handlers.ts` | 消息接收、媒体下载、分发 |
| `openclaw-repo/src/telegram/bot-message-context.ts` | MsgContext 构建、音频 preflight |
| `openclaw-repo/src/telegram/bot-message-dispatch.ts` | 回复分发（含 streaming） |

### CoClaw 当前实现

| 文件 | 说明 |
|------|------|
| `plugins/openclaw/src/channel-plugin.js` | channel 注册（`media: false`） |
| `plugins/openclaw/src/realtime-bridge.js` | 透明 RPC 桥接 |
| `plugins/openclaw/src/transport-adapter.js` | 消息收发适配 |
| `ui/src/views/ChatPage.vue:355-378` | UI 附件构建（base64） |
| `ui/src/utils/file-helper.js` | 文件类型检测 |
