# OpenClaw Provider 清单、Plan 计费与认证区分（CoClaw 视角研究）

> 研究日期：2026-06-03
> 实测环境：本机 OpenClaw gateway `2026.5.28`（systemd user service，端口 18789）
> 范围：provider 在 CoClaw 三个界面的清单口径、各厂商的「plan（订阅套餐）」计费现实与 OpenClaw 编码方式、token 与 plan 的认证层区分机制及 CoClaw 当前缺口、以及 UI「常用 provider」与 'plan' 徽章的可行性。
>
> 本文与 [`model-config-mental-model.md`](model-config-mental-model.md) 互补：那份的**附录 D**（provider 清单三处来源 + `providerAuth.catalog` 全集口径）和**附录 E**（API key 配置 SOP：setApiKey/list/remove）是基础，本文不重复其正文，只在它们之上补三个缺失角度——「三套清单的差异与‘UI 已列全’澄清」「plan 计费全景」「token/plan 认证区分及 CoClaw 三环缺口」。

---

## 0. 一页结论

1. **「UI 没列全 provider」是误会**：添加 provider 对话框消费的 `coclaw.providerAuth.catalog` 实测返回 43 个 provider、**未配凭据的全在内**，对话框**全量渲染**（无折叠/无上限/无"必须搜才出现"）。用户能配到任意 provider 的凭据。
2. **三套清单口径不同，别混**：`providerAuth.catalog`（配凭据用，折叠别名）≠ `model.listAvailable.byProvider`（选模型器用，含别名变体）≠ `openclaw infer model providers`（脚本，按模型清单分组）。"UI 里 minimax 两条"之谜出在第二套。
3. **plan 计费现实**：中国 6 家（火山/通义/智谱/MiniMax/Kimi/阶跃）+ 国际 4 家（OpenAI/Copilot/Anthropic/xAI）确有订阅套餐；DeepSeek/OpenRouter 纯按量，Gemini 的登录是免费的不算 plan。
4. **token 与 plan 可并存**（推翻"同一家二选一"的直觉）：套餐与按量走不同端点/不同 key，同账号可同时开通。
5. **认证层能区分 token vs plan，但不是靠"api-key 类型"**：openai 靠 auth kind、qwen 靠同 id 内的多个 auth choice（methodId/choiceId）、火山/阶跃靠拆成两个 provider id。OpenClaw **没有机器可读的"这是套餐"字段**，只有自由文本 label + 命名约定。
6. **CoClaw 当前读不到这个区分**：发现/写入/读回三环都把 choice 拍平丢弃，故一把已配的 qwen key 是套餐还是按量、CoClaw 判断不出来。
7. **'plan' 徽章**：无自动信号、必须策展表；provider 级徽章只能干净表达"整个 provider 就是套餐"的那批（minimax-portal/github-copilot/openai-codex/stepfun-plan），对同 id 双计费的（qwen/volcengine/openai…）本质无法准确表达。

---

## 1. provider 的三套清单：口径不同别混

CoClaw 在三处用到「provider 清单」，数据源和取舍各不相同（实测 gateway `2026.5.28`）：

| 清单 | RPC / 命令 | 维度 | 含未配凭据？ | 含别名套餐变体？ |
|---|---|---|---|---|
| **添加 provider 对话框** | `coclaw.providerAuth.catalog` | 鉴权配置（一 provider 一条，别名折叠进基座） | **是**（实测 43 个，`hasCred=false` 也返回） | 否（无 `volcengine-plan`/`byteplus-plan`/`minimax-portal-cn`/独立 `codex`） |
| **选/换主模型器** | `coclaw.model.listAvailable.byProvider` | 模型清单 ∩ 别名感知凭据 | 否（要有凭据点亮才出模型） | **是**（别名变体各成 carrier id） |
| **脚本盘点** | `openclaw infer model providers`（`plugins/openclaw/scripts/list-providers.sh`） | 按 model catalog 分组（provider 须有 ≥1 模型条目） | 部分（有静态模型表的出，纯动态拉取的没凭据则不出） | **是**（含 `-plan` 变体） |

> 基础口径（`providerAuth.catalog` = setup 全集发现）已在 [`model-config-mental-model.md`](model-config-mental-model.md) **附录 D.5** 定稿。本文补充的是：上面**第三套（脚本）是一条独立路径**（按模型清单分组，不是 `providerAuth.catalog`），以及下面两个澄清。

### 1.1 「UI 没列全 provider」是误会——其实列全了

`coclaw.providerAuth.catalog` 走 setup 全集插件发现（`resolvePluginProviders({mode:'setup', activate:false})`），**不碰 model catalog、不要凭据**，所以即便 qwen/openrouter 这种"没配 key 就拉不到模型"的动态目录 provider，也照样返回。

`ui/src/components/model-config/AddProviderDialog.vue` 把 catalog（减去已配的）**全部渲染**，分两组同屏：

- **常用组**（`provider-meta.js` 里 `popular:true` 的）置顶；
- **其他组**（其余全部）紧随。

两组都用无条件 `v-for` 全量渲染，**没有数量上限、没有"展开更多"、没有折叠、没有"必须搜索才出现"**；列表区只是固定高 `overflow-y-auto` 容器，多了内部滚动。搜索框只是叠加过滤。

**结论**：用户能配到 qwen / openrouter 等全部 43 个 provider，往下滚或搜一下即可。不存在"列不全→配不了凭据"的缺陷。

唯一被 catalog handler 跳过的是 **`authMethods` 映射后为空的 provider**（custom-only / token-only），不是凭据原因。

### 1.2 「UI 里 minimax 两条」之谜

用户在**选模型器**里看到 `minimax-portal` + `minimax-portal-cn` 两条，而添加对话框里 minimax 只有 `minimax` + `minimax-portal`（无 `-cn`）。这不是 bug，是两套清单的口径差异：

- 已配凭据只有一把 `minimax-portal`（OAuth）。
- 选模型器走 `model.listAvailable.byProvider`，是「目录 ∩ 别名感知凭据」。这把 OAuth 凭据经**别名感知鉴权**会同时点亮基座 `minimax-portal` 和区域别名载体 `minimax-portal-cn` 的模型——model catalog 把 `minimax-portal-cn` 当独立 carrier id，于是分成两组。
- 添加对话框走 `providerAuth.catalog`，把别名折叠进基座，所以那里没有 `-cn`。

---

## 2. UI「常用 provider」清单（CoClaw UI 侧）

### 2.1 现状

「常用」是 `ui/src/constants/provider-meta.js` 里每个 provider 的 `popular: true` 标记，作用是把这些 provider 在添加对话框里**置顶分组**（纯排序，不影响可达性，也不影响选模型器）。

当前 7 个标了 `popular`：anthropic、openai、google、groq、deepseek、moonshot、zhipuai。

### 2.2 预存 bug：`zhipuai` / `groq` 对不上 catalog id（已记 `ui/TODO.md`）

popular 分组靠 `getProviderMeta(catalog.provider)` 严格匹配 catalog id，匹配不到就降级 `{popular:false}`。其中两个对不上：

- **`zhipuai`**：智谱原生 catalog id 是 `zai`（别名仅 `z.ai`/`z-ai`，不含 `zhipuai`）→ 智谱永远进不了常用组。
- **`groq`**：`providerAuth.catalog` 的 43 个里根本没有 `groq`（groq 只出现在 model-catalog 路径，未进 setup 鉴权发现集）→ 这条 popular 标记空转。

结果：7 个 popular 实际只有 **anthropic/openai/google/deepseek/moonshot 这 5 个**生效。

### 2.3 纳入中国区 + 国际主力的建议（catalog id 为准）

| 目标 | catalog id | 备注 |
|---|---|---|
| 火山引擎（国内版） | `volcengine` | 用户决策只取国内版；`byteplus` 是国际版 |
| 阿里云 | `qwen` | 原生内置，不叫 aliyun；端点为百炼/DashScope |
| MiniMax | `minimax` + `minimax-portal` | 前者 API key 直连，后者订阅门户登录 |
| 智谱 | `zhipuai` → **改为 `zai`** | 修 2.2 的 bug 即生效 |
| DeepSeek | `deepseek` | 已 popular |
| 国际·按量 | `openrouter` | 原生内置、动态拉清单，加 popular 即显示 |
| 国际·套餐 | 已有的 `openai` | ChatGPT/Codex 订阅折叠在 `openai` 内 |

> 同厂多 id（如 qwen 系、minimax 系）若未来要聚合展示，按上游 manifest 的 `groupId`/`groupLabel` 聚合更干净。

---

## 3. Plan（订阅套餐计费）全景

「plan」指：买固定费套餐、按额度（请求数/周期上限）用，而非按 token 计费——类似 ChatGPT 订阅驱动 Codex、GitHub Copilot 订阅。

### 3.1 各厂商现实（2026-06 官网/文档核实）

| 厂商 | 有 plan？ | 套餐名 | 启用 plan 的认证（厂商现实） |
|---|---|---|---|
| 火山引擎/豆包 Ark | ✅ | Coding Plan（40/200 元/月） | 同账号普通 key 打到 coding 专用端点（`.../api/coding`） |
| 阿里 通义千问（百炼/DashScope） | ✅ | Coding Plan（Pro 200 元/月） | **专用套餐 key** `sk-sp-*` + 专用端点 `coding.dashscope.aliyuncs.com` |
| 智谱 GLM（bigmodel/z.ai） | ✅ | GLM Coding Plan（~49 元/月起） | 账号 key + coding 专用端点（`open.bigmodel.cn/api/coding/...`） |
| MiniMax | ✅ | Coding/Token Plan（29~119 元/月） | **专用订阅 key**，与按量 key 不可互换 |
| Kimi/Moonshot | ✅ | Kimi For Coding（49~199 元/月） | **专用套餐 key + 专用 base_url** |
| 阶跃星辰 StepFun | ✅ | Step Plan（$6.99~$99/月） | 普通 key 打到 `/step_plan/v1` 端点 |
| OpenAI | ✅ | ChatGPT Plus/Pro/Business | OAuth「Sign in with ChatGPT」 |
| GitHub Copilot | ✅ | Copilot Pro/Pro+/Business | OAuth 设备码（本质纯订阅，无通用按量 API） |
| Anthropic Claude | ✅ | Claude Pro/Max | OAuth 登录 |
| xAI Grok | ✅ | SuperGrok / X Premium+ | OAuth（accounts.x.ai） |
| **DeepSeek** | ❌ | — | 纯按 token，无任何套餐 |
| **OpenRouter** | ❌ | — | 纯按量充值 credits，无订阅 |
| **Google Gemini** | ❌ | — | `google-gemini-cli` 的 OAuth 是**免费个人登录**（免费 Code Assist 配额），非付费套餐 |

来源：火山 volcengine.com/article/37937、阿里 help.aliyun.com/zh/model-studio/coding-plan、智谱 docs.bigmodel.cn/cn/coding-plan、MiniMax platform.minimaxi.com/docs/token-plan、DeepSeek api-docs.deepseek.com/quick_start/pricing、Kimi kimi.com/code/docs、阶跃 platform.stepfun.com/step-plan、OpenAI developers.openai.com/codex/auth、Copilot docs.github.com/copilot、Anthropic code.claude.com/docs/authentication、xAI grok.com/plans、OpenRouter openrouter.ai/pricing、Gemini developers.google.com/gemini-code-assist/faqs。

### 3.2 关键事实

- **token 与 plan 可并存**：所有有套餐的厂商，套餐与按量走**不同端点/不同 key**，同一账号可同时开通。（推翻"同一家不能 token+plan 并存"的直觉。）
- **中国厂商套餐几乎都是「专用 key 或专用端点」，没一家用 OAuth 当套餐计费**。OpenClaw 里 `minimax-portal` 的 OAuth 设备码只是登录门户去取那把订阅 key 的手段，不是套餐本身的计费认证。
- **同时支持两种计费的中国厂商，"谁来区分"分两拨**：① **专用套餐 key**——通义（`sk-sp-*`）、MiniMax、Kimi：key 本身带计费身份，服务商凭 key 即可辨别走量还是套餐；② **同一把 key + 不同端点**——火山、智谱、阶跃：按量和套餐用同一把 key，凭**请求打到哪个网址**区分，服务商光看 key 分不出。**但两拨的源头都在客户端**：得先知道"走套餐还是按量"，才能填对 key / 发对端点——不是服务商自动判定。所以"用不同 key 类型区分"严格说不成立（系统无 key 类型概念），只有第一拨能说"服务商按 key 辨别"。
- **Gemini/OpenRouter 易误判**：Gemini 挂 oauth-login 但那是免费登录；OpenRouter 只有按量 credits。都不该当 plan。

### 3.3 OpenClaw 怎么编码 plan：三种形态

| 形态 | 例子 | 在 `providerAuth.catalog` 里 |
|---|---|---|
| **独立 `-plan` provider id** | `stepfun-plan`（独立 provider id + 独立 auth choice 槽 `plan-api-key-cn/intl`，但 env 仍与基座共用 `STEPFUN_API_KEY`）；`volcengine-plan`/`byteplus-plan`（纯 auth 别名，`providerAuthAliases` 指向基座、共享基座 key） | 仅 `stepfun-plan` 出现；别名型的折叠进基座、不单独出现 |
| **独立登录门户 provider id** | `minimax-portal`（device-code）、`github-copilot`（device-code）、`openai-codex`（oauth/device-code/api-key） | 出现，作为独立条目 |
| **同 provider id 内多 auth 选项** | `qwen`（4 个 api_key choice：2 按量 + 2 套餐）、`zai`（5 个 choice，其中 `coding-global`/`coding-cn` 两个是 GLM Coding Plan 端点）、`openai`（api_key + oauth + device_code） | 出现一条基座；多选项被拍平（见第 4 节） |

> **智谱与 MiniMax 编码形态（已核实）**：
> - **智谱 `zai` = 形态 B**：单一 `zai` id 下 5 个 auth choice 共用一把 key（`zaiApiKey`），靠 `method` 切端点；其中 `coding-global`/`coding-cn` 落到 coding 端点（`api.z.ai` / `open.bigmodel.cn`）= GLM Coding Plan，与按量端点并列。**无**独立 `zai-plan`。
> - **MiniMax = 混合**：`minimax`（api-key）**同时收按量 key `sk-api-` 和订阅 key `sk-cp-`**，靠 **key 前缀**区分（OpenClaw 不解析前缀、原样收；与 §3.2 第①拨一致），两者运行时都走 `/anthropic` 端点；`minimax-portal`（device-code）是 OAuth 登录门户取订阅 token。即 MiniMax 订阅有两条入口（粘 `sk-cp-` key 进 `minimax` / 经 `minimax-portal` 登录）。

---

## 4. token vs plan 的认证层区分机制 + CoClaw 三环缺口

### 4.1 上游：靠什么区分

OpenClaw 区分"同一家走按量还是走套餐"有三种机制，**没有一种是靠"api-key 的类型"**——`ProviderAuthKind` 总共只有 5 值（`oauth | api_key | token | device_code | custom`），从不把 `api_key` 再细分子类型。

| provider | 区分机制 |
|---|---|
| **openai** | 靠 **auth kind**：按量 = `api_key`，ChatGPT 套餐 = `oauth`/`device_code` |
| **qwen** / **zai** | 靠 **auth choice**（不是 kind）：同 id 下多个选项**全是 `api_key`**（qwen 4 个、zai 5 个），靠 `methodId`/`choiceId` 区分，选哪个就路由到哪个端点；落到 coding 端点的选项 = 套餐 |
| volcengine / stepfun | 靠**拆成两个 provider id**（`-plan`） |
| minimax | 靠 **key 前缀**：`minimax`（api-key）一条同收 `sk-api-`（按量）/ `sk-cp-`（订阅），OpenClaw 不解析、由服务商凭前缀辨别 |

`qwen` 的 4 个 choice（`extensions/qwen/openclaw.plugin.json`）：

| methodId | choiceLabel（自由文本） | 端点（运行时由该 method 的 applyConfig 设定） |
|---|---|---|
| `standard-api-key-cn` | Standard API Key for China (pay-as-you-go) | dashscope.aliyuncs.com |
| `standard-api-key` | Standard API Key for Global/Intl (pay-as-you-go) | dashscope-intl.aliyuncs.com |
| `api-key-cn` | Coding Plan API Key for China (subscription) | coding.dashscope.aliyuncs.com |
| `api-key` | Coding Plan API Key for Global/Intl (subscription) | coding-intl.dashscope.aliyuncs.com |

**关键**：choice 对象里**没有机器可读的"plan/subscription"枚举或布尔字段**。计费语义只活在两处：① 自由文本 `choiceLabel`/`choiceHint`（可 i18n、不可靠）；② 命名约定（`standard-*` = 按量、裸 `api-key*` = 套餐，但没有任何字段断言这个约定）。机器侧能拿到的稳定标识只有 `methodId` 和 `choiceId`。端点不是 choice 上的声明字段，而是各 auth method 的 `applyConfig` 回调按选中的 method 设定。

> 注：qwen 的 OAuth 流是**另一个独立 provider id** `qwen-oauth`（别名 `qwen-portal`/`qwen-cli`），不是 qwen 同 id 的情形。

**这些信息上游其实暴露了**：`resolvePluginProviders({mode:'setup'})` 返回的 `auth[]` 元素带 `id`（= methodId）、`label`、`hint`、`kind`、`wizard`（内含 `choiceId`/`choiceLabel`/`choiceHint`/`groupId`/`methodId`）。所以下游能读到 methodId/choiceId——但只是字符串，没有计费类型枚举，得自己按约定/文案再推。

### 4.2 CoClaw 当前读不到这个区分——三环连锁丢失

> 基础（setApiKey/list 的字段）见 [`model-config-mental-model.md`](model-config-mental-model.md) **附录 E**。本节补的是"choice 维度在三环全被丢弃"这个缺口。

| 环 | 位置（`plugins/openclaw/src/provider-auth/handlers.js`） | 丢失点 |
|---|---|---|
| **发现层** | `mapAuthMethods` + `KIND_TO_AUTH_METHOD` | 只读 `a.kind` 映射成方法名字符串（`api_key→api-key` 等），再**按方法名去重**。qwen 的 4 个 api_key choice 经映射全得 `"api-key"`、去重后**只剩一个**——choiceId/label/端点全丢。这正是实测 qwen catalog 只有扁平 `["api-key"]` 的根因。 |
| **写入层** | `setApiKey` | 入参只有 `provider`/`apiKey`/可选 `profileId`，**没有 choice 维度**；落盘 `buildApiKeyCredential(provider, apiKey, undefined, ...)` 第三参硬编码 `undefined`。存不下"用户选的哪种计费"。 |
| **读回层** | `toListEntry` / `list` | 出参 `type` 受 `VALID_CRED_TYPES = {api_key, oauth, token}` 约束，**粗粒度三值**，无 choice/plan 字段。 |

**结论**：以 CoClaw 当前实现，一把已配的 `qwen` api_key 是套餐还是按量，**判断不出来**——不是上游没给，是 CoClaw 在发现/写入/读回三环都没接住。

要支持区分，需补三环：① 发现层保留每个 choice 的 `choiceId`/`label`（catalog 出参从字符串数组升级为带 choice 标识的结构）；② 写入层 `setApiKey` 增 choice 入参并落盘到凭据；③ 读回层 `list` 透出 choice 维度。且"哪个 choice 算 plan"最终仍要 CoClaw 自维护映射（上游无字段）。

---

## 5. 'plan' 徽章可行性结论

**没有任何上游字段能自动判定 plan，徽章必须靠 CoClaw 自维护一张策展映射表。** auth kind 不能当信号——双向证伪：Gemini 挂 oauth 却是免费登录、火山/通义/Kimi 的 plan 却是 api_key。

在「徽章只打 provider、不打 model」的约束下，plan 在 OpenClaw 里的两种形态决定了徽章干净程度：

- **A 类·provider 本身就是套餐**（整个身份即 plan）：`minimax-portal`、`github-copilot`、`openai-codex`、`stepfun-plan`。
  → 这 4 个在添加对话框里是独立条目，**provider 级徽章干净无歧义**。
- **B 类·普通 provider 顺带提供套餐**（同 id 既按量又套餐）：`qwen`、`volcengine`、`zai`、`kimi`、`xai`、`anthropic`、`openai`。
  → provider 级徽章**本质上无法准确表达**：走不走套餐是比 provider 更细一层（用户配的那把 key/choice）的事，而 CoClaw 今天连这层都没追踪（见第 4 节）。要么不打、要么只能含糊标"可用套餐"。

> **B 类内部成因其实分两种，别混**：
> - **独立 `-plan` id 但被折叠**（`volcengine`/`byteplus`）：OpenClaw **有**独立套餐 id，区分本可干净落在 provider id 上、可追踪；它们"糊"纯粹是因为 **CoClaw 添加界面把这些 `-plan` 别名折叠进了基座、不单独露出**（见 §3.3），用户在添加界面只看得到按量基座。
> - **同 id 多选项**（`qwen`/`zai`/`openai`）：区分埋在一个 id 内的多个选项里，CoClaw 又把选项拍平（见 §4.2）——**这才是真正"记不下、事后分不出"的情形**。`minimax`（api-key）同收 `sk-api-`/`sk-cp-` 也属此类（CoClaw 不解析 key 前缀，分不出按量还是订阅）。
>
> 一句话：**拆成独立 provider id 的厂商，区分本质是干净的；真正的缺口只在"同 id 多选项"那一类。**（阶跃 `stepfun-plan` 正因独立 id 且在添加界面单独露出，已归在上面的 A 类。）

---

## 附录：核实方法与证据

- **活网关 RPC**（`openclaw gateway call --json --params '{}' <method>`，gateway `2026.5.28`）：
  - `coclaw.providerAuth.catalog` → 43 个 provider，每条 `{provider, authMethods[], hasCred}`；未配凭据全在内。
  - `coclaw.providerAuth.list` → 2 个已配：`openai`(api_key)、`minimax-portal`(oauth)。
  - `coclaw.model.list` → 默认主模型 `minimax-portal/MiniMax-M3`。
- **源码定位**：
  - 上游 qwen choice：`openclaw-repo/extensions/qwen/openclaw.plugin.json`、运行时端点路由 `extensions/qwen/index.ts`；类型 `src/plugins/types.ts`（`ProviderAuthKind`/`ProviderAuthMethod`）、`src/plugins/manifest.ts`（`PluginManifestProviderAuthChoice`）、`src/plugins/provider-auth-choices.ts`、`src/plugin-sdk/provider-entry.ts`（auth→wizard 组装）。
  - CoClaw 侧：`plugins/openclaw/src/provider-auth/handlers.js`（`mapAuthMethods`/`KIND_TO_AUTH_METHOD`/`setApiKey`/`toListEntry`/`list`）；UI `ui/src/components/model-config/AddProviderDialog.vue`、`PrimaryModelPickerDialog.vue`、`ui/src/constants/provider-meta.js`。
- **厂商 plan 现实**：见第 3.1 节来源域名。价格/档位与模型版本号随时间变动，不影响"是否有 plan"的判断。
