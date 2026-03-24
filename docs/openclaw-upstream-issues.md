# OpenClaw 上游 Issue 追踪

我们向 [openclaw/openclaw](https://github.com/openclaw/openclaw) 提交的 issue 和 feature request 汇总。

## 约定

- 提交后在此登记，包含 issue 编号、标题、状态、关联的本地影响
- 定期检查状态更新，必要时在 issue 中跟进回复
- issue 被修复后标注对应的 OpenClaw 版本号，并评估是否可以移除本地 workaround

## Issue 列表

| # | 类型 | 标题 | 状态 | 提交日期 | 关联影响 |
|---|---|---|---|---|---|
| [#51494](https://github.com/openclaw/openclaw/issues/51494) | Bug | `api.runtime.version` returns 'unknown' for plugins in npm-installed OpenClaw | Open | 2026-03-21 | 插件 `coclaw.info` 无法返回 OpenClaw 版本号；已在插件侧做兜底（omit 字段），见 `plugins/openclaw/STATUS.md` |
| [#51532](https://github.com/openclaw/openclaw/issues/51532) | Feature | Allow `agent()` RPC to honor caller-supplied sessionId when agentId is provided | Open | 2026-03-21 | Topic 功能当前仅限 main agent；workaround 见 `docs/designs/topic-management.md` "当前版本约束"章节 |
| [#53317](https://github.com/openclaw/openclaw/issues/53317) | Bug | Gateway overwrites fresh OAuth token with stale cached state on startup | Open | 2026-03-24 | Login 后 gateway 内存 snapshot 仍为旧 token，导致不必要的 refresh；workaround：login 后 `openclaw gateway restart` + preload 脚本（`~/.openclaw/scripts/`） |
| [#42176](https://github.com/openclaw/openclaw/issues/42176) | Bug | openai-codex OAuth login does not honor proxy env for token exchange and refresh | Open | 2026-03-13 | OAuth refresh 在 proxy dispatcher 初始化前执行，导致 403；workaround：`--require` preload 脚本在进程启动时设置 undici 全局代理（`~/.openclaw/scripts/`） |
