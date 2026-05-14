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
| Provider 认证管理（API key / OAuth / 列表 / 撤销） | **API key + list + remove 本期实施**；OAuth 待设计（下个议题） | § 2 |
| 默认模型设置 | 待设计 | § 3 |
| 白名单 + 模型附加设置 | 待设计 | § 4 |
| 多账号顺序 | 暂不做 | § 5 |

## 设计原则（全局适用）

适用于本文档下所有新增 RPC：

1. **优先 OpenClaw 原生入口**：gateway RPC > runtime API > SDK helper > 手搓。设计前先确认上游有没有现成的；只在没有时才加 `coclaw.*` RPC（见 [feedback-prefer-openclaw-native-apis](../../../docs/openclaw-research/model-config-mental-model.md#附录-c-openclaw-源码定位)）
2. **零 gateway 重启**：禁触发 `cfg.auth.*` / `cfg.models` 等"非 hot-reload 白名单"字段的写入路径（见 mental-model § 4.7）
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
**API key + 列表 + 撤销三个方法本期实施；OAuth 方法占位，下个议题展开。**

### 2.1 协议总览

| RPC | 行为 | 状态 |
|---|---|---|
| `coclaw.providerAuth.setApiKey` | 配 / 替换某 provider 的 API key | **本期实施** |
| `coclaw.providerAuth.loginOauth`（方法名占位） | 启动某 provider 的 OAuth 登录流程（一阶段返回授权信息，二阶段返回完成结果） | 待设计 |
| `coclaw.providerAuth.list` | 列出已绑定的所有 profile（**跨认证类型**，含 api_key / oauth / token） | **本期实施** |
| `coclaw.providerAuth.remove` | 撤销某 provider 的所有 profile（**跨认证类型，一锅端**） | **本期实施** |

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

### 2.3 OAuth 登录（待设计；下个议题展开）

> 占位章节。方法名（暂用 `coclaw.providerAuth.loginOauth`）和 OAuth 流程的协议形状、二阶段响应载荷、device-code 呈现方式等都待下个议题展开。

关键设计点（已确定方向）：

- 是**一个 RPC + 二阶段响应**（accepted 阶段返回授权链接 / device-code，final 阶段返回登录结果），不是两个 RPC 拆 start/complete
- 一期只覆盖 MiniMax；MiniMax 似乎为 OpenClaw 专门提供了 OAuth 方式，待核实是否走 `MINIMAX_OAUTH_MARKER` 特殊路径

占位事项（继承自前期研究）：

- OAuth 凭据由 OpenClaw 自动 refresh（mental-model § 4.4）；CoClaw 不需要自己刷
- OAuth 不可硬复制（refresh_token_reused），所有写入位置只能是 main agent
- OAuth provider 出现在 `models.authStatus`，撤销后须 `{refresh:true}` 强刷
- OAuth 凭据写入是否也"只动 secret 不动 cfg"就够，待核实

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

**出参**：无 payload（成功时 `respond(true, undefined)` 即可；判断成功失败看协议层标志位，见 § 6.6）。

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

## § 3. 默认模型设置（待设计）

> 涉及 `cfg.agents.defaults.model.primary` + `fallbacks`（mental-model § 3）。
>
> ⚠️ 写 `cfg.agents.defaults.model` 也是 hot-reload（mental-model § 4.7 的 reload 规则表里 `agents.defaults.model` 是 hot，不重启 gateway）——这条比 auth 那条幸运。
>
> 待设计的关键问题：
> - per-agent 覆盖（`cfg.agents.list[i].model`）的 UI 入口
> - 与白名单（§ 4）的交互（默认指针引用了白名单没列的模型也照跑，mental-model 陷阱 #1）
> - fallback 链的 UI 展示与编辑

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

子方法采用**扁平命名**（`setApiKey` / `loginOauth` / `list` / `remove`），不按 type 分层（不写 `apiKey.set` / `oauth.start` 形式）。理由：OAuth 是一个 RPC + 二阶段响应，不是 start/complete 两个动作；扁平就够，分层反而增加层级噪音。

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

- 成功时 payload 只承载"成功才有意义的数据"。无数据要返回的 RPC（如 `remove`）用 `respond(true, undefined)`
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

---

## § 7. 引用关系

- mental-model **§ 4.7** —— 只动 secret 不动 cfg 的实测取舍与已知妥协
- mental-model **§ 4.8** —— 遮蔽显示策略
- mental-model **附录 C 凭据段** —— SDK 签名速查
- mental-model **附录 E** —— API key 配置 SOP（代码骨架、踩坑、与上游 CLI 差异）
- mental-model **附录 D** —— provider 清单获取的三处来源对照
- [`gateway-method-conventions.md`](gateway-method-conventions.md) —— 命名 / 错误格式 / scope 约定
- [`plugin-events.md`](plugin-events.md) —— 若未来 setApiKey 之后要广播事件给 server / UI，参考事件清单和 patch 语义

## § 8. 实施 checklist（仅 § 2 API key 部分）

落地时按这条单子检查：

- [ ] 三个 RPC handler 注册位置（建议放 `src/provider-auth/index.js` 或类似新模块）
- [ ] handler 用 `respondError` / `respondInvalid` 不用旧错误格式
- [ ] **成功响应不带 `ok` 字段**——remove 用 `respond(true, undefined)`（§ 6.6）
- [ ] **时间字段用 ms epoch number，命名 `*At`，不加 `Ms` 后缀**（§ 6.7）
- [ ] `agentDir` 走 `claw-paths.js`，不手拼路径
- [ ] list handler 出参不含 `key` / `token` 字段
- [ ] 单元测试：set / list / remove 三个路径 + 错误码 + 短 key 遮蔽降级
- [ ] mental-model § 4.7 提到的"未来若要写 cfg 时的 UX 问题"暂不实现，但代码注释里留 TODO 指向本文档 § 3 / § 5
