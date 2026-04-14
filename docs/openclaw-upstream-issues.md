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
| [#54050](https://github.com/openclaw/openclaw/issues/54050) | Bug | External CLI sync unconditionally overwrites fresh OAuth token with stale `~/.codex/auth.json` | Open | 2026-03-25 | `syncExternalCliCredentials` 不比较 expires，旧 Codex CLI token 覆盖新 login token 导致 `refresh_token_reused`；workaround：`mv ~/.codex/auth.json ~/.codex/auth.json.bak` |
| [#66015](https://github.com/openclaw/openclaw/issues/66015) | Bug | `getChildLogger` sub-loggers ignore configured `logging.level` — debug logs leak to log file | Open | 2026-04-13 | cron debug 日志每 60s 污染 `openclaw logs` 输出；workaround：`script -qc "openclaw logs --follow" /dev/null \| grep -vP 'debug.*cron'` |

## 待提交：Agent Run 取消相关

源于 [`agent-run-cancellation.md`](./openclaw-research/agent-run-cancellation.md) 调研，四项互相关联的遗留问题，建议作为一组一起推进。

| # | 类型 | 标题 | 关联影响 | 建议修复要点 |
|---|---|---|---|---|
| TBD | Feature | Add `agent.abort` RPC | 外部客户端（CoClaw UI、Swift 客户端）当前没有官方 API 取消 `agent()` 发起的 run；`chat.abort` 只覆盖 `chat.send` 路径 | 新增 `agent.abort` RPC，接受 `{runId}` 或 `{sessionId}`；内部调用 `abortEmbeddedPiRun(sessionId)`，可与 `chatAbortControllers` 复用或另设 `agentAbortControllers` |
| TBD | Feature | Expose `abortEmbeddedPiRun` etc. via `api.runtime.agent` | 插件当前只能走未文档化侧门 `globalThis[Symbol.for("openclaw.embeddedRunState")]`；`src/agents/pi-embedded.ts` 已 re-export，只是 `runtime-embedded-pi.runtime.ts` 未传递 | 在 `runtime-embedded-pi.runtime.ts` 额外 re-export `abortEmbeddedPiRun` / `waitForEmbeddedPiRunEnd` / `isEmbeddedPiRunActive` / `queueEmbeddedPiMessage`，并在 `types-core.ts` 的 `PluginRuntime["agent"]` 里声明 |
| TBD | Bug/Enhancement | `lifecycle:end` event payload missing `aborted` / `stopReason` | UI 无法从 lifecycle 事件区分 abort vs 正常完成；`handleAgentEnd` 在 `pi-embedded-subscribe.handlers.lifecycle.ts:90-104` 发的 payload 不含这两个字段，command 层 fallback 因 `lifecycleEnded = true` 永远被 skip | `handleAgentEnd` 读取 `lastAssistant.stopReason` 并连同 aborted 标志一并放入 payload |
| TBD | Bug | `/compact` 命令执行中不可取消 | `commands-compact.ts:97-130` 调 `compactEmbeddedPiSession` 不传 `abortSignal`、不注册 `ACTIVE_EMBEDDED_RUNS`；`chat.abort` 与 `abortEmbeddedPiRun` 均无效；用户只能等 `compactionTimeoutMs` | 让 `compactEmbeddedPiSession` 接收并尊重 `abortSignal`，或在 compaction session 上调用 `setActiveEmbeddedRun` 使其进入统一 registry |
