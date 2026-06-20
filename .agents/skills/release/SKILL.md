---
name: release
description: 版本发布流程，三种模式：完整发布（bump + push + 视情发 npm）、只 bump push（不发 npm）、紧急 npm（不 push）。Use when 用户要求"发布"、"release"、"bump 版本"、"push 版本"。
---

# 版本发布流程

CoClaw 的发布有三种模式，按用户意图区分。**默认是模式 A**（完整发布）。

## 选模式

| 模式 | 别名 | 涉及动作 |
|---|---|---|
| **A** 完整发布（默认） | release | bump → push + tag → 视情 Release → 若插件本次 bump 则发 npm |
| **B** 只 bump push | github-only | bump → push + tag → 视情 Release（**不发 npm**） |
| **C** 紧急 npm | npm-only | 只 bump 插件 → 发 npm（**不 push、不 tag、不 Release**） |

### 触发词识别

- "发布"、"release"，不带额外限定 → **A**
- "bump 并 push"、"只 push"、"不发 npm"、"先不发 npm"、"只推 GitHub" → **B**
- "紧急 npm"、"只发 npm 不 push"、"hotfix npm"、"npm 紧急包" → **C**
- 用户意图含糊时 → **反问而非默选**

> **语言约定**：所有发布相关文本（commit message、changeset 描述、CHANGELOG、`gh release` title/body）一律用英语。

## 通用阶段（A/B/C 共用）

### 0. 工作区检查

工作区必须干净（无未提交改动），所有变更已在 `main`。

### 1. 确保 changeset 文件存在

检查 `.changeset/` 下是否已有 `.md` 文件（不算 README.md）；没有则先创建——文件格式、何时需要、级别规则见 `docs/versioning.md`。

> **C 模式硬规则**：`.changeset/` 中只能有 `@coclaw/openclaw-coclaw` 的 changeset。如有非插件的（ui/server），先 `mv .changeset/<non-plugin>.md /tmp/` 隔离，npm 发布完再移回。

### 2. 检查 changeset status

`pnpm changeset:status` 确认将要 bump 的工作区与级别：A/B 模式下每个工作区的级别要符合预期；C 模式下应只看到 `@coclaw/openclaw-coclaw`。**向用户确认后再继续**。

### 3. 消费 changeset

`pnpm changeset:version`——删除消费过的 `.changeset/*.md`、更新对应工作区 `package.json` 的 version、更新 / 创建工作区 `CHANGELOG.md`。

### 4. 同步 root 版本（A/B 必做，C 跳过）

> **A/B 硬规则**：root `package.json` 的 `version` 取**所有工作区当前版本（含本次 bump 后）的最高**。changeset **不会自动同步 root**，必须手动 edit。

判断方法：读取 ui / server / plugins/openclaw 当前 version，按 semver 比较取最高，写入 root `package.json`。即使 root 当前已 ≥ 最高，也要确认而非默认跳过——避免漏 bump。（"取最高"是当前约定，略别扭但够用；未来插件发版节奏稳定后可能改为跟随 ui。）

### 5. 提交

按模式分叉 commit message：

- **A/B**：`chore(release): bump versions`，body 列出每个 bump 的 workspace 与新旧版本（含 root）。
- **C**：`chore: version @coclaw/openclaw-coclaw@<version>`，单行。

```bash
git add .changeset/ package.json <bumped-workspaces>/package.json <bumped-workspaces>/CHANGELOG.md
git commit -m "..."
```

---

## 模式 A：完整发布

通用 0–5 → push & tag → Release 判断 → 若插件本次 bump 则发 npm。

### 6A. push & tag

```bash
git push origin main

# 若 tag 不存在
git tag -l "v<root-version>" || git tag v<root-version>
git push origin v<root-version>
```

> **镜像构建**：push 新 `v*` tag 会自动触发 `publish-images.yaml` 建 GHCR 镜像。若本次未 bump 根版本（无新 `v*` tag，仅动 server/plugin 而 ui 仍最高），自动构建不触发，需手动补：`gh workflow run publish-images.yaml`。

### 7A. Release 判断

按"GitHub Release 判断规则"执行（见下方）。

### 8A. 发布 npm（仅当本次插件 bump）

仅当 `@coclaw/openclaw-coclaw` 出现在本次 bump 列表中：

```bash
cd plugins/openclaw && pnpm release
```

`scripts/release.sh` 会：`pnpm verify`（门禁，失败即 abort）→ 检查工作区/npm 凭据 → dry-run → `npm publish --access public` → 触发 npmmirror 同步 → 轮询确认生效。

> **加强验证**：风险较高时用 `pnpm release --prerelease`，发布前先 pack + 安装到 OpenClaw 实测一遍再 publish。

---

## 模式 B：只 bump push

通用 0–5 → push & tag → Release 判断。**步骤完全同 A，跳过 8A**——即使本次插件有 bump 也不发 npm（用户的明确意图，留到下次 A 模式时再发）。

> **B 后想补发 npm**（不再 bump、发当前版本）：直接 `cd plugins/openclaw && pnpm release`，相当于补做 8A。

---

## 模式 C：紧急 npm

通用 0–5（**跳过第 4 步**）→ `cd plugins/openclaw && pnpm release`。**不 push、不 tag、不 Release**。

完成后明确告知用户："本地领先 origin N 个 commit，待下次 A/B 模式批量 push（包括本次的 bump commit）。"

---

## GitHub Release 判断规则（A/B 收尾）

push 完成后按下表判断。**tag 必打，Release 视情况**。

| 场景 | 是否创建 |
|---|---|
| **minor / major bump**（如 0.17.x → 0.18.0） | **必打** |
| **新 minor 发布时**，上一个 minor 的**最终 patch** | **补打一个**（先补旧 minor 末版，再打新 minor 首版） |
| **patch bump**，含面向终端用户的**重要修复**（数据损坏、启动失败、安全等） | **Claude 判断，必要时提示用户确认** |
| **patch bump**，普通小修 / 纯内部改动 | **不打**，累积到下次 minor |

**"Claude 判断"**：综合本次 patch 的变更规模与影响面、距上个已创建 Release 累积的 patch 数量（≥5 可考虑补一个节点）、既有节奏（`gh release list --limit 3`）；必要时一句话提示用户"本次是否创建 Release？理由：xxx"等确认，明显无必要时不打扰、收尾时简述理由。

### 创建 Release

```bash
gh release create v<version> \
  --title "CoClaw v<version>" \
  --generate-notes \
  --notes-start-tag v<prev-release-tag>
```

`<prev-release-tag>` 是 GitHub 上**上一个已存在的 Release 的 tag**（不是"上一个 git tag"），用 `gh release list --limit 3` 确认。

### 新 minor 时的双 Release

从 v0.N.x 跨入 v0.N+1.0 时按顺序两次 create：先为 v0.N 系列的**最终 patch** 创建 Release（起点为上一个已有 Release），再为 v0.N+1.0 创建 Release（起点为前者）。两个 Release 的 notes 范围不重叠、衔接完整。

---

## 注意事项

- `@coclaw/admin` 已在 changeset config 中 ignore，不参与版本管理。
- 发布到 npm 需要 `npm login` 已生效，如遇权限问题提示用户检查。

### Beta 发布（特殊场景）

灰度 / 内测发布走 beta tag，不影响 latest（普通用户拿不到 beta）：

1. 把 plugin 版本号手动改成 `0.x.y-beta.0`（`pnpm release` 默认会拒绝带 `-` 的预发布版本号，必须配合 `--beta`）
2. `cd plugins/openclaw && pnpm release --beta`

beta 发布通常不走 changeset / 不动 root / 不打 git tag——仅是 npm 上的灰度通道。
