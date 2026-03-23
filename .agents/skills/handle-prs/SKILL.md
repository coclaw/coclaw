---
description: 处理 GitHub Pull Requests。当用户要求处理、审查、合并 PR 时触发。
---

# GitHub PR 处理规范

## 基本原则

- 遵循主流最佳实践处理 PR（review 礼仪、与贡献者的沟通方式、合并/拒绝/请求修改的处理方式等）。以下仅列出项目特有的约定
- **每个 PR 的最终处理策略（合并/拒绝/请求修改）须由用户确认后执行**

## 启动流程

每次开始处理 PR 时，**委派 sonnet 级 subagent** 执行列表整理：

1. `gh pr list --state open` 拉取所有 open PR
2. 列出每个 PR 的概要（标题、作者、关联 issue、改动范围）
3. 主对话呈现整理结果，由用户决定处理顺序和方式

## 上下文管理

批量处理 PR 时，主对话应保持轻量：

- **列表整理委派 sonnet 级 subagent**
- **分析与 review 委派 general-purpose subagent**，继承当前 model，给出具体的审查要求
- 主对话只保留 subagent 返回的结论和决策点
- 这样一轮对话可以处理多个 PR，且 PR 之间的关系清晰可见

## 合并约定

- 默认使用 **squash merge**
- **必须通过 GitHub 端合并**（`gh pr merge --squash`），禁止在维护者本地执行 merge/rebase 操作
- 若 `gh pr merge` 报冲突，**通知提交者 rebase 到最新 main 并解决冲突**，由提交者 force-push 更新 PR 分支后再合并
- 禁止在维护者本地 fetch PR 分支进行 merge、reset 等操作——这会污染维护者的工作区，可能丢失未提交的改动
- Commit message 遵循项目的 commit 规范（`feat(scope):` / `fix(scope):` 等）
- 合并后同步本地：`git pull --rebase origin main`

## 关联 issue 校验

合并前确认 PR 中的 `closes #N` 引用准确：

- 验证 PR 改动是否确实解决了所引用的 issue
- 不相关的 closes 引用应通过 review comment 请贡献者移除，而非维护者直接修改

## 交叉引用

- 涉及 bug 修复的 PR，合并后应确认对应 issue 被正确关闭（参考 handle-issues skill 的关闭策略）
- 涉及代码改动的 PR，review 时应参考对应工作区的 instructions（ui/server/plugin 的 CLAUDE.md）
