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

`loginOauth` 是 gateway method，命令行可达（§ 6.13）。CLI `openclaw gateway call coclaw.providerAuth.loginOauth '{"region":"cn"}' --json` 默认**收首帧即返**（`--expect-final` 默认关，专为 agent 留），故脚本能立即拿到并打印 `verificationUri` + `userCode`。流程：脚本调用 → 打印网址 + 码 → **暂停等用户到 `api.minimaxi.com` 授权** → 脚本轮询 `coclaw.providerAuth.list '{"provider":"minimax-portal"}'` 直到出现 oauth profile（带超时）→ 断言 `openclaw.json` 的 `models.providers.minimax-portal.baseUrl` 已写 + gateway 未重启 → **Create-Test-Delete 还原**（`coclaw.providerAuth.remove` 删凭据；provider 配置节点无 CLI 可删，脚本打印手动 `jq` 清理命令，残留无害见 § 6.14）。事件类 CLI 收不到，故验**落盘副作用**而非终态帧。

### 2.4 `coclaw.providerAuth.list`（本期实施；跨认证类型）

**列出所有已绑定的 profile，不限认证类型**——api_key / oauth / token 全部在内。弥补 `models.authStatus` 只列 OAuth/refreshable provider 的坑（mental-model 陷阱 #16）。

#### 协议形状

**入参**：

```ts
{
  provider?: string;     // 可选，按 provider 过滤
}
```

**出参**：

```ts
{
  profiles: Array<{
    profileId: string;             // 如 "groq:default"
    provider: string;              // provider id
    type: 'api_key' | 'oauth' | 'token';
    keyPreview?: string;           // 仅 api_key 模式带；head4 + ... + tail4
    email?: string;                // 仅 oauth 模式（OpenClaw 自带字段）
    displayName?: string;
    expiresAt?: number;            // ms epoch；仅 oauth / 部分 token（详见 § 6.7）
  }>;
}
```

#### 实现要点

1. 调 SDK `ensureAuthProfileStore(agentDir)`（**位置参数**，不是 object params）
2. 遍历 `store.profiles`，按 provider 过滤
3. `key` / `token` 字段**绝对不放进出参**；只输出 `keyPreview = formatApiKeyPreview(cred.key)`
4. OAuth credential 的 access / refresh token 也不外露——只露 email / displayName / expiresAt

#### 与上游 `models auth list` 的关系

上游 CLI 输出更原始（含 raw provider id、按 profile 维度）；本 RPC 是给 CoClaw UI 用的，已经做了遮蔽和裁剪。两者不互相替代——上游 CLI 是开发者诊断用的，本 RPC 是产品 UI 用的。

### 2.5 `coclaw.providerAuth.remove`（本期实施；跨认证类型）

**按 provider 维度一锅端**——清掉该 provider 下的所有 profile（不分 api_key / oauth / token），详见 § 6.8 取舍。

#### 协议形状

**入参**：

```ts
{ provider: string }
```

**出参**：`{}`（成功时空 payload；判断成功失败看协议层标志位，见 § 6.6）。

幂等：撤销不存在的 provider 不报错。

**错误码**：同 setApiKey。

#### 实现要点

1. 调 SDK `removeProviderAuthProfilesWithLock({ provider, agentDir })`（异步，**带文件锁**——与 `upsertAuthProfileWithLock` 共享同一把）
2. **判 null = 失败**：该 helper 同样 `try/catch` 吞错返 `null`，handler 必须 `if (result === null) → IO_FAILED`
3. **不动 cfg.auth.profiles**——见 mental-model § 4.7
4. 同 provider 多 profileId（如 `:default` + `:work`）会一次清干净——上游 helper 内部按 provider 维度删

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
  default: { primary: string | null };
  agents: Record<string, { primary: string | null }>;     // agentId 作 key
}
```

`agents` 是 map（不是数组），形状与 `default` 对称——将来加 `fallbacks` 等字段两边平行扩。

**agents 列表来源**：

- `cfg.agents.list` 里所有合法 entry（id 是非空 string）
- 永远补一条 `main: { primary: null }`（心智模型 § 3.5：main agent 默认存在）；若 cfg 已显式含 main entry 则用其值

`primary: null` 表示该 scope 未覆盖。**只回 raw**——effective primary（per-agent → default → 内置兜底）由 UI 自行解析。

> 📌 **计划（未实施）**：每个 primary 值将加 `usable: boolean | null` 有效性标志，根治 UI 仪表盘分层债（finding #5）+ #4 别名误判。详见 [§ 3.8](#38-计划未实施modellist-输出-usable-有效性标志--catalog-查询别名归一化)。

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
- ❌ effective primary 的**层叠解析**输出（per-agent → default → 内置兜底，由 UI 自解）。注：这里否决的是"哪个 primary 生效"的层叠解析；primary **是否还能用**的有效性布尔（`usable`）是另一回事，计划加入 list 出参，见 § 3.8
- ❌ `@profile` 后缀（modelId 末尾的账号 hint，与 D1 解耦）

### 3.7 扩展路径

- 加 fallbacks：`set({ agentId?, primary?, fallbacks? })` + list 出参每个 value 加 `fallbacks` 字段
- 整删某 agent 的 model 字段：加 `coclaw.model.delete({ agentId })`
- chat / topic 级：完全新命名空间 `coclaw.chat.model.*` / `coclaw.topic.model.*`

### 3.8 计划（未实施）：`model.list` 输出 `usable` 有效性标志 + catalog 查询别名归一化

> 状态：**设计已定，未实施**（2026-05-26）。源自 model-config 发版前 deep-review 的 finding #5 + #4。本节即落地 spec；实施后把内容并入 § 3.3 / § 3.4 出参契约、删除"计划"标注。配套 UI 改动见 `ui/docs/model-config.md` § 7.4。

#### 动机

- **finding #5（分层债）**：UI 仪表盘（`/claws`）为了在外层算"主模型还灵不灵"（橙条引导用），把全量 catalog（`models.list view:"all"`）拉进了**每台 claw 的仪表盘刷新**——违背 UI 侧"低频写、按需读"分层（重数据只该在模型设置子页按需拉、退出销毁）。根因是**有效性判定放在了前端**，而该判定需要全量 catalog 比对，于是被迫把整本目录搬进仪表盘层。
- **finding #4（别名漂移）**：前端 `computePrimaryEffective` 是对插件 `model.set` 写入校验（`handlers.js` 的 `validateProviderCredAndCatalog`）的**重复实现**，两边用 `===` 硬比 provider、都漏了上游 `normalizeProviderId` 折叠别名 → 别名形 provider（如 `moonshotai` vs 规范名 `moonshot`）被误判失效。重复实现必然漂移，#4 即实证。

#### 根治方向

判定**下沉插件侧单一事实源**，`coclaw.model.list` 直接返回有效性布尔；UI 删掉本地判定与全量 catalog 拉取。经 DC 搬给 UI 的从"整本目录"缩成"一个布尔"——P2P/relay 链路上目录 JSON 才是负载大头，是**真减**不是把开销挪个地方。

#### 出参变更（additive，老消费者忽略即可）

每个 primary 值加 `usable` 字段：

```ts
{
  default: { primary: string | null, usable: boolean | null };
  agents: Record<string, { primary: string | null, usable: boolean | null }>;
}
```

- `usable` 三态语义：
  - `true` —— primary 非空，且 provider 有可用凭据，且 model 命中全量 catalog
  - `false` —— primary 非空，但 provider 无凭据 **或** model 不在 catalog（真·失效）
  - `null` —— **判不了**：primary 为 null（无可判）**或** catalog 暂不可用（未知态，见实现要点 3）
- ⚠️ `usable` 与本文档既有 **"effective primary（层叠解析）"是两个不同概念**，勿混：后者指 per-agent → default → 内置兜底解析出"哪个 primary 生效"（仍由 UI 自解，§ 3.6）；`usable` 只回答"这个 primary 现在还能不能用"。**刻意用 `usable` 而非 `effective`** 避免与"effective primary"撞名（最终字段名可由 owner 复核——UI 内部状态现叫 `primaryEffective`，映射即可）。

#### 实现要点

1. 把 `handlers.js` 的 `validateProviderCredAndCatalog`（现返回 error message 或 null）抽成**返回 bool 的 predicate**，`set`（校验拒绝）与 `list`（算 `usable`）**共用同一份判定**——从根上消除前后端两份实现的漂移源。
2. **数据全程进程内，不发 gateway RPC**：靠已注入的两个 SDK 子入口（DI、懒加载）——`buildModelsProviderData`（`openclaw/plugin-sdk/models-provider-runtime`）建 catalog、`isProviderAuthProfileConfigured`（`openclaw/plugin-sdk/provider-auth`）查凭据。核源 `commands-models.ts` 全程读 cfg + `loadModelCatalog` 建内存 Map，不发任何 RPC（`await` 仅因读 catalog 涉文件/注册表 IO）。`list` 现仅 `loadConfig`（纯配置读、不碰 catalog）；改后多**一次** `buildModelsProviderData(cfg, undefined, { view:'all' })`，各 primary 只做 Map 查 + 逐 provider 凭据查（廉价内存操作），相对"把整本目录经 DC 搬给每台 claw"可忽略。
3. **catalog 不可用时不报 `IO_FAILED`**：`buildModelsProviderData` 抛错 / 拿不到时，所有非空 primary 的 `usable` 回 `null`（未知态），`list` 整体**仍成功**——保住"数据拿不到就不显示橙条"的语义（与 UI § 7.2 一致）。`loadConfig` 失败仍是 `IO_FAILED`（不变）。
4. **别名归一化（顺带根治 #4 的插件侧盲点）**：catalog 查询前对 provider 做一次 `normalizeProviderId`。`buildModelsProviderData` 的 `byProvider` map **本就按规范名 key**（核源 `commands-models.ts:110` `normalizeProviderId(p)`），现 `handlers.js:65` 拿**原始** provider 直接 `.get(provider)` 没归一化——这正是 `model.set` 误拒别名形 primary 的根因（写入路径也有此盲点，不只显示层）。归一化后 set/list 两条路径一并治好。`normalizeProviderId` 从 **`openclaw/plugin-sdk/provider-model-shared`** 导入（已核实该子路径 re-export 它；映射只在上游一份，**不在插件复刻**——避免与上游脱节，符合发版求稳/拒投机性复杂度的取舍）。
   - ✅ **凭据校验 `isProviderAuthProfileConfigured` 无需改**：其内部 `resolveProviderIdForAuth` 已做归一化（核源 `agents/auth-profiles/order.ts`）。别名盲点**只在 catalog 查询那一处**，别误改凭据路径。

#### 跨模块顺序与定位

- 按项目规范**先改协议/文档（本节 + UI § 7.4）再改实现**；插件 + UI 两侧均补/改测试（插件覆盖率门槛 branches 95% 其余 100%）。
- 属**设计完善项**（版本已发布，作为后续完善跟进，非发版前热修）。落地前需先把"判不了"（catalog 不可用）契约钉死。

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
