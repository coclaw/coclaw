# Pion 集成参考

> 给未来的 agent：plugin 用 pion 做 WebRTC 时涉及到的 npm 包 / Go binary / 仓库分布的全景。
> 不讲"为什么是 pion"——那条理由在 `webrtc-impl-strategy.md`。这里只回答 **代码长在哪儿、binary 是怎么被找到的、并发是怎么回事**。

## 三个仓库的关系

```
@coclaw/pion-node (npm)         ← JS SDK，本插件直接 import 它
       │
       │ stdin/stdout JSON-RPC
       ▼
pion-ipc (Go binary)            ← 长连接子进程，一进程多 PC
       │
       │ 内部调用
       ▼
pion/webrtc (Go lib)            ← upstream，标准 pion WebRTC stack
```

| 仓库 | 形态 | 本地路径 | GitHub |
|---|---|---|---|
| pion-ipc | Go | `~/.openclaw/workspace/pion-ipc` | `coclaw/pion-ipc` |
| pion-node | JS | `~/.openclaw/workspace/pion-node` | `coclaw/pion-node` |
| pion/webrtc | Go (upstream) | `~/repos/pion/`（克隆备查） | `pion/webrtc` |

CoClaw 维护前两个，第三个是上游依赖（不改代码，只用）。

## 安装与 binary 解析

插件依赖：

```json
"@coclaw/pion-node": "^0.4.0"
```

binary 解析**完全由 pion-node 内部处理**，插件不参与。优先级：

1. `PION_IPC_BIN` env 指向的具体路径
2. 与 pion-node 同时安装的 npm 平台包（`@coclaw/pion-ipc-linux-x64` 等）
3. 系统 `PATH` 里的 `pion-ipc`

平台包用 npm `optionalDependencies` 矩阵分发，按目标平台自动下载。CI 构建 plugin tarball 时不带 binary，安装到目标机时由 npm 选对应平台包。

## 启动流程

`src/webrtc/pion-preloader.js`：

```
1. import('@coclaw/pion-node') 拿 PionIpc + RTCPeerConnection
2. new PionIpc({ logger, timeout, autoRestart: true })
3. await ipc.start()         ← spawn Go 子进程 + ping 验证就绪
4. 包装 RTCPeerConnection 子类，构造时把 ipc 实例注入 _ipc 字段
5. 返回 { PeerConnection, cleanup, impl: 'pion', ipc }
```

`autoRestart: true` 让 pion-node 监听 Go 进程意外退出后自动重启。

`cleanup`：调 `ipc.stop()`，干净退出 Go 进程。`RealtimeBridge.stop()` 走非 pion 分支才 cleanup；pion 分支保留 ipc 进程供下次复用（避免每次 bridge 重连都重启 Go 进程）。

## RPC 协议（IPC 边界）

pion-node ↔ pion-ipc 之间是 **stdin/stdout JSON-RPC**，每条消息一行。请求带 uint32 `id` 单调递增，pion-node 维护 pending Map 等响应。**乱序响应是允许的**——同一 PC 内方法调用顺序无强制约束（具体方法间依赖见 pion-ipc 源码）。

每个 RTCPeerConnection 在 Go 侧对应一个 peer 实例（pion-ipc Manager 维护 peerId → peer 映射）。多 PC 共享同一个 ipc 进程。

## 并发模型（HOL 与 per-PC worker）

**关键事实**：pion-ipc Go 侧曾经用单 reader goroutine 串行处理所有 RPC，多 PC 场景下存在 HOL（head-of-line）阻塞。

经过的工作（截至 2026-04 调研结论）：
- 只有 `pc.close` 真阻塞（200~400ms，SCTP Abort 200ms×2 硬编码），其余 12 个 method 全 ≤5ms。
- `Manager.ClosePeer` 持锁调慢 `peer.Close()` 会让多 PC 场景下 `GetPeer` 被阻塞。
- 方案：per-PC worker goroutine——每个 peer 一条独立 goroutine，避免互相阻塞。RPC 协议本身已支持乱序（uint32 id + pending Map）。

**当前实施进度以 pion-ipc 仓库为准**——这里写下当时的结论是为未来 agent 接手时不必从零调研。具体阶段：
- Phase 1：修 `ClosePeer` / `Peer.Close` 锁持有（~30 行）
- Phase 2：per-PC worker goroutine（~150 行新增）
- Phase 3：pion-node `dc.getBA` 配套（让 `dc.bufferedAmount` 不被其他 PC 拖慢）
- Phase 4：deep review + 集成测试

读这份的未来 agent 应该到 `~/.openclaw/workspace/pion-ipc` 看最新状态再判断。

## 故障排查的优先入口

按"先看哪儿"排序：

1. **pion-node 的 logger 输出**——`pion-preloader.js` 里把所有 `[pion-ipc]` 前缀的 log 通过 `remoteLog` 上报，本地 logger 也并行打。`request timeout` / `orphan response` 升级到 error 级。
2. **Go 进程是否还活着**：`pgrep pion-ipc`。autoRestart 失败时进程会缺席。
3. **pion-ipc 自身的 stderr**：pion-node 透传 stderr 到上层 logger，不会静默吞掉 panic。
4. **pion/webrtc upstream issue**：`~/repos/pion/` 已克隆，可以直接看上游源码核对 ICE/DTLS/SCTP 行为。

### 已知无害噪声：SIGTERM 重启日志

gateway 收 SIGTERM 重启时，日志会出现这一串：`[pion-ipc] ERROR service exited with error: context canceled` / `[pion-ipc] process exited code=1` / `[pion-ipc] watchdog: restart #1 in 200ms`。看着像异常退出 + 真重启，实际是纯噪声、无害。

根因：OS 进程组群发 SIGTERM 先杀掉 Go 子进程 → Go 把 `context.Canceled` 当 ERROR 返回、exit code=1 → pion-node 见 `_intentionalStop=false` 误调度 watchdog restart → 但随后 plugin stop 调到 `ipc.stop()` 拆掉 `_restartTimer`，**实际不重启**。

治本在上游（pion-ipc Go 优雅退出走 exit 0；或 pion-node 把子进程放进独立进程组避免被群发信号波及），本仓不修，作下游观察者跟踪上游。

## 何时来读这份 doc

- 升级 `@coclaw/pion-node` 版本时——核对 `PionIpc` 构造参数 / 平台包矩阵是否变。
- 调试"WebRTC 连不上、但握手前都正常"——优先看 pion-node logger 输出而不是先看 plugin。
- 多 PC 并发性能问题——回到 pion-ipc 仓库看 worker 实施进度。
- 准备改 `pion-preloader.js` 的初始化逻辑——这里讲过为什么 `cleanup` 在 pion 分支不调（避免反复 spawn）。
