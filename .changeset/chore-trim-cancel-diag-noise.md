---
"@coclaw/openclaw-coclaw": patch
---

chore(plugin): trim cancel-related diag log noise

阶段 2.5 上线后实测发现取消相关日志噪音过大：注册空窗期内 UI 每 500ms 重试 `coclaw.agent.abort`，每次都打 `request` / `result not-found` / `not-found diag` 三条，单次取消可累积数十行；且 `installAbortRegistryDiag` 默认 patch 4 个 Map（其中 `reply.*` 在当前 OpenClaw 版本根本不暴露）+ 启动时每 label 一条 `installed ${label} patch (size=N)`。

清理方案：

- 删除已注释的 `[coclaw.agent.abort] request` info + `abort.request` remoteLog 行
- `[coclaw.agent.abort] result` 在 `reason=not-found` 时跳过；`ok=true` / `not-supported` / `abort-threw` 仍 info
- 删除 `agent-abort.js` 的 `not-found diag` 块 + `describeReplyRunRegistry` 助手 + 不再使用的 `logger` 形参
- `PATCH_LABELS` 缩到只剩 `embedded.activeRuns`（取消路径实际读取的就是这张表；`sessionIdsByKey` 与之 1:1 同步触发，冗余；`reply.*` 当前 OpenClaw 不存在）
- `patchMapLogging` 删掉 `clear` 包装（实测从未触发）+ 启动时的 `[coclaw.diag] installed ${label} patch` 日志（与 `abort.patch installed=` remoteLog 重复）

最终噪音模型：每次 run 2 条 info（`embedded.activeRuns.set` + `.delete`）；取消成功 1 条 info + 1 条 remoteLog；`not-found` 重试期间完全静默。

RPC 契约不变。
