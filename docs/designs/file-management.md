# 文件管理设计

> 创建时间：2026-03-24
> 最近修订：2026-03-28（协议升级：采用 HTTP 动词、新增 POST 附件上传、扩展 rpc 方法集、delete 支持 force 递归删除）
> 状态：草案
> 范围：UI 通过 WebRTC DataChannel 对 OpenClaw Agent Workspace 的文件操作
> 前置依赖：`webrtc-p2p-channel.md`（WebRTC P2P DataChannel 基础设施）

---

## 一、概述

### 背景

CoClaw UI 需要对 OpenClaw Agent 工作区中的文件进行完整的文件管理操作。WebRTC P2P DataChannel 基础设施提供了 UI ↔ Plugin 的直连通道，文件操作将基于此通道实现。

### 目标

1. UI 能对指定 Agent 的 workspace 目录进行完整的文件操作（下载 / 上传 / 附件上传 / 列目录 / 删除 / 创建目录 / 创建空文件）
2. 支持大文件传输（上传限 1GB），不因文件大小导致内存溢出
3. 协议设计清晰，采用 HTTP 动词语义，可取消，容错性好

### 不在本期范围

- 递归目录列表（仅列当前层级，UI 按需展开）
- 文件锁 / 并发写入冲突处理（TODO，后续考虑）
- Agent state 目录（`~/.openclaw/agents/`）的访问——已有 session-manager 覆盖

---

## 二、架构总览

```
UI  ──(WebRTC rpc DataChannel)──────>  Plugin  ──(Node.js fs)──>  Agent Workspace
        ↕ list / delete / mkdir /        ↑
          create (JSON-RPC)              |
UI  ══(WebRTC file:<id> DC)══════════>  Plugin  ↑ 直接文件系统操作
        ↕ GET / PUT / POST（自包含传输）
```

### 通道职责

| 通道 | 类型 | 职责 |
|------|------|------|
| `rpc` DataChannel | 持久，JSON | 无数据传输的文件元操作（list / delete / mkdir / create）及 Gateway RPC 转发 |
| `file:<transferId>` DataChannel | 临时，String + Binary | 自包含的文件传输（GET / PUT / POST），DC 内完成元信息交换与数据传输 |

### 设计选择

采用**自包含 DataChannel**方案（HTTP 语义映射）。这是 WebRTC DataChannel 文件传输的社区主流做法。每次文件传输创建一条独立 DC，在 DC 内自包含完成请求-响应的完整生命周期，不依赖 `rpc` 通道。

核心理由：
- DataChannel 天然区分 string 和 binary 消息，可直接用于帧类型分离（string = 控制帧，binary = 数据帧），无需额外协议层
- 每条 DC 是独立的请求-响应单元，无跨通道状态协调
- 取消操作极其简单：close DC 即可
- `rpc` 通道职责纯净：仅承载无数据传输的元操作和 Gateway RPC 转发

> 曾评估过的其它方案见附录 A。

---

## 三、路径约定

### 相对于 Agent Workspace 目录

所有路径参数均为**相对于目标 Agent 的 workspace 目录**的相对路径。

| 方案 | 优势 | 劣势 |
|------|------|------|
| **✅ 相对 workspace** | 天然沙箱；UI 无需了解内部目录结构；agentId 隐含定位 | Plugin 需先获取 workspace 绝对路径 |
| ❌ 相对 `~/.openclaw` | 可跨 agent 访问 | 暴露内部结构；安全风险大；UI 需知道命名规则 |

示例：`path: "src/main.js"` 实际指向 `~/.openclaw/workspace/src/main.js`（main agent）或 `~/.openclaw/workspace-<agentId>/src/main.js`（非 main agent）。

### Workspace 路径获取

Plugin 通过 Gateway RPC `agents.files.list({ agentId })` 的响应中的 `workspace` 字段获取该 Agent 的 workspace 绝对路径。

**策略**：每次文件操作都调用一次 Gateway RPC 获取最新路径（进程内通信，性能无忧）。避免缓存导致 agent 配置变更或删除后路径过期。

> TODO: 后期可引入短时缓存（如 30s TTL）优化高频操作场景。

### 安全校验

```js
const resolved = path.resolve(workspaceDir, userPath);
if (!resolved.startsWith(workspaceDir + path.sep) && resolved !== workspaceDir) {
    // 路径穿越，拒绝
}
// 额外校验：
// 1. fs.lstat 检测符号链接，拒绝指向 workspace 外的 symlink
// 2. 仅允许普通文件（isFile）和目录（isDirectory），拒绝 FIFO、设备文件等特殊类型
```

---

## 四、文件传输协议（file:\<transferId\> DataChannel）

### 4.1 HTTP 语义映射

将 HTTP 的请求-响应模型映射到 DataChannel 上，直接采用 HTTP 动词作为 method 名称。DC 的 `onmessage` 天然区分 `string`（`typeof data === 'string'`）和 `binary`（`ArrayBuffer / Buffer`），利用这一特性实现帧类型分离：

| DC 消息类型 | 角色 | HTTP 类比 |
|------------|------|-----------|
| string（JSON） | 控制帧：请求 / 响应 / 完成确认 / 错误 | Request line + headers / Status line + headers |
| binary | 数据帧：文件内容分片 | Request body / Response body |

**method 与 HTTP 动词对应**：

| Method | HTTP 类比 | 语义 | path 含义 |
|--------|-----------|------|-----------|
| `GET` | HTTP GET | 下载文件 | 具体文件路径 |
| `PUT` | HTTP PUT | 上传到指定路径（客户端决定） | 具体文件路径 |
| `POST` | HTTP POST | 上传到集合路径（Plugin 决定最终路径） | 集合目录路径 |

**所有 string 消息统一为 JSON 对象**，结构与 OpenClaw RPC 响应风格对齐：

- 请求消息：`{ method, agentId, path, ... }`
- 成功响应/确认：`{ ok: true, ... }`
- 发送方完成信号：`{ done: true, bytes }` — 仅在上传场景由 UI 发送，区别于 Plugin 的 `ok` 响应
- 失败响应：`{ ok: false, error: { code, message } }`

### 4.2 通道创建

文件传输始终由 **UI 创建** DataChannel 并发起请求（UI 是主叫方，类似 HTTP client 发起连接）。

> 注意：`webrtc-p2p-channel.md` 第 5.2 节的原约定为"谁发数据谁创建"（下载时 Plugin 创建）。本设计有意调整为统一由 UI 创建——与 HTTP "client 发起连接" 语义一致，简化 Plugin 侧逻辑（Plugin 只需监听 `ondatachannel` 事件，无需主动创建）。

| 属性 | 值 |
|------|-----|
| 通道名 | `file:<transferId>`（transferId 为 UUID，由 UI 生成） |
| 创建方 | UI |
| 配置 | `{ ordered: true }`（可靠有序） |
| 生命周期 | 请求-响应完成后任一方关闭 |

#### 身份认证

file DC 建在已认证的 PeerConnection 上（WebRTC 建连经过 Server 认证的信令通道）。同一 PeerConnection 上的所有 DataChannel 隐式共享该认证身份，无需额外鉴权。

#### agentId 校验

请求中的 `agentId` 必须与当前 bot 绑定的 agent 一致。Plugin 校验失败时返回错误：

```js
<- {"ok": false, "error": {"code": "AGENT_DENIED", "message": "Agent not bound to this bot"}}
```

### 4.3 下载（GET）

```
UI 创建 DC file:<transferId>
 |                                                            Plugin
 |                                                              |
 | -- string: {                                                 |
 |      "method": "GET",                                        |
 |      "agentId": "main",                                      |
 |      "path": "src/app.js"                                    |
 |    } ------------------------------------------------------> |  <- 请求
 |                                                              |
 |                         校验路径、stat 文件                     |
 |                         获取 workspace 路径（gateway RPC）      |
 |                                                              |
 | <-- string: {                                                |
 |      "ok": true,                                             |
 |      "size": 2048,                                           |
 |      "name": "app.js"                                        |
 |    } ------------------------------------------------------  |  <- 响应头
 |                                                              |
 | <========== binary chunk (16KB) ============================ |  <- 响应体
 | <========== binary chunk (剩余) ============================ |
 |                                                              |
 | <-- string: {                                                |
 |      "ok": true,                                             |
 |      "bytes": 2048                                           |
 |    } ------------------------------------------------------  |  <- 完成确认
 |                                                              |
 |              Plugin close DC                                 |
```

消息序列：Plugin string（响应头）-> Plugin binary×N（数据）-> Plugin string（完成确认）-> close DC。

UI 可双重校验：累计字节数 == 响应头中的 `size`，且收到 `ok: true` 完成确认。

### 4.4 上传到指定路径（PUT）

```
UI 创建 DC file:<transferId>
 |                                                            Plugin
 |                                                              |
 | -- string: {                                                 |
 |      "method": "PUT",                                        |
 |      "agentId": "main",                                      |
 |      "path": "docs/report.pdf",                              |
 |      "size": 5242880                                         |
 |    } ------------------------------------------------------> |  <- 请求
 |                                                              |
 |                         校验路径、size <= 1GB                   |
 |                         获取 workspace 路径（gateway RPC）      |
 |                                                              |
 | <-- string: {"ok": true} ----------------------------------  |  <- 准备就绪（类似 HTTP 100 Continue）
 |                                                              |
 | =========== binary chunk (16KB) ===========================> |  <- 请求体
 | =========== binary chunk (16KB) ===========================> |
 |                     ...                                      |
 |                                                              |
 | -- string: {                                                 |
 |      "done": true,                                           |
 |      "bytes": 5242880                                        |
 |    } ------------------------------------------------------> |  <- 发送完成
 |                                                              |
 |              Plugin flush WriteStream                        |
 |              校验 bytes == size                               |
 |              rename tmp -> target                             |
 |                                                              |
 | <-- string: {                                                |
 |      "ok": true,                                             |
 |      "bytes": 5242880                                        |
 |    } ------------------------------------------------------  |  <- 写入结果（类似 HTTP 200 OK）
 |                                                              |
 |              任一方 close DC                                  |
```

消息序列：UI string（请求）-> Plugin string（就绪）-> UI binary×N（数据）-> UI string（`done` 发送完成）-> Plugin string（写入结果）-> close DC。

UI 发完数据后发送 `{done: true, bytes}` 完成信号（不关闭 DC），等待 Plugin 返回写入结果。`done` 字段与 Plugin 的 `ok` 响应显式区分，避免歧义。这对应 HTTP PUT 的 "client 发完 body 后等待 server 的 response status"。

### 4.5 上传到集合路径（POST）

POST 用于将文件上传到一个"集合"目录，由 Plugin 决定最终的存储路径并返回。典型场景：对话附件上传。

与 PUT 的区别：
- **PUT**：`path` 是完整的目标文件路径，客户端决定存储位置
- **POST**：`path` 是集合目录路径，另传 `fileName` 表示原始文件名；Plugin 在该目录下生成唯一文件名，返回实际路径

```
UI 创建 DC file:<transferId>
 |                                                            Plugin
 |                                                              |
 | -- string: {                                                 |
 |      "method": "POST",                                       |
 |      "agentId": "main",                                      |
 |      "path": ".coclaw/chat-files/main",                      |
 |      "fileName": "photo.jpg",                                |
 |      "size": 204800                                          |
 |    } ------------------------------------------------------> |  <- 请求
 |                                                              |
 |                         校验 path 为合法目录路径                 |
 |                         校验 size <= 1GB                      |
 |                         获取 workspace 路径（gateway RPC）      |
 |                         生成唯一文件名（如 photo-a3f1.jpg）      |
 |                         mkdir -p 目标目录                      |
 |                                                              |
 | <-- string: {"ok": true} ----------------------------------  |  <- 准备就绪
 |                                                              |
 | =========== binary chunk (16KB) ===========================> |  <- 请求体
 | =========== binary chunk (16KB) ===========================> |
 |                     ...                                      |
 |                                                              |
 | -- string: {                                                 |
 |      "done": true,                                           |
 |      "bytes": 204800                                         |
 |    } ------------------------------------------------------> |  <- 发送完成
 |                                                              |
 |              Plugin flush WriteStream                        |
 |              校验 bytes == size                               |
 |              rename tmp -> target                             |
 |                                                              |
 | <-- string: {                                                |
 |      "ok": true,                                             |
 |      "bytes": 204800,                                        |
 |      "path": ".coclaw/chat-files/main/photo-a3f1.jpg"        |
 |    } ------------------------------------------------------  |  <- 写入结果（类似 HTTP 201 + Location）
 |                                                              |
 |              任一方 close DC                                  |
```

消息序列与 PUT 相同，差异仅在于：
- 请求中 `path` 是集合目录而非文件路径，额外携带 `fileName`
- 响应中包含 `path` 字段（Plugin 生成的实际存储路径，相对于 workspace）

**文件名唯一化策略**由 Plugin 实现：4 位随机 hex 后缀 + 碰撞检测，即 `<name>-<4hex>.<ext>`。碰撞时重新生成后缀。详见 `multimodal-attachments.md` 第 3.4 节。

### 4.6 错误处理

所有错误通过统一的 JSON 格式在 DC 内返回，然后关闭 DC：

```js
// 校验阶段（路径穿越、文件不存在、超限等）
<- string: {"ok": false, "error": {"code": "NOT_FOUND", "message": "File not found: src/app.js"}}
// -> close DC

// 传输中途（磁盘错误、空间不足等）
<- string: {"ok": false, "error": {"code": "DISK_FULL", "message": "No space left on device"}}
// -> close DC
```

接收方判断逻辑：收到 string 消息时解析 JSON，检查 `ok` 字段（或 `done` 字段）。`ok: false` 即为错误，无论出现在哪个阶段。

#### 接收端超限防护

Plugin 接收上传数据时，持续检查 `receivedBytes`。若超过请求中声称的 `size` 或超过 1GB 硬限制，立即中止传输：

```js
<- string: {"ok": false, "error": {"code": "SIZE_EXCEEDED", "message": "Received bytes exceed declared size"}}
// -> 删除临时文件，close DC
```

不信任 UI 声称的 `size`，以实际接收字节数为准进行硬限制校验。

### 4.7 写入行为

- **文件覆盖**（PUT）：默认静默覆盖已存在的文件（与 HTTP PUT 语义一致）
- **目录自动创建**（PUT / POST）：写入路径中的中间目录不存在时，自动创建（类似 `mkdir -p`）

### 4.8 取消

取消操作通过**直接关闭 DC** 实现，不需要额外的 cancel RPC。

**UI 取消上传/下载**：UI 直接 close DC。Plugin 检测到 DC 关闭时判断传输是否已正常完成：

```
Plugin 侧 DC close 事件处理：
  上传场景（PUT / POST）：
    已收到 UI 的完成信号（done:true string）？
      +-- YES -> 正常结束，不应走到这里（Plugin 应已回复写入结果）
      +-- NO  -> 取消/中断，删除临时文件
  下载场景（GET）：
    已发送完成确认（ok:true string）？
      +-- YES -> 正常结束
      +-- NO  -> 取消/中断，中止 ReadStream
```

**Plugin 取消**（罕见，如 workspace 被删除）：发送 error JSON string + close DC。

这比显式 cancel RPC 简单得多——DC 生命周期即传输生命周期，关闭即终止。

> TODO: 传输中途停滞检测（发送方长时间不发数据但连接未断）——初期不处理，依赖用户手动取消。

### 4.9 超时

Plugin 对 file DC 设置初始请求超时：DC 打开后 **30 秒**内未收到合法的请求 string，Plugin 关闭 DC。防止空 DC 资源泄漏。

### 4.10 DC 内帧序列规则总结

| 操作 | 消息序列（-> 为 UI 发，<- 为 Plugin 发） |
|------|----------------------------------------|
| GET 成功 | -> request -> <- response header -> <- binary×N -> <- completion{ok} -> close |
| GET 失败（校验阶段） | -> request -> <- error -> close |
| GET 失败（传输中途） | -> request -> <- response header -> <- binary×? -> <- error -> close |
| PUT 成功 | -> request -> <- ready -> -> binary×N -> -> done -> <- result{ok} -> close |
| PUT 失败（校验阶段） | -> request -> <- error -> close |
| PUT 失败（写入阶段） | -> request -> <- ready -> -> binary×N -> -> done -> <- result{error} -> close |
| PUT 失败（超限） | -> request -> <- ready -> -> binary×? -> <- error{SIZE_EXCEEDED} -> close |
| POST 成功 | -> request -> <- ready -> -> binary×N -> -> done -> <- result{ok, path} -> close |
| POST 失败 | 与 PUT 相同 |
| UI 取消 | （任何阶段）UI close DC |
| 超时 | DC open 后 30s 无请求 -> Plugin close DC |

### 4.11 SCTP 有序可靠保证

DataChannel 配置 `ordered: true`，底层 SCTP 保证：

- **有序交付**：消息严格按发送顺序到达
- **可靠传输**：丢包自动重传，无需应用层 ACK 或序列号
- **完整性**：DTLS 加密 + SCTP 校验，无需应用层校验和
- **优雅关闭**：close 操作确保所有待发消息交付后才触发对端 close 事件

最后一点至关重要——它保证接收方总是先收到最后一条消息（完成确认），然后才检测到 DC 关闭。

---

## 五、rpc 通道上的文件操作

列目录、删除、创建目录、创建空文件等不涉及数据传输的操作，直接走 `rpc` DataChannel 上的标准 JSON-RPC。

### Plugin 侧消息路由

```
rpc DataChannel onmessage
  | parse JSON
  |
  method.startsWith("coclaw.files.") ?
    +-- YES -> FileHandler 本地处理（直接 fs 操作）
    +-- NO  -> 转发至 gatewayWs（现有 RPC 逻辑）
```

### 5.1 coclaw.files.list

列出目录内容（单层，不递归）。

```js
// Request
{ type: "req", id: "r1", method: "coclaw.files.list",
  params: { agentId: "main", path: "src/" } }

// Response — 成功
{ type: "res", id: "r1", ok: true,
  payload: {
    files: [
      { name: "main.js", type: "file",    size: 2048, mtime: 1711234567000 },
      { name: "link.js", type: "symlink", size: 0,    mtime: 1711234500000 },
      { name: "utils",   type: "dir",     size: 0,    mtime: 1711234000000 }
    ]
  }
}

// Response — 路径不存在
{ type: "res", id: "r1", ok: false,
  error: { code: "NOT_FOUND", message: "Directory not found: src/" } }
```

### 5.2 coclaw.files.delete

删除文件或目录。

```js
// Request — 删除文件或空目录
{ type: "req", id: "r2", method: "coclaw.files.delete",
  params: { agentId: "main", path: "tmp/old.log" } }

// Request — 强制删除非空目录（递归）
{ type: "req", id: "r2", method: "coclaw.files.delete",
  params: { agentId: "main", path: "old-docs", force: true } }

// Response
{ type: "res", id: "r2", ok: true, payload: {} }

// Response — 非空目录（未传 force）
{ type: "res", id: "r2", ok: false,
  error: { code: "NOT_EMPTY", message: "Directory not empty: tmp/" } }
```

#### force 参数

| `force` | 对文件 | 对空目录 | 对非空目录 |
|---------|--------|---------|-----------|
| 未传 / `false` | 删除 | 删除 | 返回 `NOT_EMPTY` 错误 |
| `true` | 删除 | 删除 | 递归删除（`fs.rm(path, { recursive: true, force: true })`） |

UI 侧在删除非空目录时需先经 checkbox confirm 对话框确认，再传递 `force: true`。

### 5.3 coclaw.files.mkdir

创建目录（递归，类似 `mkdir -p`）。目录已存在时视为成功。

```js
// Request
{ type: "req", id: "r3", method: "coclaw.files.mkdir",
  params: { agentId: "main", path: "data/exports" } }

// Response
{ type: "res", id: "r3", ok: true, payload: {} }
```

### 5.4 coclaw.files.create

创建空文件。

```js
// Request
{ type: "req", id: "r4", method: "coclaw.files.create",
  params: { agentId: "main", path: "notes.txt" } }

// Response
{ type: "res", id: "r4", ok: true, payload: {} }
```

文件已存在时的行为：返回错误 `ALREADY_EXISTS`，避免意外覆盖。需要覆盖时应使用 PUT。

### 错误码汇总

| 错误码 | 含义 | 出现位置 |
|--------|------|---------|
| `NOT_FOUND` | 文件/目录不存在 | rpc / file DC |
| `PATH_DENIED` | 路径穿越 workspace 边界 | rpc / file DC |
| `AGENT_DENIED` | agentId 未绑定到当前 bot | file DC |
| `SIZE_EXCEEDED` | 文件超过 1GB 上传限制（含接收端实际字节数超限） | file DC |
| `IS_DIRECTORY` | 对目录执行了文件操作（如 GET） | rpc / file DC |
| `NOT_EMPTY` | 删除非空目录（未传 `force`） | rpc |
| `ALREADY_EXISTS` | 创建空文件时文件已存在 | rpc |
| `READ_FAILED` | 读取中途磁盘错误 | file DC |
| `WRITE_FAILED` | 写入中途磁盘错误（含字节数不匹配） | file DC |
| `DISK_FULL` | 磁盘空间不足 | file DC |
| `UNKNOWN_METHOD` | 不支持的 method | file DC |

---

## 六、数据传输细节

### 6.1 分片

- **chunk 大小**：16KB（固定）
- 每条 binary 消息为纯二进制 chunk（ArrayBuffer / Buffer），无额外帧头
- 不需要序列号或校验——SCTP/DTLS 层保证
- 接收方按累计字节数追踪进度（总大小已通过请求/响应头告知）

> TODO: 后期可实测 werift 和浏览器的 SCTP 消息上限，尝试更大 chunk（如 64KB）以提升吞吐。

### 6.2 发送侧流控（Backpressure）

WebRTC DataChannel 不自动暂停应用层发送。发送方必须监控 `bufferedAmount` 自行控制节奏。

> 详细的平台差异分析见 `webrtc-p2p-channel.md` 第十节。

#### 平台行为差异

| 平台 | `send()` 缓冲区满时 | 不做流控的后果 |
|------|---------------------|--------------|
| **浏览器** | 抛 `DOMException`，通道不关闭 | send() 异常中断传输 |
| **werift**（Plugin） | 不抛异常，数据推入无上限 JS 数组 | 1GB 文件内容全量堆积在内存中，OOM |

两端都**必须**实现流控。werift 侧尤为关键——它不会抛异常提醒你，只会默默吃掉所有内存。

#### 流控算法

```
常量:
  CHUNK_SIZE           = 16384      (16KB)
  HIGH_WATER_MARK      = 262144     (256KB，暂停发送阈值)
  LOW_WATER_MARK       = 65536      (64KB，恢复发送阈值)

发送循环:
  1. 从 stream 读取一个 chunk
  2. dc.send(chunk)
  3. if (dc.bufferedAmount > HIGH_WATER_MARK)
       -> 暂停读取
       -> 设置 dc.bufferedAmountLowThreshold = LOW_WATER_MARK
       -> 等待 bufferedamountlow 事件
       -> 恢复读取
  4. 回到 1
  5. stream 读完 -> 发送完成确认 JSON string
```

内存峰值始终可控——即使传输 1GB 文件，不超过 `HIGH_WATER_MARK + CHUNK_SIZE`。HIGH_WATER_MARK (256KB) 远低于浏览器的 16MB 缓冲上限，正常流控下不会触发异常。实现时 `send()` 外仍加 try/catch 作为兜底。

#### werift 事件 API

werift 的 `bufferedamountlow` 事件支持两种风格，统一使用回调风格（与浏览器 API 一致）：

```js
dc.bufferedAmountLowThreshold = LOW_WATER_MARK;
dc.onbufferedamountlow = () => stream.resume();
```

### 6.3 Plugin 侧 Node.js Stream 集成

> werift 的 DataChannel 仅提供 `send(Buffer | string)`，无 pipe/stream/Writable 封装。因此 Plugin 侧必须手动将 Node.js ReadStream 与 DataChannel 的 bufferedAmount 流控桥接。

**下载（Plugin 发送，GET）**：

```js
const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
let sentBytes = 0;

dc.onbufferedamountlow = () => stream.resume();
dc.bufferedAmountLowThreshold = LOW_WATER_MARK;

stream.on('data', (chunk) => {
    dc.send(chunk);
    sentBytes += chunk.length;
    if (dc.bufferedAmount > HIGH_WATER_MARK) {
        stream.pause();
    }
});
stream.on('end', () => {
    dc.send(JSON.stringify({ ok: true, bytes: sentBytes }));
    dc.close();
});
stream.on('error', (err) => {
    dc.send(JSON.stringify({ ok: false, error: { code: 'READ_FAILED', message: err.message } }));
    dc.close();
});
```

**上传（Plugin 接收，PUT / POST）**：

```js
const ws = fs.createWriteStream(tmpPath, { highWaterMark: CHUNK_SIZE });
let receivedBytes = 0;
let doneReceived = false;

dc.onmessage = (event) => {
    if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);
        if (msg.done) {
            // UI 发送完成信号，flush 并校验
            doneReceived = true;
            ws.end(() => {
                const valid = receivedBytes === declaredSize;
                const result = valid
                    ? { ok: true, bytes: receivedBytes }
                    : { ok: false, error: { code: 'WRITE_FAILED', message: 'Size mismatch' } };
                // POST 时在成功结果中附带实际路径
                if (valid && isPost) result.path = relativePath;
                dc.send(JSON.stringify(result));
                if (valid) rename(tmpPath, targetPath);
                else unlink(tmpPath);
                dc.close();
            });
        }
    } else {
        receivedBytes += event.data.byteLength;
        // 接收端超限防护
        if (receivedBytes > MAX_UPLOAD_SIZE) {
            ws.destroy();
            unlink(tmpPath);
            dc.send(JSON.stringify({ ok: false, error: { code: 'SIZE_EXCEEDED', message: '...' } }));
            dc.close();
            return;
        }
        ws.write(event.data);
    }
};

dc.onclose = () => {
    if (!doneReceived) {
        // 未收到 done 信号 -> 取消/中断
        ws.destroy();
        unlink(tmpPath);
    }
};
```

> 写入先到临时文件（`<target>.tmp.<transferId>`），完成后 rename，避免半写文件。临时文件与目标文件在同一目录下，确保 rename 不跨挂载点（避免 EXDEV）。

### 6.4 临时文件清理

Plugin 启动时，延迟启动后台微任务（如 delay 60s），扫描各 agent workspace 中的 `.tmp.*` 文件并清理。防止因 Plugin 崩溃或进程被杀导致的临时文件残留。

### 6.5 UI 侧 Browser API

**上传**：`File.stream()` -> `ReadableStream` -> reader 逐块读取 -> 同样的 bufferedAmount 流控。发完后发送 `{done: true, bytes}` 完成信号，等待 Plugin 的写入结果。

**下载**：接收 binary chunks 重组为 Blob，或通过 StreamSaver.js / Service Worker 流式落盘（具体实现后续细化）。收到 `{ok: true, bytes}` 完成确认后校验字节数。

### 6.6 进度上报

UI 通过累计已发送/已接收字节数与总大小计算进度百分比。不需要协议层支持——总大小已在请求（PUT/POST 的 `size`）或响应头（GET 的 `size`）中告知。

```
进度 = receivedBytes / totalSize * 100
```

UI 在每次 binary 消息发送/接收后更新进度。由于 chunk 固定 16KB，进度更新频率取决于文件大小（1MB 文件约 64 次更新，1GB 文件约 65536 次更新）。

### 6.7 size 与 bytes 的区分

协议中 `size` 和 `bytes` 表达不同语义：

| 字段 | 出现阶段 | 含义 | HTTP 类比 |
|------|---------|------|-----------|
| `size` | 传输开始前（请求或响应头） | 预告文件总大小 | `Content-Length` header |
| `bytes` | 传输完成后（完成确认或写入结果） | 实际传输字节数 | 实际接收的 body 长度 |

两端各自用 `bytes === size` 校验传输完整性。

---

## 七、约束与限制

| 约束 | 值 |
|------|-----|
| 上传大小限制（UI -> Plugin） | 1GB |
| 下载无硬限制 | UI 可自行决定是否接受 |
| chunk 大小 | 16KB |
| 发送缓冲区暂停阈值（HIGH_WATER_MARK） | 256KB |
| 发送缓冲区恢复阈值（LOW_WATER_MARK） | 64KB |
| 路径沙箱 | 仅限 Agent workspace 目录内 |
| 符号链接 | 拒绝指向 workspace 外的 symlink |
| 文件锁 | TODO，后续考虑 |

---

## 八、依赖评估

| 需求 | 方案 | 新依赖 |
|------|------|--------|
| 文件读写删除 | Node.js `fs/promises` | 否 |
| 目录列表 | `fs.readdir({ withFileTypes })` | 否 |
| 路径安全校验 | `path.resolve` + 前缀检查 | 否 |
| 流式读写 | `fs.createReadStream` / `fs.createWriteStream` | 否 |
| 大文件分片传输 | WebRTC DataChannel（已有基础设施） | 否 |
| 二进制传输 | DataChannel Binary 消息 | 否 |
| Agent workspace 路径 | Gateway RPC `agents.files.list` | 否 |

**结论：不需要任何新的第三方依赖。**

---

## 附录 A：曾评估的其它方案

在确定自包含 DataChannel 方案前，评估了另外两种将传输控制放在 `rpc` DataChannel 上的方案。这两种方案在 WebRTC 文件传输场景中较少采用——社区主流做法是 per-file DC 自包含传输。

### A.1 两阶段 RPC

`rpc` 通道上的 RPC 请求从发起到传输结束才完结，response 分两阶段返回（先 `accepted`，后 `ok`/`error`）。`file:<transferId>` DC 仅传输数据，控制面全程在 `rpc` 上。

```
-> req: coclaw.file.read
<- res: {status:"accepted", payload:{transferId, size}}
   === file DC 传输 ===
<- res: {status:"ok", payload:{bytesTransferred}}
```

复用现有 `chat.send` 的两阶段模式，UI 侧单个 Promise 处理。但 RPC 长时间 pending（大文件传输可能数分钟）带来状态管理负担，连接断开时需清理 orphan pending responses（`chat.send` 在此处踩过坑），超时策略也需特殊处理。

### A.2 单阶段 RPC + 独立 Event

RPC 快速响应后即完结（返回 `transferId`），传输完成通知通过 `rpc` 上的 `coclaw.file.transferDone` event 推送。取消通过独立的 `coclaw.file.cancel` RPC。

```
-> req: coclaw.file.read
<- res: {ok:true, payload:{transferId, size}}
   === file DC 传输 ===
<- event: coclaw.file.transferDone {transferId, ok:true}
```

借鉴 FTP 模型（control channel command -> data connection -> status on control channel）。RPC 生命周期短，无长期 pending 状态。但需要跨通道（rpc DC <-> file DC）的 transferId 关联和 event 监听管理。
