# OpenClaw 侧发起绑定（认领绑定 / Enroll）

## 概述

新增一种由 OpenClaw 侧主动发起的绑定方式（认领绑定），作为现有用户侧发起绑定的补充。

### 背景

现有绑定流程要求用户先在 CoClaw App 中生成绑定码，再到 OpenClaw 侧输入。新流程反向：OpenClaw 通过 skills 平台发现 CoClaw 插件后，主动安装并发起登记（enroll），生成认领码和链接发送给用户，用户点击链接即可完成绑定。

### 主要路径

认领绑定的主路径是 **OpenClaw agent 自主发起**：agent 通过搜索 skills、GitHub 等渠道发现 CoClaw 插件，根据文档指引安装插件、发起 enroll，然后通知用户点击认领链接。用户手动在 OpenClaw 侧通过斜杠命令或 CLI 发起 enroll 是次要路径。

> **注意**：当前 OpenClaw 架构中，agent 无法直接调用斜杠命令（斜杠命令在 LLM 之前被拦截）。agent 自动发起需通过 `registerTool` 注册 agent tool，这是后续事项。当前 enroll 由用户在 OpenClaw 侧手动触发。

### 术语

| 术语 | 英文 | 创建方 | 消费方 | 场景 |
|------|------|--------|--------|------|
| 绑定码 | binding code | 用户（App 内） | bot（CLI/斜杠命令） | 用户先行，手动输入码 |
| 认领码 | claim code | bot（enroll 命令） | 用户（点击链接） | OpenClaw 先行，用户点链接 |

## 时序

### 斜杠命令路径（gateway 内直接执行）

```
用户/Agent          Plugin(gateway内)         Server              用户 App
  │                     │                      │                    │
  │──/coclaw enroll────>│                      │                    │
  │                     │──POST claim-codes───>│                    │
  │                     │<──{code,waitToken}───│                    │
  │<──认领信息文本──────│                      │                    │
  │                     │──POST claim-codes/wait─>│                 │
  │                     │   (后台长轮询)       │                    │
  │                     │                      │                    │
  │──发消息给用户──────>│                      │                    │
  │  "请点击链接认领…"  │                      │                    │
  │                     │                      │      用户点击链接──>│
  │                     │                      │                    │
  │                     │                      │   (未登录→登录/注册→回到 /claim)
  │                     │                      │                    │
  │                     │                      │<──POST /claim──────│
  │                     │                      │   {code}           │
  │                     │                      │                    │
  │                     │                      │──创建Bot+token─────│
  │                     │                      │──通知wait hub─────>│
  │                     │<──{token,botId}──────│                    │
  │                     │                      │                    │
  │                     │──保存config          │                    │
  │                     │──启动bridge          │                    │
```

### CLI 路径（CLI → RPC → gateway 代理）

```
CLI                        Gateway(插件)              Server
 │──RPC coclaw.enroll────>│                            │
 │                         │──POST claim-codes────────>│
 │                         │<──{code,waitToken}────────│
 │<──{code,appUrl}────────│                            │
 │                         │                            │
 │──输出认领码给用户        │──POST claim-codes/wait───>│(后台长轮询)
 │  退出                   │<──{token,botId}───────────│
 │                         │──写config+启bridge         │
```

CLI 单次 gateway 重启重试逻辑：

```
RPC 调用 → 成功 → 输出认领码，退出
         → 失败且判断为 gateway 不可用
              → 重启 gateway
              → 再次 RPC → 成功 → 输出，退出
                         → 失败 → 输出错误+指引，退出
         → 失败且非 gateway 不可用 → 输出错误+指引，退出
```

## 设计详情

### 1. 数据库

新增独立表 `ClawClaimCode`，不复用 `BotBindingCode`：

```prisma
model ClawClaimCode {
  code        String @id @db.VarChar(16)
  createdAt   DateTime @default(now())
  expiresAt   DateTime
  @@index([expiresAt])
}
```

- 认领码无 `userId`（创建时尚无用户），用户认领时直接消费并删除
- 绑定码和认领码分表，各流程独立查询，不会误消费对方的码
- 跨表码冲突不构成问题：绑定码由 `/bots/bind` 消费，认领码由 `/claws/claim` 消费，端点完全不同
- 有效期 30 分钟（复用 `BINDING_CODE_EXPIRE_MINUTES`）

> 命名说明：新表使用 `Claw` 而非 `Bot`。Claw 指代包含多个 agent 的容器（如 OpenClaw），agent 与 bot 才是对等关系。旧表（`Bot`、`BotBindingCode`）暂不改名。

### 2. Server

#### 2.1 Service 层（`bot-binding.svc.js`）

新增：

- **`createClaimCode()`** — 复用 `genBindingCode()` 生成 8 位认领码，写入 `ClawClaimCode` 表，返回 `{ ok, code, expiresAt }`
- **`claimBot({ code, userId })`** — 校验认领码（存在 + 未过期），检查用户是否已有绑定（已有则拒绝），创建 Bot + 生成 token，删除认领码，返回 `{ ok, botId, token, botName }`

`claimBot` 拒绝已绑定用户时的错误响应应包含引导信息：在 OpenClaw 侧执行 `openclaw coclaw unbind` 解绑后重试。

#### 2.2 API 端点（`claw.route.js`）

| 端点 | 认证 | 调用方 | 用途 |
|------|------|--------|------|
| `POST /api/v1/claws/claim-codes` | 无（公开） | Plugin(gateway) | 创建认领码，返回 `{ code, expiresAt, waitToken }` |
| `POST /api/v1/claws/claim-codes/wait` | 无（公开） | Plugin(gateway) | 长轮询等待认领结果，返回 `{ token, botId }` |
| `POST /api/v1/claws/claim` | Session | 用户 App | 用户认领，返回 `{ botId, botName }` |

旧端点 `/api/v1/bots/bind` 等不变。

#### 2.3 Claim Wait Hub（`claim-wait-hub.js`）

与 `binding-wait-hub.js` 对称：

- `registerClaimWait({ code, expiresAt })` → 返回 `waitToken`
- `waitClaimResult({ code, waitToken })` → Promise，等待认领或超时
- `markClaimBound({ code, botId, token })` → 通知等待者，传递 `{ botId, token }`

### 3. Plugin（plugins/openclaw）

#### 3.1 API 函数（`api.js`）

- `createClaimCodeOnServer({ baseUrl })` → `POST /api/v1/claws/claim-codes`
- `waitClaimCodeOnServer({ baseUrl, code, waitToken })` → `POST /api/v1/claws/claim-codes/wait`

#### 3.2 核心逻辑（`bot-binding.js`）

- **`enrollBot({ serverUrl })`** — 解析 serverUrl（复用现有默认策略），调用 `createClaimCodeOnServer`，返回 `{ code, expiresAt, waitToken, appUrl, serverUrl }`
  - `appUrl` = `{serverUrl}/claim?code={code}`
- **`waitForClaimAndSave({ serverUrl, code, waitToken, signal })`** — 循环长轮询，成功后 `writeConfig` 保存绑定信息，返回 `{ botId }`。重试策略：仅 404（认领码已失效）退出循环，其余所有错误（网络超时、HTTP 408/500、TimeoutError 等）延迟后重试，确保后台等待不会因瞬时故障终止

#### 3.3 Gateway RPC 方法

注册 `coclaw.enroll`，供 CLI 通过 RPC 调用：

1. 从 `params?.serverUrl ?? api.pluginConfig?.serverUrl` 解析 serverUrl
2. 调用 `enrollBot()` 获取认领码
3. 立即返回 `{ code, appUrl, expiresAt, expiresMinutes }` 给 CLI
4. 后台 fire-and-forget 调用 `waitForClaimAndSave()`，成功后写 config + 启 bridge

并发控制：gateway 同一时刻只允许一个活跃的 enroll，新请求取消前一个（RPC 与斜杠命令共享同一个 `activeEnrollAbort`）。

#### 3.4 CLI 命令（`cli-registrar.js`）

`bind` 保持不变（`bind <code>`，必填参数）。

新增独立命令 `enroll`：

- 支持 `--server <url>` 选项（开源用户可指定自部署的 server URL），通过 RPC `--params` 传递给 gateway 方法
- 通过 RPC 调用 `coclaw.enroll` 获取认领码
- 输出认领信息（码、链接、有效期）后立即退出
- 仅在判断为 gateway 不可用时（`spawn_error`/`spawn_failed`/`timeout`/`empty_output`/`exit_code_*`）自动重启一次再重试；业务错误不触发重启（见上方重试逻辑）

#### 3.5 斜杠命令（`index.js`）

新增 `/coclaw enroll`（独立于 `/coclaw bind <code>`）：

- 调用 `enrollBot()` → 立即返回认领信息文本
- 后台 fire-and-forget 调用 `waitForClaimAndSave()` → 成功后写 config + 启 bridge

斜杠命令在 gateway 进程内直接执行，不经过 RPC。

#### 3.6 消息文案（`messages.js`）

新增 `claimCodeCreated({ code, appUrl, expiresMinutes })` 函数，输出示例：

```
Claim code: 12345678
Open this URL to complete binding: https://im.coclaw.net/claim?code=12345678
The code expires in 30 minutes.

If you don't have a CoClaw account yet, you can register on that page.
```

### 4. UI

#### 4.1 新路由

```js
{
    path: 'claim',
    name: 'claim',
    component: ClaimPage,
    meta: { requiresAuth: true, hideMobileNav: true },
}
```

#### 4.2 Auth Guard 改进

跳转登录时携带目标 URL：

```js
// 原
return { path: '/login', replace: true };
// 改
return { path: '/login', query: { redirect: to.fullPath }, replace: true };
```

这是通用改进，所有需要登录的页面都受益。

#### 4.3 Login / Register 页面

登录/注册成功后，优先跳转 `redirect` query param 指定的路径：

```js
const redirect = this.$route.query.redirect;
this.$router.replace(redirect || (useEnvStore().screen.ltMd ? '/topics' : '/home'));
```

安全处理：通过 `safeRedirect` 计算属性过滤 redirect 值，拒绝非 `/` 开头的路径和 `//` 协议相对 URL，防止 open redirect 攻击。Login ↔ Register 切换时保留 redirect 参数。

#### 4.4 ClaimPage 组件

- `mounted` 从 `$route.query.code` 读取认领码
- 调用 `POST /api/v1/claws/claim`
- 成功：inline 展示成功状态（图标 + 文本），延迟 1.5s 后自动导航到 `/bots`（组件销毁时清理定时器）
- 失败（已绑定）：显示错误信息 + 引导在 OpenClaw 侧执行 `openclaw coclaw unbind`
- 失败（过期/无效）：显示错误信息 + 引导重新发起

#### 4.5 bots.api.js

新增 `claimBot(code)` → `POST /api/v1/claws/claim`

#### 4.6 i18n

新增 key：`claim.title`、`claim.success`、`claim.expired`、`claim.invalid`、`claim.alreadyBound` 等。

### 5. 安全与边界

| 考虑点 | 处理方式 |
|--------|----------|
| 有效期 | 30 分钟，与绑定码一致 |
| 防猜 | 8 位数字（1 亿种），30 分钟窗口 |
| 公开端点 DoS | MVP 不加 rate limit，后续可补充 |
| 一码一认领 | 认领后立即删除 |
| waitToken | 防止未授权轮询 |
| 已绑定用户认领 | 拒绝，引导先 `openclaw coclaw unbind` |
| Gateway 重启 | 后台等待丢失，认领码仍有效但 token 无法送达；用户可重试 |
| enroll 并发 | gateway 限制同时一个活跃 enroll，新请求取消前一个 |

### 6. 不变更的部分

- 现有绑定码流程（用户发起 `bind <code>`）完全不变
- `POST /api/v1/bots/bind` 端点不变
- 插件配置存储（`~/.openclaw/coclaw/bindings.json`）不变
- Realtime bridge 机制不变

## 已知问题

### 解绑不同步

| 场景 | 表现 | 影响 |
|---|---|---|
| App 侧解绑成功，插件侧未同步（gateway 未运行等） | server 无 Bot → claim 成功 → gateway 写入新 config 覆盖旧的失效 config | 无问题，自然修复 |
| 插件侧解绑成功，server 侧未同步 | server 仍有 Bot → claim 被拒 → 用户困惑 | 属于解绑流程的一致性问题，不在本设计中处理 |

### OpenClaw 命令注册机制隔离

OpenClaw 架构中三种命令注册机制完全隔离：

| 注册方式 | 用户聊天触发 | 用户终端触发 | Agent（LLM）触发 |
|---|---|---|---|
| `registerCommand`（斜杠命令） | `/name` 拦截 | 不能 | **不能** |
| `registerTool`（agent tool） | 不能 | 不能 | **可以** |
| `registerCli`（CLI） | 不能 | `openclaw <cmd>` | **不能** |

当前 enroll 通过斜杠命令和 CLI 注册，agent 无法直接触发。未来支持 agent 自动发起需额外注册 `registerTool`。

## 设计决策记录

| 决策 | 结论 | 理由 |
|------|------|------|
| 数据库表 | 独立 `ClawClaimCode` 表 | 避免 userId null 重载语义，消除耦合 bug 风险 |
| 新表命名 | 使用 `Claw` 而非 `Bot` | Claw 指代 agent 容器，与旧表命名解耦，面向未来兼容 |
| 命令名 | `enroll`（独立于 `bind`） | 语义明确：OpenClaw 向 CoClaw 登记自己；与 bind 无歧义 |
| CLI 架构 | CLI → RPC → gateway 代理 | CLI 快速退出，消除跨进程并发写入，长轮询收敛到 gateway |
| API 路径 | `/api/v1/claws/` | 新旧路径自然分离，旧 `/bots/` 端点不变 |
| 已绑定用户认领 | 拒绝 + 引导解绑 | 与 bind（rebind 语义）区分：enroll 主路径是 agent，不应静默覆盖 |
| enroll 并发 | 同时只允许一个，新请求取消前一个 | 只有一个 default 绑定槽位，多个同时等待无意义 |
| CLI gateway 不可用 | 自动重启一次再重试 | enroll 必须依赖 gateway，单次重启是合理的自动恢复 |
