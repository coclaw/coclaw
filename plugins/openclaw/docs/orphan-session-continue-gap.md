# 2026-02-20 orphan session 续聊能力缺口记录

> 状态：历史记录 — 后续 session 管理演进（Topic 功能、chat history 追踪）已部分覆盖此缺口

## 背景
在 `session-manager` 插件接入测试中，已成功验证：
- `nativeui.sessions.listAll`
- `nativeui.sessions.get`

并按约束选择了较早历史会话（`indexed=false`，即不依赖 `sessions.json` key 映射）进行“继续对话”测试。

## 复现结论
对 `chat.send` 传入 `sessionId`（orphan transcript 对应 id）会失败，错误为：

- `INVALID_REQUEST invalid chat.send params: must have required property 'sessionKey'; at root: unexpected property 'sessionId'`

## 当前判断
- OpenClaw 当前版本 `chat.send` 参数模型要求 `sessionKey`。
- 对 orphan transcript（只有 `sessionId`、无可用 `sessionKey`）无法直接继续对话。
- 因此“list/get 可行，但 orphan continue 暂不可行”。

## 后续演进

自本文档记录以来，session 管理能力已显著增强：

- `nativeui.sessions.listAll` 现在返回 `sessionKey`（通过关联 `sessions.json`），orphan session 标记为 `indexed: false`
- 新增 `coclaw.sessions.getById`：按 sessionId 获取消息记录（仅 message 行），可用于只读查看 orphan transcript
- chat history manager（`coclaw.chatHistory.list`）可追踪 chat reset 产生的孤儿 session
- Topic 功能提供了独立于 sessionKey 体系的对话管理能力

## 仍存在的核心缺口

- **orphan session 续聊**仍不可行：`chat.send` 要求 `sessionKey`，对 orphan transcript（仅有 `sessionId`、无可用 `sessionKey`）无法直接继续对话
- `attach/rehydrate` 类桥接方法仍未实现

## 注意事项
- 在续聊能力缺口未补齐前，不要对 orphan session 执行”继续对话成功”的产品承诺
- 会话联调仍遵循：不删已有 session，不默认创建新 session
