# WebRTC 实现选择策略

> 给未来的 agent：现在 plugin 的 WebRTC 路径只有一条——**pion 单实现，失败即 none，无兜底**。
> 写这份的目的是把"为什么只剩 pion / ndc 和 werift 是怎么退场的 / `__ndcPreloadResult`
> 这类遗留命名怎么回事"一次说清，后续读 `pion-preloader.js` / `webrtc-peer.js` 时不用再考古。

## 当前事实（先把结论放前面）

- **运行时实际路径**：`preloadPion()` 成功 → `impl='pion'`；失败 → `impl='none'`（RTC 不可用）。
- **impl='none' 的语义**：bridge 照常启动、server WS 照常连接、RPC / 自动升级链路完全不受影响；
  仅 UI 发来 RTC offer 时记 `rtc.unavailable` 并拒绝。机器可通过发布修复版 + 自动升级捞回
  （该独立性由 `src/auto-upgrade/rtc-isolation.test.js` 钉死）。
- **行为分析、资源模型（如 coturn TURN 占用、ICE restart 行为）只考虑 pion**。

## 为什么是 pion 主力

- **稳定性**：libdatachannel 在某些平台（特别是 Android 的 native bridge / 老 glibc）上 dlopen 后偶发崩溃；pion 是独立 Go 进程，崩溃不带垮 gateway。
- **进程隔离**：native thread 死锁 / 内存泄漏 / segfault 都由 IPC 边界吸收。
- **跨平台**：Go 交叉编译比预编译 native addon 容易，`pion-ipc` 的 binary 矩阵覆盖度高。
- **生命周期清晰**：`ipc.stop()` 一次性回收。

代价：每一次 RPC 都要跨进程，相对纯 native 有 IPC 开销——但 DataChannel 工作负载下可忽略。

详细到 pion 怎么集成的，见 `pion-integration.md`。

## 历史：三级 fallback 如何退场

历史上代码结构是三级 fallback（pion → ndc → werift）：

| 实现 | 形态 | 退场时间与原因 |
|---|---|---|
| **ndc** (`node-datachannel`) | Native addon (libdatachannel C++ 绑定) | 2026-04-19 摘除依赖：Android 偶发崩溃、`initLogger` native threads 令 cleanup 阻塞 10s+、上游修复慢。详见 `node-datachannel-notes.md` |
| **werift** | 纯 JS 库 | 2026-07-16 连同 `ndc-preloader.js` 整体移除，见下节 |

### 为什么剔除 werift（而不是留作兜底）

线上 25 天 359 次连接 100% 走 pion、0 次回退——werift 从未被真实触发。更关键的是它是**坏兜底**：

- **背压回调不兼容（致命）**：插件的 RPC 背压（`rpc-dc-sender.js` 的 HWM waiter）与文件下载恢复
  （`file-manager/handler.js` 的 `stream.resume()`）都挂在 `dc.onbufferedamountlow` **属性回调**上；
  werift 的 DataChannel 只触发自家 rx.mini 事件与 EventEmitter `emit()`，从不调用该属性——
  文件下载超过 256KB 高水位即永久暂停，RPC 缓冲顶过 1MB 后发送器永久楔死。
  故障形态是"显示已连接、文件卡 0%"，比干脆连不上更难排查。
- **修复不生效**：`sctpRtoMax`（移动端后台唤醒收敛）与 `interfaceFilter`（docker 伪直连过滤）仅 pion 注入。
- **无 ICE restart**：仅 pion 放行（`webrtc-peer.js __handleOffer`），werift 只能整 PC rebuild。
- **仅 TURN/UDP**：werift 只取第一个 `turn:` URL，UDP 受限网络下连不上——恰是最需要兜底的场景。
- **license 卫生**：werift 传递闭包 63 包含多枚无 license 文本的包（rx.mini / ip / nano-time 等），
  是依赖树里唯一的 Unknown license 来源。

结论：保留 werift 的唯一"价值"是把"连不上（干净、易诊断）"变成"连上了但坏（脏、难诊断）"。
剔除后 pion 失败 → 显式 `impl=none`，靠自动升级发布修复版恢复。

## 加载流程（实际代码路径）

```
RealtimeBridge.__preloadWebrtc
  ├─ 版本预热并行启动（versionPromise，返回前必 await）
  └─ preloadPion()                  ← src/webrtc/pion-preloader.js
      ├─ import @coclaw/pion-node → 启动 pion-ipc Go 进程 → ping 就绪
      ├─ 成功：返回 { PeerConnection: BoundPeerConnection, cleanup, impl: 'pion' }
      └─ 失败：返回 null → __preloadWebrtc 返回
                { PeerConnection: null, cleanup: null, impl: 'none' }
```

none 结果**必须保持非空三字段对象**——`start()` / `stop()` 的竞态守卫直接读 `.impl` / `.cleanup`，
裸 `null` 会在 start/stop race 时抛 TypeError（有测试钉死）。

返回结果存到 `RealtimeBridge.__ndcPreloadResult`（变量名是 ndc 时代遗留，意义已变，未做扩散重命名）。`__implLabel` 用于握手时上报。

## impl 标签语义

`webrtc-peer.js` 创建 PC 时传入 `impl` 字符串，主要用于：
- **诊断 log 标记**：`[coclaw/rtc:pion]`。
- **能力分支**：ICE restart / settings 注入 / SCTP stats 等仅 pion 放行——现存 impl 只有 pion，
  这些 gate 对 pion 恒真；`webrtc-peer.js` 内残留的非 pion 兼容分支为不可达代码，未随 werift
  剔除顺手重构（保持 diff 最小），后续清理见 `TODO.md`。
- **握手上报**：`coclaw.env impl=...` 通过 server WS 报告，便于 server 侧统计 deploy 矩阵。

current label 取值：`pion` / `none`。

## 何时来读这份 doc

- 升级 `@coclaw/pion-node` 版本时——先核对 `max-message-size` 协商行为是否变更。
- 遇到 `rtc:restart-rejected` 的相关代码——理解为什么仅 pion 放行。
- 看到 `__ndcPreloadResult` 这类命名困惑时——这里有解释。
- 想知道为什么没有兜底实现 / impl=none 机器怎么恢复时——见"为什么剔除 werift"节。
