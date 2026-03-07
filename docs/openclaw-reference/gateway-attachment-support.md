# OpenClaw Gateway RPC 附件支持分析

> 撰写时间：2026-03-04
> 状态：当前限制，待 OpenClaw 核心扩展

## 背景

CoClaw UI 支持用户上传图片和录制语音。图片附件可正常被 bot 识别，但语音附件在发送后 bot 表示看不到。本文档记录了对 OpenClaw Gateway RPC 附件处理链路的完整分析。

## UI 端附件构建

文件：`ui/src/views/ChatPage.vue`

UI 在发送消息时将文件转为 base64 附件：

```js
attachments.push({
    type: f.isImg ? 'image' : f.isVoice ? 'audio' : 'file',
    mimeType: f.file.type || 'application/octet-stream',
    fileName: f.name,
    content: base64,
});
```

- `isImg` / `isVoice` 标志由 `file-helper.js` 的 `formatFileBlob()` 根据 MIME 类型判定
- 附件通过 `agentParams.attachments` 随 `agent` RPC 请求发送

## Gateway RPC 附件处理链路

### 1. 附件规格化

文件：`openclaw-repo/src/gateway/server-methods/attachment-normalize.ts`

`normalizeRpcAttachmentsToChatAttachments()` 将 RPC 入参转为 `ChatAttachment[]`，保留 `type`、`mimeType`、`fileName`、`content` 字段。此步骤不过滤任何类型。

### 2. 附件解析（瓶颈所在）

文件：`openclaw-repo/src/gateway/chat-attachments.ts` — `parseMessageWithAttachments()`

该函数是 `agent` 和 `chat.send` 两条路径的**共同瓶颈**：

```typescript
// 第 123-130 行
if (sniffedMime && !isImageMime(sniffedMime)) {
    log?.warn(`attachment ${label}: detected non-image (${sniffedMime}), dropping`);
    continue;  // ← 非图片附件在此被丢弃
}
if (!sniffedMime && !isImageMime(providedMime)) {
    log?.warn(`attachment ${label}: unable to detect image mime type, dropping`);
    continue;
}
```

返回值类型 `ParsedMessageWithImages` 只包含 `message` + `images`，没有 audio/file 通道。

### 3. Agent 处理器

文件：`openclaw-repo/src/gateway/server-methods/agent.ts`

```typescript
// 第 229 行
const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(request.attachments);

// 第 235-247 行
const parsed = await parseMessageWithAttachments(message, normalizedAttachments, { ... });
message = parsed.message.trim();
images = parsed.images;

// 第 603-606 行 — 只有 message 和 images 传给 agentCommandFromIngress
void agentCommandFromIngress({
    message,
    images,  // ← 只有图片
    ...
});
```

### 4. chat.send 处理器

文件：`openclaw-repo/src/gateway/server-methods/chat.ts`

```typescript
// 第 743 行
const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(p.attachments);

// 第 755-767 行 — 同样调用 parseMessageWithAttachments
const parsed = await parseMessageWithAttachments(inboundMessage, normalizedAttachments, { ... });
parsedImages = parsed.images;

// 第 923 行 — 同样只传 images
images: parsedImages.length > 0 ? parsedImages : undefined,
```

## 结论

| 路径 | 图片 (image/*) | 音频 (audio/*) | 其他文件 |
|------|:-:|:-:|:-:|
| `agent` RPC | 支持 | 丢弃 | 丢弃 |
| `chat.send` RPC | 支持 | 丢弃 | 丢弃 |
| Channel 消息（Telegram/Discord 等） | 支持 | 支持（media-understanding 管道） | 部分支持 |

两条 Gateway RPC 路径（`agent` / `chat.send`）都汇聚到 `parseMessageWithAttachments`，该函数只处理 image 类型附件，非图片一律静默丢弃（带 warn 日志）。

OpenClaw 的音频处理能力（`audio-transcription-runner.ts`、`audio-preflight.ts` 等）存在于 channel 消息管道，尚未接入 gateway RPC 路径。

## 可能的解决方向

1. **浏览器端 STT**：在 UI 发送前用 Web Speech API 或第三方 STT 将语音转文字，以文本形式发送
2. **推动 OpenClaw 核心支持**：在 `parseMessageWithAttachments` 中增加 audio 处理，或在 `agentCommandFromIngress` / `dispatchInboundMessage` 中接入 media-understanding 管道
3. **CoClaw Plugin 层转写**：在 CoClaw 插件中拦截音频附件，调用外部 STT 服务转写后再注入消息文本（需启用 plugin media 能力）

## 相关文件索引

- UI 附件构建：`ui/src/views/ChatPage.vue` (~第 296-307 行)
- UI 文件类型判定：`ui/src/utils/file-helper.js`
- RPC 附件规格化：`openclaw-repo/src/gateway/server-methods/attachment-normalize.ts`
- 附件解析（瓶颈）：`openclaw-repo/src/gateway/chat-attachments.ts`
- Agent 处理器：`openclaw-repo/src/gateway/server-methods/agent.ts`
- Chat 处理器：`openclaw-repo/src/gateway/server-methods/chat.ts`
- 音频转写能力：`openclaw-repo/src/media-understanding/audio-transcription-runner.ts`
