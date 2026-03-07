# CoClaw 方案：在插件侧通过 Gateway WebSocket 确保 `agent:main:main` 可用

> 更新时间：2026-03-03  
> 目标：在 CoClaw 插件启动后，主动确保 OpenClaw 主会话 key（`agent:main:main`）对应 entry 存在，避免 UI 首次对话时出现“无会话映射”问题。

---

## 1. 背景与结论

已确认：

- OpenClaw 启动时**不保证**在 `sessions.json` 中预创建 `agent:main:main` entry。
- main key 通常在首条命中消息到达时按需创建。

因此，为了让 CoClaw 的“开箱即聊”更稳定，需要一个显式“ensure”动作。

你倾向在插件侧做，这个方向可行：

- 插件本来就会连接 Gateway WebSocket；
- 直接调用 OpenClaw 的**公开 WebSocket API**（而不是触碰内部文件）即可；
- 实现简单、行为可观测、升级风险低。

---

## 2. 设计原则

1. **仅用公开网关 API**（`sessions.resolve` / `sessions.reset` / 可选 `chat.history`）。
2. **幂等**：多次调用不会产生副作用风暴。
3. **最小侵入**：不修改 OpenClaw 核心代码、不直接改 `sessions.json`。
4. **可观测**：记录 ensure 成功/失败日志和耗时。

---

## 3. 推荐流程（插件启动后执行一次）

目标 key：`agent:main:main`

### Step A：探测

调用：

- `sessions.resolve({ key: "agent:main:main" })`

判定：

- 若 `ok=true` 且返回 entry/sessionId 存在 => 已就绪，结束。
- 否则进入 Step B。

### Step B：创建（ensure）

调用：

- `sessions.reset({ key: "agent:main:main", reason: "new" })`

说明：

- `sessions.reset` 在 key 不存在时会写入新 entry（生成新的 sessionId）。
- 这比调用内部 JS API 或手动写文件更安全。

### Step C：复核

再次调用：

- `sessions.resolve({ key: "agent:main:main" })`

若仍失败，标记为初始化告警（不阻塞插件主流程，但提示运维排查）。

---

## 4. 失败与重试策略

1. WS 未连接：等待连接建立后再执行 ensure。  
2. 请求超时：指数退避重试（建议 3 次：0.5s / 1s / 2s）。  
3. 权限/参数错误：立即告警并停止重试（配置问题）。  
4. 避免循环风暴：单进程生命周期内仅执行一次 ensure（成功/最终失败后都停止）。

---

## 5. 与现有对话方案的关系

- 若你们后续常规对话走 `agent(sessionKey="agent:main:main")`，本方案可保证首次发送前 key 已有 entry。  
- 若保留 `chat.send(sessionKey)` 路径，也同样受益。  
- orphan 续聊（`agent(sessionId)`）不受此 ensure 流程影响。

---

## 6. 事件与状态建议（给 UI / 日志）

插件侧建议产出一次性状态：

- `mainSessionEnsure: "ready" | "created" | "failed"`
- `sessionId`（若拿到）
- `error`（失败时）
- `durationMs`

可用于：

- 调试页展示
- 启动日志追踪
- 故障定位

---

## 7. 伪代码（插件侧）

```ts
async function ensureMainSessionKey(wsClient) {
  const key = "agent:main:main";

  const resolved = await wsClient.call("sessions.resolve", { key }).catch(() => null);
  if (resolved?.ok && resolved?.result?.entry?.sessionId) {
    return { state: "ready", sessionId: resolved.result.entry.sessionId };
  }

  await wsClient.call("sessions.reset", { key, reason: "new" });

  const verify = await wsClient.call("sessions.resolve", { key });
  if (verify?.ok && verify?.result?.entry?.sessionId) {
    return { state: "created", sessionId: verify.result.entry.sessionId };
  }

  throw new Error("ensure main session key failed: resolve after reset returned empty");
}
```

---

## 8. 风险与边界

1. 如果 OpenClaw 未来改变 `sessions.reset` 语义，需要回归验证。  
2. 若同一时刻多个客户端并发 ensure，通常是幂等可接受（最终都会有 entry）。  
3. 不建议把 ensure 频繁执行为每次发消息前动作；启动后一次足够。

---

## 9. 验收标准（DoD）

1. OpenClaw 全新环境（无 main entry）下，插件连接后 3 秒内可确保 `agent:main:main` resolve 成功。  
2. 重启插件不会导致异常或无限重置风暴。  
3. 首次 UI 发送消息无需额外预热即可成功。  
4. 失败场景有明确日志与状态输出。

---

## 10. 建议落地位置

- `coclaw/plugins/openclaw` 的 gateway ws client 初始化流程中。  
- 在“连接成功回调”中执行一次 ensure（并缓存结果）。
