---
description: 处理 GitHub Issues。当用户要求处理、分析、查看 issues 时触发。
---

# GitHub Issues 处理规范

## 启动流程

每次开始处理 issues 时，先执行全局扫描：

1. **拉取所有 open issues**：`gh issue list --state open`，获取标题、标签、创建时间
2. **识别 bug 类 issues**：包括标记了 `bug` 标签的，以及从标题/内容判断属于 bug 性质的（即使未打标签）
3. **逐条分析**：对每个 bug 类 issue 简要说明问题本质、影响范围（ui/server/plugin）、当前状态（待排查/已有线索/疑似已修复等）
4. **列表呈现**：按优先级排列，由用户甄选处理哪些问题

未经用户确认，不主动开始修复工作。

## Bug 修复后的关闭策略

采用"回复 + 关闭 + 允许 reopen"策略：

1. 在 issue 中回复：说明原因、修复方式、涉及的 commit 或版本
2. 请用户验证：提示更新到最新版本后验证
3. 关闭 issue：附带"如仍有问题请 reopen 此 issue"
4. 回复语言：与 issue 原文语言一致（中文 issue 用中文回复）

## Enhancement / Feature Request

- 非 bug 类 issue（enhancement、feature request 等）单独归类呈现
- 处理方式由用户决定，不与 bug 混在一起排优先级

## 交叉引用

- 修复 bug 时遵循项目根 `CLAUDE.md` 中的"Bug 修复流程"（修复 → review → 补测试 → 验证）
- 涉及代码改动的 issue，处理前应加载对应工作区的 instructions（ui/server/plugin 的 CLAUDE.md）
