---
name: release
description: 版本发布流程：npm 发布（plugins/openclaw）和 GitHub Release（整体项目）。Use when 用户要求"发布"、"release"、"bump 版本"。
---

# 版本发布流程

CoClaw 有两种**独立**的发布类型，通常不会同时执行：

| 类型 | 触发词 | 范围 |
|---|---|---|
| npm 发布 | "发布"、"release" | 仅 `@coclaw/openclaw-coclaw` 插件 |
| GitHub Release | "GitHub 发布"、"项目发布" | 整体项目里程碑 |

## npm 发布流程（默认）

### 前置条件

- 所有变更已合并到 `main` 分支
- `.changeset/` 目录下存在包含 `@coclaw/openclaw-coclaw` 的 changeset 文件
- 工作区干净（无未提交改动）

### 1. 确保 changeset 文件存在，检查待发布变更

先检查 `.changeset/` 目录下是否存在 changeset `.md` 文件（不含 README.md）。
若不存在，需要先创建 changeset 文件（包含变更描述和 bump 级别），随代码一起提交。

changeset 文件格式示例（`.changeset/<name>.md`）：
```markdown
---
"@coclaw/openclaw-coclaw": patch
---

变更描述
```

changeset 文件就绪后，检查状态：

```bash
pnpm changeset:status
```

确认 `@coclaw/openclaw-coclaw` 将 bump、级别是否合理。向用户确认后再继续。

> **注意**：`pnpm changeset:status` 在没有 changeset 文件时会报错退出，这不是异常——说明需要先创建 changeset 文件。

### 2. 隔离非插件 changeset

`pnpm changeset:version` 会消费所有 changeset 文件。若 `.changeset/` 中存在非插件的 changeset（如 ui/server），需暂时移走以避免被一起消费：

```bash
# 将非插件 changeset 移到 /tmp，版本 bump 后再移回
mv .changeset/<non-plugin-changeset>.md /tmp/
```

### 3. 消费 changeset，bump 版本

```bash
pnpm changeset:version
```

此命令会：
- 删除 `.changeset/` 下被消费的 changeset 文件
- 更新 `plugins/openclaw/package.json` 的 version
- 更新/创建 `plugins/openclaw/CHANGELOG.md`

完成后，将步骤 2 中移走的 changeset 移回：

```bash
mv /tmp/<non-plugin-changeset>.md .changeset/
```

### 4. 检查变更并提交

审查 `git diff`，确认版本号和 CHANGELOG 内容正确。

```bash
git add .changeset/ plugins/openclaw/package.json plugins/openclaw/CHANGELOG.md
git commit -m "chore: version @coclaw/openclaw-coclaw@<version>"
```

### 5. 质量门禁

在插件目录下执行验证：

```bash
cd plugins/openclaw && pnpm verify
```

### 6. 发布 npm 包

在插件目录下执行：

```bash
cd plugins/openclaw && pnpm release
```

此脚本（`scripts/release.sh`）会：
- 执行 `pnpm verify`（质量门禁）
- 检查工作目录与 npm 凭据
- dry-run 确认发布内容无敏感文件
- 执行 `npm publish --access public`
- 触发 npmmirror 镜像同步
- 轮询确认发布生效

### 7. 推送（可选）

询问用户是否需要推送到 GitHub：

```bash
git push
```

## 推送到 GitHub

每次推送到 GitHub 时，须确保当前根版本号对应的 git tag 存在：

```bash
# 检查标签是否已存在
git tag -l "v<version>"

# 若不存在，创建轻量标签
git tag v<version>

# 推送代码和标签
git push --follow-tags
```

## GitHub Release 流程

独立于 npm 发布，用于标记项目整体里程碑。

### 前置条件

- 代码已推送到 GitHub（含对应版本的 git tag）
- 确定发布版本号

### 1. Bump workspace 版本并同步根版本

按需 patch bump 各 workspace（server / ui / admin）的版本号（插件版本由 npm 发布流程单独管理，此处不动）。

**根版本号约定**：根 `package.json` 的 `version` 始终保持为所有 workspace（含 plugins）中最高的版本号。bump 完各 workspace 后，取最高版本写入根 `package.json`，一并提交推送。

### 2. 创建 Release

```bash
gh release create v<version> \
  --title "CoClaw v<version>" \
  --generate-notes
```

## 注意事项

- `@coclaw/admin` 已在 changeset config 中 ignore，不参与版本管理
- private 包（server/ui/root）的 changeset 应在插件发布时隔离，避免被误消费
- 发布到 npm 需要用户已 `npm login`，如遇权限问题提示用户检查
