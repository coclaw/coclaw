# CoClaw Bot 绑定与鉴权方案 (Bot Binding & Authentication Scheme)

本文档详细阐述了将用户本地 OpenClaw 实例（即 "Bot" 或 "Agent"）绑定到 CoClaw 云端账号的架构设计，以及随后的鉴权机制与体系融合方案。

## 1. 核心概念

*   **Bot**: 用户 OpenClaw 实例在 CoClaw 系统中的数字化身。我们将此实体命名为 **Bot**（而非 Device），因为它更贴近“智能助手/代理”的业务属性，符合 Chat 场景的用户心智。
*   **反向认领 (Reverse Claiming)**: 不同于传统的 IoT 设备自动发现，CoClaw 采用 **用户主动发起绑定** 的流程。用户从 Web 控制台获取认领码，并在本地 CLI 输入。这确保了用户对连接行为的显式授权和隐私控制。
*   **Token 鉴权 (Token-Based Auth)**: 系统采用标准的 Bearer Token 机制进行鉴权，由服务端在绑定成功时统一颁发。

## 2. 绑定流程 (The "Claim" Process)

绑定流程将一个匿名的本地实例转化为 CoClaw 平台上身份明确的 "Bot"。

### 第一阶段：获取认领码 (Web 端)

1.  用户登录 **CoClaw Web 控制台**。
2.  进入 **"Bots" -> "添加新 Bot"** 页面。
3.  服务端生成一个短时效的 **绑定码 (Binding Code)**（例如 `88889999`，有效期 5 分钟），并与当前用户会话关联。
4.  Web 界面显示该绑定码，以及需在终端执行的绑定命令。

### 第二阶段：执行绑定 (CLI 端)

1.  用户打开运行 OpenClaw 的本地终端。
2.  输入绑定命令：
    ```bash
    openclaw coclaw bind "88889999"
    ```
3.  **CLI 动作**：
    *   插件注册的 Command Handler 被触发。
    *   CLI 工具向 `https://coclaw.net/api/v1/bots/bind` 发送 POST 请求。
    *   Payload: `{ code: "88889999" }`。

### 第三阶段：服务端验证与颁发 (Server)

1.  **验证**：服务端检查绑定码是否存在且未过期。
2.  **创建与颁发**：
    *   创建新的 `Bot` 记录，关联至生成绑定码的用户。
    *   分配全局唯一的 **Bot ID** (Snowflake ID)。
    *   生成 **Access Token**（基于 CUID2）。
    *   计算 Token 的 **SHA-256** 哈希并 **仅存储哈希值 (tokenHash)**，以 `BINARY(32)` 存储。
3.  **响应**：服务端将 `{ botId: "...", token: "..." }` 返回给 CLI。

### 第四阶段：配置写入与连接建立

1.  **写入**：插件将 `botId` 与明文 `token` 写入本地绑定配置（`~/.openclaw/coclaw/bindings.json`）。
2.  **连接条件**：仅当本地存在有效 token 时，插件才会连接 server 的实时控制通道。
3.  **连接**：插件建立 `WS /api/v1/bots/stream?token=...`，用于接收解绑/凭证失效控制消息。

## 3. 鉴权机制

绑定完成后，Bot 使用标准的 Web 协议进行身份验证。

### 3.1 解绑与在线约定（当前实现）

*   **多 Bot（当前实现）**：同一用户可绑定多个 Bot（每次绑定创建新记录）。
*   **解绑（Unbind）**：解绑时服务端直接删除 Bot 记录（先删再踢线）。
*   **在线收敛策略（当前实现）**：
    *   删除成功后服务端向在线 bot 下发 `bot.unbound` 控制消息，并主动断开其 ws 连接。
    *   插件收到消息或特定 close code（如 4001）后自动清理本地 token。
*   **在线状态来源**：以 server 内存中的 bot ws 连接是否存在为准，不依赖数据库字段。

*   **协议**：WebSocket (Secure WSS)。
*   **HTTP API 鉴权**：Header `Authorization: Bearer <Access_Token>`。
*   **WebSocket 鉴权**：URL 参数 `?token=<Access_Token>`。
*   **验证逻辑**：
    1.  Server 提取 Token。
    2.  计算 `SHA-256(Token)`。
    3.  查询 `Bot` 表中是否存在匹配 `tokenHash` 的记录。
    4.  若存在则接受；否则断开。

### 3.2 Bots 列表接口返回（当前实现）

`GET /api/v1/bots` 返回每个 bot 的字段包含：
- `id`
- `name`
- `online`（是否在线，基于内存 ws 连接池实时计算）
- `lastSeenAt`
- `createdAt`
- `updatedAt`

## 4. 数据模型策略

我们采用统一的 `Bot` 表来管理身份与凭证，并引入 `BotBindingCode` 表管理临时绑定码。

### 概念模型 (Schema)

#### Bot 表
*   **id** (PK): Snowflake ID。Bot 的不可变唯一标识。
*   **userId** (FK): Bot 的所属用户。
*   **name**: 用户设置的备注名（可选）。
*   **tokenHash**: 用于鉴权的凭证哈希。**注意：服务端绝不存储明文 Token。**
*   **lastSeenAt**: 最后活跃时间（可选，当前在线判断不依赖该字段）。

> 备注：`status` 为历史字段，当前实现不再作为在线与鉴权依据。

#### BotBindingCode 表
*   **code** (PK): 8位数字绑定码（如 `88889999`）。作为主键以利用数据库唯一性约束防止重复。
*   **userId** (FK): 关联用户。
*   **expiresAt**: 过期时间。
*   **createdAt**: 创建时间。

### 绑定码防碰撞与复用策略

鉴于 8 位数字空间有限，在生成绑定码时需采用 **“碰撞重试 + 过期复用”** 的双重策略：
1.  **生成逻辑**：应用层随机生成一个 8 位数字码。
2.  **写入尝试**：尝试 `INSERT`。
3.  **冲突处理**：若主键冲突，检查该码是否已过期。
    *   **已过期**：`UPDATE` 复用该码（懒惰清理）。
    *   **未过期**：重新生成并重试（最多 3 次）。

## 5. OpenClaw 体系融合方案 (Integration Strategy)

本节阐述 CoClaw 插件如何作为一个原生组件融入 OpenClaw 生态。

核心是通过将 CoClaw 隧道封装为 **Channel 插件** 并集成 **CLI 绑定命令**，我们实现了一个既符合 OpenClaw 原生规范，又具备全功能管理权限的优雅方案。

### 5.1 插件形态：Channel Plugin

我们将 CoClaw 隧道插件注册为 **Channel（渠道）** 类型。
*   **npm 包名**: `@coclaw/openclaw-coclaw`；**插件 ID**: `coclaw`。
*   **优势**: 
    *   **生命周期管理**：复用 OpenClaw 的启动、停止、崩溃重启机制。
    *   **配置管理**：利用标准 Config Schema 进行验证和热重载。
    *   **消息路由**：自动接入 OpenClaw 的消息分发体系。

### 5.2 混合运行时架构 (Hybrid Runtime)

插件在内部扮演 **“双重角色”**，兼顾聊天与管理能力。

#### A. 角色一：聊天通道 (Standard Channel)

*   **职责**：处理用户在 CoClaw Web 发送的对话消息。
*   **实现**：将收到的 `type: 'message'` 包转换为 `api.ingest()` 调用，进入 LLM 处理流程；将 LLM 的回复通过 `send()` 钩子发回 CoClaw。

#### B. 角色二：全能网关隧道 (Admin Tunnel)

*   **职责**：赋予 CoClaw Web 对 OpenClaw 的完全控制权（如管理会话、修改配置、重启服务）。
*   **实现**：插件拦截 `type: 'rpc'` 包，直接调用 `api.runtime` 内部方法（如 `runtime.sessions.list()`），拥有与 Local Gateway 同等的 **最高权限**。

### 5.3 CLI 命令集成

插件通过 `api.registerCommand` 注册自定义子命令，实现“零手动配置”体验。

*   **命令**: `openclaw coclaw bind <code>` / `openclaw coclaw unbind`
*   **逻辑**:
    1.  调用 CoClaw API 换取 Token。
    2.  插件将凭据写入本地 `~/.openclaw/coclaw/bindings.json`。
    3.  插件检测到本地有 token 后，建立到 server 的实时通道。

### 5.4 插件内部职责分层（当前方案）

插件已合并为单一 `@coclaw/openclaw-coclaw` 包，内部分层：
- transport + realtime-bridge：负责 bind/unbind、server ws 连接、本机 gateway ws 透传桥接。
- session-manager：负责会话业务方法定义（`nativeui.sessions.listAll/get` 等）。
- UI：只通过 CoClaw server 的 ws 通道发 rpc，不直连 OpenClaw gateway。

### 5.5 开发与生产的适配 (Dev vs Prod)

为了便于开发调试，插件采用 **适配器模式 (Adapter Pattern)** 兼容两种运行环境：

*   **生产环境 (In-Process Plugin)**:
    *   代码运行在 OpenClaw 主进程中。
    *   主要关注绑定/解绑与实时控制通道（`/api/v1/bots/stream`）的稳定性。
*   **开发环境 (Standalone Process)**:
    *   代码作为独立 Node.js 进程运行（CLI 模式）。
    *   与插件模式共享同一 bind/unbind 核心逻辑。

> 注：当前阶段优先完成“绑定体系 + 自动解绑收敛”，Gateway 全量隧道能力按后续里程碑推进。

## 6. 未来演进：密钥对鉴权

若未来安全需求升级，可在 CLI 绑定阶段增加密钥生成步骤，将鉴权方式从 Token 升级为 Ed25519 签名，且无需更改整体架构。
