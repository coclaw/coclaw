---
'@coclaw/ui': patch
---

Bump `BRIEF_DISCONNECT_MS` from 5s to 30s to suppress refresh after short network jitter.

`__refreshIfStale` 在 RTC DC 重建成功后按断连时长决定是否拉取 agents/sessions/topics/dashboard。原 5s 门槛过短，10s 量级的网络抖动也会触发全量刷新。

抬到 30s 不会影响长后台恢复场景：`disconnectedAt` 是在 PC 进入 `restarting`/`failed`/`closed` 时打点，不是用户切回前台时打点；长后台时 PC 通常在切到后台不久就失败，gap 累计到回前台时远超 30s。中等时长断连（25–60s）数据漂移很小，跳过刷新可接受，下一轮真断连或手动刷新会兜底。
