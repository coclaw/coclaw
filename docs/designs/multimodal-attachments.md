# 多模态附件发送设计

> 创建时间：2026-03-28
> 最近修订：2026-03-28（附件信息从 extraSystemPrompt 改为嵌入 user message）
> 状态：草案
> 范围：Chat / Topic 对话中基于附件的多模态信息发送
> 前置依赖：`file-management.md`（文件管理协议）、`webrtc-p2p-channel.md`（WebRTC P2P 基础设施）

---

## 一、概述

### 背景

当前对话中的文件发送受限于 `agent()` 请求只能携带 inline image（base64）。非图片类型（语音、视频、文档等）无法传递给 agent。即使是图片，inline base64 也导致 session `.jsonl` 文件体积膨胀，且 agent 无法对图片进行灵活处理（转换、压缩等）。

### 方案

将所有附件（含图片）统一上传到 agent workspace 的约定目录，在 user message 尾部嵌入附件信息块（markdown 格式），告知 agent 文件路径。Agent 使用自身的文件工具（read/ls 等）读取和处理文件。附件信息随 user message 持久化到 session `.jsonl`，确保多轮对话、session compaction 和历史加载均可追溯。

### 目标

1. 支持任意类型附件（图片、语音、视频、文档等）随对话消息发送
2. 减小 session `.jsonl` 体积（文件内容不再 inline）
3. Agent 可灵活处理文件（读取、转换、压缩等）
4. 用户可在消息中预览/下载已发送的附件

### 不在本期范围

- WS 通道的附件上传 fallback（WebRTC 不可用时暂不支持非图片附件）
- 对话附件的自动清理策略（chat-files 的回收）
- Agent 回复中文件引用的 UI 交互化解析（TODO，见第十节）

---

## 二、整体流程

```
用户选择文件 + 输入文本
        |
        v
  点击发送（锁定输入）
        |
        v
  逐个 POST 上传附件 ──> Plugin 写入 workspace
  （显示进度，可取消）        返回实际 path
        |
        v
  在 user message 尾部拼接附件信息块
        |
        v
  发送 agent RPC ──> OpenClaw agent()
  （message 中包含正文 + 附件信息块）
        |
        v
  Agent 通过文件工具读取附件 ──> 生成回复
```

### 与现有 inline image 的关系

- **新流程**：所有文件（含图片）通过 POST 上传到 workspace，附件信息嵌入 user message 尾部
- **保留现有代码**：WS 通道的 inline image 处理代码暂不删除，作为 WebRTC 不可用时图片发送的 fallback
- **保留 session content 中 inline image 的解析/展示代码**：历史消息中已有的 inline image 仍需正常显示

---

## 三、目录约定

### 3.1 命名空间

附件存储在 agent workspace 内的 `.coclaw/` 目录下。`.coclaw/` 是 CoClaw 在 workspace 内的统一命名空间，未来可扩展存放其它内容（如配置）。

```
<agent-workspace>/
  .coclaw/
    chat-files/          <- 对话附件
    topic-files/         <- 主题附件
```

### 3.2 Chat 附件目录

```
.coclaw/chat-files/<chatKey>/<YYYY-MM>/
```

- `<chatKey>`：sessionKey 去除 `agent:<agentId>:` 前缀后的 rest 部分，冒号用 `--` 转义
- `<YYYY-MM>`：按月分子目录（UI 本地时间），缓解无限积累
- Chat 永不销毁，文件长期保留，暂不做回收

示例：

| sessionKey | chatKey 目录名 | 完整路径示例 |
|---|---|---|
| `agent:main:main` | `main` | `.coclaw/chat-files/main/2026-03/photo-a3f1.jpg` |
| `agent:main:telegram:direct:123` | `telegram--direct--123` | `.coclaw/chat-files/telegram--direct--123/2026-03/doc-b7e2.pdf` |

### 3.3 Topic 附件目录

```
.coclaw/topic-files/<topicId>/
```

- `<topicId>`：UUID，即 topic 的 sessionId
- 不按月分（topic 生命周期有限，文件不会无限积累）
- Topic 删除时，整目录清理：`rm -rf .coclaw/topic-files/<topicId>/`

示例：`.coclaw/topic-files/a1b2c3d4-5678-9abc-def0-123456789abc/report-c4d9.pdf`

### 3.4 文件名唯一化

由 Plugin 负责。在目标目录下生成不重名的文件名。策略：4 位 hex 随机后缀 + 碰撞检测。

规则：
1. 生成 4 位随机 hex 后缀，拼接为 `<name>-<4hex>.<ext>`（如 `photo-a3f1.jpg`）
2. 检查目标目录是否存在同名文件
3. 碰撞时重新生成后缀，直到不重名

Plugin 返回的 `path` 中包含实际文件名。UI 展示时直接使用自身保存的原始文件名，无需从存储文件名反向解析。历史消息中原始文件名的还原见 TODO 10.6。

---

## 四、上传协议

基于 `file-management.md` 中定义的 POST 协议。

### 4.1 请求格式

```json
{
  "method": "POST",
  "agentId": "main",
  "path": ".coclaw/chat-files/main/2026-03",
  "fileName": "photo.jpg",
  "size": 204800
}
```

| 字段 | 说明 |
|------|------|
| `method` | 固定 `"POST"` |
| `agentId` | 目标 agent |
| `path` | 集合目录路径（由 UI 构造，相对于 workspace） |
| `fileName` | 原始文件名 |
| `size` | 文件大小（字节） |

Chat 模式：`path` = `.coclaw/chat-files/<escapedChatKey>/<YYYY-MM>`
Topic 模式：`path` = `.coclaw/topic-files/<topicId>`

### 4.2 响应格式

```json
{
  "ok": true,
  "bytes": 204800,
  "path": ".coclaw/chat-files/main/2026-03/photo-a3f1.jpg"
}
```

`path` 是 Plugin 生成的实际存储路径（相对于 workspace），UI 用它来：
1. 构造 user message 尾部附件信息块中的路径
2. 后续预览/下载时作为 GET 的 `path` 参数

### 4.3 传输细节

消息序列、分片、流控、取消等完全复用 `file-management.md` 第四节和第六节的定义，无额外约定。

---

## 五、附件信息块格式

### 5.1 为什么嵌入 user message 而非 extraSystemPrompt

经研究确认，OpenClaw 的 `extraSystemPrompt` 是**运行时临时注入**，不持久化到 session `.jsonl`：

- 每次 `agent()` 调用独立使用当前的 `extraSystemPrompt`，不累积
- 前一次调用的 `extraSystemPrompt` 在后续调用中完全不可见
- session compaction 时仅保留当前调用的值

如果用 `extraSystemPrompt` 携带附件路径，会导致：多轮对话中历史附件信息丢失、历史消息无法还原附件展示、compaction 后文件引用可能丢失。

因此，将附件信息**直接嵌入 user message 文本尾部**。这样：
- 附件信息随消息持久化到 `.jsonl`
- 多轮对话中 agent 始终能看到历史附件
- UI 从历史消息中可解析还原附件展示
- 用户仅发送文件时无需占位符（附件信息块本身即为消息内容）
- 用户在其它 app（如 OpenClaw WebChat）中也能看到附件信息

### 5.2 附件信息块格式（采用方案）

在 user message 尾部追加 markdown 格式的附件信息块，与正文之间用空行分隔。采用 `##` 标题 + markdown table：

**正常情况**（无文件名碰撞）：

```
帮我分析这张图片

## coclaw-attachments 🗂

| Path | Size |
|------|------|
| .coclaw/chat-files/main/2026-03/photo-a3f1.jpg | 200KB |
| .coclaw/chat-files/main/2026-03/report-b7e2.pdf | 2.1MB |
| .coclaw/chat-files/main/2026-03/voice-c4d9.webm | 120KB |
```

**有文件名碰撞时**（本批次中存在原始文件名重复）：

```
帮我对比这两张照片

## coclaw-attachments 🗂

| Path | Size | Name |
|------|------|------|
| .coclaw/chat-files/main/2026-03/photo-a3f1.jpg | 200KB | |
| .coclaw/chat-files/main/2026-03/photo-c9d4.jpg | 150KB | photo.jpg |
```

`Name` 列仅在本批次存在碰撞时出现。碰撞的文件行填入用户实际上传的原始文件名，未碰撞的行留空。

**仅发送文件**（无正文）：

```
## coclaw-attachments 🗂

| Path | Size |
|------|------|
| .coclaw/chat-files/main/2026-03/report-b7e2.pdf | 2.1MB |
```

消息内容仅包含附件信息块，无需占位符。

#### 格式说明

| 要素 | 说明 |
|------|------|
| `## coclaw-attachments 🗂` | 固定标题行，作为解析边界。`🗂`（U+1F5C2, card index dividers）为辅助标记 |
| markdown table | 标准 markdown 表格，其它 app 可直接渲染 |
| `Path` 列 | workspace 相对路径，agent 可直接用于 read 工具调用 |
| `Size` 列 | 人类可读的文件大小 |
| `Name` 列 | 可选，仅碰撞时出现，记录原始文件名 |
| 块位置 | 始终在消息末尾，标题之后到消息结尾即为附件区 |

#### 解析规则

UI 渲染消息时：
1. 查找 `## coclaw-attachments 🗂` 行
2. 将该行及之后内容识别为附件信息块
3. 解析 markdown table 提取 Path、Size（及可选 Name）
4. 将附件信息块从正文中剥离，渲染为附件卡片
5. 展示时使用 UI 侧保存的原始文件名（当前会话），或存储文件名（历史消息）

#### 设计考量

- **Model 友好**：markdown 标题 + table 是 LLM 最熟悉的格式，无需额外提示即可理解
- **人类可读**：其它 app 中渲染为标题 + 表格，用户能清楚看到附件信息
- **解析可靠**：`coclaw-attachments` + `🗂` 组合作为标记极不可能在用户正文中出现；块始终在末尾，无需闭合标记
- **Token 效率**：固定开销 3 行（标题 + 表头 + 分隔线），每个文件约 15-20 tokens
- **特殊字符**：路径由 Plugin 控制，不含 `|`；万一原始文件名含 `|`，markdown table 中用 `\|` 转义

> TODO: 当文件扩展名与实际 MIME type 不一致时，UI 应在 Size 列追加类型提示（如 `500KB, audio/webm`）。

### 5.3 曾考虑的方案

#### 方案 B：标记块 + pipe 分隔（基于方案 A 改进）

```
帮我分析这张图片

[coclaw-attachments]
.coclaw/chat-files/main/2026-03/photo-a3f1.jpg | 200KB
.coclaw/chat-files/main/2026-03/report-b7e2.pdf | 2.1MB
[/coclaw-attachments]
```

使用 `[coclaw-attachments]` / `[/coclaw-attachments]` 开闭标记，一行一个文件，` | ` 分隔路径和大小。

优点：解析边界明确（开闭标记）；比 markdown table 更紧凑（无表头开销）。
未采用原因：需要闭合标记；其它 app 无法直接渲染为结构化展示；扩展列（如 Name）时格式不如 table 清晰。

#### 方案 C：extraSystemPrompt

最初方案。将附件路径列表放入 `agent()` 的 `extraSystemPrompt` 字段。

未采用原因：`extraSystemPrompt` 不持久化到 `.jsonl`，导致多轮对话中历史附件信息丢失、历史消息无法还原附件展示、session compaction 后文件引用可能丢失。详见 5.1。

### 5.4 sendMessage 流程改造

```
sendMessage(text, files)
  |
  |-- 1. 守卫检查（sending、连接状态等）
  |
  |-- 2. 构造乐观消息（optimistic user + bot）
  |      图片文件：仍生成 base64 用于即时预览
  |      所有文件：记录 { name, size, type } 用于消息展示
  |
  |-- 3. 上传附件（如有）
  |      锁定输入（uploadingFiles = true）
  |      逐个 POST 上传：
  |        file.uploading = true
  |        file.progress = 0 → 1
  |        成功：记录返回的 path
  |        失败：标记失败，中止后续上传
  |      解锁输入
  |
  |-- 4. 构造 agentParams
  |      message: text + 附件信息块（见 5.2）
  |      sessionKey / sessionId: 按 chat/topic 模式
  |
  |-- 5. 发送 agent RPC（现有流程）
```

### 5.5 仅文本消息

无附件时，message 即为纯文本，流程与现有完全一致。

---

## 六、上传交互设计

### 6.1 上传进度

参考 qidianchat 的方式：

- 每个文件卡片上显示进度环（圆形进度条）
- 文件处于上传中时，卡片半透明
- 上传完成后进度环消失，恢复正常显示

### 6.2 上传期间锁定

上传进行中时：
- 发送按钮禁用
- 输入框禁用（或显示上传状态提示）
- 用户不可编辑文件列表

### 6.3 上传顺序

逐个上传（串行），非并行。原因：
- 避免同时创建多个 file DC 的资源开销
- 进度展示更直观（用户能看到当前正在上传哪个文件）
- 串行上传中某个失败可立即中止，避免浪费后续上传

### 6.4 上传失败处理

部分上传成功、部分失败时：

1. **已上传的文件保留在 workspace**（不回删）
2. **UI 将所有文件恢复到待发状态**（调用 `restoreFiles`）
3. **内部记录已成功上传的文件及其 path**
4. **用户再次点击发送时，跳过已成功上传的文件**，仅上传剩余的
5. 通知用户上传失败原因

### 6.5 取消上传

用户可在上传过程中取消（关闭 DC 即可）。已上传的文件保留在 workspace，不回删。

---

## 七、消息中的附件展示

### 7.1 用户消息

用户消息区展示已发送的附件信息：
- 图片：缩略图预览（使用本地 base64 或 Object URL，不依赖 workspace 文件）
- 非图片：文件卡片（图标 + 文件名 + 大小）

### 7.2 预览与下载

用户点击附件时：
- **可预览类型**（图片等）：打开预览
- **其它类型**：触发下载（通过 file DC GET 从 workspace 读取）

下载使用 `file-management.md` 中定义的 GET 协议，`path` 即为上传时 Plugin 返回的路径。

### 7.3 历史消息中的附件

从 session `.jsonl` 加载历史消息时，user message 文本中包含附件信息块。UI 解析 `## coclaw-attachments 🗂` 标记及其 markdown table，还原附件展示。

> 现有 inline image 的解析和展示代码保留不动，确保历史 inline image 消息正常显示。

---

## 八、关键标识符

发送时各标识符的来源：

| 标识符 | Chat 模式 | Topic 模式 |
|--------|----------|-----------|
| `agentId` | 从 `chatSessionKey` 解析（第二段） | `topicAgentId` |
| 集合目录 `path` | `.coclaw/chat-files/<escapedRest>/<YYYY-MM>` | `.coclaw/topic-files/<topicId>` |
| `chatKey`（rest 部分） | `chatSessionKey` 去掉 `agent:<agentId>:` 前缀 | 不适用 |
| `topicId` | 不适用 | `sessionId`（= topicId） |
| 附件信息块 | 拼接在 `agentParams.message` 尾部 | 同左 |

### chatKey 转义规则

```js
// agent:main:telegram:direct:123 → telegram--direct--123
const rest = chatSessionKey.split(':').slice(2).join(':');
const escaped = rest.replaceAll(':', '--');
```

---

## 九、兼容性说明

| 场景 | 处理方式 |
|------|---------|
| WebRTC 可用 | 新流程：POST 上传 + 附件信息块嵌入 message |
| WebRTC 不可用，发送图片 | 保留现有 WS inline base64 路径 |
| WebRTC 不可用，发送非图片 | 暂不支持，提示用户 |
| 历史消息中的 inline image | 现有解析/展示代码保留，正常显示 |
| 历史消息中的附件引用 | 从 user message 文本中解析附件信息块，展示附件卡片 |

---

## 十、未来优化项

### 10.1 Agent 文件引用格式化（TODO）

引导 agent 在回复中引用文件时使用统一的 workspace 相对路径格式（如通过 AGENTS.md 或 TOOLS.md 中的约定）。UI 可解析这些路径并渲染为可交互元素（预览/下载）。

### 10.2 文件扩展名与 MIME type 校验（TODO）

上传前检查文件扩展名是否与实际 MIME type 一致。不一致时在附件信息块 Size 列追加类型信息。

### 10.3 WS fallback（TODO）

WebRTC 不可用时，通过 WS 通道上传附件。需要设计 WS 上的文件传输协议（可能基于 base64 分片或 binary WebSocket frames）。当前仅图片可通过 WS 走 inline base64。

### 10.4 Chat 附件清理策略（TODO）

Chat 附件长期积累，后续可加策略：
- 按月清理（保留最近 N 个月）
- LRU（保留最近 N 条消息的附件）
- 用户手动清理（在 UI 中提供清理入口）

### 10.5 上传前压缩（TODO）

大图片在上传前可在 UI 侧压缩（如 canvas resize），减少传输时间和存储占用。

### 10.6 附件信息块携带原始文件名（TODO）

在 Name 列中始终携带原始文件名（不仅碰撞时），便于历史消息渲染时还原显示名称，无需额外映射机制。
