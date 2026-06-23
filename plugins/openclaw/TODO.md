# Plugin TODO

## 覆盖率门禁偶发假性失败：c8 多进程聚合 race（**未修，止血已回退**）

**发现日期**：2026-06-22
**关联**：`package.json` 的 `test` 脚本（`c8` 包 `node --test`）；被误判的文件随机（最近一次 `src/file-manager/handler.js:719-724`）

**判据（极易辨认）**：覆盖率塌（可微塌如 lines 99.96%、缺口落在本次根本没碰的文件）但**同次 `# fail=0` 且用例数正常**、**二跑即干净** = c8 跨子进程覆盖聚合 race，**非真退化**、非本批回归。

**根因（2026-06-22 实测钉死）**：`node --test` 默认 `--test-isolation=process`，每个测试文件 fork 一个子进程并行（当前约 86 文件→约 86 份覆盖文件）；c8 给各子进程设 `NODE_V8_COVERAGE=tmpdir`，等顶层 `bash` 退出后 `readdir` 该目录、逐份 `JSON.parse` 合并；某份此刻还没刷盘可读时，c8 的 `try/catch` **静默整份丢弃**（`c8/lib/report.js`，仅 `NODE_DEBUG=c8` 可见）→ 只被那份覆盖到的行凭空变未覆盖。`pnpm verify`（check 紧接 test）的 IO 压力 + macOS APFS 放大可见性窗口。

**止血已回退（2026-06-23）**：曾加 `--test-isolation=none` 让所有测试文件挤进同一进程（只产 1 份覆盖文件、race 物理消失），但该 flag 是 **Node 23+ 才有的**——本项目 CI 与生产都跑 **Node 22**（`node:22-slim`、OpenClaw 运行时 ≥22.19），`node:22-slim` 实测 `node: bad option: --test-isolation=none`。该改动只在本地 Node 24 验过、从未过 CI，随一批未推 commit 带上 main 后首次 push 即把 CI 打红。已回退回不带 flag 的原命令（Node 22 兼容、此前多次发版跑绿）。**race 偶发假失败因此回归**——遇到按"判据"识别、二跑即过；真治本走下面的对症方案。

**⚠️ 当时也并非治本**（2026-06-22 业界证据调研定性）：`--test-isolation=none` 关掉的是"进程隔离"——一个**与覆盖率无关**的测试正确性担保（防测试间全局状态/模块单例串味），靠副作用恰好掩盖 race；社区无人背书用它稳覆盖率。故即便它能在 Node 22 跑，也不该长期依赖。

**对症方案（待办，暂不做）**：切 node 内置覆盖——`node --test --experimental-test-coverage` + `node:test/reporters` 的 `lcov`，**退回默认 `process` 隔离**。优势：少一层进程（顶层 runner 亲自收割全部子进程后才读盘，刷盘窗口趋近消失）+ **不静默丢**（c8 那个 per-file `try/catch` 静默跳过它没有），直接拔掉静默丢弃失败模式。暂不做的原因：① node 24/26 仍 `--experimental-`、未转 stable，API 可能变；② **branch 覆盖口径比 istanbul 弱**（解构默认值等分支 V8 粒度不够、可能误报 100%，上游 `nodejs/node#57435` 仍 open），咱们门禁卡 `branches 95`，迁移可能让 branch 虚高、门禁失效，须重校基线、校不过就回退；③ 本问题严重度低（只门禁偶发误报、二跑就过、不伤生产代码与测试正确性），性价比暂不值大动。

**纠正认知（防重蹈）**：commit `7b5ac8d`（2026-05-24）号称"collapse 成单进程修 race"是**错的**——裸 `node --test <多个 glob>` 不带 isolation flag 时默认仍是 `process` 隔离并行，race 从没消除、故复发。别再把任何"裸 `node --test` 多 glob"当单进程，也别把本次 `--test-isolation=none` 当治本。历史脉络：并行（原始）→ `cb77b574` WSL2 逐文件串行 → `7b5ac8d` 改回并行（误以为修了）→ 2026-06-22 加 `--test-isolation=none` 止血 → 2026-06-23 回退（Node 22 不认该 flag、CI 红）。

**诊断辅助**：复现时挂 `NODE_DEBUG=c8` 能把被丢的覆盖文件打出来坐实。

---

## worktree 重构建并跑时主网关偶发被 SIGTERM 重启（隔离网关基础设施落地时发现）

**发现日期**：2026-05-31（worktree 插件验证基础设施 `scripts/worktree-gateway.sh` 落地实测时发现）
**关联**：主网关 systemd user service（`Restart=always`）；现象与 `docs/worktree-plugin-dev.md`「已知偶发」同条

**现象**：在 worktree 里跑 `pnpm wt:up`（`pnpm install` ~3.7s + `pnpm deploy` ~18s，合计约 22s 高 CPU/IO）期间，主网关**偶发**收到外部 SIGTERM、干净关闭（~467ms），systemd 立即自愈重启（pid 变、`openclaw.json` md5 不变）。3 次同类操作中复现 1 次（另两次主网关 pid 全程不变）。

**已排除**：对照探针证明**隔离 profile 网关本身不扰主网关**——distinct 端口、起独立网关时主网关 pid 不变。所以不是方案 B 的隔离泄漏。（注：2026-05-31 起脚本已不再传 `gateway run --force`，改为只起在自己的空闲端口上，连"只杀目标端口"的抢占都不做，进一步与主网关解耦。）

**根因初判（未钉死）**：SIGTERM（而非 SIGABRT/SIGKILL）指向"显式 stop/restart"而非 OOM/看门狗超时（systemd 看门狗默认发 SIGABRT）。leading 假说：①重构建饥饿主网关事件循环 → 某健康检查判不健康触发 restart；②某条命令使主 `openclaw.json` 被同内容重写（md5 不变但 mtime 变）→ chokidar `plugins.*` reload。两者都未坐实。本机 WSL2 11.7GB、8 核，资源紧时更易触发。

**为什么暂不立刻修**：①severity 低——主网关 `Restart=always` 秒级自愈，无数据损失；②偶发、根因未钉死，需先稳定复现（重构建并跑 + 抓 SIGTERM 来源 / 健康检查日志 / config mtime）才谈得上修；③与方案 B 的隔离正确性无关（已证伪泄漏）。落生产对应"重构建期间主网关抖一下"，可观测、可自愈。已在 `docs/worktree-plugin-dev.md` 提示重构建期间别对主网关做敏感操作。

---

## 选模型器目录读取裸调 loadModelCatalog，缺网关的 stale-while-revalidate / 超时保护

**发现日期**：2026-05-31（8ea6d41b `readOnly:true→false` 修复的 deep-review 时识别）
**关联**：`plugins/openclaw/src/model-default/handlers.js`（:88 set 存在性校验 / :245 listUsable 枚举）

**问题**：两处把 `loadModelCatalog({readOnly:true})` 改成 `{readOnly:false}`（修 manifest-only provider 如 `openai-codex/*` 选不出——修复正确、保留）。`readOnly:false` 会跑 discovery，**冷调用（缓存 miss）实测 ~12–13s 出结果、其中同步冻网关事件循环 ~2.2–2.8s**（2026-05-31 本机 `OPENCLAW_DEBUG_INGRESS_TIMING` + `monitorEventLoopDelay` 探针 ×3 复现）。冻期间整个网关停摆（所有 RPC / agent 事件 / 心跳全停）。**冻点订正**：不在 `discoverModels`/`ModelRegistry` 构造（那段实测仅 ~7ms，整个同步段 `readFileSync`+parse+校验+清 legacy auth.json 才 ~200ms），**真正的冻在 `ensureOpenClawModelsJson` 的厂商发现**——同步加载 46 个厂商扩展插件枚举模型，模块求值连冻 ~2.5s。冷调用整条 >10s，顶穿常见超时（重启后第一次开选模型器很可能转圈/失败）。

**这是 OpenClaw 自身的已知成本（非 CoClaw 引入）**：全量目录发现谁调都付这个钱——网关原生 `models.list view:all` 冷调用实测同样 ~11s；上游自带命令 `openclaw models list --all` 冷调用更要 **~66s**（独立 CLI 进程、无缓存、每次从头发现，第二次仍 ~61s）。OpenClaw 源码自己在 `agents/model-catalog.ts` 注释 "provider discovery blocks the event loop"，并**专门给自家 `models.list` 套了 stale-while-revalidate 缓存 + 750ms 超时兜底**——说明上游早知此路慢/会卡、是已知问题、且为自己绕了。根子是反复加载 46 个厂商扩展插件（日志见单插件被重复加载 88 次、其中一次单插件加载就 2.7s ≈ 那个 ~2.5s 冻），与已登记的上游 **#80697**（manifest 缓存反复 mismatch → 重复发现）同一家族。即：成本是上游的、已知的；CoClaw 只是因"可用清单要含 manifest-only provider"才不得不走 `readOnly:false` 踩上去，且**裸调没蹭到上游那两层保护**。

**双实例（已坐实）**：插件经 `plugin-sdk/agent-runtime` barrel 拿的 `loadModelCatalog` 与网关自家 `agents/model-catalog.js` 是**两份独立模块实例**，各自一份 `modelCatalogPromise`。实测：网关 `models.list view:all` 把网关那份目录烤热后，插件 `listUsable` 仍从头冷跑 10.9s。

**冷的频率（推翻旧前提）**：因双实例 + 插件代码从不 reset 自己的缓存（无 `useCache:false` / 无 `resetModelCatalogCache`）→ 插件目录缓存**粘到下次网关重启**。冷调用 ≈ 每次重启后第一次 `listUsable`/`set`，**一次**，不是"每次改配置"。**旧前提"被 config reload（含 `coclaw.model.set`）置空"实测推翻**：set 之后连**网关自家**缓存都没清（set 后 `models.list view:all` 仍 1.26s 热命中、零重扫），对插件独立缓存更够不着。

**陈旧（范围窄）**：插件目录缓存粘住会陈旧，但按凭据筛选（`enumerateUsableModels`）每次现读、不缓存——**加新 key 立刻显示**；只有"目录构成本身变"（装新厂商插件 / 凭据门控的在线发现）才需重启网关才进选模型器。

**为什么接受现状（2026-05-31 实测后用户拍板）**：①代码修复本身正确，bug（ChatGPT 模型选不出）必须修；②冷调用低频（≈每次网关重启一次），多数命中粘性缓存无感；③单次代价虽高（~2.5s 冻 + >10s 顶穿超时）但罕见，上完整 stale-while-revalidate 属过度设计。治本等上游 #88392 暴露廉价 available 信号后改读廉价源、绕开整条 discovery。

**旧 ~1.2s 的来历**：是网关自家 `models.list view:all` **热命中**（gateway 级 `loadGatewayModelCatalog` 缓存 + readOnly 路 750ms 超时兜底），代表不了插件裸路径。插件 `listUsable` 即便目录热命中（~0ms）整条仍 ~3.4s——那是 `enumerateUsableModels` 凭据检查（纯异步、不冻网关）。已在 `docs/model-config-api.md` §3.2.1 caveat 同步更正。

**若日后要插件侧先行兜底**（非现状选择）：成本最低的是注册时后台预热一次目录缓存，把 12s+2.5s 冻挪到网关启动期（无用户/agent RPC 在途）、用户首次开选模型器即热；完整 stale-while-revalidate 因双实例需插件自带刷新逻辑、对低频场景过重。

---

## RPC handler 错误响应 `err.message` 透传可能泄露内部细节

**发现日期**：2026-05-15（D1 model-default deep-review 时识别）
**关联**：`plugins/openclaw/src/provider-auth/handlers.js` + `plugins/openclaw/src/model-default/handlers.js`

**问题**：handler catch 块里直接把 `String(err?.message ?? err)` 当作 RPC error message 透传，路径 / 内部函数名 / 栈片段可能随之外泄到 UI / server / 远端 log。具体调用方：

- provider-auth/handlers.js setApiKey / list / remove 三个 method 的 IO_FAILED 路径
- model-default/handlers.js set / list 的 IO_FAILED 路径

**为什么本期未一并修**：项目级遗留问题——provider-auth 同款，按"review 仅修本次引入"原则不动；同时 message 透传对开发者排错有用，纯遮蔽掉信息密度会下降。需要"分级脱敏"方案（如：识别 stack-like 片段才剪 / 白名单 message 字面量），不是单点改动。

**修复方向**：

- 在两处 helper（`respondIoFailed` / provider-auth 的同款）里加 message 净化：剪掉绝对路径、文件名、stack frame；保留前 N 字符的人类语义
- 或引入 plugin 级 "outbound error sanitizer" 集中处理；同步给 server 远端 log 也走一遍
- 实施前评估对调试体验的影响

---

## __forwardToServer 在 WS 断窗口期静默/丢信令的完整方案

**发现日期**：2026-05-08（codex-rescue review WS-PC 解耦方案时识别）
**关联 commit**：fix(plugin): keep WebRTC sessions across server WS reconnect; tighten heartbeat miss limit to 3

**问题**：`realtime-bridge.js` `__forwardToServer` 在 `serverWs` 不可用或 `send` 抛异常时，仅记本地 log 后丢弃 payload。WS 断窗口期 webrtcPeer 异步回调（trickle ICE candidate、`handleSignaling` 几个 await 之间触发的 `rtc:answer` / `rtc:restart-rejected` 等，ICE restart 应答与初次应答都走 `rtc:answer`）会被丢。

**为什么本次未一并修**：丢失对 plugin 端 PC 状态机不致命——UI 端 sig.state 恢复后会主动触发新一轮 ICE restart，重发完整 candidate set 与 SDP；plugin 端因保留了 webrtcPeer，新一轮 restart 直接走 `restartIce` 续上，不需要 rebuild。当前是观察项不是阻塞项。

**修复方向**：要么在断窗口期 queue 待发信令、重连后批量补发；要么在 SDP-bearing 信令发送失败时把对应 connId 标记为 failed，让下一轮 ICE restart 自然重启该 connId。需评估对端（UI / server）契约。

## MAX_SESSIONS=10 不是硬上限（all-active 时 evict 失败仍创建新 session）

**发现日期**：2026-05-08（codex-rescue review WS-PC 解耦方案时识别）
**关联**：`webrtc-peer.js` `__evictOldestFailed`

**问题**：`createSession` 撞 `MAX_SESSIONS` 时仅尝试淘汰 `connectionState === 'failed'` 的 session；若所有 session 都还活着（disconnected / checking / connected），evict 返回 false 但仍继续创建新 session。

**影响**：极端场景下 sessions 数会超过 10。常见路径不会触发（CoClaw UI rebuild 复用 connId、不增 session 数；多设备并发也罕见超 10）。WS-PC 解耦后 PC 跨重连保留，理论上窗口稍长但实战影响小。

**修复方向**：达到上限时拒绝新 offer 回 `rtc:offer-rejected reason=max_sessions`，或加 LRU 强制淘汰。

## DC onerror 不触发清理 → consumeLoop 可能永挂

**发现日期**：2026-05-02
**关联**：webrtc-peer.js 的 dc.onerror

**问题**：DC `onerror` 仅打日志，清理依赖后续 `dc.onclose` 到来。如果某些 WebRTC 实现只触发 error 不触发 close，consumer 会卡在 sender BAL 等待中（虽然阶段 1 加了 finally 兜底，但仍依赖某种触发条件）。

**修复方向**：在 `dc.onerror` 中也触发 sender close + queue destroy，或给 BAL 等待加超时上限。

**预存问题**。

## 测试增强建议（阶段 1 deep-review 期间记录）

- realtime-bridge.test.js:6073/6096 的 5x setTimeout(0) drain —— 已评估（2026-06-23）：两处都是否定断言（断言「不应 broadcast」），drain N 个 tick 等「缺席」是标准写法，无更确定的可观测条件可替代；保留现状、低优先。

## __setupDataChannel 装配抛错 → rpcQueue 半残静默丢消息（真 bug；后果非平凡但生产概率≈0 → KEEP/defer；含 ex-553）

**发现日期**：2026-05-02（rpc-dc-stage1 deep-review round 4）；2026-06-23 两路对抗评审重核，合并原「装配段 `new FileBackedQueue()` / `init()` 抛错的静默缝隙」(ex-553) 为单一真相源
**关联**：`src/webrtc/webrtc-peer.js` `__setupDataChannel` / `ondatachannel`

**后果（非平凡）**：`ondatachannel` 同步先赋 `session.rpcChannel`(~:830)，再 fire-and-forget 调 `__setupDataChannel`，其抛错被最外层 `.catch`(~:831-833) 只 log 吞掉。`__setupDataChannel` 构造 queue + `await queue.init()`，**成功后**才赋 `session.rpcQueue`(~:1079)；构造/init 抛 → rpcQueue 停 null 但通道已 open。三个生产者（broadcast ~:325 / sendTo ~:352 / files ~:914）以 `?.rpcQueue?.` 静默门跳过 → plugin→UI 所有 RPC 响应静默丢。**且不可自恢复**：probe-ack 走裸 `dc.send` 绕 queue(~:890-891) → 传输层探测成功 → UI 认通道健康、不重建 → 丢失持续。

**概率（生产≈0，与后果分开看）**（2026-06-23 两路独立核实）：
- 唯一现实触发 = **server 违反 connId 跨进程契约**（非法字符 → FBQ/MemoryQueue 构造 `ID_RE` 校验抛 TypeError）。正常 UI 发 `c_${uuid}` 恒合法。
- diskCap 非有限 → 不可达：`measureDiskCap` 已夹紧 [64MB,1GB]、异常回退 1GB，仅测试注入坏值才抛。
- **更正 ex-553 旧表述**：原称「`init()` 的 `fs.mkdir` 在权限/磁盘异常下可能抛」**不成立**——FBQ `init()` 不调 mkdir（只一个被 try/catch 吞的 `fs.rm`），mkdir 懒延迟到首次 spill；`await queue.init()` 近乎 throw-proof。

**可验证性**：确定性、廉价单测可钉的不变量（非难复现 race）——测试注入坏 `diskCap`(=Infinity) 或喂非法 connId 即可强制抛，断言"降级后 rpcQueue 非 null + 日志如实报 mem + enqueue 抵达"，撤修法 flip-to-RED。

**⚠️ 朴素修法是错的（已证伪，别重蹈）**：「catch 后回退到既有 `new MemoryQueue(connId)`」对唯一现实触发**失效**——MemoryQueue 与 FBQ 共用同一套 `ID_RE`，同一非法 connId 喂给它**再次抛** → throw-in-catch 逃逸回最外层 `.catch` → rpcQueue 仍 null、依旧半残。两路对抗评审独立撞同一洞。

**正确修法方向（未来真要修再做：业务码改动走深水区 + 发 patch changeset）**：try/catch 仅包 FBQ「构造 + init」两步（边界画在 init 之后、~:1058 身份重核之前，别误吞 abort）；catch 内 ① `new MemoryQueue` 用**安全内部 id**（非 connId；MemoryQueue id 只做日志 tag、不碰盘）→ 对非法 connId 也不再抛；② 重算 `queueImpl='mem'`/`fbqFallback` 让既有日志(~:1066-1068)**如实+响亮**报降级 + warn 带错误。两组测试（坏 diskCap / 非法 connId）各 flip-to-RED。
- **更高层替代（更大改动、follow-up）**：信令入站处校验 connId 字符集、非法即结构化拒连（在它成为 session 路由键之前），是「正确 altitude」——避免在装配深处 mask 一个 server 契约违反。
- **残余根因（更深、非本条范围）**：上面修法让 rpcQueue 对这些触发永不为 null，但 probe-ack 绕 queue 的不对称仍在——任何**其它**未来导致 rpcQueue 为 null 的路径，UI 仍因 probe 通而不重建。

**为何 KEEP/defer（2026-06-23 用户拍板）**：生产概率≈0 + 正确修法触及 webrtc 核心错误路径逻辑 + connId 契约语义，维护期稳定优先；本轮只修订本 TODO（含证伪朴素修法），暂不实际修复。非"难验证的陷阱"——纯属维护期取舍。

**关联（不合并）**：`## A1 异步装配引入的"handler 已挂、字段未挂"理论窗口` 是 init **顺利期间** rpcQueue 暂 null 的**瞬态自愈**窗口（init resolve 即愈），与本条「构造/init **抛错**后的永久半残」是不同失败模式、修法不互相覆盖，仅根因同源（字段赋值在 handler 挂载之后）。

## __sendPeerTransport 失败后无重试调度（预存）

**发现日期**：2026-05-02（rpc-dc-stage1 deep-review round 4）
**关联**：webrtc-peer.js __sendPeerTransport

**问题**：sendTo 返回 false 时回滚 sig 允许重试，但重试依赖下次 dc.onopen 或 onselectedcandidatepairchange 事件。若 pair 已稳定、DC 已 open 过、此后这些事件不再触发，transport info 永远不重发。

**修复方向**（不修）：sendTo 失败后挂一个延迟重试，或在 onbufferedamountlow 恢复时检查 sig 为 null 再发。预存——sendTo 改 async 不引入新问题，仅在原本就失败的场景下不重试。

## bridge 不被通知 conn 关闭 → server 侧 pending request map 残留（预存）

**发现日期**：2026-05-02（rpc-dc-stage1 deep-review B 阶段维度 2 集成路径）
**关联**：realtime-bridge.js（gateway WS message handler 与 webrtcPeer 之间无 conn-closed 信号）

**问题**：webrtcPeer.closeByConnId 只清 plugin 侧 session 状态，没有回调 bridge。bridge 把 server 端发来的 RPC 请求映射到具体 connId 后，若该 conn 在 plugin 侧已断开，映射不会被主动清掉，要等 gateway 整体关闭或 TTL 才消失。

**影响**：bridge 内存里有过时映射；server 侧后续来的回包尝试 sendTo 已不存在的 conn → 静默 false。功能层面 UI 已重建会话恢复，但残留映射占内存且日志噪音。

**修复方向**：webrtcPeer 暴露 onConnClosed(connId) 回调；bridge 订阅后主动清掉该 conn 的所有挂起映射。

## files sendFn 不返回 boolean / Promise，response 入队失败被静默吞（预存）

**发现日期**：2026-05-02（rpc-dc-stage1 deep-review B 阶段维度 2 集成路径）
**关联**：webrtc-peer.js __setupDataChannel 内构造的 sendFn（line ~631）；file-manager/handler.js 调用处

**问题**：sendFn 是 sync void 接口（"历史是 sync void 接口"注释），内部对 enqueue 做 fire-and-forget `.catch()`。enqueue 返回 false（admission 拒绝、queue 已 destroy）时调用方完全无感。

**影响**：file RPC 内部已执行完毕但 response 被 queue-full 或 teardown 静默丢，UI 端只能等超时。预存——阶段 1 之前 sendFn 同样不暴露 boolean。

**修复方向**：sendFn 改返回 Promise<boolean>（或同步返回 enqueue 结果），file-manager handler 在 false 时打 `file.rpc.response-undeliverable` 日志或走重试。需斟酌签名变更对 file-manager 的影响。

## auto-upgrade state read-modify-write 缺跨进程互斥（预存）

**发现日期**：2026-05-02（rpc-dc-stage1 C 阶段维度 3）
**关联**：plugins/openclaw/src/auto-upgrade/state.js（addSkippedVersion / updateLastCheck / updateLastUpgrade）+ updater.js（__reportLastUpgradeResult）

**问题**：parent (gateway) 和 worker (独立进程) 都会 read-modify-write `upgrade-state.json`。CLAUDE.md 强约束 "read-modify-write 必须 mutex"，但进程内 mutex 跨进程无效。当前靠 `isLocked` 守门挡住绝大多数并发（worker 跑期间 parent skip check），但极小窗口（worker spawn 与 lock 写入之间、stale lock 强制清理时）仍有理论丢字段风险。

**影响**：实测从未发生——窗口极窄、最坏后果是 lastCheck/lastUpgrade 丢一次记录、自然恢复。无数据损坏（atomic 写已保证）。

**修复方向**：用文件级 advisory lock（如 `proper-lockfile` 或 flock）保护 read-modify-write 段。改动跨进程协议，影响面大；当前接受现状，标 TODO 提示长尾。

**2026-06-11 注记**（摆脱账本改造评审再确认）：维持"已接受模式"结论——gateway 与 worker 的写入由 `upgrade.lock` 时序隔离（worker 在跑时 scheduler 跳过整轮 check），新增的 L2 no-op 路径状态写入（addSkippedVersion / updateLastUpgrade / appendLog）同受此隔离，不另开条目。inflight 对账现也暴露在此窗口：锁 TTL 误清（worker 真活超 110min）后，活 worker 的 inflight 会被 scheduler 误记 interrupted + 双 spawn，账目最终被 worker 终态覆盖收敛。

## auto-upgrade 物理 restore 后上游安装记录停在坏版本（账实偏差，E2E 复验观察）

**发现日期**：2026-06-11（a3c49fdf 发版 gate 复验 Tb 链观察）
**关联**：plugins/openclaw/src/auto-upgrade/worker-backup.js（restoreFromBackup）

**问题**：验证失败回滚走 rename 恢复备份只改磁盘文件，上游 `plugins inspect` 的 install record 仍记坏版本（实测：磁盘已回 0.26.7，record version 仍 0.26.8）。直到下次 install/update 才被刷新。

**影响**：纯元数据偏差，不影响加载（gateway 读磁盘文件）也不破坏后续升级逻辑——下一轮 checkForUpdate 用磁盘 package.json 判版本，L2 baseline 取陈旧 record 但"record 是否推进"的判定语义仍成立（本机 Run C 实测下一轮升级正常）。主要代价是排障困惑（inspect 显示坏版本"在装"）与 lastUpgrade.from 取磁盘、baseline 取 record 的字符串不一致。与 docs/auto-upgrade.md "rollback=文件态已恢复"语义一致，属已知权衡的具体化，暂不修。

**同族第二形态（2026-06-11 独立验证 S2 观察）**：record 的 `spec` 也会被装坏版时重新钉死为精确版号（实测：S1 解钉后的裸名 spec，经 S2 装 0.26.23 失败回滚后变回 `@coclaw/openclaw-coclaw@0.26.23`）。发现逻辑不受影响（skip 周期用裸名查 latest 实测正常），下次成功升级经裸包名 update 会再次解钉自愈。同根因（restore 不回写上游记录），随本条一起处置。

## file-manager handler 8 项预存问题（C 阶段维度 2）

**发现日期**：2026-05-02
**关联**：plugins/openclaw/src/file-manager/handler.js

| # | 锚点 | 问题 |
|---|---|---|
| 1 | 49-51, 247-249, 277-279, 602-618 | validatePath 不解析父目录 symlink，可越权写到 workspace 外（PATH_DENIED 漏判） |
| 2 | 121-129, 196-235, 253-280 | delete/create 先做文件操作再发 RPC 响应；响应丢失时副作用已发生，UI 重试会得到 NOT_FOUND/ALREADY_EXISTS |
| 3 | 320-349, 744-805 | file DC 只有"请求前 30s"超时，传输期 idle 不超时，半上传 tmp 文件可永久挂住 |
| 4 | 894-900, 503-506, 737-738 | sendError 不 await dc.close → 错误 JSON 可能在 close 前丢失 |
| 5 | 463-485 | GET 背压 low 事件早于 pausedNow=true 触发 → 永久卡 pause |
| 6 | 647-689, 744-779 | PUT/POST 接收侧 pendingQueue 无上限，慢磁盘下可被远端打满至 1GB → OOM |
| 7 | 629-635, 764-765, 799-800, 813-814, 836 | tmp 文件 unlink 失败无重试 → 残留磁盘 |
| 8 | 277-280, 136-140 | createFile 用 writeFile('') 直写最终路径，抛错时空文件留下 |

**影响**：均属预存边角，与 rpc DC 重构无关。

**修复方向**：每条独立修；建议优先级 1（安全） > 6（OOM 风险） > 4（错误响应丢失） > 其他。

## auto-upgrade worker 9 项预存问题（C 阶段维度 3）

**发现日期**：2026-05-02
**关联**：plugins/openclaw/src/auto-upgrade/

| # | 锚点 | 问题 | 严重度 |
|---|---|---|---|
| 1 | worker.js:121-191, updater.js:65-97, worker-backup.js:42-56 | kill -9/OOM 在备份后 + 替换文件期间发生 → stale lock 清理只删锁不恢复备份 → 残破插件 + 残留 .bak | Critical |
| 2 | worker-backup.js:52-56 | restore 先删 pluginDir 再 rename .bak → 中途崩溃整个插件目录消失 | High |
| 4 | updater-spawn.js:45-66, updater.js:309-322 | child.pid undefined 时仍写 lock；async error/exit 未识别 | High |
| 5 | updater-check.js:63-77, worker-verify.js:24-38 | 自定义 semver 不支持 prerelease ordering / build metadata | Medium |
| 6 | updater-spawn.js:52-55 | worker stdio 被忽略，致命错误丢失 | Medium |
| 7 | worker-backup.js:22-34 | 备份无 checksum/manifest，损坏备份会被信任性 restore | Medium |
| 8 | updater-check.js:35-55 | 初次 check 不走 registry fallback，主 registry 故障即无更新 | Low |
| 9 | updater.js:17-25 | LOCK_TTL_MS 110min 接近 worker 最坏耗时，未来若超时矩阵增长，stale 清理可能起并行 worker | Low |

**影响**：均属预存边角。auto-upgrade 是 gateway 启动稳定性关键链路，1/2 风险较高。

**修复方向**：1/2 需要重设计 backup → 用 swap 模式；其他逐项处理。

**2026-06-11 注记**（a3c49fdf 升级链修复后复核）：原 #3（rollback 双失败仍记 result='rollback'）已实装修复（rollback-failed 终态）并删行；#1 的"残留 .bak"措辞已过时——备份迁至 `<state-dir>/coclaw/upgrade-backup/`，npm 地盘无残留，但"kill -9 于替换窗口致残破插件、stale lock 清理不恢复备份"主体仍在（inflight 对账会补记 interrupted 并保留备份供人工恢复，不自动 restore）；表内行号锚为 2026-05-02 快照，已陈旧，按问题描述定位。

## agent-run-response bypass 是否扩展到 lifecycle:end（产品决策待定）

**发现日期**：2026-05-02
**关联**：plugins/openclaw/src/webrtc/agent-run-response.js

**问题**：当前 `isAgentRunResponse` 只命中 `type='res' + payload.runId`。OpenClaw 一次 agent run 会 emit 多次 lifecycle:end（compaction-retry / model-fallback / final），这些是 type='event' 帧，不命中白名单。队列满时 lifecycle:end 全 drop，UI 可能看不到运行结束信号导致"任务永远进行中"。

**影响**：严重时用户感知任务卡死，需手动取消。但仅在队列满（10MB 软上限）的极端拥塞场景触发。

**修复方向（待决策）**：
- 选项 A：扩展白名单命中 `type='event' + event='lifecycle:end' + payload.runId`
- 选项 B：让 producer 显式标记需 bypass 的帧（语义更清晰）
- 选项 C：保持现状（lifecycle:end 走 broadcast，UI 端需自己有兜底超时）

需先确认 UI 是否依赖 lifecycle:end 判定 run 结束 + 队列满频率。

## D 阶段记 TODO 不修的预存问题

### dc-chunking BEGIN-without-END pending Map 无总量上限

**发现日期**：2026-05-02（D 阶段 dim 4）
**关联**：plugins/openclaw/src/webrtc/dc-chunking.js createReassembler

**问题**：`pending` Map 没有总条目数 / 总字节数上限。peer 持续发送不同 msgId 的 FLAG_BEGIN 但不发 FLAG_END，每个 entry 都留在 Map 中（每个 1 chunk）。`MAX_REASSEMBLY_BYTES`/`MAX_CHUNKS_PER_MSG` 是单条消息粒度，跨条不护。

**影响**：理论上可被恶意 peer DoS 撑爆 reassembler 内存。但 CoClaw 的 DC 对端是受信 UI（不是公网随便接入），peer 关闭时 reassembler GC 释放。实际风险低。

**修复方向**：加 pending 总条数上限（如 100）+ 总字节数上限，或加 entry 级超时（首次 chunk 后 N 秒内无 END 则丢弃）。需要决策超时窗口（OpenClaw run 单条消息可能 > 60s）。

### webrtc-peer ICE restart 不刷新 TURN iceServers config

**发现日期**：2026-05-02（D 阶段 dim 2）
**关联**：plugins/openclaw/src/webrtc/webrtc-peer.js:185-244 __handleOffer ICE restart 分支

**问题**：ICE restart 时 `msg.turnCreds` 仅用于打 `credRemain` 日志，旧 PC 的 ICE config（含 TURN 凭证）没有更新。如果 TURN 凭证在通话中途过期，restart 后的 relay 候选用旧凭证失败。

**影响**：高 — 长通话过程跨 TURN 凭证 TTL 边界时，relay-only 路径恢复失败，UI 需全量 rebuild。但 TURN 凭证 TTL 一般较长（小时级），实际触发概率低。

**修复方向**：在 setRemoteDescription 之前调 `existing.pc.setConfiguration({ iceServers: rebuiltFromTurnCreds })`。需先验证 pion-node 与 werift 的 setConfiguration 实现一致性。

### claw-binding 并发 bind/unbind R-M-W 跨调用竞态

**发现日期**：2026-05-02（D 阶段 dim 7）
**关联**：plugins/openclaw/src/common/claw-binding.js bindClaw / unbindClaw

**问题**：`bindingsMutex` 仅保护 config.js 的 writeConfig/clearConfig 内部 R-M-W；不保护 claw-binding 层的"读 → server 调用 → 写"完整序列。两个 CLI 进程或同时调用 RPC `coclaw.bind` 与 `coclaw.unbind` 时存在竞态。

**影响**：CLI 用户连按或脚本并发触发的边角场景。gateway 单进程 RPC 通常串行处理同名 method。

**修复方向**：跨模块暴露 mutex（claw-binding 持有自己的 mutex 包覆整个 bindClaw/unbindClaw），或文件级 advisory lock。

### unbindClaw 已解绑时返回 NOT_BOUND 而非幂等成功

**发现日期**：2026-05-02（D 阶段 dim 7）
**关联**：plugins/openclaw/src/common/claw-binding.js:160-164

**问题**：unbindClaw 在本地 config.token 缺失时抛 `NOT_BOUND` 错误。脚本重试 / 用户连按 unbind 被当成失败。

**影响**：低 — 行为缺陷，非 bug。CLI 输出不友好。

**修复方向**：改为 `return { clawId: null, alreadyUnbound: true }`。需检查所有调用方对返回值的依赖。

## E 阶段（2026-05-02）跨模块 / 复杂改动 TODO

### restartRealtimeBridge / stopRealtimeBridge 缺串行化保护

**发现**：E1 codex-rescue 维度 1。
**锚点**：`plugins/openclaw/src/realtime-bridge.js:1438`（restartRealtimeBridge）/ `:1454`（stopRealtimeBridge）

**问题**：两次 restart 并发交错时，先创建的 bridge 被新引用覆盖，后续 stop 只停当前 singleton，旧 bridge 已 start 但引用丢失，无法清理。

**修复方向**：给 singleton 生命周期加 mutex / promise queue，串行化 restart/stop。

**为什么 TODO**：跨模块状态机锁，需整体设计 lifecycle 管理；现有测试只覆盖顺序 restart，需新增并发场景测试。

**2026-06-22 注记（合并自原「pion preload 缺并发合并保护」条）**：该 race 在 pion 层有重复症状——并发 restart 各自 `start()→preloadPion()` 会 spawn 多个 pion-ipc Go 子进程 + 旧 singleton 孤儿化（孤儿 PionIpc 带 autoRestart 看门狗、仅 `stop()` 回收，泄漏自愈型 Go 进程）。⚠️ **别在 `preloadPion` 内做 in-flight 合并**（原条目的修复方向是错的）：它是每 bridge 实例一次的无状态工厂、每次 new 独立 `PionIpc` 且 `cleanup=ipc.stop()` 绑死该实例（`pion-preloader.js:53-64,80-89`），合并会让两个不同 bridge 共享同一 Go 进程→一个 stop()/restart 把另一个传输层一并杀掉（共享生命周期/双重 stop）。治本＝本条的 restart/stop 串行化，pion 多进程是其副作用、随本条一并消除。

### bind/unbind 在缺 serverUrl 但有 token 时静默跳过远端解绑

**发现**：E1 codex-rescue 维度 1。
**锚点**：`plugins/openclaw/src/common/claw-binding.js:37`（`bindClaw`）/ `:195`（`unbindClaw`）

**问题**：legacy 或手动写入的 `bindings.json` 中存在 `{ token, clawId }` 但无 `serverUrl` 时，本地照样清理但远端不解绑，违反 unbind "强制不容错"契约的精神（实际 server 还有孤儿 claw）。

**为什么 TODO**：是否保留兼容旧格式属于设计决策（用户场景待确认）。需先和用户对齐：`serverUrl` 缺失时是直接报错，还是兜底用 default url。

### gateway pre-handshake send-fail 不入退避重试

**发现**：E2 codex-rescue。
**锚点**：`plugins/openclaw/src/realtime-bridge.js:669-672`（`__sendGatewayConnectRequest` catch）

**问题**：握手 connect 请求 send 抛错时只 warn + 清 reqId，未关 ws、未调 `__onGatewayAttemptFailed`，握手前 close handler 又被 `wasReady||connectFailReported` 守卫拦下，最终不入退避。

**为什么 TODO**：触发面极窄（ws send 在 OPEN 状态抛错少见）；改动需要谨慎覆盖握手三态机。先放一放，等真实环境观察到该路径触发再修。

### bind 进行中可被新 enroll 插入覆盖 config

**发现**：E 阶段 round-2 复查（codex-rescue High）。
**锚点**：`plugins/openclaw/index.js`（doBind / cancelActiveEnroll / coclaw.enroll handler）、`plugins/openclaw/src/common/claw-binding.js`（enrollClaw / waitForClaimAndSave）

**问题**：`bind` 在取消 enroll A 后立即把 `activeEnrollAbort` 置 null，自身仍在 `await bindClaw` 期间不会阻挡新进来的 enroll B；B 进入时 `enrollClaw` 仅检查"已持久化 config 是否 token"——bind 还没 writeCfg 完成，B 通过检查并最终也写一次 token。两条路径写 config 顺序不确定，可能产生 enroll-vs-bind config 覆盖。

**影响**：用户连续操作（先 enroll、再 bind）极少触发；自动化 / 多客户端并发更可能命中。当前 round-1 已修了 bind/unbind 主动 cancel enroll，但反向"bind 进行中拒绝新 enroll"未做。

**为什么 TODO**：跨 bind/unbind/enroll 三条路径的操作互斥需要统一 op generation 计数器或全局 mutex，属于跨模块状态机锁。round-1 的 `cancelActiveEnroll` 已解决主要单方向 race；剩余双向竞态留待统一规划 lifecycle 时一并修。

**Compact 后复盘（2026-05-02）**：经 origin/main 与 HEAD 对比，此问题在 origin/main（未引入 `cancelActiveEnroll` 之前）就已存在——bind/unbind 入口本就完全不感知活跃 enroll，并发即互踩。本次 `bd6dd61` / `df7ec73` 仅是缩窄了 race 窗口（入口主动取消旧 enroll + waitClaimCode 后多一次 abort 检查），并非引入或放大。属预存问题，发版前不修。

### waitForClaimAndSave writeCfg 期间 abort 信号无回滚（H3）

**发现**：F 阶段 deep-review compact 后 H2/H3 联合复盘（2026-05-02）。
**锚点**：`plugins/openclaw/src/common/claw-binding.js:155-180` `waitForClaimAndSave` 内 BOUND 数据分支

**问题**：`df7ec73` 在 `waitClaimCode` 返回后、`writeCfg` 开始前加了 `if (signal?.aborted)` 检查 + 服务端 token 回滚。但该检查只覆盖"abort 信号在 await waitClaimCode 期间到达"这一窗口；若 abort 在 `await writeCfg` 进行中或写完之后到达，本地 token 已经落盘，没有任何回滚路径。

**影响**：与 H2 同等结果——本地写入了"应被取消的 enroll"的 token，bridge 后续用错误身份连服务端。可恢复（用户重新 bind）。

**为什么 TODO**：单独修这一个窗口仍治不彻底（H2 未解、bind/bind 也未保护），需要与 H2 一起用 mutex 或 op generation 统一改造，属跨模块状态机锁，6-8 小时工作量 + 关键路径风险。

**Compact 后复盘（2026-05-02）**：origin/main 的 `waitForClaimAndSave` 完全没有 abort 检查，落盘动作直接发生——比当前 HEAD 的窗口更宽。本次仅是收紧、不是引入或放大，属预存问题。

## G 阶段（2026-05-02）deep-review 发现且不修

### enroll cancel 不通知 server，mobile 后到 claim 留孤儿 claw（H, 本次引入）

**发现**：G 阶段 deep-review 维度 1（codex-rescue）。
**锚点**：`plugins/openclaw/index.js:208-216` `cancelActiveEnroll`、`plugins/openclaw/src/common/claw-binding.js:120-189` `waitForClaimAndSave`

**问题**：`cancelActiveEnroll()` 只在 plugin 端 abort 长轮询，不通知 server 失效 claim code。如果取消之后 mobile 端在 claim code 30 分钟过期之前还是 claim 上去，server 创建 claw + token 但 plugin 不再轮询取它 → server 留下死记录。`df7ec73` 的回滚只覆盖"长轮询返回 BOUND 之后、writeCfg 之前 abort 到达"窗口，覆盖不到"abort 之后才 claim"窗口。

**实际影响**：server DB 长尾死记录直到自然过期/server 自己清理；plugin 端业务无感；user-facing 影响极小。

**为什么 TODO**：origin/main 没有 cancelActiveEnroll，enroll 长轮询不会被中途取消，mobile 任何时候 claim 都有人取——所以是本次引入的 regression，但 user-facing 影响小。修法 A（server 加 invalidate-claim-code RPC）跨工作区；修法 B（plugin 端保留终态 watcher）增加复杂度。属 H2/H3 同家族，待统一规划 bind/enroll 状态机锁时一并处理。

### server message handler await 后未重验 sock identity（M，预存）

**发现**：G 阶段 deep-review 维度 3（codex-rescue）。
**锚点**：`plugins/openclaw/src/realtime-bridge.js:1213-1220` `rtc:` 分支 `await __webrtcPeerReady` + `await webrtcPeer.handleSignaling`

**问题**：入口 1197 行有 stale guard，但 1213-1220 两次 await 期间 `serverWs` 可能被 close handler 设 null 或换成新 sock。await 返回后会用旧消息内容调用当前 webrtcPeer。webrtcPeer 自身有大量 identity guard 兜底，实际穿透概率低。

**修复方向**：每次 await 后重验 `this.serverWs === sock && !this.intentionallyClosed`。

**为什么 TODO**：预存、穿透概率低、webrtcPeer 内部 guard 已兜底。

### atomic-write 系统断电场景的 fsync 加固（M，预存）

**发现**：G 阶段 deep-review 维度 4（codex-rescue）。
**锚点**：`plugins/openclaw/src/utils/atomic-write.js`（`atomicWriteFile` 与 `atomicWriteFileSync`）

**问题**：当前实现是 `writeFile(tmp) → rename`，rename 是原子 syscall，能防"进程崩溃"。但系统级断电（kernel panic / 拔电）下，tmp 文件的数据可能还在内核 buffer 没刷到磁盘，rename 完成但目标文件读到 0 字节或旧数据。同理父目录的 rename 元数据也可能未持久化。

**影响**：device-identity 私钥、settings、bindings、auto-upgrade state/lock/log 都过这条路；理论上系统断电后可能丢失最近一次写入。但这些数据全部可恢复（重新 bind / 重新生成 deviceId），且 plugin 跑在用户机器上，真"硬断电"极少发生。

**为什么 TODO（不修）**：曾尝试在 7fac52e 加 fsync(tmp) + fsync(父目录)，后回滚（ebffc1d）。原因：
- 价值低 —— 保护极罕见、可恢复场景
- 风险高 —— `tmpFh.sync()` 在某些环境（特殊 FS、网络存储、Windows 路径）可能抛错，未做 best-effort 兜底；atomic-write 抛错会让 auto-upgrade lock / state 写不下去，引入比原问题更危险的 regression
- 测试覆盖不足 —— 没法在普通文件系统上模拟"系统断电"

**修复方向（未来若做）**：
- fsync(tmp) 包成 best-effort try/catch + warn，失败不传播给 caller
- fsync 父目录已经是 best-effort（Windows 不支持 dir fd）
- 给 auto-upgrade 路径加专项测试覆盖 fsync 抛错场景
- 单独发一个补丁版本（不与 release 节奏混在一起）

## A1 异步装配引入的"handler 已挂、字段未挂"理论窗口（Phase B 切 FBQ 时一并补 warn）

**发现日期**：2026-05-03（rpc-dc Phase A1+A2 deep-review）
**关联**：`plugins/openclaw/src/webrtc/webrtc-peer.js` `__setupDataChannel`

**问题**：Phase A1 把 `__setupDataChannel` 改 async 后，handler 顺序倒过来——A1 之前是"先做三件套（赋字段）后挂 handlers"，A1 之后是"先挂 handlers 后 await queue.init() 才赋字段"。结果：dc.onopen / dc.onmessage 在 await init() 期间触发时，`session.rpcQueue` 还是 null，下游有两条 silent drop 路径：
1. **file sendFn** `sess?.rpcQueue?.enqueue(...)` 在 rpcQueue 为 null 时 short-circuit 返回 undefined，没有任何 log，违反"丢消息必须 loud 可观测"红线
2. **dc.onopen → __sendPeerTransport** 在 init 期触发时 sendTo 返回 false，peer-transport 诊断信息丢失，没有 retry

**MemoryQueue 阶段为什么不触发**：MemoryQueue.init() 是 async no-op（仅消耗 1 microtask），dc.onopen / dc.onmessage 由 SCTP 握手异步触发（native ms 级），microtask 必然在 SCTP 完成之前 resolve。实测 race 窗口宽度 ≈ 0。

**Phase B 切 FBQ 时为什么会成为现实**：FBQ.init() 做 fs.rm + createWriteStream，可能数 ms 到数十 ms，与 SCTP 握手时间重叠，理论窗口 → 现实窗口。

**修复方向（Phase B 时一并做）**：
- file sendFn 加 null check + warn 日志（`rpcQueue not ready, dropped file response`）
- __sendPeerTransport 在 sendTo 返回 false 时打 warn 或一次性 retry（peer-transport 是诊断信息，丢失影响小）
- 等 Phase B 引入 RpcDropMonitor 后，把这两条 silent drop 也作为 reason 上报

**关联（不同失败模式、不合并）**：本条是 init **顺利期间** rpcQueue 暂 null 的**瞬态自愈**窗口（init resolve 即愈）；构造/init **抛错**后的**永久半残**是另一条 `## __setupDataChannel 装配抛错 → rpcQueue 半残静默丢消息`。两者根因同源（字段赋值在 handler 挂载之后）但修法不互相覆盖。（注：FBQ 现已切，本条理论窗口已成现实窗口，但仍自愈。）

## claw-paths runtime 改造遗留（2026-05-05 deep-review 抓出，预存）

### session-manager readFile TOCTOU 分支无法 test-only 覆盖（PRE-EXISTING 噪音，余 1 项）

**发现日期**：2026-05-05（2026-06-23 收口）
**关联**：`src/session-manager/manager.js` `readTranscriptText` 的 readFile race 块

2026-06-23 测试补强：原条目列的 default-construct / malformed / invalid-index / 分页 分支前轮已覆盖；本轮又补测并删除了 5 处 c8-ignore（safeReaddir / safeAccess 非 ENOENT 上抛、listAll 与 resolveTranscriptFile 的 readdir→stat race 双子分支、sort tiebreaker），均用悬空/自环软链构造确定性 ENOENT/ELOOP，无 prod 逻辑改动。

**剩 1 项无法 test-only 覆盖**：`readTranscriptText` 的 readFile race 块——`if (err.code === 'ENOENT') return ''` 子分支需真 TOCTOU（文件在 resolveTranscriptFile 校验通过后、readFile 前消失），非 mock `fsp` 或改 prod 不可确定复现；兄弟 throw 分支仅 EACCES 可达，删块 ignore 会暴露未覆盖的 `return ''` 语句、打破 `--lines 100 / --statements 100` 门禁。故保留该处 c8-ignore。

### sendPeerTransport 签名回滚后无重发触发器（PRE-EXISTING）

**发现日期**：2026-05-06（B-stage2 B10 deep-review 抓出）

**锚点**：`plugins/openclaw/src/webrtc/webrtc-peer.js:905-932`（`__sendPeerTransport`）+ `:635-644`（`dc.onopen` queueMicrotask 调用点）

**问题**：`__sendPeerTransport` 在 sendTo 失败时回滚 `__lastPeerTransportSig` 并注释"以便 dc.onopen 再次触发时重发"，但 `dc.onopen` 在 dc 生命周期内只触发一次——没有任何机制让它"再次触发"。失败后该 session 的 peer-transport 信息（candidate type / protocol / relay protocol）永久不会上报到 UI 诊断。

**触发条件**：dc.onopen 触发时 `session.rpcQueue` 尚未就绪——`sendTo` line 190 检查 `if (!q || ...) return false`。MemoryQueue 时代 `init()` 是异步 no-op-but-callable（plan-1 round-2 引入），微秒级完成；切到 FBQ 后 `init()` 包含 mkdir + readdir + cleanupResiduals + open writeStream，时间窗从 microtask 级放大到数十毫秒级。**B-stage2 B9b 让 PRE-EXISTING bug 从理论暴露变成实际易复现**，但 race 本身在 plan-1 round-2 引入 `init()` 后就已存在。

**影响**：仅 UI 诊断信息（peer transport 信号）丢失，不影响 RPC 业务。

**修复方向**：装配 rpcQueue 后主动调一次 `__sendPeerTransport(connId)`（条件：`session.pc.selectedCandidatePair` 已 nominate 完成），或在 sendTo 失败回滚 sig 后注册一个"等 rpcQueue 就绪重试"的钩子。（2026-06-11 归位：本段原误插在下方"上游契约演进"条目内）

## 跟踪 OpenClaw 上游契约演进对 auto-upgrade 的影响

**发现日期**：2026-05-06

**背景**：自动升级链路跨"gateway 进程内 spawner"和"detached worker 子进程"两段，对 OpenClaw 的依赖面分成两块。任何一块的契约变更都可能让自动升级整体失效或误回滚，需统一跟踪。

### 1. 账本格式（已闭环：账本直读全部移除，2026-06-11）

2026-06-11（commit 1f2cae34）起 updater 与 `scripts/_lib.sh` 不再直读任何账本文件（旧 JSON / 新 SQLite 均不读），安装记录一律经 `openclaw plugins inspect <id> --json`（依赖契约见第 2 节表末行）。历史教训保留：上游两次搬家（2026.4.25 `openclaw.json` → `plugins/installs.json`；2026.6.1 → 共享 SQLite）都曾打断升级链——后续任何"新增状态读取"一律优先 CLI/SDK，禁止再添文件直读。

**措辞更正（2026-06-11）**：本条旧版称"SDK 侧已有 `loadInstalledPluginIndexInstallRecordsSync` helper，可考虑切换到 SDK API"——失准。该 helper 是上游内部模块，**从未经 plugin-sdk exports 暴露**（exports 实查），插件侧从来不存在可用的 SDK 安装记录查询面；CLI inspect 是唯一官方契约。

### 2. CLI 契约（gateway L1 门禁 + worker 端依赖）

worker 故意不读 OpenClaw 内部 state（pluginDir 由 spawner 通过 `--pluginDir` 传入），gateway 的 L1 来源门禁与 worker 全程靠子进程调 `openclaw` CLI，因此对 CLI 行为强耦合：

| 调用 | 锚点 | 失败后果 |
|---|---|---|
| `openclaw plugins update <pkg-name>`（2026-06-11 起传裸 npm 包名而非插件 id，借 update 的包名匹配把安装记录 spec 重写为裸名、解除 exact spec 钉死；依赖"裸包名恰好单匹配一条 npm 安装记录"，0/多匹配退回按 id 处理 → no-op skip） | `worker.js` | 升级直接失败 → 回滚（不 skipVersion，按瞬态） |
| `openclaw plugins install <pkg>@<ver> --force`（2026-06-11 起单命令覆盖装回滚兜底，替代原 uninstall+install 两段；依赖 `--force` 映射 mode=update 绕开 already exists） | `worker.js` | 备份恢复失败叠加此失败 → 终态 `rollback-failed`（坏版本在位） |
| `openclaw gateway restart` | `worker-verify.js` | 验证前 gateway 不被主动重启，依赖 watcher 自恢复；回滚分支该命令失败追加 jsonl 事件 `rollback-restart-failed` |
| `openclaw gateway call <method> --json` | `worker-verify.js` | 见下条 |
| `--json` 输出 = RPC result 原值（无 envelope） | 同上 | 若上游加 `{ok,result}` 包装，`JSON.parse(output).version` 取到 undefined → 一直 missing-version → 验证超时 → 误判为"新版本坏掉"并 skipVersion + 回滚 |
| `openclaw plugins inspect <id> --json`（2026-06-11 新增依赖） | `updater-check.js` `inspectPluginInstall`（gateway L1 来源门禁 + worker L2 结局核对共用）；`_lib.sh` `load_install_record` | L1 失败 → 本周期跳过（去重 `upgrade.gate-inspect-failed`，下周期自愈）；L2 失败 → 保守按真升级走 restart+verify。**契约点**：exit code（未安装非 0）、顶层 `install` 字段透传原始 record（含 `source`/`installPath`/`version`/`sourcePath`） |

**前提注（2026-06-11）**：表中"后半程"行——回滚兜底 install、`gateway restart` 之后的 `gateway call` / `--json` 解析等——仅在 worker 能存活过网关重启的形态下成立；npm+systemd 默认形态曾被本机实测证伪（worker 与 gateway 同 cgroup，重启清场连带杀死，后半程整段不可达），worker cgroup 脱逃修复（systemd-run scope 包装）后恢复成立；探针失败的降级形态仍不成立，账目由 scheduler inflight 对账兜底（见 `docs/auto-upgrade.md`）。

**风险等级**：CLI 子命令名长期稳定（CHANGELOG 没出现过重命名），但 `--json` 输出包装是历史相对短的接口，`docs/auto-upgrade.md` 里也标了"`coclaw.upgradeHealth` 返回格式 → 待定"。

另一条语义依赖（按设计稿 P5 核实结论注记，2026-06-11）：`plugins update` 对 path/archive 装置与**缺安装记录**的行为是"干净 skip + exit 0"（先于任何磁盘写）——L2 no-op 分支（record 未推进 → 立即 skipVersion）依赖此语义；上游若把 skip 改成报错或部分写盘，worker 结局矩阵需重审。

**应对**：升级 OpenClaw 时关注 `src/cli/gateway-cli/call.ts` 与 `plugins-*.ts` 是否变更子命令名/参数 schema/输出格式；尤其留意 `gateway call --json` 是否加 envelope（如加包装，worker-verify 的解析需兼容两种形态）、`plugins inspect --json` 的 exit code 与 `install` 字段透传是否变化。

## 2026-05-06 deep-review（file-manager test setTimeout→waitFor 改造）抓出的预存问题

### __gatewayRpc 真 setTimeout 触发 settle 路径丢失端到端测试覆盖

**锚点**：`plugins/openclaw/src/realtime-bridge.js:379` 的 `setTimeout(() => settle({ ok: false, error: 'timeout' }), timeoutMs)`

**背景**：b106430 把 `ensureAgentSession should NOT reset on resolve timeout` 用例 stub 掉了 `__gatewayRpc`（避免等真 2s 定时器），节省 ~2s。后果：`__gatewayRpc` 自身的真 setTimeout 触发 settle 行为不再有用例端到端验证。

**注意**：c8 line coverage 仍 100%（setTimeout 注册行通过其他路径被执行；arrow function body 也算 covered）。但**真 timer fire → settle('timeout') → clearTimeout → delete pendingRequest** 的端到端行为没专门用例。`__gatewayAgentRpc` 是另一套独立实现，不复用 `__gatewayRpc`。

**修复尝试记录**：本次 review 试过补一条直测用例（`bridge.__gatewayRpc('any.method', {}, { timeoutMs: 10 })`），但 bridge.start() 后即使调 `drainEnsureAllAgentSessions` 也会让 event loop 残留 pending promise（连续两次报 `'Promise resolution is still pending but the event loop has already resolved'` + `cancelledByParent` 级联取消后续 ~140 个用例），暂未找到稳定 setup。已撤回。

**修复方向**：考虑直接 mock 一个 bridge 实例，手工设置 `gatewayWs` / `gatewayReady` 等内部状态，绕过 `bridge.start()` 的全套副作用；或拦截 `setTimeout`（参考 `RealtimeBridge should handle connect timeout` 的 timer 拦截 pattern）让 setTimeout 立即触发。

## 2026-05-07 FBQ bypass-overshoot round 2 deep-review 抓出的预存问题

### webrtc-peer.test 的 flushAsync 依赖固定圈数 setImmediate（PRE-EXISTING）

**锚点**：`plugins/openclaw/src/webrtc/webrtc-peer.test.js:19` 的 `flushAsync` helper

**问题**：当前实现是固定圈数 `setImmediate`，consumeLoop 或 setup 内部任何位置多一个 `await` 都可能让相关测试假通过或假失败。

**修复方向**：改成轮询具体可观测条件（如 `until queue.memBytes === 0` / `until session.rpcDcSender.flushed === true`）或等待事件 Promise，而非固定 tick 数。

## 2026-05-07 FBQ 本机实测中发现的诊断盲点

### FBQ / monitor 都未统计 bypass overshoot 的次数与字节数

**发现日期**：2026-05-07（FBQ 本机实测 A 场景，跑 agent run 看不到 bypass 路径流量量级）

**锚点**：
- `plugins/openclaw/src/utils/file-backed-queue.js:184-190` bypass overshoot 入队路径无任何计数
- `plugins/openclaw/src/utils/file-backed-queue.js` `stats()` 只返回 memCount / memBytes / diskBytes / writtenBytes / spilled / fsBroken
- `plugins/openclaw/src/webrtc/rpc-drop-monitor.js` `getStats()` 当前返回 dropCount / dropBytes / overflowActive / spillActive / fsBroken / lastReason，仍然没有 bypass 计数

**问题**：degraded 模式下 bypass overshoot 是"豁免 admission 但没存账"的路径，运维侧无法知道它救了多少帧。健康路径下也无法区分入队的是 bypass 流量还是普通流量。close-log 的 `residualChunks` 只是关闭瞬间快照，算不上累计统计。

**影响**：bypass overshoot 是 round 1 修复的核心特殊路径，但缺乏正向流量观测——只能间接通过"`fsBroken=true` 但 `dropped=0` / `lastReason!=fs-error`"等组合推断曾经走过。一旦 bypass 流量持续大、mem 桶接近无界（红线 3 设计取舍接受 OOM 风险），运维只能看 RSS 增长后果，看不到原因。

**修复方向**：
- FBQ `enqueue` 增加 `__bypassEnqueueCount` / `__bypassEnqueueBytes` 累计字段，stats() 透出
- 可选：进一步细分 `__bypassOvershootCount`（仅 overshoot 路径触发）vs 普通 bypass 入队（memFits=true 时也豁免 diskCap admission，算 bypass 但不是 overshoot）
- monitor 不必参与（monitor 是 drop 视角，bypass 不是 drop）；bypass 统计放 FBQ 自身 stats 即可
- close-log 加 bypass 累计字段（与 dropped / residual 并列），让降级期间的 bypass 救援量级可观测

## gateway WS transport-level error 握手前发生时重试调度静默卡死

**发现日期**：2026-05-09（Round 2 step 2 deep-review 由 codex-rescue 综合实例 surface）

**锚点**：
- `plugins/openclaw/src/realtime-bridge.js:975-987` `ws.addEventListener('error', ...)` handler — 仅打日志 + 主动 close，没有标"connect-failed"
- `plugins/openclaw/src/realtime-bridge.js:963-973` close handler 重试调度的判定 `if (this.started && !this.__gatewayGaveUp && (wasReady || connectFailReported))`
- `connectFailReported` 仅在 `:812` 设置 true（v3 握手 res 的协议错误分支）

**问题**：gateway WS 在握手前发生 transport-level error（连接被拒、DNS 失败等）时，error handler 主动 ws.close(1011)，但 `connectFailReported` 没人设 true、`wasReady` 也是 false。close handler 的重试调度判定两个条件都不满足 → **静默不重试**，gatewayWs 卡在 null，新一轮 `__ensureGatewayConnection` 也不会自动调度。bridge 看似活着但内线永久断。

**当前不易触发**：本机 OpenClaw gateway 是同进程嵌入，本地 WS 连接极少 transport error。但 IPC over WS / 容器化场景下可能撞到。

**修复方向**：error handler 内主动设 `connectFailReported = true` + `__gatewayLastReason = 'ws_error'`，让 close handler 走重试路径；或独立调用 `__onGatewayAttemptFailed('ws-error')`。

**预存问题**：step 1 之前就存在（step 1 仅移除了外线 gate `serverWs && serverWs.readyState === 1`），不是 Round 2 引入，但 Round 2 让内线独立后这个长尾问题会更显眼（外线无法兜底重启内线了）。

## pion-ipc SIGTERM 退出码 + watchdog 误打 schedule restart 噪声

**发现日期**：2026-05-09（Round 2 系统级测试 gateway 重启日志分析）

**锚点**：
- `@coclaw/pion-ipc`（Go 二进制）SIGTERM 处理路径 + exit code 决定逻辑
- `node_modules/.../@coclaw/pion-node@0.3.0/src/pion-ipc.js:308` `_handleProcessExit` / line 329 `_scheduleRestart`
- gateway 重启时 plugin stop hook 与 OS 进程组信号传播的时序

**现象**：gateway 收到 SIGTERM 重启时，gateway 日志会出现这一串噪声：
- `[pion-ipc] [stderr] received signal, shutting down signal:15`
- `[pion-ipc] [stderr] ERROR service exited with error: context canceled`
- `[pion-ipc] process exited code=1 signal=null`
- `[pion-ipc] watchdog: restart #1 in 200ms`

但 watchdog 计划的 200ms 重启实际不会发生——plugin stop 路径稍后调到的 `ipc.stop()` 会把 `_stopped/_intentionalStop` 标记上并清掉 `_restartTimer`。

**根因层次**：
- OS 把 SIGTERM 群发给整个进程组 → pion-ipc Go 子进程**先于** plugin stop hook 调到 `ipc.stop()` 之前被杀
- Go 端把 `context.Canceled` 当 ERROR 返回主进程并 exit code=1（应当 exit 0）
- pion-node 的 `_handleProcessExit` 看到 `_intentionalStop=false`（plugin 还没来得及调 stop），按崩溃路径 schedule watchdog restart 并打 log
- 紧跟 plugin stop 调到 `ipc.stop()`，把 watchdog 拆掉，**实际没有真重启**

**影响**：仅日志噪声，不影响功能。但容易让分析者误判为异常退出 + 真重启。

**修复方向**（不在 plugin 层）：
- **首选 · pion-ipc Go**：SIGTERM 路径走优雅退出，把 `context.Canceled` 视为已知关闭原因，exit 0；不要打 ERROR 级 service 退出 log
- **备选 · pion-node**：spawn pion-ipc 时放进独立进程组（`detached: true` / 设 `setpgid`），避免 OS SIGTERM 群发波及子进程，由 pion-node 主动按节奏 stop
- plugin 层无更优解——已在 stop hook 内 await `ipc.stop()`，无法更早抢救（被 OpenClaw gateway shutdown 触发时机决定）

**预存问题**：非 plugin 自身 bug，不在本仓库修；plugin 作为下游观察者跟踪上游修复。

## 自动升级与 OpenClaw 插件 hub 形成双源（hub 上线前必须决策）

**发现日期**：2026-05-09（pre-hub release 设计 review）

**锚点**：
- `src/auto-upgrade/updater.js:269` `scheduler.start()`
- `src/auto-upgrade/updater.js:218-220` 唯一 opt-out（`OPENCLAW_NIX_MODE=1`）
- `docs/auto-upgrade.md` 立项动机段落：上游当时无 plugin hub

**问题**：插件每小时自检 npm + spawn worker 改 `openclaw.json` + 触发 gateway restart，这套是在"OpenClaw 没有 plugin hub"前提下设计的。发到 hub 上线后，hub 自己也管版本（清单、签名、灰度、回滚），plugin 还自带升级逻辑就形成两个升级源：hub 装 v0.21、plugin 半小时后又自己升到 v0.22；用户在 hub 端禁掉某版本，半夜 plugin 又把它装回来；hub 想灰度时 plugin 越权改 `openclaw.json`。当前唯一 opt-out 盯的是 nix 环境，识别不到 hub 装机。

**触发场景**：hub 接管插件分发；用户在 hub 端禁用/锁定某版本；多设备同步要求版本一致；企业管理员锁版本。

**修复方向**：
- 默认行为改为 opt-in（设置开关或 env），hub 装机路径下默认关；npm 直装可保留默认开
- 现有 `source==='npm'` 判定不足以区分"hub 装"vs"npm 直装"，需要 OpenClaw 上游补 install source 字段（`hub` / `npm` / `path` / `archive`）
- 这是发布到 hub 前的**前提级决策**——保留 / 让位 / 改 opt-in 必须先选一条，不是发布后小修

**严重度**：Block release（双源会在 hub 上线第一天就打架）

## 大文件上传接收侧无内存上限（最坏可打崩 gateway）

**发现日期**：2026-05-09（pre-hub release 设计 review）

**锚点**：
- `src/file-manager/handler.js:648-778` `receiveUpload` 内 `pendingQueue.push()`
- push 前无长度 / 字节水位检查；仅在 error / abort 路径清空

**问题**：UI 经独立 file DC 上传时，进来的二进制块先入内存队列 `pendingQueue`、再由 `drainLoop` 异步刷盘。声明上限 1GB，但中间无内存水位封口——磁盘慢/卡盘时队列持续堆积，最坏打爆 gateway 进程内存把整个 OpenClaw 拖崩。

**触发场景**：公网用户群里慢盘 / WSL / 杀毒扫描插一脚 / 老硬件并不罕见，撞概率不低；不需要恶意构造。

**修复方向**：
- 给 `pendingQueue` 加内存字节水位（HWM/LWM）：超 HWM 暂停 ack DC 数据帧、磁盘追上后再放行
- 与 UI 端约定一套"接收侧反压"信令帧（当前 file DC 没有这一层）
- 极端时直接拒绝继续接收（reason=receiver-busy）让 UI 重试

**严重度**：Block release（公网用户群有真实概率把 gateway 打崩）

## 占位/已停用代码会随 npm 包发到 hub

**发现日期**：2026-05-09（pre-hub release 设计 review）

**锚点**：
- `src/webrtc/ndc-preloader.js`（旧 node-datachannel 路径，依赖已摘除，运行不命中）
- `src/transport-adapter.js` + `src/message-model.js`（"未来通过 channel outbound 收发消息"的预留适配层，主路径不经过）
- `src/channel-plugin.js:42-51` `outbound.sendText` 占位 + `status.defaultRuntime.running: true` 写死
- `package.json` `files` 字段为 `src/**/*.js`，会把上述一并发到 npm

**问题**：
1. 包体增大、装机时间略长
2. OpenClaw 未来给 channel outbound 加 schema 校验时，这些占位会变成噪音报错源
3. `outbound.sendText` 返回 `coclaw-${Date.now()}` 形式 messageId——上游真接通那天会被识别为"成功投递但不可追溯"，比明确的 `not-implemented` 错误更难排查
4. `status.defaultRuntime.running: true` 写死，admin 看到永远绿、掩盖 bridge 真实状态

**修复方向**：
- 删 `webrtc/ndc-preloader.js`、`transport-adapter.js`、`message-model.js` 及对应测试（`docs/architecture.md:172-178` 已标"别花时间读"）
- `channel-plugin.js` 保留但 `sendText` 改成显式 throw `not-implemented`（含 error code）
- `status.defaultRuntime.running` 接到 bridge 实状态（singleton 启动且 server WS alive）

**严重度**：Should fix（hub 发布前清干净一波，避免噪音随包扩散）

## await 让出窗口下 connId 复用 → response 投递到新 session（预存架构问题）

**发现日期**：2026-05-11（session-manager streaming jsonl deep-review，codex-rescue R2 抓出）
**关联**：`src/realtime-bridge.js:1091`（`__dcPendingRequests.set`）、`src/realtime-bridge.js:895`（`sendTo` 投递）、memory `feedback_async_orphan_operation_pattern`

**问题**：UI 转发 RPC 路由表 `__dcPendingRequests` 只记 `reqId -> connId`。任何 RPC handler 内部 await 让出（含本次每 100 行的 setImmediate、旧的 `await fsp.readFile` 等）期间，同一 `connId` 可能被一个新建的 WebRTC session 复用——handler 跑完调 `sendTo(connId, payload)` 时会把旧请求的 response 投到新 session 的 DC。极端窗口里可能造成"答非所问"。

**为什么本次未一并修**：本次 streaming 改动**不放大风险量级**——旧 `readFile` 已经创造让出窗口；让出频率从"1 次/调用"提到"N 次/调用"但单次窗口仍是毫秒级，总暴露面积≈总耗时基本不变。问题本质是路由表缺 session 代数（generation）/ session 替换时未清表，是架构层预存问题。memory 已有 async-orphan 模式记录但治本方案未定。

**修复方向**：路由表存请求时同时记录"session 代数"标识；`sendTo` 前对比当前映射的 session 是否仍是发请求时那个，不匹配直接丢弃。或在 connId 对应 session 关闭/替换时主动清空该 connId 下所有 pending reqId。

**严重度**：Low（窗口窄、复用条件苛刻；但要根治需要架构层改动，纳入 async-orphan 治本方案讨论）

## helper chunk 边界检测在 pretty-print JSON 多 chunk 到达时可能误判

**发现日期**：2026-05-16（Phase C 核实 C3 时顺手识别）
**关联**：`plugins/openclaw/src/common/gateway-notify.js:107-113` chunk 监听 + `startGracePeriod`

**问题**：`child.stdout.on('data')` 累积 stdout 后判 `trimmed.startsWith('{') && trimmed.endsWith('}')` 即触发 `startGracePeriod()`；后者**同步调用 `parseResult()`** 并把结果钉死到 closure 里。

上游 `openclaw gateway call --json` 实际输出的是 pretty-printed JSON（缩进 2）。若 payload 含嵌套对象、且 stdout 分多 chunk 到达，**中间某次累积可能恰好在嵌套对象闭合的瞬间满足 startsWith/endsWith**——此时 stdout 整体仍是不完整 JSON，`JSON.parse` 抛、`parseResult` 退化到"非 JSON 兜底"返回 `{ ok: true }`（无 payload）。

**当前严重性**：低——
- 小 payload（bind/unbind/enroll 返回都 <300 字节）通常一次 chunk
- C1 已让 bindOk/unbindOk 容忍 undefined，触发后只是输出 `Claw (unknown) ...`，不再 crash
- 但 `setApiKey` 的 `apiKeySetOk({ provider, profileId: data?.profileId ?? '${provider}:default' })` 等其它 CLI 已经用 optional chain 兜底

**预存性**：与 Phase B 改 wrap 字段名无关，是 helper 自身的 chunk 边界处理设计缺陷，旧版同存在。

**2026-05-16 Phase D 失败尝试**（已回退）：曾以"推迟 `parseResult` 到 grace timer fire 时"修复（commit `e981fd3`），红测覆盖 nested 假闭合场景验证通过。但事后周边分析发现场景 E 退化——"chunk1 完整 JSON + chunk2 在 grace 内追加 stdout"（OpenClaw 子进程 WS 心跳 log / grace shutdown 提示等若落 stdout 即触发）原本由"快照锁定"返回成功 payload，修后变成 timer fire 时用被污染的 stdout 解析、落非 JSON 兜底丢失 payload。已回退该修复（.js 改动 + 红测 + 对应 changeset）。

**修复方向**（按周边影响排序）：

- **推荐**：在 startsWith/endsWith 触发 `startGracePeriod` 时**先尝试 `JSON.parse(stdout)`**，仅解析成功时启动 grace timer 并**钉死 snapshot**；失败则不启动 timer、等更多 chunk。此修法对全部 A/B/C/D/E 场景都不差于原行为，且顺手闭合"nested 假闭合 + chunk 在 grace 期外才到"边缘
- **不推荐**：推迟 `parseResult` 调用到 grace timer fire 时（已尝试 + 回退，详见上面失败尝试段）
- **不推荐**：移除早判、纯靠 `child.on('close')` 触发 `parseResult`——会让"永不优雅退出的子进程"等到总超时 10s 才返回结果，破坏 helper 当初引入 grace 期的设计意图

**实施前提**：写测试时务必同时覆盖场景 C（nested 假闭合 + grace 内补全）与场景 E（完整 JSON + 后续 chunk 追加），防止再次单面修法。

---

## chat-history 双源归档 follow-up F1：topic 模式与上游 sessions 体系的实际关系

**发现日期**：2026-05-17（第三轮 review 用户问询）→ 2026-05-17 二次调研修正
**关联**：`plugins/openclaw/index.js#handleSessionCreated` 的早返 guard、`plugins/openclaw/src/realtime-bridge.js` sessions.changed 分支

**原命题**（已被推翻一半）：topic 模式（`agent({ sessionId: <uuid> })` 不传 sessionKey）时 OpenClaw 完全不写 sessions.json、不 fire session_start、不 emit 任何 sessions.changed。

**调研结论**（精确到上游源码行）：

| 子命题 | 实际真相 | 上游锚点 |
|---|---|---|
| 不写 sessions.json | ❌ 不成立 | 内层 runner 在 `agents/command/session.ts:277-282` 用 `buildExplicitSessionIdSessionKey` 把 sessionId 伪造成 `agent:<agentId>:explicit:<sessionId>`，跑完后 `agent-command.ts:1241-1262` 走 updateSessionStore 写进 sessions.json |
| 不 fire session_start hook | ✅ 成立 | `emitGatewaySessionStartPluginHook` 在 agent.ts 全文无调用，仅 `session-reset-service.ts:680` + `sessions.ts:1326` 触发 |
| 不 emit sessions.changed | ❌ 部分不成立 | gateway 层 reason=create/send 守卫 `requestedSessionKey` 严，topic 跳过；但 transcript-update 链路（`config/sessions/transcript.ts:316` → `server-session-events.ts:107,153-165`）仍发 `sessions.changed { phase: "message" }` 事件，**无 reason 字段** |

**澄清 CoClaw 自身有没有"fake sessionKey"**：
- UI `ui/src/stores/chat.store.js:607-611`：topic 模式只设 `agentParams.sessionId`，**不设 sessionKey**（grep 全仓未找到任何 fake sessionKey 概念）
- UI→plugin 现走 WebRTC DC 直通（不经 server；server `claw-ws-hub.js` 那条 forwardToClaw 链路是废弃旧路），plugin 端拿到的 params 与 UI 发出时一致
- Plugin topic-manager 不参与 agent RPC 调用，只管 topic 元信息
- 所以 `agent:<id>:explicit:<sessionId>` 是**上游内层 runner 自造**的，CoClaw 全链路看不到（也不该看到）

**对 plugin 自身的影响**：**无**。两条防线刚好都挡得住：
- hook 路径：上游不 fire session_start，plugin 收不到
- sessions.changed 路径：plugin 在 `realtime-bridge.js:875` 严格判 `reason === 'create'`，topic 的 transcript-update 没 reason 字段，被过滤掉

**外溢副作用**（plugin 改不了，归上游设计）：
1. OpenClaw 自家 sessions.json + sessions list（webchat/dashboard）会被 topic 的 `agent:*:explicit:*` 历史 entries 占位污染
2. 上游 `sessions.changed` 事件复用同一频道发 `phase=message` 但**不带 reason 字段**——区分 reason 类型只能靠 reason 是否存在

**关于 explicit sessionKey 行为的引入时间**（2026-05-17 git archaeology）：

| 项 | 值 |
|---|---|
| 引入 commit | `cd36ff7483`（`fix: resume explicit session-id agent runs`，Peter Steinberger） |
| 日期 | 2026-04-04 |
| 首个含此 commit 的上游 tag | `v2026.4.5` |
| 动机 | 让 `openclaw agent --session-id <uuid>` 跑完后**能再次 resume 同一 sessionId**——必须有一个稳定 sessionKey 才能 store-and-lookup |
| 引入前行为（v2026.4.5 之前） | `agents/command/session.ts:149` 父节点版本：sessionId-only 时 `sessionKey=undefined`，下游 `agent-command.ts:540` 写盘守卫 `if (sessionStore && sessionKey)` 直接跳过——**sessions.json 不写** |
| caller opt-out | **无**——grep `persistExplicit` / `skipExplicitPersist` / `ephemeral.*session` 全无命中；`updateSessionStoreAfterAgentRun` 也无 opt-out 参数 |
| 兜底机制 | 通用 `session.maintenance.pruneAfter`（默认 30 天）+ `maxEntries`（默认 500），见 `src/config/sessions/store-maintenance.ts:20-21`；cron `session-reaper.ts` 执行。**不针对 explicit** |

**用户回忆得到验证**：CoClaw 最初支持 topic 时（早于 2026-04-04），sessions.json 不会因 topic 流量膨胀。当前 gateway 2026.5.7 已带 explicit 逻辑，且上游没开 caller flag 让外部 plugin 关掉。

**膨胀风险评估**：
- 重度 topic 用户：每 topic 一条 entry，长期累积；通用 maxEntries=500 触顶后 LRU 裁剪，不会无界膨胀，但 entry 周转会让"老 topic 突然恢复不出来"
- 轻度 topic 用户：30 天 prune 兜底足够

**可能的根治方向**（按代价从低到高）：
- (A) **等上游加 opt-out**：去上游提 issue / PR，给 agent RPC 加 `persistExplicit: false` 或类似 flag —— 受益面广，但周期长
- (B) **CoClaw 端调小 maintenance 上限**：通过 OpenClaw config 把 `session.maintenance.maxEntries` 压到更小（如 50）—— 治标但会牵连所有 session，可能误伤
- (C) **CoClaw 自管 topic transcript**：放弃用 OpenClaw 的 sessionId 体系驱动 topic transcript 写入，plugin 自己维护 topic .jsonl 不调上游 agent RPC —— 重构成本高，且失去上游 model 调用便利
- (D) **被动接受现状**：上游兜底机制能 capping，UX 上"老 topic 续不上"接受为已知行为

**待办**：
- [x] 此节内容并入 task #11 上游 issue 草稿（已记录在本 TODO 节）

**待办**：
- [x] CLI 实验交叉验证（2026-05-17）——结果完全命中预期：chat-history.json sha256 不变；sessions.json 新增 `agent:main:explicit:d623247e-4d48-4e0c-84ef-f79b1461d966` entry（71→72）；plugin 日志无 chat-history.missing-keys 或任何 handleSessionsCreated（旧名，5125818 重命名前的实验日志，现名 handleSessionCreated）相关 warn（reason='create' 严判完全静默 phase=message 流量）
- [x] 上述两个外溢副作用纳入上游 issue 草稿（2026-05-23）——草稿写在 `docs/upstream-issues/explicit-session-key-opt-out.md` + `docs/upstream-issues/sessions-changed-message-reason-field.md`（整目录 gitignored，draft-only 约定见该目录 README）；提交 GitHub 后登记到 `docs/openclaw-upstream-issues.md` 并删除本地草稿
- [ ] 多 agent topic 启用后复评：F1 实验只钉死了"main agent topic 路径不破"，若 CoClaw 解开 UI `chat.store.js` topicMode 分支让非 main agent 也能新建 topic（参考 `docs/decisions/topic-main-agent-constraint.md` §"2026-05-17 重评"），需要复跑实验验证非 main agent 的 explicit fake sessionKey 路径同样不撞穿 `reason === 'create'` 严判，并核查 chat-history 桶不被污染

---

## chat-history 双源归档 follow-up F2：核实 agent sessions 目录判定的覆盖配置

**发现日期**：2026-05-17（第三轮 review 用户问询）→ 2026-05-17 二次调研修正
**关联**：`plugins/openclaw/src/claw-paths.js`

**原命题**（已被推翻一半）：CoClaw 没接住 `agents.<id>.store` / `entry.sessionFile` 两个覆盖入口。

**调研结论**（精确到上游 schema）：

- **`agents.<id>.store` 字段根本不存在**——`openclaw-repo/src/config/zod-schema.agent-runtime.ts:889-961` 的 `AgentEntrySchema` 里没有 `store` 字段；之前的 follow-up 描述把这个字段当真存在，是认错对象
- 真正的旋钮是顶层 **`session.store`**（`zod-schema.session.ts:54` 定义为 `z.string().optional()`），支持绝对路径或 `{agentId}` 模板替换
- 另一个旋钮是 sessions-index **`entry.sessionFile`**（每 sessionsKey 单独覆盖文件名）
- `claw-paths.js:53` 调上游 `resolveStorePath(store, { agentId })` 时 store 写死 `undefined`，没接住顶层 `session.store`
- `session-manager/manager.js:187` 调 `resolveTranscriptPath(sid, agentId)` 时也漏传 entry，没接住 `entry.sessionFile`
- 上游 runtime API `rt.config.current()`（`types-core.ts:145-148`）已暴露读 `OpenClawConfig.session.store` 的能力，修补不缺 API

**影响范围**：仅当用户在 OpenClaw 配置里显式设置 `session.store` 把存储位置改到非默认目录时，CoClaw 自管文件（`coclaw-chat-history.json` / `coclaw-topics.json`）会落到默认 `<state-dir>/agents/<id>/sessions/`，OpenClaw 自家的 `sessions.json` / 单 session jsonl 落到用户指定位置——两边分家。

**严重性**：低——绝大多数用户走 OpenClaw 默认布局；上游也很少有人配 `session.store`。

**决策**：用户拍板"只记 TODO 暂不修"。

**未来修补方向**：
- `claw-paths.js` 的 `sessionStorePath` 读 `rt.config.current()?.session?.store` 喂 helper
- `session-manager.resolveTranscriptFile` 从 sessions.json 读出 entry 后透传 `entry.sessionFile`
- 加多 profile / 容器场景的 fixture 测试

**注**：AGENTS.md L29 措辞已修正，把 `agents.<id>.store` 改成顶层 `session.store` 并明确标注上游 schema 里没有 `agents.<id>.store` 字段。

---

## chat-history follow-up F4：cron / 其它非 main 形态的产品语义（待斟酌）

**发现日期**：2026-05-18 F3 调研附带（`openclaw-repo/src/sessions/session-key-utils.ts:58-64` `isCronSessionKey`）

**事实**：调研 F3 时发现 OpenClaw 现网除 `:subagent:` / `:explicit:` 之外还存在 `:cron:` 形态（定时任务）。chat-history 当前只挡 explicit / subagent，cron 形态会按普通 chat 入档。

**为什么暂不处理**：cron 形态本质属于"用户人机对话流"（用户配置的定时任务产生的对话），未来 UI 可能要展示这类 chat history。F3 用户原话："对于 cron，暂时也不过滤，这块再斟酌。毕竟也许以后也要展示 cron 这个 chat 的 history。"

**何时需要复评**：

- 若发现 cron 跑很高频导致 chat-history 文件无界增长（类似 F3 闭环前 subagent 的症状）
- 若 OpenClaw 给 cron sessionKey 也加了类似 subagent 的"创建但永不归档"语义，使得未归档头永久滞留
- 若 CoClaw 决定明确"chat-history 只索引用户主动发起的对话"，把 cron / IM 等程序起的也排除

**关联**：`plugins/openclaw/index.js#handleSessionCreated`（守卫位置）+ `openclaw-repo/src/sessions/session-key-utils.ts:58-64`（cron 形态判定参考）

## chat-history follow-up F5：register(mode='full') 热重载下两个 race 隐患

**发现日期**：2026-05-18（任务 #13 opus subagent 调研识别）
**关联 commit**：F3 后续主线验证调研

**背景**：OpenClaw config 热重载（任何 `plugins.*` 配置变更）会在**同进程内**重新走 plugin `register(mode='full')` 流程：
- 入口：`openclaw-repo/src/gateway/config-reload-plan.ts:123` `{ prefix:"plugins", kind:"hot", actions:["reload-plugins"…] }`
- 调度：`server-reload-handlers.ts:281-307` → `server.impl.ts:1131-1227 reloadAttachedGatewayPlugins`（旧 service stop → 新 register → 新 service start）
- loader：`plugins/loader.ts:2363-2368` cache miss → 重跑 `runPluginRegisterSync`

**正常路径安全**：`api.on` / `registerGatewayMethod` / `registerChannel` 走 `replaceAttachedPluginRuntime` 整体替换 registry；`registerService` 显式 `previousPluginServices.stop()` 在前；`realtime-bridge` 模块级 singleton 由 stop() 清空、新 start() 重建——无双实例并存。

**隐患 A — In-flight enroll 跨 reload 残留**：

`coclaw.enroll` / `/coclaw enroll` 的 `waitForClaimAndSave` 是 fire-and-forget 后台任务，闭包持有旧 register 时的 `restartBridge`（仍调模块级 `restartRealtimeBridge`）。reload 时只清新闭包里的 `activeEnrollAbort`；旧闭包仍在跑，认领回来后会把新 register 刚装好的 bridge 杀掉重起，且 `pluginConfig.serverUrl` 是旧 snapshot。

**修复方向**：enroll 闭包检测自身是否仍是 active 闭包（如比对 registration generation token），失活则放弃 restartBridge；或 reload 时显式 abort 所有 in-flight enroll 任务。

**隐患 B — 同源 JSON 文件 per-instance mutex 不互斥**：

reload 瞬间旧 register 的 RPC handler 可能仍在写 `coclaw-topics.json` / `coclaw-chat-history.json`；新 register 同时也能写。两份 manager 各自一套 `__mutexes`，互不相通。`atomicWriteJsonFile` 防半截写，但仍可能整段 JSON lost-update（旧 read → 新 read → 旧 write → 新 write 序列下旧 write 覆盖新内容）。

**修复方向**：mutex 改为基于文件路径的全进程级注册表（同路径不同实例共享同一把锁）；或所有 read-modify-write 改用 `flock` 文件锁；或 reload 时显式 await 所有 in-flight RPC handler。

**严重性**：低——用户主动改 `plugins.*` 配置且改的时机正好撞上 enroll / RPC handler in-flight 才会复现，极偶发。不阻塞当前发布。

## getById 大文件一次性 readFile + 全量解析的内存/CPU 压力

**发现日期**：2026-05-19（getById fallback + 上限修复 deep review 综合实例识别）
**关联 commit**：fix(openclaw-plugin): include .deleted archives in getById fallback and lift 500-message cap

**问题**：`src/session-manager/manager.js` `getById` 拿掉 500 上限后，对几千条消息的长 transcript（可能数十 MB JSONL），`readTranscriptText` 用 `fsp.readFile` 一次性把整个文件读进内存，再 `iterTextLines` 逐行 JSON.parse 出 `messages` 数组，最后才（在传了正 limit 时）`slice(-N)`。即便调用方只想要尾部 N 条，也得先把整个文件 parse 完——内存峰值与 transcript 大小成正比，CPU 上也是无效解析。`iterTextLines` 有 `setImmediate` 让步避免单次 freeze event loop，但累计仍可能拖慢 gateway。

**为什么本期未修**：本次任务 scope 只在去掉 500 上限和 fallback 拓宽。UI 主要痛点已记在 `ui/TODO.md` 同名条目；plugin 侧优化是 UI 选了"传正 limit"路径后才能省的事。

**修复方向**：

- 在 `getById` 检测到 `useLimit === true` 时走"tail-only"分支：从文件末尾分块（如 64KB）反向读，扫到 `limitNum + 1` 条 message 行后停止解析。需要小心处理 CRLF / 跨块行边界。
- 或更激进：JSONL 按行落盘天然支持 tail，用 `fs.read(fd, ...)` + 自己的 line buffer 实现真正的"读够 N 条就停"。
- 暂不动 `get`，因为它走 `cursor + limit` 分页，行为差异更大。

## chat-history 双源乱序 A→B→C race：stale 防御吞掉中间段的归档信号（红测已 skip）

**发现日期**：2026-05-19（cron 顶替止血任务实施前 dump 整理）
**关联**：`plugins/openclaw/src/chat-history-manager/manager.test.js` 末尾 REPRO_LOST_ARCHIVED 用例（已 `{ skip: ... }`）

**现象**：在 A→B→C 三跳快速连翻的极端时序下（两条 `sessions.changed` 先到、两条 `session_start` hook 后到），第三条到达的 hook (current=B, archived=A) 因 currentSessionId 已不再是 list head，命中 `recordSessionTransition` 内的 stale 防御直接 return，**A 这一段从未被任何写盘路径记录**，永久缺失。段 A 的唯一来源是那条被吞 hook 的 `resumedFrom`（一次性事件、不回放）；`reconcileAll`（只喂 sessions.json 当前 head 且从不传 archived）、`__sanitizeAllSessionKeys`（只给已存在项补 archivedAt）、重启均补不回——不自愈。丢的是历史列表里的一段**指针**，A 的 transcript 正文文件本身未被删。

**为什么本期未修**：cron 顶替止血只覆盖 user A → cron B 单跳场景（现有"老 head 翻 archived + 新 sid unshift"路径正常工作）；A→B→C 三跳是更深层、独立于 cron 路径的双源 race，修法要重新设计 stale 判定 + 归档信号的去重链路，工作量与 cron 止血不在同一量级。

**修复方向**：让 stale 防御在 `archivedSessionId` 信号上下文中至少补登被漏归档的中间段（即便 head 已翻过）；可能需要在到达 `recordSessionTransition` 时合并 sessions.changed 与 hook 的乱序事件流，而不是直接 return。

**修复障碍（T14 语义冲突）**：naive fix（stale 分支不直接 return、而是把 `archivedSessionId` 插进 list）会**直接撞翻 T14 测试**（`manager.test.js:300`）——T14 的 stale 事件同样带 `archivedSessionId`，却断言"整体丢弃、该 archived 不入、不写盘"，与 REPRO 的期望正好相反。两条测试对同一代码路径编码了矛盾期望，从 `recordSessionTransition` 即时入参根本分不出哪个该补哪个该丢。根治必须先裁定"stale 事件的 archived 载荷是否回填"的规范语义并重写或废掉 T14，不是改几行。

**复测**：根因修复后 `unskip` 测试 `recordSessionTransition - REPRO 双源乱序：A→B→C ...`，期望 list = [C, B@arch, A@arch]。

**严重性**：低——需要极端时序（毫秒级三跳 + 双源到达顺序倒置）才触发。"生产未观察到实例"背后是近乎不可达：reset 路径只发 session_start hook（有序不串）；agent.send 只发 sessions.changed（不带 archived）；唯一能双发的 sessions.create 通常又没有 resumedFrom——标准触发器几乎构造不出此交错时序；红测是直接调 `recordSessionTransition` 人为摆顺序绕过了可达性问题。红测仅作为根因修复的 fixture 保留。

## chat-history 启动期对账快照与并发事件路径的时序假设

**发现日期**：2026-05-19（cron 顶替止血 deep review codex-rescue 多实例点出）
**关联**：`plugins/openclaw/index.js` 启动期对账链 `chatHistoryManager.load → manager.listAllEntries → chatHistoryManager.reconcileAll`

**问题**：启动期对账是 fire-and-forget 的 Promise 链，`listAllEntries` 拿到的 entries 是某一刻的 sessions.json 快照。若在 reconcileAll 真正执行某条 entry 之前，事件路径（cron_changed hook / phase=message）已经为同一 sessionKey 写入了更新的 sid，reconcileAll 用旧快照走 `recordSessionTransition`，理论上可能把"已被事件正确归档的新 head"再次翻档。

**为什么本期未修**：实际触发难度极高——启动对账几乎与 register 同步发起；事件路径需要 gateway WS 握手完成后才能传到 plugin。在用户笔记本上的 systemd 常驻 gateway 场景里，握手在启动后才能完成，启动对账几乎肯定先于任何事件到达。`recordSessionTransition` 内部已 `__reloadFromDisk` + mutex 串行化，能吞掉多数 race；只有一种极端时序（启动对账 stage-2 已读 sessions.json 但 stage-3 还没拿到 mutex 期间，事件路径完成了一次 reset）才会触发，至今未观察到实例。

**修复方向**：reconcileAll 内每条写前再次 reload 磁盘，对比 entry.sessionId 与磁盘 head sid——磁盘 head 已是更新的（未归档）状态时跳过本条让事件路径赢。

**严重性**：低——理论盲点；触发难度高；recordSessionTransition 现有 reload+mutex 已吞掉多数 race。

## chat-history classifyChatHistorySessionKey 是黑名单策略（未来新 sessionKey 形态默认入档）

**发现日期**：2026-05-19（cron 顶替止血 deep review 第二轮 codex-rescue 提出）
**关联**：`plugins/openclaw/src/chat-history-manager/manager.js` `classifyChatHistorySessionKey`

**问题**：helper 用黑名单（explicit / subagent / cron）判定跳过，其他形态默认 `ok=true` 进 chat-history。若上游未来新增 `agent:<id>:debug:*` / `agent:<id>:replay:*` / 其它新 segment，会无声入档污染 chat-history。

**为什么本期未修**：黑名单策略对当前已知形态准确；改成白名单需要枚举所有合法 chat sessionKey 段（`main` / 用户自定义 channel 等），过度设计风险高于当前价值。属于"识别到才说"。

**修复方向**：上游确实加新 segment 形态时，及时把它加入黑名单（一行改动）。若上游频繁演进 segment 词表，考虑迁移到白名单 + 默认拒绝策略。

**严重性**：低——需要上游主动加新形态才会触发；可观测信号有 `chat-history.skip-*` 缺失。

## providerAuth.list 返回原始 provider 拼写，未做上游别名归一化，UI 端 === 比对误判别名服务商

**发现日期**：2026-05-26（model-config 发版前 deep-review 识别）
**关联**：问题出在 UI 端比对（`ui/src/stores/dashboard.store.js` `computePrimaryEffective` / `ui/src/views/ModelConfigPage.vue` / `ui/src/components/model-config/PrimaryModelPickerDialog.vue`），但更干净的修法落在插件侧 `plugins/openclaw/src/provider-auth/handlers.js` 的 `list` handler。

**问题**：CoClaw 把两份 OpenClaw 出参在前端用 `===` 直接比 provider 名：
- `models.list view:'all'` 出参的 `provider` 是注册表规范名（只小写、不折叠别名），如 `moonshot`；
- `coclaw.providerAuth.list` 出参的 `provider` 是**存进去时的原始拼写**（`buildApiKeyCredential` 不动 provider、`toListEntry` 原样返回 `cred.provider`），如外部用 `moonshotai` 配的就是 `moonshotai`。

OpenClaw 自己从不踩坑，因为它每次比对前都先 `normalizeProviderId`（`openclaw-repo/src/agents/provider-id.ts`：`moonshotai→moonshot`、`modelstudio/qwencloud→qwen`、`z.ai→zai` 等）折叠别名 + 小写。CoClaw 前端复制了读写、漏了这步归一化，于是两份未对齐的原始拼写硬比 → 主模型被误报"失效"（橙条）、picker 里看不到该 provider 的模型。

**影响**：很窄。只在该 provider 是**绕开 CoClaw 界面**（`openclaw` onboard 命令 / 手改 auth-profiles / 外部 CLI 导入）用别名形或非规范大小写配置时才触发。通过 CoClaw 界面添加时，发出去的 provider 名取自 catalog 规范名（`AddProviderDialog` 可选列表来自 catalog 的 `m.provider`，`provider-meta.js` 也只有规范的 `moonshot` 无 `moonshotai`），存进去 = 规范名 = 与 catalog 一致，永不触发。无数据损坏、不崩、不影响其它 provider。

**2026-06-22 复核：两个症状已被 model.list/listAvailable 别名感知重构架空（症状休眠，根因仍在）**。橙条改吃 `coclaw.model.list` 的 `hasAnyUsableCredential`/`default.providerUsable`（`ui/src/stores/dashboard.store.js:298-299`）+ `listAvailable.byProvider`（`ui/src/views/ModelConfigPage.vue:268-284,358`），picker 改吃 `listAvailable.byProvider`（`PrimaryModelPickerDialog.vue:172,181-196`），`providerAuth.list` 现仅喂纯展示的 `ProviderAuthRow`（`ModelConfigPage.vue:119-125`）、无 `===` 误判。**根因仍在**——`handlers.js` list 三源（账本 `:169-171`/内联 `:688-691`/env `:715-729`）原样透传不归一，仅 catalog 路径归一（`:594-602`）。故降级为备忘：当前无活跃有害消费者，若 UI 日后再以 `providerAuth.list` 的 provider 做语义判断会复活；修法 B（list 出参侧归一）仍是正解。

**为什么发版前不修**：
- 修法 A（前端复刻上游别名映射表，比对前先折叠）会让前端持有一份与上游可能脱节的映射，上游新增别名时无声错位；临发版加投机性复杂度不划算。
- 修法 B（插件侧在 `list` handler 返回前用上游自己的归一化函数把 `cred.provider` 折叠成规范名再给前端）更干净——映射只在上游一份、前端保持简单。但前提是 plugin-sdk 暴露了 `normalizeProviderId`（待核实；当前插件未 import 该函数），且仍是跨工作区的发版前改动。

**修复方向**：优先走修法 B——先核实 `openclaw/plugin-sdk` 是否暴露 `normalizeProviderId`（或等价 `normalizeProviderIdForAuth`）；若暴露，在 `provider-auth/handlers.js` `list` 的 `toListEntry` 出参处把 `provider` 归一化，并同步给 UI 一条"profiles[].provider 已规范化"的契约说明。若 SDK 未暴露，再评估前端兜底或推动上游导出。

## MiniMax OAuth：global 区域登录流未真机验证

**发现日期**：2026-05-26（MiniMax OAuth e2e 验证时识别）
**关联**：`plugins/openclaw/src/provider-auth/minimax-oauth.js`（`createOAuthHandler` 路径）

**背景**：设备码登录流仅 cn 区域实地跑通（真账号扫码、令牌落盘、配置热更、零重启全验过）。global 走相同代码、不同 baseUrl，机制一致但端点行为/响应未实测。拿到 global 账号时跑一遍同款 e2e（`scripts/oauth-e2e-verify.sh` 改 region 即可）。

**模型清单已与 REST 解耦**：模型清单现取自内置静态表（`portal-model-catalog.js`），登录写一次 + 启动对账同步，cn/global 同款两个模型，不再有 region 相关的 `/models` 端点行为差异。详见 `docs/model-config-api.md` § 2.3.7。

## MiniMax OAuth：登录写凭据成功但写配置失败会留半残绑定（预存）

**发现日期**：2026-05-27（方案 B deep-review 时识别，非本次引入）
**关联**：`plugins/openclaw/src/provider-auth/handlers.js` `persistOAuthSuccess`（写凭据 → 写配置两步）

**根因初判**：登录成功先 `upsertAuthProfileWithLock` 写 OAuth 凭据，再 `mutateConfigFile` 写 provider 节点。若凭据写成而配置写失败（磁盘/锁/校验），凭据留在 auth store 但 config 里没有 `models.providers.minimax-portal` 节点。启动对账遇"无节点"判 `not-bound` 直接跳过、自愈不了——模型对用户不可用，直到重新扫码登录覆盖。`providerAuth.list` 仍能看到这条 oauth profile，外观像"绑了但选不到模型"。

**为什么暂不立刻修**：两步写盘的顺序与本次方案 B 无关（方案 B 只把写入的 `models` 从 `[]` 换成静态表）；重新登录即可恢复，发生概率低（写配置失败本就罕见）。治本需让对账在"有凭据但无节点"时补建节点（即把 `not-bound` 细分出"凭据在、节点缺"分支并 create-on-reconcile），属功能增强而非缺陷修复，单独评估。

## 通用设备码登录（B1）deep-review 留存项（4 条，2026-05-27）

**发现日期**：2026-05-27（B1 插件后端 deep-review 时识别）
**关联**：`plugins/openclaw/src/provider-auth/index.js` + `handlers.js` + `device-code-login.js` + `utils/deep-merge.js`

本轮 deep-review 核实到、按"仅修本次引入的明确缺陷 + 不过度设计"原则暂未一并修的 4 条。codex/copilot 当前两家均不触发，均为**面向未来任意 device_code provider 的健壮性**或**预存模式一致性**：

1. **SDK 子入口 import 失败被永久缓存（预存模式，非本次新增）**：`provider-catalog-runtime` 的惰性加载用 `??=` 缓存 import promise；若该 import 一次 reject（如插件升级窗口的瞬时 fs/loader 抖动），rejected promise 留缓存，之后所有通用设备码登录都拿到 IO_FAILED 直到 gateway 重启。这与既有 `_sdkPromise` / `_configMutationPromise` 同款——治本应**统一**给三个 loader 加"reject 时清空缓存允许下次重试"，而非只补新加的这个（避免不一致）。不崩 gateway，仅单个 RPC 退化，且静态 import 失败多为非瞬时（包在/不在），故低优先。

2. **取消后上游后台轮询仍跑到自然到期（设计取舍，非缺陷）**：`run(ctx)` 无 abort 钩子，`cancelOauth` 只翻本地标志，上游轮询继续到设备码过期（约 15 分钟）才停。反复"取消→重试"会累积僵尸轮询。本通道刻意不强停（终态必达 + 清理）。若要收口，**在 UI 那轮**加客户端重试节流 / 每 provider 在途登录上限，比插件侧强停更合适。

3. **`makeDeviceCodeCtx` 的 `runtime.exit` 是空操作（面向未来的隐患）**：codex/copilot 的 device_code run 都不调 `runtime.exit`，今天安全。但未来若有 provider 用 `runtime.exit` 表达致命错误，空操作会让 run 继续往下跑、可能 resolve 出垃圾。可考虑让 `runtime.exit` 抛错（与 ctx 里 text/select 被调即抛同philosophy），使其落进 `OAUTH_FAILED`——但有反向风险（某 provider 成功后良性 `exit(0)` 会被误判失败），故先观察、接入新 device_code provider 时再定。

4. **note 解析 + configPatch 合并对"任意未来 provider"的健壮性（今天安全，未对齐上游）**：
   - `extractVerification`：无 `Code:` 行时 `DEVICE_CODE_RE` 扫全文（含 URL），理论上可能从 URL 里抠错码；裸 URL 回退 `[^\s)]+` 可能带上尾随标点。codex/copilot 都有显式 `URL:`/`Code:` 行不触发。硬化方向：码回退前先剥掉文中 URL；URL 捕获后剪尾随 `.,;:`。
   - `isVerificationNote`：靠 `faq|help|trouble|docs.openclaw` 英文词排除帮助 note。未来某 provider 的真验证 note 若 URL 路径含 `help` 等词，会被误判非验证 note → phase-1 不发、URL 不展示。今天两家 note 无此词。
   - `deepMergeInto` vs 上游 `mergeConfigPatch`：上游额外（a）递归净化数组元素内的原型污染键；（b）合并后跑 `normalizeConfigModelRefsForWrite` 规范化模型别名。本实现都没做。今天不咬人——codex 的 configPatch 是不含数组/别名的 plain `agents.defaults.models` 对象，copilot 无 configPatch。接入会下发数组/别名 configPatch 的 provider 前补齐。

## 返回 session 正文时区分"文件没了"与"其他情况"

**发现日期**：2026-05-28
**关联**：`plugins/openclaw/src/session-manager/manager.js` `getById`（及同款 `get`）；UI 侧 commit `9a41b718`（空归档段占位）

**现状**：`getById` 把多种"取不到正文"的情形塌缩成同一个返回形状，调用方分不清：
- transcript 文件不存在（`resolveTranscriptFile` → null）→ `{ messages: [] }`
- 文件在、但没有 `type==='message'` 且有 role 的可显示行 → 也是 `{ messages: [] }`
- 单行 JSON 损坏 → `bad json line skipped` 打 warn 后**跳过**，悄悄少消息 / 退化成空
- （真正的读盘 IO 错误目前会抛出，由 RPC 层暴露——这一类已可区分）

**后果**：UI 拿到空数组只能统一按"正文已不可用"显示中性占位（已实现），无法对不同成因分别处置——例如"文件确实没了"才提示"已不可恢复"、"读取/解析出错"提示"稍后重试"、"文件在但本就无可显示内容"或许不该当成丢失。最核心的盲区是**分不清 session 文件是真没了，还是别的原因取不到**。

**修复方向**：让返回 session 正文的 RPC 带一个明确的状态信号，至少把"文件没了"单独标出来。可选形状：
- `{ messages: [], status: 'missing' | 'empty' | 'partial' }`，或简单点 `{ messages: [], missing: true }`
- `missing`：`resolveTranscriptFile` 返回 null（裸名 / `.reset.` / `.deleted.` 变体全无）
- `empty`：文件在、解析正常但无可显示消息
- `partial`：有行被 `bad json` 跳过（可带跳过计数），提示正文可能不完整
- 读盘 IO 错误维持抛出（不要吞成空），让调用方能区分"取不到"与"出错"

**范围**：跨 UI + plugin（plugin 加信号 + UI 消费做精确文案），需双 changeset。属健壮性增强，**低优先、非阻塞**——当前 UI 中性"已不可用"文案已覆盖主场景（真没正文）。实施时 UI 侧把占位文案按 status 细分（见 ui 工作区对应改造）。

## 2026-06-11 auto-upgrade 摆脱账本改造记 TODO 不修的预存/残余问题

**发现日期**：2026-06-11（设计稿 `docs/designs/auto-upgrade-ledger-free-gate.md` 残余风险节 + 实施 review）
**关联**：`src/auto-upgrade/`、`scripts/_lib.sh`。均不阻塞、独立可修；state.js 无锁 read-modify-write 一条并入上方既有条目"auto-upgrade state read-modify-write 缺跨进程互斥"的 2026-06-11 注记，不在此重复。

### 托管布局回滚后"新依赖+旧代码"混搭风险

备份只覆盖插件目录本身；托管布局下依赖树可能由 npm 在插件目录之外统一管理，mv 回旧代码后依赖仍是新版安装时改写的状态，形成"新依赖+旧代码"混搭。同族限制：布局迁移场景（老布局升级 → record 指新托管路径）回滚不完美——备份的是旧实体、record 已指新处（`worker-verify.js` 头注释已有记述）。

## 2026-06-11 auto-upgrade 升级链修复 follow-up（不阻塞发版）

**发现日期**：2026-06-11（升级链缺陷修复方案评审收尾时商定；缺陷修复本体随同期 commit 落地、不在此留账，实测细节见 git 历史与 `tmp/upgrade-verify-20260611/` 留档）
**关联**：`src/auto-upgrade/`、`docs/auto-upgrade.md`。

### 非 prerelease 成因的持久性 update 失败每周期循环（policy/integrity/engines 等）

持久性 update 失败（registry policy 拒装、integrity 校验失败、engines 不满足等）按瞬态语义不写 skipVersion，每周期重复"失败→回滚→重启网关"。本次修复**有意不动**：失败时乱写 skip 会把网络抖动等真瞬态失败误伤成永久跳过，v3.1 评审砍掉重试计数器是同一判断。错因富化后 upgrade-log/lastUpgrade.error 已可见真因，循环周期 1h 可观测。候选解法是未来的有界重试 / 失败分类议题。同族推论——"磁盘新、运行旧"悬置态：worker 死于 update 阶段（磁盘已写新版）且网关未重启时，对账补记 interrupted 后 checkForUpdate 读磁盘判"无更新"，新版本等下次自然重启才激活且无人验证（备份保留，仍可人工回滚）。

### V5：跨平台形态摸底（systemd system service 探针、macOS/Windows restart 行为）

systemd **system service** 变体下 `systemd-run` 探针（无 `--user`）行为未实测——主路径只承诺 user service 推荐形态；macOS / Windows 形态 `openclaw gateway restart` 是否连带杀 detached worker 也未摸底。不阻塞发版：非 systemd 形态不走 scope 分支、行为零改动；探针失败降级=现状 + `upgrade.cgroup-escape-failed` 信号 + inflight 对账兜底。

### lastUpgrade.error 的 500 字符截尾可能截掉真因、只留 stderr 噪音（S4 实测）

**发现日期**：2026-06-11（S4 独立回归实测）。`formatCmdFailure` 拼接顺序 `message | stdout | stderr`，npm 的 404 真因落 stdout 段；本机 openclaw CLI 的 stderr 固定带 proxy-preload / state-migrations 噪音（约 500+ 字符）。远程上报行（`upgrade.result error=...`，`updater.js`）引的正是 `lastUpgrade.error` → 远端看不到真因、只有本地 jsonl 留全文。

**已部分缓解、症状仍在（2026-06-23 复核）**：`formatCmdFailure` 后来改成**双流各取尾部 + 先脱敏**（`worker.js`，`CMD_OUTPUT_TAIL_CHARS=500` 对 message/stdout/stderr 各自 tail 后拼 `prefix: … | stdout: … | stderr: …`），完整复合串原样进 jsonl。但这道改动服务的是脱敏 + 保证两流尾部都进 jsonl，**没碰症状那道截断**——`recordUpgradeTerminal` 仍对复合串再做一次**全局** `slice(-500)`（`state.js` `truncateErrorTail`，`ERROR_MAX_CHARS=500`）写进 `lastUpgrade.error`。stderr 段在复合串**末尾**，本机 stderr 噪音 ≥500 时全局尾-500 整段落在 stderr 内，stdout 的 404（位于复合串中段）仍被切掉。

**判定**：维护期 KEEP（非 STALE、非不可达无害——本机此类升级失败每次命中）。但升级失败本身低频、纯诊断退化、本地 jsonl 留全文可恢复，维护期不主推。**最小修向**（若要恢复远程排障）：`state.js` 一处把 `ERROR_MAX_CHARS` 放宽到能容下已逐段封顶的复合串（每流 ≤500、复合上限 ~1530，取 ~1600），或移除这道二次截断、信任 `formatCmdFailure` 的逐段封顶——代价仅上报行变长。**别**让 `state.js` 去解析 `formatCmdFailure` 的分段格式做段感知截断（耦合 worker.js 字符串格式、得不偿失）。

## pion ICE 网卡过滤黑名单只拦 docker0，TUN 的 utun 伪候选漏网

**发现日期**：2026-06-15（本机配置 sing-box TUN 系统级翻墙分流时发现；预存窄黑名单，非本次造成）
**关联**：`plugins/openclaw/src/webrtc/webrtc-peer.js` pion `SettingEngine.SetInterfaceFilter` 的 `denyPrefixes`

**问题**：`interfaceFilter` 的 `denyPrefixes` 只列了 `['docker0']`（注释自陈是极保守黑名单）。宿主一旦跑 sing-box TUN（或任何 VPN/utun 类工具），会多出 `utun` 虚拟网卡、带私网地址（如 sing-box 默认 `172.19.0.x/30`）。pion 枚举本机网卡时不拦它 → 把这个无用的 utun 地址当 host 候选收进来发给对端。

**影响**：多数情况只是噪音——对端连不上该私网地址，ICE 回落真 LAN/srflx/relay，浪费几次连通性探测。**真隐患**：若**对端也跑同款 sing-box TUN、同一 `172.19` 网段**，可能凑出"伪 ICE pair"误判 P2P 成功（与代码里防 `docker0` 注释所述失败模式同源）。2026-06-15 本机实测：网关侧开 TUN 后 ICE 仍正确 nominate 真 LAN 候选（192.168.0.102），未观测到实际故障——属硬化项不是阻塞 bug。

**为什么不修**：2026-06-15 用户明确暂不动。属预防性硬化。

**修复方向**：把 `'utun'` 加进 `denyPrefixes`（与现有 `docker0` 同模式，一行）；或更通用地按"私网地址的虚拟网卡"过滤。注意 HasPrefix 误杀红线见 `docs/openclaw-research/pion-interface-filter-hasprefix.md`。
