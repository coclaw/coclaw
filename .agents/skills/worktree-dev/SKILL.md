---
name: worktree-dev
description: 在 git worktree 里开发 / 验证 coclaw（plugin/ui/server）的避坑规范——cwd 重置假绿、活网关只认主检出的插件、以及用一次性隔离网关在 worktree 里验真插件代码。Use when 在 worktree 里改 / 跑 / 验证 coclaw 代码，尤其要在活网关验插件改动、或 worktree 下跑 test/lint/dev。
---

# worktree 下开发 / 验证

worktree 让同一工作区也能开多个并行任务。但有两个坑会让你白忙：**改了没生效**和**测了假绿**。

## 坑 B（plugin/ui/server 通用）：cwd 重置 → 假绿

本环境**每条 Bash 命令结束后 cwd 重置回主检出**。在 worktree 里跑任何命令，必须**单条**写成：

```bash
cd <worktree绝对路径>/<工作区> && <cmd>      # 如 cd /home/.../.agents/worktrees/X/ui && pnpm test
```

否则命令在主检出跑，绿是假绿（测的不是你 worktree 的改动）。worktree 真实路径在
`<repo>/.agents/worktrees/<名>`（EnterWorktree 回显的 `.claude/...` 是同一处）。EnterWorktree 若被 `.claude → .agents` 软链挡住，手动 `git -C <repo> worktree add <repo>/.agents/worktrees/<名> -b <分支> HEAD` 即可。

## 坑 C：新 worktree 首装缺件

- `pnpm install` 默认拦 postinstall 构建脚本（approve-builds 机制）→ server 的 prisma client 不会生成，跑 server 测试 / E2E 前先 `cd <wt>/server && pnpm exec prisma generate`。
- worktree 不带 gitignored 文件（如 `server/.env`）——需要时从主检出拷。

## 插件（plugins/openclaw）：还有坑 A——活主网关只认主检出

主网关装的插件 `src` 是软链回**主检出**，所以 worktree 改插件 + restart 主网关**看不到**。
两条验证路子。注意 `wt:*` 脚本只存在于 `plugins/openclaw/package.json`——每条命令都得带 `cd <wt>/plugins/openclaw &&` 前缀（坑 B 同样适用）：

- **默认（方案 A）**：`cd <wt>/plugins/openclaw && pnpm verify`（单测+lint）。覆盖不到加载/RPC/双实例/WebRTC。
- **要活网关（方案 B）**：`pnpm wt:up` → `pnpm wt:call <method>` → 改 src 后 `pnpm wt:reload`（只重启网关，src 在 stage 里是软链；改 `index.js` / manifest / 依赖须重跑 `pnpm wt:up` 重建 stage）→ 用完 `pnpm wt:down`。起的是隔离 profile 网关，主网关 / 主 config 全程不动。fresh profile 不绑定也能验插件加载 + RPC；只有 bridge / WebRTC 端到端才需补绑定凭据。

**机制、成本、红线、偶发坑的完整说明在 [`plugins/openclaw/docs/worktree-plugin-dev.md`](../../../plugins/openclaw/docs/worktree-plugin-dev.md)——动手前读它。**

## ui / server

没有坑 A（按 cwd 跑，进对目录就是 worktree 码），只有坑 B。`cd <wt>/ui && pnpm dev` / `pnpm test` 即可。

## 红线

- **别在 worktree 里 `pnpm run link`**——会把主网关共享 config 指到 worktree stage，worktree 删后主网关起不来。验活网关只走 `pnpm wt:*`。
- 用完 `pnpm wt:down` 清隔离 profile；**`wt:down` 必须在 `git worktree remove` 之前**（先删 worktree 会留下脚本没了、网关还跑的孤儿，此时在任意检出的 `plugins/openclaw` 下 `pnpm wt:down --all` 兜底收）。
- 删 worktree / 分支前确认提交已合回 main（分支没合就删＝提交真丢）：合回站主检出、按全局合回纪律执行（优先 rebase / cherry-pick 重放 fast-forward，不留 merge commit），`git merge-base --is-ancestor <分支> main` 通过再删。别在 worktree 会话里裸 `git worktree remove` 删自己 cwd。
