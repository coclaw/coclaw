# 版本管理方案

> 决策时间：2026-03-08

## 概述

CoClaw 采用 **Changesets** + **Independent 版本** 策略管理 monorepo 内各 workspace 的版本。

## 为什么选择 Changesets

- pnpm monorepo 社区主流方案（Vue、Nuxt UI、Turborepo 等均采用）
- 支持 independent 版本：各 workspace 独立 bump，只有实际变更的包才更新版本
- 变更驱动：在开发阶段声明变更，发布时自动消费
- 自动生成 CHANGELOG

## 为什么选择 Independent 而非 Fixed

| 维度 | Fixed | Independent（选择） |
|---|---|---|
| 版本号 | 所有包共享同一版本 | 各包独立版本 |
| 适合场景 | 包之间紧耦合（如 Babel） | 包之间松耦合、更新节奏不同 |
| CoClaw 场景 | 不适合：只有 1 个 npm 公开包 | 适合：plugin 迭代快，server/ui 按部署节奏 |

## 各 Workspace 版本策略

| Workspace | 发布目标 | 版本 bump | Git Tag | npm publish |
|---|---|---|---|---|
| `@coclaw/coclaw`（根） | 不发布 | 有变更时 bump | 手动（GitHub Release 时） | 否 |
| `@coclaw/server` | 私有部署 | 有变更时 bump | 否 | 否 |
| `@coclaw/ui` | 私有部署 | 有变更时 bump | 否 | 否 |
| `@coclaw/admin` | 暂不开发 | 忽略 | 否 | 否 |
| `@coclaw/openclaw-coclaw` | npm 公开发布 | 有变更时 bump | 自动 | 是 |

## 日常开发流程

### 开发时：声明变更

完成功能/修复后，执行：

```bash
pnpm changeset
```

交互式选择受影响的包、变更级别（patch/minor/major）、描述。会在 `.changeset/` 下生成一个 markdown 文件，随代码一起提交。

### 何时需要 changeset

- 修改了会影响包行为的代码（功能、修复、重构）→ 需要
- 仅修改测试、文档、CI 配置 → 不需要
- 不确定 → 加一个 patch 级别的 changeset

### 变更级别

- **patch**（0.1.0 → 0.1.1）：bug 修复、小调整
- **minor**（0.1.0 → 0.2.0）：新功能、非破坏性增强
- **major**（0.1.0 → 1.0.0）：破坏性变更

### 发布时

见 `/release` skill。插件实际发布使用 `plugins/openclaw` 下的 `pnpm release`。

## 配置文件

- `.changeset/config.json`：changesets 核心配置
- `access: "public"`：允许 scoped 包公开发布
- `ignore: ["@coclaw/admin"]`：admin 不参与版本管理
- `privatePackages.version: true`：private 包仍 bump 版本（部署追踪）
- `privatePackages.tag: false`：private 包不打 git tag

## 两类发布及其关系

| 类型 | 触发词 | 范围 | 频率 |
|---|---|---|---|
| npm 发布 | "发布"、"release" | 仅 `@coclaw/openclaw-coclaw` | 高（每次插件变更后） |
| GitHub Release | "GitHub 发布"、"项目发布" | 整体项目里程碑 | 低（重要节点） |

- 两者独立：可以只发 npm 不做 GitHub Release，反之亦然
- 默认"发布"仅指 npm 发布

## 版本级别默认规则

由 Claude Code 执行 `pnpm changeset` 时，按以下规则默认选择级别：
- **patch**（0.1.1 → 0.1.2）：bug 修复、小调整、文档修正
- **minor**（0.1.2 → 0.2.0）：新功能、非破坏性增强
- **破坏性变更**：检测到时不自动选 major，而是提示用户确认。开发阶段（1.0 之前）通常仍选 minor

用户明确指定级别时以用户为准。

## Electron 壳子版本独立维护

Electron 壳子（`ui/electron-builder.yaml`）的版本号**独立于 `@coclaw/ui` 的 npm 版本**，不进入 changesets 流程。

### 为什么独立

- 壳子定位是"薄壳 + 远程加载"：大多数 Web 端迭代都由远程加载的前端直接覆盖，壳子本身无需跟随升级
- `@coclaw/ui` 版本随 Web 端每次发布都可能 bump，若壳子跟车，用户每次开机都会被推送一次"新壳子"安装包，而壳子实际没有变化
- 壳子升级需要走 NSIS 安装器（Windows）/ DMG 重新挂载（macOS），打扰成本高，应严格限定在"壳子自身改动"时

### 如何维护

壳子版本写在 `ui/electron-builder.yaml` 的 `extraMetadata.version` 字段，手工修改。

**bump 规则**：

| 场景 | 级别 |
|---|---|
| 新增原生权限、IPC 通道、系统集成能力 | minor |
| 修壳子 bug（不新增能力） | patch |
| 破坏性变更（较少出现，会影响远程前端的契约时） | major |

修改 `extraMetadata.version` 后打 GitHub Release tag（如 `shell-v1.1.0`），便于追溯每次壳子发布。

> **注**：Web 端（`@coclaw/ui`）版本按 changesets 自动 bump，与壳子完全解耦。
