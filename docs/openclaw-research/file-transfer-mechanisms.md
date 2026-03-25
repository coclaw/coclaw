# OpenClaw 文件传输机制

> 更新时间：2026-03-25
> 基于 OpenClaw 本地源码验证

---

## 一、概述

OpenClaw **没有专用的文件上传/下载 RPC**。文件传输通过以下机制实现：

| 机制 | 适用场景 | 文件传递方式 |
|------|---------|-------------|
| `chat.send` attachments | Main 通道（WebChat）对话 | base64 内联 |
| `send()` mediaUrl | 外发到 IM 平台（WhatsApp/Telegram/Signal） | URL 或本地路径引用 |
| `agent()` attachments | Agent 调用时传入附件 | base64 内联 |
| `agents.files.*` | Agent workspace 配置文件读写 | UTF-8 文本 |
| IM 入站 | 用户通过 IM 发送文件给 OpenClaw | 下载到本地 → 路径引用 |

**所有机制均不支持分片/流式传输**，都是标准 request-response 模式。

---

## 二、`agents.files.*` — Agent Workspace 配置文件 RPC

### 1. 三个方法

| 方法 | 作用 | 权限 |
|------|------|------|
| `agents.files.list` | 列出 workspace 文件元数据（name/path/size/mtime） | `operator.read` |
| `agents.files.get` | 读取单个文件的完整 UTF-8 内容 | `operator.read` |
| `agents.files.set` | 原子覆写单个文件（temp-file-and-rename） | `operator.admin` |

来源：`src/gateway/server-methods/agents.ts:633-773`

### 2. 文件名白名单（硬编码，无扩展点）

```
BOOTSTRAP_FILE_NAMES:  AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md,
                       USER.md, HEARTBEAT.md, BOOTSTRAP.md
MEMORY_FILE_NAMES:     MEMORY.md, memory.md

ALLOWED_FILE_NAMES = BOOTSTRAP_FILE_NAMES ∪ MEMORY_FILE_NAMES  (共 9 个)
```

来源：`src/gateway/server-methods/agents.ts:51-66`

任何不在白名单中的 `name` 参数返回 `INVALID_REQUEST: unsupported file "<name>"`。仅接受裸文件名，不接受路径或路径穿越。

### 3. Workspace 路径解析

`resolveAgentWorkspaceDir(cfg, agentId)`（`src/agents/agent-scope.ts:256-272`）：

| 条件 | 解析路径 |
|------|---------|
| Agent config 有 `workspace` 字段 | 使用该自定义路径（`resolveUserPath` 展开） |
| 默认 agent + `agents.defaults.workspace` 已设置 | 使用该 fallback |
| 默认 agent（无配置） | `~/.openclaw/workspace`（或 `~/.openclaw/workspace-<profile>`） |
| 命名 agent（无自定义 workspace） | `<stateDir>/workspace-<agentId>` |

`stateDir` 默认为 `~/.openclaw`，可通过 `$OPENCLAW_STATE_DIR` 覆盖。

磁盘文件示例（默认 agent）：

```
~/.openclaw/workspace/AGENTS.md
~/.openclaw/workspace/SOUL.md
~/.openclaw/workspace/MEMORY.md
...
```

### 4. 大小限制

handlers 内部**无显式大小限制**。`readLocalFileSafely()` 未传 `maxBytes` 参数。实际受 WebSocket 帧上限约束（25 MB）。

### 5. 结论

这些接口**不能用于通用文件传输**，仅限操作 agent workspace 下的 9 个配置文件。

---

## 三、`chat.send` Attachments — Main 通道附件

### 1. Schema

```typescript
// src/gateway/protocol/schema/logs-chat.ts:34-47
ChatSendParamsSchema = {
  sessionKey: NonEmptyString,   // 必填
  message: String,              // 必填
  thinking?: String,
  deliver?: Boolean,
  attachments?: Array<unknown>, // 每项: { type?, mimeType?, fileName?, content? }
  timeoutMs?: Number,
  idempotencyKey: NonEmptyString
}
```

`chat.send` **没有** `extraSystemPrompt` 参数（该参数仅在 `agent()` RPC 上可用）。

### 2. 附件处理流程

```
attachments[] (base64)
  → normalizeRpcAttachmentsToChatAttachments()
    (src/gateway/server-methods/attachment-normalize.ts)
    content 字段: base64 string / ArrayBuffer / ArrayBufferView → 统一为 base64
  → parseMessageWithAttachments()
    (src/gateway/chat-attachments.ts:97-145)
    → 校验解码后大小 ≤ maxBytes (默认 5 MB)
    → MIME 嗅探验证
    → 仅图片 MIME 通过，非图片静默丢弃并打印 warning
```

### 3. 限制

| 限制项 | 值 | 来源 |
|--------|---|------|
| 单附件解码大小 | 5 MB（base64 约 6.7 MB） | `chat-attachments.ts` `maxBytes` 默认值 |
| WS 单帧上限 | 25 MB | `server-constants.ts` `MAX_PAYLOAD_BYTES` |
| WS 连接缓冲 | 50 MB | `server-constants.ts` `MAX_BUFFERED_BYTES` |
| 心跳间隔 | 30 秒 | `server-constants.ts` `TICK_INTERVAL_MS` |
| 支持类型 | **仅图片** | `parseMessageWithAttachments` MIME 过滤 |

---

## 四、`send()` RPC — IM 通道出站

### 1. 基本信息

- **专用于外发到 IM 平台**（WhatsApp / Telegram / Signal 等）
- **不可用于 main 通道**：显式传 `channel: "webchat"` 返回硬拒绝错误，错误消息指向 `chat.send`
- 来源：`src/gateway/server-methods/send.ts:64-77`，`rejectWebchatAsInternalOnly: true`

### 2. Schema

```typescript
// src/gateway/protocol/schema/agent.ts:32-50
SendParamsSchema = {
  to: NonEmptyString,           // 必填
  message?: String,
  mediaUrl?: String,            // 单媒体
  mediaUrls?: String[],         // 多媒体
  gifPlayback?: Boolean,
  channel?: String,             // 可选，若仅配一个通道则自动选择
  accountId?: String,
  agentId?: String,
  threadId?: String,
  sessionKey?: String,
  idempotencyKey: NonEmptyString
}
```

### 3. `mediaUrl` 支持的来源

| 来源类型 | 示例 | 处理方式 |
|---------|------|---------|
| HTTP/HTTPS URL | `https://example.com/photo.jpg` | `fetchRemoteMedia()` 远程下载（含 SSRF 防护） |
| `file://` URL | `file:///tmp/openclaw/report.pdf` | `fileURLToPath()` 转为本地路径 |
| `~` 开头路径 | `~/workspace/output.png` | `resolveUserPath()` 展开 |
| 绝对路径 | `/home/user/.openclaw/media/outbound/x.pdf` | 直接使用 |
| `MEDIA:` 前缀 | `MEDIA: /tmp/openclaw/file.png` | 剥离前缀后按上述规则处理 |

### 4. 本地路径白名单

`buildMediaLocalRoots()`（`src/media/local-roots.ts:20-33`）：

```
$OPENCLAW_TMP_DIR          (如 /tmp/openclaw/)
~/.openclaw/media/
~/.openclaw/agents/
~/.openclaw/workspace/
~/.openclaw/sandboxes/
```

`getAgentScopedMediaLocalRoots()`（`local-roots.ts:39-56`）额外追加当前 agent 的 workspace 目录。

安全措施：symlink 解析后校验、路径穿越拒绝、根路径 `/` 拒绝。

---

## 五、IM 通道入站 — 用户发送文件给 OpenClaw

### 1. 完整流程（以 WhatsApp 语音消息为例）

```
用户发送语音 → WhatsApp 服务器 → Baileys WebSocket
        ↓
  ① messages.upsert 事件触发
     extensions/whatsapp/src/inbound/monitor.ts:433
     → handleMessagesUpsert() → normalizeInboundMessage()
        ↓
  ② 媒体下载 — downloadInboundMedia(msg, sock)
     extensions/whatsapp/src/inbound/media.ts:42
     → Baileys downloadMediaMessage() 下载到 Buffer
     → 返回 { buffer, mimetype: "audio/ogg; codecs=opus", fileName }
        ↓
  ③ 媒体存储 — saveMediaBuffer(buffer, mimetype, "inbound", maxBytes, fileName)
     src/media/store.ts:387-406
     → 创建 ~/.openclaw/media/inbound/ 目录 (mode 0o700)
     → 生成 UUID + 从 MIME 推导扩展名
     → 文件名: {sanitized-original}---{uuid}.{ext} (或 {uuid}.{ext})
     → 写入文件 (mode 0o644，Docker sandbox 可读)
     → 返回 { id, path, size, contentType }
        ↓
  ④ 设置消息上下文
     monitor.ts:295-303
     → mediaPath = saved.path  (绝对路径)
     → mediaType = mimetype
        ↓
  ⑤ 防抖入队 → debouncer.enqueue(inboundMessage)
     防抖后触发 onMessage()
     → processMessage()
     extensions/whatsapp/src/auto-reply/monitor/process-message.ts:126
        ↓
  ⑥ 上下文规范化 — finalizeInboundContext()
     src/auto-reply/reply/inbound-context.ts:37-128
     → 设置 MediaPath, MediaUrl(=MediaPath), MediaType
     → 对齐 MediaPaths[], MediaUrls[], MediaTypes[] 数组
        ↓
  ⑦ Agent 感知文件（多种互补方式）

     A. 文本注解注入
        buildInboundMediaNote() (src/auto-reply/media-note.ts:49)
        注入系统提示/用户消息:
        "[media attached: ~/.openclaw/media/inbound/voice---uuid.ogg (audio/ogg)]"

     B. 沙箱暂存（如启用沙箱）
        stageSandboxMedia() (src/auto-reply/reply/stage-sandbox-media.ts:22)
        → 将文件从 media/inbound/ 复制到 agent sandbox workspace
        → 重写 MediaPath 为沙箱内相对路径

     C. 媒体理解管线（如配置）
        src/media-understanding/runner.ts
        → 音频: transcribeAudioFile() 转写为文本
               结果注入 ctx.MediaUnderstanding
               音频注解被抑制以节省 token
        → 图片: 视觉模型生成描述

     D. Agent 工具访问
        → 图片: agent 使用 read/image tool 读取路径 → base64 image block → LLM 视觉
        → 文档/PDF: pdf-tool.ts 提取文本 → 结构化内容块
        → 通用: agent 的 read tool 可读取沙箱内文件
```

### 2. 各 IM 平台入站支持的消息类型

| 平台 | 支持类型 | 来源 |
|------|---------|------|
| WhatsApp | imageMessage, videoMessage, documentMessage, audioMessage, stickerMessage | `extensions/whatsapp/src/inbound/media.ts` |
| Telegram | photo, video, video_note, document, audio, voice, 静态 sticker (WEBP) | `extensions/telegram/src/bot/delivery.resolve-media.ts` |
| Signal | 任何带 `id` 的 attachment | `extensions/signal/src/monitor/event-handler.ts:704-738` |

### 3. MIME 类型与大小限制

已知 MIME 映射（`src/media/mime.ts` `EXT_BY_MIME`）：

| 类别 | MIME 类型 | 大小限制 |
|------|----------|---------|
| 图片 | jpeg, png, webp, gif, heic, heif | 6 MB |
| 音频 | ogg, mpeg, wav, flac, aac, opus, mp4 | 16 MB |
| 视频 | mp4, quicktime | 16 MB |
| 文档 | pdf, json, zip, gz, tar, 7z, rar, doc/xls/ppt, docx/xlsx/pptx, csv, txt, md | 100 MB |

大小限制来源：`src/media/constants.ts`。未识别的 MIME 类型以 `application/octet-stream` 存储。

WhatsApp 扩展覆盖了默认的 5 MB 限制，使用配置中的 `mediaMaxMb`（默认 50 MB）。

### 4. TTL 清理机制

- **默认 TTL**：2 分钟（`store.ts:16`，`DEFAULT_TTL_MS = 2 * 60 * 1000`）
- **惰性清理**：每次 `saveMediaSource()` 调用时顺带执行 `cleanOldMedia()`
- **定时清理**：Gateway 启动时注册定时器（`server-maintenance.ts:135-163`），每 60 分钟递归扫描 `~/.openclaw/media/`，删除 `mtime` 超过 TTL 的文件，并清理空目录
- `cleanOldMedia()` 实现（`store.ts:113-171`）：遍历目录，对每个文件检查 `mtime`，超期则 `fs.rm(path, { force: true })`

---

## 六、IM 通道出站 — Agent 发送文件给用户

### 1. 完整流程（以 WhatsApp 发送本地文件为例）

```
Agent 调用 send({ to, message, mediaUrl: "~/.openclaw/media/outbound/report.pdf" })
        ↓
  ① Gateway RPC handler — send()
     src/gateway/server-methods/send.ts:91
     → validateSendParams()
     → 提取 mediaUrl 并 trim
        ↓
  ② 通道解析 — resolveOutboundChannelPlugin()
     → 确定目标 IM 通道（如 WhatsApp）及其插件
        ↓
  ③ 分发 — deliverOutboundPayloads()
     src/infra/outbound/deliver.ts:438
     → 计算 mediaLocalRoots（白名单路径列表）
     → createChannelHandler() → 加载通道出站适配器
        ↓
  ④ 适配器 — whatsappOutbound.sendMedia()
     extensions/whatsapp/src/outbound-adapter.ts:55-68
        ↓
  ⑤ 通道发送 — sendMessageWhatsApp(to, text, { mediaUrl, mediaLocalRoots })
     extensions/whatsapp/src/send.ts:17-100
        ↓
  ⑥ 媒体加载 — loadWebMedia(mediaUrl, { localRoots })
     extensions/whatsapp/src/media.ts:404
     (详见下方 loadWebMedia 说明)
     → 返回 { buffer, contentType, kind, fileName }
        ↓
  ⑦ 构建 Baileys 消息体（按 kind）:
     image → { image: buffer, caption, mimetype }
     audio → { audio: buffer, ptt: true, mimetype }
     video → { video: buffer, caption, mimetype, gifPlayback? }
     其他  → { document: buffer, fileName, caption, mimetype }
        ↓
  ⑧ active.sendMessage(jid, payload)
     extensions/whatsapp/src/inbound/send-api.ts:37-65
     → 通过 Baileys WebSocket 发送到 WhatsApp 服务器
```

### 2. `loadWebMedia()` — 统一媒体加载函数

定义于 `extensions/whatsapp/src/media.ts:404`。虽然位于 WhatsApp 扩展中，但通过插件 runtime 暴露给其他通道使用（`runtime.media.loadWebMedia`）。

处理步骤：

```
输入 mediaUrl
  → 剥离 "MEDIA:" 前缀（LLM 输出有时会加此标记）
  → file:// URL → fileURLToPath() 转为本地路径
  → 判断来源:
      HTTP/HTTPS → fetchRemoteMedia({ url, maxBytes, ssrfPolicy }) 远程下载
      本地路径   → resolveUserPath() 展开 ~
                 → assertLocalMediaAllowed(path, localRoots) 检查白名单
                 → readLocalFileSafely() 读取到 Buffer
  → detectMime() 嗅探 MIME 类型
  → clampAndFinalize() 按类型限制大小:
      图片(非GIF) → optimizeAndClampImage() 压缩优化
      其他       → 检查大小是否超限
  → 返回 { buffer, contentType, kind, fileName }
```

### 3. 图片自动优化压缩

在 `loadWebMedia()` 内部完成，调用链：

```
loadWebMedia(optimizeImages=true)  (media.ts:404)
  → clampAndFinalize()             (media.ts:284)
    → optimizeAndClampImage()      (media.ts:257)
      → optimizeImageWithFallback() (media.ts:208)
         ├─ PNG + alpha → optimizeImageToPng()     (src/media/image-ops.ts)
         │               若结果仍超限 → 回退 JPEG
         └─ 其他       → optimizeImageToJpeg()     (media.ts:426)
                          ├─ HEIC → convertHeicToJpeg()  (src/media/image-ops.ts)
                          └─ 压缩网格搜索:
                             sides:     [2048, 1536, 1280, 1024, 800]
                             qualities: [80, 70, 60, 50, 40]
                             → resizeToJpeg({ buffer, maxSide, quality })
                             → 取第一个满足 maxBytes 的结果
```

底层使用 **Sharp** 库，macOS 上可能使用 `sips`（`image-ops.ts:26` `prefersSips()`）。

此外，Agent 运行时工具返回的图片在提交 LLM 前，还有**第二道优化**：`sanitizeContentBlocksImages()`（`src/agents/tool-images.ts:269`），防止 vision 输入过大。

---

## 七、`saveMediaBuffer()` 插件可用性

`saveMediaBuffer` 通过 `PluginRuntime` 的 `channel.media` 暴露给插件：

```typescript
// src/plugins/runtime/types-channel.ts:51-54
channel: {
  media: {
    fetchRemoteMedia: typeof import("../../media/fetch.js").fetchRemoteMedia;
    saveMediaBuffer: typeof import("../../media/store.js").saveMediaBuffer;
  };
};
```

插件可通过 `runtime.channel.media.saveMediaBuffer()` 调用。

---

## 八、Agent 文件访问机制

### 1. Agent 的工作目录

Agent 启动时执行 `process.chdir(effectiveWorkspace)`（`src/agents/pi-embedded-runner/run/attempt.ts:1409`），**CWD = workspace 目录**。Agent 可使用相对路径访问 workspace 下的文件。

### 2. Agent 文件工具

通过 `pi-coding-agent` 提供（`src/agents/pi-tools.ts:1-59`）：

| 工具 | 功能 | 路径约束 |
|------|------|---------|
| `read` | 读取文件（page size 50KB，max 512KB） | workspace-only 模式下限 workspace 内 |
| `write` | 写入文件 | 同上 |
| `edit` | 编辑文件 | 同上 |

路径策略由 `tool-fs-policy.ts` 控制。

### 3. `extraSystemPrompt` — 不可见上下文注入

仅 `agent()` RPC 支持（`chat.send` 无此参数）：

```typescript
// src/gateway/protocol/schema/agent.ts:96
extraSystemPrompt: Type.Optional(Type.String())
```

注入位置：
- 主 agent 调用 → 系统提示的 `## Group Chat Context` 段
- 子 agent 调用 → 系统提示的 `## Subagent Context` 段

来源：`src/agents/system-prompt.ts:583-588`

**不会展示给终端用户**，纯 server 端注入。可用于告知 agent 用户上传了哪些文件及其路径。

### 4. Subagent Attachments — 文件物化机制

仅限 `sessions_spawn`（子 agent 调用），不可用于主 agent 调用。

```typescript
// src/agents/subagent-spawn.ts:59-66
attachments?: Array<{
  name: string,
  content: string,
  encoding?: "utf8" | "base64",
  mimeType?: string,
}>;
```

物化路径：`{targetWorkspace}/.openclaw/attachments/{uuid}/`

限制（默认值，可配置）：

| 限制 | 默认值 | 配置键 |
|------|-------|--------|
| 总大小 | 5 MB | `tools.sessions_spawn.attachments.maxTotalBytes` |
| 文件数 | 50 | `tools.sessions_spawn.attachments.maxFiles` |
| 单文件 | 1 MB | `tools.sessions_spawn.attachments.maxFileBytes` |

默认关闭，需设置 `tools.sessions_spawn.attachments.enabled = true`。

子 agent 通过 `systemPromptSuffix` 得知文件位置（`subagent-attachments.ts:229-233`）。

---

## 九、对 CoClaw 的启示

### 当前可用路径

| 场景 | 可行方案 | 限制 |
|------|---------|------|
| 向 agent 发送图片 | `chat.send` attachments (base64) | 仅图片，5 MB |
| 向 agent 发送任意文件 | 需自建：文件存入 workspace → `agent()` + `extraSystemPrompt` 告知路径 | `chat.send` 不支持 `extraSystemPrompt` |
| 从 agent 获取文件 | Agent 回复中提及相对路径 → UI 解析 → 通过自建 RPC 从 workspace 读取 | 无结构化文件引用机制 |
| Agent workspace 配置文件 | `agents.files.get/set` | 仅 9 个白名单文件 |

### 需要 CoClaw 自建的能力

1. **文件存储服务**：在 CoClaw server 或插件中实现文件的接收、存储、读取
2. **Workspace 文件读写 RPC**：通过插件注册自定义 RPC，读写 agent workspace 中的任意文件
3. **`extraSystemPrompt` 整合**：使用 `agent()` 而非 `chat.send` 发起对话，以便注入文件信息
4. **Markdown 链接解析**：UI 侧解析 agent 回复中的文件路径链接，触发下载/预览
