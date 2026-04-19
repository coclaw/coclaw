---
'@coclaw/ui': patch
---

Fix: per-claw 化 RTC 重连恢复 / 首次 init 的数据加载路径，消除多 claw 错峰恢复时的 RPC 风暴。

`__refreshIfStale(id)` 与 `__fullInit(id)` 之前通过 `loadAllSessions()` / `loadAllTopics()` 横扫所有已连接 claw，单 claw 触发却拉所有 claw 的 sessions 与 topics。3 个 claw（每个 2 agent）错峰恢复时单轮可达 36 个 RPC，与用户反馈的"数据风暴"现象吻合。

改为新增 `loadSessionsForClaw(id)` / `loadTopicsForClaw(id)` per-claw 加载方法（带 in-flight Map 合流），refresh / init 路径只刷当前 claw 的数据。3 claw 错峰恢复 RPC 数从 36 → 12，单 claw 恢复从 12 → 4。

`loadAllSessions()` / `loadAllTopics()` 全量接口保留，仍用于 MainList 列表渲染等真正需要全量的场景。
