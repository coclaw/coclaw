# remoteLog 命名空间字典

UI / plugin 通过 `remoteLog(text)` 把关键事件汇到 server。每条形如 `<模块>.<事件> key=value key=value ...`。

排查时熟悉每个事件的**触发位置**和**字段语义**比通读日志快十倍。新加事件请同步补到本字典。

## agent.run.* — Agent run 生命周期

| 事件 | 触发位置（UI 侧） | 关键字段 | 含义 |
|---|---|---|---|
| `agent.run.registered` | `agent-runs.store.register` 真正注册成功 | `runId`、`runKey`、`clawId` | run 进入 store，开始有完整生命周期跟踪 |
| `agent.run.preaccept-failed` | `runAgent` 内 pre-accept RPC reject | `runKey`、`code`、`msg` | 服务端拒绝（参数 / 权限 / agent 不存在） |
| `agent.run.norun` | RPC ok=true 但 result 没 accepted | `runKey` | 罕见。服务端协议异常 |
| `agent.run.send-cancelled` | `sendMessage` 内 USER_CANCELLED 早 return | `accepted=true/false`、`runKey` | 用户主动取消（accepted 标识 register 是否已发生） |
| `agent.run.upload-cancelled` | `sendMessage` 上传阶段被取消 | `runKey` | 用户主动取消文件上传 |
| `agent.run.send-retry` | `sendMessage` 断连重试中间态 | `code`、`runKey` | DC 临时断连，进入重试。看后续是否 `send-failed` 或 `registered` |
| `agent.run.send-failed` | `sendMessage` 兜底 throw | `code`、`runKey` | PRE_ACCEPTANCE_TIMEOUT / retry 失败 / 其它。是 chat.store 自己 180s 看门狗触发，与 runAgent 主 RPC `timeout=0` 异步 |
| `agent.run.end` | `endRun` 唯一入口 | `runId`、`runKey`、`reason` | run 终结。reason 见下表 |
| `agent.run.preempt` | 新 run 抢占旧 run | `prevRunId`、`newRunId` | superseded reason 的前置 |
| `agent.run.drop` | dropRun 真清掉 store 记录 | `runId` | endRun 之后的 GC |
| `agent.run.rpc-grace-elapsed` | RPC 优雅退出窗口耗尽 | `runId` | 后续会 endRun reason=failed |

### `agent.run.end reason` 取值

| reason | 含义 |
|---|---|
| `failed` | 主 RPC reject（DC 死或服务端 ok=false） |
| `rpc` | 正常二阶段 res 完成 |
| `wait` | wait(0) 探测命中终态 |
| `timeout` | UI 端看门狗触发 |
| `superseded` | 被新 run 抢占 |
| `cleanup` | 主动 cleanup |
| `claw-removed` | claw 被移除 |
| `logout` | 用户登出 |

## conn.* — DC 与 RPC 拒绝

| 事件 | 字段 | 含义 |
|---|---|---|
| `conn.rejectPending` | `claw=<X>`、`count=<N>`、`code=<Y>` | DC close 时一次性拒绝挂起 RPC 的总览 |
| `conn.rejectPending.detail` | `claw=<X>`、`method=<M>`、`reqId=<R>` | 每条挂起 RPC 的明细。`method=agent` 即被拒绝的 sendMessage 主 RPC |

## rtc.* — RTC 关键事件

| 事件 | 字段 | 触发条件 | **不会**触发的场景 |
|---|---|---|---|
| `rtc.unrecoverable` | `claw=<X>`、`attempts=<N>` | ICE restart 180s 预算耗尽，PC 即将 rebuild | init 超时、`dc.onclose`、`createOffer` 异常、其他 `close({asFailed:true})` 路径 |

> `rtc.unrecoverable` 是**窄路径事件**——只覆盖 ICE restart 一直失败到耗尽预算这一种。其他失败路径走 `close({asFailed:true})` 但不打 unrecoverable，不要把它当作"RTC 失败"的兜底信号。

## cancel.* — 取消协调状态机

| 事件 | 含义 |
|---|---|
| `cancel.handoff` | UI 把取消请求 handoff 给插件侧 |

（其余 cancel.* 事件待补充。）

## 其他常见事件（来自历史 SKILL.md "常见事件关键词"）

- **RTC 生命周期**：`sig.state`、`sig.resume`、`restart.trigger`、`ICE restart succeeded`、`stats.pre-restart`、`stats.post-restart-success`、`plugin-probe`、`claw.recover`、`rtc.state`、`rtc.iceState`、`rtc.dump`、`connectionState:`、`iceState:`
- **RPC 异常**：`rpc.timeout`、`rpc-queue.overflow-start`、`rpc-queue.overflow-end`、`rpc-queue.close`、`drop reason=queue-full`、`drop reason=single-msg-oversize`
- **前后台 / 网络**：`app.stateChange`、`app.network`、`sig.resume source=app:foreground elapsed=<ms>`
- **SSE**：`sse.connected`、`sse disconnected`、`claw.snapshot`
- **文件**：`file.dl.start` / `progress` / `ok`、`dc.received`
- **诊断**：`coclaw.diag`、`embedded.activeRuns.set/delete`

## 字段使用规范

- 形如 `<key>=<value>`，key 用驼峰或下划线均可——**不要带空格**
- value 含空格时不加引号，直接放行尾（grep 用 `\w+=` 分隔）
- `runKey` 是 `<chatKey>:<sessionId>` 拼成的串
- `claw=<X>` 中 X 通常是 clawId 短码，全链路稳定
- `c_<uuid>` 是 PeerConnection 稳定 ID。**同一 SPA 实例内跨 ICE restart / PC 重建都不变**（代码注释见 `ui/src/services/webrtc-connection.js` 注释 "connId 按 claw 复用、不按 restart 代际"），是关联键首选。会清掉它的入口位于 `signaling-connection.js`（搜 `__connIds.delete` / `__connIds.clear`）和 `claw-connection.js` 的 disconnect 路径——上次梳理时是登出 / claw 被快照剔除 / 信令 WS 主动 disconnect / 收到 server 推送的 `rtc:closed` 这四条；如果哪天发现实际行为对不上这清单，先怀疑代码新增了清理路径，核实后回头更新本条。
	因为这些入口都不会被前后台切换 / 网络抖动触发，所以**同一只 claw 在窗口里 connId 换过 N 次，可以读作 N 次 SPA 软重启（移动端 WebView 被 OS 回收）**。详细判定见 `docs/diagnosis-playbook.md` "SPA 软重启识别"。脚本：`scripts/connid-timeline.sh`
