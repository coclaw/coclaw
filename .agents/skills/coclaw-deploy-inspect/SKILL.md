---
name: coclaw-deploy-inspect
description: SSH 到 CoClaw 部署机，获取 server/coturn 等容器日志（server 的包含 UI/plugin remote log）。Use when 用户要求"到服务器排查/看日志"，以排查运行时问题。
---

# CoClaw 服务器排查

目的：**只读**地从部署机读出诊断所需的一切，不改任何状态。动手前先默认 read-only；需要 restart/exec 写操作必须先与用户确认。

## 持续沉淀（先看这条）

排查中产出的**方法论、决策树、命名空间约定、可重用脚本**，结束前主动落进本 skill——避免下次同类问题再从零研究。

- **方法论 / 决策树 / 案例** → 写到 `docs/<topic>.md`，在本文档末尾"参考文档"建索引（按需加载）
- **新事件约定 / 字段语义** → 加到 `docs/remote-log-namespace.md`
- **可复用流程** → 写成 `scripts/*.sh`，命令式封装，戒律写进脚本注释

衡量标准：**"如果今天的方法论丢失了，明天遇到同类问题是否要白手起家？"** —— 是 → 还没沉淀够。

排查时若识别到一个**通用模式**或**新命名空间**，先落沉淀再走，避免漏埋。

## 1. 目标主机

- 默认 `im.coclaw.net`。**用户明示其他主机**（自部署）时优先使用用户给的。
- 远端工作目录：`~/coclaw`（`docker compose` 文件所在）。
- SSH key 已配：直接 `ssh im.coclaw.net`，不需要密码。首次可用 `ssh -o BatchMode=yes <host> 'echo OK'` 探活。

## 2. 容器拓扑（`docker ps`）

| 容器 | 作用 | 排查价值 |
|---|---|---|
| `coclaw-server-1` | Node server（内部 3000） | **核心**。UI/plugin 的 `remoteLog` 都汇到这里的 stdout |
| `coclaw-nginx-1` | 反向代理 / TLS | HTTP/上传/证书问题时查 access log |
| `coclaw-coturn-1` | TURN/STUN（3478, 443） | 罕用。P2P 直连问题基本从 UI/plugin rtc log 就能定位 |
| `coclaw-mysql-1` | DB | 只在确认 schema / 特定记录时进入 |
| `coclaw-certbot-renew-1` | 证书续期 | 仅证书过期相关 |

与 CoClaw 无关的容器忽略。

## 3. 拉 server 日志（90% 的排查只需要这条）

```bash
ssh <host> 'cd ~/coclaw && docker compose logs --since=<DURATION> --no-color -t server 2>&1' > /tmp/srv.log
```

关键参数：
- `--since=20m` / `--since=2h` 限定窗口，避免一次拖满。
- `-t` 打上 server 容器侧时间戳（UTC, RFC3339）。排查时**以此为准**，不要被日志行里内嵌的 +8 时间误导。
- `--no-color` 否则 ANSI 会污染 grep。
- `2>&1` compose logs 会把 container stderr 也混进来（很多插件侧是走 stderr 的）。

### 三戒（踩过的坑）

1. **别 `docker compose logs -f`**：会阻塞 SSH；用 `--since` 拉快照。
2. **grep 要 binary-safe**：日志混有二进制字节，普通 `grep` 会返回 `Binary file (standard input) matches` 然后丢弃行。**必须 `LC_ALL=C grep -a`**。
3. **先 dump 再过滤**：把原始日志落到远端 `/tmp/srv.log`，后面多次 grep 复用。不要每次都重新 `docker compose logs`。

### 典型用法

```bash
# 1) 先落盘
ssh <host> 'cd ~/coclaw && docker compose logs --since=25m --no-color -t server > /tmp/srv.log 2>&1; wc -l /tmp/srv.log'

# 2) 按 user / claw / connId 过滤
ssh <host> "LC_ALL=C grep -aE '143579687452|148571708137|c_7fd224ff' /tmp/srv.log > /tmp/srv_u.log; wc -l /tmp/srv_u.log"

# 3) 拉回本地看
ssh <host> 'cat /tmp/srv_u.log'
```

## 4. 日志标签字典

| 前缀 | 来源 | 含义 |
|---|---|---|
| `[remote][ui][user:<userId>]` | UI | UI 通过 WS 把 `remoteLog` 汇报上来，server 转打印 |
| `[remote][plugin][claw:<clawId>]` | plugin | plugin 通过 realtime-bridge WS 汇报 |
| `[coclaw/rtc-sig]` | server | 信令路由（WS 连接、offer/answer/ICE 转发） |
| `[coclaw/rtc]` | server | RTC 信令路由器（signal-router forwarded） |
| `[coclaw/sse]` | server | UI 的 SSE 通道（连接/断开、sendToUser） |
| `pion.ipc [pion-ipc] [stderr]` | plugin 内 pion IPC 子进程 | pion 原生 state 变化 |

### 常见事件关键词（直接 grep）

完整命名空间字典见 [docs/remote-log-namespace.md](docs/remote-log-namespace.md)。下面只列高频起点：

- **RTC 生命周期**：`sig.state`、`sig.resume`、`restart.trigger`、`ICE restart succeeded`、`rtc.unrecoverable`、`rtc.state`、`rtc.dump`
- **Agent run**：`agent.run.registered` / `.preaccept-failed` / `.send-cancelled` / `.send-retry` / `.send-failed` / `.end reason=…`
- **DC/RPC 拒绝**：`conn.rejectPending` / `conn.rejectPending.detail`
- **RPC 队列异常**：`rpc.timeout`、`rpc-queue.overflow-start` / `.overflow-end` / `.close`、`drop reason=queue-full` / `single-msg-oversize`
- **前后台 / 网络**：`app.stateChange`、`app.network`、`sig.resume source=app:foreground elapsed=<ms>`
- **SSE**：`sse.connected`、`sse disconnected`、`claw.snapshot`
- **文件**：`file.dl.start`/`progress`/`ok`、`dc.received`
- **诊断**：`coclaw.diag`、`embedded.activeRuns.set/delete`

## 5. 时间线拼接要点

- server `-t` 前缀是 UTC，行里内嵌的 `04:33:31.664` 是**源端**时间（UI 或 plugin 本地时间，可能是 +8）。同一事件两处时间差就是 UI↔plugin↔server 的跨端时延 + 时钟偏移，可用来估算链路健康。
- `elapsed=<ms>` 出现在 `sig.resume` 里，直接给出后台时长。`35211979ms` ≈ 9h46m。
- plugin `rtc.dump` 行里含 `queueLen / queueBytes / dropped / fileCount`，一行顶十行状态快照，这是判断 plugin→UI 方向 RPC 压力的第一手材料。
- `c_<uuid>` 是 PeerConnection 的稳定 ID，**跨 ICE restart 不变**，是最可靠的关联键。

## 6. 容器环境变量（需要时）

```bash
ssh <host> 'docker inspect coclaw-server-1 --format "{{.Config.Env}}" | tr " " "\n"'
```

取到 `DB_URL`、`TURN_SECRET`、`APP_DOMAIN` 等。**不要打印到用户可见区域**（含密钥）。

## 7. 其他容器（按需）

```bash
# nginx access
ssh <host> 'cd ~/coclaw && docker compose logs --since=10m --no-color -t nginx 2>&1 | tail -200'

# mysql（只读查询示例）
ssh <host> 'docker compose -f ~/coclaw/compose.yaml exec -T mysql mysql -ucoclaw -p"$PW" coclaw -e "SHOW TABLES"'
# 密码从 server 容器 env DB_URL 里解析，避免写死
```

`docker compose --profile auto-https ps` 看全部 profile 下的服务。

## 8. 行为边界

- **只读默认**：`logs` / `inspect` / 只读 SQL / `gh api` 不用问。
- **需确认**：`restart` / `exec` 写操作 / DB 写 / `compose down` / `deploy-*.sh` / 改 nginx 配置。
- **不要**：为了"重现问题"重启服务。优先从现有日志还原时间线。
- **敏感信息**：env 里的 `DB_URL`、`TURN_SECRET`、`SESSION_SECRET` 不要回显给用户。

## 9. 快速自检模板

排查入口固定三步：

```bash
# (a) 健康摘要
ssh <host> 'docker ps --format "table {{.Names}}\t{{.Status}}"'

# (b) 时间窗落盘
ssh <host> 'cd ~/coclaw && docker compose logs --since=30m --no-color -t server > /tmp/srv.log 2>&1; wc -l /tmp/srv.log'

# (c) 按实体过滤（user / claw / connId 中至少一个）
ssh <host> "LC_ALL=C grep -aE '<USER_ID>|<CLAW_ID>|<CONN_ID>' /tmp/srv.log > /tmp/srv_e.log; wc -l /tmp/srv_e.log"
ssh <host> 'cat /tmp/srv_e.log'
```

`(b)` + `(c)` 已封装成 `scripts/fetch-and-filter.sh`：

```bash
.claude/skills/coclaw-deploy-inspect/scripts/fetch-and-filter.sh <host> <since> [<regex>]
# 示例：./fetch-and-filter.sh im.coclaw.net 30m 'c_7fd224ff|143579687452'
```

### 落到本地多次复用比反复 ssh 划算

跨度比较大、或要做多维度横向对照时，可以考虑先把窗口拉一份到本地，之后所有 grep 直接对本地文件。`fetch-and-filter.sh` 在传 regex 时把过滤结果 `cat` 到 stdout，重定向即可：

```bash
./scripts/fetch-and-filter.sh im.coclaw.net 24h '<USER_ID>|<RUN_ID>|<CLAW_A>|<CLAW_B>' \
	> tmp/diag-window.log

LC_ALL=C grep -aE 'agent\.run\.|conn\.rejectPending' tmp/diag-window.log
LC_ALL=C grep -aE 'claw\.fullInit|claw\.online'      tmp/diag-window.log
```

什么时候值得预先落地，按手感判断——大致看排查会涉及多少个独立维度、要不要反复横向对照。窗口小、单条线索追到底的简单排查，直接 stdout 看就够了。

剩下的就是读日志讲故事——按现象选 playbook（见下方"参考文档"）。

## 10. 参考文档（按需加载）

按当前排查现象按需展开对应文档：

| 文档 | 适用场景 |
|---|---|
| [docs/diagnosis-playbook.md](docs/diagnosis-playbook.md) | 按用户描述的现象（"任务未完成"、"断了又恢复"等）找诊断决策树和 grep 模板 |
| [docs/remote-log-namespace.md](docs/remote-log-namespace.md) | 看到陌生 `<模块>.<事件>` 时查含义、字段、触发位置；新加事件也补到这里 |

## 11. 脚本目录

`scripts/` 下沉淀的可复用流程：

- `fetch-and-filter.sh` — 远端落盘 + 按 regex 过滤 + 拉回本地 stdout（封装第 9 节模板）
- `connid-timeline.sh` — 从本地日志抽取某只 claw 的 connId 时间线，**用于检测 SPA 是否被刷过**（移动端 WebView 软重启）。详见 `docs/diagnosis-playbook.md` 的"SPA 软重启识别"小节

新沉淀脚本时遵循 `scripts/fetch-and-filter.sh` 的注释风格（顶部用法 + 参数 + 戒律）。
