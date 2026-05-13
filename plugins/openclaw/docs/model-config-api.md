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
| API key 配置 | **本期实施** | § 2 |
| OAuth 配置 | 待设计（下个议题） | § 3 |
| 默认模型设置 | 待设计 | § 4 |
| 白名单 + 模型附加设置 | 待设计 | § 5 |
| 多账号顺序 | 暂不做 | § 6 |

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

## § 2. API key 配置（本期实施）

### 2.1 协议总览

加三个 `coclaw.providerAuth.*` RPC：

| RPC | 行为 | 出参核心字段 |
|---|---|---|
| `coclaw.providerAuth.setApiKey` | 配 / 替换某 provider 的 API key | `{ profileId }` |
| `coclaw.providerAuth.list` | 列出已绑定的 api_key profile（弥补 `models.authStatus` 不列 api_key 的坑） | `{ profiles: [{ profileId, provider, type, keyPreview, ... }] }` |
| `coclaw.providerAuth.remove` | 撤销某 provider 的所有 profile | `{ ok: true }` |

均归 `operator.admin` scope（同 [`gateway-method-conventions.md`](gateway-method-conventions.md) 默认）。

### 2.2 `coclaw.providerAuth.setApiKey`

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
| `IO_FAILED` | 文件锁竞争 / 磁盘错误 | 由 `respondError` 抛，message 透传 |

#### 实现要点

handler 内部一步走完：

1. 校验 params（`respondInvalid` on bad input）
2. 调 SDK `upsertApiKeyProfile`（同步返回 profileId）：
   - `provider`：调用方传的 id
   - `input`：调用方传的 apiKey
   - `agentDir`：用 [`claw-paths.js`](../src/claw-paths.js) 解析的 **main agent 完整路径**（含 `/agent` 子目录）
   - `options.secretInputMode: 'plaintext'`
   - `profileId`：调用方传的或默认
3. **不调** `updateConfig` / `mutateConfigFile`——见 mental-model § 4.7"只动 secret 不动 cfg"
4. `respond(true, { profileId })`

总代码量 ~15 行，参考 mental-model 附录 E.1 的代码骨架。

### 2.3 `coclaw.providerAuth.list`

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
    expiresAt?: number;            // ms epoch，仅 oauth / 部分 token
  }>;
}
```

#### 实现要点

1. 调 SDK `ensureAuthProfileStore(agentDir)`（**位置参数**，不是 object params）
2. 遍历 `store.profiles`，按 provider 过滤
3. `key` / `token` 字段**绝对不放进出参**；只输出 `keyPreview = formatApiKeyPreview(cred.key)`
4. OAuth credential 的 access / refresh token 也不外露——只露 email / displayName / expiry

#### 与上游 `models auth list` 的关系

上游 CLI 输出更原始（含 raw provider id、按 profile 维度）；本 RPC 是给 CoClaw UI 用的，已经做了遮蔽和裁剪。两者不互相替代——上游 CLI 是开发者诊断用的，本 RPC 是产品 UI 用的。

### 2.4 `coclaw.providerAuth.remove`

#### 协议形状

**入参**：

```ts
{ provider: string }
```

**出参**：

```ts
{ ok: true }
```

幂等：撤销不存在的 provider 不报错（返回 `{ok:true}`）。

**错误码**：同 setApiKey。

#### 实现要点

1. 调 SDK `removeProviderAuthProfilesWithLock({ provider, agentDir })`（异步，返回 store 或 null）
2. **不动 cfg.auth.profiles**——见 mental-model § 4.7
3. 同 provider 多 profileId（如 `:default` + `:work`）会一次清干净——上游 helper 内部按 provider 维度删

### 2.5 写完后的 cache 行为

- `models.authStatus` 有 60s 缓存——UI 撤回 / 重登后下次读必须传 `{refresh:true}`，但因为 api_key provider 不进 authStatus，本期影响小
- `coclaw.providerAuth.list` 走 SDK `ensureAuthProfileStore`，每次读按 mtime 失效——无需关心 cache 一致性
- 不需要触发 `secrets.reload`——本期没有"已 running channel 立刻用新 key"的场景

---

## § 3. OAuth 配置（待设计）

> 待下个议题展开。涉及上游 `wizard.*` / provider-plugin 的 device-code flow / token refresh。
> 关键挑战：UI 怎么把 device-code 链接呈现给用户授权 + 在 plugin 端等回调。

占位事项：

- OAuth 凭据由 OpenClaw 自动 refresh（mental-model § 4.4）；CoClaw 不需要自己刷
- OAuth 不可硬复制（refresh_token_reused），所有写入位置只能是 main agent
- OAuth provider 出现在 `models.authStatus`，撤销后须 `{refresh:true}` 强刷

---

## § 4. 默认模型设置（待设计）

> 涉及 `cfg.agents.defaults.model.primary` + `fallbacks`（mental-model § 3）。
>
> ⚠️ 写 `cfg.agents.defaults.model` 也是 hot-reload（mental-model § 4.7 的 reload 规则表里 `agents.defaults.model` 是 hot，不重启 gateway）——这条比 auth 那条幸运。
>
> 待设计的关键问题：
> - per-agent 覆盖（`cfg.agents.list[i].model`）的 UI 入口
> - 与白名单（§ 5）的交互（默认指针引用了白名单没列的模型也照跑，mental-model 陷阱 #1）
> - fallback 链的 UI 展示与编辑

---

## § 5. 白名单 + 模型附加设置（待设计）

> 涉及 `cfg.agents.defaults.models[]`（mental-model § 2）+ 给单个模型挂 `alias` / `params` / `agentRuntime` / `streaming` 附加设置。
>
> 写 `cfg.agents.defaults.models` 也是 hot-reload（不重启 gateway）。
>
> 待设计的关键问题：
> - 加自定义模型的 UI 入口
> - alias 命名约束（一期不上 alias，alias 几乎所有解析路径都生效，可能撞上下游）
> - per-model 设置的展示折叠

---

## § 6. 多账号顺序（暂不做）

涉及 `cfg.auth.order[<provider>]`（mental-model § 4.6）。

**暂不做的原因**：

- 一期统一 `<provider>:default`，单 profile 用不上 order
- 写 `cfg.auth.order` 会触发 gateway 全量重启（同 § 4.7 的 auth 写规则），上线前必须先解 UX 问题
- 真正要做时：插件加 `coclaw.providerAuth.setOrder` RPC + UI 端处理 gateway 重启窗口

---

## § 7. 取舍记录

汇总本文档下的关键取舍，每条带"为何"：

### 7.1 命名用 `coclaw.providerAuth.*`，不用 `coclaw.modelAuth.*`

凭据理论上不止服务于"模型 provider"——未来 channel 类的 provider auth 可能也走这套。用更通用的 `providerAuth` 留口子。

### 7.2 API key 配置不写 `cfg.auth.profiles`

见 mental-model § 4.7。三句话总结：

- 写 cfg 触发 gateway 全量重启（5-10s 中断），UI 用户感知为"出错了"
- OpenClaw 所有读写路径只看 `auth-profiles.json`，cfg 那份是冗余镜像
- 已知妥协：弱 LLM 翻 `openclaw.json` 自省"我配了啥"会误答；专业用户翻 cfg 也会困惑——这两件事一期接受

### 7.3 list RPC 出 `keyPreview` 而非完整 key，也不完全隐藏

上游策略是完全不展示；CoClaw 取中间值，给 `head4 + ... + tail4`——让用户在多账号场景能"对眼"识别。

约束：

- 遮蔽在 plugin handler 端做（用 SDK `formatApiKeyPreview`），不下放原始 key 让 UI 自己 mask
- `remoteLog` 绝对不能带 keyPreview / raw key

### 7.4 一期不做 provider key 探活

设 key 之后不主动调 provider API 验证有效性。理由：

- 引入外网调用复杂度（provider 各家协议不同）
- 第一次用模型时自然会 fail，错误信息已经够
- 探活会增加"看似配好实际还在转圈"的 UI 状态

### 7.5 profileId 一期统一 `:default`

多 profile 用 `:work` / `:personal` 可扩展，但一期不上 UI 入口。

---

## § 8. 引用关系

- mental-model **§ 4.7** —— 只动 secret 不动 cfg 的实测取舍与已知妥协
- mental-model **§ 4.8** —— 遮蔽显示策略
- mental-model **附录 C 凭据段** —— SDK 签名速查
- mental-model **附录 E** —— API key 配置 SOP（代码骨架、踩坑、与上游 CLI 差异）
- mental-model **附录 D** —— provider 清单获取的三处来源对照
- [`gateway-method-conventions.md`](gateway-method-conventions.md) —— 命名 / 错误格式 / scope 约定
- [`plugin-events.md`](plugin-events.md) —— 若未来 setApiKey 之后要广播事件给 server / UI，参考事件清单和 patch 语义

## § 9. 实施 checklist（仅 § 2 API key 部分）

落地时按这条单子检查：

- [ ] 三个 RPC handler 注册位置（建议放 `src/provider-auth/index.js` 或类似新模块）
- [ ] handler 用 `respondError` / `respondInvalid` 不用旧错误格式
- [ ] `agentDir` 走 `claw-paths.js`，不手拼路径
- [ ] list handler 出参不含 `key` / `token` 字段
- [ ] 单元测试：set / list / remove 三个路径 + 错误码 + 短 key 遮蔽降级
- [ ] mental-model § 4.7 提到的"未来若要写 cfg 时的 UX 问题"暂不实现，但代码注释里留 TODO 指向本文档 § 4 / § 6
