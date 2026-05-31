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
`<repo>/.agents/worktrees/<名>`（EnterWorktree 回显的 `.claude/...` 是同一处）。

## 插件（plugins/openclaw）：还有坑 A——活主网关只认主检出

主网关装的插件 `src` 是软链回**主检出**，所以 worktree 改插件 + restart 主网关**看不到**。
两条验证路子：

- **默认（方案 A）**：worktree 里 `cd <wt>/plugins/openclaw && pnpm verify`（单测+lint）。覆盖不到加载/RPC/双实例/WebRTC。
- **要活网关（方案 B）**：worktree 里 `pnpm wt:up` → `pnpm wt:call <method>` → 改 src 后 `pnpm wt:reload` → 用完 `pnpm wt:down`。起的是隔离 profile 网关，主网关 / 主 config 全程不动。

**机制、成本、红线、偶发坑的完整说明在 [`plugins/openclaw/docs/worktree-plugin-dev.md`](../../../plugins/openclaw/docs/worktree-plugin-dev.md)——动手前读它。**

## ui / server

没有坑 A（按 cwd 跑，进对目录就是 worktree 码），只有坑 B。`cd <wt>/ui && pnpm dev` / `pnpm test` 即可。

## 红线

- **别在 worktree 里 `pnpm run link`**——会把主网关共享 config 指到 worktree stage，worktree 删后主网关起不来。验活网关只走 `pnpm wt:*`。
- 用完 `pnpm wt:down` 清隔离 profile；删 worktree / 分支前确认提交已合回 main（分支没合就删＝提交真丢）。
- 别在 worktree 会话里裸 `git worktree remove` 删自己 cwd；合回站 main 执行 `git -C <main> merge worktree-<名>`。
