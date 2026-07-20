# OpenClaw 模型配置与规则

> 更新时间：2026-05-28
> 第一阅读者：CoClaw 维护者。第二阅读者：Agent。
> 目的：用最简洁的方式呈现 OpenClaw 关于"模型"这件事的完整机制，便于维护者与 Agent 快速建立完整的规则地图。
> 源码定位放附录 C，需要核实/扩展时再翻；CoClaw 写凭据 SOP 见附录 E。

---

## 概览：三层 + 凭据独立块

OpenClaw 关于模型这件事拆成三层：

```
┌─ 第一层：provider 货架 ─┐
│  models.providers.<id> │      每个厂家一个货架，写好接入信息和它的模型清单
│  baseUrl / models[] /  │
│  api / headers 等       │
└──────────┬──────────────┘
           │
           ▼
┌─ 第二层：白名单 ─┐           允许出现在挑选器里的模型清单
│ agents.defaults.│            (顺带给每个模型挂"附加设置")
│ models[]        │
└──────────┬──────┘
           │
           ▼
┌─ 第三层：默认指针 + fallback ─┐
│ agents.defaults.model.       │  实际用哪个模型，主选挂了转哪条备用链
│   { primary, fallbacks }     │
│ agents.list[i].model         │  per-agent 覆盖
└──────────────────────────────┘
```

**凭据是独立块**——存放位置、共享机制都和上面三层不在同一套规则里。它有一条**反直觉规则**（写在 main 一份就够，所有 agent 自动可见），要单独讲（见第四节）。

---

## 一、第一层：provider 货架

每个厂家一个货架，写好接入信息和它能提供的模型清单。

### 1.1 配置位置

主配置文件顶层 `models`：

```jsonc
{
  "models": {
    "mode": "merge",                                          // 可选，默认 merge
    "providers": {
      "<厂家>": {
        "baseUrl": "https://...",                             // 必填
        "apiKey": "...",                                      // 不建议（兼容口子，见 4.4）
        "models": [
          { "id": "...", "name": "...", "reasoning": true }
        ]
      }
    }
  }
}
```

### 1.2 货架清单的四个来源 + 合并

货架最终的模型清单从四处汇进来：

1. **插件自带清单**（装上插件即生效，最常见来源）
2. **插件运行时拉的清单**（少数插件有联网拉的能力）
3. **用户在主配置里手写**（即 `models.providers.<厂家>.models[]`）
4. **OpenClaw 自带"未装预览清单"**（边沿话题，一般用户不碰）

**合并规则**——同一个厂家的不同来源汇到一起：

- **同 id 模型两边都有**：用户写的字段覆盖插件自带，但**按字段一个一个覆**——用户只写了 `name` 才覆盖 `name`，没写就保留插件值
- **数字字段特殊**（`contextWindow` / `maxTokens` / `contextTokens`）：必须用户写的是**有效正数**才覆盖，0/空/负数当没写
- **用户独有模型**：原样进清单
- **插件独有模型**：原样保留，append 到清单尾部
- **顺序**：用户列的在前，插件自带的在后

**`mode: "replace"` 不是"只用用户写的"**——它只是跳过"和上一份派生清单的合并"，**插件自带不会被砍**。

### 1.3 货架顶层属性

```jsonc
"<厂家>": {
  "baseUrl": "...",              // 必填
  "apiKey": "...",               // 兼容口子，不推荐
  "api": "...",                  // 接入协议（自动检测，少数情况指定）
  "headers": { ... },            // HTTP 头（按 key 深合并）
  "params": { ... },             // 调用时附加的私有参数
  "localService": { ... },       // 本地起服务（如 Ollama）
  "agentRuntime": { "id": "..." }, // 此厂家默认绑哪个底层 runtime
  "models": [ ... ],             // 自定义模型清单
  "timeoutSeconds": 60,
  "injectNumCtxForOpenAICompat": true,
  "authHeader": true,
  "request": { ... }
}
```

### 1.4 模型条目字段（写在 `models[]` 里）

每条 strict 校验，**写未知字段会报错**。15 个可写字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | **必填**——不带厂家前缀的模型 id |
| `name` | string | **必填**——展示名（**唯一**展示字段，没有 description / displayName） |
| `reasoning` | bool | 能否开"深度思考" |
| `input` | `["text"|"image"|"video"|"audio"]` | 支持的输入模态 |
| `contextWindow` | number | 上下文窗口大小 |
| `maxTokens` | number | 单次输出上限 |
| `cost` | object | 价格：`{ input, output, cacheRead, cacheWrite, tieredPricing[] }` |
| `api` | enum | 接入协议（覆盖 provider 顶层） |
| `baseUrl` | string | per-model 覆盖 |
| `params` | record | per-model 私有参数 |
| `agentRuntime` | `{ id }` | per-model 底层 runtime |
| `headers` | record | per-model HTTP 头 |
| `compat` | object | 兼容性 hint |
| `contextTokens` | int | 旧别名，向后兼容 |
| `metadataSource` | `"models-add"` | 来源标记 |

### 1.5 模型引用字符串：`<厂家>/<模型>`

OpenClaw 里所有"指向某个模型"的字符串都长这样：

- 解析**只看第一个**斜杠：左边是厂家，右边整段（哪怕还有斜杠）是模型
- 双斜杠合法且常见：`openrouter/anthropic/claude-opus-4.5` —— 厂家=`openrouter`，模型=`anthropic/claude-opus-4.5`
- 厂家名大小写不敏感，**老别名自动认**（`bedrock` ≡ `amazon-bedrock`、`moonshotai` ≡ `moonshot`、`modelstudio` ≡ `qwen` 等）
- 模型名部分默认保留大小写

---

## 二、第二层：白名单 + 模型附加设置

### 2.1 配置位置

```jsonc
"agents": {
  "defaults": {
    "models": {                                          // ← 白名单字典
      "anthropic/claude-opus-4-7": { "alias": "opus" },
      "openai-codex/gpt-5.5":       { "alias": "gpt5" },
      "openrouter/*":               {}                   // 整厂放开
    }
  },
  "list": [
    { "id": "researcher", "models": { ... } }            // per-agent 单独覆盖
  ]
}
```

注意：单数 `model`（第三层默认指针）和复数 `models`（第二层白名单）路径相邻，**名字像但作用完全不同**，别写错。

### 2.2 字典结构

**key**：
- `<厂家>/<模型>` —— 具体一条
- `<厂家>/*` —— 整家通配放开

**value**：4 个可选槽位（strict，多写报错）：
- `alias` —— 给这个模型起短名，chat 切模型用
- `params` —— 调 LLM 时附加的私有参数（如 GLM 的"推理模式"开关）
- `agentRuntime: { id }` —— 把这个模型绑到特定底层 runtime
- `streaming` —— 是否流式（默认开，Ollama 默认关）

写空对象 `{}` 也行——纯占位表示"这条放进白名单，不加附加设置"。

### 2.3 反直觉：只筛挑选器，不筛执行

- 字典**非空** → chat 里 `/model` 切模型时挑选器只显示登记过的（含 `<厂家>/*` 命中的整厂）
- 字典**为空 / 字段没写** → 不限制，所有清单模型都能切

**关键反直觉点**：白名单**只筛挑选器，不筛执行**——
- 默认指针（第三层）引用了某个模型，白名单里没列也**照样能跑**
- 反过来白名单里列了某个模型，不等于真能用——还得登录、清单里得有

所以这字典**不是启用开关、不是安全开关**——它只控制下拉框的范围。

### 2.4 短名（alias）几乎所有解析路径都生效

写了短名后，所有需要"把字符串解析回具体模型"的地方都查这张表，包括：

- 默认指针 `agents.defaults.model.primary = "opus"` 直接写短名能用
- chat 里 `/model opus` 切模型
- 子 agent 派生
- CLI 列模型、计价、TTS 等

**判定规则**：字符串含 `/` 当作全名直接用；不含 `/` 才查短名表。

**实务建议**：**展示**给用户可以用短名，**存进配置**走全名——短名重名、被改、漏登记都会埋雷。

---

## 三、第三层：默认指针 + fallback

### 3.1 配置位置

```jsonc
"agents": {
  "defaults": {
    "model": {                                            // ← 默认指针
      "primary": "anthropic/claude-opus-4-7",
      "fallbacks": ["openai-codex/gpt-5.5"]
    }
  },
  "list": [
    {
      "id": "researcher",
      "model": { "primary": "...", "fallbacks": [...] }   // per-agent 单独覆盖
    }
  ]
}
```

也支持简写：`"model": "<厂家>/<模型>"`（纯字符串，等同于只有 primary、无 fallbacks）。

### 3.2 解析顺序

agent 跑一次找模型，**逐字段两步 fallback**：

```
agents.list[id=X].model.primary    >  agents.defaults.model.primary    >  内置兜底
agents.list[id=X].model.fallbacks  >  agents.defaults.model.fallbacks  >  []
```

### 3.3 反直觉：写 primary 没写 fallbacks = 显式清空

如果某个 agent entry 写了：

```jsonc
{ "id": "researcher", "model": "openai/gpt-5" }                    // 简写
// 或
{ "id": "researcher", "model": { "primary": "openai/gpt-5" } }     // 显式
```

**这两种写法都视为"这个 agent 不要 fallback"**，不会回退到 `defaults.model.fallbacks`。

要保留备用链，必须写完整对象：

```jsonc
{ "id": "researcher", "model": { "primary": "...", "fallbacks": [...] } }
```

### 3.4 main agent 的默认行为

`main` 通常**不在 `agents.list` 里显式写 model**，直接吃 `agents.defaults.model.primary`。

所以"切全局默认模型"**直接写 `agents.defaults.model.primary`** ——main 和其他没自配 model 的 agent 全部跟着变。**不要往 `agents.list[id=main].model` 里写**——会把 main 从"跟随全局"切到"独立配置"，反而割裂 main 和其他 agent。

### 3.5 不在 list 里的 agent 也算存在

OpenClaw 默认 agent 是 `main`。即使 `agents.list` 里没有 main 条目，main 也算存在——查 agent 列表为空时兜底返回 `["main"]`。任何 agent id 没在 list 里，model / workspace / identity 全部回退到 defaults。

---

## 四、凭据（独立块）：和 model fallback 完全不同的机制

凭据是**独立于三层规则之外的话题**。要单独讲是因为它的共享规则**和 model fallback 的"找不到就往上翻"完全不同**——容易把心智模型搞混。

### 4.1 物理存储

凭据**不在主配置文件里**，存在 agent 目录下：

```
~/.openclaw/agents/<agentId>/agent/
  ├── auth-profiles.json     ← 秘密（OAuth token / API key / static token）
  ├── auth-state.json        ← cooldown / 使用统计
  └── harness-auth/          ← harness 层凭据（CLI 模式专用）
```

主配置文件顶层只放声明（不带秘密）：

```jsonc
"auth": {
  "profiles": {
    "openai-codex:default": { "provider": "openai-codex", "mode": "oauth" }
  },
  "order": {
    "openai-codex": ["openai-codex:default"]              // 多账号顺序，一期 default 即可
  }
}
```

**声明 + 秘密两份必须同步写**——OpenClaw SDK 已经把这件事打包好（`upsertAuthProfile` + `applyAuthProfileConfig`）。

### 4.2 反直觉点：层叠合并 ≠ fallback

**这是和 model fallback 完全不同的机制**：

|  | model 的 fallback（第三层） | 凭据共享 |
|---|---|---|
| **写在哪** | 每个 agent 各自在自己的 entry 里 | **只写 main 这一份** |
| **机制** | 单点解析：找不到往上翻 | 层叠合并：两份文件按 profile id 浅合并 |
| **生效时** | 选一个用一个 | main 是底、当前 agent 是面，**两份同时生效** |
| **看不见同名时** | 用 defaults | 用 main 的 |
| **看得见同名时** | 用 agent 自己的 | 用 agent 自己的（盖住 main 同名 profile） |

直观比喻：

- model fallback 像查户口——这个 agent 的户口本上没填，就翻总册（defaults）找
- 凭据共享像两层透明胶片叠在一起看——main 那张永远在底下，所有 agent 的胶片叠上去看到的是两层综合

### 4.3 实务结论：写 main 一份就够

机制具体行为：

- main 里有的 OAuth profile，所有其他 agent **自动可见、自动可用**
- 子 agent 真去刷新 OAuth token，会**反向同步回 main**，所有 agent 始终看到最新 token
- 没有"为每个 agent 单独登录"的概念——所有"登录"动作的物理写入位置都是 main

**硬约束**：

- 登录按钮**只写到 main**——别给 UI 加"为某 agent 单独登 OAuth"或"复制 OAuth 到这个 agent"的按钮
- OAuth 凭据**默认不可复制**——硬复制会让两个 agent 同时用同一把 refresh token，被 provider 当成 token 重用攻击拒掉（`refresh_token_reused`）
- API key 可以复制（静态秘密，复制是安全的），但通常也只在 main 管一份就够

### 4.4 凭据类型

`auth-profiles.json` 里每条 profile 的 `type` 字段：

- **`oauth`** —— OAuth（access + refresh + expires + accountId，自动刷新，**不可复制**）
- **`api_key`** —— 静态 API key（**可复制**；新建 agent 时 OpenClaw 会问要不要复制过去）
- **`token`** —— 静态 bearer token（可选过期、无 refresh）
- **`aws-sdk`** —— AWS SDK 默认凭据链（不落地到文件，由 AWS SDK 自取）

### 4.5 别用兼容口子写 API key

主配置文件里 `models.providers.<厂家>.apiKey` 字段虽然能写，**但是兼容口子，不安全**：

- 明文写进主配置文件
- 绕开 SDK 的锁和缓存清理

**上游立场**：OpenClaw 自家所有录密钥入口（`models auth` / onboarding）写的都是账本（auth-profiles），**从不写内联**；`secrets audit` 把内联明文 key 标为安全 finding。内联 `apiKey` 仅作向后兼容/逃生口存在，推荐顺序 SecretRef（引外部 secret） > 账本 > 内联。**推论**：CoClaw 自己也从不往内联写 key（加 api-key 走账本，见附录 E），所以撤销功能里要删的"内联 key"基本都是用户历史遗留手写 / 脚本注入的——删它是帮用户清老配置，不是删 CoClaw 造的东西。

要存 API key 走 SDK helper（`upsertAuthProfileWithLock` + `buildApiKeyCredential`），它只写 `auth-profiles.json` 秘密一份——`cfg.auth.profiles` 声明无需同步写（实测结论详见 § 4.7）。

### 4.6 多账号机制（一期不做）

profileId 命名 `<provider>:<label>`——`default` 是缺省 label，`work`/`personal` 等可扩展。多账号时账号顺序走 `auth.order[<provider>] = [profileId1, profileId2, ...]`，按顺序逐个尝试。

**modelId 字符串不带账号信息**——账号选择和模型选择完全解耦。一期统一 `:default`。

### 4.7 实测结论：CoClaw 写凭据只动 `auth-profiles.json`，不动主配置

2026-05-14 端到端实测钉死的关键事实——**`cfg.auth.profiles` 是冗余声明，OpenClaw 所有读写路径都只看 `auth-profiles.json`**：

**实测证据**：
- 把 `cfg.auth.profiles` 整段清空成 `{}`，重启 gateway 后：
  - `chat` 仍能跑（inference 路径不依赖 cfg）
  - `models.authStatus` RPC 完整返回 `openai-codex`（含 displayName / expiry / usage / plan）
  - `openclaw models auth list --json` 完整列出 profile
- 只调 `upsertApiKeyProfile` 写 `auth-profiles.json`（**不调** `updateConfig` 写 cfg）：
  - `openclaw models auth list --provider <X>` 立刻能列出 orphan secret
  - `gateway` 全程不重启、不掉线

**为什么这一点重要——`cfg.auth.profiles` 改动会触发 gateway 全量重启**：

OpenClaw 把任何未在 hot-reload 白名单里的 cfg 字段改动当作"需要重启"，而 `auth.*` 整段都不在白名单——所以**每次写 cfg.auth.profiles 都让 gateway 进程全量重启一次**（systemd 拉起约 5–10 秒，期间所有 chat / agent run / P2P 都中断）。

CLI `models auth paste-token` 之所以写两份（secret + cfg 声明），是因为它的设计假设是"用户在装机或 onboarding 时一次性配，重启 gateway 没事"。CoClaw 是在线运行的 UI，**无法接受用户每加一把 key 就让 gateway 重启**。

**实务规则**：

- **set API key**：用 `buildApiKeyCredential` 构造凭据后调 `upsertAuthProfileWithLock`（写 secret 一份，**带文件锁**——与 remove 共享同一把，避免并发丢写），**不调** `updateConfig(applyAuthProfileConfig)`。零 gateway 重启。**注意**：该 helper 失败时静默返回 `null`（内部 try/catch 吞错），handler 必须显式判 null
- **remove API key**：只调 `removeProviderAuthProfilesWithLock`（清 secret 一份，**带文件锁**），**不动** cfg。零 gateway 重启。同样静默返回 `null` 表示失败，必须显式判 null
- **list 已绑 provider**：调 `ensureAuthProfileStore` 读 store 后遍历 `store.profiles`——cfg 那份本来就是空的，无需读

**已知妥协（暂不修复，CoClaw 一期取舍）**：

1. **弱 LLM 自省可能误答**：用户问 agent "我配了哪些 provider"，模型若去读 `openclaw.json` 看 `auth.profiles`，会答"什么都没配"。专业用户提问能引导 agent 调 `models.authStatus` / `models auth list` 得到正确答案；弱模型不会
2. **开发者用户翻 cfg 会困惑**：习惯翻 `openclaw.json` 找 profile 的开发者会看到空段，但实际能用——是个反直觉点。专业用户可以自己改 cfg 走标准路径（仍然 work）
3. **多账号顺序无法在 cfg 里调**：`cfg.auth.order[<provider>]` 不写，OpenClaw 走"profile id 自然顺序"。一期统一 `:default` 不受影响；将来要支持多账号优先级排序时要解这道题

**如果将来 CoClaw 要写主配置（如为支持多账号 order）**：

- UI 必须处理 gateway 重启窗口的 RPC closed 错误（约 5–10s）——"忽略 1006 / abnormal closure，等 gateway 起来后自动重连"
- 用户能看到的动作必须是"配置中…等几秒"而非"出错了"
- 这是个未来要专门设计的 UX 流程

### 4.8 读侧遮蔽显示策略（CoClaw 偏好）

OpenClaw 自家完全不展示 key 任何字符（`models auth list` / `models.authStatus` 输出都不带 key），目的是"凭据不外流"。CoClaw UI **偏好部分展示**：默认遮蔽中间，露出 `head4 + ... + tail4`（短 key 降级到 `head2 + ... + tail2`）。

**理由**：让用户在 UI 卡片上能"对眼"识别"我配的是哪一把 key"——尤其多账号场景下区分用。完全不显示会让用户每次都要去 OpenAI/MiniMax 控制台对比 last4 才能确认。

**约束**：

- 遮蔽逻辑在**插件 handler 端做**（不要把原始 key 传到 UI / server，再让前端 mask）。OpenClaw SDK 提供 `formatApiKeyPreview` helper 可复用
- 列表 / 单条详情 RPC 出参字段叫 `keyPreview`（不叫 `key`），明确这是个**只读展示串**，不是原始 key
- 远端日志（`remoteLog`）**绝对不能**带原始 key 或 keyPreview——日志可能广播到 server
- 单元测试要 cover 短 key（≤ 8 字符）的降级遮蔽逻辑，避免泄露过多

### 4.9 provider 身份 = 定义 + 密钥两摊；删内联 key 的"内置 vs 自定义"之别

一个 provider 的完整身份拆两块，走两条**互不相干**的路：

- **密钥**（apiKey / token）——三源穿透解析（env → 内联 `apiKey` → 账本，见第四节 + 陷阱 #17），任一命中即用。CoClaw 和 OpenClaw 自家"加密钥"都只写**账本**。
- **定义**（baseUrl / api / models / contextWindow…）——provider 货架字段（§1.3 / 1.4），供 provider 注册用，**不进密钥解析链**。定义有两个来源：
  - **内置 provider**（如 pi-ai 字典里的 minimax）：定义在 OpenClaw 自带字典（`models.generated.js`），用户内联往往**只写一把 apiKey**。
  - **自定义 provider**：定义**只存在内联节点里**。

**所以删内联 key 的正确做法 = 只删 `apiKey` 字段、保留节点其余、删完节点空 `{}` 才清整节点**。这一条规则恰好同时接住两类：

- **内置**：删掉那唯一的 apiKey → 节点空 → 清掉**无损**（定义在字典里没丢，重配密钥照用）。
- **自定义**：删 key 后节点还剩 baseUrl/models → 保留 → 定义不被销毁。

**反过来"删整节点"严格更危险**：会毁掉自定义 provider 的唯一定义，而 CoClaw 的"加 api-key"只写账本、**不会重建 provider 定义**，用户只剩一把指向"无定义 provider"的死账本 key。

**残节点（无 apiKey、有 baseUrl/models）+ 账本 key 零冲突**：取 key 链遇节点无 apiKey 自动落账本，"节点定义 provider + 账本供 key"本就是 OpenClaw 一等配置形态。残节点对内联列举也隐身（列举只认带 apiKey 的节点 → 不会冒充幽灵凭据；模型选择器应按**能用集**过滤（§ 4.10）、不是按原始名拼凭据，重配 key 后该 provider 重新可选）。

**OAuth / 扫码 provider 的内联节点天生无 apiKey**：登录时 token 写**账本**，同时往内联写一个 provider **定义**节点（baseUrl/api/models，**无 apiKey**，走 `mutateConfigFile`；典型是 minimax-portal 补内置字典漏掉的清单，见附录 F）。因为无 apiKey，内联列举 / 撤销**永远碰不到它**。这类清单的写回靠**登录流程本身**（每次 OAuth 成功整节点重写、含 models），不靠对账；对账只在 gateway 启动时补"升级后陈旧清单"且**只补已存在节点**（删了的不重建）。

### 4.10 判"哪家/哪个模型能用"用 OpenClaw 鉴权解析，别自己按原始名拼三源（2026-05-28，修订 6 定稿）

> **CoClaw 落地结论（修订 6）**：用**入口 C `loadModelCatalog` 干净目录 + 统一别名感知凭据原语**（见下），**放弃**入口 B"能用集 `buildModelsProviderData`/cfgClone"（幽灵 + 需 cfgClone + 鉴权口径与 /claws 信号不一致）。详见 memory [[reference_openclaw_alias_plan_catalog_and_auth_surfacing]] + dump 修订 6。

"哪些 provider/模型真能选、能设"是 **OpenClaw 的职责**，不是 CoClaw 该按原始名硬拼的。**别名授权是常见、不是边角**：`models.list view:'all'` 把别名变体当**独立 provider**（`volcengine-plan` / `byteplus-plan` / `minimax-cn` / `stepfun-plan` …），一把基座 key（`volcengine`）经厂商 manifest `providerAuthAliases` 同时授权基座**和**变体；而 **套餐用户想用的默认模型常落在变体里**（volcengine 默认 = `volcengine-plan/ark-code-latest`）。`normalizeProviderId` 只做 lowercase/trim、**不做**这类语义映射，所以"自己拼三源 + 按原始名跟目录取交集"必漏。

**变体从哪来 + 实测确认（2026-05-28）**：变体模型来自**厂商扩展插件清单的 `modelCatalog` 字段**（`dist/extensions/volcengine/openclaw.plugin.json` 的 `modelCatalog.providers.volcengine-plan.models[]`，含 `ark-code-latest`），**不是** pi-ai 出厂字典、**不是**别名表（`providerAuthAliases` 是同一文件里**另一个独立**字段、纯鉴权侧、不造目录条目）。本机实测：加一把基座 `volcengine` 账本 key，**默认（鉴权过滤）视图**即同时出现 `volcengine/*` 与 `volcengine-plan/ark-code-latest` 全套；删 key 归零。源码链 `createProviderAuthChecker → hasAuthForModelProvider(model-provider-auth.ts:217 listProfilesForProvider) → resolveProviderIdForAuth`（别名感知两侧）。

要别名感知，有三条 OpenClaw 自家入口（取舍见下）：

**入口 A（便宜、不读目录、能答"某 provider 可用否"，但不能枚举模型）**：现成已导出的 `isProviderApiKeyConfigured`（`plugin-sdk/provider-auth`）**已别名感知**——它查账本走 `listProfilesForProvider`，后者对传入名和每条凭据名都跑 `resolveProviderIdForAuth`（按 manifest `providerAuthAliases` 归一，`agents/provider-auth-aliases.ts`）再比。故 `isProviderApiKeyConfigured('volcengine-plan')` 自解析成 `volcengine` → 命中账本 key → true，**全程不读目录**。覆盖账本+env（别名感知）；**漏内联 key（它不查 `models.providers.*.apiKey`）+ IAM/本地**。`resolveProviderIdForAuth` 本体**未导出 plugin-sdk**，插件不能拿它单独解析内联名。

**入口 B（完整但被污染、要读目录）"能用集" `buildModelsProviderData(cfgClone, agentId, {view:'default'}).byProvider`**（`openclaw/plugin-sdk/models-provider-runtime`，公开自 v2026.4.1）：

```js
// cfgClone = 去掉模型白名单(agents.defaults.models / agent models) + 已配主模型(model) + imageModel 的 cfg 克隆
const data = await buildModelsProviderData(cfgClone, agentId, { view: 'default' });
const byProvider = data.byProvider; // Map<provider, Set<modelId>>
```

⚠️ **`byProvider` ≠ 干净的"目录∩鉴权"**（修订 4 误判，已证伪——详见陷阱 #24 + memory [[reference_openclaw_buildmodelsproviderdata_byprovider_contamination]]）。前半段（visibleCatalog）确实按鉴权过滤主目录、且 `createProviderAuthChecker→hasAuthForModelProvider` 覆盖 **env+内联+账本+别名+IAM/本地** 五源；**但尾部无 auth 门硬塞三类脏数据**：①内置默认 `openai/gpt-5.5`（没配主模型时的兜底常量，摘 model 后**永远**在）②`imageModel`+fallback（摘 model 不摘 imageModel 就漏）③configuredCatalog（config 里定义过 `models.providers.<id>.models[]` 的 provider，无 auth）。`add()` 的可见性过滤近乎全通（只排 retired codex）。**唯一能枚举别名变体模型清单（如 `ark-code-latest`）的入口就是它**（入口 A 只能答 yes/no、不能列模型），这是"绕不开能用集"的根。

- **摘白名单**：默认视图本被 `agents.defaults.models` 缩窄；摘掉后 `allowAny=true` = 全量鉴权集。
- **能用集是进程内 SDK 调用、不是网关 RPC**（无"res 广播给各 UI"问题）；摘白名单后读 `loadCatalog({readOnly:true})`+750ms 超时（缓存只读、**非慢 discovery**）。

**入口 C（CoClaw 修订 6 采用）：`loadModelCatalog` 干净目录 + 统一别名感知凭据原语**——`loadModelCatalog({readOnly:true})`（经 `openclaw/plugin-sdk/agent-runtime`，barrel re-export `../agents/model-catalog.js`）返回 registry + **manifest catalog 行（变体在此）** + configured 的合并目录；`readOnly` 路径**设计上零副作用**（读持久化 `models.json`/静态 manifest，跳过 `ensureOpenClawModelsJson` 与 provider discovery，不联网、不卡事件循环），**且幽灵注入在 `buildModelsProviderData` 尾部、不在 `loadModelCatalog` 里 → 此源天然无幽灵**、也不需 cfgClone（目录本就白名单之前）。枚举 = 目录按 provider 分组 → 留过"统一原语"的 provider。统一原语 = `isProviderApiKeyConfigured`（env+账本，别名感知）∪ 内联（内联名过 `resolveProviderIdForAuth` 归一）；`resolveProviderIdForAuth` **可经 `openclaw/plugin-sdk/agent-runtime` 子路径 import**（不在主桶）。统一漏 IAM/本地（`hasAuthForModelProvider` 未导出，接受）。caveat：readOnly 主路径读 lazy 缓存 `models.json`，新装厂商扩展有极窄过时窗口（自带扩展即在内），要绝对保险走非 readOnly（更新鲜但首拉慢）。

**用法取舍（CoClaw 落地见 plugin `model-config-api.md` § 3.2.1，定稿见 `tmp/inline-key-list-revoke--clear-dump.md` 修订 6）**：**入口 C 是 CoClaw 采用的路**——选模型器枚举（目录∩统一原语，无幽灵、含变体）/ model.set 门 / providerUsable / noKey **四处同一原语**，杜绝跨界面矛盾。**放弃入口 B（能用集）**：它有幽灵、需 cfgClone、且其鉴权过滤走 `hasAuthForModelProvider`（覆盖 IAM）与 /claws 信号用的 `isProviderApiKeyConfigured`（不覆盖 IAM）口径不一致 → IAM-only 用户"选得到却判失效"。入口 A 是统一原语的一半（答 yes/no），入口 C 在它之上叠干净目录做枚举。

**反模式（CoClaw 踩过）**：① 选模型器/凭据信号拿 `providerAuth.list`（三源凭据、**原始名**）∩ 目录 → 别名变体漏；② `model.set` 用 `isProviderAuthProfileConfigured`（**只认账本**，漏内联/env）→ 模型放行却设不上。

**上游缺口（值得提 issue）**：OpenClaw 给 CLI 算了每模型的 `available` 标志，但**没经网关 `models.list` RPC 吐出来**；真吐出来，插件可直接读 `m.available`，连入口 B 的"摘白名单 + 躲幽灵"都省了。可用性本就是 OpenClaw 的职责。

---

## 五、其他重要规则

### 5.1 插件启用

每个插件两层开关：

- **manifest 默认**：插件自己在 `openclaw.plugin.json` 里写 `enabledByDefault: true/false`
- **用户覆盖**：主配置文件 `plugins.entries.<id>.enabled` —— **只在反对默认状态时才写**：默认开的想关写 `false`，默认关的想开写 `true`

OpenClaw 自带 90 多个插件，绝大部分默认开。所以**装好的瞬间就有几十个厂家、几百个模型可见**——但能跑哪些取决于登过哪些（除本地厂和 AWS Bedrock）。

### 5.2 派生缓存 `models.json`（别动）

```
~/.openclaw/agents/<id>/agent/models.json
```

这是 OpenClaw runtime 自动写的**物化清单**——把第一层货架（用户 cfg + 插件自带 + 运行时拉的）合并后落盘。

**别动、别读、别依赖**：

- runtime 用内存 cache 守着，gateway 进程起来后基本不重写——删了也不会自动回来
- 但跑模型本身**不依赖**这个文件，所以删了不影响 chat
- 拉模型清单统一走 gateway RPC（`models.list`），不直读文件

### 5.3 配置改了 cache 不自动刷

改完主配置文件，立刻调 gateway 拉模型清单接口可能拿到旧 cache——cache 失效靠 config-reload 事件触发，不靠文件改本身。

强刷有两条路：

- 触发 config-reload（推荐）
- 调 `models.list view: "all"`（会跑所有插件 discovery，慢）

### 5.4 拉模型清单接口给的字段是窄版

gateway 的 `models.list` 接口给的字段**只有 9 个**：

```
id / name / provider / alias / contextWindow / contextTokens / reasoning / input / compat
```

**`cost` / `maxTokens` / `api` / `baseUrl` / `headers` / `params` / `agentRuntime` 在接口输出层被砍**——要展示价格或单次输出上限，必须**绕过 RPC 直接读主配置文件的 `models.providers.<厂家>.models[]`**。

> ⚠️ 注意"直读主配置"只对**已写进 config 的 provider** 管用。对**纯内置 provider**（如 pi-ai 出厂的 `minimax` / `minimax-cn`，没有 config 条目），`maxTokens` 连进程内的 `loadModelCatalog` 都拿不到——它在 catalog 构建层（pi-ai 条目映射）就被丢，不只是 RPC 投影。细节与影响（CoClaw 为何仍须硬写 maxTokens）见附录 F.4 / F.5。

### 5.5 OpenRouter 的"光秃秃 modelId 自动补前缀"机制

OpenRouter 在插件清单里登记了一条规则：用户引用 OpenRouter 模型时如果只写一个**光秃秃的名字**（不含斜杠），自动补 `openrouter/` 前缀。

但**这条规则的本意**是给 OpenRouter 自家"自动路由型"特殊模型（`auto`、`aurora-*` 等）用的，**不是给下游厂家（OpenRouter 转手卖的 Anthropic/OpenAI 等）模型用的**。

实务约束：用户加 OpenRouter 下游模型时，只让填后半段（如 `anthropic/claude-opus-4.5`），自己拼 `openrouter/` 上去。别让用户依赖 `prefixWhenBare`。

---

## 六、典型陷阱清单

1. **白名单 ≠ 启用开关**——默认指针引用了模型，白名单没列也照跑（见 2.3）
2. **写 primary 没写 fallbacks = 显式清空**——不会回退到 defaults.fallbacks（见 3.3）
3. **凭据共享是"叠加合并"不是"fallback"**——只写 main 一份就够（见 4.2）
4. **OAuth 不可复制**——硬复制触发 token 重用攻击
5. **`models.providers.<厂家>.apiKey` 是兼容口子**——别用，走 SDK helper（见 4.5）
6. **派生缓存 stale 残留**——删了的插件，派生 `models.json` 里它的 provider 条目不会自动清。永远以 RPC 拿到的当前为准
7. **一个插件两个 provider id**——`openai` 插件同时管 `openai` 和 `openai-codex`。按"厂商品牌"理解，不按 provider id
8. **synthetic auth provider 不写 `auth-profiles.json`**——某些 provider 通过 manifest 的 `nonSecretAuthMarkers` 标记，**不需要凭据**。识别登录状态时要区分"需要凭据 / synthetic / 本地服务"三态
9. **OpenRouter 双斜杠合法**——`openrouter/anthropic/claude-opus-4.5` 是正确写法，别画蛇添足拼成 `openrouter/openrouter/...`（见 1.5、5.5）
10. **`agents.defaults.model` vs `agents.defaults.models`**——单数（默认指针）和复数（白名单字典）名字相邻但作用完全不同（见 2.1）
11. **gateway 拉模型清单接口字段是窄版**——价格、单次输出上限被砍，得直接读主配置文件（见 5.4）
12. **配置改了模型清单 cache 不自动刷**——靠 config-reload 触发（见 5.3）
13. **`auth.*` 字段改动默认触发 gateway 全量重启**——hot-reload 白名单不含 auth；写 `cfg.auth.profiles` = 重启 gateway（5–10s 中断）。CoClaw 因此走"只动 secret 不动 cfg"路径（见 4.7）
14. **`upsertApiKeyProfile` 的 `agentDir` 参数预期含 `/agent` 子目录**——传 `<state-dir>/agents/<id>/agent`（而不是 `<state-dir>/agents/<id>`），否则 secret 写到错位置 OpenClaw 读不到。统一用 `claw-paths.js` 拿 agentDir 不要手拼
15. **`cfg.auth.profiles` 是冗余声明**——OpenClaw 所有读写路径只看 `auth-profiles.json`；cfg 那份是镜像 / 审计 / 多账号 order 才用得上（见 4.7）
16. **`models.authStatus` 不列 api_key provider**——只列 OAuth/可刷新的；UI 想列"已绑哪些 api_key provider"必须走插件自己的 list RPC（读 store 然后遍历）
17. **真正的凭据门禁比"三源 key"更宽，且"全集判定函数"没对插件开放**——`hasAuthForModelProvider`（`src/agents/model-provider-auth.ts`）= 归一化 + `hasRuntimeAvailableProviderAuth`（env + 内联 + **IAM：`authOverride==="aws-sdk"` / 裸 `amazon-bedrock` 不看 key** + **本地无 key 的 custom provider**，`src/agents/model-auth.ts`）+ `listProfilesForProvider`（profiles），是判"这家到底有没有可用 auth"的真·全集；但**未从任何 plugin-sdk barrel 导出**。插件能拿的只有 `isProviderApiKeyConfigured`（env+profiles，**漏内联 + 漏 IAM/本地**）。要在插件侧精确判定需推上游导出该函数，否则只能手搓 + 接受 IAM/本地/纯 env 残留（与第 8 条"三态"互补）
18. **provider 旧名是"读时折叠"的硬编码别名表，绝不改写配置**——`normalizeProviderId`（`src/agents/provider-id.ts`，约 9 组：`doubao`/`bytedance`→`volcengine`、`kimi-code`/`kimi-coding`→`kimi`、`z.ai`/`z-ai`→`zai`、`modelstudio`/`qwencloud`→`qwen`、`moonshotai`→`moonshot`、`bedrock`/`aws-bedrock`→`amazon-bedrock`、`opencode-zen`→`opencode` 等）。只在 OpenClaw 读取/比对时临时折叠，**配置文件里能长期保留旧拼写**。凡是不走 OpenClaw 函数、自己拿两份 provider 字符串比对的地方都得先过这张表；但表只此一份、下游复刻必随上游加 provider 漂移——能委托 OpenClaw 判定就别自己比
19. **`models.list view:"all"` 的 `provider` 字段不保证规范名**——discovered 来源原样塞（`src/agents/model-catalog.ts`，只 trim 不归一化），configured 来源另处才折叠。所以"拿主模型 provider 裸比目录 provider"对别名拼写会误判（"模型下架"类校验的残留来源）
20. **`hasConfiguredSecretInput` 只是语法/存在感判定，不等于凭据可用**——非空字符串 → true；合规 SecretRef（`{source,provider,id}`）→ true；但 `{env:...}`/`{file:...}` 简写、空值 → false；且不验证 env 引用能否真解析（未设值的引用也算 true）。用它判"配了内联 key"只能当"配置信号"，不当"凭据可用"
21. **别想在插件侧用 `byProvider` 判"模型在不在目录"/"有没有凭据"——它尾部无 auth 门硬塞脏数据（修订 5 升级：不止主模型）**——`buildModelsProviderData().byProvider` 在尾部**无条件塞入**（不经目录/鉴权校验，`commands-models.ts:281-282`）：①已配主模型；②没配主模型时的**内置默认常量 `openai/gpt-5.5`**（`agents/defaults.ts`，故摘掉 model 后它**永远**在、且是裸 `openai` 与 `openai-codex` 无关）；③`imageModel`+fallback；④configuredCatalog（config 里定义过 `models.providers.<id>.models[]` 的 provider，无 auth）。拿它查"模型在不在目录"是自我应验、测不出"模型下架"；拿它"非空"判"有没有凭据"被幽灵恒真化。且 `loadModelCatalog` 失败**返回 `[]` 不抛错**。判"模型下架"的可靠源是 gateway `models.list view:"all"`（干净原始目录），不是 byProvider；判"某 provider 可用否"用 `isProviderApiKeyConfigured`（4.10 入口 A）。详见 memory [[reference_openclaw_buildmodelsproviderdata_byprovider_contamination]]
22. **凭据"读"是三源、"列举/撤销"曾只认账本一源 → 列表与现实打架**——key 解析吃 env + 内联 `cfg.models.providers.<id>.apiKey` + 账本 profiles 三源（第 17 条），但早期 `coclaw.providerAuth.list` 只遍历账本 store：用户把 key 直接手写在 `openclaw.json`（内联）或塞环境变量时，模型照常能用，列表却空着说"没配 key"，引导自相矛盾。**撤销更没有统一入口**：账本走 `removeProviderAuthProfilesWithLock`、内联只能 `mutateConfigFile` 删 `apiKey` 字段（删字段不删节点——`baseUrl`/`api`/`models` 是用户自定义 provider 定义）、env 进程级根本撤不了。且 **OpenClaw 自己从不删内联 key**（`logout --provider` 只清账本、re-onboard 仍保留内联），把它当用户私有手写配置。CoClaw 越过这条线让内联可撤。**已治本**：list 合并三源、每条带 `source`/`removable`，remove 按 `source` 分派（plugin `model-config-api.md` § 2.4 / § 2.5）
23. **provider 身份 = 定义 + 密钥两摊；删内联 key 内置 vs 自定义不同**——密钥三源穿透解析、定义另走一路；内置 provider 定义在字典（删空壳无损）、自定义定义只在内联节点（必须保留，删整节点会毁掉且 CoClaw 加 key 补不回）；残节点 + 账本 key 零冲突；OAuth/扫码节点天生无 apiKey 故内联撤销碰不到（详见 4.9）
24. **判"模型能不能选/设"用 OpenClaw 别名感知鉴权，但 `byProvider` ≠ 干净"目录∩鉴权"（修订 5 订正前曾误判）**——`buildModelsProviderData(cfg 去白名单+主模型+imageModel, view:'default').byProvider` 前半段是目录∩鉴权（覆盖 env+内联+账本+别名+IAM/本地），**但尾部无 auth 门硬塞内置默认 `openai/gpt-5.5`（摘 model 后永远在）+ imageModel + configuredCatalog**（详见陷阱 #21 升级版 + memory [[reference_openclaw_buildmodelsproviderdata_byprovider_contamination]]）。故能用集**可枚举别名变体模型**，但**不能拿"非空"判"有没有 key"**（幽灵恒真化 noKey）。**CoClaw 修订 6 已弃用 byProvider 喂选模型器**，改用入口 C `loadModelCatalog` 干净目录（天然无幽灵、含变体）∩ 统一别名感知凭据原语（详见 4.10 入口 C）。自己按原始名拼三源 ∩ 目录会漏别名套餐（`volcengine-plan` 选不到）；`model.set` 旧用 `isProviderAuthProfileConfigured` 只认账本（漏内联/env，"选得到设不上"根因，修订 6 换统一原语）；上游每模型 `available` 未经网关 RPC 暴露（详见 4.10）

---

## 附录 A：关键文件路径速查

```
~/.openclaw/openclaw.json                              ← 主配置文件
                                                          - 顶层 models      → 第一层 provider 货架
                                                          - 顶层 agents      → 第二层 + 第三层
                                                          - 顶层 auth        → 凭据声明（不带秘密）
                                                          - 顶层 plugins     → 插件启用覆盖

~/.openclaw/plugins/installs.json                      ← 插件装载清单（OpenClaw 自动生成，DO NOT EDIT）

~/.openclaw/agents/<id>/agent/
  ├── auth-profiles.json                               ← 凭据秘密（main 兜底所有 agent）
  ├── auth-state.json                                  ← cooldown / 使用统计
  ├── harness-auth/                                    ← harness 层凭据（CLI 模式）
  └── models.json                                      ← 派生缓存（别动、别读）
```

## 附录 B：主配置文件里和"模型"相关的字段全清单

```jsonc
{
  "models": {                                            // ─ 第一层：provider 货架
    "mode": "merge",                                     //   "merge" 默认 / "replace"
    "providers": {
      "<厂家>": {
        "baseUrl": "...",                                //   必填
        "apiKey": "...",                                 //   兼容口子，不推荐
        "api": "...",
        "headers": { ... },
        "params": { ... },
        "localService": { ... },
        "agentRuntime": { "id": "..." },
        "models": [
          {
            "id": "...", "name": "...",                  //   必填两项
            "reasoning": true, "input": [...],
            "contextWindow": 200000, "maxTokens": 8192,
            "cost": { ... }
          }
        ]
      }
    },
    "pricing": { "enabled": true }
  },

  "agents": {
    "defaults": {
      "model": {                                          // ─ 第三层：默认指针
        "primary": "<厂家>/<模型>",
        "fallbacks": ["..."]
      },
      "models": {                                         // ─ 第二层：白名单 + 附加设置
        "<厂家>/<模型>": {
          "alias": "...",
          "params": { ... },
          "agentRuntime": { "id": "..." },
          "streaming": true
        },
        "<厂家>/*": { }
      },
      "agentRuntime": { "id": "..." }                     //   全局底层 runtime
    },
    "list": [
      {
        "id": "...",
        "model": { ... },                                 //   per-agent 指针覆盖
        "models": { ... }                                 //   per-agent 白名单覆盖
      }
    ]
  },

  "auth": {                                               // ─ 凭据声明（秘密在另一文件）
    "profiles": {
      "<provider>:<label>": {
        "provider": "...",
        "mode": "oauth" | "api_key" | "token" | "aws-sdk"
      }
    },
    "order": {
      "<provider>": ["<provider>:<label>"]                //   多账号顺序
    }
  },

  "plugins": {                                            // ─ 插件启用覆盖
    "entries": {
      "<plugin-id>": { "enabled": true | false }
    }
  }
}
```

## 附录 C：OpenClaw 源码定位

需要核实细节、扩展规则、追问"为什么"时再翻。

**modelRef 解析**
- `src/agents/model-selection-normalize.ts` — `parseModelRef` / `normalizeModelRef`
- `src/agents/provider-id.ts` — `normalizeProviderId` + 历史别名表
- `src/plugins/manifest-model-id-normalization.ts` — `stripPrefixes` / `aliases` / `prefixWhenBare`
- `src/agents/model-selection-shared.ts` — `resolveConfiguredModelRef` / `buildModelAliasIndex` / `resolveModelRefFromString`
- `src/agents/model-selection.ts` — `resolveDefaultModelForAgent` / `resolveModelThroughAliases` / `resolveSubagentSpawnModelSelection`

**清单合并**
- `src/agents/models-config.merge.ts` — `mergeProviderModels`（写 models.json 时的字段级 merge）
- `src/agents/models-config.plan.ts` — `planOpenClawModelsJson`
- `src/agents/model-catalog.ts` — `loadModelCatalog`（给 RPC 的最终合并）
- `src/agents/model-catalog.types.ts` — `ModelCatalogEntry`（RPC 输出窄版 schema，9 字段）

**Schema**
- `src/config/zod-schema.core.ts:318-413` — `ModelDefinitionSchema` / `ModelProviderSchema` / `ModelsConfigSchema`
- `src/config/zod-schema.agent-defaults.ts:65-79` — `AgentDefaultsSchema.models`（白名单 entry 4 字段 strict）
- `src/config/zod-schema.ts:660` — 顶层 `models` 字段挂载点
- `src/config/schema.help.ts:1076-1081` — 白名单字典 key 语义文本

**RPC / Gateway**
- `src/gateway/server-methods/models.ts` — `models.list` RPC、view 模式、750ms 超时
- `src/gateway/server-model-catalog.ts` — readOnly / full 两套 cache
- `src/gateway/server-reload-handlers.ts` — `markGatewayModelCatalogStaleForReload`

**凭据**
- `src/agents/auth-profiles/store.ts` — `ensureAuthProfileStoreWithoutExternalProfiles`（main 兜底浅合并的实现）
- `src/agents/auth-profiles/path-resolve.ts:12-15` — `resolveAuthStorePath(agentDir)` = `path.join(agentDir, "auth-profiles.json")`；**`agentDir` 预期是含 `/agent` 子目录的完整路径**（如 `<state-dir>/agents/main/agent`），不是上一层
- `src/agents/auth-profiles/types.ts:25-53` — `ApiKeyCredential` / `TokenCredential` 字段对照（api_key 无 expires + 含 metadata；token 有 expires + 无 metadata）
- `src/plugins/provider-auth-helpers.ts:114-134` — `upsertApiKeyProfile` 同步返回 profileId（默认 `<provider>:default`）
- `src/agents/auth-profiles/profiles.ts:147-188` — `removeProviderAuthProfilesWithLock` 实现，**只清 secret 不清 cfg 声明**
- `src/gateway/config-reload-plan.ts:48-127` — gateway reload 规则表，`auth.*` 整段不在 hot-reload 白名单 → 默认走 restart

**Plugin SDK 入口**（区分 App SDK / Plugin SDK 与 import 路径见 [plugin-sdk-and-runtime.md](plugin-sdk-and-runtime.md)）
- `openclaw/plugin-sdk/provider-auth` — `upsertAuthProfile` / `upsertAuthProfileWithLock` / `upsertApiKeyProfile` / `writeOAuthCredentials` / `applyAuthProfileConfig` / `buildApiKeyCredential` / `buildTokenProfileId` / `removeProviderAuthProfilesWithLock` / `listProfilesForProvider` / `ensureAuthProfileStore` / `ensureAuthProfileStoreForLocalUpdate` / `updateAuthProfileStoreWithLock` / `formatApiKeyPreview`（遮蔽显示）
- `openclaw/plugin-sdk/config-mutation` — `mutateConfigFile` / `replaceConfigFile` / `updateConfig`

**SDK 签名要点**（实测踩坑后修订）：
- `upsertApiKeyProfile({ provider, input, agentDir?, profileId?, options?, metadata? }): string` —— **同步**返回 profileId；`agentDir` 预期含 `/agent` 子目录
- `removeProviderAuthProfilesWithLock({ provider, agentDir? }): Promise<AuthProfileStore | null>` —— 只清 `auth-profiles.json`，**不动 cfg.auth.profiles**
- `ensureAuthProfileStore(agentDir?, options?): AuthProfileStore` —— **位置参数**（不是 object params）
- `listProfilesForProvider(store, provider): string[]` —— 返回 profileId 数组，按 provider 维度过滤

**某测试环境实测事实**（2026-05-13）
- openclaw v2026.5.7（npm 全局装）
- 92 个 bundled plugins
- `plugins.entries` 只显式写了 `openai` 和 `openclaw-coclaw`
- `agents.defaults.model.primary = "openai-codex/gpt-5.5"`
- `auth.profiles["openai-codex:default"]` OAuth 模式
- 顶层 `models.providers` 字段不存在（全靠插件自带清单）
- `models.json` 里有 stale 残留 `codex` provider（来自历史版本，OpenClaw 不主动清理）

## 附录 D：provider 清单的三处来源对照（CoClaw UI 视角）

> 2026-05-13 追加。本附录解释"想拿一份完整 provider 列表"时三条数据源的差异，以及实测出的数量对照；供后续需要扩展 provider UI 时参考。

### D.1 三条数据源 + 实测数量（v2026.5.7，实测环境）

| 来源 | provider 数 | 含意 |
|---|---|---|
| `models.list view:"all"` RPC | **37** | runtime 已加载的（PI SDK 内置 + plugin 静态 catalog + 已成功 discovery 出来的）；漏掉所有"被动激活但还没激活"的 provider |
| 扫盘 manifest（`<openclawInstallDir>/dist/extensions/<id>/openclaw.plugin.json`） | **62** | OpenClaw 已装 bundled 插件声明的所有 provider id，**包括未激活的本地服务 / CLI 复用类**（qwen / ollama / lmstudio / claude-cli / google-gemini-cli / minimax / kimi / 阿里系 等） |
| `getActivePluginRegistry().plugins` | **0**（无 LLM provider） | 此 registry 装的是已 active 的工具类插件（browser / memory / skill-workshop 等 7-8 个）；LLM provider 走 PI SDK 那条线，**不进这里** |

模型条目数：`models.list view:"all"` 给 994 条（含 OpenRouter / Bedrock / Vercel AI Gateway 这类大宗 catalog），manifest 静态 catalog 只有 256 条——**模型详情必须走 RPC，扫盘 manifest 拿不到**。

### D.2 扫盘 manifest 的做法（如未来需要 provider 全清单）

bundled 插件 manifest 路径：从 `process.argv[1]`（gateway 入口）反推 `dirname(...)/extensions/<id>/openclaw.plugin.json`。安装目录无环境变量约定，用 entry 反推是当前最稳的方式。

manifest 里和 provider 相关的字段（按用途）：

- `providers: string[]` —— 该插件声明的 provider id 列表（如 `["openai","openai-codex"]`）
- `providerAuthChoices[]` —— 该 provider 支持的登录方式枚举，每条含 `provider / method / choiceId / groupId / groupLabel / choiceHint / cliFlag` 等；`method` 是 free-form 字符串，bundled 插件共出现 24 种取值（建议归并五大族：oauth / api-key / token / cli / local）
- `syntheticAuthRefs[]` —— 该插件提供"合成认证" hook 的 provider/cli-backend id（无需用户填 secret 也算"已认证"）
- `nonSecretAuthMarkers[]` —— 占位 marker，写入 `models.providers.<id>.apiKey` 视为有效凭据（如 `ollama-local` / `codex-app-server`）
- `setup.providers[]` —— 新一代字段，含本地凭据探测（aws / gcp adc 用）
- `activation.onStartup` —— 是否启动时即激活；绝大多数 provider 插件是 `false`（被动激活），所以不在 `getActivePluginRegistry` 里

### D.3 注意事项

- **provider id 别名归一化两侧不一致**：`models.list view:"all"` 输出**原始** id（如 `moonshotai`、`xiaomi-token-plan-ams`），manifest 用规范名（`moonshot`、`xiaomi`）。OpenClaw 内部 `normalizeProviderId` 函数有归一化（如 `moonshotai → moonshot`、`modelstudio → qwen`），但 RPC 输出不归一。合并不同源数据时需要先做 alias 对齐
- **`models.providers.<id>.apiKey` 是兼容口子**，写入凭据要走 SDK helper `upsertApiKeyProfile`，不要直写主配置（详见第四节）
- **42 个 manifest 里的 `providerAuthChoices` 总条数 68**——多数 provider 只有 1-2 种登录方式，少数（如 openai 系、google 系、anthropic）有 3-4 种
- **`models.providers` 顶层字段在主配置文件里默认不存在**，所以 `api.config.models?.providers` 在用户没显式配 provider 时是 undefined，不能作为 provider 清单的来源
- **`getCurrentPluginMetadataSnapshot()` 是 OpenClaw 内部模块的私有状态**（不挂全局 Symbol），插件直接 import 受 exports map 阻挡，且文件路径在 dist 中带 hash 后缀，不要直接依赖

### D.4 一期决策（2026-05-13 / CoClaw v0.21.x）——已被 D.5 取代

> **已被 D.5 取代（2026-05-31）**：provider 选择 UI 改用 `coclaw.providerAuth.catalog`（setup 模式 provider 解析、全集），**不再**用 `models.list view:"all"` 去重。下文保留作历史背景。

一期 provider 选择 UI **不做扫盘 manifest**，直接用 `models.list view:"all"` + `models.authStatus`：

- 拿到的 37 个 provider 对当前需求够用（CoClaw 一期只要支持 MiniMax 的 OAuth；其它能选已经够多）
- 漏掉的 25 个被动激活类（qwen / ollama / lmstudio 等）等需要扩展时再加扫盘 fallback
- displayName 缺失（覆盖率 ~3%）的暂时不修，缺的 ~36 个 provider 在 UI 端建本地英文映射表（不进 i18n 包，OpenClaw 自家也都英文）

未来需要扩展时（如要把"被动激活"的 provider 也呈现给用户选），按 D.2 的扫盘做法加上即可，本附录是契约速查。

### D.5 provider 全集 + 认证方式：CoClaw `providerAuth.catalog` 口径（2026-05-31）

> 取代 D.4 的"用 `models.list view:"all"` 去重"旧决策——前端列 provider 不再拉重型全量 models。CoClaw 插件 RPC `coclaw.providerAuth.catalog` 改用 setup 模式 provider 解析一次拿全集，契约见 plugin `model-config-api.md` § 2.7。本节记口径与边角排除规则（**心智模型层**）。

**数据源 = setup 全集**：`resolvePluginProviders({ mode:'setup', activate:false, cache:true })` 返回**全部 provider（含从没配过的）**，每项带 `auth[]`（元素含 `kind`）。setup 全集口径 = **bundled provider + 受信/已激活的 workspace owner**（未受信 workspace 插件被过滤）；对每个 bundled 插件无条件 eligible，与 config / auto-enable 无关 → **零配置新机也成立**。比 D.1 的 `view:"all"`（仅"已加载"provider、原始拼写、不带认证方式）更全、更贴前端所需维度。

**只露三种认证方式（一条规则，零特判）**：按 `auth[].kind`（`oauth | api_key | token | device_code | custom`）映射——

| kind | 露出 | 边角口径 |
|---|---|---|
| `api_key` | `api-key`（输 key） | |
| `device_code` | `oauth-device-code`（设备码登录） | `minimax-portal` 即此类 |
| `oauth` | `oauth-login`（列出但"暂不支持"，回环 localhost 远端 UX 太重） | |
| `token` | **不露** | **anthropic 的"贴 token"刻意不露**（避免诱导第三方 OAuth 封号风险）；anthropic 的 `api-key` 正常露 |
| `custom` | **不露** | **本地 / 代理 / CLI**（ollama / lmstudio / vllm / 各 proxy / anthropic cli）无需凭据录入面 |

**provider 仅在露出的 authMethods 非空时进列表**，于是这几类**自然被排除、无需特判**：

- **custom（本地 / 代理 / CLI）排除**：它们无需凭据、理论上本应自动出现在可用清单里；是否放开"列出"留作后续次要项。
- **纯 env（空 `auth[]`，如 groq 只认环境变量）暂不列、暂不处理**（将来或简化处理，记一笔）。它的模型照样进可用清单可选可用（OpenClaw 认 env、CoClaw 读其清单），只是不进"加 provider"列表——加不进对（已配过），不在凭据管理列表显示也对（CoClaw 本就不管 env 凭据），三处行为全对。
- **token-only**：同上自然排除。

**`hasCred`（是否已配，供加 provider 排除）= 账本 / 内联 / env 三源任一有凭据、别名感知归一基座 id**（同 § 4.10 的凭据判定原语；服务端算，UI 拿不到 `resolveProviderIdForAuth`）。

**oauth 范围（实测三家 + 边角）**：minimax-portal（device_code）+ github-copilot（device_code）+ openai-codex（device_code）露 `oauth-device-code`；google-gemini-cli（oauth-only）/ openai-codex 的 oauth 方法 / xai 的 oauth 方法露 `oauth-login`（"暂不支持"，回环-PKCE 远端要贴回 redirect URL）。anthropic OAuth 出局（上游封禁第三方）→ 只剩 api-key。

## 附录 E：API key 配置流程（CoClaw 视角端到端 SOP，实测 2026-05-14）

> 本附录记录 CoClaw 写 API key 的实务路径。背景与设计取舍见第四节 4.7-4.8。本附录是给 plugin 实现者 / 代码 review 时的速查。

### E.1 三个 RPC handler 的关键调用

CoClaw 插件需要注册三个 gateway method（参考现有 `coclaw.*` 命名）：

#### `coclaw.providerAuth.setApiKey({ provider, apiKey })`

```js
import {
  upsertAuthProfileWithLock,
  buildApiKeyCredential,
} from 'openclaw/plugin-sdk/provider-auth';
import { mainAgentDir } from './claw-paths.js';  // CoClaw 已有

// handler 内
const profileId = profileIdInput ?? `${provider}:default`;
const credential = buildApiKeyCredential(
  provider,
  apiKey,
  undefined,
  { secretInputMode: 'plaintext' },
);
const result = await upsertAuthProfileWithLock({
  profileId,
  credential,
  agentDir: mainAgentDir(),       // 含 /agent 子目录
});
// 关键：SDK 内部 try/catch 把锁失败 / 磁盘错误吞成 null
if (result === null) {
  // → 走 IO_FAILED 错误响应
  throw new Error('failed to write auth-profiles store');
}
return { status: { profileId } };
```

**返回**：`{ status: { profileId } }`，如 `{ status: { profileId: 'groq:default' } }`。`status` 外层包装是本插件 CLI 共享 `callGatewayMethod` 的 wire 约定（见 model-config-api.md § 2.2 末尾告示）。
**副作用**：写 `<state-dir>/agents/main/agent/auth-profiles.json`，**文件级锁保护**——与 `removeProviderAuthProfilesWithLock` 共享同一把锁，避免 set + remove 并发丢写。
**不触发**：gateway 重启、config-reload、`models.json` 派生。

**为什么不用上层封装 `upsertApiKeyProfile`**：该封装内部走同步、**无锁**的 `upsertAuthProfile`，与带锁的 remove 并发时会绕过文件锁丢写。带锁版本与 `buildApiKeyCredential` 配合使用，行为与封装内部完全等价（两次幂等的 `normalizeSecretInput` ≡ 一次）。

#### `coclaw.providerAuth.list({ provider? })`

> ⚠️ **下方片段是早期"只读账本"形态，已演进为三源合并**（账本 + 内联 + env，每条带 `source`/`removable`，见第 22 条 + plugin `model-config-api.md` § 2.4）。保留片段示意账本侧遮蔽规则；完整三源契约以插件 doc 为准。

```js
import { ensureAuthProfileStore, formatApiKeyPreview } from 'openclaw/plugin-sdk/provider-auth';

const store = ensureAuthProfileStore(resolveMainAgentDir());  // 位置参数
const entries = Object.entries(store.profiles || {})
  .filter(([id, cred]) => !provider || cred.provider === provider)
  .map(([id, cred]) => ({
    profileId: id,
    provider: cred.provider,
    type: cred.type,                            // "api_key" / "token" / "oauth"
    keyPreview: cred.type === 'api_key' && typeof cred.key === 'string' && cred.key.length > 0
      ? formatApiKeyPreview(cred.key)            // head4 + ... + tail4
      : undefined,
    email: typeof cred.email === 'string' ? cred.email : undefined,
    displayName: typeof cred.displayName === 'string' ? cred.displayName : undefined,
    expiresAt:                                   // ms epoch；只 oauth / token 才暴露
      (cred.type === 'oauth' || cred.type === 'token') && typeof cred.expires === 'number'
        ? cred.expires
        : undefined,
  }));
return { status: { profiles: entries } };
```

**返回**：包成 `{ status: { profiles: [...] } }`——同 setApiKey，wire 约定（见 model-config-api.md § 2.2 末尾告示）。

**遮蔽规则**：原始 `key` / `token` 字段**绝对不出 handler**；只回 `keyPreview`。OAuth credential 的 refresh token / access token 也不外露。

#### `coclaw.providerAuth.remove({ provider })`

```js
import { removeProviderAuthProfilesWithLock } from 'openclaw/plugin-sdk/provider-auth';
import { mainAgentDir } from './claw-paths.js';

const result = await removeProviderAuthProfilesWithLock({
  provider,
  agentDir: mainAgentDir(),
});
// 同 setApiKey：锁失败 / 磁盘错误吞成 null
if (result === null) {
  // → 走 IO_FAILED 错误响应
  throw new Error('failed to update auth-profiles store');
}
// 协议层 respond(true, { status: {} })；不带 ok 字段（见 model-config-api.md § 6.6）。
// 出参必须包 status 包装层、且非 undefined——见 model-config-api.md § 2.2 末尾告示
```

**只清 secret**，主配置文件不动。**幂等**：撤销不存在的 provider 不报错。

### E.2 已知坑速查（实测踩过的）

| # | 坑 | 怎么避 |
|---|---|---|
| 1 | `agentDir` 传 `<state-dir>/agents/main` 时 secret 写到错位置（`agents/main/auth-profiles.json`，OpenClaw 不读这个） | 传 `<state-dir>/agents/main/agent`（含 `/agent` 子目录）；统一走 `claw-paths.js` |
| 2 | 调 `updateConfig(applyAuthProfileConfig)` 写 cfg → gateway 全量重启，所有 chat / agent run / P2P 中断 | **别调** `updateConfig`，用 `buildApiKeyCredential` + `upsertAuthProfileWithLock`（带文件锁，与 remove 共享） |
| 2b | 用上层封装 `upsertApiKeyProfile`（无锁、同步） → 与带锁的 remove 并发时丢写 | 走带锁版 `upsertAuthProfileWithLock`，与 `removeProviderAuthProfilesWithLock` 共享同一把文件锁 |
| 2c | 带锁版 helper 失败时**静默返回 `null`**（内部 try/catch 吞错），不抛异常 | handler 必须 `if (result === null) → IO_FAILED`；切勿把 null 当成功 |
| 3 | `ensureAuthProfileStore({ agentDir })` 抛 `input.trim is not a function` | 改成位置参数：`ensureAuthProfileStore(agentDir)` |
| 4 | `models.authStatus` 查不到刚配的 api_key provider | 这是设计如此——api_key 不在 refreshable 列表。UI 走插件自己的 list RPC（见 E.1） |
| 5 | UI 想刷新 OAuth provider 状态时拿到旧缓存 | `models.authStatus` 传 `{ refresh: true }` 旁路 60s TTL |

### E.3 主线核验脚本（必要时复刻）

实测脚本位于 `/tmp/coclaw-apikey-exp/`（ephemeral，已删）：

- `experiment.mjs` — 端到端 set / read / remove / cleanup 五阶段
- `verify-no-cfg.mjs` — 关键对照：只写 secret 不写 cfg，确认 gateway 不重启 + OpenClaw CLI 仍识别
- 使用方式：在与 OpenClaw npm 全局包同 node 环境下，从含 `node_modules/openclaw -> 全局包` 软链的目录运行；用 dummy provider id（如 `groq`） + fake key（`sk-test-coclaw-DELETE-ME-*`）避免污染真实凭据
- baseline 校验：脚本前后 `md5sum ~/.openclaw/agents/main/agent/auth-profiles.json` 应一致；`~/.openclaw/openclaw.json` 允许 `meta.lastTouchedAt` 单行变化（其它字段须一致）

### E.4 与上游 CLI（`models auth paste-token` / `models auth login`）的差异

| 维度 | OpenClaw CLI | CoClaw 插件 |
|---|---|---|
| 触发场景 | 装机 / onboarding，一次性配 | 长期运行 UI 中随时配 |
| 写 cfg.auth.profiles | 是（两步） | 否（只动 secret） |
| 触发 gateway 重启 | 可以接受（用户在 CLI 端能感知） | 不能接受（UI 端用户感知为"系统故障"） |
| 主要 helper | `upsertAuthProfile` + `updateConfig(applyAuthProfileConfig)` | `buildApiKeyCredential` + `upsertAuthProfileWithLock`（带锁、与 remove 共享） |

**结论**：CoClaw **不抄** CLI 模板，因为运行环境约束不同。设计取舍记录在 4.7。

---

## 附录 F：能否让扫码 provider（minimax-portal）白嫖内置 catalog 模型清单？（2026-05-27 调研 + 决策）

> 问题：CoClaw 给扫码/token-plan provider `minimax-portal` 维护一张**硬编码**模型表写进 config（`plugins/openclaw/src/provider-auth/portal-model-catalog.js`），登录 + 启动对账时写入。能不能改成**运行时从 OpenClaw 自带 catalog 白嫖**、免维护、自动跟上游同步？
> 结论：**部分可行，但救不了关键字段（maxTokens），决定暂保留硬编码表**。下面是钉死的机制 + 决策依据，全部真机/源码核实。

### F.1 `view:'all'` 是凭据无关的"全宇宙目录"

- `models.list` 的 `view` 合法值只有 `default` / `configured` / `all`（`openclaw-repo/src/gateway/protocol/schema/agents-models-skills.ts:198-205`；`available` 等非法）。
- `view:'all'` 走 `loadGatewayModelCatalog({readOnly:false})` 后**原样返回**，跳过 `default`/`configured` 才跑的可见性/凭据过滤 `resolveVisibleModelCatalog`（`src/gateway/server-methods/models.ts:84-85` 直返 vs `88-96` 过滤）。
- **实测**：把 `minimax`/`minimax-cn` 的 api-key 凭据从 auth-profiles 删光（env / openclaw.json 也无 key）后重启，`view:'all'` 里它俩仍各出 2 条（带 `contextWindow:204800 / reasoning:true`）。即 **view:'all' 出不出某模型与凭据无关**。

### F.2 catalog 三来源里，谁不靠凭据

`loadModelCatalog`（`src/agents/model-catalog.ts:317`）合并三源（与 §1.2 / 附录 D 同，这里补"凭据"维度）：

1. **pi-ai 出厂字典** `@mariozechner/pi-ai/dist/models.generated.js`，经 `instantiatePiModelRegistry().getAll()`（model-catalog.ts:371-418）——**纯静态、不靠任何凭据**。`minimax`(块 @5874) / `minimax-cn`(@5910) 的 M2.7 两条就在这。
2. provider 插件 augment（`augmentModelCatalogWithProviderPlugins`，仅 `readOnly:false` 才跑）——**凭据门控**：minimax 的 `resolveApiCatalog` 解不到 key 就 `return null`。
3. config 里 `models.providers.*`（`buildConfiguredModelCatalog`）。

→ **minimax/minimax-cn 无凭据照出，是因为它们在 pi-ai 字典里（源1）；minimax-portal 不在字典、注册时也不声明静态 models（OAuth 成功写 `models:[]`），只能靠源3（写 config）。** 这就是不对称的根。

### F.3 插件运行时能怎么拿这份 catalog

- **主路径**：`import('openclaw/plugin-sdk/agent-runtime')` → `loadModelCatalog({config})`。该子路径在安装的 dist 里确有导出（`dist/plugin-sdk/agent-runtime.js` re-export `loadModelCatalog`；`package.json` exports 含 `./plugin-sdk/agent-runtime`，是 295 个 plugin-sdk 子路径之一）。插件内已有同源用法：model-default handler 调 `buildModelsProviderData(cfg, undefined, {view:'all'})`（`openclaw/plugin-sdk/models-provider-runtime`）。
- **必须 `readOnly:false`**：readOnly 路径只读磁盘 `models.json`（派生缓存，不含 pi-ai 内置）+ manifest 静态目录，**不调 pi-ai 字典**（model-catalog.ts:245-315）→ readOnly 拿不到 minimax。
- **保底路径**：插件向 gateway 发 `models.list {view:'all'}` RPC（同源、效果同主路径）。

### F.4 致命限制：maxTokens 拿不到（承重点）

- `loadModelCatalog` 把 pi-ai 条目映射成目录条目时**只保留 `{id,name,provider,contextWindow,contextTokens,reasoning,input,compat}`，丢掉 `maxTokens` 和 `cost`**（model-catalog.ts:408-417）。这是在 **catalog 构建层**就丢，不只是 §5.4 说的 RPC 投影层——所以 §5.4 的"绕过 RPC 直读主配置"补救只对**已写进 config 的 provider** 管用，对 `minimax`/`minimax-cn` 这种**纯内置 provider** 仍拿不回 maxTokens。
- 其它入口也给不了：`plugin-sdk/minimax` 只导出 model ids（`MINIMAX_TEXT_MODEL_REFS`）无 maxTokens，且**不是合法 dist 子路径**。
- 即 pi-ai 源数据本身写着 `maxTokens:131072`（models.generated.js minimax 块），但**没有任何 sanctioned 运行时 API 能把它取出来**。

### F.5 为什么 maxTokens 不能丢（16x 截断）

- config 里某模型缺 `maxTokens` 时，OpenClaw 归一化填 `min(DEFAULT_MODEL_MAX_TOKENS, contextWindow)`，而 `DEFAULT_MODEL_MAX_TOKENS = 8192`（`src/config/defaults.ts:45` 定义、`:209-211` 填充）。
- minimax-portal 真实 maxTokens=131072。若白嫖目录不补 maxTokens → 单次最大输出被钉死 **8192**（16x 截断，长回复被砍）。**所以 maxTokens 必须显式写死**——这条把"彻底零硬编码"判了死刑。

### F.6 结论 + 决策（2026-05-27）

- **彻底"零硬编码"做不到**：maxTokens 取不到、缺了又 16x 截断 → 必须本地写死一个常量；登录那一刻目录若偶发取不到，还需种子兜底。
- 能做的最多是"半白嫖"：`list + name + reasoning + contextWindow` 从 catalog 自动同步（新模型 / 上游升级自动跟上），`maxTokens` 用本地常量补、空时回退种子。
- **当前决策：暂保留现有硬编码表**。理由：既然无法完全去硬编码（maxTokens + 种子都省不掉），"半白嫖"带来的边际收益（MiniMax 出新模型时不发 CoClaw 版本就能自动出现）不足以抵其新增的运行时依赖 + 兜底分支 + 测试复杂度。MiniMax 加模型频率极低，手动更新那张表即可。
- **重评触发条件**（写进 `/check-openclaw-compat` 必查项 K，升级时核）：上游把 maxTokens 纳入 catalog 输出 / 出 sanctioned API；或 pi-ai 字典新增 `minimax-portal`；或 `DEFAULT_MODEL_MAX_TOKENS` 抬高到 ≥ minimax 真实值。任一成立则重启"半白嫖"评估。
