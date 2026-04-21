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

> **语言约定**：所有发布相关的描述文本一律用英语，包括：commit message、changeset 描述、CHANGELOG、`gh release` 的 title/body 等。

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

### 5. 发布 npm 包

在插件目录下执行：

```bash
cd plugins/openclaw && pnpm release
```

此脚本（`scripts/release.sh`）会：
- 执行 `pnpm verify`（质量门禁，失败即 abort，后续步骤不会执行）
- 检查工作目录与 npm 凭据
- dry-run 确认发布内容无敏感文件
- 执行 `npm publish --access public`
- 触发 npmmirror 镜像同步
- 轮询确认发布生效

### 6. 推送（可选）

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

# 推送代码和标签（轻量 tag 可能需要额外显式 push）
git push --follow-tags
git push origin v<version>  # 若上一步未推送 tag
```

push 完成后，按下一节规则判断是否创建 GitHub Release。

## GitHub Release 流程

独立于 npm 发布，用于标记项目整体里程碑，是 Release 页面的"浓缩视图"。tag 是"技术快照"、Release 是"值得回顾的节点"——二者可以分离。

### 何时创建

| 场景 | 是否创建 |
|---|---|
| **minor / major bump**（如 0.17.x → 0.18.0） | **必打** |
| **新 minor 发布时**，上一个 minor 的**最终 patch** | **补打一个**（先补旧 minor 末版，再打新 minor 首版） |
| **patch bump**，含面向终端用户的**重要修复**（数据损坏、启动失败、安全等） | **Claude 判断，必要时提示用户确认** |
| **patch bump**，普通小修 / 纯内部改动 | **不打**，累积到下次 minor |

**"Claude 判断"的操作要求**：push 完成后，Claude 应结合以下因素综合评估，再决定是否主动提示用户：
- 本次 patch 的变更规模、影响范围、是否面向终端用户
- 距上一个已创建 Release 累积的 patch 数量与跨度（例如上个 Release 后已累积 ≥5 个 patch 可考虑补一个节点）
- GitHub Releases 页面的既有节奏（参考 `gh release list` 的最近几条）

若判断可能有必要 → 以一句话提示用户："本次是否创建 Release？理由：xxx"，等用户确认；若判断明显无必要 → **不打扰**，直接跳过，在收尾汇报中简短说明"本次 patch 未创建 Release（理由）"。

### 创建 Release（命令）

```bash
gh release create v<version> \
  --title "CoClaw v<version>" \
  --generate-notes \
  --notes-start-tag v<prev-release-tag>
```

`<prev-release-tag>` 是 GitHub 上**上一个已存在的 Release 的 tag**（不是"上一个 git tag"）。用 `gh release list --limit 3` 确认。

需要 gh ≥ 2.28 支持 `--notes-start-tag`。

### 新 minor 时的双 Release 操作

从 v0.N.x 跨入 v0.N+1.0 时，按顺序执行两次 create：

1. **先为 v0.N 系列的最终 patch 创建 Release**（起点为上一个已有 Release）
2. **再为 v0.N+1.0 创建 Release**（起点为第 1 步创建的 v0.N 最终 patch）

这样两个 Release 的 notes 范围不重叠、衔接完整。

## 注意事项

- `@coclaw/admin` 已在 changeset config 中 ignore，不参与版本管理
- private 包（server/ui/root）的 changeset 应在插件发布时隔离，避免被误消费
- 发布到 npm 需要用户已 `npm login`，如遇权限问题提示用户检查
