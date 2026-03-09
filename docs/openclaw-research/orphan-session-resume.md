# CoClaw：基于 Orphan/归档 Session 的续聊实现说明（Gateway WS）

> 更新时间：2026-03-02  
> 面向对象：coding agent / 开发同学  
> 目标：先把“基于 orphan 历史 session 的继续对话”在 CoClaw 跑通。

---

## 1. 背景与明确结论

基于已完成验证（`tunnel-poc/docs/2026-03-01-orphan-session-resume-verification.md`），结论如下：

1. `chat.send(sessionKey=<orphanSessionId>)` **不能**可靠续写 orphan transcript。
2. `agent(sessionId=<orphanSessionId>)` **可以**续写 orphan transcript。

因此，CoClaw 第一阶段要实现 orphan 续聊，**必须走 Gateway WS 的 `agent` 方法 + `sessionId` 参数**。

---

## 2. 适用范围与非目标

### 2.1 适用范围

- 用户在 CoClaw 前端选择一个“历史/归档/孤儿 session”（有 `sessionId`，可能没有当前 `sessions.json` 的 key 映射）。
- 用户在该会话里继续发消息。
- CoClaw 通过 Gateway WebSocket 发起对话并流式展示执行过程与结果。

### 2.2 非目标（本阶段不做）

- 不改 OpenClaw 源码。
- 不强行把 orphan session 兼容为 `chat.send` 语义。
- 不做新 Gateway API（如 `sessions.resume`）。

---

## 3. 协议层选择（必须）

## 3.1 常规会话 vs orphan 会话

- **常规会话（有稳定 sessionKey）**：继续使用 `chat.send`。
- **orphan/归档会话（仅 sessionId 可靠）**：使用 `agent`。

建议在 server 侧做路由：

- `mode = "chat"` -> `chat.send`
- `mode = "orphan-resume"` -> `agent(sessionId=...)`

避免前端直接判断过多细节。

## 3.2 orphan-resume 请求参数（CoClaw 内部）

建议 CoClaw server 对 UI 暴露统一接口（示例）：

```json
{
  "openclawBotId": "bot_xxx",
  "sessionId": "5c8e57f0-73c0-47ed-b302-7e55804a916b",
  "message": "继续上次的话题...",
  "idempotencyKey": "uuid-v4",
  "thinking": "medium"
}
```

然后映射到 Gateway WS：

```json
{
  "id": "req-xxx",
  "type": "req",
  "method": "agent",
  "params": {
    "sessionId": "5c8e57f0-73c0-47ed-b302-7e55804a916b",
    "message": "继续上次的话题...",
    "deliver": false,
    "idempotencyKey": "uuid-v4",
    "thinking": "medium"
  }
}
```

说明：

- `deliver: false`：避免消息向外部渠道再次投递，专注 WebChat/CoClaw UI 内对话。
- `idempotencyKey`：必须稳定唯一，用于重试去重和 run 追踪。

---

## 4. 事件流与 run 标识

> chat.send 与 agent 的完整协议对比详见 `rpc-and-session.md`。

本方案使用 `agent(sessionId)` 路径：

- ACK：`status: "accepted"`（含 `runId`）
- 主事件：`event = "agent"`，stream 类型：`lifecycle` / `assistant` / `tool`
- 可选等待：`agent.wait({ runId })`
- `runId` 是一次执行标识（通常等于 `idempotencyKey`），与 `sessionId`（会话标识）不要混用

---

## 5. 前端流式展示映射规范（必须实现）

为了让 orphan 续聊体验接近 chat.send，需要把 `agent` 事件映射为 UI 聊天流。

## 5.1 事件过滤

只处理当前请求的 `runId`：

- 若 `event.payload.runId !== currentRunId`，忽略。

## 5.2 assistant 文本流

- `stream=assistant` 且 `data.text` 存在：更新流式气泡。
- 建议以 `data.text` 作为“当前完整文本”，而非追加 `delta`（避免重复拼接）。

## 5.3 tool 事件

- `stream=tool`：展示工具执行轨迹（可折叠）。
- phase 建议支持：
  - `start`
  - `update`
  - `result`

## 5.4 生命周期

- `stream=lifecycle, phase=start`：标记运行开始。
- `phase=end`：固化 assistant 最终内容，run 完成。
- `phase=error`：run 失败，展示错误。

---

## 6. 后端状态机（建议）

对单次 orphan-resume run：

1. `INIT`
2. 收到 agent ACK -> `ACCEPTED`
3. 收到 lifecycle.start -> `RUNNING`
4. assistant/tool 持续更新 -> `RUNNING`
5. lifecycle.end -> `SUCCEEDED`
6. lifecycle.error 或超时 -> `FAILED`

超时策略：

- 网关 ACK 超时（短超时，如 10s） -> 直接失败
- 运行超时（长超时，如 120~600s，可配置） -> 调 `agent.wait` 或本地超时收敛

---

## 7. 最小可交付开发任务拆分

## 7.1 server（CoClaw）

1. 新增“orphan resume send”服务函数（Gateway WS client）：
   - 请求 `agent`（带 `sessionId`）
   - 监听 `agent` 事件并按 `runId` 过滤
   - 将事件转发给 UI SSE/WebSocket
2. 标准化返回结构：
   - accepted / running / final / error
3. 可选：调用 `agent.wait` 做最终兜底收敛（防止事件丢失）

## 7.2 ui（CoClaw）

1. 对 orphan 会话发送消息走新接口。
2. 支持 `agent` 事件渲染：
   - assistant 流式文本
   - tool timeline（先简版即可）
   - lifecycle 完成/失败状态
3. 保持与普通 chat.send 对话在视觉上尽量一致。

---

## 8. 错误处理与重试

## 8.1 可重试错误

- 网关连接中断
- ACK 未返回
- `lifecycle.error`（可由用户手动重试）

## 8.2 重试要求

- **同一次业务重试必须复用同一个 `idempotencyKey`**（保证网关去重）。
- 用户“重新发送”才生成新 key。

## 8.3 典型错误文案

- `No session found`（如果误走 chat.send）
- Gateway unavailable
- Agent run timeout

---

## 9. 验收标准（DoD）

满足以下全部条件即算跑通：

1. 选中 orphan session 后发送消息，UI 能看到流式回复。
2. 目标历史 transcript 文件大小增长。
3. marker 文本可在目标 transcript 尾部检索到。
4. tool calls 在 UI 可见（至少 start/result）。
5. 失败时 UI 能明确显示错误并允许重试。

---

## 10. 回归测试用例（建议）

1. **Happy path**：`agent(sessionId)` 正常续聊。
2. **对照失败路径**：`chat.send(sessionKey=<same_uuid>)` 失败（防回归误用）。
3. **并发双请求**：不同 runId 事件不串流。
4. **重试去重**：同 idempotencyKey 重试不重复启动 run。
5. **网络抖动**：中途断链后重连可通过 `agent.wait` 或最终态补齐。

---

## 11. 与 OpenClaw 现状对齐（实现依据）

- `chat.*` 为 sessionKey 驱动，不等价于按孤儿 `sessionId` 恢复。
- `agent` 支持显式 `sessionId` 参数，验证可续写 orphan transcript。
- 参考验证文档：
  - `tunnel-poc/docs/2026-03-01-orphan-session-resume-verification.md`

---

## 12. 后续演进（第二阶段，可选）

1. 统一会话发送入口（server 自动识别 key/sessionId，内部路由 chat.send 或 agent）。
2. 增加“会话恢复能力探测”缓存，减少失败试探。
3. 如后续 OpenClaw 提供 `chat.send(sessionId)`/`sessions.resume`，再切换到官方统一语义。

---

## 附录 A：最小事件样例（agent）

```json
{ "event": "agent", "payload": { "runId": "r1", "stream": "lifecycle", "data": { "phase": "start" } } }
{ "event": "agent", "payload": { "runId": "r1", "stream": "assistant", "data": { "text": "正在继续上次会话..." } } }
{ "event": "agent", "payload": { "runId": "r1", "stream": "tool", "data": { "phase": "start", "name": "read", "toolCallId": "t1" } } }
{ "event": "agent", "payload": { "runId": "r1", "stream": "tool", "data": { "phase": "result", "name": "read", "toolCallId": "t1", "isError": false } } }
{ "event": "agent", "payload": { "runId": "r1", "stream": "lifecycle", "data": { "phase": "end" } } }
```

---

## 附录 B：给 coding agent 的一句执行指令（可直接贴）

在 CoClaw 中实现 orphan session 续聊 MVP：

1. 新增一条发送路径，调用 Gateway WS `agent`，传 `sessionId`（而非 chat.send 的 sessionKey）。
2. 把 `agent` 事件（lifecycle/assistant/tool）按 `runId` 映射到现有聊天流 UI。
3. 保持 `deliver=false`，并实现失败重试与 idempotencyKey 去重。
4. 增加最小自动化测试覆盖：happy path、误用 chat.send 对照、并发 runId 过滤。
