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

## 当前决策
- 暂不在本轮实现 `attach/rehydrate` 类桥接方法。
- 先保留该缺口，后续专题处理。

## 后续可选方向（待评估）
1. 在插件中增加 `nativeui.sessions.attach`：
   - 输入 `sessionId`
   - 输出可用于 `chat.send` 的 `sessionKey`
2. 评估是否可利用 gateway/session store 现有能力进行安全挂载（不破坏现有 session 索引）。
3. 若无官方能力，考虑最小可控的“只读 + 显式 attach”双阶段方案。

## 注意事项
- 在能力缺口未补齐前，不要对 orphan session 执行“继续对话成功”的产品承诺。
- 会话联调仍遵循：不删已有 session，不默认创建新 session。
