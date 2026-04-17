---
'@coclaw/ui': patch
---

修复 pre-accept 窗口点取消的"假取消"bug。

之前在 chat/topic 发消息后、服务端回 accepted 之前点 STOP：本地气泡瞬间消失看起来取消成功，但服务端的 agent run 实际会跑到底（onAccepted 仍到达 → `register` → 流式输出继续到自然结束）。

改为：pre-accept 点 STOP 时挂起 `__pendingCancelIntent` 标记——不清乐观气泡、不 reject sendMessage，让 STOP 按钮转"取消中"禁用态；等 `onAccepted` 到达后在 sendMessage 的 onAccepted 回调末尾立刻转交 accepted 分支，由已有的 `coclaw.agent.abort` 轮询协调真正终止 run。`isCancelling` getter 把挂意图纳入，UI 绑定无需改动。

上传阶段取消走原路径不变（中断 upload handle + sendMessage CANCELLED catch 分支清理）。cleanup / superseded / catch 均同步清意图避免残留。
