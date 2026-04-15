---
"@coclaw/server": patch
---

server: 抽 claw ws close handler 的 offline 分支为可测函数

新增 `finalizeClawOffline(clawId, deps?)` 和 `scheduleClawGraceOffline(clawId, deps?)` 两个具名导出，替换 `attachClawWsHub` 内联的 offline 处理逻辑。外部行为与前版一致（管理性 close code 4001/4003 立即 finalize；普通断连走 5s grace，期间重连不触发；grace 超时且未重连才真正 offline）。

动机：原先内联 close handler 无集成测试保护，未来若有人误删 `markClawLastSeen(clawId)` 调用，CI 无法发现。抽函数后补了 5 个单测断言 markLastSeen 的调用时机与 offline 事件发射。
