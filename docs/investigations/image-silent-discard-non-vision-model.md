# 图片被静默丢弃：模型不支持 vision 时无用户反馈

- 日期：2026-03-06
- 状态：分析完成，待跟进
- 关联：内测用户反馈"图片未发送成功"

## 现象

用户在 CoClaw 中发送图片+文本消息后，文本被正常处理，但图片"没有发送出去"，且无任何错误提示。

## 根因

OpenClaw Gateway 对图片附件的处理链路存在设计缺陷：

1. **`chat.send` 阶段**（`server-methods/chat.ts`）：无条件接收并解析 attachments，提取 `parsedImages`，不检查模型是否支持 vision。
2. **auto-reply 分发阶段**：images 透传到 agent 执行层。
3. **Agent 执行阶段**（`pi-embedded-runner/run/images.ts:271-309`）：
   - `modelSupportsImages(model)` 检查 `model.input` 是否包含 `"image"`。
   - 若模型配置为 `input: ["text"]`（不含 `"image"`），`detectAndLoadPromptImages()` 返回空数组。
   - **图片被静默丢弃，不报错、不通知用户。**

### 模型 vision 能力定义

在 `models-config.providers.ts` 中，模型通过 `input` 数组声明能力：
- 支持 vision：`input: ["text", "image"]`（如 Claude 3.5 Sonnet、GPT-4V）
- 仅文本：`input: ["text"]`（如 Qwen Coder、部分 DeepSeek 模型）

## 影响范围

- 所有通过 CoClaw 发送图片的用户，若其 OpenClaw 配置的模型不支持 vision，图片均会被静默丢弃。
- 用户无法得知图片未被处理。

## CoClaw 侧可行方案

1. **短期**：在 UI 文档或帮助中提示用户确认模型是否支持 vision。
2. **中期**：发送前通过 RPC 查询模型能力，若不支持 vision 则在 UI 提示用户。
3. **长期**：向 OpenClaw 社区反馈，建议在 `chat.send` 阶段即返回 vision 不支持的错误，而非静默丢弃。

## 排查建议

遇到用户反馈图片未送达时，优先确认：
1. 用户 OpenClaw 配置的模型是否支持 vision（`input` 数组是否包含 `"image"`）。
2. 图片大小是否超过 5MB（`maxBytes: 5_000_000`）。
3. 图片格式是否可被 `sniffMimeFromBase64()` 识别（HEIC/HEIF 等特殊格式可能不支持）。
4. OpenClaw gateway 日志中搜索 "dropping" 或 "attachment" 相关 warn。
