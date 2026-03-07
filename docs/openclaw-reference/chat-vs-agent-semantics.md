# OpenClaw 对话机制要点：`chat.send` vs `agent(sessionKey)`

> 更新时间：2026-03-03  
> 适用项目：CoClaw

## 1. 统一结论

- `chat.send` 与 `agent()` 底层都会触发 agent run。
- 两者差异主要在 **Gateway 对外协议层**：
  - `chat.send`：聊天聚合协议（`event: chat`）
  - `agent()`：执行事件协议（`event: agent`）

---

## 2. sessionKey / sessionId 语义

- `sessions.json` 是 `sessionKey -> sessionEntry(sessionId, ...)` 映射。
- 一个 `sessionKey` 只指向一个当前 `sessionId`；但一个 agent 可有多个 `sessionKey`。
- `agent:main:main` 是 main agent 的主会话 key（DM scope=main 时常用）。
- `agent:main:<custom>`（如 `session-research-*` 或裸 uuid 变体）本质是“显式自定义业务 key”。

### cron key 语义

- `agent:main:cron:<jobId>`：cron job 级锚点 key（当前指针）
- `agent:main:cron:<jobId>:run:<runId/sessionId>`：单次运行快照 key
- run key 不是“子会话层级”，而是运行记录别名；下一次 run 时 base key 会前移。

---

## 3. `agent(sessionKey)` 是否可行

可行，且可保持会话桶语义：

- `agent` 方法支持 `sessionKey` 参数。
- 使用 `sessionKey` 时，OpenClaw 会按 key 读取/更新会话 entry（而不是绕开 key）。
- 因此不会像 `agent(sessionId)`（orphan 恢复场景）那样弱化 key 语义。

> 结论：`agent(sessionKey)` 不是 `chat.send` 的“调用别名”，但在会话维护层面可覆盖大部分 chat 需求。

---

## 4. `chat.send` 与 `agent()` 的事件差异

## 4.1 `chat.send`

- ACK：`runId + status=started`
- 主事件：`event=chat`
  - `state=delta|final|error|aborted`
- 面向聊天 UI 的聚合流，默认更“简化”。

## 4.2 `agent()`

- ACK：`runId + status=accepted + acceptedAt`
- 主事件：`event=agent`
  - `stream=lifecycle|assistant|tool`
- 更适合展示执行过程、工具轨迹、生命周期。

---

## 5. 关于工具调用与“思考过程”

- `chat` 的 `delta` 是实时文本增量，但不承载完整 tool 事件结构。
- tool 调用轨迹应从 `event=agent, stream=tool` 获取。
- 若 UI 要展示执行过程（工具调用、阶段进展），应消费 `agent` 事件。

---

## 6. `agent:main:main` 创建时机

- `agent:main:main` 作为 canonical key 总是可解析。
- 但其在 `sessions.json` 的 entry 通常是**按需创建**（首次实际会话流量写入时）。
- 非“安装后/启动后必定预置 entry”。

---

## 7. 自动 session reset 可观测性

- 自动 reset（会话 freshness 失效后换新 sessionId）通常不会单独推送“session changed”专门事件。
- `chat.send` ACK 与 `chat` 事件都不直接包含底层 `sessionId`。
- 若要判断是否重置，需主动查询（见下一个文档）。

---

## 8. 对 CoClaw 的建议

- 若目标是统一 UI 展示执行过程，优先考虑 `agent(sessionKey)` 作为常规路径。
- orphan/归档恢复继续保留 `agent(sessionId)`。
- 列表层可先收敛为仅 `agent:main:main` 可聊（其余 key 作为系统/特殊会话不开放）。
