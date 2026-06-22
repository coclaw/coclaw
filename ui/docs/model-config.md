# 模型配置（UI 侧）

> 创建时间：2026-05-25（2026-05-31 补 OAuth 设备码 UI 流 + catalog 驱动加 provider + 去 view:all）
> 状态：已实施（过程稿，完结归档；当前真相以代码为准）
> 范围：CoClaw UI 端"模型配置"功能的产品定义与 UX 设计，覆盖 API key 凭据管理 + **OAuth 设备码登录** + 默认主模型设置
> 前置依赖：`plugins/openclaw/docs/model-config-api.md`（API 契约；provider 目录 `providerAuth.catalog` § 2.7、可用清单 `model.listAvailable` § 3.2.1）
> 不含：oauth-login（回环-PKCE，列出但"暂不支持"）、per-agent 主模型覆盖、白名单、多账号顺序

---

## 一、概述

### 目标

让 CoClaw 用户在 UI 端完成两件事：

1. 给某台 claw 配 / 撤 LLM provider 的 API key
2. 给某台 claw 设默认主模型

让 agent 真正能跑起来。

### 核心设计原则

- **按 claw 维度组织**：凭据与主模型在 plugin 后端就是 claw 维度（写到该 claw main agent 的 `auth-profiles.json`），UI 沿用相同心智，避免"全局 vs 单 claw"心智分裂
- **移动端优先**：所有页面先解决移动端体验，桌面端在移动版基础上扩出更宽布局
- **首次接入零摩擦**：用户绑完 claw 后能被主动引导到"配 key"路径，不需要靠"试着 chat 失败"反推
- **低频写、按需读**：写操作（设 key / 撤 key / 设主模型）一次性进入"设置子页"完成；读操作分两层——标识级数据进 dashboard 聚合，详情数据由子页按需即拉

### 不做项（明确否决）

- ✅ OAuth **设备码**登录入口（2026-05-31 落地，见 § 5.5）；oauth-login（回环-PKCE）类**列出但点开"暂不支持"**——刻意列出免得日后忘了这个坑
- OAuth 类型 profile 在凭据列表中展示（挂 `oauth` 徽章）+ 可撤销（"有凭据即可撤销"，纯看 `removable`）
- ❌ per-agent 主模型覆盖（后端 API 已支持，UI 本期不暴露；多数用户一台 claw 用同一偏好）
- ❌ fallback 链维护（后端不做，UI 也不暴露）
- ❌ 多模态模型字段（image / video / pdf 等）
- ❌ provider key 探活（设完 key 不主动调 provider API 验证；首次用模型时自然 fail）
- ❌ 模型 alias / 自定义模型条目
- ❌ 多 profile（同 provider 多账号）——一期 profileId 统一 `<provider>:default`

---

## 二、核心术语

| UI 术语 | 含义 |
|---|---|
| claw | 一台远端 OpenClaw 实例（一个 claw = 一组凭据 = 一份默认主模型） |
| provider | 模型供应商（anthropic / openai / groq / deepseek 等） |
| 主模型 | 该 claw 的默认主模型（`<provider>/<model>` 形态） |
| 凭据 | 该 claw 已绑的 provider 凭据（一期只有 API key 类型） |

---

## 三、信息架构

### 入口

`ManageClawsPage`（`/claws`）每个 claw 卡片上加一个「模型设置」按钮，点击进入该 claw 的模型设置子页。

**按钮形态与位置**：作为齿轮 icon button（`i-lucide-settings`），放在 claw 名旁边，与现有"重命名"笔形 icon button（`i-lucide-pencil`）视觉对齐——形态轻、不挤占现有"解绑"按钮所在的右侧区域。仅在 claw 在线时启用。

### 子页路由

```
/claws/:clawId/models
```

- 标题：「模型设置」
- 路由 meta：`hideMobileNav: true` + `requiresAuth: true`（按 mobile-subpage 规范）
- 作用域：只管这一台 claw（凭据 + 默认主模型）
- 落点：在 `src/router/index.js` 的 `AuthedLayout` 子路由中加 `path: 'claws/:clawId/models'`、`name: 'model-config'`、`component: ModelConfigPage`；claw 在线性由 page 自行检查（参考 FileManagerPage 现状）

### 桌面端归属表达

- 侧栏「我的 Claw」入口在进入模型设置子页时**保持 active 高亮**——让用户清楚知道"我还在 Claws 这个大区块下"
- 实现层面：`MainList` 的"我的 Claw" 项高亮判定由"路径精确匹配"扩成"路径前缀匹配"——当 `currentPath === '/claws'` 或 `currentPath.startsWith('/claws/')` 时高亮
- 范围效应：`/claws/:id/models`、`/claws/add`、未来其它 `/claws/...` 子路径都会高亮「我的 Claw」，行为统一可预测。这是 bonus，不视作"超出本期范围"

> 范围说明：本期只给模型设置子页做这件事。FileManagerPage / AddClawPage / AboutPage 等其它二级页面的同类高亮缺失留作 TODO，后续对齐。

### 桌面端返回

桌面端在子页顶部 header 左侧加一个返回按钮（`i-lucide-arrow-left`）。

**返回行为统一走 back() + fallback**：

```
if (history.state?.back) router.back();
else router.replace(fallback);   // 模型设置子页的 fallback = '/claws'
```

- 复用 `MobilePageHeader` 的现有 4 行逻辑，抽成 helper（如 `utils/nav-back.js`），让两端共用并支持 fallback 参数化
- 用 back() 不用固定 push，是因为"从 chat 进 → 返回回 chat / 从 /claws 进 → 返回回 /claws"才是用户预期的自然行为
- fallback 处理 Electron / Capacitor 冷启动直进 deep link 的边界

---

## 四、子页面结构

页面从上到下两大区块：

### A. 默认主模型区（顶部）

**已配状态**：

```
┌────────────────────────────────────────┐
│ 默认主模型                              │
│                                         │
│  groq / llama-3.3-70b-versatile  [更换] │
└────────────────────────────────────────┘
```

**未配 / 失效状态**（橙色提示条）：

```
┌────────────────────────────────────────┐
│ ⚠ 未配主模型,agent 无法对话             │
│                                         │
│  [选择主模型]                            │
└────────────────────────────────────────┘
```

"失效"定义:当前 primary 字符串对应的 provider 已被撤销,或对应 model 不在可用清单里（二者由 `listAvailable.byProvider` membership 一次判定，见下）。判断由前端计算属性在可用清单 + primary 双就绪时算出。

**为什么 UI 能判"失效"（有据可依）**：判定标准与**插件 `coclaw.model.set` 接受一个主模型时的校验同源**——插件写入 primary 时会拒绝"provider 无可用凭据"或"model 不在干净目录"的值（见 `plugins/openclaw/docs/model-config-api.md`）。故凡已落库的 primary 写入时一定满足；UI 只是在子页加载 / 选择器关闭后判它"现在是否仍成立"。

**判定数据源（2026-05-31 改）**：用 `coclaw.model.listAvailable` 的 `byProvider` membership——`primary = <provider>/<model>` 是否落在 `byProvider[provider]` 里。一次判了"provider 有没有凭据"+"模型还在不在目录"两件（可用清单 = 干净目录 ∩ 别名感知凭据），比旧的"`providerUsable` 信号 + `models.list view:"all"` 全量目录比对"更准，且**去掉最后一个 view:all 消费点**。

**实现方式 = 计算属性（决策4，红线级偏好）**：primary 有效性做成一个计算属性，输入 = {可用清单 `listAvailable.byProvider`, 当前 primary}，**两者皆为必须项**，两者就绪才算出"是否警告 + 警告类型"；任一未就绪 → 自然算不出警告（不误报），**无需手写时序门**（不再用 `!loadOk.catalog→effective` 保守门那套 epoch/loadOk 过度保护，已删）。关键一条：membership 把"清单还没到"当成**"先不下结论"，不是"不在清单里"**——否则清单未到时会把所有 primary 误判失效。**这"双就绪才判"本身即承担了"写后刷新失败"的反误报**（清单陈旧/未到 → 算 null，不拿旧信号误报失效）；旧的 `credSignalFresh` 单独 guard 已随计算属性化**删除**（`computePrimaryEffective(primary, available)` 现只这两个入参）。

### B. API 凭据区（下方）

每行一个凭据，**跨三种来源**（`source`，见 plugin `model-config-api.md` § 2.4）——根治"模型能用却显示没配 key"：

```
┌──────────────────────────────────────────────────────┐
│ API key                                     [+ 添加]  │
├──────────────────────────────────────────────────────┤
│ Groq                      gsk_xxxx…ABCD       [撤销]  │  ← 账本(本平台添加/扫码;不打标签)
│ minimax     [配置文件]    sk-mm…1234          [撤销]  │  ← 内联(openclaw.json 手写)
│ openai      [环境变量]    去主机移除           [撤销]  │  ← env(灰显+禁用)
└──────────────────────────────────────────────────────┘
```

- 每行：provider 名 + **来源小标签（仅 inline/env：`配置文件` / `环境变量`；账本 profile 是默认存储、不打标签）** + keyPreview(头 4 + … + 尾 4) + 撤销动作。【2026-05-28 拍板：profile 不打标签——新用户多只有 profile 源、全程看不到标签，负担最低；列表不分组】
- **来源决定可撤性**（`removable`）：账本 / 内联可撤；**env 不可撤**（在 OpenClaw 主机进程环境里，插件改不了）——该行灰显、撤销按钮禁用，次行提示"到 OpenClaw 主机移除"
- 同一 provider 可多来源并存（如账本 + 内联各一份），各自独立成行、撤销互不影响。**注（2026-05-31 修订）**：本列表**回归纯凭据管理**——只管**展示 + 撤销**。两件曾搭在它身上的事都已搬走：picker 可选性吃可用清单（`coclaw.model.listAvailable`，见 §7.1 / §7.3）；「加 provider」排除已配吃 `coclaw.providerAuth.catalog` 的 `hasCred`（见 §5.2 / §7.3）
- **OAuth 类型行挂 `oauth` 徽章**（`profile.type === 'oauth'`）：徽章字面量 `oauth` **不进 i18n**（品牌/类型词不翻译），容器用 `items-end` 让徽章底边与同行文字底边对齐。撤销纯看后端 `removable`（"有凭据即可撤销"，本地删可经 CoClaw 重登回来；**删旧 `COCLAW_OAUTH_PROVIDERS` 白名单 gate**）
- **env 行的列出范围待定（#3 挂起）**：env 是否在此成行是**纯展示口径**问题——模型可选性已由可用清单（`coclaw.model.listAvailable`）解决（env 模型照样能选），env 成不成行不再影响可用性。具体口径见 dump「方案 TODO」+「方案修订」
- 列表为空（账本 + 内联皆空）时显示提示:"还没配任何 provider,先添加一个 API key"
- 「+ 添加」打开"添加 provider"流程（已配 provider——含内联/env——从可选列表剔除，避免再加一份低优先级、不生效的 key）

---

## 五、关键流程

### 5.1 首次接入主路径

```
新用户绑完 claw
  → ManageClawsPage 该 claw 卡片显示橙条「未配 API key,agent 无法对话」+「去配置」
  → 点击进入 /claws/:id/models
  → 「+ 添加」选 provider(搜索 + 列表，catalog 全集中 hasCred===false 的可加项)
  → 输入 API key(密码 input)+ 可选「去 provider 官网拿 key」链接
  → 提交,凭据列表刷新
  → 上方"默认主模型区"自动检测:还没设主模型 → 提示「请继续选主模型」
  → 点「选择主模型」打开模型选择器
  → 选完即保存
  → 返回 ManageClaws → 该 claw 橙条消失（/claws 不再拉全量目录，AgentCard 不再显示模型名徽章，见 §7.2）
```

### 5.2 添加 provider 流程（细化）

**形态钉死：单 dialog 内 stepper 切换**——使用 Nuxt UI 4 的 stepper 模式，next/prev 按钮在 dialog 底部切换两个 step。取消行为统一：任意 step 点「取消」直接关闭整个流程，不退回 Step 1，避免"取消是退一步还是退出"的二义性。Step 2 提交成功后自动关闭整个 dialog。

**Step 1 选 provider**（移动端为 bottom sheet 全屏，桌面端为模态）：

```
┌────────────────────────────────────────┐
│ 选择 provider              [取消]       │
│                                         │
│ [🔍 搜索 provider...           ]        │
│                                         │
│ ─ 常用 ────────────────────             │
│  ○ anthropic       Claude               │
│  ○ openai          GPT                  │
│  ○ google          Gemini               │
│  ○ groq            Llama (托管)         │
│  ○ deepseek                             │
│  ○ moonshot                             │
│ ─ 其它 ────────────────────             │
│  ○ ...                                  │
└────────────────────────────────────────┘
```

- 列表数据源：`coclaw.providerAuth.catalog` 返回的 provider 中 **`hasCred === false`** 的那些（即"还没配过、可加"的）；不再从 `models.list view:"all"` distinct provider 取（已去 view:all）
- **排除已配 provider 用别名归一名（修订 6，#8 闭合）**：列表里要排掉用户已有凭据的 provider，排除口径**两侧都按别名基座名归一**（`resolveProviderIdForAuth`，插件侧做——UI 拿不到该函数）。否则套餐用户持 `volcengine` 基座 key，仍被提供去重复加 `volcengine`/`volcengine-plan`。归一后的"已配 provider"集由插件随凭据信号或专门字段给 UI
- "常用"分组的 provider 由 UI 端硬编码（一期人工维护一份"热门 provider"清单，按用户分布 + 国内外平衡选取）
- displayName 由 UI 端硬编码映射表给（plugin 端 § 1.2 决策）。**当前无消费点**：模型设置页所有界面（API 密钥列表 / 撤销弹窗 / provider 选择列表 / 主模型选择器）统一直接展示原生 provider id，排序也按 id——映射表只覆盖少数常用 provider，混用 id/品牌名既不一致又是维护负担。displayName 字段保留、不删，待将来真要做品牌名展示时再启用

**Step 2 输入 API key**（移动端为居中 confirm 小卡片、非全屏；桌面端为模态。输 key 步套用项目统一 confirm 弹窗样式，不随 Step 1 全屏）：

```
┌────────────────────────────────────────┐
│ 配置 groq                  [取消]       │
│                                         │
│ API key                                 │
│ [••••••••••••••••              ]        │
│                                         │
│ 还没有 groq 的 API key？                │
│ [去 groq 官网创建 →]                    │
│                                         │
│            [取消]    [提交]              │
└────────────────────────────────────────┘
```

- input type 用 password
- 「去官网创建」链接：UI 维护一份 `provider id → dashboard URL` 映射表，有才显，没有就不显；点击在外部浏览器打开（Electron / Capacitor 用各自的 openExternal API）
- 提交：调 `coclaw.providerAuth.setApiKey({ provider, apiKey })`
- 成功 → 关闭 → 列表刷新（**成功不 notify**：新增项立即出现在凭据列表即反馈）
- 失败 → 表单内显示错误（`INVALID_ARGS` / `IO_FAILED`），错误码映射成本地化的人话

**Step 2 按 `authMethods` 多入口（2026-05-31）**：选中 provider 后，按 `coclaw.providerAuth.catalog` 给的 `authMethods` 渲染对应入口，**零特判（OpenClaw 给什么给什么）**：

- `api-key` → 上面的"输 key"步骤。
- `oauth-device-code` → **设备码登录步骤**（挂 `ProviderOAuthLoginStep` 组件，§ 5.5）。
- `oauth-login` → 列出但点开提示**"暂不支持"**（回环-PKCE 远端要贴回 redirect URL，UX 太重）。
- **device-code 在场时隐掉 oauth-login**：同一 provider 同时给 `oauth-device-code` + `oauth-login` 时只留 device-code——cb 我们暂不支持，留着只会多出一个点了即"暂不支持"的死入口；对用户而言两种 OAuth 都是"开页授权"、无需暴露差异。故 openai-codex（api-key + code + cb）塌成 **api-key + 设备码** 两入口。
- 一个 provider 多方式 → **多个入口并排**让用户选；单方式直达对应步骤。
- **面向用户的文案统一为"账号授权"**（device-code 与 oauth-login 共用同一标签——经上一条过滤后两者永不并排，故同名自洽），流程内展示的码称"授权码"；底层协议键 `oauth-device-code`/`oauth-login` 与机制名"设备码"不变。

### 5.3 换主模型流程

点「更换」/「选择主模型」打开模态：

```
┌────────────────────────────────────────┐
│ 选择主模型                  [取消]       │
│                                         │
│ [🔍 搜索模型...                ]        │
│                                         │
│ ─ groq ────────────────────              │
│  ● llama-3.3-70b-versatile  ← 当前      │
│    llama-3.1-8b-instant                 │
│    mixtral-8x7b                         │
│ ─ anthropic ────────────────             │
│    claude-opus-4-7                      │
│    claude-sonnet-4-6                    │
│ ─ deepseek ────────────────              │
│    deepseek-chat                        │
│    deepseek-reasoner                    │
└────────────────────────────────────────┘
```

- 数据源：吃 `coclaw.model.listAvailable`（原 `listUsable` 改名，双名过渡）返回的 `byProvider`（provider → 可用 modelId，插件侧已 `loadModelCatalog` 干净目录 ∩ 别名感知凭据、无幽灵），按 provider 分组直接出可选项；**不再**用"`models.list view:"all"` ∩ `providerAuth.list`"按原始名取交集（那会漏别名套餐变体，如 `volcengine-plan/ark-code-latest`）。**旧插件兜底已删**（决策1：新 UI 直接要求新插件，不再回退到旧交集）。
- 点击一项即选即保存：`coclaw.model.set({ primary: '<provider>/<model>' })`（其凭据门与选模型器走同一别名感知原语，避免"选得到设不上"）
- 保存成功 → 关闭模态 → 主模型区刷新（**成功不 notify**：主模型区立即变更即反馈）
- 不做"二次确认"——可以再换，无破坏性

### 5.4 撤销 provider 流程

点「撤销」→ 二次确认：

**普通情况**：

```
撤销 groq？
撤销后 groq 的所有模型将无法使用。
[取消]  [撤销]
```

**该 provider 是当前主模型载体的情况**（强提示）：

```
撤销 groq？
当前默认主模型 groq/llama-3.3-70b-versatile 落在 groq 上。
撤销后主模型将失效，agent 无法对话，需要重新选一个主模型。

[取消]  [仍然撤销]
```

判断条件：当前 `model.list.default.primary` 拆出 `<provider>` 等于待撤的 provider（按 provider 段匹配，对内联来源同样适用）。

**内联来源统一处理（2026-05-28 拍板）**：撤内联**不再**加"会从配置文件删 key"那句单独提示——确认弹窗与普通删除一个样。理由：来源已由列表行标签（`配置文件`）表达，弹窗重复且带术语；内联属历史遗留，用户用 CoClaw 配模型后不必再手改 `openclaw.json`，不值得让小白理解"配置文件 vs 账本"之别。主模型载体的强提示**保留**（安全闸）。（底层撤销仍是删 `apiKey` 字段、保留节点其余——见 plugin §2.5 / mental-model §4.9，只是 UI 不再特别说明。）

提交：`coclaw.providerAuth.remove({ provider, source })`——`source` 透传决定后端分派（账本删凭据账本 / 内联删 key 字段；env 行已禁用、不会走到这）。成功 → 凭据列表刷新 + 主模型区刷新（若已失效会自动显示橙条）

**关于撤完后 primary 字段**：UI **不主动**调 `model.set({ primary: null })` 把 primary 清空——保持原字符串留在 cfg 里，让"主模型失效"橙条自然引导用户重选。理由：一是减少额外 RPC 与失败处理；二是用户重选时直接覆盖比"先清空再选"更顺。

### 5.5 OAuth 设备码登录流程（2026-05-31）

provider 的 `authMethods` 含 `oauth-device-code` 时，「加 provider」走设备码登录步骤——新组件 `ProviderOAuthLoginStep`（Options API，不用 `<script setup>`）承载两阶段流，**复用 `claw-connection.js` 的 `request(method, params, {onAccepted, signal})` 两阶段地基，无需新管道**。

**两阶段契约**（见 plugin `model-config-api.md` § 2.3.2 / § 6.16.8）：

- phase-1（`onAccepted`，仅 `status==='accepted'` 帧触发）：`coclaw.providerAuth.loginOauth({provider})` 返回 `{ loginId, verificationUri, userCode, rawText }`。展示顺序为**先授权码（inline 小块 + icon 复制按钮，复制后就地显示"已复制"约 3s，不弹 toast）再授权链接**（多数流程第一步是复制码、再点链接）；结构化字段抠不到时用 `rawText` 全文**兜底渲染**。授权码**已嵌进 `verificationUri` 时不单列**（启发式 `showUserCode`：`verificationUri` 直接子串含 `userCode` 即隐藏，如 minimax-portal；假定码不被 URI 换码，匹配落空只是照常显示、失败安全）。
- phase-2（终态帧，同一请求）：成功 → 通知父级走既有 `refreshAfterWrite` 刷新；失败按 `error.code` 映 i18n——`OAUTH_FAILED` / `OAUTH_TIMEOUT` / `IO_FAILED` / `NOT_FOUND` 各有文案，未知码回退泛化"失败"文案；**`OAUTH_CANCELLED` 不映错误文案**（取消是预期终态、静默退回，不弹 toast）。
- 取消：调 `coclaw.providerAuth.cancelOauth({loginId})`（用登录起记的 claw id 定位，避免切 claw 期间拨错；client waiter 由 `signal` abort 收掉）。
- `loginOauth` / `cancelOauth` 走 DC 直达 plugin；**`loginOauth` 注入 `timeout:0`**（设备码授权窗口长、不设超时），`cancelOauth` 是快速 abort、用常规 `RPC_TIMEOUT`（~60s）。

**oauth-login（回环-PKCE）= 列出但"暂不支持"**：catalog 给 `oauth-login` 的 provider 仍列入口，点开提示"暂不支持"——刻意列出，免得日后忘了这个坑回头纳闷某家为何没列（回环 localhost 回调远端要贴回 redirect URL，UX 太重，搁置）。

notify 走组件内 `useNotify()`（store 不 import nuxt-ui，组件内可用）。

---

## 六、首次引导（ManageClawsPage 外层）

每个 claw 卡片在以下任一条件下显示橙色提示条：

| 条件 | 提示文案 | 动作按钮 |
|---|---|---|
| 无任何可用凭据 | 未配 API key，agent 无法对话 | 去配置 → `/claws/:id/models` |
| 凭据非空但 primary 为空 | 未配主模型，agent 无法对话 | 去配置 → `/claws/:id/models` |
| primary 不为空但失效（provider 已撤 / model 不在可用清单） | 主模型失效，请重新选择 | 去配置 → `/claws/:id/models` |

- 三种状态互斥，按优先级 1 > 2 > 3 选最严重的一种展示
- 仅在该 claw 在线时显示（离线时数据本来就拿不到，不展示）
- 「去配置」即跳模型设置子页
- 「可用凭据」= 自管账本 **或** OpenClaw 配置里的内联 key；判定细节、刻意不覆盖的情形、旧插件处理见 §7.4

### chat 按钮的处理

未配模型 / 已失效时**不禁用** chat 按钮：

- 让用户能进入 chat，发消息时由 plugin / agent 端报错
- ManageClaws 外层的橙条已提供主动引导，禁用 chat 反而让用户困惑"为什么按钮是灰的"
- 移动端不适合 hover tooltip 这种解释方式

---

## 七、数据流

### 7.1 数据来源

```
┌────────────────────────────────────────────────────────────┐
│  plugin (per claw)                                          │
│  ─ coclaw.providerAuth.list      （已配凭据：展示+撤销）    │
│  ─ coclaw.providerAuth.setApiKey                            │
│  ─ coclaw.providerAuth.remove                               │
│  ─ coclaw.providerAuth.catalog   （全 provider+认证方式+hasCred；加 provider 源）│
│  ─ coclaw.model.list             （各 scope 的 primary）   │
│  ─ coclaw.model.set                                         │
│  ─ coclaw.model.listAvailable    （干净目录∩别名感知凭据；可用清单/有效性源；listUsable 过渡别名）│
│  （已去 models.list view:"all"）                            │
└────────────────────────────────────────────────────────────┘
              │
              ▼
┌────────────────────────────────────────────────────────────┐
│  UI                                                         │
│                                                             │
│  dashboard.store（外层用：每 claw 标识级数据）              │
│  ─ hasUsableCredential: boolean   ← model.list 凭据信号     │
│  ─ primaryModel: string | null                             │
│  ─ primaryProviderUsable: boolean ← 只看凭据、不查目录      │
│  （仪表盘只调 model.list 取凭据信号，不拉 catalog/providerAuth）│
│                                                             │
│  模型设置子页（组件 state，按需即拉）                       │
│  ─ profiles: providerAuth.list 全量（凭据区展示/撤销）      │
│  ─ catalogProviders: providerAuth.catalog（加 provider 列表：hasCred + authMethods）│
│  ─ available: coclaw.model.listAvailable.byProvider（选模型器 + primary 有效性）│
│  ─ default: model.list.default                             │
└────────────────────────────────────────────────────────────┘
```

### 7.2 dashboard.store 扩展

`loadDashboard` 并行调 status / usageCost / tts / channels / sessions raw / tools.catalog，凭据相关只多调一条：

- `coclaw.model.list`：派生 `primaryModel` 字符串 + **凭据/有效性判定信号**（见 §7.4；旧插件给不出信号 → 当 false，不再压制）

**`models.list view:"all"` 已彻底移除（2026-05-31）**：橙条判定只看 model.list 凭据信号、不查目录；agent 卡片模型名徽章因 `status.model` 常空本就不显示，故仪表盘不拉它。设置子页原先自拉 view:all 做"模型下架"检测，本轮也改吃 `coclaw.model.listAvailable.byProvider`（§7.3），故**全前端再无 view:all 消费点**，省掉每次拉近千模型的重操作。
凭据列表（子页凭据区）也不在仪表盘拉——子页进入时自取 `coclaw.providerAuth.list`。

**失败处理沿用现有 allSettled 模式**：单条 RPC 失败不影响其它字段；失败时按"未知态"取默认值。外层在这种"未知态"下**不显示橙条**——避免数据拿不到时误报 warning。橙条显隐**与 catalog 解耦**（仪表盘本就不拉 catalog；§7.4）。

写操作完成后，子页主动调 `dashboardStore.loadDashboard(clawId, { force: true })` 重拉一次，让外层一致性自动恢复。

### 7.3 模型设置子页

- 进入页面时**并发四路**（`Promise.allSettled`）：`providerAuth.list`（凭据区展示/撤销）+ `providerAuth.catalog`（加 provider 列表：hasCred + authMethods）+ `model.list`（current default + 凭据信号）+ `coclaw.model.listAvailable`（选模型器 `byProvider` + primary 有效性 membership，干净目录∩别名感知凭据、无幽灵）。**已去 `models.list view:"all"`**——"模型下架"检测改由 `listAvailable.byProvider` membership 承担（§4 / §7.4），不再单拉全量目录。
- **不做旧插件回退（决策1）**：新 UI 直接要求新插件（claw 随插件自动升级，窗口极窄），不再为缺 `listAvailable`/`catalog` 的旧插件留 UI 回退路径。
- 写完任一字段 → 局部更新 state + 触发 `dashboard.store` 重拉（**成功不 notify**：界面变化即反馈）
- 退出页面销毁——不长期占用 store

### 7.4 凭据 / 有效性判定（修订 6：四处统一别名感知原语）

> **修订 6 定稿（取代修订 4/5）**：修订 4 想把判定全挂 OpenClaw"能用集"，被无 auth 门幽灵污染（`openai/gpt-5.5` + imageModel + 残留自定义 provider）"非空"判 noKey 会恒真——已证伪；修订 5 改"选模型器/set 用能用集、/claws 信号用便宜检查"的**分层**，但两套口径不一致会让 IAM-only 用户"选得到却判失效"。**修订 6 收敛成单一原语**：选模型器枚举（`loadModelCatalog` 干净目录 ∩ 别名感知凭据）/ set 门 / providerUsable / noKey **全部基于 `computeProviderUsableByName`（= `isProviderApiKeyConfigured`〔env+账本，别名感知〕∪ 内联）**，杜绝跨界面矛盾、且无幽灵。详见 plugin doc § 3.2.1/§ 3.3/§ 3.4 + memory `reference_openclaw_alias_plan_catalog_and_auth_surfacing`。
>
> 修订背景（历史）：原判定只数「自管账本」一处，漏内联 key，导致老用户被误报「未配 API key」（线上实锤）。已发布修复＝三源信号。

> **2026-05-31 调整（primary 有效性改计算属性 + 去 view:all）**：**primary 有效性**判断从"`model.list.providerUsable` 信号 + `models.list view:"all"` 全量目录比对"**改为前端查 `coclaw.model.listAvailable` 的 `byProvider` membership**（一次判"provider 有凭据 ∧ model 在目录内"），并落成**计算属性**（决策4，§4）。两个连带变化：① **设置子页**不再用 `providerUsable` 判 primary 有效性（改 membership）；但 **`/claws` 仪表盘外层引导仍消费 `default.providerUsable`**（`primaryProviderUsable`，仪表盘从轻、不拉可用清单，§ 7.2）→ 故该字段**保留、非可删**（设计稿曾设想它变"可选清理"，实现保留了仪表盘这条消费路径）；② **`this.catalog`（view:all）目录半保留已删**，不再单拉全量目录守"模型下架"。**`noKey` 信号 `hasAnyUsableCredential` 保留不动**（红线）。

**判定信号由 plugin 计算**，搭在 `coclaw.model.list` 出参回传：

- 「主模型那家可用否」：`<scope>.providerUsable` = `computeProviderUsable(primary)`（别名感知、不读目录；账本里的别名套餐 key 已能正确判 `volcengine-plan` 可用）。与选模型器枚举**同口径**。**注（2026-05-31）**：**设置子页**的 primary 有效性已改用 `listAvailable.byProvider` membership（见上方调整说明），子页不再消费本字段；但 **`/claws` 仪表盘外层引导仍消费 `default.providerUsable`**（`primaryProviderUsable`，§ 7.2）→ 字段**保留**。
- 「这台 claw 有没有可用凭据」（驱动 noKey）：`computeHasAnyUsableCredential` = 账本非空 OR 任一内联 key **OR env key**（修订 6 补 env，与 providerUsable 口径对齐；shipped 实现漏 env，纯 env-only 用户会"选得到却被弹没 key"，故必补）。

**覆盖面（修订 6）**：选模型器 / set / providerUsable / noKey 四处统一覆盖 env+内联+账本+**别名套餐（火山/byteplus/minimax-cn/stepfun）**；**统一漏 IAM/本地**（`hasAuthForModelProvider` 未导出 plugin-sdk，pro 边角 → 可能 spurious noKey/失效橙条，但**不阻断使用**，按"简单优先、可接受 pro 残留"取舍）。**不再有"信号便宜 vs 枚举完整"分层**——同一原语贯穿，四处一致。

**旧插件不再特判（feature-detect-suppress 已移除）**：响应里没有凭据信号字段（旧插件）→ 前端当 false → **该弹 noKey / invalid 就弹**。取舍理由：目标是通过 CoClaw 界面配置的小白用户，主动引导提示本身是产品价值；且 claw 很快会自动升级插件，「新前端 + 旧插件」窗口极窄——这段窗口内旧插件用户短暂再现误报可接受，远好过对小白沉默。

> 历史：早期版本曾按「出参无凭据信号 → 视为旧插件 → 压制 noKey/invalid」做 feature-detect-suppress（宁可少提示不可误报）。后因「宁可放过不误报」与小白引导价值冲突而废弃——见 commit 历史。子页「写完设置后那次后台刷新失败」的反误报保护是**另一回事**（不拿写入前的旧凭据信号误报失效）——2026-05-31 起由 primary 有效性**计算属性**天然承担（可用清单 + primary 双就绪才判、未就绪算 null），旧的 `credSignalFresh` 单独标记已随之**删除**（见上 §7.4 调整说明）。

**仪表盘不查目录**：主模型「灵不灵」只看凭据，不为此拉全量目录判「模型是否还在 catalog」。「模型下架」这种情形**仅在设置子页暴露**（子页用 `listAvailable.byProvider` membership 判定，见 §7.3 / §4）；仪表盘从轻、且**根本不拉 catalog**（§7.2）。橙条显隐与 catalog 解耦。

**切主模型走「成功即权威、不重读确认」**：picker await `model.set` 成功后才回调，子页据此**直接**把成功值设为 `primary`，写后刷新**不重拉 `model.list` 覆盖**（`refreshAfterWrite({ trustPrimary:true })`）。
- 动因：写盘成功后立即读 `model.list` 可能命中 OpenClaw 运行时**写前陈旧快照**（hot reload 滞后约 1s），把刚切的新值/新 provider 凭据盖回旧值——即「切主模型后显示回跳」bug。成功即权威，不靠读回确认（与项目通则一致）。
- **刚切的模型天然命中可用清单**：primary 有效性由计算属性吃 `listAvailable.byProvider` membership 判，而**选模型器选项正是来自同一份 `byProvider`** → 刚选的模型必在其中、membership 天然成立、不误报失效，**无需额外目录复核**。
- **去掉旧的 view:all 目录半保留**：旧实现里 `primaryEffective` 还拿 `this.catalog`（`models.list view:"all"`）裸比对守"模型真被下架"，本轮**删除**——可用清单已是"干净目录 ∩ 别名感知凭据"，membership 一步覆盖"凭据在 ∧ 模型在目录"，且选模型器与有效性判定**同源同一份 byProvider**，不会出现"选得到却判失效"的结构性缺口（旧 view:all 超集前提那套推演随之作废）。
- 仅切主模型一路 trust；**加/删 provider 仍走默认路径**重拉并 apply（primary 未变；删掉主模型那家 provider 后 `listAvailable.byProvider` 不再含它 → membership 翻失效，必须放行让橙条引导重选）。

---

## 八、组件清单

| 组件 | 角色 | 位置建议 |
|---|---|---|
| `ModelConfigPage` | 子页主组件 | `src/views/ModelConfigPage.vue` |
| `ProviderAuthRow` | 单 provider 凭据行（含 oauth 徽章） | `src/components/model-config/` |
| `AddProviderDialog` | 添加 provider 流程容器（按 `authMethods` 多入口） | 同上 |
| `ProviderOAuthLoginStep` | OAuth 设备码登录步（两阶段流，§ 5.5） | 同上 |
| `PrimaryModelPickerDialog` | 主模型选择器 | 同上 |
| `RemoveProviderConfirmDialog` | 撤销确认（含强提示分支） | 同上 |

辅助数据：

- `src/constants/provider-meta.js`：硬编码 `provider id → { displayName, popular, dashboardUrl }` 映射表（见 § 8.1 初始值）
- `src/utils/nav-back.js`：抽取自 `MobilePageHeader` 的 back+fallback helper

### 8.1 provider 元数据映射表（初始值）

`src/constants/provider-meta.js` 导出形如：

```js
export const PROVIDER_META = {
	anthropic: { displayName: 'Anthropic Claude', popular: true,  dashboardUrl: 'https://console.anthropic.com/settings/keys' },
	openai:    { displayName: 'OpenAI',           popular: true,  dashboardUrl: 'https://platform.openai.com/api-keys' },
	google:    { displayName: 'Google Gemini',    popular: true,  dashboardUrl: 'https://aistudio.google.com/apikey' },
	groq:      { displayName: 'Groq',             popular: true,  dashboardUrl: 'https://console.groq.com/keys' },
	deepseek:  { displayName: 'DeepSeek',         popular: true,  dashboardUrl: 'https://platform.deepseek.com/api_keys' },
	moonshot:  { displayName: 'Moonshot (Kimi)',  popular: true,  dashboardUrl: 'https://platform.moonshot.cn/console/api-keys' },
	zai:       { displayName: '智谱 AI (GLM)',    popular: true,  dashboardUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
	// 其它 provider 未在表中即为 popular: false / dashboardUrl 缺省（不显示"去官网"链接）
};
```

约定：

- **本期"常用" provider 共 7 个**（上表 `popular: true`），覆盖国外主流（Claude / OpenAI / Gemini / Groq）+ 国内主流（DeepSeek / Moonshot / 智谱）
- `displayName` 用品牌官方名，**不进 i18n**（品牌不翻译）
- `dashboardUrl` 实施时由队员核验是否仍可用；若变更则在 PR 描述中标注
- 未在表中的 provider：`displayName` fallback 为 provider id 本身、`popular: false`、不显示"去官网"链接
- 完整 provider 列表由 `coclaw.providerAuth.catalog` 运行时拿（setup 全集，含认证方式 + hasCred），**不在本表硬编码**——未来扩展只动 PROVIDER_META，不破坏 dropdown 完整性

### 8.2 i18n key 命名规范

新增 key 集中放 `src/i18n/locales/*.js` 的 `modelConfig.*` 命名空间，下分四个二级子空间（每个组件 / 流程对应一个）：

| 二级命名空间 | 归属 | 示例 |
|---|---|---|
| `modelConfig.primary.*` | 默认主模型区 + 主模型选择器 | `primary.title`、`primary.changeButton`、`primary.notSetWarning`、`primary.invalidWarning`、`primary.pickerTitle` |
| `modelConfig.providerAuth.*` | API 凭据区 + 添加 / 撤销流程 + **OAuth 设备码登录步** | `providerAuth.title`、`providerAuth.addButton`、`providerAuth.removeButton`、`providerAuth.add.stepSelectTitle`、`providerAuth.add.stepConfigTitle`、`providerAuth.remove.title`、`providerAuth.remove.descAffectPrimary`；**设备码流** `providerAuth.oauth.*`：`oauth.starting`、`oauth.instructions`（**通用文案、不含占位**——标题已带 provider）、`oauth.codeLabel`、`oauth.copy` / `oauth.copied`（复制按钮 aria-label / 就地"已复制"反馈）、`oauth.rawTextLabel`、`oauth.waiting`、`oauth.failed`（泛化回退）、`oauth.errors.{OAUTH_FAILED, OAUTH_TIMEOUT, IO_FAILED, NOT_FOUND}`（**OAUTH_CANCELLED 静默、无 key**）；复制失败复用 `common.copyFailed`。链接为可点 `<a>`（无独立"打开"按钮、无 `linkLabel`，指引已说"下方链接"）；oauth-login"暂不支持" = `providerAuth.add.oauthLoginUnsupported`（含 `{provider}`）+ `providerAuth.add.methodOauthLogin` |
| `modelConfig.guidance.*` | ManageClawsPage 外层引导（橙条文案 + "去配置"按钮） | `guidance.noKeyWarning`、`guidance.noPrimaryWarning`、`guidance.invalidPrimaryWarning`、`guidance.goConfigure` |
| `modelConfig.common.*` | 通用文案（offline 提示 / 保存失败 / 连接异常等） | `common.clawOffline`、`common.saveFailed`、`common.connError` |

约束：

- 涉及语言：**全 12 个 locale**（de / en / es / fr / hi / ja / ko / pt / ru / vi / zh-CN / zh-TW，与现状一致）
- 任何新 key 必须 **12 个语言**全部**同步**新增；漏一个 = deep-review 必驳（设备码/oauth key 占位 `{provider}` 也须各语言齐）
- `displayName`（provider 品牌名）**不进** i18n；oauth 徽章字面量 `oauth` 也**不进** i18n
- 错误码 → 文案映射的 key 放 `modelConfig.common.*`（如 `common.errInvalidArgs`、`common.errIoFailed`），避免分散到各 component

---

## 九、桌面端 / 移动端布局差异

| 维度 | 移动端 | 桌面端 |
|---|---|---|
| Header | `MobilePageHeader`，左返回 + 标题 | 自有 header，左返回 + 标题（`{claw 名} · 模型设置`） |
| 添加 provider（选 provider 步） | Bottom sheet 全屏 | UModal 居中 |
| 添加 provider（输 key 步） | 居中 confirm 小卡片（非全屏） | UModal 居中 |
| 主模型选择器 | Bottom sheet 全屏 | UModal 居中 |
| 撤销确认 | UModal（小尺寸） | UModal（小尺寸） |
| 内容宽度 | 占满 | 居中，最大宽 `max-w-2xl`（对齐 ManageClawsPage） |

### Header 复用范式

沿用 `FileManagerPage` 现状——**不**抽公共 PageHeader 组件（两端样式差异较大，强行抽提反而增加 props 复杂度）。具体做法：

- 移动端：`import MobilePageHeader from '@/components/MobilePageHeader.vue'`，照搬现有用法
- 桌面端：在子页 template 内写一个 `<header class="hidden md:flex ...">` 的桌面 header，左侧返回按钮 + 中间标题
- 两端的返回按钮共用 `utils/nav-back.js` helper，fallback 传 `'/claws'`
- 桌面 header 的 claw 名来源：从 `dashboard.store` 的 `instance?.name` 字段取（已有字段，无需新拉）

---

## 十、错误与边界

### 错误码 → 文案映射

| RPC 错误码 | UI 表现 |
|---|---|
| `INVALID_ARGS`（provider 无凭据 / model 不在 catalog） | 表单内联红字 + 描述具体哪项不通过 |
| `IO_FAILED` | notify 错误："保存失败，请重试" |
| RPC 超时 / 通道断 | notify 错误："连接异常，请重试"；表单不关闭 |

### 边界场景

| 场景 | 处理 |
|---|---|
| claw 离线时进子页 | 顶部展示离线提示，所有动作 disabled |
| 子页加载中通道断 | 现成 RTC 恢复机制处理，loading state 顺其自然 |
| 撤完最后一个 provider | 凭据列表显示空态，主模型区自动变成"失效"橙条 |
| 设 primary 时该 provider 同时被另一标签页撤销 | plugin 端 `INVALID_ARGS`（provider 无凭据），表单提示 |
| Electron 冷启 deep link 进子页 | 返回按钮走 fallback `/claws`，由 `nav-back` helper 兜 |
| 用户输入的 API key 含首尾空格 | 提交前 `trim()`；trim 后为空显示 INVALID_ARGS |

---

## 十一、测试要求

按仓库根 CLAUDE.md "所有代码改动必须配套测试"原则，本设计的测试覆盖按下表分层。task-new 拆 subtask 时按此填 Acceptance。

### 必 E2E 场景（4 条）

| 场景 | 理由 |
|---|---|
| 首次接入主路径 | 绑 claw → 橙条引导 → 进子页 → 配第一个 key → 选主模型 → 返回 → 橙条消失。整链路必须端到端验证，否则核心价值无保障（/claws 不再拉全量目录后，AgentCard 模型名徽章已移除，不再断言 modelLabel，见 §7.2） |
| 撤销 primary 对应的 provider | 强提示分支影响主流程，验证文案分支条件 + 撤销后橙条自动切到"失效"态 |
| 主模型切换 | 用户高频操作；验证选完即保存 + 状态实时反映到子页主模型区 |
| 桌面端返回行为 | back() + fallback 两条路径都要验证（从 chat 进 vs deep link 冷启） |

### 必单测（不需 E2E）

- 各 dialog / row 组件的 props / event（标准组件测试）
- `dashboard.store` 新增字段（含失败态默认值）的派生计算
- 错误码 → 文案映射函数
- `utils/nav-back.js` helper
- `constants/provider-meta.js` 映射表形态校验（每条带 displayName、popular、可选 dashboardUrl）
- "primary 失效判定"计算属性（拆 `<provider>/<model>` + 与 `listAvailable.byProvider` membership 比对；清单未到=先不下结论、不误报）

### 按现行规范

- 单元测试与源码同目录、命名 `[filename].test.js`
- E2E 用例打"标签"按 e2e-test skill 约定
- 覆盖率阈值按 ui 工作区现行配置（branches ≥90%、其它 ≥95%）

---

## 十二、可访问性与安全

- 添加 / 撤销 / 设主模型：**成功不 notify**（界面变化即可让用户分辨），**失败一律 notify**（按全局 notify 规范）
- API key 在 input 中用 password 类型，提交后**不落地 UI 任何缓存**，只取 plugin 返回的 keyPreview
- 不在 UI 端 log raw key（即便 console.log 也不行）
- 错误信息不包含 raw key 片段
- 撤销操作必须二次确认（含强提示分支）

---

## 十三、引用关系

- 上游 plugin 契约：`plugins/openclaw/docs/model-config-api.md`
- 心智模型与凭据 SOP：`docs/openclaw-research/model-config-mental-model.md`
- 通信模型：`docs/architecture/communication-model.md`
- 移动端子页面规范：UI 工作区 `mobile-subpage` skill
- 全局 notify：UI 工作区 `ui-notify` skill
- E2E 测试规范：UI 工作区 `e2e-test` skill

---

## 十四、扩展路径（不在本期）

- per-agent 主模型覆盖：AgentCard 加"切此 agent 主模型"动作 + 子页加 per-agent section
- fallback 链：子页主模型区加"备用模型"展开区
- OAuth 登录：「+ 添加」流程里出现 provider 时如果是 OAuth 类，走 device-code 流程
- 多 profile（同 provider 多账号）：「+ 添加」可显式指定 profileId 后缀（`:work` / `:personal`）
- 模型 alias / 自定义模型：子页加"自定义模型"列表
