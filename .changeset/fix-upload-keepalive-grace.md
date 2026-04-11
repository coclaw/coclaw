---
"@coclaw/ui": patch
---

fix(ui): 大文件上传中途被 keepalive 误杀（DC_CLOSED during flow control）

`webrtc-connection.createDataChannel` 在 file DC 上新增 `bufferedamountlow` 监听，与现有 `message` 监听一起更新 `__lastDcActivityAt`。

**Why**：keepalive 的活动宽限只在入向 `message` 时记账。上传场景下 file DC 几乎没有入站消息，rpc DC probe 又因 SCTP 出向被 file 数据塞满迟迟不返回 ack，宽限内没有活动证据 → keepalive 关闭整个 PC → 正在 await BAL 的 sendChunks 被强制 reject 为 `DC_CLOSED`。BAL 触发等价于"出向字节真实进入网络"——是上传时唯一可信的 SCTP liveness 信号，把它纳入活动统计即可消除误杀，且不削弱 keepalive 对真实 SCTP 假死的检测能力。
