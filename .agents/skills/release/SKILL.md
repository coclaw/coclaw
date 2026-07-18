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

检查 `.changeset/` 下是否已有 `.md` 文件（不算 README.md）；没有则先创建——文件格式、何时需要、级别规则见 `docs/versioning.md`。归属口径：客户端壳 / 移动端壳 / 面向用户的 UI 行为归 `@coclaw/ui`；纯开发 / 部署基建改动通常不写 changeset。

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

通用 0–5 → push main → 等 CI 绿 → 打/push tag → Release 判断 → 若插件本次 bump 则发 npm。

### 6A. push → CI 闸 → tag → 镜像监控

**前置判断**：本节脚本只适用于「root 版本本次有变化（将产生新 `v*` tag）」；若 root 版本不变（如仅 bump server/plugin 而 ui 仍最高），跳过脚本、走下方"盲区兜底"。

push tag 会**立刻**触发 `publish-images.yaml` 建镜像、且没有第二道闸，所以必须**先确认这次 bump commit 的 CI 通过、再打 tag**——CI 没绿就别打 tag，远端零残留、可干净重来。这段不可逆编排沉淀进 `scripts/release-publish.sh`，一次 Bash 调用跑完：

> **执行提示**：脚本要等 CI + 镜像跑完（正常 ~3–6min）。跑它时**务必把 Bash 工具超时调到上限 `600000`ms（10min），别用默认 120s**，否则没跑完就被工具超时掐断、还得善后。脚本各轮询自带上界、不会无限等。

```bash
bash scripts/release-publish.sh <root-version>    # 0.32.11 或 v0.32.11 均可
bash scripts/release-publish.sh --decide HEAD     # 可选预演：只打印镜像推导，不碰远端（参数是 git ref，通常在 bump commit 后用 HEAD，不是版本号）
```

脚本一次跑完 push → CI 闸 → 打/push tag → 镜像监控，安全属性已内建（钉确切 SHA——非裸 HEAD，防等 CI 期间本地 main 被推进而 tag 套到未验 commit；CI 红/超时中止不打 tag；push tag 失败回滚本地 tag；镜像监控非门禁）。**退出语义**：

- **push 失败 / CI 红 / CI 超时 → 非零退出**，均在打 tag 前中止，远端零 tag、零镜像，可干净重来。
- **镜像监控失败 / 超时 → echo `WARN` 但 exit 0**：tag 已推、`publish-images.yaml` 已不可逆触发，这步只确认、非门禁；看到 WARN 去 Actions 页核实即可。
- CI 超时后手动善后补打 tag 时，每个 tag 单独 `git push origin <tag>`——与 branch 或多个 tag 混推**不触发** workflow。

镜像该建哪些（server / ui / 两者）由脚本**自动推导**——与 `publish-images.yaml` 同源（自上个 tag 起的路径 diff，根依赖变更则全建），据此调监控节奏（含 server 的 arm64 慢构建先等过拐点，仅 ui 从头短轮询）并校验实际构建。

> **盲区兜底：root 版本不变（tag 已存在）**：此时**别指望脚本管镜像**——对已存在 tag 的 push 是 no-op、不会触发新构建。脚本的镜像监控只认本次 tag 触发的新 run（按 tag 名 + SHA + 新于推 tag 前的 run 快照三重过滤），此情形下会 WARN「未找到本次 tag 触发的 run」而不误报成功，但它不会替你触发构建。正确做法：手动 `git push origin main` → 等该 SHA 的 CI 绿 → `gh workflow run publish-images.yaml` 补建。手动触发**始终全建**（拿不到 tag 语义、不做选择性构建），是该盲区的可靠兜底。

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

通用 0–5 → 跑 6A 的 `scripts/release-publish.sh`（同一道 CI 闸与前置判断：root 版本没变同样走盲区兜底）→ Release 判断。**步骤完全同 A，跳过 8A**——即使本次插件有 bump 也不发 npm（用户的明确意图，留到下次 A 模式时再发）。

> **B 后想补发 npm**（不再 bump、发当前版本）：直接 `cd plugins/openclaw && pnpm release`，相当于补做 8A。

---

## 模式 C：紧急 npm

通用 0–5（**跳过第 4 步**）→ `cd plugins/openclaw && pnpm release`。**不 push、不 tag、不 Release**。

> **CI 闸不涉及 C**：不打 tag → 不触发镜像构建，无需等 CI；且 `pnpm release` 本就先跑 `pnpm verify`（本地全门禁，失败即 abort），已有一道保险。

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
