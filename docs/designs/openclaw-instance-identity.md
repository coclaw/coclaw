# OpenClaw 实例唯一标识研究

> 状态：研究阶段，暂未实施
> 日期：2026-03-15

## 背景与需求

当前 CoClaw Server 在 OpenClaw 插件 bind 时为其分配 Snowflake botId。每次重新 bind 都会生成新的 ID，导致 Server 无法跨 bind 持续追踪同一个 OpenClaw 实例。

我们需要唯一标识一个 OpenClaw 实例，以便在 Server 中建立与实例的持久对应关系（例如：记录某实例中某 agent 有哪些用户触发创建的新话题 session）。

核心挑战：用户可能将整个 `.openclaw` 目录复制到其它主机运行，此时需要能区分原始实例与副本。

---

## OpenClaw 现有身份机制

### Device Identity（Ed25519 密钥对）

- **源码**：`openclaw-repo/src/infra/device-identity.ts`
- **存储**：`~/.openclaw/identity/device.json`（权限 0o600）
- **deviceId**：SHA-256(Ed25519 公钥原始字节)，64 字符 hex
- 首次运行时生成，后续一直复用
- 用于 Gateway WebSocket 连接时的签名认证（`v3` payload 格式）

存储结构：
```json
{
  "deviceId": "dc365349...",
  "publicKeyPem": "...",
  "privateKeyPem": "...",
  "createdAtMs": 1234567890,
  "version": 1
}
```

### 克隆检测

**OpenClaw 没有任何克隆检测机制。** 复制 `~/.openclaw/` 到新机器后，新机器拥有完全相同的 `deviceId` 和密钥对，OpenClaw 不会感知。

### 其它标识

| 标识 | 性质 | 用途 |
|---|---|---|
| `deviceId` | 稳定，密码学派生，持久化 | Gateway 认证、Presence 去重 |
| `instanceId` | 临时，每次连接重新生成 `randomUUID()` | WS 连接级去重，非持久化 |

---

## CoClaw 当前 Bind 机制

### 流程

1. 用户在 UI 调用 `POST /api/v1/bots/binding-codes` → 获得 8 位绑定码（30 分钟有效）
2. OpenClaw 插件提交绑定码到 `POST /api/v1/bots/bind` → Server 分配 Snowflake botId + cuid2 token
3. 凭据存入 `~/.openclaw/coclaw/bindings.json`：`{ serverUrl, botId, token, boundAt }`
4. 后续 WS 连接通过 token 认证，Server 以 SHA-256(token) 查找 Bot 记录

### 关键文件

| 文件 | 说明 |
|---|---|
| `server/src/services/bot-binding.svc.js` | 绑定码生成、bind/unbind 逻辑 |
| `server/src/services/id.svc.js` | Snowflake botId 生成 |
| `server/src/routes/bot.route.js` | HTTP 路由处理 |
| `plugins/openclaw/src/common/bot-binding.js` | 插件侧 bind 入口 |
| `plugins/openclaw/src/api.js` | 插件 → Server HTTP 调用 |
| `plugins/openclaw/src/config.js` | 凭据持久化 |
| `plugins/openclaw/src/realtime-bridge.js` | WS 连接（Server + 本地 Gateway） |
| `plugins/openclaw/src/device-identity.js` | 插件侧 Ed25519 身份（仅用于本地 Gateway 认证） |

### 问题

- botId 在每次 bind 时重新生成，无法跨 bind 追踪实例
- 插件侧的 device-identity 与 OpenClaw 自身的 device-identity 是独立的两套
- 克隆 `.openclaw` 目录后，两台机器共享同一 botId 和 token

---

## 可选方案

### 方案 A：直接使用 OpenClaw deviceId

将 OpenClaw 的 `deviceId` 作为实例唯一标识，在 bind 时上报给 Server。

- **优点**：已存在、稳定、密码学绑定
- **缺点**：克隆后两台机器共享同一 deviceId，无法区分
- **适用**：如果克隆被视为极端边缘情况

### 方案 B：deviceId + 机器指纹

在 CoClaw 插件侧生成复合标识：`hash(deviceId + machineFingerprint)`

机器指纹候选：
- Linux：`/etc/machine-id`（systemd 生成）
- macOS：`IOPlatformUUID`（硬件级）
- 或 `os.hostname() + os.networkInterfaces()` 的稳定字段

- **优点**：克隆到新机器后指纹自然不同，产生新 ID
- **缺点**：机器指纹稳定性因环境而异（Docker/VM 场景尤其不可靠）

### 方案 C：首次生成 + 环境变更检测（推荐）

在 CoClaw 插件侧维护 `instance-identity.json`：

```json
{
  "instanceId": "<随机 UUID>",
  "machineHint": "<hostname + machine-id 的 hash>",
  "createdAt": "..."
}
```

启动时校验 `machineHint`：
- 未变化 → 继续使用现有 `instanceId`
- 变化 → 判定为克隆，生成新 `instanceId`，向 Server 发起重新注册

类似 VMware 的 "moved or copied" 检测逻辑。

- **优点**：不依赖 OpenClaw 上游变更；核心唯一性由 UUID 保证；指纹仅用作克隆检测哨兵
- **缺点**：Docker 容器重建等场景可能误判为克隆（但误判方向安全——宁可多生成 ID，不可共享 ID）

### 方案 D：Server 侧冲突检测

不在客户端保证唯一性，而是：
- 允许同一 deviceId 的多个连接同时存在
- Server 通过 IP、连接时间、在线状态等信号检测疑似克隆
- 冲突时提示用户确认

- **优点**：客户端零改动
- **缺点**：检测逻辑复杂，存在漏判窗口

---

## 初步推荐

**方案 C** 最务实：

1. 不依赖 OpenClaw 上游变更
2. `machine-id` 等指纹在绝大多数场景下足够可靠（仅用于触发重新生成）
3. 核心唯一性由随机 UUID 保证，不依赖外部因素
4. 与 VMware 处理思路一致，用户可理解
5. 误判方向安全（宁可产生新 ID，不可两实例共享 ID）

需要接受的 tradeoff：某些场景（Docker 容器重建）可能误判为克隆。
