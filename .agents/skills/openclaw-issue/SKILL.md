---
name: openclaw-issue
description: 向 OpenClaw 上游提交和管理 Issue。当需要向 openclaw/openclaw 仓库报告 bug、提交 feature request，或追踪/回复已提交 issue 时使用。
---

# 向 OpenClaw 提交和管理 Issue

## 仓库信息

- 仓库：`openclaw/openclaw`（https://github.com/openclaw/openclaw）
- 本地源码镜像：`./openclaw-repo`
- 社区：https://discord.com/invite/clawd

## 模板要求

OpenClaw 禁用空白 issue，**必须使用官方模板**。仅两种模板：

### Bug Report

标题格式：`[Bug]: <描述>`

必填字段：

| 字段 | 说明 |
|---|---|
| Bug type | `Regression` / `Crash` / `Behavior bug` |
| Summary | 一句话说明哪里坏了 |
| Steps to reproduce | 最短可复现路径 |
| Expected behavior | 没有 bug 时应有的行为 |
| Actual behavior | 实际发生了什么（含错误信息） |
| OpenClaw version | 精确版本号，如 `2026.3.13`（`openclaw --version`） |
| Operating system | OS 及版本 |
| Model | 使用的模型（若无关填 N/A） |
| Provider / routing chain | 请求路径（若无关填 N/A） |

建议填写的选填字段：
- Install method（npm global / pnpm dev / docker 等）
- Logs, screenshots, and evidence（日志/截图，须脱敏）
- Additional information（额外上下文）

### Feature Request

标题格式：`[Feature]: <描述>`

必填字段：Summary、Problem to solve、Proposed solution、Impact

## 语言规范

- **全程使用美式英语**（CONTRIBUTING.md 明确要求）
- 代码块、路径、版本号等技术内容保持原样

## 落款

在 Additional information 字段末尾附上落款，格式：

```
---

Reported by the [CoClaw](https://github.com/coclaw/coclaw) team.
This issue was discovered while developing [@coclaw/openclaw-coclaw](https://www.npmjs.com/package/@coclaw/openclaw-coclaw), a CoClaw channel plugin for OpenClaw.
```

落款的作用：
1. 说明 bug 发现的背景（为什么我们会触达这个代码路径）
2. 自然引出项目链接，不刻意推广
3. 用分隔线 `---` 与正文内容区分

## 提交方式

使用 `gh issue create`：

```bash
gh issue create --repo openclaw/openclaw \
  --title "[Bug]: <标题>" \
  --label "bug" \
  --body "<正文>"
```

注意：由于 OpenClaw 使用 YAML form 模板（.yml），`gh issue create` 会绕过模板结构直接提交。应在 body 中用 Markdown 标题（`### 字段名`）手动复现模板结构，确保可读性和信息完整性。

## 提交前检查清单

- [ ] 标题符合 `[Bug]:` 或 `[Feature]:` 格式
- [ ] 所有必填字段已填写
- [ ] 全文美式英语（color 非 colour，behavior 非 behaviour 等）
- [ ] 敏感信息已脱敏（token、密钥、私有路径等）
- [ ] 附上根因分析或证据（源码行号、路径推导等）
- [ ] 若有修复建议，指出具体文件和修复方向
- [ ] 落款已附加在 Additional information 末尾

## 提交后追踪

所有已提交的 issue 登记在 `docs/openclaw-upstream-issues.md` 中。

### 提交后必做

1. 将新 issue 追加到追踪文档的表格中，填写：编号、类型、标题、状态、提交日期、关联影响
2. 若本地有 workaround，在「关联影响」中注明 workaround 位置

### 定期跟进

当用户要求检查上游 issue 状态时：

1. 读取 `docs/openclaw-upstream-issues.md` 获取 issue 列表
2. 用 `gh issue view <number> --repo openclaw/openclaw` 逐条检查状态
3. 若状态有变更（已关闭、有新回复等），更新追踪文档
4. 若 issue 被修复并发布了新版本，评估是否可以移除本地 workaround

### 回复 issue

需要在 issue 中跟进回复时：

```bash
gh issue comment <number> --repo openclaw/openclaw --body "<回复内容>"
```

回复同样使用美式英语，保持专业友好的语气。
