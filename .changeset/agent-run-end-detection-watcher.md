---
'@coclaw/ui': patch
---

修复 agent run 卡"思考中"的高发 bug（约 30% 概率），同时让 gateway 重启场景能在数秒内被识别。

把 agent run 的发起和生命周期管理收敛到 `agentRunsStore.runAgent`，引入 watcher 协调四路结束信号：
- agent RPC 第二阶段 res（终态权威信号，原代码完全忽略）
- `lifecycle:end` 事件
- 事件流静默 30 秒后启动的长挂 `agent.wait` 兜底
- 任何 RPC 错误 / DC 失败（异常结束，覆盖 gateway 重启场景）

任一信号命中即触发 endRun，UI 立即退出"思考中"状态；之后由 `loadMessages` 拉服务端真实状态再 `dropRun` 释放 streamingMsgs（避免消息列表瞬间空白）。
