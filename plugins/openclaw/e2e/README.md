# E2E 测试

跑：`pnpm run e2e`（plugin 工作区）。

**默认 `pnpm test` 不跑这套**——E2E 黑盒、依赖真 gateway、要 LLM 实跑，不适合进 CI 常规 lane。需要回归验证时手动跑。

## 前置

1. gateway running（`openclaw gateway status` 看 connectivity probe 通）
2. **当前 plugin 已 link 到 stage**（`pnpm run link` + 等 gateway 重启完）——直接跑 npm 装的稳定版起步 E2E 没意义
3. 本机有可用的 model provider（默认 codex backend）；如果跑 subagent 用例需要 prompt 能诱发模型调 `sessions_spawn` tool
4. **本机务必是测试环境**——E2E 会真改 `~/.openclaw/agents/main/sessions/coclaw-chat-history.json`，跑完不会自动回滚

## 环境变量

- `OPENCLAW_STATE_DIR`：覆盖默认 `~/.openclaw` state 目录
- `OPENCLAW_CLI`：覆盖默认 `openclaw` CLI 二进制名/路径（少用）

## 当前覆盖

`chat-history.e2e.spec.js`：

| 场景 | 验证 |
|---|---|
| reset reason=reset | length+1，旧 head 翻 archived 排 pos[1] |
| reset reason=new | 同上 |
| 5 次 reset 幂等 | length+5，archived 段时间戳严格 desc |
| 多 agent 隔离 | `tester` agent reset 不影响 `main` bucket |
| explicit fake sessionKey 守卫 | sessions.create + `agent:main:explicit:<uuid>` 不入档 |
| subagent spawn 守卫 | 顶级键不新增 `agent:*:subagent:*` 形态 |
| gateway 重启韧性 | systemctl restart 后 chat-history.json 仍可解析、新 sid 已落盘（atomic write） |

`cron-eviction.e2e.spec.js`（cron 顶替修复主题，dump tmp/cron-session-eviction--clear-dump.md 场景 4/5/9）：

| 场景 | 验证 |
|---|---|
| cron sessionKey 守卫 | sessions.create + `agent:main:cron:<job>:run:<sid>` 被 `classifyChatHistorySessionKey` 挡掉，不入档 |
| `__persist` sanitize 自愈 | 手工注入 list[1..] 缺 archivedAt 的脏 entry，下次写盘时被强制补 archivedAt |
| 启动 reconcileAll 兜底 | 预置 chat-history head 与 sessions.json head 分歧（cron 顶替滞后场景），systemctl restart 后启动对账修齐 |

## 不在 E2E 范围、由单元测试覆盖

- 嵌套 subagent（`agent:main:subagent:a:subagent:b`）守卫：`index.test.js`
- agentId 字面叫 `subagent` 不误伤：`index.test.js`
- recordSessionTransition 13+ 个边界（双源到达顺序、archivedSessionId 错位、并发等）：`src/chat-history-manager/manager.test.js`
- realtime-bridge 订阅/重连/事件分发：`src/realtime-bridge.test.js`
- `listAllEntries` 损坏 JSON / 数组形态 / 空 sessionKey 兜底：`src/session-manager/manager.test.js`

E2E 只验证"端到端串起来对不对"——具体每条路径的边界由单测钉死。

## 未覆盖（已知 / 触发太难）

- **IM channel sessionKey 行为快照**：需要绑 Telegram / Discord 等渠道才能触发；当前预期入档不挡
- **快速连续 reset A→B→C 双源乱序**：红测 skip pending root-cause fix；e2e 跑 5 连击通过，但 A→B→C 真乱序的人工触发极困难（看 TODO.md）
- **sessions.json 真实损坏文件兜底**：risk too high to corrupt the primary index in e2e；改用单测覆盖 `listAllEntries` 损坏 JSON / 数组形态分支
