---
name: release
description: 版本发布流程。默认仅发布 npm 包（plugins/openclaw），用户明确说"GitHub 发布/项目发布"时才额外创建 GitHub Release。当用户要求"发布"、"release"、"bump 版本"时使用。
---

# 版本发布流程

## 发布范围判断

- 用户说"发布"、"release" → **仅 npm 发布**（步骤 1-5）
- 用户说"GitHub 发布"、"项目发布"、"整体发布" → npm 发布 + GitHub Release（步骤 1-6）

## 前置条件

- 所有变更已合并到 `main` 分支
- `.changeset/` 目录下存在待消费的 changeset 文件（非 config.json/README.md）
- 工作区干净（无未提交改动）
- `pnpm verify` 已通过

## npm 发布流程（默认）

### 1. 检查待发布变更

```bash
pnpm changeset:status
```

确认哪些包将 bump、bump 级别是否合理。向用户确认后再继续。

### 2. 消费 changeset，bump 版本

```bash
pnpm changeset:version
```

此命令会：
- 删除 `.changeset/` 下的 changeset 文件
- 更新受影响包的 `package.json` version
- 更新/创建各包的 `CHANGELOG.md`

### 3. 检查变更并提交

审查 `git diff`，确认版本号和 CHANGELOG 内容正确。

```bash
git add .changeset/ **/package.json **/CHANGELOG.md
git commit -m "chore: version packages"
```

### 4. 发布 npm 包

仅 `@coclaw/openclaw-coclaw`（非 private）会被实际发布。

```bash
pnpm changeset:publish
```

此命令会：
- 对非 private 包执行 `npm publish`
- 为发布的包创建 git tag（如 `@coclaw/openclaw-coclaw@0.2.0`）

### 5. 推送

```bash
git push --follow-tags
```

npm 发布到此结束。

### 6. GitHub Release（仅在用户明确要求时）

```bash
gh release create v$(node -p "require('./package.json').version") \
  --title "CoClaw v$(node -p "require('./package.json').version")" \
  --generate-notes
```

## 仅创建 GitHub Release（无 npm 变更）

如果 `plugins/openclaw` 没有变更，但 server/ui 有重要更新需要标记：
1. 手动 bump 根 `package.json` 版本
2. 提交并推送
3. 执行步骤 6

## 注意事项

- `@coclaw/admin` 已在 changeset config 中 ignore，不参与版本管理
- private 包（server/ui/root）会 bump 版本但不发布到 npm、不打 git tag
- 发布到 npm 需要用户已 `npm login`，如遇权限问题提示用户检查
