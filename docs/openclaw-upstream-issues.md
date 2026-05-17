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
| [#51532](https://github.com/openclaw/openclaw/issues/51532) | Feature | Allow `agent()` RPC to honor caller-supplied sessionId when agentId is provided | Open | 2026-03-21 | **2026-05-17 重评**：上游已于 v2026.4.5（commit `cd36ff7483`，2026-04-04）经 explicit fake sessionKey 机制解除该约束；CoClaw UI 仍守 main-only 守卫，是否开放多 agent topic 待产品决策。详见 `docs/decisions/topic-main-agent-constraint.md` §"2026-05-17 重评" + `docs/openclaw-research/topic-feature-research.md` 第十章 |
| [#53317](https://github.com/openclaw/openclaw/issues/53317) | Bug | Gateway overwrites fresh OAuth token with stale cached state on startup | Open | 2026-03-24 | Login 后 gateway 内存 snapshot 仍为旧 token，导致不必要的 refresh；workaround：login 后 `openclaw gateway restart` + preload 脚本（`~/.openclaw/scripts/`） |
| [#42176](https://github.com/openclaw/openclaw/issues/42176) | Bug | openai-codex OAuth login does not honor proxy env for token exchange and refresh | Open | 2026-03-13 | OAuth refresh 在 proxy dispatcher 初始化前执行，导致 403；workaround：`--require` preload 脚本在进程启动时设置 undici 全局代理（`~/.openclaw/scripts/`） |
| [#54050](https://github.com/openclaw/openclaw/issues/54050) | Bug | External CLI sync unconditionally overwrites fresh OAuth token with stale `~/.codex/auth.json` | Open | 2026-03-25 | `syncExternalCliCredentials` 不比较 expires，旧 Codex CLI token 覆盖新 login token 导致 `refresh_token_reused`；workaround：`mv ~/.codex/auth.json ~/.codex/auth.json.bak` |
| [#66015](https://github.com/openclaw/openclaw/issues/66015) | Bug | `getChildLogger` sub-loggers ignore configured `logging.level` — debug logs leak to log file | Open | 2026-04-13 | cron debug 日志每 60s 污染 `openclaw logs` 输出；workaround：`script -qc "openclaw logs --follow" /dev/null \| grep -vP 'debug.*cron'` |
| [#66531](https://github.com/openclaw/openclaw/issues/66531) | Feature | Add `agent.abort` RPC to cancel embedded agent runs | Open | 2026-04-14 | 外部客户端（CoClaw UI、ACP 客户端）无官方 API 取消 `agent()` 发起的 run；workaround：插件 RPC `coclaw.agent.abort` via `globalThis[Symbol.for("openclaw.embeddedRunState")]` 侧门，见 `plugins/openclaw/src/agent-abort.js` |
| [#66532](https://github.com/openclaw/openclaw/issues/66532) | Feature | Expose `abortEmbeddedPiRun` family on `api.runtime.agent` | Open | 2026-04-14 | 插件获取 abort 能力只能走侧门，同上 workaround |
| [#66534](https://github.com/openclaw/openclaw/issues/66534) | Bug | `lifecycle:end` event payload missing `aborted` and `stopReason` on pi-embedded path | Open | 2026-04-14 | UI 无法从 lifecycle 事件本身区分 abort vs 正常完成；workaround：CoClaw UI 从 `agent()` RPC completion frame 的 `result.meta.aborted` 判定，见 `docs/designs/agent-run-cancellation.md` |
| [#66535](https://github.com/openclaw/openclaw/issues/66535) | Bug | `/compact` command cannot be canceled while in progress | Open | 2026-04-14 | `/compact` 进行中无法中断；workaround：CoClaw UI 在 `/compact` 期间禁用取消按钮（`ChatInput.cancelDisabled` prop），见 `ui/src/components/ChatInput.vue` + `ui/src/views/ChatPage.vue` |
| [#74325](https://github.com/openclaw/openclaw/issues/74325) | Bug | gateway restart blocks main thread for ~75s — `sidecars.channels` takes 45s, then a second ~28s freeze right after "gateway ready" | Open | 2026-04-29 | gateway 重启后 ~80 秒内插件无法服务；bridge 的 gateway WS 握手撞上 30s 超时被关闭后再退避 5s 重试；UI 端 DC 已通但常规 RPC 报 `gateway_not_ready`。暂无 workaround；插件侧可考虑加客户端握手超时与扩大 `__waitGatewayReady` 容忍 |
| [#75069](https://github.com/openclaw/openclaw/issues/75069) | Bug | Bundled plugin runtime mirror runs synchronously on every pi-agent invocation, blocking the gateway main thread for tens of seconds (regression in 2026.4.22+) | Open | 2026-04-30 | 首次 agent run 卡 ~89.5s（4 轮全 plugin sync mirror sweep，cold fs 放大），后续 agent run 每次仍卡数十秒；plugin 侧 lag 探针已落地 (`plugins/openclaw/src/realtime-bridge.js` commit `11862c5`)；UI 侧 rpcTrace 已落地 (`ui/src/services/claw-connection.js` commit `931d753`)。暂无 workaround，等上游 async 改造 |
| [#80697](https://github.com/openclaw/openclaw/issues/80697) | Bug | status / sessions.list / models.list block event loop ~9s per call due to plugin manifest cache miss on every session row | Open | 2026-05-11 | UI 冷启动首屏 4 个 RPC（status / models.list / sessions.list / topics.list）每次卡 ~9.6s；每个 session row 都重建插件清单，70+ session × 2 次 ≈ 7.3s 重复工作；workaround：本地 patch `~/.nvm/.../openclaw/dist/manifest-model-id-normalization-*.js` 给 `loadManifestModelIdNormalizationPolicies` 加进程级 fallback cache（60s TTL），CLI 11s→3.8s、UI 首屏 ~10s→~2.9s |
| [#81355](https://github.com/openclaw/openclaw/issues/81355) | Bug | First-load RPC fanout: tts.status monopolizes event loop ~1.5s and applyPluginAutoEnable recomputes 8× per fanout | Open | 2026-05-13 | UI 冷启动 fanout 总耗时 1.3-2.7s：(A) `tts.status` 是 async 但内部零 await，4 段同步代码 + `readFileSync` 共 ~1.5s 独占主线程，连带卡住所有同 tick handler；(B) `applyPluginAutoEnable` 同 `config`/`env` 引用被算 8 次共 ~600ms。暂无 workaround，等上游修；建议补丁：tts.status 内部 await + provider 并发探测；applyPluginAutoEnable 加 `WeakMap<config, WeakMap<env, result>>` 缓存 |

## 已提交 issues 组：Agent Run 取消相关

源于 [`agent-run-cancellation.md`](./openclaw-research/agent-run-cancellation.md) 调研，四项互相关联的遗留问题已全部提交（#66531 / #66532 / #66534 / #66535）。合并后按 [`docs/designs/agent-run-cancellation.md`](./designs/agent-run-cancellation.md) 阶段 3 末尾的"CoClaw 侧适配路径"表渐进迁移。
