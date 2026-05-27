---
disable-model-invocation: true
---

# /check-openclaw-compat — OpenClaw 上游不兼容变更扫描

## 定位

**用途**：扫描本地 OpenClaw 仓 (`openclaw-repo/`) 在 baseline 之后的变更，找出会影响 `plugins/openclaw` 插件的破坏性改动——尤其影响**已安装插件的自动升级链路**。

**触发场景**：
- 准备发新版本前
- 看到 OpenClaw 发了新版怀疑可能撞坑
- gateway 升级后插件出现奇怪行为

**严格约束**：
- 只读分析；不修任何代码
- 不 commit、不发布
- 不"顺手修"发现的不兼容——只出报告，由用户决定怎么改
- 输出报告后**必须**更新本文件的 baseline 与必要时追加新踩坑模式（见"演进规则"）

## 用法

```
/check-openclaw-compat                       # 用文件里记录的 baseline
/check-openclaw-compat <commit-ish>          # 用指定 baseline（commit hash / tag）
/check-openclaw-compat <附加指令>            # 自由文本，加深检测（如 "更彻底"、"重点看 sessions"）
```

## 当前 baseline

> 每次跑完都把这一行更新成本次的 HEAD。

```
baseline-commit: e2898eaa881b34e36c09d6fb2119fc6810bfaac1
baseline-checked-at: 2026-05-07
```

## 核心关切（为什么这个命令存在）

我们已经踩过两次因为没及时感知 OpenClaw 变更而带来的事故，最严重的一次是**老版本插件无法自动升级**——install records 从 `openclaw.json` 搬到 `~/.openclaw/plugins/installs.json`，老插件读不到记录就判断不了升级路径，用户那边的插件就僵住了。

**自动升级链路一旦断裂，老用户没法靠新版本自我修复——只能让用户手动重装。** 这是发布事故里成本最高的一类。

所以本命令的优先级排序：

1. **影响自动升级链路的变更**（最高优先级）
2. 影响 plugin 加载 / register 的变更
3. 影响插件运行时的变更
4. 影响 CLI / 配置文件 schema 的变更
5. 影响外围（sessions、transcript 等只读路径）的变更

## 必查清单（每次跑都要过一遍）

> 这是历史踩点的台账。代码会演进，新风险可能不在列——发现新类别**必须追加**到本清单（见"演进规则"）。

### A. 插件安装记录（install records）

- **历史踩点（2026.5）**：install records 从 `openclaw.json` 的 `plugins.installs` 搬到 `~/.openclaw/plugins/installs.json` 的 `installRecords`，前者标记为 transient 不再持久化
- 检查：
  - install records 文件路径是否变化
  - records 字段名 / schema 是否变化（`source`、`sourcePath`、`installPath`、`version` 等）
  - 我方代码里所有读 install record 的地方（`scripts/_lib.sh`、`auto-upgrade/updater.js` 的 legacy fallback）是否还能读到

### B. 插件启动加载条件

- **历史踩点**：非 channel 类型插件如果配置 json 没声明 `activation.onStartup=true`，gateway 启动时**不会自动加载**
- 检查：
  - activation schema 是否新增字段 / 改了语义（如新增 `onStartup` 之外的触发条件）
  - 我们的 `openclaw.plugin.json` 当前声明是否仍然能被识别
  - 是否引入了新的"必须声明才会加载"的元数据

### C. plugin runtime API（注入到 register 的对象）

- **历史踩点（v2026.4.27）**：`config.loadConfig()` → `config.current()`，旧 API 触发 deprecation 警告
- 检查：
  - `runtime.config.*` 公开方法是否有增删改
  - `runtime.logger`（pino 风格 `info/warn/error`）签名 / 方法集是否变化
  - `runtime.api` / 注册接口（`registerService`、`registerGatewayMethod`、`registerCli`、`api.on`）签名 / 行为是否变化
  - 是否新增了 deprecation 警告（grep `deprecated` / `warned`）
- 上游锚点：`openclaw-repo/src/plugins/runtime/runtime-config.ts`、`types-core.ts`

### D. state-dir / state-paths 解析

- **历史踩点**：runtime 注入的 `resolveStateDir`（v2026.2.19）vs SDK 子路径 `@openclaw/plugin-sdk/state-paths`（v2026.3.16），上市时间差一个月——选错就在老版本 host 上崩
- 检查：
  - state-dir 解析方式（env / profile / CLI flag 的优先级）是否变化
  - sessions / transcript 路径推导规则是否变化
  - `agents.<id>.store` / `entry.sessionFile` 等覆盖配置是否引入新分支
- 上游锚点：`openclaw-repo/src/plugins/runtime/state-paths.ts`

### E. gateway method / RPC 协议

- 检查：
  - `respond` 回调的入参格式是否变化（错误响应 schema）
  - 我方注册的 method（`coclaw.*`）是否撞了新的保留前缀
  - `callGatewayMethod` 客户端协议是否变化
- 上游锚点：`openclaw-repo/src/plugins/runtime/registration.ts` / gateway WS 协议相关文件

### F. CLI 命令 / 参数

- 影响 auto-upgrade worker（worker 调 `openclaw plugins install <pkg>` 等 CLI 命令）
- 检查：
  - `openclaw plugins install/uninstall/doctor/list` 的参数 / 输出格式是否变化
  - `openclaw gateway start/stop/restart/status` 的输出是否变化（`scripts/` 多处依赖）
  - 是否新增了"必须传"的参数

### G. openclaw.json schema

- 检查：
  - `plugins.entries` / `plugins.installs` / `plugins.load.paths` / `channels.*` 节点 schema 是否变化
  - 是否引入新的必填字段（schema 验证失败 → gateway 起不来）
- 上游锚点：`openclaw-repo/` 里 config schema 相关源码（zod / json-schema 定义）

### H. sessions / transcript 文件布局

- 检查：
  - `sessions.json` 索引格式
  - 单条 transcript JSONL 结构
  - 多次 lifecycle:end / 顶层 timestamp 字段语义（已知陷阱：参考全局 memory `project_thinking_duration_format.md`、`reference_openclaw_multi_lifecycle_end.md`）
- 上游锚点：`openclaw-repo/src/agents/runs/` 或对应目录

### I. 全局 Symbol / 内部 patch 点

- **历史踩点**：插件直接 patch `globalThis[Symbol.for('openclaw.embeddedRunState')].activeRuns` 的 `set/delete` 来观测 agent run 注册——这是上游**未文档化的内部 API**，没有兼容性承诺
- 检查：
  - 我方 `index.js` 通过 `Symbol.for(...)` 取的全局对象在上游是否被重构 / 重命名 / 改类型
  - 当前已知 patch 点：`Symbol.for('openclaw.embeddedRunState')` → `.activeRuns`（Map）
  - 看上游是否新增 / 删除其他 `Symbol.for("openclaw.*")` 全局 Symbol
- 上游锚点：上游 grep `Symbol.for("openclaw\.` / `embeddedRunState` / `activeRuns`
- 风险等级：**高** —— 这类 patch 点上游永远不会发 deprecation 警告，悄悄改了我们就摸不到

### J. plugin register 模式枚举值

- **历史踩点（前瞻类）**：`api.registrationMode` 已经历过 `cli-metadata` / `discovery` / `full` 几代，未来还可能再加（如 `setup-only` / `setup-runtime` / 健康检查 / dry-run / 热重载）。我方 `index.js:135-156` 当前是**排除式白名单**——`cli-metadata` 单独走、`mode !== 'full'` early return、其余模式都注册 channel + CLI 但不起 service / RPC。任何上游新增模式都会落进"非 cli-metadata 非 full"的中间分支，跑了 channel/CLI 注册却**没起 bridge / 没装 RPC handler**，形成半残注册：channel 在但桥接没起、命令显出来但 RPC 不在
- 检查：
  - `api.registrationMode` 上游枚举是否新增值（grep `registrationMode` / `RegistrationMode` 类型/枚举定义）
  - 新模式的语义（是否预期触发 service / RPC / hook）；半残注册是否会被上游健康检查识别为故障
  - 我方 `index.js` 的 mode 分叉是否还能容纳新模式而不出半残
- 上游锚点：`openclaw-repo/src/plugins/runtime/registration.ts` 或对应 register 入口；类型定义文件中 `registrationMode` 字符串字面量的并集
- 修复方向（命中时）：把分叉改成**已知模式白名单**——未知模式默认 noop + warn，避免把副作用注册半截
- 风险等级：**中** —— 上游加新模式不一定有 deprecation，半残注册的症状（channel 在但 RPC 找不到）排查链条较长

### K. 模型 catalog 来源 / 字段契约（CoClaw 自维护 minimax-portal 清单所依赖）

- **背景（2026-05-27 主动核实，非事故）**：CoClaw 给扫码 provider `minimax-portal` 维护一张**硬编码**模型表写进 config（`plugins/openclaw/src/provider-auth/portal-model-catalog.js`）。曾论证能否改成"运行时从上游 catalog 白嫖、免维护、自动同步"，结论**不行**——根因落在下面几条上游契约上，**任何一条变了都该重评"是否还需自维护 / 是否还需硬写 maxTokens"**。完整调研见 `docs/openclaw-research/model-config-mental-model.md` 附录 F。
- **K1. `DEFAULT_MODEL_MAX_TOKENS` 与缺省填充规则**：config 里模型缺 `maxTokens` 时上游归一化填 `min(DEFAULT_MODEL_MAX_TOKENS, contextWindow)`，当前 `DEFAULT_MODEL_MAX_TOKENS = 8192`（`openclaw-repo/src/config/defaults.ts:45` 定义、`:209-211` 填充）。minimax 真实 maxTokens=131072 → 不写就被截到 8192（16x）。检查：常量值 / 填充公式是否变；若上游抬高默认或改成按 provider 兜底，我方"必须硬写 maxTokens"的前提松动。
- **K2. catalog 是否仍丢 maxTokens**：`loadModelCatalog` 把 pi-ai 条目映射成目录条目时只留 `{id,name,provider,contextWindow,contextTokens,reasoning,input,compat}`，**丢 `maxTokens`/`cost`**（`openclaw-repo/src/agents/model-catalog.ts:408-417`）。检查：若上游开始把 maxTokens 带进 catalog 输出，则"白嫖 catalog 免硬编码"变得可行 → 重评自维护方案。
- **K3. pi-ai 出厂字典成员关系**：minimax/minimax-cn 的 M2.7 写死在 pi-ai 出厂字典（`node_modules/@mariozechner/pi-ai/dist/models.generated.js`，`"minimax"`/`"minimax-cn"` 块），无凭据也出；`minimax-portal` **不在**字典、注册时也不声明静态 models（OAuth 写 `models:[]`）→ 只能靠写 config。检查：升级后 pi-ai 字典里 minimax/minimax-cn 是否还在、M2.7 的 contextWindow/reasoning 是否变（变了我方静态表要对齐）、是否**新增了 minimax-portal**（新增则可考虑不再自写）。
- **K4. `models.list` 的 view 契约**：合法值 `default`/`configured`/`all`（`openclaw-repo/src/gateway/protocol/schema/agents-models-skills.ts:198-205`），且 `view:'all'` 原样返回、**跳过凭据/可见性过滤**（`openclaw-repo/src/gateway/server-methods/models.ts:84-96`）——CoClaw 的 `coclaw.model.set` catalog 存在性校验依赖 `view:'all'` 能列出未配凭据的 provider。检查：view 枚举是否增删值、`view:'all'` 是否开始按凭据过滤（任一变化都会让 model-default handler 的校验误判：合法模型被判 not found）。
- **K5. 取 catalog 的 plugin-sdk 子路径**：model-default handler 依赖 `openclaw/plugin-sdk/models-provider-runtime` 的 `buildModelsProviderData`；"白嫖"主路径会依赖 `openclaw/plugin-sdk/agent-runtime` 的 `loadModelCatalog`。检查：这两个子路径是否仍在 dist `package.json` exports、导出名是否变。
- 上游锚点：见各条括注；pi-ai 字典 grep `@mariozechner/pi-ai/dist/models.generated.js` 的 `"minimax"` 块。
- 风险等级：**中** —— 不影响自动升级链路，但 K1/K4 命中会让"已配模型默认输出上限"或"加模型校验"**静默错位**（症状：长回复被截到 8192、合法模型被判 not found），无 deprecation 警告、排查链条长。

## 工作流

1. **解析参数**：
   - 无参数 → 用本文件 `baseline-commit`
   - 第一个 token 看像 commit hash / tag（`^[a-f0-9]{7,40}$` 或以 `v` / `openclaw@` 开头）→ 当作 baseline
   - 否则当作"附加指令"（用户希望加深的关注点）

2. **取 diff 范围**：
   - `git -C openclaw-repo log --oneline <baseline>..HEAD` 看变更范围
   - 如果范围 > 200 commits 或 baseline 不存在，先告诉用户、问是否继续

3. **逐项过清单**：
   - 对必查清单 A-K 每一项：grep / read 上游相关文件，看是否有变更
   - 重点 grep："`deprecated`"、"`@deprecated`"、"`BREAKING`"、"`removed`"、"`renamed`"
   - 看 `openclaw-repo/CHANGELOG.md`（如有）的 baseline 之后段落

4. **判定影响**：
   - 对每条命中：判断我方代码（`plugins/openclaw/`、根 `scripts/`）是否依赖被改动的部分
   - 命中且我方依赖 → blocker；命中但我方未依赖 → warning（写下来，下次还要看）

5. **写报告**（见下节）

6. **更新 baseline**：把本文件 `baseline-commit` 改为本次的 `git -C openclaw-repo rev-parse HEAD`，`baseline-checked-at` 改为今天。

7. **若发现新类别坑**（不在 A-K 之内）：按"演进规则"追加到清单。

## 报告格式

```
OpenClaw 上游兼容性扫描报告

─ 范围
  baseline: <hash> (<日期>)
  HEAD:     <hash>
  commits:  N
  appendix: <用户附加指令，若有>

─ Blockers (N)：影响自动升级或加载
  1. <类别> <一句话变更摘要>
     上游锚点: <file:line 或 commit-hash>
     我方依赖: <我方哪个文件 / 函数依赖了>
     影响: <一句话说清后果，重点：会不会让老插件无法自升级>
     建议修复: <一句话>

─ Warnings (M)：上游变了但我方暂未依赖（仍记录，留心）
  1. ...

─ 必查清单核查
  A. install records   [PASS / NEW-BLOCKER / NEW-WARNING]
  B. 启动加载条件      [PASS / NEW-BLOCKER / NEW-WARNING]
  C. runtime API       [...]
  D. state-paths       [...]
  E. RPC 协议          [...]
  F. CLI               [...]
  G. openclaw.json     [...]
  H. sessions          [...]
  I. 全局 Symbol       [...]
  J. registrationMode  [...]
  K. 模型 catalog 契约 [...]

─ 新发现的踩坑模式（若有）
  X. <新类别> <说明>
     已追加到本命令的必查清单 ✓

─ 结论
  PASS / FAIL（二选一）
  baseline 已推进至: <new HEAD hash> (<日期>)
```

## 演进规则（很重要）

执行过程中如果发现**不属于现有 A-K 类别**的不兼容模式：

1. 把它命名（`I.` `J.` ...）并加进"必查清单"段，描述清楚：
   - 历史踩点（这次撞到的具体上游变更）
   - 检查要点（以后该看什么）
   - 上游锚点（哪些文件 / 路径）
2. 在报告"新发现的踩坑模式"里也列出来
3. 这一步是**强制的**，不要"等下次再加"——下次大概率忘了

类别分得粗一点没关系，重点是**有这个钩子，别让历史教训沉到水下**。

## 严禁

- 不改任何代码（包括我方 `plugins/openclaw/` 与上游 `openclaw-repo/`）
- 不 commit / 不发布
- 不"顺手"修发现的不兼容
- 不在没跑完清单的情况下就出 PASS——清单 A-K 每一项都要明确给出 PASS / NEW-BLOCKER / NEW-WARNING
- 不漏更新 baseline——下次会重复扫同样的 commits
- 不漏追加新发现的坑——下次还会撞同样的雷

## 参考

- 上游仓本地路径：`openclaw-repo/`（仓库根的符号链接，已在 `coclaw/CLAUDE.md` 登记）
- 我方插件硬约束：`plugins/openclaw/CLAUDE.md`
- 自动升级机制详解：`plugins/openclaw/docs/auto-upgrade.md`
- 历史 install-records 迁移背景：搜 `installs.json` / `installRecords` 关键字
