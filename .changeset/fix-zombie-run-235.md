---
"@coclaw/ui": patch
---

fix(ui): 修复僵尸 agent run 导致 UI 计时器空转、输出卡住 (#235)

当 `lifecycle:end` 事件丢失时，agent run 进入僵尸态（unsettled），使 `isSending` 永远为 true，进而阻断所有可能触发 `reconcileAfterLoad` 的 `loadMessages` 路径，形成死锁。
本次修复在 `agent-runs.store` 增加 `isRunIdle` 检测（事件流静默 ≥10s），并在三个入口（chat.store activate 重入、ChatPage __onConnReady 重连、__handleForegroundResume 前台恢复）放行强制静默刷新，由 `reconcileAfterLoad` 的双重安全检查（事件流静默 + 服务端确认完成）兜底防止误清理活跃 run。
