# Pion IPC 方案设计与实施计划

> 创建时间：2026-04-09
> 状态：实施中（Phase 1 已完成）
> 前置研究：[webrtc-connection-research.md](../study/webrtc-connection-research.md) 附录 G/H

---

## 一、目标

用 Pion (Go WebRTC) 替代 node-datachannel / werift 作为插件端的 WebRTC 实现，以获得：

1. **ICE restart 后 DC 存活**——从根本上解决断点续传问题
2. **SCTP 无限存活**——任意时长断线后可通过 ICE restart 恢复
3. **TURN TCP 全面支持**——即使 Plugin 端 UDP 也被封
4. **崩溃隔离**——sidecar 崩溃不影响 gateway，可自动重启
5. **内存泄漏容忍**——定期优雅重启 sidecar 即可

## 二、项目拆分

### 三个独立关注点

| 仓库 | 名称 | 语言 | 职责 |
|------|------|------|------|
| **Go IPC 服务** | `pion-ipc` | Go | 纯 Go 独立进程，通过 IPC 暴露 Pion WebRTC 能力（DC + 未来音视频） |
| **Node.js SDK** | `pion-node` | JS | spawn pion-ipc 进程、IPC 协议编解码、进程生命周期管理、暴露类 W3C API |
| **CoClaw 适配** | `coclaw`（现有） | JS | `PionBridge` 适配层，调用 pion-node，替换 webrtc-peer.js |

### pion-ipc（独立仓库，与 coclaw 平级）

**纯 Go 项目，不包含任何 JS 代码。** 通过 IPC 提供 WebRTC API——类似 REST API server，调用方可以是任何语言。

- 默认 stdin/stdout 模式（父进程 spawn）
- 可扩展支持 TCP localhost、Unix socket 等传输方式
- 核心代码（PC/DC 管理、消息路由）不感知传输方式
- 当前聚焦 DataChannel，架构上不限制未来扩展音视频

### pion-node（独立仓库）

- spawn pion-ipc Go binary 并管理生命周期
- IPC 协议编解码（JS 侧）
- 暴露类 W3C 风格的 PeerConnection/DataChannel API
- 通过 npm optionalDependencies 自动分发对应平台的 Go binary

### 二进制分发

npm optionalDependencies + 平台包（esbuild/turbo 验证过的模式）：

```
@coclaw/pion-node                  → JS SDK（npm 包）
@coclaw/pion-ipc-linux-x64         → 预编译 binary（npm 包）
@coclaw/pion-ipc-linux-arm64
@coclaw/pion-ipc-darwin-x64
@coclaw/pion-ipc-darwin-arm64
@coclaw/pion-ipc-win32-x64
```

- npm/pnpm 根据 `os`/`cpu` 字段自动只安装当前平台的包
- 不需要运行任何 install scripts（兼容 OpenClaw `--ignore-scripts`）
- npm mirror 自动镜像所有包

## 三、架构

```
调用方进程（任意语言）
  │
  ├─ stdin  → pion-ipc 进程（Go binary）
  ├─ stdout ← pion-ipc 进程（协议专用）
  └─ stderr ← pion-ipc 进程（日志）

CoClaw 具体场景：
  OpenClaw Gateway (Node.js)
    └─ openclaw-coclaw plugin
         └─ PionBridge (JS)
              └─ pion-node (JS SDK)
                   └─ spawn pion-ipc (Go binary)
```

### 不变的部分

- **UI 端完全不受影响**——浏览器使用原生 WebRTC API
- **dc-chunking.js 保留在 CoClaw JS 侧**——分片/重组是业务层逻辑
- **file-manager/handler.js 业务逻辑不变**——只是底层 DC 操作改为通过 PionBridge

## 四、IPC 线路协议

### 4.1 帧格式

```
┌─────────────┬──────────────────┬──────────────────┬─────────────┐
│ length (4B) │ hdr length (2B)  │ header (msgpack) │ payload     │
│ uint32 LE   │ uint16 LE        │                  │ raw bytes   │
└─────────────┴──────────────────┴──────────────────┴─────────────┘
```

- length 包含 hdr length + header + payload 的总长度
- hdr length 标识 msgpack header 的字节数，解决 msgpack 边界问题
- header 用 MessagePack 编码，包含消息类型和路由信息
- payload 为 raw bytes（JSON string 或 binary 数据），零 overhead

### 4.2 消息类型

**调用方 → Go（请求）**

| method | 参数 | 说明 |
|--------|------|------|
| `pc.create` | `{ pcId, iceServers, iceTimeouts? }` | 创建 PeerConnection |
| `pc.setRemoteDescription` | `{ pcId, type, sdp }` | 设置远端 SDP |
| `pc.createAnswer` | `{ pcId }` | 创建 answer |
| `pc.createOffer` | `{ pcId }` | 创建 offer |
| `pc.setLocalDesc` | `{ pcId, type, sdp }` | 设置本地 SDP |
| `pc.addIceCandidate` | `{ pcId, candidate, sdpMid, sdpMLineIndex }` | 添加 ICE candidate |
| `pc.restartIce` | `{ pcId }` | 触发 ICE restart |
| `pc.close` | `{ pcId }` | 关闭 PC |
| `dc.create` | `{ pcId, label, ordered }` | 创建 DataChannel |
| `dc.send` | `{ pcId, dcLabel, isBinary }` + payload | 发送数据 |
| `dc.close` | `{ pcId, dcLabel }` | 关闭 DC |
| `dc.setBALT` | `{ pcId, dcLabel, threshold }` | 设置 bufferedAmountLowThreshold |
| `dc.getBA` | `{ pcId, dcLabel }` | 查询 bufferedAmount |
| `ping` | 无 | 健康检查 |

**Go → 调用方（事件/响应）**

| event | 参数 | 说明 |
|-------|------|------|
| `pc.icecandidate` | `{ pcId, candidate, sdpMid, sdpMLineIndex }` | ICE candidate |
| `pc.statechange` | `{ pcId, connState, iceState }` | 连接状态变更（connection 或 ICE 状态变化均触发） |
| `pc.selectedcandidatepairchange` | `{ pcId, local: {type,address,port,protocol}, remote: {...} }` | 选中的 candidate pair（connected 时自动发送） |
| `pc.icegatheringstatechange` | `{ pcId, state }` | ICE gathering 状态（new/gathering/complete） |
| `pc.signalingstatechange` | `{ pcId, state }` | 信令状态（stable/have-local-offer/...） |
| `pc.datachannel` | `{ pcId, dcLabel, ordered }` | 远端创建 DC |
| `dc.open` | `{ pcId, dcLabel }` | DC 打开 |
| `dc.close` | `{ pcId, dcLabel }` | DC 关闭 |
| `dc.error` | `{ pcId, dcLabel }` + error message | DC 错误 |
| `dc.message` | `{ pcId, dcLabel, isBinary }` + payload | DC 消息 |
| `dc.bufferedamountlow` | `{ pcId, dcLabel }` | 低水位事件 |
| `pong` | 无 | 健康检查响应 |

### 4.3 stdout 污染防护

Go 进程启动时立即执行：
```go
protocolOut := os.Stdout
os.Stdout = os.Stderr // 任何 fmt.Print* 或 os.Stdout.Write 都落到 stderr
```

所有协议输出通过 `protocolOut` 发送。跨平台（含 Windows）行为一致。

### 4.4 优雅退出

- stdin EOF（调用方退出）→ Go 进程关闭所有 PeerConnection 后退出
- SIGTERM/SIGINT → 同上
- Windows：stdin EOF 是主要信号（Windows 无 SIGTERM 语义）

## 五、实施阶段

### Phase 1：pion-ipc Go 项目 ✅

独立仓库，已完成：
- IPC 协议层（帧编解码、reader/writer）
- PeerConnection/DataChannel 管理
- 所有事件发射、ICE restart、背压支持
- 39 个测试（含 ICE restart DC 存活集成测试），全部通过 `-race`
- CI/CD 配置（lint + test + 5 平台交叉编译 release）
- 优雅退出、stdout 防护

### Phase 2：pion-node JS SDK（独立仓库）

- spawn Go binary、进程生命周期管理
- IPC 协议编解码（JS 侧）
- 暴露类 W3C 风格 API
- npm optionalDependencies 平台包分发
- 测试

### Phase 3：CoClaw 集成（CoClaw 仓库）

- PionBridge 适配层（调用 pion-node）
- 替换 webrtc-peer.js
- 文件传输背压适配
- 端到端测试
- UI 侧 ICE restart 恢复策略调整

### Phase 4：收尾

- 移除 ndc/werift 相关代码
- 更新文档（通信模型、CLAUDE.md 约束等）

## 六、风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| Pion sctp#357 频繁 DC 重启内存泄漏 | 监控 Go 进程内存；定期优雅重启 sidecar |
| IPC 延迟影响文件传输吞吐 | 批量发送减少 IPC 往返 |
| Go binary 分发增加包体积 | gzip 后 ~3MB/平台；npm optionalDependencies 只装当前平台 |
| sidecar 崩溃导致所有 DC 中断 | 自动重启 + 通知上层重建 PC |
| 核心维护者 bus factor 低 | OpenAI/LiveKit 的生产依赖保证短期维护；Go 源码可 fork |

## 七、不包含在此方案中的

- **WS fallback 通道**：Server 侧 RPC 中继已实现，UI 侧切换逻辑待独立方案
- **文件传输 HTTP fallback**：待 WS fallback 方案一起规划
- **UI 侧 ICE restart 恢复策略调整**：待 Phase 3 验证完成后调整
