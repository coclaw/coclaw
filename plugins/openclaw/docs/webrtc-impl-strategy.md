# WebRTC 实现选择策略

> 给未来的 agent：现在 plugin 的 WebRTC 路径就两条——pion 主力 + werift 兜底。
> 写这份的目的是把"为什么是这两个 / ndc 是怎么回事 / 能力差异在哪"一次说清，
> 后续读 `pion-preloader.js` / `ndc-preloader.js` / `webrtc-peer.js` 时不用再考古。

## 当前事实（先把结论放前面）

- **运行时实际路径**：先尝试 pion，失败回退 werift。
- **代码结构看起来像三级 fallback**（pion → ndc → werift），但 ndc 这一层是**死代码**——`node-datachannel` 的 npm 依赖和 vendor 预编译包 2026-04-19 已摘除，`preloadNdc` 内部的 `dynamicImport('node-datachannel')` 必然抛 import-failed，立即调用 `weriftFallback`。所以心智模型按"两条路径"看就行。
- **行为分析、资源模型（如 coturn TURN 占用、ICE restart 行为）只考虑 pion**——werift 仅是兜底，不在主力 deploy target 上跑。

## 三个候选实现的简介

| 实现 | 形态 | 状态 |
|---|---|---|
| **pion** | Go binary（pion-ipc）+ pion-node SDK 通过 IPC 调它 | 主力 |
| **werift** | 纯 JS 库 | 兜底（pion 失败时） |
| **ndc** (`node-datachannel`) | Native addon (libdatachannel C++ 绑定) | 已停用 |

详细到 pion 怎么集成的，见 `pion-integration.md`。

## 为什么是 pion 主力

- **稳定性**：libdatachannel 在某些平台（特别是 Android 的 native bridge / 老 glibc）上 dlopen 后偶发崩溃；pion 是独立 Go 进程，崩溃不带垮 gateway。
- **进程隔离**：native thread 死锁 / 内存泄漏 / segfault 都由 IPC 边界吸收。
- **跨平台**：Go 交叉编译比预编译 native addon 容易，`pion-ipc` 的 binary 矩阵覆盖度高。
- **生命周期清晰**：`ipc.stop()` 一次性回收，不像 ndc 的 `initLogger` ThreadSafeCallback 维持 native threads（详见 `node-datachannel-notes.md`）。

代价：每一次 RPC 都要跨进程，相对纯 native 有 IPC 开销——但 DataChannel 工作负载下可忽略。

## 为什么 werift 仅做兜底

- **应用层 max-message-size 上限**：werift 在 SDP 里声明 `a=max-message-size: 65536`，对端按此拒收超大消息——即使 werift 自己 SCTP 层做了透明分片也没用。所以 plugin 必须自建应用层分片（见 `dc-chunking.js` + `rpc-dc-send-queue.md`），且分片阈值要按对端 SDP 解析。
- **ICE restart 不可靠**：`webrtc-peer.js __handleOffer` 的 ICE restart 分支只放行 `__impl === 'pion'`；非 pion impl 直接发 `rtc:restart-rejected` 让 UI 走 PC rebuild 流程。
- **性能**：纯 JS 实现的 SCTP/DTLS 在大流量下吞吐显著低于 Go/C++。
- **维护活跃度**：werift 是单人维护项目，issue 修复速度不如 pion 生态。

werift 的价值在于"装不上 pion binary 时插件还能跑"——比如临时测试环境 / 未发布的平台架构。

## 为什么 ndc 退役

历史路线是 ndc 主力（2026-Q1 启用），后来切到 pion 是因为：
- libdatachannel 在 Android 上偶发崩溃。
- ndc 的 `initLogger` 用 ThreadSafeCallback 维持 native threads，`cleanup()` 阻塞 10s+；`RealtimeBridge.stop()` 因此选择**不调** cleanup，靠进程退出兜底——这是个泄漏式的妥协。
- 上游 issue 修复节奏慢。

切到 pion 后 ndc npm 依赖直接摘除（commit 2026-04-19）。`ndc-preloader.js` 文件保留只是"过渡期失败锚点"——它内部的 werift fallback 还有用，作为"ndc-or-werift 二选一兜底层"被 `preloadPion` 失败时调用。

**未来要彻底清理 ndc 时**：把 `preloadNdc` 重命名为 `preloadWerift` 或拆出去；把 SUPPORTED_PLATFORMS / vendor binary 检查 / `wrapNdcCredentials` / native logger 注册等 ndc 专属逻辑全删；`webrtc-peer.js __initWebrtcPeer` 里的 `__ndcPreloadResult` / `__ndcCleanup` 命名也要改。

## 加载流程（实际代码路径）

```
RealtimeBridge.__loadWebRtcImpl
  ├─ preloadPion()                  ← src/webrtc/pion-preloader.js
  │   ├─ import @coclaw/pion-node
  │   ├─ 启动 pion-ipc Go 进程
  │   └─ 失败 → 返回 null
  │
  └─ if pion null:
     preloadNdc()                   ← src/webrtc/ndc-preloader.js
        ├─ import('node-datachannel') ← 因依赖摘除，必抛 import-failed
        └─ 走 weriftFallback() 路径
            └─ import('werift')
                  ├─ 成功：返回 { PeerConnection, impl: 'werift' }
                  └─ 失败：返回 { PeerConnection: null, impl: 'none' }
```

返回结果存到 `RealtimeBridge.__ndcPreloadResult`（变量名是 ndc 时代遗留，意义已变）。`__implLabel` 用于握手时上报。

## impl 标签语义

`webrtc-peer.js` 创建 PC 时传入 `impl` 字符串，主要用于：
- **诊断 log 标记**：`[coclaw/rtc:pion]` / `[coclaw/rtc:werift]`。
- **能力分支**：ICE restart 仅 pion 放行（详见 `webrtc-peer.js:__handleOffer`）。
- **握手上报**：`coclaw.env impl=...` 通过 server WS 报告，便于 server 侧统计 deploy 矩阵。

current label 取值：`pion` / `ndc`（不会再出现）/ `werift` / `none`。

## 何时来读这份 doc

- 升级 `@coclaw/pion-node` 或 `werift` 版本时——先核对 `max-message-size` 协商行为是否变更。
- 遇到 `rtc:restart-rejected` 的相关代码——理解为什么仅 pion 放行。
- 看到 `__ndcPreloadResult` / `preloadNdc` 这类命名困惑时——这里有解释。
- 评估是否要清理 ndc 残留代码时——按"未来要彻底清理 ndc 时"那段执行。
