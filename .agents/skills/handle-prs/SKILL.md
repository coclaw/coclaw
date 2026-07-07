---
name: handle-prs
description: 处理 GitHub Pull Requests。Use when 用户要求处理、审查、合并 PR。
---

# GitHub PR 处理规范

## 基本原则

- 遵循主流最佳实践处理 PR（review 礼仪、与贡献者的沟通方式、合并/拒绝/请求修改的处理方式等）。以下仅列出项目特有的约定
- **每个 PR 的最终处理策略（合并/拒绝/请求修改）须由用户确认后执行**

## 委派与上下文管理

主对话保持轻量：分析类工作默认委派 subagent，主对话只保留返回的结论和决策点——这样一轮对话可以处理多个 PR，且 PR 之间的关系清晰可见。Claude Code 侧派单一律显式传 model，档位策略见全局规范「模型选择倾向」节（Codex 侧按全局 [仅 Codex] 规则，不指定 model）：

- **列表整理**（每次开始处理 PR 时委派，机械整理活）：`gh pr list --state open` 拉取所有 open PR，列出每个 PR 的概要（标题、作者、关联 issue、改动范围）；主对话呈现整理结果，由用户决定处理顺序和方式
- **分析与 review**（把关，用最强档）：委派普通 subagent 并给出具体的审查要求；review 时参考对应工作区的 instructions（ui/server/plugins 各自的 AGENTS.md，CLAUDE.md 为其软链）

## 合并约定

- 默认使用 **squash merge**
- **必须通过 GitHub 端合并**（`gh pr merge --squash`），禁止在维护者本地执行 merge/rebase 操作
- 若 `gh pr merge` 报冲突，**通知提交者 rebase 到最新 main 并解决冲突**，由提交者 force-push 更新 PR 分支后再合并
- 禁止在维护者本地 fetch PR 分支进行 merge、reset 等操作——这会污染维护者的工作区，可能丢失未提交的改动
- Commit message 遵循项目的 commit 规范（`feat(scope):` / `fix(scope):` 等）
- 合并后同步本地：`git pull --rebase origin main`

## 关联 issue 校验

- 合并前验证 PR 中的 `closes #N` 引用准确——改动是否确实解决了所引用的 issue；不相关的 closes 引用应通过 review comment 请贡献者移除，而非维护者直接修改
- 涉及 bug 修复的 PR，合并后应确认对应 issue 被正确关闭
