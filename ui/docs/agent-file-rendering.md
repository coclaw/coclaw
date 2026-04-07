# Agent 文件渲染

- **状态**：设计中
- **更新日期**：2026-04-07
- **适用范围**：`ui` 工作区，涉及 MarkdownBody、ChatMsgItem、chat.store、session-msg-group、coclaw-file 服务等模块

## 背景

用户消息中的附件已支持上传和渲染（ChatImg / ChatFile / ChatAudio）。现需支持渲染 agent 回复中引用的文件——agent 在 markdown 文本中使用 `coclaw-file:` 协议引用其 workspace 内的文件。

## coclaw-file 协议扩展

### 现有格式（完整 URL，前端内部使用）

```
coclaw-file://clawId:agentId/path/to/file
```

- `//` 引入 authority（RFC 3986 标准层级 URI）
- `clawId:agentId` 为 authority
- 路径为 workspace 相对路径（不含前导 `/`）

### 新增格式（Agent 编写，无 authority）

```
coclaw-file:path/to/file
```

- 无 `//`，scheme 后直接跟路径（RFC 3986 合法的 path-rootless URI）
- 路径为 workspace 相对路径，与完整 URL 中的 path 语义一致
- 前端渲染时结合上下文的 `clawId` / `agentId` 补全为完整 URL

### 路径安全校验

前端在处理 agent 提供的路径前，需做基本校验：

- 拒绝包含 `../` 的路径（路径穿越）
- 拒绝以 `/` 开头的路径（绝对路径，当前不支持）
- 校验不通过时忽略该链接，不构建 coclaw-file URL

### 示例

Agent 在 markdown 中写：

```markdown
分析完成，结果如下：

![趋势图](coclaw-file:output/trend.png)

详细数据见 [完整报告](coclaw-file:output/report.xlsx)。
```

## extraSystemPrompt

### 组装位置

`chat.store.js` 的 `sendMessage` 方法中，agentParams 组装阶段（约第 478–496 行）。

### 策略

每次 agent 请求都携带文件渲染能力提示（OpenClaw 不持久化 extraSystemPrompt，已使用的不会在后续请求中保留）。

与现有语音转录提示合并为统一的 extraSystemPrompt：

```js
// 基础提示（始终携带）
const prompts = [
  '当你需要向用户展示文件时，可在回复中使用 coclaw-file: 协议引用文件：',
  '- 图片：![描述](coclaw-file:文件路径)',
  '- 其他文件：[文件名](coclaw-file:文件路径)',
  '路径为相对于工作目录的相对路径。',
];

// 语音转录提示（条件追加）
if (finalMessage.voicePaths?.length) {
  prompts.push('');
  prompts.push('用户通过语音输入发送了以下音频文件，请先转录再回复：');
  prompts.push(...finalMessage.voicePaths.map((p) => `- ${p}`));
}

agentParams.extraSystemPrompt = prompts.join('\n');
```

## 分阶段实施

### Phase 1：链接点击 + 附件卡片

Phase 1 中 agent 回复的 coclaw-file 引用通过两种方式呈现：

- **A（链接点击）**：markdown 中的 `coclaw-file:` 链接可点击，触发下载或查看
- **B（附件卡片）**：从最终结果中提取所有 coclaw-file 引用，以附件卡片形式渲染

#### 1A. Markdown 预处理：图片语法转链接语法

Agent 回复的 markdown 在渲染前，将 `![desc](coclaw-file:path)` 转为 `[🖼 desc](coclaw-file:path)`。

- 转换时机：`MarkdownBody` 的 `revisedText` computed 阶段，或在 `renderMarkdown` 之前
- 转换后图片不会被浏览器尝试加载（避免破图），而是显示为可点击链接
- 若 `desc` 为空，用文件名作为显示文本：`[🖼 trend.png](coclaw-file:output/trend.png)`

正则示例：

```js
text.replace(/!\[([^\]]*)\]\((coclaw-file:[^)]+)\)/g, (_, alt, url) => {
  const label = alt || url.split('/').pop();
  return `[🖼\u00A0${label}](${url})`;
});
```

#### 1B. 链接点击拦截

扩展 `MarkdownBody.vue` 的 `onLinkClick`（第 122–139 行），新增 `coclaw-file:` scheme 处理：

```
onLinkClick 判断链路：
  coclaw-file:path
    ├─ 路径安全校验（拒绝 ../ 和 /）
    ├─ 构建完整 coclaw-file://clawId:agentId/path URL
    ├─ 图片扩展名？→ fetchCoclawFile → ImgViewDialog 查看
    └─ 非图片？→ fetchCoclawFile → 触发浏览器下载保存
```

**需要解决的问题**：`MarkdownBody` 当前不感知 `clawId` / `agentId`。需要通过 props 或 provide/inject 从 `ChatMsgItem` 传入。

#### 1C. 附件提取与渲染

**提取时机**：仅在 agent run 结束后提取。在 `session-msg-group.js` 的消息分组阶段处理。

**提取逻辑**：从 botTask 的 `resultText` 中扫描所有 `coclaw-file:` 引用：

- `![...](coclaw-file:path)` → 图片附件
- `[...](coclaw-file:path)` → 根据扩展名判断类型（isImageByExt / isVoiceByExt）

提取结果按出现顺序排列，按 path 去重，存入 botTask 的新字段 `attachments`：

```js
// botTask 结构扩展
{
  type: 'botTask',
  resultText,      // 不剥离 coclaw-file 链接（Phase 2 需要保留）
  attachments,     // [{ path, name, isImg, isVoice }]
  // ... 其他字段
}
```

**渲染**：在 `ChatMsgItem.vue` 的 botTask 模板中，`<MarkdownBody>` 之后、底部元信息之前，渲染附件卡片列表：

```vue
<!-- agent 文件附件 -->
<div v-if="agentAttachments?.length" class="flex flex-wrap gap-2 mt-2">
  <ChatImg v-for="att in agentImages" :key="att.path" :src="att.url" :filename="att.name" />
  <ChatFile v-for="att in agentFiles" :key="att.path" :src="att.url" :name="att.name" />
</div>
```

`agentAttachments` computed 负责将 `attachments` 中的 path 构建为完整 `coclaw-file://` URL。逻辑与现有 `userAttachments`（第 229–245 行）类似。

### Phase 2：Markdown 内联图片渲染（后续）

Phase 1 完成后，用户已能通过附件卡片查看 agent 图片。Phase 2 在此基础上增强体验——图片在 markdown 文本中就地渲染。

#### 方案概要

- 不再将 `![](coclaw-file:...)` 转为链接语法，保留为图片语法
- 自定义 markdown-it 的 image renderer，对 `coclaw-file:` src 输出带标记的 `<img>` 占位元素
- `MarkdownBody.__postProcess` 中异步处理这些占位元素：下载 → 压缩缩略图 → 替换 src
- 复用 ChatImg 的核心逻辑（fetchCoclawFile + compressImage），但以 DOM 操作实现，不挂载 Vue 组件
- 附件卡片区中的图片附件可考虑移除（避免重复），或保留作为补充入口

#### Phase 2 对 Phase 1 的影响

- 图片预处理（`![]()` → `[]()`）需改为条件性的，Phase 2 启用后不再转换
- 附件提取逻辑不变，但渲染时可区分已内联渲染的图片

## 涉及的文件

| 文件 | Phase 1 改动 |
|------|-------------|
| `src/stores/chat.store.js` | extraSystemPrompt 组装 |
| `src/utils/markdown-engine.js` 或 `MarkdownBody.vue` | 图片语法→链接语法预处理 |
| `src/components/MarkdownBody.vue` | onLinkClick 扩展、传入 clawId/agentId |
| `src/utils/session-msg-group.js` | 附件提取逻辑、botTask 字段扩展 |
| `src/components/ChatMsgItem.vue` | agent 附件卡片渲染 |
| `src/services/coclaw-file.js` | 新增路径安全校验工具函数、无 authority URL 解析 |
| `src/utils/file-helper.js` | 可能新增提取 coclaw-file 引用的工具函数 |
