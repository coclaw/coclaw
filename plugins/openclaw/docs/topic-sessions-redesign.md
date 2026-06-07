# Topic 重设计：自管存档 + 非 main agent 支持

> 状态：**草案（Draft）** — 方案已定，关键前提全部真机/源码核实；待实现期确认项见文末。
> 日期：2026-06-06
> 范围：核心机制**仅插件**（`plugins/openclaw`）；非 main 启用需配套**少量 UI** 改动（见 §7，跨模块、改动小）。
> 关联：取代 repo 根 `docs/designs/topic-management.md` 与 `docs/decisions/topic-main-agent-constraint.md` 的"备选方案"章节；上游行为依据见本文 §2。
> 核心术语：**topic = 恰好一个 session**（1:1，自带 sessionId 寻址）；**chat = 某 agent main 通道下所有 session 的集合**。

---

## 1. 要解决的问题

1. **sessions.json 膨胀**：自 OpenClaw v2026.4.5 起，`agent(sessionId)` 不带 sessionKey 时会自动派生并落盘 `agent:<agentId>:explicit:<sessionId>` 条目。每个 topic 一条，随 topic 数增长。
2. **只支持 main agent 的 topic**：早期上游 `agent(sessionId)` 总路由到 main，故 UI 把 topic 锁死在 main。上游约束已解除。
3. **长寿命 topic 的存活**：一个 topic 可能几个月、几年不动，用户随时回来续聊，必须仍能续上、不丢上下文。

---

## 2. 已钉死的上游事实（设计的地基）

| 事实 | 结论 | 核实方式 |
|---|---|---|
| **自带 sessionId 时 reset 结构性失效** | 调用方传 sessionId 时，`isNewSession` 被**强制为 false**，freshness/reset 策略永不把 topic 轮转成新 session；run 永远追加到 `<topicId>.jsonl` | 读源码 `agents/command/session.ts`（sessionId 被原样采用 + isNewSession 公式） |
| **非 main 路由可用** | `agent({sessionId, agentId:<非main>})` 正确落到目标 agent，sessionId 被保留 | 真机实验（对 tester 发起，落 tester 名下） |
| **默认保洁会两阶段删正文** | 默认 `mode=enforce`、`pruneAfter=30d`、`maxEntries=500`。条目超 30 天闲置→**剪索引 + 把 `<topicId>.jsonl` 改名归档 `.jsonl.deleted.<ts>`**；归档自身超 30 天→**`fs.rm` 硬删**（≈第 60 天，不可恢复） | 源码常量 + 执行路径 `config/sessions/store.ts` + 上游集成测试断言 + 真机 fork 复核 |
| **插件能读归档** | `session-manager` 的 `resolveTranscriptFile` 会扫 `.reset.<ts>`/`.deleted.<ts>` 取最新 → 归档窗口（≈30d）内仍读得到 | 读插件源码 + 上游测试 |
| **CoClaw 自家目录免疫保洁** | 保洁只扫各 agent 的 sessions 目录；`pluginDir()`(`<state-dir>/coclaw`) 是另一棵树，够不着 | 读 `claw-paths.js` + 保洁 scope=`dirname(storePath)` |
| **孤儿续聊可重建上下文** | 正文在盘、**零索引条目**时，`agent(sessionId)` 仍读正文、模型完整复述历史，并**自动重建索引条目** | 真机实验（埋暗号→造孤儿→续聊准确复述） |

**关键推论**：reset 不是威胁；真正会弄丢老 topic 的是默认保洁在 ≈60 天的硬删。只要把正文存到 sessions 目录之外、回来时临用临恢复，就彻底免疫。

---

## 3. 核心模型

把一个 topic 看成**由 CoClaw 拥有的对话**，它对 OpenClaw 的唯一硬依赖只是"在指定 agent 上跑、并往一个 transcript 文件追加"。

- **权威存档（canonical）**：CoClaw 自管的镜像，放在 `pluginDir()` 下，免疫一切保洁。**这是 topic 历史的唯一真相来源。**
- **工作副本（working copy）**：OpenClaw sessions 目录里的 `<topicId>.jsonl`，**视为可丢弃**——保洁随便归档/删，CoClaw 不依赖它的持久性。
- **索引条目**：`agent:<agentId>:explicit:<topicId>`，视为**冗余产物**，CoClaw 从不依赖；交给默认保洁自然剪裁即可（剪掉也无害，见 §5/§6）。

---

## 4. 存储方案（"怎么存"）

- **位置**：`pluginDir()/topic-transcripts/<agentId>/<topicId>.jsonl`
  新增唯一解析入口（`claw-paths.js`）：
  - `topicMirrorDir(agentId)` = `join(pluginDir(), 'topic-transcripts', agentId)`
  - `topicMirrorPath(agentId, topicId)` = `join(topicMirrorDir(agentId), topicId + '.jsonl')`
  （工作副本路径继续走 `sessionTranscriptPath(topicId, agentId)`，自动随 OpenClaw 自定义 store 配置走。）
- **格式**：与 OpenClaw transcript **逐字节一致的 JSONL 拷贝**。理由——恢复时要原样写回工作副本让 OpenClaw 当普通 transcript 读，故镜像必须是忠实副本，不做转换。
- **元数据**：仍只用 `coclaw-topics.json`（每 agent 一份，`{topicId, agentId, title, createdAt}`）。镜像路径可由 agentId+topicId 算出，**无需新增字段**。

---

## 5. 自管机制（"怎么管"）

三个原语 + 三个触发点。**所有捕获都是幂等的整文件拷贝**——故"至少一次"即可、重复触发无害，OpenClaw 一次 run 发多次结束信号的去重问题被自然消解。

### 5.1 三个原语

**① 捕获 `captureMirror(agentId, topicId)`：把最新正文折进镜像**
1. `src = resolveTranscriptFile(agentId, topicId)`（OpenClaw 工作副本 live，缺失则取最新 `.deleted.`/`.reset.` 归档）。
2. 若 `src` 是 **live（在盘且非空）** → `mirror := copy(src)` **无条件**（live 是权威，含 compaction 后的最新态）。
3. 若 `src` 是 **归档（live 已不在）** → 仅当归档记录数 **多于** 当前镜像时 `mirror := copy(归档)`（兜住"漏捕获后被归档"的极端；闲置期不发生 run，归档只会单调≥镜像，故安全）。
4. 若 live 与归档都没了（>60d）→ 镜像是唯一幸存者，无操作。

> 用 live/归档分支区分，规避 compaction 的长度歧义：compaction 只在 run 期发生（此时必走 live 分支、无条件覆盖），归档分支永不遇到 compaction。

**② 恢复 `restoreWorkingCopy(agentId, topicId)`：续聊前把工作副本备好**
1. 先 `captureMirror`（确保镜像最新）。
2. 若工作副本 `<topicId>.jsonl` **缺失或空** → `live := copy(mirror)`（原子写）。
   - 活跃期工作副本在盘且 ≥ 镜像，**绝不覆盖**；只在长闲置导致工作副本被归档/删后才恢复。

**③ 读历史 `readTopicTranscript(agentId, topicId)`：getHistory 用**
1. 先 `captureMirror`。
2. 读镜像并解析返回。镜像永远是权威，**绝不读 OpenClaw 的 reset/abandoned 文件**（满足 R4）。

### 5.2 三个触发点

- **周期对账（正确性保证）**：`__pluginInitDone` 里挂一次性 **backfill**（把现有 topic 的 live/归档拷进镜像，纯文件、不跑 agent）+ 低频 **reconcile** 定时（建议 ≤12h，远小于 30d 归档窗口）：遍历所有 agent 的 `coclaw-topics.json`，对每个 topic 跑 `captureMirror`。**无状态、磁盘驱动**（每轮重读 `coclaw-topics.json`），规避 `--link` 双实例缓存陷阱。
- **打开 topic 时（查看新鲜度）**：UI 打开 topic → `coclaw.topics.getHistory`（内部 `readTopicTranscript`，顺带捕获）。
- **续聊前（恢复）**：UI 打开 topic 时调 `coclaw.topics.ensureLive({topicId, agentId})`（内部 `restoreWorkingCopy`）。因为 UI 流程里"先打开再发送"，故 on-open 恢复足够覆盖。

> **为何不强依赖"每次 run 后捕获"**：周期对账（≤12h）+ getHistory 读最新（live/归档/镜像）已保证正确性与新鲜度，且归档窗口给出 ≈30d 富余。每次 run 后即时捕获只是延迟优化，**非必需**（避免改动 bridge 热路径、避免过度设计）。如需即时，可在 bridge 转发链路对"已知 topic 的终态 res"做 fire-and-forget 捕获（须 `.catch()`、不得重排 res 路由）。

### 5.3 安全（项目硬约束）

- 镜像/工作副本写一律走 `atomicWriteFile`（禁裸 `fs.writeFile`）。
- 每 topic 一把 mutex，捕获/恢复的读-改-写在同一 `withLock` 内；`withLock` 返回的 Promise 不 await 必 `.catch()`。
- **绝不直接改 sessions.json**（网关有内存缓存，手改会脏读）。只动 transcript 文件（工作副本 + 镜像）。索引清理（§6 可选）走原生 RPC，不碰文件。
- 路径解析全部经 `claw-paths.js` 唯一入口。

---

## 6. topic 全生命周期（默认配置）

| 阶段 | OpenClaw 侧 | CoClaw 侧 |
|---|---|---|
| 创建 | 无 | `coclaw.topics.create` 记 record，暂无正文/镜像 |
| 首次发送 | run 落 `<topicId>.jsonl` + 索引条目 | reconcile/打开时捕获镜像 |
| 活跃续聊 | 追加工作副本 | 捕获镜像（幂等） |
| 闲置 ≈30d | 索引剪掉 + 工作副本归档 `.deleted.` | 镜像早已持有；归档窗口内仍可对账 |
| 60d 内续聊 | — | `ensureLive` 从镜像恢复工作副本 → run 追加 + 重建索引 |
| 闲置 >60d | 归档被 `fs.rm` 硬删 | **镜像是唯一幸存者** |
| 几年后续聊 | — | `ensureLive` 从镜像恢复 → run 重建上下文（已实测）+ 重建索引 |
| 删除 | （可选清索引条目） | 删 record + unlink 工作副本 + unlink 镜像 |

---

## 7. 四项需求如何满足

- **R1 膨胀**：索引条目每 topic 一条（续聊复用、非每 run 新增），默认保洁 30d/500 自然封顶；镜像在 sessions 目录外、不进 sessions.json。**剪索引对 topic 无害**（§6 恢复机制兜底）。如要近乎零占用：每次 topic run 终态后用原生 `sessions.delete({key, deleteTranscript:false})` 清条目（**可选**，见 §9 待定）。
- **R2 非 main**：topic 的 `agent()` 调用补 `agentId = topic.agentId`；run 落到目标 agent。**配套 UI 改动**（跨模块、小）：
  - `ui/src/stores/chat.store.js` topic 分支：`agentParams.agentId = topic.agentId`；
  - `ui/src/views/ChatPage.vue`：撤 `showNewTopicBtn` 的 main-only 守卫；
  - `ui/src/stores/topics.store.js`：列 topic 不再硬编码 `agentId:'main'`，按当前 agent 查；
  - 插件 `title-gen` 调 `agent()` 时带 `agentId`（且从**镜像**取正文，见下）。
- **R3 长寿命**：镜像免疫一切保洁；续聊前恢复工作副本；孤儿续聊重建上下文（已实测）。与 OpenClaw 对工作副本做什么无关。
- **R4 不暴露成 chat**：`getHistory` 只读镜像（绝不读 abandoned/reset 文件）；现有 chat-history 分类已丢弃 `explicit` 形态；**加固**——分类与 `session-manager.listAll` 都额外排除已知 topicId（防 null-sessionKey/老版本/未来形态变化）。topic 仅经 `coclaw-topics.json` 组织，永不作为 chat 出现。

---

## 8. 标题生成的衔接

`title-gen` / `TopicManager.copyTranscript` 改为从**镜像**拷贝到临时文件再跑 `agent(sessionId=tempId, agentId)`：既读到权威正文、又路由到正确 agent；临时条目自然被剪。

---

## 9. 待实现期确认项（不影响方案成立，实现时写测试锁死）

1. `ensureLive` 覆盖所有续聊入口（UI on-open 足够；若改走 bridge 链路恢复，需异步顺序测试，不得重排 res 路由）。
2. reconcile 能在归档被硬删前读到正文——已知 `resolveTranscriptFile` 读 `.deleted.`，且有 ≈30d 富余；补 reconcile 单测（模拟归档→折进镜像）。
3. compaction 在盘形态——基线用整文件拷贝即正确，无需依赖此项；仅当将来做增量追加优化时再确认。
4. 可选索引清理触发的 session-end 钩子对 CoClaw chat-history 无副作用（仅当采用 §7 的可选清理时需确认）。

---

## 10. 待你拍板的产品决策

1. **膨胀松紧**：默认保洁封顶（推荐，最省事、剪掉无害）vs 主动清索引做到近乎零（多一步 + 需确认钩子无副作用）。
2. **存量 topic 迁移**：升级时一次性 backfill 镜像（推荐，纯拷贝不花 token，保住已超 30d 可能将被删的）vs 等下次打开懒迁移（更简单，有迁移窗口丢失风险）。

---

## 11. 上游杠杆（可选，非必需）

若上游提供"外置 session"运行模式（`agent()` 写一份稳定、免保洁的 `<sessionId>.jsonl` 且不写 sessions.json 索引、并对插件连接可见），则 R1 彻底归零、镜像/恢复/对账代码全删。当前方案**不依赖**它，在 2026.6.1 上零上游改动即满足全部四需求。次选（暴露 preserve-keys provider 让插件 pin 住 topic key）会保住 R3 但每 topic 永留一条、恶化 R1，劣于外置 session 杠杆。
