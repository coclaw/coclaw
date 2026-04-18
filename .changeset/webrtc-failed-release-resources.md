---
'@coclaw/ui': patch
---

修复 WebRtcConnection 失败路径的 PC 资源泄漏：4 处 `__setState('failed')` 入口（DC 在 restart 中关闭、ICE restart 超时、createOffer 抛异常、`rtc:restart-rejected`）原本只改状态字段，不释放底层 `RTCPeerConnection` 也不通知 plugin，需要等 3~120 秒的退避重试才延迟清理；5 轮退避耗尽后更会永久悬挂。

改造：`close()` 方法新增 `{ asFailed }` 参数复用统一清理逻辑，4 处失败入口立即释放 native PC、清理定时器/监听器、并向 plugin 发 `rtc:closed` 信令。同时修复 `initRtc` 的 `state === 'failed'` 分支漏清 `rtcInstances` Map 的问题。
