---
name: openclaw-issue
description: 向 OpenClaw 上游提交和管理 Issue。Use when 需要向 openclaw/openclaw 仓库报告 bug、提交 feature request，或追踪/回复已提交 issue。
---

# 向 OpenClaw 提交和管理 Issue

## 仓库信息

- 仓库：`openclaw/openclaw`（https://github.com/openclaw/openclaw）
- 本地源码镜像：`./openclaw-repo`

## 模板要求

OpenClaw 禁用空白 issue，**必须使用官方模板**（Bug Report / Feature Request 两种）。

字段以本地镜像模板为准，提交前先读 `openclaw-repo/.github/ISSUE_TEMPLATE/bug_report.yml` / `feature_request.yml`——上游会增改字段（含必填 dropdown），不在此做快照。要点：

- 标题格式 `[Bug]: <描述>` / `[Feature]: <描述>`
- 必填字段逐一覆盖；dropdown 字段从模板 options 中选合法值
- OpenClaw version 用 `openclaw --version` 精确值

## 语言规范

**全程使用美式英语**（CONTRIBUTING.md 明确要求）；代码块、路径、版本号等技术内容保持原样。

## 落款

在 Additional information 字段末尾附上（用 `---` 与正文区分；作用：说明发现背景、自然带出项目链接不刻意推广）：

```
---

Reported by the [CoClaw](https://github.com/coclaw/coclaw) team.
This issue was discovered while developing [@coclaw/openclaw-coclaw](https://www.npmjs.com/package/@coclaw/openclaw-coclaw), a CoClaw channel plugin for OpenClaw.
```

## 提交方式

`gh issue create` 会绕过 YAML form 模板结构，须在 body 中用 Markdown 标题（`### 字段名`）手动复现模板字段结构：

```bash
gh issue create --repo openclaw/openclaw \
  --title "[Bug]: <标题>" \
  --label "bug" \
  --body "<正文>"
```

## 提交前检查清单

- [ ] 已读本地镜像模板，标题格式正确、必填字段逐一覆盖
- [ ] 全文美式英语（color 非 colour 等）
- [ ] 敏感信息已脱敏（token、密钥、私有路径等）
- [ ] 附根因分析或证据（源码行号、路径推导等）；有修复建议则指出具体文件与方向
- [ ] 落款已附加在 Additional information 末尾

## 提交后追踪

所有已提交 issue 登记在 `docs/openclaw-upstream-issues.md`。提交后必做：将编号、类型、标题、状态、提交日期、关联影响追加进表格；本地有 workaround 的在「关联影响」注明位置。

### 定期跟进

1. 读 `docs/openclaw-upstream-issues.md` 获取 issue 列表
2. `gh issue view <number> --repo openclaw/openclaw` 逐条检查状态
3. 状态有变（已关闭、有新回复等）更新追踪文档
4. 修复已发新版则评估移除本地 workaround

### 回复 issue

```bash
gh issue comment <number> --repo openclaw/openclaw --body "<回复内容>"
```

回复同样使用美式英语，保持专业友好语气。
