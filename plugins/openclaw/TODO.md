# Plugin TODO

## Bridge WS 断连不应 closeAll 所有 WebRTC session

**发现日期**：2026-04-14
**关联 commit**：fix(plugin): fix PionIpc listener leak and add failed session cleanup

**问题**：`realtime-bridge.js` 在 server WS 断连时调用 `webrtcPeer.closeAll()`，销毁所有 WebRTC PeerConnection。但 WebRTC 数据通道（P2P via TURN）独立于信令通道，现有 PC 在 server WS 短暂断连期间仍可正常工作。`closeAll` 导致不必要的连接中断。

**影响**：server 重启或网络抖动时，所有 UI 的 WebRTC 连接被强制断开，用户需重新建连。

**修复方向**：移除 WS 断连时的 `closeAll` 调用，依赖 per-connId 的 TTL timer 和 queue length 机制自然回收不再活跃的 session。需注意：
- WS 重连后信令路由恢复，现有 PC 应能继续使用
- 如果 server WS 长时间断开，PC 最终会因 ICE 失败进入 failed → TTL 回收
- 需评估是否有依赖 `closeAll` 重置状态的其他逻辑

**风险**：直接移除可能引入其他问题（如 bridge 重连后状态不一致），需谨慎评估。
