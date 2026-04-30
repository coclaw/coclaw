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

## RpcSendQueue 两处疑似预存问题

**发现日期**：2026-04-30
**关联 commit**：fix(plugin): preserve string type in rpc send queue to drain as string frame（commit 2957e15 的 deep review 期间发现，本次未修）

### 问题 A：`buildChunks()` 抛异常未在 `send()` 内捕获
**位置**：`src/webrtc/rpc-send-queue.js:71`

`send()` 顶层直接调用 `buildChunks()`，对端 SDP 中 `maxMessageSize <= HEADER_SIZE` 等异常情况会直接 throw 给调用方。现有测试 "buildChunks 抛异常时透传给调用方（maxMessageSize 太小）" 还显式断言这一行为。这违反 plugin 工作区"所有异常必须被 catch、避免 gateway 崩溃"的强约束。

**修复方向**：在 `send()` 内把 `buildChunks()` 包进 try/catch；catch 内累计 dropped 统计 + warn/remoteLog，返回 `false`；同步把那条断言"必抛"的测试改为断言"返回 false 不抛"。

**风险**：低。改动面很小，调用方原本也不期待 send 抛。

### 问题 B：分片消息单条上限检查算入了 header 字节
**位置**：`src/webrtc/rpc-send-queue.js:72-74`

```js
const totalBytes = chunks
    ? chunks.reduce((n, c) => n + c.length, 0)  // 每片含 5 字节 header
    : Buffer.byteLength(jsonStr, 'utf8');
```

随后 `if (totalBytes > MAX_SINGLE_MSG_BYTES) drop`。`MAX_SINGLE_MSG_BYTES` 注释里对齐的是接收端 reassembly **payload** 上限（50 MB），但分片路径累计的是含 header 的帧字节。极端情况下 payload 恰好不超 50 MB 但帧字节累计超限，就会被误判 drop——而对端理论上能正确重组。

**修复方向**：单条上限检查改用 `Buffer.byteLength(jsonStr, 'utf8')` 单独判断（即真正的 payload 字节数）；队列字节核算/drop 统计仍用实际帧字节（即 chunks.length 之和）。补一个边界场景测试。

**风险**：低。极端边界，生产中很难触发，但语义更干净。
