# 模型配置 API（插件提供的能力）

> 给未来的 agent：本插件围绕"模型配置/管理"对外提供的所有 gateway RPC 的契约与实现要点。
> 这份是**上游契约**（UI / server 怎么调），不涵盖 UI UX 设计——后者由 UI 工作区按需另写。
> 必读前置：[`docs/openclaw-research/model-config-mental-model.md`](../../../docs/openclaw-research/model-config-mental-model.md)（OpenClaw 上游事实 + CoClaw 凭据写入 SOP）。

## 总体范围

本插件围绕"模型配置"承担两类职责：

1. **包装 OpenClaw 上游能力**——上游有 RPC（如 `models.list`、`models.authStatus`）就直接让 UI 用，不重复包；只在上游没有现成入口或行为不够用时加 `coclaw.*` RPC
2. **写凭据 / 改默认模型 / 维护白名单**——这些是 OpenClaw 没暴露成 gateway RPC 的能力，需要本插件在 gateway 进程内调 SDK helper 完成

涉及的子话题：

| 子话题 | 状态 | 章节 |
|---|---|---|
| provider 清单获取 | 已定（用上游 `models.list view:"all"`） | § 1 |
| Provider 认证管理（API key / OAuth / 列表 / 撤销） | **API key + list + remove + OAuth（MiniMax device-code）已实施** | § 2 |
| 默认模型设置 | **本期实施**（default + per-agent primary） | § 3 |
| 白名单 + 模型附加设置 | 待设计 | § 4 |
| 多账号顺序 | 暂不做 | § 5 |

## 设计原则（全局适用）

适用于本文档下所有新增 RPC：

1. **优先 OpenClaw 原生入口**：gateway RPC > runtime API > SDK helper > 手搓。设计前先确认上游有没有现成的；只在没有时才加 `coclaw.*` RPC（见 [feedback-prefer-openclaw-native-apis](../../../docs/openclaw-research/model-config-mental-model.md#附录-c-openclaw-源码定位)）
2. **零 gateway 重启**：判定按"改了哪条配置路径"逐条来（核源 `openclaw-repo/src/gateway/config-reload-plan.ts`，首次匹配规则）——**禁触发非 hot-reload 路径**（如 `cfg.auth.*`：全表无规则 → 默认全量重启，5-10s 中断；api-key 路径刻意不碰 cfg 正因此，见 mental-model § 4.7）；**hot-reload 路径允许写**（`cfg.models.*`（含 `cfg.models.providers.*`）/ `cfg.agents.defaults.model(s).*`：命中 hot 规则 → 仅毫秒级心跳重启，不掉 gateway / 不断 RTC / chat/run 不中断）。§ 3 默认模型与 § 2.3 OAuth 写的就是 hot 路径
3. **凭据不外流**：原始 API key / OAuth token 绝对不出 gateway 进程边界；UI / server / 远端 log 只能拿到遮蔽串 `keyPreview`（见 mental-model § 4.8）
4. **命名空间 `coclaw.*`**：所有新 method 名遵循 [`gateway-method-conventions.md`](gateway-method-conventions.md) 的命名 / 错误格式 / scope 约定
5. **写凭据走 main agent**：`auth-profiles.json` 的写入对象**永远是 main agent**（`<state-dir>/agents/main/agent/`），所有 agent 通过 OpenClaw 的层叠合并自动可见（见 mental-model § 4.2-4.3）

## § 1. provider 清单获取

**结论**：不加新 RPC，直接用上游 `models.list` + `models.authStatus`。

### 1.1 调用方约定

UI / server 直接通过 OpenClaw gateway 调上游 RPC：

| RPC | 用途 | 注意 |
|---|---|---|
| `models.list` | 拿模型清单（含 provider 字段） | 默认按"已登录"过滤；要全量必须传 `{view:"all"}`（mental-model § 5.4） |
| `models.authStatus` | 拿 OAuth/refreshable provider 的健康状态（含 expiry / usage / plan） | **不列纯 api_key provider**（mental-model 陷阱 #16）；强刷传 `{refresh:true}` |

api_key provider 的"已绑/未绑"状态走 § 2.2 的 `coclaw.providerAuth.list`。

### 1.2 一期决策（mental-model 附录 D）

不做扫盘 manifest 拿全量 provider 清单——`models.list view:"all"` 的 37 个对一期够用。displayName 缺失的在 UI 端建本地英文映射表。

---

## § 2. Provider 认证管理

本节统称"凭据/认证"相关的 RPC，涵盖 API key、OAuth 等所有认证模式。
**API key + 列表 + 撤销 + OAuth（MiniMax device-code）方法均已实施。**

### 2.1 协议总览

| RPC | 行为 | 状态 |
|---|---|---|
| `coclaw.providerAuth.setApiKey` | 配 / 替换某 provider 的 API key | **已实施** |
| `coclaw.providerAuth.loginOauth` | 启动 provider 的 OAuth 登录（**真·两阶段 res**：受理帧返回授权链接 + device-code，终态帧返回登录结果） | **已实施** |
| `coclaw.providerAuth.cancelOauth` | 取消进行中的 OAuth 登录（单发，镜像 `agent.abort`） | **已实施** |
| `coclaw.providerAuth.list` | 列出已绑定的所有 profile（**跨认证类型**，含 api_key / oauth / token） | **已实施** |
| `coclaw.providerAuth.remove` | 撤销某 provider 的所有 profile（**跨认证类型，一锅端**） | **已实施** |

均归 `operator.admin` scope（同 [`gateway-method-conventions.md`](gateway-method-conventions.md) 默认）。

#### 全局约定（本节所有 RPC 适用）

1. **成功响应不带 `ok` 字段**——协议层 `respond(true/false, ...)` 已经携带成功标志，出参 payload 只放成功时才有意义的数据；判断成功失败一律看协议层标志位（详见 § 6.6）
2. **时间字段统一 `number`（ms epoch）**，命名以 `*At` 结尾，不加 `Ms` 后缀。跟随上游 `models.authStatus.expiry.at` / `sessions.list.updatedAt` 等已有约定（详见 § 6.7）
3. **凭据不外流**——原始 API key / OAuth token 绝对不出 gateway 进程边界；UI / server / 远端 log 只能拿到遮蔽串 `keyPreview`（mental-model § 4.8）
4. **写凭据走 main agent**——`auth-profiles.json` 的写入对象永远是 main agent（`<state-dir>/agents/main/agent/`），见 mental-model § 4.2-4.3

### 2.2 `coclaw.providerAuth.setApiKey`（本期实施）

#### 协议形状

**入参**：

```ts
{
  provider: string;      // provider id，如 "groq" / "anthropic"
  apiKey: string;        // 明文 key（仅传输一次，落盘后不返回）
  profileId?: string;    // 可选；缺省 `<provider>:default`
}
```

**出参**：

```ts
{ profileId: string }    // 实际写入的 profileId
```

**错误码**：

| code | 触发 | 说明 |
|---|---|---|
| `INVALID_ARGS` | provider 为空 / apiKey 为空 / 类型错 | 由 `respondInvalid` 抛 |
| `IO_FAILED` | 文件锁竞争 / 磁盘错误 / **SDK 静默返回 null** | 由 `respondError` 抛，message 透传 |

**与已有 profile 的冲突**：profileId 缺省 `<provider>:default`，若该 profileId 已被 OAuth 等其它认证模式占用，**直接顶替**（type 翻成 api_key，原凭据丢失）。设计假设：实际市面上同一个 provider 不会同时提供多种认证方式——OAuth 厂家通常给独立的 provider id，冲突场景不存在（详见 § 6.9）。

#### 实现要点

handler 内部一步走完：

1. 校验 params（`respondInvalid` on bad input）
2. 用 SDK `buildApiKeyCredential(provider, apiKey, undefined, { secretInputMode: 'plaintext' })` 构造凭据对象
3. 调 SDK `upsertAuthProfileWithLock({ profileId, credential, agentDir })`：
   - `profileId`：调用方传的或默认 `<provider>:default`
   - `agentDir`：用 [`claw-paths.js`](../src/claw-paths.js) 的 `mainAgentDir()` 解析（含 `/agent` 子目录）
   - **带文件锁**——与 `removeProviderAuthProfilesWithLock` 共享同一把锁，避免 set + remove 并发丢写
4. **判 null = 失败**：该 helper 内部 `try/catch` 把锁失败 / 磁盘错误**静默吞成 `null`**（不抛异常），handler 必须显式 `if (result === null) → IO_FAILED`
5. **不调** `updateConfig` / `mutateConfigFile`——见 mental-model § 4.7"只动 secret 不动 cfg"
6. `respond(true, { profileId })`

> ⚠️ **为什么不用上层封装 `upsertApiKeyProfile`**：该封装内部走同步、**无锁**的 `upsertAuthProfile`，与带锁的 remove 并发时会绕过文件锁丢写。带锁版 + `buildApiKeyCredential` 的组合与封装内部行为等价（两次幂等的 `normalizeSecretInput` 等于一次），但锁正确。

总代码量 ~20 行，参考 mental-model 附录 E.1 的代码骨架。

### 2.3 OAuth 登录（已实施；MiniMax device-code）

OAuth 登录由**一个两阶段 RPC（`loginOauth`）+ 一个独立取消 RPC（`cancelOauth`）**组成。一期只覆盖 **MiniMax**（默认 `cn` region，亦支持 `global`）。

#### 2.3.1 前提结论（为什么自己复刻 device-code 流）

源码核实（`openclaw-repo`，详见 memory `reference_openclaw_oauth_provider_login_mechanics`）：

- **上游无插件可用的"发起 OAuth 登录"入口**：登录能力是 provider 私有的 auth method（`run(ctx)`，CLI 交互式 prompter 驱动），`openclaw models auth login` 硬要 TTY（`src/commands/models/auth.ts:628`）；plugin-sdk 只暴露**凭据落盘** + **PKCE 工具**，不暴露 provider 注册表 / 登录发起。→ CoClaw 只能自己复刻设备码流（~50 行）。
- **MiniMax 是标准 device-code OAuth，非 OpenClaw 私有**：`POST /oauth/code` 拿 `user_code` + `verification_uri` → 轮询 `POST /oauth/token`（grant_type `urn:ietf:params:oauth:grant-type:user_code`）。端点（cn `https://api.minimaxi.com`）/ client_id（`78257093-...`）/ scope（`group_id profile model.completion`）在 `openclaw-repo/extensions/minimax/oauth.ts` 全是写死值，**复刻并共用同一 client_id**（token 最终要被 OpenClaw 认）。"token plan" 是 MiniMax 产品名，无独立 provider id，凭据 + 配置节点都是 `minimax-portal`（cn auth method `id:"oauth-cn"` / `kind:"device_code"`）。
- **device-code 流无需本机回环回调** → 与 CoClaw"UI 在远端、claw 在内网"天然契合（对比 OpenAI Codex 的 localhost 回环流，远端只能"粘 redirect URL"兜底）。

#### 2.3.2 两阶段机制（搭现成基础设施，三层零改动）

- **plugin 注册的 gateway method 的 `respond` 可多次调用**（非单发）——同一 reqId 先发 accepted 帧、后发终态帧，与上游 agent run 同构。核源：`server-methods/agent.ts` 先 `respond(accepted)`（:1358）、后台 fire-and-forget 再 `respond(final)`（:486/:516）；`server-methods.ts:182-199` 把同一 `respond` 原样传所有 handler（内置 + 插件 `registerGatewayMethod`），**无 already-responded 守卫**。
- **CoClaw 中继按 reqId 通用路由两帧**（`realtime-bridge.js:942-981`，非 agent 专属）：命中 `__dcPendingRequests` 后，`status==='accepted'` 保留路由等下一帧，非 accepted（含无 status）当终态转发 + 清理。
- **UI** `claw-connection.js` `request()` 传 `onAccepted` 即开两阶段（见 [`docs/architecture/gateway-agent-rpc-protocol.md`](../../../docs/architecture/gateway-agent-rpc-protocol.md)）。
- ⚠️ **phase-1 payload 必须带 `status:'accepted'`**，否则中继当终态提前清路由、第二帧丢失。

#### 2.3.3 `coclaw.providerAuth.loginOauth`

> 本节是 **MiniMax / B2** 形态（缺省 `provider` 或 `provider:'minimax-portal'`）。`loginOauth` 同时是路由器：其它 `provider` 走通用 **B1** 设备码驱动，入参/帧形态见 **§ 6.16.8**（两阶段机制、错误码语义两者共用本节 § 2.3.2 / § 2.3.6）。

**入参**：

```ts
{ region?: 'cn' | 'global' }   // 缺省 'cn'；provider 锁 minimax-portal
```

**Phase-1（accepted，立即返回）**：

```ts
{
  status: 'accepted';        // 必带，供中继识别中间态
  loginId: string;           // uuid，供 cancelOauth 关联
  verificationUri: string;   // 让用户打开授权
  userCode: string;          // 让用户输入
  expiresAt: number;         // ms epoch，device-code 过期时刻
  interval: number;          // 建议轮询间隔（ms，下限 2000）
}
```

**Phase-2（final，后台轮询出结果后，同 reqId）**：

- 成功：`respond(true, { status: 'ok', profileId })`
- 失败：`respond(false, { status: 'error' | 'timeout' | 'cancelled' }, { code, message })`

#### 2.3.4 `coclaw.providerAuth.cancelOauth`

**入参**：`{ loginId: string }`　**出参**：`{}`（幂等，未知 loginId 也回 `{}`）

拨掉该 `loginId` 的后台轮询（AbortController）→ 对应 `loginOauth` 的 phase-2 回 `status:'cancelled'`。单发，镜像 `agent.abort`：一次即停，无轮询、无 agent-run 那类限制。

#### 2.3.5 实现要点

`loginOauth` handler：

1. 校验 `region`；生成 PKCE；`POST <cn>/oauth/code` 拿 `user_code` / `verification_uri` / `expired_in` / `interval`（`interval` 规整到 `[2s, 60s]`：非数兜 2s，离谱大值兜 60s）。
2. 注册 `loginId`(uuid) + `AbortController` 进**模块级 registry**（**在 respond accepted 之前**，让紧随其后的 `cancelOauth` 一定找得到）；`respond` phase-1（accepted）；再 **fire-and-forget 启后台轮询循环（必 `.catch`，否则 unhandled rejection 带垮 gateway）**。
3. 后台轮询循环：`POST /oauth/token`，`pending` → sleep `interval` 再轮；`success` / `error` / 到截止 / `signal.aborted` 退出。**截止取服务端 `expired_in` 与本地硬窗口 `MAX_LOGIN_WINDOW`(1h) 的较早者**——服务端给离谱大 `expired_in`（如误用单位）也由本地窗口兜住，循环必定自我终止、phase-2 必 fire，不会永久挂死 / registry 泄漏。`/oauth/token` 的 token 有效期 / `resource_url` 也做类型校验（有效期非有限正数 → token 视为不全；`resource_url` 非字符串 → 丢弃，回落区域默认 baseUrl）。
4. **success**：
   - 用 **`upsertAuthProfileWithLock`** 写 oauth credential `{ type:'oauth', provider:'minimax-portal', access, refresh, expires }`——与 `removeProviderAuthProfilesWithLock` **共享文件锁**；**判 null = IO_FAILED**（同 setApiKey）。**刻意不用 `writeOAuthCredentials`**（它走无锁 `upsertAuthProfile`，与带锁 remove 并发会丢写）。profileId 落 `minimax-portal:default`（MiniMax token 不回 email，与 `writeOAuthCredentials` 的 email→profileName 规则在无 email 时一致）。
   - 再 `mutateConfigFile({ afterWrite:{ mode:'auto' }, mutate })` 写 `models.providers['minimax-portal'] = { baseUrl: result.resourceUrl || <配置默认>, api:'anthropic-messages', authHeader:true, models }`，其中 `models` 取内置静态表 `getPortalModels('minimax-portal')`（含 `{id,name}` + 运行元数据 `reasoning`/`contextWindow`/`maxTokens`，详见 § 2.3.7；**不是空数组**）。`afterWrite:'auto'` → 走 hot 路径**零打断**（见设计原则 #2）；**别传 `{mode:'restart'}`**。`baseUrl` 是每账号登录后服务端动态返回的 `resourceUrl`（缺省回落到配置默认）。⚠️ **配置默认 baseUrl 带 `/anthropic` 后缀**（cn `https://api.minimaxi.com/anthropic`、global `https://api.minimax.io/anthropic`），**区别于 OAuth 端点 base**（cn `https://api.minimaxi.com`，用来拼 `/oauth/code`、`/oauth/token`）——两者不是一回事，核源 `extensions/minimax/provider-registration.ts:29-30`（`DEFAULT_BASE_URL_CN/GLOBAL`）。
   - `respond` phase-2 `{ status:'ok', profileId }`。
5. 终态统一在 `finally` 清 registry 条目；每个终态额外推一条 `remoteLog`（`providerAuth.oauth.{ok|error|timeout|cancelled|io-failed}`，**终态级、低频**）——后台轮询是该家族唯一"终态帧可能凭空消失"（gateway 重启 / RTC 掉线）的操作，半截写（凭据写成功但配置写失败）这类隐蔽态靠它留痕可诊断。
6. **不自动设主模型**——选主模型走既有 `coclaw.model.set`（§ 3），避免越权。

`cancelOauth` handler：registry 查 `loginId` → `abort()`；`respond(true, {})`。

#### 2.3.6 错误码

**phase-1（含 phase-1 之前）单帧错误**：

| code | 触发 |
|---|---|
| `INVALID_ARGS` | `region` 非法 / `loginId` 缺失或类型错 |
| `IO_FAILED` | 设备码请求失败（网络 / HTTP / 响应不全）|

**phase-2 终态失败**：payload 带 `status: 'error' | 'timeout' | 'cancelled'` 区分语义（`error`=授权失败/网络/token 不全，`timeout`=device-code 过期，`cancelled`=被 `cancelOauth` 拨掉）；结构化 `error.code` 随语义给：

| status | error.code | 触发 |
|---|---|---|
| `error` | `OAUTH_FAILED` | 轮询拿到授权失败 / token 不全 |
| `error` | `IO_FAILED` | 写凭据 helper 返 null / `mutateConfigFile` 抛错（成功登录但落盘失败）|
| `timeout` | `OAUTH_TIMEOUT` | 到截止（`expired_in` 与本地硬窗口的较早者）仍未授权 |
| `cancelled` | `OAUTH_CANCELLED` | 被 `cancelOauth` 拨掉 |

UI 用 **payload.status** 做机器判定（成功失败看协议层标志位 + status），`error.code` / `error.message` 供诊断与展示。

> **为什么 phase-2 错误帧带 `payload`（而非 `respond(false, undefined, {code,message})`）**：两阶段终态帧（含 error）携带 `payload.status` 是**刻意**的，镜像上游 agent run 两阶段（`server-methods/agent.ts` 终态走 `respond(false, {runId,status:'error',...}, error)`），CoClaw 中继正是按 `payload.status !== 'accepted'` 路由这两帧。这与单发方法"error 帧只 `respond(false, undefined, {code,message})`"的约定不冲突——带 status 是两阶段协议的一部分，不是历史 status wrap。

#### 2.3.7 关键依赖与边界

- **CoClaw 产出"凭据 + 配置（含模型清单）"**；不重写 provider runtime（推理仍走 OpenClaw 的 `anthropic-messages` provider）。**注意**：OpenClaw 自带 minimax bundled 扩展虽然内置了 minimax-portal 的静态模型清单，但它**只在按 provider 限定范围的 discovery pass 被触发时**才注入 catalog，而该 pass 仅对"默认模型 provider"或"声明了 discovery 入口的插件"在网关启动时跑——minimax 两者都不是，第三方插件也没有 sanctioned 入口去触发它。**结论（已真机核实）：第三方驱动的 minimax-portal 绑定拿不到 bundled 自动注入，模型清单必须由 CoClaw 自己写入**（见下条）。
- **RPC 连接中断不处理**：不追踪 UI 存活，断了 phase-2 帧丢弃无害（凭据可能已落盘，下次 `providerAuth.list` 能看到 `minimax-portal`）。现 RTC 基础设施很难断。
- OAuth 凭据由 OpenClaw 自动 refresh（mental-model § 4.4），CoClaw 不自己刷；不可硬复制（`refresh_token_reused`），写入永远是 main agent（设计原则 #5）；撤销后 `models.authStatus` 须 `{refresh:true}` 强刷。
- **模型清单是模型可用的必要条件**：不写清单则 OpenClaw catalog 中该 provider 名下零模型——UI 选不到、`coclaw.model.set` 报 not-found、agent 用不了（已真机隔离实测确认：官方 bundled minimax 插件的 discovery **不会**把扫码 provider 的清单送进可见 catalog，必须我们写）。清单取自 CoClaw 内置的**静态表** `src/provider-auth/portal-model-catalog.js`（与上游 bundled `MINIMAX_TEXT_MODEL_ORDER` 对齐：`MiniMax-M2.7` + `MiniMax-M2.7-highspeed`），登录成功时写进 provider 节点 `models[]`。每条除 `{id,name}` 外只带**最必须的运行元数据** `reasoning`/`contextWindow`/`maxTokens`（与上游 `model-definitions.ts` 对齐；**不带 `cost`**——portal 走 token plan、不按量计费）。`reasoning` 尤其要写：缺省会被当 false，推理模型被按普通模型处理。
  - **为什么静态而非登录时调 `/models` 拉**：MiniMax 的 `<baseUrl>/models` 用 OAuth token 确实能拉到 7 个模型，但其中 5 个是旧代、用户不需要；且登录拉一次后清单即静态（出新模型需重登才刷新），并不比静态表"更活"。OpenClaw 自己对 minimax 也是写死这两个、手动维护——CoClaw 照抄、负担持平，且甩掉网络拉取 + 旧模型噪音。**MiniMax 升代时手动更新本表。**
  - **启动对账补同步**：清单只在登录那一刻写一次，插件升级后表里补了新模型而老用户不会重新扫码——配置里会停在旧清单。故 gateway 启动时跑一次对账（`src/provider-auth/reconcile.js`，挂在 `index.js` 的 full-mode init bundle）：已绑定时判**配置是否已覆盖内置表的全部模型（只按 model id）**，未覆盖（缺了我们某个 id）才补写整份静态表。**关键：已覆盖就一字不写**——`mutateConfigFile` 无条件写盘，而"写配置"将来万一被上游改成触发重启，无脑每次写会反复重启；先比对、只在缺失时写，能保证即便如此也只重启一次。
    - **为什么是"覆盖"而非"全等"（按 id）**：万一别的来源（如官方 MiniMax 插件）也往同一 provider 写它自己的清单，那通常是含我们这俩 id 的更大清单。全等比对会嫌它"多了几个"→ 每次重启都覆盖回我们这份、和它来回打架。改判"我们的 id 都在就放手"，配置成我们的超集时不动它；name / 其它参数与我们不同也不触发写（模型可用与否由 id 决定）。代价：升级若只改了参数（id 没变），老用户那份不会被刷新——可接受，遵循最小改动。
  - 这条与"零打断 hot-reload"不冲突：`models.providers.*` 仍是 hot 路径（`afterWrite:auto`）。

#### 2.3.8 e2e（人机协同；cn 站授权）

`loginOauth` 是 gateway method，命令行可达（§ 6.13）。CLI `openclaw gateway call coclaw.providerAuth.loginOauth --params '{"region":"cn"}' --json`（**入参走 `--params <json>` 选项、非位置参数**；2026-05-27 在 v2026.5.7 核实，旧位置语法会报 "too many arguments"）默认**收首帧即返**（`--expect-final` 默认关，专为 agent 留），故脚本能立即拿到并打印 `verificationUri` + `userCode`。流程：脚本调用 → 打印网址 + 码 → **暂停等用户到 `api.minimaxi.com` 授权** → 脚本轮询 `coclaw.providerAuth.list '{"provider":"minimax-portal"}'` 直到出现 oauth profile（带超时）→ 断言 `openclaw.json` 的 `models.providers.minimax-portal.baseUrl` 已写 + gateway 未重启 → **Create-Test-Delete 还原**（`coclaw.providerAuth.remove` 删凭据；provider 配置节点无 CLI 可删，脚本打印手动 `jq` 清理命令，残留无害见 § 6.14）。事件类 CLI 收不到，故验**落盘副作用**而非终态帧。

### 2.4 `coclaw.providerAuth.list`（本期实施；跨认证类型 + 跨来源）

**列出所有可见凭据，跨认证类型（api_key / oauth / token）且跨来源（账本 / 内联 / 环境变量）。** 弥补两个坑：① `models.authStatus` 只列 OAuth/refreshable provider（mental-model 陷阱 #16）；② 早期只读账本，漏了用户手写在 `openclaw.json` 的内联 key 与环境变量 key，导致"模型能用却显示没配 key"的列表/引导不一致（陷阱 #22，三源详见 mental-model「provider key 三源」）。

#### 凭据三源（本节核心）

| `source` | 存放位置 | CoClaw 能否撤销 (`removable`) |
|---|---|---|
| `profile` | 自管账本 auth-profiles store（UI `setApiKey` / OAuth 登录写入） | ✅ 走 `removeProviderAuthProfilesWithLock` |
| `inline` | `cfg.models.providers.<id>.apiKey`（用户手写 / OAuth 登录写的节点若带 key） | ✅ 走 `mutateConfigFile` 删 `apiKey` 字段（§ 2.5） |
| `env` | 进程环境变量（`resolveEnvApiKey` 命中） | ❌ 不在配置/账本中，插件无法撤销，仅展示 |

#### 协议形状

**入参**：

```ts
{
  provider?: string;     // 可选，过滤作用于已合并的三源结果；env 候选范围见实现要点 #3
}
```

**出参**（`source` / `removable` 为本次新增，**additive 向后兼容**——旧前端忽略未知字段；旧插件给不出这俩字段，前端按 `source` 缺省 'profile'、`removable` 缺省 true 退化处理，至多漏列内联/env 来源，等价旧行为不回归）：

```ts
{
  profiles: Array<{
    profileId: string;             // 账本来源 = 真实 profileId（如 "groq:default"）；
                                   // 内联/env 来源 = 合成稳定 id "<provider>#inline" / "<provider>#env"
                                   // （保证前端列表 key 唯一：同一 provider 多来源并存时不撞）
    provider: string;              // provider id（账本/内联用其各自原始拼写，env 用解析命中的 provider）
    source: 'profile' | 'inline' | 'env';   // 新增：凭据来源
    removable: boolean;            // 新增：CoClaw 能否撤销（profile/inline=true，env=false）
    type: 'api_key' | 'oauth' | 'token';     // 内联/env 恒为 'api_key'
    keyPreview?: string;           // api_key 模式带；head4 + ... + tail4（内联明文 key 也给；env/`{env}`引用形态可省）
    email?: string;                // 仅 oauth 模式（OpenClaw 自带字段）
    displayName?: string;
    expiresAt?: number;            // ms epoch；仅 oauth / 部分 token（详见 § 6.7）
  }>;
}
```

#### 实现要点

1. **账本来源**：调 SDK `ensureAuthProfileStore(agentDir)`（**位置参数**），遍历 `store.profiles`，按 provider 过滤，`source='profile'`、`removable=true`。
2. **内联来源**：读 cfg（注入 `loadConfig`），遍历 `cfg.models.providers`，`hasConfiguredSecretInput(node.apiKey)` 为真的标 `source='inline'`、`removable=true`。**只看 `apiKey` 字段**——OAuth 登录写的节点（如 `minimax-portal`）没有 `apiKey`，天然不会被误收（§ 6.14）。
3. **env 来源**：对候选 provider 集合跑 `resolveEnvApiKey(provider)`，命中的标 `source='env'`、`removable=false`。候选集 = 账本 ∪ 内联 ∪ 已配主模型的 provider 段（与 model.list 凭据信号的候选口径一致，避免漏报）。**口径外的"纯 env、非账本/内联、又非主模型段"provider 不列出**——即便带 `provider` 过滤也列不出（接受残留：env 既不可撤、又只有支撑主模型时才影响可用性，列出无意义，与 mental-model 同一定调）。
4. **同 provider 多来源并存合法**：如某 provider 账本有 key、内联也有 key → 输出两条不同 `source` 的 entry（如实反映两处各有一份，撤销互不影响）。
5. `key` / `token` 原文**绝对不放进出参**；只输出 `keyPreview = formatApiKeyPreview(...)`。OAuth credential 的 access / refresh token 也不外露——只露 email / displayName / expiresAt。

#### 与上游 `models auth list` 的关系

上游 CLI 输出更原始（含 raw provider id、按 profile 维度）；本 RPC 是给 CoClaw UI 用的，已经做了遮蔽和裁剪。两者不互相替代——上游 CLI 是开发者诊断用的，本 RPC 是产品 UI 用的。

### 2.5 `coclaw.providerAuth.remove`（本期实施；跨认证类型 + 按来源分派）

**撤销某 provider 的凭据，按来源分派**——账本一锅端清 profile（不分 api_key / oauth / token，§ 6.8）；内联删 `apiKey` 字段；env 不可撤销直接拒。

> **账本 vs 内联，撤销语义相反，别混**：
> - **账本（含 OAuth）**：`remove` 即"登出"——只删账本凭据、**不删**登录时写的 `cfg.models.providers` 节点（残留节点无 key、UI 按凭据过滤不可见，§ 6.14）。
> - **内联**：要删的**就是** `cfg.models.providers.<id>.apiKey` 这个字段本身。**只删 key 字段，保留节点其余内容**（`baseUrl` / `api` / `models` 等是用户手写的自定义 provider 定义，删整节点会连带抹掉用户的服务地址 + 内联模型定义，把"没 key"恶化成"模型不存在"）。删 key 后若节点变空 `{}` → 顺手清掉空节点（避免留不合法空壳）。

#### 协议形状

**入参**（`source` 为本次新增可选项，缺省 `'profile'` 兼容旧前端）：

```ts
{
  provider: string;
  source?: 'profile' | 'inline';   // 缺省 'profile'；'env' 非法（见错误码）
}
```

**出参**：`{}`（成功时空 payload；判断成功失败看协议层标志位，见 § 6.6）。

幂等：撤销不存在的凭据不报错（账本无 profile / 内联无该节点或无 apiKey → 视为已撤销，返回成功）。

**错误码**：同 setApiKey；额外 `source:'env'`（或其它非法 source）→ `INVALID_ARGS`（env 来源插件无法撤销，UI 侧本就把 env 行的删除按钮禁用，此为后端兜底）。

#### 实现要点

1. **`source='profile'`（缺省）**：调 SDK `removeProviderAuthProfilesWithLock({ provider, agentDir })`（异步，**带文件锁**——与 `upsertAuthProfileWithLock` 共享同一把）。**判 null = 失败** → `IO_FAILED`。同 provider 多 profileId 一次清干净。**不动 cfg**（mental-model § 4.7）。
2. **`source='inline'`**：走 `mutateConfigFile`（read-modify-write，已为 OAuth 注入），在 `mutate` 回调里：定位 `cfg.models.providers[provider]`（按原始拼写；找不到 → 幂等成功），`delete node.apiKey`；若 `delete` 后 `Object.keys(node).length === 0` → `delete cfg.models.providers[provider]`。`afterWrite:{ mode:'auto' }`（hot 路径零打断，§ 6.14，**不传 restart**）。
3. **`source='env'` 或未知值**：`respondInvalid` → `INVALID_ARGS`，不做任何写。
4. **写完无需 `secrets.reload`**：同 § 2.6，本期无"running channel 立即生效"诉求。

### 2.6 写完后的 cache 行为

- `models.authStatus` 有 60s 缓存——UI 撤回 / 重登后下次读必须传 `{refresh:true}`，但因为 api_key provider 不进 authStatus，本期影响小
- `coclaw.providerAuth.list` 走 SDK `ensureAuthProfileStore`，每次读按 mtime 失效——无需关心 cache 一致性
- 不需要触发 `secrets.reload`——本期没有"已 running channel 立刻用新 key"的场景

---

## § 3. 默认模型设置

**两个 method 一次到位：default scope + per-agent scope，纯兜底**——用户至少有一个可用 model。fallback 链交给用户与 agent 自行配置，CoClaw 不动；模态（image/video/music/pdf）也不动。

### 3.1 协议总览

| RPC | 行为 | 状态 |
|---|---|---|
| `coclaw.model.set` | 设 / 清 default 或某 agent 的 primary | **本期实施** |
| `coclaw.model.list` | 列 default + 所有 agent 的 primary | **本期实施** |

均归 `operator.admin` scope。

写 `cfg.agents.defaults.model.primary` / `cfg.agents.list[i].model.primary` 是 **hot-reload**（mental-model § 4.7 reload 规则表）——毫秒级心跳重启 agent，不掉 gateway、不掉 RTC、chat/run 不中断。锚点：`openclaw-repo/src/gateway/config-reload-plan.ts:81-85`（`agents.defaults.model`）+ `:96-99`（`agents.list[i].model`）。

### 3.2 范畴

- **写**：`cfg.agents.defaults.model.primary`（default scope）+ `cfg.agents.list[i].model.primary`（per-agent scope）
- **不写**：
  - `fallbacks`——交给用户与 agent 沟通来配（自动算容易选错模型，如 provider 的 mini/flash 不是用户期望）
  - 模态字段（`imageModel` / `imageGenerationModel` / `videoGenerationModel` / `musicGenerationModel` / `pdfModel`）——独立 primary+fallbacks 结构，与 D1 解耦
  - `auth.order` profile 顺序
- **不 hook**：setApiKey / removeApiKey 不联动重算 fallbacks

### 3.3 `coclaw.model.set`

**入参**：

```ts
{
  agentId?: string;              // 缺省 = default scope；非空 string = per-agent scope
  primary: string | null;        // 必传；非空 string 为设，null 为清
}
```

**出参**：成功 `{}`（空对象）。

**错误码**：

| code | 触发 |
|---|---|
| `INVALID_ARGS` | params 非 object / array / 未知字段 / agentId 非空 string 检查失败 / primary 缺失或类型错 / primary 形态错（无 `/`、`/` 在端点）/ provider 无可用凭据 / model 不在 catalog |
| `IO_FAILED` | runtime cfg 不可读 / `mutateConfigFile` 抛错 / SDK 校验函数抛错 |

**校验流程（fail-fast）**：

1. params 必须是 object（拒 array、null）
2. 拒未知字段（只允许 `agentId` / `primary`）
3. `agentId` 缺省 OR 非空 string
4. `primary` 必传，类型为 string 或 null
5. 非 null 时：
   - 含 `/`，且 `/` 不在首尾（拆出 `<provider>` + `<model>`）
   - `isProviderAuthProfileConfigured({ provider, cfg, agentDir })` 返回 true
   - `buildModelsProviderData(cfg, undefined, { view: 'all' })` 的 `byProvider.get(provider)?.has(model)` 为 true

注意 catalog 校验用 `view: 'all'`：默认 view 会过滤掉 picker 不可见的合法 provider，导致 false negative（subagent 调研结论）。

**写盘行为**：

- 走 `mutateConfigFile`（last-writer-wins，不传 baseHash）
- **字段级**修改 `primary`，**不整体重写** `model` 对象——保留原有 `fallbacks` / `timeoutMs` 等兄弟字段
- model 字段三态处理：
  - object：`model.primary = newId`
  - string（简写形态）：升级成 `{ primary: newId }`（原 string 本只含 primary 一项语义，无损）
  - 缺省：创建 `{ primary: newId }`

**清除（primary = null）**：

- object 形态：`delete model.primary`；删完后若 model 对象为空 → 整体删 `model` 字段
- string 形态：`delete model` 字段
- per-agent scope 且 entry 不存在 → 静默成功（无写操作）
- 容器（defaults / entry）即便清空也保留，避免影响兄弟字段

**per-agent 新建 entry**：若 `cfg.agents.list` 里没该 agentId，自动 append `{ id, model: { primary } }`——`AgentEntrySchema` 内部所有字段都 optional，最小 entry 合法（核源 `openclaw-repo/src/config/zod-schema.agent-runtime.ts:889`）。

### 3.4 `coclaw.model.list`

**入参**：无

**出参**：

```ts
{
  default: { primary: string | null, providerUsable: boolean };
  agents: Record<string, { primary: string | null, providerUsable: boolean }>;  // agentId 作 key
  hasAnyUsableCredential: boolean;     // 凭据信号（见下）；旧插件不带此字段
}
```

`agents` 是 map（不是数组），形状与 `default` 对称——将来加 `fallbacks` 等字段两边平行扩。

**agents 列表来源**：

- `cfg.agents.list` 里所有合法 entry（id 是非空 string）
- 永远补一条 `main: { primary: null, providerUsable: false }`（心智模型 § 3.5：main agent 默认存在）；若 cfg 已显式含 main entry 则用其值

`primary: null` 表示该 scope 未覆盖。primary **只回 raw**——effective primary（per-agent → default → 内置兜底）由 UI 自行解析。

#### 凭据信号（`providerUsable` / `hasAnyUsableCredential`，简化定稿 2026-05）

为根治"手动配置用户被误报未配 key"（UI 设计 `ui/docs/model-config.md` § 7.4），list 顺带回传凭据判定，**避免新增 RPC**：

- `<scope>.providerUsable`：该 scope 的 primary 那家 provider **有没有可用凭据**。判定 = OpenClaw 现成 `isProviderApiKeyConfigured`（覆盖环境变量 + 自管账本，**provider 旧名归一化由其内部完成、本插件不写别名逻辑**）**或** 该 provider 的配置内联 key 存在（`hasConfiguredSecretInput(cfg.models.providers[…].apiKey)`）。`primary` 为 `null` 时恒 `false`（UI 此时走 noPrimary，不看它）。
- `hasAnyUsableCredential`：这台 claw **有没有任何可用凭据**（自管账本非空 **或** 任一 provider 节点有内联 key）。驱动 UI 的 noKey 引导。

**刻意不覆盖（接受残留，仅影响 CoClaw 之外手动配置的过渡期用户，且现状同样误报 = 非回归）**：纯环境变量且无节点非主模型的 provider、"无 key 也算 authed"的 IAM（aws-sdk / bedrock）与本地无 key 模型、别名拼写零星误判。根因（含"全集判定函数 `hasAuthForModelProvider` 未对插件导出"）见 `docs/openclaw-research/model-config-mental-model.md` 典型陷阱清单。

**旧插件兼容**：旧插件出参无 `hasAnyUsableCredential` 字段，UI 据此 feature-detect → 凭据信号未知则不渲染 noKey / invalid 橙条（宁可少提示不误报）。

**错误码**：仅 `IO_FAILED`（runtime cfg 不可读）。

### 3.5 实现位置

| 文件 | 角色 |
|---|---|
| `src/model-default/resolve.js` | 从 cfg 读 default + per-agent primary 的纯函数（含 list 装配） |
| `src/model-default/persist.js` | 字段级 set / clear 写盘（封装 `mutateConfigFile` 调用） |
| `src/model-default/handlers.js` | set / list handler（入参校验 + 副作用编排） |
| `src/model-default/index.js` | 懒加载 SDK + 注册到 gateway api |
| `index.js`（plugin 入口） | 注入三个 SDK 子入口字面量 `import('openclaw/plugin-sdk/...')` |

### 3.6 不做项（明确否决）

- ❌ fallback 链自动维护（交给用户与 agent 沟通配）
- ❌ hook setApiKey / removeApiKey 联动
- ❌ CoClaw in-process mutex（last-writer-wins 够用）
- ❌ baseHash 乐观锁重试
- ❌ plugin event 失败通知
- ❌ CLI 入口（一期 UI-only；debug 用 `openclaw gateway call coclaw.model.list --json`）
- ❌ effective primary 的**层叠解析**输出（per-agent → default → 内置兜底，由 UI 自解）
- ❌ `@profile` 后缀（modelId 末尾的账号 hint，与 D1 解耦）

### 3.7 扩展路径

- 加 fallbacks：`set({ agentId?, primary?, fallbacks? })` + list 出参每个 value 加 `fallbacks` 字段
- 整删某 agent 的 model 字段：加 `coclaw.model.delete({ agentId })`
- chat / topic 级：完全新命名空间 `coclaw.chat.model.*` / `coclaw.topic.model.*`

---

## § 4. 白名单 + 模型附加设置（待设计）

> 涉及 `cfg.agents.defaults.models[]`（mental-model § 2）+ 给单个模型挂 `alias` / `params` / `agentRuntime` / `streaming` 附加设置。
>
> 写 `cfg.agents.defaults.models` 也是 hot-reload（不重启 gateway）。
>
> 待设计的关键问题：
> - 加自定义模型的 UI 入口
> - alias 命名约束（一期不上 alias，alias 几乎所有解析路径都生效，可能撞上下游）
> - per-model 设置的展示折叠

---

## § 5. 多账号顺序（暂不做）

涉及 `cfg.auth.order[<provider>]`（mental-model § 4.6）。

**暂不做的原因**：

- 一期统一 `<provider>:default`，单 profile 用不上 order
- 写 `cfg.auth.order` 会触发 gateway 全量重启（同 § 4.7 的 auth 写规则），上线前必须先解 UX 问题
- 真正要做时：插件加 `coclaw.providerAuth.setOrder` RPC + UI 端处理 gateway 重启窗口

---

## § 6. 取舍记录

汇总本文档下的关键取舍，每条带"为何"：

### 6.1 命名用 `coclaw.providerAuth.*`，不用 `coclaw.modelAuth.*`

凭据理论上不止服务于"模型 provider"——未来 channel 类的 provider auth 可能也走这套。用更通用的 `providerAuth` 留口子。

子方法采用**扁平命名**（`setApiKey` / `loginOauth` / `cancelOauth` / `list` / `remove`），不按 type 分层（不写 `apiKey.set` / `oauth.start` 形式）。理由：OAuth 登录是一个两阶段 RPC（受理 + 终态），不拆 start/complete；`cancelOauth` 是与登录并列的取消动作（镜像 `agent.abort`），不是登录的"complete"。扁平就够，分层反而增加层级噪音。

### 6.2 API key 配置不写 `cfg.auth.profiles`

见 mental-model § 4.7。三句话总结：

- 写 cfg 触发 gateway 全量重启（5-10s 中断），UI 用户感知为"出错了"
- OpenClaw 所有读写路径只看 `auth-profiles.json`，cfg 那份是冗余镜像
- 已知妥协：弱 LLM 翻 `openclaw.json` 自省"我配了啥"会误答；专业用户翻 cfg 也会困惑——这两件事一期接受

### 6.3 list RPC 出 `keyPreview` 而非完整 key，也不完全隐藏

上游策略是完全不展示；CoClaw 取中间值，给 `head4 + ... + tail4`——让用户在多账号场景能"对眼"识别。

约束：

- 遮蔽在 plugin handler 端做（用 SDK `formatApiKeyPreview`），不下放原始 key 让 UI 自己 mask
- `remoteLog` 绝对不能带 keyPreview / raw key

### 6.4 一期不做 provider key 探活

设 key 之后不主动调 provider API 验证有效性。理由：

- 引入外网调用复杂度（provider 各家协议不同）
- 第一次用模型时自然会 fail，错误信息已经够
- 探活会增加"看似配好实际还在转圈"的 UI 状态

### 6.5 profileId 一期统一 `:default`

多 profile 用 `:work` / `:personal` 可扩展，但一期不上 UI 入口。

### 6.6 成功响应不带 `ok` 字段

OpenClaw 的 RPC 协议层 `respond(true, data)` / `respond(false, undefined, { code, message })` 已经携带成功/失败信号——下游解协议时就拿到了。出参 payload 里再放 `ok: true` 是冗余。

规则：

- 成功时 payload 只承载"成功才有意义的数据"。无数据要返回的 RPC（如 `remove`）用 `respond(true, {})`——**不要用 `respond(true, undefined)`**：上游 CLI `openclaw gateway call --json` 在 data 为 undefined 时会崩 `endsWith` TypeError，空对象占位绕开
- 判断成功失败一律看协议层标志位，不看 payload 里的 ok 字段
- 失败时通过 `respond(false, undefined, { code, message })` 携带结构化错误，不要把 error 塞进 payload

### 6.7 时间字段统一 ms epoch number，不加 `Ms` 后缀

CoClaw RPC 出参里的所有时间字段统一用 `number`（ms since epoch），字段名以 `*At` 结尾（如 `expiresAt` / `updatedAt` / `createdAt`），**不加 `Ms` 后缀**。

理由：

- 跟上游对齐——`models.authStatus.expiry.at` / `sessions.list.updatedAt` / `chat-abort.startedAt` 等上游字段全部是 number ms
- CoClaw 自家既有 RPC（`coclaw.topics.list.createdAt` / `coclaw.chatHistory.list.archivedAt` / `nativeui.sessions.listAll.updatedAt`）也已经是 number ms
- JS 默认 ms，不加 `Ms` 后缀（参考 feedback-ms-suffix-convention）

**与 server 边界的差异**：`coclaw.enroll` 出参的 `expiresAt` 是 ISO 字符串——这是 CoClaw server 透传出来的，server 侧 datetime 字段约定就是 ISO 字符串（见 `binding-wait-hub` / `claim-wait-hub` 等），不视为不一致。本节约定的"ms epoch"作用范围是**插件自有的 `coclaw.*` RPC 出参**；跨 server 边界透传 server 数据时按 server 端格式保持原样，不做转换。

### 6.8 remove 按 provider 一锅端，不按 type 细粒度

`coclaw.providerAuth.remove` 接 `{ provider }`，删该 provider 下所有 profile（不分 api_key / oauth / token）。

理由：

- 用户"撤销该 provider"的心智本来就是粗粒度的"我不要这家了"——不需要按 type 单独剥离
- 实际市面上同一个 provider 不会同时提供多种认证方式（OAuth 厂家通常给独立的 provider id）——一锅端的副作用场景几乎不存在
- 对应 SDK helper `removeProviderAuthProfilesWithLock` 本来就是按 provider 维度删，行为天然对齐

### 6.9 setApiKey 直接顶替已有 profile，不防 OAuth 覆盖

`setApiKey` 默认 profileId `<provider>:default`，若该 profileId 已被 OAuth 等其它认证模式占用，直接顶替（type 翻成 api_key，原凭据丢失）——**不报 CONFLICT，不要求显式 profileId**。

理由（同 6.8）：实际市面上同一个 provider 不会同时提供 API key 和 OAuth 两种方式，冲突场景不存在。加 CONFLICT 检查反而引入不必要的产品复杂度（用户得理解"为什么要先 remove 才能 set"）。

### 6.10 list 出参不带"凭据来源"字段（plaintext vs env）

上游 API key profile 有两种来源：直接落盘明文（plaintext mode）和环境变量引用（env mode，`cred.keyRef` 指向 `$ENV_VAR`）。当前 list 出参对前者输出 `keyPreview`，对后者既不输出 preview 也不标识来源——理论上 UI 看到这条 env-mode profile 无法解释其出处。

**已讨论的取舍**：

- CoClaw UI 的目标用户群是手机 / 桌面端使用 CoClaw 跟 OpenClaw 聊天的最终用户，几乎不会去 shell / docker / systemd 里挂环境变量
- 真去用环境变量配 key 的人是开发者 / 运维，自己在系统层配的条目能认出来源
- 两类人群几乎不交叉——"UI 上看到 env-mode 条目却不知来源"的产品场景几乎不存在

**决定**：不加来源字段。未来若 CoClaw UI 扩展到 admin 视图（管理员能看到系统层 env 配的 profile），再重新评估加 `source: 'plaintext' | 'env'` 或 `keyPreview: '$ENV:VAR_NAME'` 形式的标识。

### 6.11 list 出参不带 createdAt / updatedAt

profile 没有创建时间 / 修改时间。多账号场景下用户看不出哪条最近更新。

**根因**：上游 `auth-profiles.json` 存储就没存这两个字段。CoClaw 要补只能往 credential 的 `metadata` 字典里塞一份（plugin-sdk 的 `buildApiKeyCredential` 第三参数 `metadata?: Record<string,string>` 是公开入口）。

**已讨论的取舍**：

- 本期 profileId 一期统一 `:default`（§ 6.5），单账号场景下"按时间排序 / 区分新旧"无需求
- 真要补必须走 plugin-sdk 公开的 metadata 入口（`buildApiKeyCredential` 第三参数），**禁止绕开 SDK 直接改文件**——一致性由 SDK 负责（参 mental-model § 4.5）
- 字段名规则、上游持久化时会不会清理 metadata、读取端怎么取，C2 真实施时再核实

**决定**：延后。前提是（1）UI 真出现按时间排序 / 显示更新时间的需求；（2）实施前核实 plugin-sdk 对 metadata 的持久化语义。

### 6.12 OAuth 用真·两阶段 res，不用 event 广播

OAuth 终态走 `loginOauth` 同一请求的第二帧 res（§ 2.3.2），**不**另发 `broadcastPluginEvent`。

理由：

- plugin 的 `respond` 可多次调用（核实见 § 2.3.2），真·两阶段成立——曾一度误判为"单发故需 event"，已纠正
- 两阶段更干净：UI 这次调用直接 resolve/reject 拿结果，**单播回发起连接**，不广播给其它 UI（event 版会播给所有 UI DC + 要 UI 按 loginId 过滤）
- 三层（线路 / 中继 / UI）本来就都支持两阶段，零改动

### 6.13 loginOauth 做 gateway method，不像 `coclaw.files.*` 就地处理

DC req 分流按方法名前缀（`webrtc-peer.js`）：`coclaw.files.*` 由插件**就地处理**（不转发 gateway、CLI 不可达），其余转发 gateway。loginOauth/cancelOauth 选**做 gateway method**（转发路径）。

理由：

- 与现有 providerAuth.* 一致；且 gateway method 顺带得**命令行入口** → 人机协同 e2e 简单（§ 2.3.8）
- `coclaw.files.*` 就地是因为文件传输涉二进制 DataChannel、是插件 WebRTC 层独有能力、gateway 无对应方法——那是"没得选"，不是"选了本地"。providerAuth 无此约束
- 代价仅一次本机回环转发（微秒级，可忽略）

### 6.14 OAuth 必写 `cfg.models.providers`（hot-reload，与 api-key 不同）

api-key 路径刻意"只动 secret 不碰 cfg"（§ 6.2）；OAuth **必须**额外写 `cfg.models.providers.minimax-portal`（每账号动态 `baseUrl`，agent 才知去哪请求）。这不违反设计原则 #2——`models.providers.*` 是 **hot-reload 路径**（毫秒级心跳重启，不掉 gateway/RTC/run），与 `auth.*`（全量重启）是两条不同路径。写法用公开 `mutateConfigFile` + `afterWrite:'auto'`（§ 2.3.5）。

> 卸载 CoClaw 后这条 `minimax-portal` 节点会残留——无害（合法 OpenClaw 节点，与用户自己用上游 CLI 登录后果相同），不触发 schema 校验失败（区别于硬约束禁写的 `channels.coclaw` / `plugins.entries`）。

**登出（logout）= 只删凭据，不删此节点**（2026-05-27 实测定案）。曾担心"只删凭据、留着此节点"会在 UI 切模型界面留下"僵尸模型"，实测证伪：UI 主模型选择器拿 `models.list view:all` 的全量 catalog **与 `providerAuth.list`（有凭据的 provider）取交集**，只列两边都有的（见 `ui/src/components/model-config/PrimaryModelPickerDialog.vue` 的 `allowed.has(m.provider)` 过滤）。删凭据后 `minimax-portal` 不在交集里，那 2 个模型即便仍在 catalog 也**不露面**；模型配置页"已配 provider"列同样源自 `providerAuth.list`，该行连同移除按钮一并消失。故现有 `coclaw.providerAuth.remove`（仅删凭据）**对 UI 已是干净登出**，无需新增 logout RPC、无需删此 cfg 节点。反向：删此节点反而越界——无法证明该节点一定是本插件写的（官方 MiniMax 插件可能自己补同名节点），删它有与官方插件来回覆盖之险（与 `reconcile.js` 按 id 子集判覆盖、不硬删别人模型同源）。

### 6.15 写 OAuth 凭据用 `upsertAuthProfileWithLock`，不用 `writeOAuthCredentials`

公开的 `writeOAuthCredentials` 内部走**无锁**同步 `upsertAuthProfile`，与带锁的 `removeProviderAuthProfilesWithLock` 并发会绕锁丢写。改用带锁的 `upsertAuthProfileWithLock` + 手搓 oauth credential——核实该 helper 收 `AuthProfileCredential` 联合类型（含 oauth）直接存盘，落盘结果与 `writeOAuthCredentials` 等价但锁正确（与 § 2.2 setApiKey 的"不用上层封装"取舍同源）。

### 6.16 OAuth 能力扩展到外部 provider（2026-05-27 专项研究结论）

**核心问题**：上游有没有"统一的、插件可用的 OAuth login/logout"，若有则不必逐个 provider 手工复刻登录？**结论：登出有、登录半有半无。**

#### 6.16.1 登出（已统一，且 CoClaw 已在用）

`removeProviderAuthProfilesWithLock({ provider })`（上游 `src/agents/auth-profiles/profiles.ts`）**按 provider 一锅端删凭据，不分认证类型**（oauth / token / api_key 同一路径），CoClaw 现有 `coclaw.providerAuth.remove`（§ 2.5）直接调它——**对任何 provider 都是干净登出**。⚠️ 唯一边界：它**只删本地凭据存档，不发远端 token 吊销网络请求**（厂商侧 token 仍有效到自然过期）。对"UI 登出"语义足够（§ 6.14）。

#### 6.16.2 登录（无现成泛化函数，但有可拼装的接缝）

- **没有** `loginProvider(providerId)` 这类现成泛化入口。plugin-sdk 只 `@deprecated` 导出三个**逐个命名**的登录命令（`loginOpenAICodexOAuth` / `loginChutes` / `githubCopilotLoginCommand`，`src/plugin-sdk/provider-auth-login.ts`），全标"改用 provider 自己的 auth hooks"——押注它们有上游删除风险。
- **但泛化接缝可拼**：`resolvePluginProviders`（`plugin-sdk/provider-catalog-runtime` 子路径导出，注明"供 provider 契约测试"、不在 index.ts）→ 拿 provider 的 `auth: ProviderAuthMethod[]` → 调 `method.run(ctx)`。上游 CLI `openclaw models auth login` 的通用调度（`src/commands/models/auth.ts` resolve → pick method → `method.run`）走的就是这条；CoClaw 理论上可复制。
- **输出侧天然统一、可复用**：`run(ctx)` 返回 `ProviderAuthResult { profiles:[{profileId,credential}], configPatch? }`，**调用方负责落盘**（上游 `persistProviderAuthResult` 写凭据 + 应用 configPatch）——这与 CoClaw 给 MiniMax 的落盘形态**完全一致**（`upsertAuthProfileWithLock` + `mutateConfigFile`）。所以"登录成功后怎么存"对所有 provider 零额外代码。
- **输入侧才是真成本**：`ctx` 是 `ProviderAuthContext`，里面 `runtime`（仅 `{log,error,exit}`，随手造）/ `isRemote` / `openUrl` / `config` / `oauth.createVpsAwareHandlers` 都好供，**唯独 `prompter: WizardPrompter` 是多轮交互**——`run` 自行决定调几次 `prompter.text/select/note/progress`、问什么、什么顺序。CoClaw 现有两阶段 RPC（accepted + final 两帧，§ 2.3.2）**装不下多轮对话**。要走泛化路径，得先搭一条**通用的多轮 prompt-over-RPC 管道**（插件抛 prompt 规格 → UI 渲染 → 用户答 → 喂回 `run` 正在 await 的 prompter → 循环到 resolve）+ UI 侧通用 prompt 渲染器。这是独立的中型工程，不是顺手扩。

#### 6.16.3 provider 登录流普查（决定"值不值得做"和"能不能自己复刻"）

| provider id | 流程 | 远端可行性（UI 公网 / claw 内网） | client_id | 登录是否写 `models.providers.<id>` |
|---|---|---|---|---|
| `minimax-portal` | device-code | **零摩擦** | 写死，可照抄 | **是**（不在内置字典，不写则模型不可用） |
| `github-copilot` | device-code | **零摩擦** | 写死，可照抄 | 否（内置，仅凭据 + defaultModel） |
| `openai-codex`（设备码方法） | device-code | **零摩擦** | 写死，可照抄 | 否（内置，仅凭据 + 别名） |
| `openai-codex`（oauth 方法） | 回环-PKCE | 需用户**贴回 redirect URL** | 写死 | 同上 |
| `chutes` | 回环-PKCE | 需用户**贴回 redirect URL** | **取自 env/凭据，手里没有→不能自己复刻** | 是 |
| `google-gemini-cli` | 回环-PKCE | 需用户**贴回 redirect URL** | **取自 env/本机 gemini-cli 安装→不能自己复刻** | 否 |

两条铁律：① **只有 device-code 那一类对远端零摩擦**；回环-PKCE 类远端只能让用户把授权后浏览器跳转的那条本机地址**整条贴回来**（上游 `createVpsAwareOAuthHandlers` 就是这么兜的），体验明显差。② **Chutes / Google 的 client_id 来自用户本机环境/安装**，CoClaw 手里没有，**MiniMax 式自复刻这条路对它们走不通**，只能走 §6.16.2 的"驱动 `run(ctx)`"泛化路径（连带前述多轮 prompt 管道成本）。

#### 6.16.4 两条扩展策略 + 倾向

- **策略 B（逐个复刻 device-code，= 现有 MiniMax 路子）**：只盯 device-code 阵营（MiniMax 已做、GitHub Copilot、OpenAI Codex 设备码入口），每个 ~50 行，**只依赖厂商稳定 OAuth 端点 + 未废弃的写凭据/写配置 SDK**，远端零摩擦。覆盖不了 Chutes/Google（client_id 拿不到）和回环类，但那些远端体验本就差。**低风险、增量小，推荐优先。**
- **策略 A（搭通用 prompt 管道 + 驱动 `run(ctx)` 通吃）**：覆盖含回环类的所有 provider，但要建多轮 prompt-over-RPC 协议 + UI prompt 渲染器 + 接受回环类贴 URL 体验 + 依赖偏内部/已废弃接缝。**中型独立工程，仅当确需通吃才上。**

#### 6.16.6 device-code 子类：无需多轮管道（2026-05-27 追问核实）

§6.16.2 说的"多轮 prompt-over-RPC 管道"成本**只属于回环/多轮交互类**。**device-code 子类（MiniMax / GitHub Copilot / OpenAI Codex 的 `device-code` 方法）的 `run(ctx)` 是纯输出 + 轮询、零用户输入**——核实 `extensions/openai/openai-codex-device-code.ts` 的 `loginOpenAICodexDeviceCode`（只有 `onVerification` 给 URL+码 / `onProgress`，内部轮询，无 `onPrompt`）+ 其 ctx 包装 `runOpenAICodexDeviceCode`（`openai-codex-provider.ts:403`，只调 `prompter.note`/`prompter.progress`/`runtime.log`，远端连 `openUrl` 都跳过），形态与 MiniMax 完全一致。

故这一子类**用 CoClaw 现有两阶段 RPC（§2.3.2）就装得下**：`run(ctx)` 内 `note(URL+码)` 触发 → 发 phase-1 accepted；`run` resolve → 落盘 + 发 phase-2 final。需要的 prompter 是**输出型桩**（`note`/`progress` 转发或忽略，`text`/`select` 永不被调，可防御性抛错），ctx 其余字段都好造（`runtime={log,error,exit}` / `isRemote=true` / `openUrl` 远端不调 / `config` 取快照）。

另：`openclaw models auth login` 是**纯本地 CLI**（硬要 TTY `src/commands/models/auth.ts:352,628` + clack 终端 prompter + 写盘 `updateConfig`），**不走 gateway RPC**（gateway 事后从盘热加载凭据）。所以"直接 spawn 该 CLI"不干净（TTY 绑定、无头驱动要伪 pty + 抓 stdout，脆）；但其调度模式（resolve provider → `method.run(ctx)`）可在 gateway 内由插件复刻。

→ **device-code 子类的两条统一做法**（这才是用户问的"统一处理这类"的可行答案）：
- **B1 驱动 `run(ctx)`**：`resolvePluginProviders` → 找 provider 的 `auth.find(kind==='device_code')` → 输出型 prompter 驱动 `run(ctx)` → 落盘 `ProviderAuthResult`。一条码路通吃、自动跟随上游。
  - **本质是 in-process SDK 调用，不是 spawn CLI**：`import { resolvePluginProviders } from 'openclaw/plugin-sdk/provider-catalog-runtime'`（**已发布子路径**，与 `config-mutation` 并列在 package exports，满足 loader 字面量扫描）→ `resolvePluginProviders({ config, providerRefs:[id], activate:true, mode:'runtime' })` → 取 provider → `method.run(ctx)`，全程在 gateway 进程内。注入给插件的 runtime **没有**"列已加载 provider + 其 auth 方法"的轻量访问器，`resolvePluginProviders` 是唯一入口。`note()` 回调在 `run` 内**先于轮询**被 await（codex 实测 onVerification 在 poll 前），故能拿它触发 phase-1 accepted、`run` resolve 触发 phase-2 final，时序天然契合两阶段。
  - **对比 spawn CLI（`openclaw models auth login`）：劣，不取**——CLI 硬要 TTY（须分配伪 pty）、要抓子进程 stdout 找 URL/码 + 判完成、且它自己写盘拿不到结构化 `ProviderAuthResult`。in-process 严格更优。
  - **设计定则：只认"含码的单个 auth-url"，要单独输码的 provider 不支持**（2026-05-27 用户拍，永久边界，免日后再纠结 OAuth 码）。device-code 流标准是 `verification_uri`（裸）+ 独立 `user_code`，但部分服务端把码塞进 URL（`verification_uri_complete` 语义）。CoClaw **只从输出里正则抠出一个 URL 交给用户打开**，不解析、不回传 `user_code`。后果（实测）：**MiniMax 的 `verification_uri` 服务端已含码 → 支持**；**OpenAI Codex 设备码（`auth.openai.com/codex/device` 裸 URL + 独立码）/ GitHub Copilot 设备码（`github.com/login/device` + 独立码）→ 不含码 → 本定则下不支持**。即 B1 + 本定则**当前只覆盖"自带完整 URL"的 provider（恰是已支持的 MiniMax），对 codex/copilot 不增量**；价值是前向——任何"URL 自带码"的 device-code provider 零适配自动可用。**这把"码软肋"彻底消除**（只抠 URL，正则极稳）。
  - **澄清 codex 两方法 + "点一次即完"记忆的归属（2026-05-27 fork 核实）**：codex 注册**两个** auth 方法（`openai-codex-provider.ts:483,497`）——`oauth`（kind `oauth`，**回环-PKCE**）与 `device-code`（kind `device_code`）。用户记得的"CLI 只给一个 URL、点开授权完、不输任何东西"是**前者（回环 `oauth` 方法）**，不是 device-code。该方法建**一个自包含 authorize URL**（`auth.openai.com/oauth/authorize?...redirect_uri=http://localhost:1455/auth/callback&scope=...`，`openai-codex-oauth.runtime.ts:13`）、**全程无 `user_code`**；本地靠 `localhost:1455` 回调监听自动接住跳转即完成，故用户什么都不输。"函数单独给码、CLI 拼进 URL"的猜测**不成立**——URL 从一开始就自包含（流程里的 "code" 是授权后回跳带回的 *authorization code*，非在 OpenAI 页面手输）。**"点一次即完"成立的前提是 browser 与 claw 同物理机**（核实 `isRemoteEnvironment()` `src/infra/remote-env.ts`：**显式把 WSL 判为非 remote** `... && !isWSLEnv()`）：用户在 WSL2 终端跑 login（无 SSH）→ 走 **local 模式**、在 WSL2 内起 `localhost:1455` 监听、不提示粘贴；Windows 浏览器授权后回跳 `http://localhost:1455/auth/callback` 被该监听接住（**WSL2 默认与 Windows 共享 localhost**）→ 只见一个 URL、点开即完。**它就是 localhost:1455 回环流，只是同主机透明跑通。** **但真·远端破功**：UI 在手机/公网、claw 在另一台 → 手机回跳 `localhost:1455` 打到手机自己、claw 收不到；且 claw 若 SSH-headless/非 WSL Linux，`isRemoteEnvironment()` 返回 true，OpenClaw 自身就切到 `createManualCodeInputHandler`（`provider-openai-codex-oauth.ts:86-92`）**必然**提示 "Paste the authorization code (or full redirect URL)" → 用户得把回跳 URL **贴回来**（**两腿**：给 authorize URL → 授权后贴回 redirect URL，超出 accepted+final 两阶段）。**结论**：codex 两方法在**真·远端**都给不出"单个自包含 URL 点一次即完"——device-code 裸 URL+独立码、oauth 自包含 URL 但需贴回——故 codex 本定则下不入。**用户 WSL2+Windows 的"点一次即完"记忆完全准确，只是同主机透明跑通、不迁移到真·远端。**
  - **codex `localhost:1455` 是否"我们参数没给对"导致——已坐实：不是，且改参数也没用（2026-05-27 code 核实）**：真正驱动 OAuth 的是底层库 `@mariozechner/pi-ai` 的 `loginOpenAICodex`（`dist/utils/oauth/openai-codex.js`）。其中 `client_id`（`app_EMoamEEZ73f0CkXaXp7hrann`，即 OpenAI 官方 Codex CLI 的公开客户端）、`redirect_uri`（`http://localhost:1455/auth/callback`）、authorize/token 端点**全是该库写死的常量**，构造 authorize URL（`createAuthorizationFlow`）只动态填 `state`/`code_challenge`/`originator`。**OpenClaw 调用侧（`openai-codex-oauth.runtime.ts:324`）只传 `onAuth`/`onPrompt`/`originator`/`onManualCodeInput`/`onProgress` 这几个回调，根本没有 `redirect_uri`/`client_id` 入参**——"参数没给对"无从谈起（没这个参数）。更关键：换 redirect 也过不了关——OAuth 要求 authorize 与 token 交换两处 redirect_uri 一致、且**必须是 OpenAI 为该 client_id 服务端预注册的白名单值**（这是 OpenAI 对其官方 Codex 客户端的硬约束，非 OpenClaw 的选择）；填别的地址（如 CoClaw 域名）authorize 端点会在用户登录前就 `redirect_uri mismatch` 拒掉。想换地址只能自注册 OpenAI OAuth 应用，但自注册的拿不到 ChatGPT Plus/Pro 的 Codex 订阅授权（那是 OpenAI 官方客户端专属），等于换不动。
  - **URL 那两个 flag 不是 redirect 开关**：`codex_cli_simplified_flow=true`/`id_token_add_organizations=true` 是 pi-ai 写死的同意页/token claim 控制；`originator=openclaw` 是 OpenClaw 唯一注入的、纯品牌/遥测标识。**都不改变回调走 localhost**，也没有可切到 out-of-band（贴码）redirect 模式的旋钮。
  - **唯一的 env 旋钮 `PI_OAUTH_CALLBACK_HOST`（默认 `127.0.0.1`）只改本地监听绑定的网卡**，**不改发给 OpenAI 的 redirect_uri 字符串（仍 `localhost:1455`），也不改端口 1455**。对真·远端无用：浏览器在用户那台、回跳打到浏览器自己的 `localhost:1455`，claw 绑哪张网卡都接不到。
  - **即便假设能换 redirect**：授权发生在用户远端浏览器，回跳要落到 CoClaw 能接住的地方才有用；若落到 CoClaw server 就成"server 中介 OAuth"，违反"server 不在数据通路"（见 mental-model / 通信架构），是另一套更重的设计。此点纯属推演——前面已证 redirect 改不动，moot。
  - **收口**：codex 回环 `localhost` 是 OpenAI 对其官方 client 的强制白名单 + pi-ai 写死的结果，**与 CoClaw/OpenClaw 调用参数无关，"修参数"无法让它不走 localhost**。回到既有结论：codex 真·远端绕不开"贴回 redirect URL"（或本定则下不支持）。§6.16.6 前述"强假设（待证）"现升级为**已证实**。
  - **残余风险（剩两处）**：① `resolvePluginProviders` 是**加载器**（带 `activate`/`cache`，可能重载 provider 模块），在已运行 gateway 内调用的重入/重复加载需实施期验证，非零成本；② 接缝头注"供 provider 契约测试"——但它**已在 package exports 公开发布、且未标 @deprecated**（区别于 `provider-auth-login` 的三个登录命令是显式 `@deprecated`；**B1 走的是非废弃的 catalog-runtime 接缝，不碰那三个废弃命令**）。按"plugin-sdk 公开导出即相对稳定契约、变了再跟"对待即可。**版本下限：该子路径自 OpenClaw `v2026.4.27` 引入**（`resolvePluginProviders` 本体更早 2026-03-22，但公开子路径是 4.27）；CoClaw 若用，gateway 须 ≥ v2026.4.27。输出型 prompter 若被意外调 `text/select` 应防御性抛错（安全显错，接某家时即暴露）。
- **B2 一个通用 device-code 引擎 + 每 provider 小描述符**（`{clientId, deviceAuthEndpoint, tokenEndpoint, scope, grantType, configPatch}`）：结构化拿 URL+码（不解析字符串），只依赖稳定端点 + 未废弃的写凭据 SDK；client_id 这三家都写死可抄。代价：grant_type / 字段名各家有小差异（MiniMax `...:user_code` vs codex/copilot `...:device_code`；codex `user_code`/`usercode` 兼容），描述符要带 per-provider 适配。**比 B1 稳、无字符串解析与废弃接缝依赖，推荐。**

#### 6.16.5 UI 放开撤销的口径（可放宽）

原"CoClaw 能往返（既登录又登出）的才放"是过度保守——**登出对任何有凭据的 provider 都安全可用**（§ 6.16.1）。UI 放开 oauth 撤销**不必等登录扩展**，按"有凭据即可撤销"放即可（仅记得它不发远端吊销）。

> 为什么 `minimax-portal` / `chutes` 必须写 `cfg.models.providers`、而 `openai-codex` / `github-copilot` / `google-gemini-cli` 不用写：前两者不在 OpenClaw 内置 provider 字典里（登录不写则 catalog 为空、模型不可用），后三者是 bundled provider、模型清单自带——根因与三处来源对照见 mental-model § 5.2 / 附录 D / F.4-F.5。

#### 6.16.7 范围调整：定则放宽到"设备码家族"（2026-05-27 用户拍，覆盖 §6.16.6 旧定则）

旧定则（§6.16.6"只认含码的单个 auth-url、要单独输码的不支持"）**作废**。新边界：**支持整个"设备码家族"**——凡"亮出信息（URL[+独立短码]）+ 后台轮询、用户输入只发生在 provider 官网、零回传 CoClaw"的流程都纳入，不论码是否嵌在 URL 里。**回环/贴回类仍不在内**（需把授权后回跳的 redirect URL 整条贴回 = 多轮交互，超出两阶段 RPC）。

三层全景：

| 层 | 流程 | 是否纳入 | provider |
|---|---|---|---|
| 1 | 码已在 verification URL 里 | ✅ 已做 | `minimax-portal` |
| 2 | 设备码 + 独立短码（敲进 provider 官网） | ✅ **本轮接** | `openai-codex` 的 `device-code` 方法、`github-copilot` |
| 3 | 回环-PKCE，远端需贴回 redirect URL | ❌ 重，搁置 | `openai-codex` 的 `oauth` 方法、`google-gemini-cli`、`chutes` |

**关键认知（为何第 2 层不难）**：设备码流程里那串码是用户敲进 **provider 官网**的，**从不回传 CoClaw**。CoClaw 侧仍是"亮信息 + 后台等"，只是亮"URL + 码"两样、不是一样——**套得进现有两阶段 RPC（§2.3.2），无需多轮 prompt 管道**（那条成本只属第 3 层）。走 B2（自建设备码引擎 + per-provider 描述符）时直接拿结构化 `{user_code, verification_uri}`，**无字符串抠码**——旧定则要消除的"抠码软肋"在 B2 下本就不存在，故放宽定则不会把它带回来。

**本轮范围（已拍）：`openai-codex`（device-code 方法）+ `github-copilot`**。两家 client_id 均写死可抄、端点稳定、**全程不碰 localhost**：
- **codex device-code**（`extensions/openai/openai-codex-device-code.ts`）：client_id `app_EMoamEEZ73f0CkXaXp7hrann`；usercode 端点 `auth.openai.com/api/accounts/deviceauth/usercode`、轮询 `.../deviceauth/token`、换 token `auth.openai.com/oauth/token`；redirect_uri 是 **OpenAI 自家 `auth.openai.com/deviceauth/callback`（非 localhost）**。**流程两步**：轮询先拿 `{authorization_code, code_verifier}`，再 `/oauth/token` 换 access/refresh——比 copilot/minimax（轮询直出 token）多一步，B2 引擎须兼容两形态。verification URL = 裸 `auth.openai.com/codex/device`、user_code 独立。method id = `device-code`。
- **github-copilot**（`extensions/github-copilot/login.ts`）：标准 RFC 8628，client_id `Iv1.b507a08c87ecfe98` 写死，轮询 `github.com/login/oauth/access_token`（`grant_type=urn:ietf:params:oauth:grant-type:device_code`）直出 token，最简单。verification URL = 裸 `github.com/login/device`、user_code 独立。

**Gemini 搁置（两堵墙，验证于 `extensions/google/`）**：① 回环-PKCE（`oauth.shared.ts` `REDIRECT_URI=http://localhost:8085/oauth2callback` 写死），远端必须贴回 → 需第 3 层多轮管道；② **client_id/secret 无写死**——`resolveOAuthClientConfig`（`oauth.credentials.ts`）从 env（`OPENCLAW_GEMINI_OAUTH_CLIENT_ID`/`GEMINI_CLI_OAUTH_CLIENT_ID`）或**用户本机 gemini-cli 安装里抠** `*.apps.googleusercontent.com`，否则抛 "Gemini CLI not found"；CoClaw 服务器两者皆无。→ 非"顺手加"，是中型工程 + 未解凭据难题。

**anthropic 出局**：用户告知 Anthropic 已封禁 openclaw 等第三方用 OAuth 登录；本版 OpenClaw 也未注册 anthropic 的 provider auth 方法（pi-ai 库 `dist/utils/oauth/anthropic.js` 虽有实现，但无登录入口）。确认不做。

**实测结论（2026-05-27 用户实测，gate 已过）**：codex device-code **可用、障碍可接受**。真实 UX = 开 `auth.openai.com/codex/device` 页面 + 敲短码 + 同意；**首次需在 ChatGPT 里打开"codex 设备码启用"开关**（旧记忆"要翻设置"属实），但**该验证页内直接有进设置的链接，点过去开一次即可、一次性**。账号未被服务端挡（成功授权）。→ **codex + copilot 本轮均开工。**

#### 6.16.8 实施决定与落地（2026-05-27，插件后端）

**选 B1（驱动上游 `run`），不手写 B2** —— 覆盖 §6.16.4/§6.16.6 里"推荐 B2"的研究期倾向。决定理由：用户核心诉求是**不自己手写复刻各家登录、跟随上游同步**（HTTP / 端点 / 轮询 / 两步换 token 全交 provider 插件）。B1 唯一命门"验证信息只能从 `prompter.note` 文本正则抠"已用充分容错化解：抠不到不报错，**把 note 全文作为 `rawText` 字段一并返回，交前端判断渲染**。

**不针对 codex/copilot 硬编码**：入口 `coclaw.providerAuth.loginOauth` 加 `provider` 参数路由——`minimax-portal`（或缺省，向后兼容）走原 B2 自家流；**其它任何暴露了 `kind:'device_code'` auth 方法的 provider 自动走通用 B1 驱动**。后续 OpenClaw 新增 device-code provider 零适配自动可用。回环/贴回类（`kind:'oauth'`）天然不被选中（B1 只找 `device_code` 方法），codex 的 `oauth` 方法因此自动排除。

**B1 变体的 I/O 形态**（两阶段机制 / 错误码语义共用 § 2.3.2 / § 2.3.6；与 § 2.3.3 MiniMax 形态的差异在字段）：

```ts
// 入参（provider 必填、非空串；空串/非串 → INVALID_ARGS 单帧）
{ provider: string }

// Phase-1（accepted）：结构化字段抠不到给 null，rawText 永远带全文交前端兜底
{
  status: 'accepted';
  loginId: string;
  provider: string;
  verificationUri: string | null;   // 抠不到给 null
  userCode: string | null;          // 抠不到给 null
  rawText: string;                  // note 全文，前端兜底渲染
  // 注意：无 expiresAt / interval（上游 run 内部自管轮询，不暴露给本通道）
}

// Phase-2（final，同 reqId）
// 成功：respond(true, { status:'ok', provider, profileIds: string[] })
// 失败：respond(false, { status:'error'|'cancelled' }, { code, message })
//   code：run reject / 空 profiles → OAUTH_FAILED；写凭据返 null / configPatch 写盘抛错 → IO_FAILED；取消 → OAUTH_CANCELLED
// provider 无 device_code 方法 / loader 异常 / config 读取异常 → 单帧（payload undefined）NOT_FOUND / IO_FAILED
```

**落地要点**：
- 入口经 `provider-catalog-runtime` 子路径的 `resolvePluginProviders` 拿 provider 的 auth 方法；**一律 `activate:false`**（只读拿 `method.run`，不激活 provider → 零副作用，不动 gateway 活跃插件名册，已实测钉死）。
- 用"输出型捕获 prompter"驱动 `run(ctx)`：`note` → 触发 phase-1 accepted；`progress` 空操作；`confirm` 答 true（copilot 已登录重登放行）；`text`/`select`/`createVpsAwareHandlers` 被调即抛（= 需交互、本通道不支持，经 run reject 暴露）。`isRemote:true`、`openUrl` 空操作。
- 时序：`run` 内 `note(URL+码)` 先于轮询 → 抠 URL/码 + rawText → phase-1 accepted；`run` resolve → 校验 `profiles` 非空（空 = 失败，上游把中途失败吞成空）→ 写凭据 + 有 `configPatch` 就深合并进 cfg（hot-reload）→ phase-2 final。reject / 空 profiles → phase-2 error；note 之前就失败 → 单帧错误。
- 取消：`run` 无 abort 钩子，停不掉上游后台轮询；`cancelOauth` 只 abort 信号，`run` 到期自己 settle 时识别 aborted → 回 cancelled 终态、不写凭据（终态必达 + 清理）。
- **落盘只做"写凭据 + 应用 configPatch"**，不复制上游 CLI 的 `applyAuthProfileConfig` / `promoteAuthProfileInOrder` / `applyDefaultModel`（设默认模型走独立的 `coclaw.model.set`）；凭据写进 auth-profiles store 即被 `providerAuth.list` ∩ catalog 的模型选择器认出（凭据三源之一，agent 运行时自动解析）。

**MiniMax 仍走 B2**：它不在 OpenClaw 内置 provider 字典，登录后还要补写 `models.providers` 静态模型清单（上游对 portal 不做 catalog discovery），与 codex/copilot"内置、模型自带"不同——并入 B1 会因 configPatch 写空 `models:[]` 静默回归（见 [`reference_minimax_portal_oauth_model_catalog`]）。

**本轮范围 = 插件后端**。UI（白名单放开撤销 + 扫码展示流 + `rawText` 兜底渲染）另起一轮——当前 UI 尚无任何扫码登录展示流。

---

## § 7. 引用关系

- mental-model **§ 4.7** —— 只动 secret 不动 cfg 的实测取舍与已知妥协
- mental-model **§ 4.8** —— 遮蔽显示策略
- mental-model **附录 C 凭据段** —— SDK 签名速查
- mental-model **附录 E** —— API key 配置 SOP（代码骨架、踩坑、与上游 CLI 差异）
- mental-model **附录 D** —— provider 清单获取的三处来源对照
- [`gateway-method-conventions.md`](gateway-method-conventions.md) —— 命名 / 错误格式 / scope 约定
- [`plugin-events.md`](plugin-events.md) —— 若未来 setApiKey 之后要广播事件给 server / UI，参考事件清单和 patch 语义
- [`docs/architecture/gateway-agent-rpc-protocol.md`](../../../docs/architecture/gateway-agent-rpc-protocol.md) —— 两阶段 res 协议（§ 2.3 OAuth 复用同一机制）
- `openclaw-repo/extensions/minimax/oauth.ts` —— device-code 流复刻源（端点 / client_id / scope / 轮询语义）

## § 8. 实施 checklist

### 8.1 § 2 API key 部分（已实施）

- [x] 三个 RPC handler 注册位置（建议放 `src/provider-auth/index.js` 或类似新模块）
- [x] handler error 响应符合协议层错误形态（`respond(false, undefined, { code, message })`），错误码用本节约定的 `INVALID_ARGS` / `IO_FAILED`；helper 名不强制（模块自带局部 helper 也行）
- [x] **成功响应不带 `ok` 字段**——空响应用 `respond(true, {})`（§ 6.6）
- [x] **时间字段用 ms epoch number，命名 `*At`，不加 `Ms` 后缀**（§ 6.7）
- [x] `agentDir` 走 `claw-paths.js`，不手拼路径
- [x] list handler 出参不含 `key` / `token` 字段
- [x] 单元测试：set / list / remove 三个路径 + 错误码 + 短 key 遮蔽降级

### 8.2 § 2.3 OAuth 部分（已实施）

- [x] 新增 `src/provider-auth/minimax-oauth.js`：复刻 device-code 流（PKCE → `/oauth/code` → 轮询 `/oauth/token`），**注入式 `fetch` + 可配 baseUrl**（单测免网、e2e 不误触 global）；端点/client_id/scope 抄 `openclaw-repo/extensions/minimax/oauth.ts`，cn 默认
- [x] 新增 `src/provider-auth/oauth-registry.js`：模块级 `Map<loginId, { abortController, ... }>`（link-safe 单例，同一模块由 index.js 同次 register 注册）
- [x] 扩 `src/provider-auth/handlers.js`：`handleLoginOauth`（两阶段：respond accepted + 后台轮询 fire-and-forget 必 `.catch` + 终态 respond）/ `handleCancelOauth`
- [x] `index.js`：full 模式注册 `coclaw.providerAuth.loginOauth` / `cancelOauth`；**顶部加裸字面量 `import('openclaw/plugin-sdk/config-mutation')`**（loader 只扫入口源码字面量，与现有 `provider-auth` 同处）
- [x] phase-1 payload **带 `status:'accepted'`**（否则中继提前清路由，§ 2.3.2）
- [x] 写凭据用带锁 `upsertAuthProfileWithLock`（§ 6.15），判 null = IO_FAILED
- [x] 写配置用 `mutateConfigFile({ afterWrite:{ mode:'auto' } })`，**不传 restart**（§ 6.14）
- [x] 后台轮询以 `expired_in` 为自身超时；终态 `finally` 清 registry
- [x] 单元测试：注入 fetch mock 覆盖 code/token 各分支（pending / success / error / 超时 / abort）+ phase-1 payload + 轮询状态机 + 写凭据共享锁 + `mutateConfigFile` 调用形参 + 错误码；覆盖率维持门槛（lines/fn/stmt 100%、branches 95%）
- [x] e2e：`scripts/oauth-e2e-verify.sh`（人机协同，§ 2.3.8）

### 8.3 § 6.16.8 通用 device-code 登录（B1，插件后端已实施）

- [x] `device-code-login.js`：纯 helper（`isVerificationNote` 含 URL 且非帮助/FAQ 文案、`extractVerification` URL/Code 行优先+回退抠不到给 null、`findDeviceCodeMethod` 选 `kind:'device_code'`、`makeDeviceCodeCtx` 输出型捕获 ctx）
- [x] `handlers.js`：`loginOauth` 按 `provider` 路由（minimax-portal/缺省 → B2，其它 → B1）；**provider 给了但非空串 → INVALID_ARGS 边界挡掉**；`loginOauthDeviceCode` 驱动 `run(ctx)` 两阶段；`persistDeviceCodeSuccess` 写凭据 + 深合并 configPatch；空 profiles/reject/note 前失败/取消各自终态
- [x] `index.js`（子模块）：惰性注入 `resolveProviders`（`resolvePluginProviders`，`activate:false`）+ 默认 `resolveConfig=getClawConfig`；catalog-runtime 独立惰性加载，不耦合进 setApiKey/list/remove 的 getHandlers
- [x] `index.js`（入口）：加字面量 `import('openclaw/plugin-sdk/provider-catalog-runtime')` 供 loader 扫描
- [x] `utils/deep-merge.js`：configPatch 深合并（plain object 递归、其余覆盖、原型污染键跳过）
- [x] 抠取**充分容错**：URL/码抠不到不报错，phase-1 accepted 永远带 `rawText` 全文交前端
- [x] 单元测试：B1 成功（accepted 结构化字段+rawText / 写凭据 / configPatch 深合并）/ 空 profiles / reject / note 前失败单帧 / 无 note 成功单帧 / 取消不写 / 无 device_code 方法 NOT_FOUND / resolveProviders 抛错 / 写凭据 null / mutateConfigFile 抛错 / config 来源 / note 过滤 + 抠不到给 null；覆盖率达门槛
- [x] 真 gateway 实测：copilot device-code 拿到真实 `github.com/login/device` + 码、phase-1 accepted；deepseek（无 device_code）→ NOT_FOUND；`cancelOauth` 取消后不写凭据；`activate:false` 零副作用
- [ ] UI：放开 oauth 撤销 + 扫码展示流 + `rawText` 兜底渲染（另起一轮）
