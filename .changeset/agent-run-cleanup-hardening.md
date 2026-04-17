---
'@coclaw/ui': patch
---

修复 agent run watcher 重构的两处清理边界 bug（deep-review 发现）。

1. `__cleanupRun` 在 `register` 清旧 run 和 `removeByClaw` 路径下不触发 `onEnd`，导致 `runAgent` 的 `finalPromise` 悬挂、外层 `sendMessage` Promise 泄漏。现在两条路径分别按 `superseded` / `claw-removed` 原因 endRun 后再清理。
2. `dropRun(runKey)` 通过 runKey 反查 runId，若旧 run 在 `await loadMessages` 期间被用户新发消息覆盖同一 runKey，老挂钩会误清新 run 的 streamingMsgs。`dropRun` 新增可选 `expectedRunId` 参数，`chat.store` 的 `runPromise.then` 与 24h 内存兜底均传入闭包 runId 校验。
