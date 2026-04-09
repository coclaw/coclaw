# 项目 CoClaw

> 适用范围：对整个 `coclaw` 仓库生效。
> coclaw 旗下各 Workspace 可补充规则。

General Instructions
- 收到用户的任务请求后，首先应理解并向用户澄清需求，待用户确认后再实际执行任务
- 避免过度设计
- 严格遵循移动端优先的设计思路

## 项目简介

- **项目名**：CoClaw（`coclaw`）
- **组织**：CoClaw
- **域名**：`coclaw.net`
- **License**：Apache-2.0（暂定）
- **核心目标**：让用户即使与 OpenClaw 处于网络隔离状态，也能通过 CoClaw 平台与其 OpenClaw 交互
- **产品定位**：功能形态类似 OpenClaw WebChat，但在平台能力与产品细节上做更深入扩展
- 支持多语言：默认跟随浏览器语言，不支持的语言回退为英文

**对项目开发的一句话原则**：pnpm 统一管理、优先成熟依赖、严格测试闭环、文档持续同步、按模块分层收敛复杂度。

## 文档体系

项目文档的**第一阅读者是 Agent（你自己），第二阅读者是开发者**。文档由 Agent 在开发过程中自动维护——架构变更、协议演进、关键设计决策等应及时反映到文档中。

### 阅读路径

1. [docs/architecture/overview.md](docs/architecture/overview.md) — 系统全景
2. [docs/architecture/communication-model.md](docs/architecture/communication-model.md) — 通信模型
3. [docs/README.md](docs/README.md) — 完整索引，按需深入

### 文档分类

| 目录 | 内容 | 更新频率 |
|------|------|---------|
| `docs/architecture/` | 系统架构（当前真相） | 随架构演进持续更新 |
| `docs/decisions/` | 架构决策记录 (ADR) | 决定后较少变动 |
| `docs/designs/` | 功能设计稿（过程文档，头部标注状态） | 已实施的以代码为准 |
| `docs/openclaw-research/` | OpenClaw 上游机制研究 | 按需 |
| 工作区 `docs/` | 该工作区特有文档 | 按需 |

### 组织原则：按关注范围归属

- 理解文档需要**多个工作区**的上下文 → 放 `docs/`（如通信模型、绑定流程、RPC 协议）
- 仅需**单个工作区**的上下文 → 放该工作区 `docs/`（如 UI 文件浏览器、chat 状态架构、Android 签名配置）

## 核心术语

| CoClaw 术语 | OpenClaw 对应 | 含义 |
|-------------|--------------|------|
| **chat** | sessionKey | 无限对话流（长期身份），如 `agent:main:main` |
| **session** | sessionId | chat 中的一个片段；reset 时产生新 session，旧 session 成为孤儿 |
| **topic** | 无对应 | 用户主动发起的独立对话，脱离 OpenClaw sessionKey 体系 |

- chat 与 sessionKey 一一对应：一条 chat 即一个 sessionKey，代表持续的对话流
- session 与 sessionId 一一对应：是 chat 内的一段对话，每次 reset 产生新的 session
- topic 由 CoClaw 自管理，使用 `agent(sessionId=<uuid>)` 发起，不关联 sessionKey

## 包管理器

- 本仓库 **仅使用 `pnpm`**
- 禁止提交 `package-lock.json`
- 统一维护 `pnpm-lock.yaml`

## 依赖策略

- 通用需求优先使用工业标准级开源库，禁止造轮子
- 仅当无合适开源库时，才自行编写并放入 `src/utils`

## JavaScript 编码规范（适用于前后端及插件）

- 采用 JavaScript，而非 TypeScript
- 用 TAB 缩进；开发者阅读代码时会按 1TAB=2空格 设置阅读器
- 语句末尾原则上应添加分号
- 标识符命名应简洁清晰，优选社区通用缩写（如 `prev`、`cur`/`curr`、`msg`、`cfg`、`ctx`、`conn`、`btn`、`idx`、`fn`、`cb`、`req`/`res`、`err`、`args`、`params`、`opts`、`info`、`init` 等）
- 函数风格
  - 顶层/具名函数优先 `function` 声明
  - 内联回调优先箭头函数以保持简洁
  - 涉及词法 `this` 时必须使用箭头函数
- 对于异步操作，优选 `async/await`，除非链式写法明显更清晰
- 网络请求优选用 `axios`
- class 的 private 方法名不要用 `#` 前缀，需要添加前缀时用 `__`
- 抛出异常中的 message 用英文描述
- 注释规范
  - 注释主要供你阅读，应尽量简洁
  - 注释一律用简体中文，因为有时开发者也会阅读
  - 对于行内注释，多数情况下只需在注释与代码之间用一个空格分隔即可，无需相邻行间纵向对齐
  - JSDoc 数组用 `[]` 语法，如 `string[]`，不用 `Array<string>`
  - JSDoc `@param` 使用 `name - 描述` 格式
- 除 Vue 单文件组件或配置文件等框架/工具链明确约定使用 default export 的情形外，所有 JavaScript 模块（包括 Utils、Services、Repos 等）均采用具名导出 (named export)
- 导入部分 node 模块的命名约定
  - 在导入 node path 模块时，将导出名称设置为 nodePath，即 `import nodePath from 'path'`
  - js 的单元测试代码直接使用 node 的 test，而不使用 it 方式

## 单元测试规范

### 基本要求

- 所有代码改动必须配套测试（新增/修改）
- 测试文件与源码同目录，命名为 `[filename].test.js`
- 测试运行必须非交互、可自动执行
- 在执行单元测试前，必须先通过静态检查（至少包含 `lint`，必要时含 type check）

### 测试框架风格

- 默认使用 Node 原生测试器：`node:test`
- 使用 `test()`，不要使用 `it()` 风格

### 覆盖率基线

- 各工作区的覆盖率门槛已提升至较高水平，具体阈值以各自的测试配置为准（server ≥90%、plugin ≥95%、ui branches ≥90% 其余 ≥95%）
- `??` / `?.` fallback 分支不强制覆盖
- 新增/改动代码应优先补齐关键路径覆盖；若暂时无法达标，需在变更说明中明确差距与补齐计划

### Mock 与数据安全

- 涉及"增删改"操作时遵循：
  - 优先 **Create-Test-Delete**（只操作测试创建的数据）
  - 若无法创建，只能 **Modify-Revert**，且必须恢复原状
  - 若恢复失败，立即在 Workspace `TODO.md` 记录人工清理任务
- 禁止删除/污染测试前已存在的核心数据

## 开发流程约束

- 每次任务先明确影响范围（`server/ui/plugin`）再动手
- 遵循最小变更原则：非需求要求下，不进行大范围重构/重命名/目录搬迁
- 涉及跨模块改动（`ui <-> server <-> plugin`）时，先更新 `docs` 中的接口/协议说明，再改实现
- 不在本阶段推进 `admin` 实质开发，除非明确指令

## Bug 修复流程

修复方案确认后，主动执行：修复代码 → review → 补单元测试 → 补 E2E 测试（如涉及 UI）→ `pnpm check` + `pnpm test` 完整验证。无需用户逐项要求。

## E2E 测试

涉及 E2E 测试的执行、编写或调试时，**必须先加载 `e2e-test` skill**，其中包含执行命令、标签分类、编写规范和关键约束。

## 安全与敏感信息

- 禁止提交任何密钥、token、凭据、生产环境配置
- `.env*` 默认不入库；仅允许提交 `.env.example`
- 日志、dump、导出数据中若包含敏感信息，提交前必须清理或脱敏

## Commit 规范

- 仅在以下条件同时满足时允许 commit：
  1) 变更范围清晰且可回滚
  2) `pnpm check` 通过
  3) `pnpm test` 通过（含覆盖率检查；若暂无法达标需在变更说明记录例外原因）
- 每次 commit 保持单一主题，避免将无关改动混在一起
- commit message 使用祈使句并包含范围（建议：`feat(server): ...` / `fix(ui): ...` / `refactor(tunnel): ...` / `test(...): ...` / `docs(...): ...`）
- 禁止提交：临时调试代码、无关格式化噪音、敏感信息、无意义大文件

## 版本管理（Changesets）

- 采用 Changesets + Independent 版本策略，详见 `docs/versioning.md`
- 代码改动涉及包行为变更时，需执行 `pnpm changeset` 声明变更，将生成的 `.changeset/*.md` 随代码一起提交
- 仅改测试/文档/CI 时不需要 changeset
- 版本级别默认规则：bug 修复/小调整 → patch；新功能 → minor。检测到破坏性变更时提示用户确认级别（开发阶段通常仍选 minor）。用户明确指定时以用户为准
- 发布流程使用 `/release` skill。默认"发布"仅指 npm 发布（plugins/openclaw），用户明确说"GitHub 发布"时才额外创建 GitHub Release

## 移动端与桌面端

- **移动端（Android / iOS）**：Capacitor —— 将 `ui` 的 Vite 构建产物打包为原生 App
- **桌面端（Windows / macOS）**：Electron（待后续启动）
- 决策详情见 `docs/decisions/adr-mobile-desktop-framework.md`
- Android 开发规范与命令见 `capacitor-android` skill
- 前端代码与 Web 端完全共用，不维护多套 UI

## 部署执行约定（内部）

- 涉及部署时，优先使用 `scripts/deploy-*.sh`，避免临时手敲分散命令
- 部署说明与参数以 `docs/deploy-ops.md` 为准
- 默认内部发布域名为 `im.coclaw.net`

## 遵循对应最佳实践

- 没有提及的规范/约束，应遵循对应技术栈的最佳实践
- 当系统或用户的要求有违对应的最佳实践时，应明确指出，让用户确认是否修改

## OpenClaw 开发参考

OpenClaw 是较新的项目，且处于快速迭代阶段，训练数据中未包含其最新细节。请务必通过"阅读源码"和"查阅文档"来获取准确信息。

### 文档与源码

CoClaw 项目（尤其是 `openclaw-plugins/tunnel`）与 OpenClaw 生态紧密结合。需要时，请查阅已同步到本地目录 `./openclaw-repo/openclaw` 中的 OpenClaw 仓库内容（文档和/或源码），该目录下的内容与本地安装和运行的 OpenClaw 版本一致。

OpenClaw 网络资源：
- Source: https://github.com/openclaw/openclaw
- Community: https://discord.com/invite/clawd

需要了解 OpenClaw 行为、命令、配置或架构时，优先查阅本地文档。诊断问题时尽量自行运行 `openclaw status`；仅在无权限时（如沙箱环境）才请用户协助。

### OpenClaw CLI

OpenClaw 通过子命令控制，禁止编造不存在的命令。管理 Gateway 守护进程：
- `openclaw gateway status`
- `openclaw gateway start / stop / restart`

不确定时，请用户运行 `openclaw help` 或 `openclaw gateway --help` 并粘贴输出。
