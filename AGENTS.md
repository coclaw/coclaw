# 项目 CoClaw

> 适用范围：对整个 `coclaw` 仓库生效。
> coclaw 旗下各 Workspace 可补充规则。
> POC（概念证明）项目位于 `../tunnel-poc` 中，包含了打通 OpenClaw <-> server <-> ui 的相关验证代码。

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
- 支持多语言：默认为前端浏览器语言。目前只支持简体中文和英文，对于不支持的语言回退为英文

**对项目开发的一句话原则**：pnpm 统一管理、优先成熟依赖、严格测试闭环、文档持续同步、按模块分层收敛复杂度。

## 仓库结构（monorepo，扁平组织）

- `server`：后端服务
- `ui`：前端应用（主要开发）
- `admin`：管理端（已预留，暂不开发）
- `plugins`：自研插件父目录（面向多 Agent 扩展）
- `plugins/openclaw`：当前唯一 OpenClaw 插件（含 transport + session-manager + common）
- `docs`：项目文档（架构、计划、决策、运维等）

## 包管理器

- 本仓库 **仅使用 `pnpm`**
- 禁止提交 `package-lock.json`
- 统一维护 `pnpm-lock.yaml`

## 依赖策略（避免造轮子）

- 在开发过程中遇到通用需求（包括但不限于数据处理、日期、路径、网络请求等）时，应避免“自己造轮子”（即避免手动编写 utils 函数或类）
- 应当优先利用你内化的知识，首选使用 **工业标准级、社区广泛认可** 的开源库。无需联网搜索，直接你内化的知识来甄选包，并按最佳实践调用
- 对常见能力（HTTP、日期、数据处理、UUID、classnames 等），禁止重复造轮子
- 仅当没有满足需要的开源库时，才自己编写工具模块，并将其组织在 `src/utils` 目录中

## JavaScript 编码规范（适用于前后端及插件）

- 采用 JavaScript，而非 TypeScript
- 用 TAB 缩进；开发者阅读代码时会按 1TAB=2空格 设置阅读器
- 语句末尾原则上应添加分号
- 标识符命名应简洁清晰，优选社区通用缩写
- 函数风格
  - 顶层/具名函数优先 `function` 声明
  - 内联回调优先箭头函数以保持简洁
  - 涉及词法 `this` 时必须使用箭头函数
- 对于异步操作，优选 `async/await`，除非链式写法明显更清晰
- 网络请求优选用 `axios`
- 对于标识符命名，尽量使用被社区广泛接受的通用缩写
- class 的 private 方法名不要用 `#` 前缀，需要添加前缀时用 `__`
- 抛出异常中的 message 用英文描述
- 注释规范
  - 注释主要供你阅读，应尽量简洁
  - 注释一律用简体中文，因为有时开发者也会阅读
	- 对于行内注释，多数情况下只需在注释与代码之间用一个空格分隔即可，无需相邻行间纵向对齐
  - JSDoc 数组用 `[]` 语法，如 `string[]`，不用 `Array<string>`
	- JSDoc `@param` 使用 `name - 描述` 格式
- 除 vue 组件等被采用 default 
- 除 Vue 单文件组件或配置文件等框架/工具链明确约定使用 default export 的情形外，所有 JavaScript 模块（包括 Utils、Services、Repos 等）均采用具名导出 (named export) 
- 导入部分 node 模块的命名约定
  - 在导入node path 模块时，将导出名称设置为 nodePath，即 import nodePath from 'path'
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

### 覆盖率基线（当前阶段）

- 当前阶段采用常规覆盖率门槛：
  - `lines >= 70%`
  - `functions >= 70%`
  - `branches >= 60%`
  - `statements >= 70%`
- 新增/改动代码应优先补齐关键路径覆盖；若暂时无法达标，需在变更说明中明确差距与补齐计划

### Mock 与数据安全

- 涉及“增删改”操作时遵循：
  - 优先 **Create-Test-Delete**（只操作测试创建的数据）
  - 若无法创建，只能 **Modify-Revert**，且必须恢复原状
  - 若恢复失败，立即在 Workspace `TODO.md` 记录人工清理任务
- 禁止删除/污染测试前已存在的核心数据

## 开发流程约束

- 每次任务先明确影响范围（`server/ui/plugin`）再动手
- 遵循最小变更原则：非需求要求下，不进行大范围重构/重命名/目录搬迁
- 涉及跨模块改动（`ui <-> server <-> plugin`）时，先更新 `docs` 中的接口/协议说明，再改实现
- 代码改动后必须先通过静态检查，再进行测试与覆盖率检查：`pnpm check` → `pnpm test` → `pnpm coverage`（或直接 `pnpm verify`）
- 改动应同步文档（尤其 `docs/` 下的计划、决策、接口说明）
- 不在本阶段推进 `admin` 实质开发，除非明确指令

## Bug 修复流程

当收到 bug 报告（无论来自开发者还是用户反馈），bug 的存在说明现有测试未覆盖该场景。修复方案确认后，按以下步骤执行：

1. **修复 Bug**：实施代码修改
2. **Review**：仔细审查修改，确认问题已修复且不会引入新问题
3. **补充单元测试**：为该 bug 场景补充单元测试用例，确保回归可检测
4. **补充 E2E 测试**（如涉及 UI 行为）：为该 bug 场景补充端到端测试
5. **完整验证**：运行 `pnpm check` → `pnpm test`，确保所有测试通过且无回归

以上步骤在修复方案确认后**主动执行**，无需用户逐项要求。

## 文档与决策沉淀

- 架构/协议/关键流程变更必须在 `docs/` 留痕
- 重要权衡建议采用 ADR（`docs/decisions/`）
- 与 tunnel 相关的协议约束、边界条件、失败语义需明确记录，避免实现漂移
- 必须维护各子工作区状态文件：每个 workspace（如 `server` / `ui` / `plugins/openclaw`）在其目录下维护 `STATUS.md`，用于沉淀当前进度、关键决定、待办与阻塞项，确保新会话可快速接手

## 安全与敏感信息

- 禁止提交任何密钥、token、凭据、生产环境配置
- `.env*` 默认不入库；仅允许提交 `.env.example`
- 日志、dump、导出数据中若包含敏感信息，提交前必须清理或脱敏

## Commit 规范

- 仅在以下条件同时满足时允许 commit：
  1) 变更范围清晰且可回滚
  2) `pnpm check` 通过
  3) `pnpm test` 通过
  4) 涉及测试覆盖范围的改动需通过 `pnpm coverage`（或在变更说明记录例外原因）
- 每次 commit 保持单一主题，避免将无关改动混在一起
- commit message 使用祈使句并包含范围（建议：`feat(server): ...` / `fix(ui): ...` / `refactor(tunnel): ...` / `test(...): ...` / `docs(...): ...`）
- 禁止提交：临时调试代码、无关格式化噪音、敏感信息、无意义大文件

## 版本管理（Changesets）

- 采用 Changesets + Independent 版本策略，详见 `docs/versioning.md`
- 代码改动涉及包行为变更时，需执行 `pnpm changeset` 声明变更（选择受影响的包、级别、描述），将生成的 `.changeset/*.md` 随代码一起提交
- 仅改测试/文档/CI 时不需要 changeset
- 版本级别默认规则：bug 修复/小调整 → patch；新功能 → minor。检测到破坏性变更时提示用户确认级别（开发阶段通常仍选 minor）。用户明确指定时以用户为准
- 发布流程使用 `/release` skill。默认"发布"仅指 npm 发布（plugins/openclaw），用户明确说"GitHub 发布"时才额外创建 GitHub Release

## 命令约定（示例）

```bash
pnpm install
pnpm check
pnpm test
pnpm coverage
pnpm verify
pnpm changeset          # 声明变更
pnpm changeset:status   # 查看待发布变更
pnpm changeset:version  # 消费 changeset，bump 版本
pnpm changeset:publish  # 发布 npm 包（实际发布插件使用 plugins/openclaw 下的 pnpm pub:release）
```

## 移动端与桌面端

- **移动端（Android / iOS）**：Capacitor —— 将 `ui` 的 Vite 构建产物打包为原生 App
- **桌面端（Windows / macOS）**：Tauri v2（待后续启动）
- 决策详情见 `docs/decisions/adr-mobile-desktop-framework.md`
- Android 开发规范与命令见 `capacitor-android` skill
- 前端代码与 Web 端完全共用，不维护多套 UI

## 部署执行约定（内部）

- 涉及部署时，优先使用 `scripts/deploy-*.sh`，避免临时手敲分散命令。
- 部署说明与参数以 `docs/deploy-ops.md` 为准。
- 默认内部发布域名为 `im.coclaw.net`。

## 遵循对应最佳实践

- 没有提及的规范/约束，应遵循对应技术栈的最佳实践
- 当系统或用户的要求有违对应的最佳实践时，应明确指出，让用户确认是否修改

## OpenClaw 开发参考

OpenClaw 是较新的项目，且处于快速迭代阶段，训练数据中未包含其最新细节。请务必通过“阅读源码”和“查阅文档”来获取准确信息。

### 文档与源码

CoClaw 项目（尤其是 `openclaw-plugins/tunnel`）与 OpenClaw 生态紧密结合。需要时，请查阅已同步到本地目录 `./openclaw-repo/openclaw` 中的 OpenClaw 仓库内容（文档和/或源码），该目录下的内容与本地安装和运行的 OpenClaw 版本一致。

OpenClaw 网络资源：
- Source: https://github.com/openclaw/openclaw
- Community: https://discord.com/invite/clawd

For OpenClaw behavior, commands, config, or architecture: consult local docs first.
When diagnosing issues, run `openclaw status` yourself when possible; only ask the user if you lack access (e.g., sandboxed).

### OpenClaw CLI

OpenClaw is controlled via subcommands. Do not invent commands. To manage the Gateway daemon service (start/stop/restart):
- openclaw gateway status
- openclaw gateway start
- openclaw gateway stop
- openclaw gateway restart

If unsure, ask the user to run openclaw help (or openclaw gateway --help) and paste the output.
