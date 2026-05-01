# 诊断 Playbook

按用户描述的现象快速锁定根因。每条 playbook 含**触发现象**、**判定步骤**、**根因分流**。

排查中识别到一个新的通用模式，请回写到本文件（不重复就追加，重复就补细节）。

---

## "任务未完成 + 终止按钮消失但 plugin 还在跑" — 零 endRun 信号

**触发现象**：用户描述某次发消息后没结果、UI 不转圈、但插件那边像还在跑。

### 第 1 步：grep `agent.run.end` 看该 runKey 的命中数

```bash
LC_ALL=C grep -aE "agent.run.end" /tmp/srv.log | LC_ALL=C grep -a "runKey=<RUNKEY>" | wc -l
```

**判定**：

| 命中数 | 结论 | 下一步 |
|---|---|---|
| **0** | run **从未 register 进 store** → 根因在 `agent-runs.store.register` 之前的 sendMessage pre-accept 链路 | **跳到第 2 步** |
| **≥ 1** | register 过了，按 reason 分流即可 | **跳到第 3 步** |

> **强保证基础**：ClawConnection 是单例（`claw-connection-manager.js` connect 幂等返回同一实例），且 close 路径必 reject pending（`claw-connection.js __rejectAllPending`）。这两条把"register 之后悄无声息没 endRun"的可能性堵死，所以**零 endRun 一定是 pre-accept 阶段问题**。

### 第 2 步（零 endRun）：sendMessage pre-accept 阶段的命中点

按命中优先级 grep：

| remoteLog 事件 | 含义 | 下一步 |
|---|---|---|
| `agent.run.preaccept-failed code=<X>` | runAgent 内 pre-accept RPC 拒绝 | 看 code/msg；服务端拒绝（参数/权限/agent 不存在） |
| `agent.run.send-cancelled accepted=...` | sendMessage USER_CANCELLED 早 return | 用户主动取消；`accepted` 标识 register 是否已发生 |
| `agent.run.upload-cancelled` | sendMessage 上传阶段被取消 | 用户取消上传 |
| `agent.run.send-retry code=<X>` | sendMessage 断连重试中间态 | 看后续是否 `agent.run.send-failed` 或 `agent.run.registered` |
| `agent.run.send-failed code=<X>` | sendMessage 兜底 throw | PRE_ACCEPTANCE_TIMEOUT / retry 失败 / 其它 |
| `agent.run.norun` | RPC ok=true 但未 accepted（罕见） | 服务端协议响应错位 |

**全部都没命中**：说明请求根本没发出去。

```bash
LC_ALL=C grep -aE "conn.rejectPending.detail" /tmp/srv.log | LC_ALL=C grep -a "method=agent"
```

- 命中 → DC close 时被 reject 掉（看 `conn.rejectPending` 总览的 code）
- 也没命中 → 链路彻底没建起来，回头看 `sig.*` / `restart.trigger` / `rtc.unrecoverable`

### 第 3 步（命中 ≥ 1）：按 endRun reason 分流

```
reason=failed     → 主 RPC reject（DC 死或服务端 ok=false）
reason=rpc        → 正常二阶段 res 完成
reason=wait       → wait(0) 探测命中终态
reason=timeout    → UI 端看门狗触发
reason=superseded → 被新 run 抢占（前面应有 agent.run.preempt）
reason=cleanup / claw-removed / logout → 各自外部路径
```

reason 详细取值见 `ui/src/stores/agent-runs.store.js` 中 `endRun`。

### 决策树（速查图）

```
用户报"任务未完成"
│
├── grep agent.run.end runKey=X → 窗口内是否 0 次？
│   ├── 是 → run 从未 register；查 agent.run.preaccept-failed / .send-failed / .send-cancelled / .upload-cancelled / .send-retry → 哪条命中？
│   │       └── 都没命中 → 检查 conn.rejectPending.detail method=agent → 有则 RPC 被 close 拒；无则请求根本没发出
│   └── 否 → register 过了；按 agent.run.end reason 分类继续追
│           reason=failed     → 主 RPC reject（DC 死或服务端 ok=false）
│           reason=rpc        → 正常完成
│           reason=wait       → wait(0) 探测命中终态
│           reason=timeout / superseded / cleanup / claw-removed / logout → 各自外部路径
│
└── 同时 grep rtc.unrecoverable 看是否 RTC 彻底失联过
```

---

## "用户感觉断了一会但又恢复了" — RTC 不可恢复路径辨认

**触发现象**：用户报"突然没反应了一会，然后又好了"。

### 第 1 步：是否到了 PC rebuild

```bash
LC_ALL=C grep -aE "rtc.unrecoverable" /tmp/srv.log
```

| 结果 | 含义 |
|---|---|
| 命中 | ICE restart 180s 预算耗尽、PC 已重建。该 claw 上若有 active run，UI 弹了一次 notify |
| 无命中 | 不是这条路。其他 `close({asFailed:true})` 路径（init 超时 / `dc.onclose` / `createOffer` 异常）**不会触发 rtc.unrecoverable** |

> `rtc.unrecoverable` 是**窄路径事件**——只覆盖"ICE restart 一直失败到耗尽预算"。其他失败路径走 `close({asFailed:true})` 但不打 unrecoverable。

### 第 2 步：定位失联起点和恢复点

```bash
LC_ALL=C grep -aE "restart.trigger|ICE restart succeeded|sig.resume|claw.recover" /tmp/srv.log | LC_ALL=C grep -a "<CLAW_ID>"
```

时间线跨度 = 用户感知的"卡住时长"。

---

## 常用日志拉取命令模板

按 runKey 全链路（最常用）：

```bash
LC_ALL=C grep -aE "runKey=<KEY>" /tmp/srv.log
```

按 clawId 全链路：

```bash
LC_ALL=C grep -aE "claw=<CLAW_ID>" /tmp/srv.log
```

只看 reject + 失联类（异常窗口排查）：

```bash
LC_ALL=C grep -aE "rtc.unrecoverable|conn.rejectPending|agent.run.preaccept-failed|agent.run.send-failed" /tmp/srv.log
```

按 PeerConnection ID（跨 ICE restart 稳定）：

```bash
LC_ALL=C grep -aE "c_<UUID_PREFIX>" /tmp/srv.log
```
