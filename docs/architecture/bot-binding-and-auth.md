# CoClaw Bot 绑定与鉴权方案 (Bot Binding & Authentication Scheme)

> 状态：已实施
> 最后更新：2026-04-02

本文档详细阐述了将用户本地 OpenClaw 实例（即 "Bot" 或 "Agent"）绑定到 CoClaw 云端账号的架构设计，以及随后的鉴权机制与体系融合方案。

## 1. 核心概念

*   **Bot**: 用户 OpenClaw 实例在 CoClaw 系统中的数字化身。我们将此实体命名为 **Bot**（而非 Device），因为它更贴近“智能助手/代理”的业务属性，符合 Chat 场景的用户心智。
*   **反向认领 (Reverse Claiming)**: 不同于传统的 IoT 设备自动发现，CoClaw 采用 **用户主动发起绑定** 的流程。用户从 Web 控制台获取认领码，并在本地 CLI 输入。这确保了用户对连接行为的显式授权和隐私控制。
*   **Token 鉴权 (Token-Based Auth)**: 系统采用标准的 Bearer Token 机制进行鉴权，由服务端在绑定成功时统一颁发。

## 2. 绑定流程

系统支持两种对称的绑定流程，将匿名的本地 OpenClaw 实例转化为 CoClaw 平台上身份明确的 "Bot"。

### 流程 A：用户主导（Binding）

用户在 UI 获取绑定码，在 OpenClaw CLI 执行绑定。

**第一阶段：获取绑定码（UI 端）**

1.  用户登录 CoClaw App，进入"添加 Claw"页面。
2.  `POST /api/v1/bots/binding-codes` 生成 8 位绑定码（默认有效期 30 分钟，`BINDING_CODE_EXPIRE_MINUTES` 可配），关联当前用户。
3.  UI 进入长轮询等待（`POST /api/v1/bots/binding-codes/wait`，25s 超时轮询）。

**第二阶段：执行绑定（CLI 端）**

1.  用户在 OpenClaw 终端执行：`openclaw coclaw bind "88889999"`
2.  CLI 通过 `coclaw.bind` gateway RPC 将请求发送到 gateway 进程。
3.  Gateway 内的 RPC handler：停止 bridge → 若已有绑定则先强制解绑旧 bot → 向 `POST /api/v1/bots/bind` 提交绑定码。

**第三阶段：服务端验证与颁发**

1.  验证绑定码存在且未过期，删除已用绑定码（用完即焚）。
2.  创建 `Bot` 记录（Snowflake ID），生成 Access Token（CUID2），仅存储 `SHA-256(token)` 到 `tokenHash BINARY(32)`。
3.  唤醒长轮询等待者 + SSE 推送 `bot.bound` 事件。
4.  返回 `{ botId, token }` 给 Plugin。

**第四阶段：配置写入与连接建立**

1.  Gateway handler 将 `botId` + `token` 通过 `writeConfig`（原子写入 + mutex）写入 `~/.openclaw/coclaw/bindings.json`。
2.  调用 `restartRealtimeBridge()` 建立 Server WS + Gateway WS 连接。

### 流程 B：Plugin 主导（Claim / Enroll）

Plugin 在 CLI 生成认领码，用户在 App 端认领。

**第一阶段：生成认领码（CLI 端）**

1.  用户在 OpenClaw 终端执行：`openclaw coclaw enroll [--server <url>]`
2.  CLI 通过 `coclaw.enroll` gateway RPC → handler 调用 `POST /api/v1/claws/claim-codes` 生成 8 位认领码（30 分钟有效）。
3.  终端显示认领码和 App URL，handler 进入长轮询等待（`POST /api/v1/claws/claim-codes/wait`）。

**第二阶段：用户认领（App 端）**

1.  用户在 CoClaw App 输入认领码，调用 `POST /api/v1/claws/claim`（需 session 鉴权）。
2.  Server 验证认领码 → 创建 Bot 记录 → 签发 token → 删除认领码。
3.  唤醒 Plugin 的长轮询，将 `{ botId, token }` 返回给 Plugin。

**第三阶段：配置写入与连接建立**

与流程 A 第四阶段相同。

## 3. 鉴权机制

绑定完成后，Bot 使用标准的 Web 协议进行身份验证。

### 3.1 解绑与在线约定（当前实现）

*   **多 Bot（当前实现）**：同一用户可绑定多个 Bot（每次绑定创建新记录）。插件侧在重绑时强制先解绑旧 bot（mandatory unbind），但多 Claw 场景下用户仍可拥有多个 bot 记录。
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

#### BotBindingCode 表（用户主导绑定）
*   **code** (PK): 8位数字绑定码（如 `88889999`）。作为主键以利用数据库唯一性约束防止重复。
*   **userId**: 发起绑定的用户（非外键）。
*   **expiresAt**: 过期时间。
*   **createdAt**: 创建时间。

#### ClawClaimCode 表（Plugin 主导认领）
*   **code** (PK): 8位数字认领码，与 BotBindingCode 同格式。
*   **expiresAt**: 过期时间。
*   **createdAt**: 创建时间。

> 两种码使用独立的表，互不冲突。

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
*   **npm 包名**: `@coclaw/openclaw-coclaw`；**插件 ID**: `openclaw-coclaw`。
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

*   **命令**: `openclaw coclaw bind <code>` / `openclaw coclaw unbind` / `openclaw coclaw enroll`
*   **逻辑**：三条命令均为瘦 CLI，通过 `coclaw.bind`/`coclaw.unbind`/`coclaw.enroll` gateway RPC 在 gateway 进程内执行：
    1.  Gateway handler 停止 bridge（bind 前）或先执行 server API 调用（unbind）。
    2.  调用 CoClaw API 换取 Token（bind）/ 删除 bot（unbind）/ 生成认领码（enroll）。
    3.  写入/清理本地 `~/.openclaw/coclaw/bindings.json`（原子写入 + mutex）。
    4.  启动/停止 bridge 连接。

### 5.4 插件内部职责分层（当前方案）

插件已合并为单一 `@coclaw/openclaw-coclaw` 包，内部分层：
- transport + realtime-bridge：负责 bind/unbind、server ws 连接、本机 gateway ws 透传桥接。
- session-manager：负责会话业务方法定义（`nativeui.sessions.listAll/get` 等）。
- UI：只通过 CoClaw server 的 ws 通道发 rpc，不直连 OpenClaw gateway。

### 5.5 运行环境

插件始终作为 OpenClaw In-Process Plugin 运行，代码运行在 OpenClaw gateway 主进程中。CLI 命令（`openclaw coclaw bind/unbind/enroll`）为瘦壳，通过 gateway RPC 委托执行。

> 注：当前阶段优先完成”绑定体系 + 自动解绑收敛”，Gateway 全量隧道能力按后续里程碑推进。

## 6. Ed25519 设备身份

Plugin 侧已实现 Ed25519 密钥对（`device-identity.js`），当前**仅用于 Plugin → 本地 Gateway WS 的连接认证**（challenge-response 签名）。Plugin → Server 的认证仍使用 Bearer Token。

若未来安全需求升级，可将 Plugin → Server 的鉴权也升级为 Ed25519 签名，无需更改整体架构。
