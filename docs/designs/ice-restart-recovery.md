# ICE Restart 恢复策略

> 状态：已实施（db12a17 + 9a5cdf0）
> 日期：2026-04-12
> 范���：UI（WebRtcConnection、claws.store、ManageClawsPage）、Server（claw-ws-hub 信令��由）、Plugin（webrtc-peer）

---

## 一、背景与目标

当前连接恢复策略为**全量 PC rebuild**：关闭旧 PeerConnection → reject 所有 pending RPC → 重新建连（ICE gathering + offer/answer + DTLS + SCTP + DC open）。此方案在 werift 时代合理（werift 的 ICE restart 实现不完整，会产生僵尸连接），但代价明显：

- 文件传输中断，需从头重传
- 所有 pending RPC 被 reject（`RTC_LOST`）
- 重建耗时 1-3s（含 DTLS 握手 + SCTP 协商）

Pion 已集成并验证了完整的 ICE restart 支持（`pion-ipc` Phase 1 已完成，含 ICE restart DC 存活集成测试）。核心事实：

- **浏览器（Chrome/Firefox/Safari）**：dcSCTP `max_retransmissions = nullopt` → SCTP 永不中止
- **Pion**：`noMaxRetrans = 0` → SCTP 永不中止
- **DTLS**：基于数据报，不维护连接级超时，session 仅存于内存
- ICE restart 仅重新协商 ICE 层，DTLS/SCTP/DataChannel **完整保留**

> 来源：`docs/study/webrtc-connection-research.md` Appendix C（SCTP 存活机制）、Appendix G（Pion 评估）

### 目标

用 ICE restart 替代全量 rebuild 作为首选恢复手段。PC rebuild 仅在 plugin 已销毁 PC（如 gateway 重启）时执行。

### 核心收益

- 断点续传从根本上解决（file DC 存活）
- pending RPC 不丢失（SCTP 缓冲自动 flush）
- 网络切换无感（proactive restart，旧路径保底）

---

## 二、设计原则

1. **restart-first, rebuild-fallback**：在现有"放弃→rebuild"的出口处插入 restart 尝试，restart 被 reject 才走 rebuild
2. **WebRtcConnection 自愈**：restart 逻辑封装在 WebRtcConnection 内部，store 仅在 restart 被 reject 后介入 rebuild
3. **现有结构不变**：触发点、两层重试、rtcPhase 状态机等保持现有架构
4. **ICE 自恢复与 restart 互斥**：`setLocalDescription(restartOffer)` 使旧 credentials 失效，因此先给 ICE 自恢复 5s 窗口，超时再 restart

---

## 三、状态机变更

### 3.1 WebRtcConnection 内部状态

新增 `restarting` 状态：

```
idle → connecting → connected
                      │
          ┌───────────┼──────────────────┐
          │           │                  │
     disconnected     │           triggerRestart()
     (5s 自恢复)      │           (proactive, from store)
          │           │                  │
          ↓           ↓                  ↓
     __onIceFailed() ─────────→ restarting ←── nudgeRestart()
                                  │  ↑  │
                        ┌─────────┘  │  └─────────┐
                  ICE connected    重试    rtc:restart-rejected
                        ↓            │         / dc.onclose
                    connected        │           ↓
                                     │        failed
                         network:online          ↓
                         foreground         store rebuild
                         periodic(60s)      (__ensureRtc)
```

### 3.2 rtcPhase（store 层）

新增 `restarting` phase，store 在此 phase 不干预：

```
idle → building → ready ⇄ restarting
                    ↓         ↓ (rejected)
                  failed ← failed → recovering → ready
```

---

## 四、各层改动

### 4.1 UI: WebRtcConnection（`ui/src/services/webrtc-connection.js`）

**核心：在现有"放弃"出口处插入 restart 尝试。**

#### 修改的现有出口

| 现有出口 | 当前行为 | 改为 |
|---------|---------|------|
| `__onIceFailed()` | `__setState('failed')` | `__attemptRestart()` |
| keepalive 失败路径 | `this.close()` | `this.__onIceFailed()` |

#### 新增方法

**`__attemptRestart(reason)`**：发起 ICE restart offer

```
1. 守卫：!pc || state=closed → return
2. 同步 setState('restarting')（仅首次，确保状态立即可观测）
3. 首次进入时记录 __restartStartTime
4. 时间预算检查：Date.now() - startTime >= ICE_RESTART_TIMEOUT_MS(90s) → 放弃 → setState('failed')
5. 确保安全网定时器运行（ICE_RESTART_SAFETY_MS=30s，覆盖 failed 未触发的极端场景）
6. 信令 WS 不可用 → 跳过本次 offer（安全网定时器或 nudge 会再来）
7. 并发防护：__restartInFlight → return（防止 timer 与 immediate retry 产生并发 createOffer）
8. 计数递增 + 重置候选缓冲（__remoteDescSet / __pendingCandidates）
9. pc.createOffer({ iceRestart: true })（await 后 bail-out 检查）
10. pc.setLocalDescription(offer)（await 后 bail-out 检查）
11. sendSignaling('rtc:offer', { sdp, iceRestart: true })
```

**`nudgeRestart()`**（public）：store 调用，外部事件触发立即重试

```
if (state !== 'restarting') return;
__attemptRestart('nudge');
```

**`triggerRestart(reason)`**（public）：store 调用，从 connected 主动发起

```
if (state === 'restarting') → __attemptRestart(reason)
if (state === 'connected') → __attemptRestart(reason)
```

#### 修改 `onconnectionstatechange`

```
connected:
  + 如果当前 restarting → 清除 restart 定时器/计数器，log restart 成功
  setState('connected')
  + __startKeepalive()  // 幂等；restart 成功后恢复保活
  __resolveCandidateType(pc)

disconnected:
  + 如果当前 restarting → 忽略（restart 过程中的中间状态）
  否则 → 启动 5s disconnected 超时（现有逻辑不变）

failed:
  + 如果当前 restarting → 本次 ICE check 失败，立即触发 __attemptRestart('ice_check_failed')
  否则 → __onIceFailed()（现有逻辑不变）

closed:
  清除 disconnected timer + restart 状态 → setState('closed')
```

#### 新增 `rtc:restart-rejected` 信令处理

```
__onSignaling(msg):
  + case 'rtc:restart-rejected':
      清除 restart 定时器
      __setState('failed')  // → store 走 rebuild
```

#### 安全网定时器

- 间隔：30s（`ICE_RESTART_SAFETY_MS`）——作为安全网，覆盖 `connectionState:failed` 未触发的极端场景
- 主要恢复路径已改为 `connectionState:failed` 时立即重试，安全网定时器仅补位
- 仅 restarting 状态时活跃
- 仅 signaling WS connected 时发送 offer
- `app:background` 时停止，`foreground` 由 store nudge 触发

#### 其他联动修改

- `dc.onclose`：restarting 时 → SCTP 已断，restart 无法挽救 → `__clearRestartState()` + `__setState('failed')`
- `__doKeepalive`：restarting 时跳过本轮 probe
- `__doKeepalive`（失败路径）：从 `this.close()` 改为 `this.__onIceFailed()`
- `createDataChannel()`：restarting 时返回 null
- `send()`：**不变**（DC 仍 open，数据进 SCTP 缓冲，restart 成功后 flush）
- 发送队列：**不 reject、不清空**
- `close()`：清除 restart 定时器/计数器

#### 兼容兜底

时间预算兜底（`ICE_RESTART_TIMEOUT_MS = 90s`）：从首次进入 restarting 起计时，90s 内如果既无连通、也无 `rtc:restart-rejected` 响应，则放弃 restart → `__setState('failed')` → store rebuild。覆盖旧版 plugin 不支持 `rtc:restart-rejected` 的场景。ICE check 失败后立即重试（不等安全网 timer），约可容纳 2-3 次 ICE check 尝试（每次 ~30s 超时）。

### 4.2 UI: claws.store（`ui/src/stores/claws.store.js`）

**改动极小：将现有 rebuild 调用改为 restart 调用。**

#### `__rtcCallbacks.onRtcStateChange`

```
+ case 'restarting':
    claw.rtcPhase = 'restarting'
    claw.disconnectedAt = claw.disconnectedAt || Date.now()
    return
```

`connected` 分支变更：无条件设置 `claw.rtcPhase = 'ready'`（确保 restarting→connected 正确恢复），用 `wasDisconnected = !claw.dcReady` 判断是否需要 `__refreshIfStale`。其余 `failed`、`closed` 处理不变。

#### `__handleNetworkOnline(typeChanged)`

```
对每个 claw:
  rtc.state === 'restarting'  → rtc.nudgeRestart()
  rtc.state === 'connected' && typeChanged → rtc.triggerRestart('network_type_changed')
  rtc.state === 'failed'/'closed' → __ensureRtc()（现有 rebuild 路径）
  其余 → 不干预
```

#### `__checkAndRecover(id, source)`

probe 失败路径：

```
- this.__ensureRtc(id, { forceRebuild: true })
+ rtc.triggerRestart('probe_failed')
```

restarting 时：

```
+ if (rtc.state === 'restarting') { rtc.nudgeRestart(); return; }
```

#### 不变部分

`__ensureRtc`、`__scheduleRetry`、`__fullInit`、`__clearRetry` 等全部保留——它们仍是 restart 被 reject 后的 fallback 路径。

### 4.2.1 UI: ManageClawsPage（`ui/src/views/ManageClawsPage.vue`）

`rtcPhase='restarting'` 的 UI 适配：

- **排序优先级**：归入 connecting 组（与 building/recovering 同级），确保 restarting 的 claw 排在 idle 前
- **连接标签**：restarting 时 DC 仍存活，按 ready 显示传输详情（而非通用"连接中"）；无 transportInfo 时回退到"连接中"
- **状态点颜色**：黄色脉冲（与其他中间状态一致）

### 4.3 Server（`server/src/claw-ws-hub.js`）

Plugin→UI 信令路由白名单添加新消息类型：

```javascript
// claw-ws-hub.js onClawMessage 中 Plugin→UI 路由
if (payload.type === 'rtc:answer' || payload.type === 'rtc:ice'
    || payload.type === 'rtc:closed' || payload.type === 'rtc:restart-rejected') {
```

其余 server 逻辑无需改动。UI→Plugin 方向的 `rtc:offer`（含 `iceRestart: true`）已在现有路由中。

### 4.4 Plugin（`plugins/openclaw/src/webrtc/webrtc-peer.js`）

#### 4.4.1 session 不在 `failed` 时删除

当前 `onconnectionstatechange`（line 216-218）：

```javascript
if (state === 'failed' || state === 'closed') {
    this.__sessions.delete(connId);
}
```

改为仅 `closed` 时删除：

```javascript
if (state === 'closed') {
    this.__sessions.delete(connId);
}
```

> 关键原因：app 进入后台 → 浏览器进程冻结 → pion 侧 ICE consent 超时 → `failed`。如果此时删除 session，前台恢复后的 ICE restart 将因无 session 而被 reject。
>
> 此改动仅适用于 pion 环境。如果 ndc/werift 仍在使用，需通过 PeerConnection 来源条件判断。

#### 4.4.2 ICE restart impl 门控 + reject 处理

ICE restart 仅对已验证支持的 impl 放行（当前仅 `pion`），其余 impl（ndc/werift）立即 reject，让 UI 走 PC rebuild：

```javascript
if (isIceRestart) {
    const existing = this.__sessions.get(connId);
    if (existing) {
        // impl 门控：仅 pion 放行
        if (this.__impl !== 'pion') {
            this.__onSend({
                type: 'rtc:restart-rejected',
                toConnId: connId,
                payload: { reason: 'impl_unsupported' },
            });
            return; // session 保留，UI 会走 rebuild 替换
        }
        try {
            // restart 逻辑（setRemoteDescription → createAnswer → send answer）
            return;
        } catch (err) {
            // restart 协商失败 → reject
            this.__onSend({
                type: 'rtc:restart-rejected',
                toConnId: connId,
                payload: { reason: 'restart_failed' },
            });
            await this.closeByConnId(connId).catch(logWarn);
            return; // 不 fall through
        }
    }
    // 无 session → reject（plugin 可能已重启）
    this.__onSend({
        type: 'rtc:restart-rejected',
        toConnId: connId,
        payload: { reason: 'no_session' },
    });
    return; // 不 fall through 创建新 PC
}
```

---

## 五、信令协议变更

### 新增消息类型

| 消息 | 方向 | 触发条件 | payload |
|------|------|---------|---------|
| `rtc:restart-rejected` | Plugin → UI | ICE restart 不支持/无 session/协商失败 | `{ reason: 'impl_unsupported' \| 'no_session' \| 'restart_failed' }` |

### 修改的现有消息

| 消息 | 变更 | 说明 |
|------|------|------|
| `rtc:offer` | payload 新增 `iceRestart: boolean` | UI 发起 ICE restart 时为 true（plugin 已有此处理） |

---

## 六、场景推演

### 6.1 手机进地铁（信号间歇）

```
connected → disconnected → 5s 内恢复 → connected ✓ (ICE 自恢复)
                         → 5s 超时 → restarting → 信号恢复 → network:online
                           → nudgeRestart → restart offer → connected ✓
                           → SCTP flush → pending RPC/文件传输继续
```

### 6.2 WiFi → 蜂窝

```
network:online typeChanged=true
  → store triggerRestart → ICE restart from connected
  → 旧 WiFi 传输保底 → 新 cellular candidates 连通 → seamless 切换 ✓
```

### 6.3 App 后台 5 分钟

```
app:background → 浏览器冻结 → pion ICE failed → session 保留, SCTP 存活
app:foreground → 冻结回调触发 failed → __onIceFailed → restarting
  + store foreground-resume → nudgeRestart（双保险）
  → pion 有 session → restart answer → connected ✓ → SCTP flush
```

### 6.4 无信号 1 小时

```
ICE failed → restarting → 周期重试 → WS 断了 → 发不出
  → 信号恢复 → network:online → WS 重连 → nudgeRestart
  → restart offer → pion 有 session → connected ✓
```

### 6.5 Gateway 重启（SSE 正常）

```
SSE claw.online=false → __checkAndRecover(sse_offline)
  → DC probe / PC state 裁决：
    - DC 通（P2P 情形，数据面未断）→ probe 成功，不动
    - DC 坏（TURN 情形，数据面随 gateway 挂）→ triggerRestart / rebuild
SSE claw.online=true → 若本地 DC 恢复，展示层回同步；否则已在 restart/rebuild 进程中
```

**关键**：UI↔plugin 的 DC 状态不会被 SSE 事件直接修改。SSE offline 只做一次轻触发 probe，PC 自身状态才是数据面的权威来源。详见 `docs/architecture/communication-model.md` §5.5。

### 6.6 Gateway 重启（SSE 延迟）

```
ICE failed → restarting → restart offer
  → plugin 无 session → rtc:restart-rejected
  → failed → store __scheduleRetry → __ensureRtc → rebuild ✓
```

### 6.7 大文件上传中网络切换

```
file DC 传输中 → WiFi→蜂窝 → triggerRestart
  → file DC 保持 open → SCTP buffer 填满 → flow control 暂停
  → restart 成功 → buffer flush → 上传从断点继续 ✓
  → createDataChannel() 在 restarting 返回 null → 新传输需等 restart 完成
```

### 6.8 Server 宕机

```
WS 断 + ICE 断 → restarting → 周期重试 → WS 不通
  → Server 恢复 → WS 重连 → SSE applySnapshot
  → plugin 在线 → __fullInit → rebuild ✓
```

### 6.9 iOS 杀死后台 app

```
进程终止 → 所有状态丢失 → 用户重开 → 冷启动 → 全新建连 ✓（不受本方案影响）
```

---

## 七、兼容性

### 旧版 Plugin（不支持 `rtc:restart-rejected`）

收到 restart offer 后 fall through 创建新 PC → 回 answer → DTLS fingerprint 不匹配 → UI 侧 ICE check 失败 → 立即重试 → 时间预算耗尽（90s）→ `__setState('failed')` → rebuild。

### 旧版 Server（不识别 `rtc:restart-rejected`）

`claw-ws-hub` 白名单不含此类型 → 消息被丢弃 → UI 收不到 reject → 同上，时间预算兜底。

### 新增信令消息

`rtc:restart-rejected` 遵循现有 `rtc:*` 命名约定，UI 侧 `signaling-connection.js` 的泛匹配 `startsWith('rtc:')` 自动转发，无需改动。

---

## 八、不包含

- **Server IP 检测 API**：当前方案不依赖 IP 变化检测。`typeChanged` 覆盖 WiFi↔蜂窝；其余场景靠 ICE 状态机驱动 restart。后续如有需要可独立引入。
- **ndc/werift 的 session 保留**：仅 pion 环境保留 `failed` 状态的 session。ndc/werift 行为不变。
- **WS fallback（Server-relayed RPC）**：独立方案，不在此范围。
