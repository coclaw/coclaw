# 设计稿：自动升级摆脱安装账本（三层防线：位置短路 + 逐周期来源门禁 + 结局核对）

> 状态：**已实施**（2026-06-11，commit 1f2cae34）。已归档，不再追新。
> v2 → v3：吸收第 2 轮三路评审（场景推演 / 复杂度裁判 / codex 复审）。要点：L2 结局矩阵补全（失败路径原样保留）、砍掉 no-op 计数器（改立即记跳过）、比较器措辞对齐现行实现、信号分类与去重、`upgrade.available` 后移。
> v3 → v3.1（评审终版）：L2 矩阵"版本未达标"拆分为 record 推进 / 未推进两支（推进未达标 → verify 目标参数化为实装版本；未推进 → no-op），补"基线不可得"退化分支；配套 updater-spawn 新增 `--baselineVersion` argv 接线（`install.version` 不只记日志，作 L2 推进判定基线；缺失不传 flag）。
> 归档时已按设计稿规范清理易腐 file:line 引用（保留路径级指针）。
> 2026-06-11 本机实测发现的升级链缺陷与修复（worker cgroup 脱逃、回滚链加固、prerelease 闸等）见 `docs/auto-upgrade.md` 与 `TODO.md`（修复随 vNEXT 发布）；本稿维持归档、正文不追新。

## 背景与问题

上游 OpenClaw ≥2026.6.1 将插件 install records 从 `<state-dir>/plugins/installs.json` 迁入共享 SQLite。迁移后旧 JSON 或被改名归档，或因冲突留置但永久停更（本机 2026.6.5 即此态）。

我方 updater 读账本只消费两个字段，对应两种坏法：

1. `source !== 'npm'` 即整体跳过（scheduler `start()` 同步调用）——新 host 上记录缺失 → 误判非 npm → **自动升级整体静默停摆**，无 remoteLog。
2. `installPath` 传 worker 作备份/回滚目录——记录陈旧 → 回滚落点错位。

worker 从不读账本（argv 传参）；`scripts/_lib.sh` 也直读旧 JSON 且硬编码 `$HOME/.openclaw`。

## 方案 v3.1：三层防线

**核心原则**：账本直读归零；来源判定走官方 CLI 契约并**每周期重新验证**（瞬时失败下周期自愈），结构上消灭"一次误判 → 永久静默停摆"；升级命令**失败路径一字不动**（最小变更），只对"假成功"（exit 0 但账本未推进）新增处理；所有稳定态跳过与异常都有去重后的远程可见性。

### L0 dev 短路（`start()`，同步，约 15 行）

- 自身包根：`nodePath.resolve(import.meta.dirname, '../..')` 先得根、再 `fs.realpathSync`（与 `updater-check.js` 的包根自推同锚点；先 resolve 后 realpath，link 模式下结果确定为 stage 根，测试断言可定）。与 **runtime 注入的** `resolveStateDir()` 结果（同样 realpath）判包含。
- 包含谓词（R2 实测钉死，禁用裸 `startsWith('..')`）：`rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))`，其中 `rel = path.relative(stateDir, pkgRoot)`。Windows 大小写由 `path.win32.relative` 天然处理；跨盘符落 `isAbsolute` 兜住。
- 在外 → dev/link 装置 → 跳过整个 scheduler + remoteLog `upgrade.position-skip`（带 pkgRoot/stateDir；每次 gateway start 至多一条，与 nix-skip 同级）。
- **只信 runtime**：runtime 不可用、realpath/谓词任一步抛错 → **不下"在外"结论**，放行到 L1 + remoteLog（信号 key 可与现有 `state-dir-failed` 合并，实施裁量）。整个判定表达式包进同一个 try/catch。`state.js` env/home 兜底不认上游 `OPENCLAW_CONFIG_PATH` 派生（上游 `utils.ts` vs 本插件 `state.js`），兜底结果不得用于"在外"判定。
- NIX 判定（`updater.js`）保持在 L0 之前。
- 保留理由（第 2 轮复杂度对抗后裁决）：dev 长命网关完全静默（否则"已发版未 pull"常态窗口每小时 spawn 一次 inspect）、start 时刻即有信号、不依赖 CLI 可用性（dev/worktree 网关恰是 CLI 异常高发地）、顺带挡住 link+npm 共存的边角；其全部失败模式都是"落到 L1"，单独不会拦错真用户。

### L1 来源门禁（`__check()` 内，异步，逐周期）

- 顺序：`npm view` 比版本（现状不变）→ **有新版才**执行：execFile `openclaw plugins inspect <pluginId> --json`（独立 CLI 不依赖网关在跑，子进程不冻结网关，~3.2s 仅在有新版待升时发生；execFile 选项对齐先例：30s timeout + win32 shell，经 `__opts` 注入 `inspectInstallFn`）。
- **L1 必须在 `__check` 内局部 try/catch**——`__check` 外层 catch-all 会把异常吞成泛化 `upgrade.check-failed`，信号混淆（S1/codex 同时指出）。
- 判定与信号（三类，前两类为**稳定态**、按 `(原因, toVersion)` 内存去重，实例字段先例 `__lastReportedUpgradeTs`，重启重置至多重发一条）：
  - `install.source === 'npm'` → 放行；此时才 remoteLog `upgrade.available`（**后移到 L1 之后**——否则永不升级的装置每小时刷一条 available；npm 用户行为不变）。
  - `install.source` 非 npm，或 inspect 正常但**无 install 记录**（如手动 load.paths 装置）→ 本周期跳过 + 去重的 `upgrade.source-skip`（source 值带 `none` 表无记录）。语义与现状等价（这些装置今天也不升级），且多了远程可见性。
  - inspect **真失败**（exit≠0 / 解析失败）→ 本周期跳过 + 去重的 `upgrade.gate-inspect-failed`，下周期自动重试（瞬时自愈、持续可见）。
- 放行时取 `install.installPath` 作 worker `pluginDir`（权威且新鲜）；字段缺失 → 回退自推包根 + remoteLog 降级日志 + spawn 前核验该目录 `package.json` 的包名（防错传目录给备份/回滚）。`install.version` 作 L2 推进判定基线，经 `--baselineVersion` 传 worker（v3.1：不再只记日志；缺失不传 flag）。
- 行为差异（接受并记录）：非 npm 装置上 scheduler 现在会启动并每小时跑一次 `npm view`（现状是不启动）——一次 registry 查询，可忽略。

### L2 worker 结局矩阵（post-update）

完整矩阵（codex/S2 第 2 轮 MUST-FIX 补全；v3.1 把"版本未达标"按基线推进与否拆分；**失败分支 = 现行路径一字不动**）：

| update 结果 | inspect 核对 | 处置 |
|---|---|---|
| exit≠0 | — | **现行回滚路径不变**（恢复备份 + 重启 + 不 skipVersion + 下周期重试，`worker.js`）——瞬时故障不被永久跳过的既有语义保留 |
| exit 0 | record 达标：`version === toVersion \|\| isNewerVersion(version, toVersion)`（**与现行成功判据同构**，抽为共享 `isVersionReached`（`worker-verify.js`）；`isNewerVersion` 是严格大于，须显式加等号——v2 "≥ 语义"措辞有误，codex 纠正） | 真升级 → 现行 restart + 健康轮询 + 失败回滚流不变 |
| exit 0 | record 推进但未达标（latest-compatible 封顶等：> 基线且 < toVersion） | **verify 目标参数化为实装版本**：restart + 健康验证实装版本，成功 → skipVersion(toVersion) + 记 `ok`；失败 → 现行回滚（v3.1 拆分） |
| exit 0 | record 未推进（=== 基线；update 干净 skip、registry 假成功——磁盘什么都没变） | **no-op**：不重启、不回滚、删 `.bak`、**立即写 skipVersion**、写 `lastUpgrade` result=`noop-skip`（接 scheduler 下轮 `__reportLastUpgradeResult` 既有上报链，`updater.js` 透传无需改；worker 禁 remoteLog 不破） |
| exit 0 | 基线不可得（`--baselineVersion` 缺失）且版本未达标 | 退化为现行 restart + verify(toVersion) 分支（v3.1 补） |
| exit 0 | inspect 自身失败 | 保守按"真升级"处理 → 现行 restart + verify（健康检查 + 回滚兜底，避免工具故障静默压制激活） |

- **no-op 立即记 skipVersion 的论证**（v2 的 3 次计数器已砍，第 2 轮逐代对照裁决）：任何一代主机上都不劣于今天——老 host（update 出错也 exit 0，P9）瞬时故障今天本来就走"轮询超时 → 回滚 + skipVersion"（还多两次重启），新路径同样 skip 但省掉重启；新 host 瞬时故障 exit≠0，走的还是原回滚重试路、不 skip。跳过即停止重试也封掉 latest-compatible 封顶场景（P14）的每小时空转循环。skipVersion 记录本就是现行回滚路径的既有语义，非新引入。
- update 的 stdout 文本仅记 worker 日志作旁证，不作判据（人面文案无契约承诺，P9）。
- worker 显式 `gateway restart` 保留（P10：afterWrite 只是标记，reload mode 可配不重启；最坏双重启幂等=现状）。
- v3.1 配套：`updater-spawn.js` 新增 `--baselineVersion` argv 接线——L1 取得的 `install.version` 作 L2 "record 推进 / 未推进"判定基线；缺失时不传 flag，worker 按"基线不可得"分支退化。

### 删除项与脚本侧

- `loadInstallRecord` / `loadInstallRecordFromLegacyConfig` / `getPluginInstallPath` / 账本路径常量及 `getClawConfig`、`nodeFs` import 删除；`shouldSkipAutoUpgrade` 保名换实现（nix + L0），`__opts.shouldSkipFn` 测试缝复用（消费点全集已核实，P7）。
- `_lib.sh`：`get_install_mode` / `get_installed_version` 改走 `plugins inspect <id> --json`，`node -e` 读 stdin 解析（不引 jq）；单脚本内 memo 化（一次 CLI 调用，避免 prerelease 串调 +10-15s）；**无 JSON 回落**——CLI 失败响亮报错（dev 机均新 host，回落只会读到分歧账本）。未安装判定用"exit≠0 或 stdout 空"，勿碰 stderr 文案。顺带修硬编码 `$HOME/.openclaw`（含 `ensure_uninstalled` 的 extensions 残留清理）。link 判定所需 `sourcePath` 是否经 CLI 透传，**实施第一步在 link 模式下实测**。

## 与历史定论对账

`docs/auto-upgrade.md` 既有定论"磁盘 package.json 版本仅诊断、不参与判定"**完整保留**：L2 判据是权威账本（经官方 inspect），不是磁盘文件。v1 曾拟用磁盘版本作闸，已被第 1 轮推翻并弃用。

## 已核实前提（P1–P14）

- **P1** link 安装三代物化一致：`source:"path"`、源路径进 `plugins.load.paths`、从源目录运行、不进 state-dir（上游 `plugins-install-command.ts`；v2026.3.22 同构；`discovery.ts`）。我方 link.sh 链 `.build/link-stage`，同在 state-dir 外。
- **P2** **默认布局下**正式安装三代都在 state-dir 内（旧 npm=`extensions/` ≤2026.5.2；新 npm=`npm/projects/` ≥2026.5.3；git=`git/`；marketplace/clawhub=extensions），代码层有目录参数但生产 CLI 全喂默认值、无用户旋钮（`install-paths.ts`）。
- **P3** 自推包根 == 账本 `installPath`（本机对账；`updater-check.js` 先例在产）。v3 中自推仅作 L0 判据与 L1 installPath 缺失回退。
- **P4** npm 装置路径链逐级 lstat 无软链；软链信号弃用；realpath 两侧 + 守卫谓词无已知误报成因。
- **P5** `plugins update` 可升级集合 = {npm, marketplace, clawhub, git}（**git 为新代加入，v2026.3.22 集合为 {npm, marketplace, clawhub}**）；path/archive → 干净 skip、先于任何磁盘写、exit 0（上游 `update.ts`）。record 缺失同样 skip + exit 0。
- **P6** worker 现状 exit 0 即无条件 restart → 5min 轮询 → 超时回滚 → 再 restart——L2 改造点。
- **P7** 账本消费点全集 = updater 两处 + `_lib.sh` 两函数（两轮独立全量 grep 互证）；worker 不读账本。
- **P8** SDK / runtime / gateway RPC 无账本查询面；上游内部 helper 从未经 plugin-sdk 暴露（exports 实查）——TODO.md 旧记录措辞失准，已更正。
- **P9** `plugins update` 无 `--json`；outcome 只打印人面文本（模板三代逐字一致但无契约承诺）；**v2026.3.22 上 update 出错也 exit 0**——exit code 与文本均不可作 L2 主判据。
- **P10** `afterWrite {mode:"restart"}` 是标记非动作；网关经 config watcher 按 reload mode（默认 hybrid 重启，可配不重启）自行决定——worker 显式重启必须保留；skipped 零 config 写 → 上游不触发重启。
- **P11** inspect 判定通道三代成立：独立 CLI；"记录推进 ⇔ 真升级落盘"干净双射（写记录 await 在命令退出前、失败原子回滚，三代核实）；`install.version/source/installPath` 字段三代在；`info` 为注册别名，用主名 `inspect`。本机实测 3.13s、stdout 纯 JSON。
- **P12** 布局迁移基线：老布局升级后 record 指新托管路径、discovery 按 record 加载且新副本 provenance 必胜——现行重启+健康检查流端到端成立。
- **P13** **老版 skip 零写盘成立**：v2026.3.22 不可升级/无记录 → `outcomes.push + continue` 先于任何 install 调用；config 写仅 `changed=true`，skipped 不置位（S1 核验）。
- **P14** **裸 npm spec 默认装 latest compatible**（上游 `install.ts`）：改装 npm 即装上 ≥被跳过版本，"skipVersion 压制后续合法升级"不成立；host 过老时 latest-compatible < toVersion，no-op + skipVersion 恰好抑制注定不达标的重试（正向副作用）。codex 注记：exact/tag spec 在更新时被保留（`install-channel-specs.ts`）——用户显式 pin 版本属自担行为，不影响裸 spec 主流路径。

## 评审裁决记录

**第 1 轮**（v1 → v2）：R1 布局迁移假阴性 → L2 改走 inspect；R1 state-dir 兜底不可信 → L0 只信 runtime；R2 包含谓词 / noop 接上报链 → 采纳；R3 历史定论对账 / TODO 矛盾 / SOP 漏更 → 采纳；codex fail-open 与位置≠npm → 闭合于 L1 逐周期正向验证（codex 第 2 轮确认两条 CLOSED）。

**第 2 轮**（v2 → v3）：

| 来源 | 发现 | 处置 |
|---|---|---|
| S1 | 无 install 记录是稳定态，并入 gate-inspect-failed 会每小时刷远程 | **采纳**：归入去重 source-skip（source=none），gate-inspect-failed 只留真失败 |
| S1 | `__check` catch-all 吞 L1 异常 | **采纳**：L1 局部 try/catch（实现约束） |
| S2 | L2 结局矩阵缺 exit≠0 分支定义 | **采纳**：矩阵补全，失败路径=现行路径不动 |
| S2 | L0 删除论证 / L1 顺序 / 计数器三项对抗 | L0、L1 顺序维持；**计数器砍掉**（用户"简单优先"尺度终裁）：exit-code 分流后瞬时故障语义已由原路径保留，no-op 立即 skip 逐代对照不劣于现状 |
| codex | isNewerVersion 是严格大于，"≥ 语义"措辞错误 | **采纳**：判据写为 `=== \|\| isNewerVersion`，与现行成功判据同构 |
| codex | 计数器字段/重置未定义 | **随计数器砍除而消解** |
| codex | upgrade.available 在 L1 前会与 source-skip 并发刷屏 | **采纳**：available 后移到 L1 放行后 |
| codex | installPath 回退无日志无核验；skipVersion 触发无专用信号 | **采纳**：回退加 remoteLog + 包名核验；no-op 的可见性由 noop-skip token 经下轮 upgrade.result 上报承担（无需新信号 key） |

## 残余风险（v3.1）

- **inspect 契约依赖**：升级链对 `plugins inspect --json` 形成依赖；上游若破坏该契约，自动升级**可见地暂停**（gate-inspect-failed 持续上报）直到人工修复——失败方向正确（暂停优于做错），契约已核实三代稳定。
- **latest-compatible 封顶**（老 host + 新版抬 minHost）：no-op + skipVersion 后，磁盘上可能留有已装入的兼容版，在下次自然重启时未经健康验证激活——engine-compatible 由上游解析保证，接受；稳态为每个新版本一轮 no-op。
- marketplace/git/clawhub 装置：L1 明确跳过（语义与现状等价 + 远程可见）；未来如需支持，L1 是天然扩展点。
- 布局迁移场景回滚不完美（备份旧实体、record 已指新处）——预存限制（`worker-verify.js` 头注释已有记述），文档注记 + TODO。
- dev checkout 放进 state-dir（反常布局）：L0 放行 → L1 source=path 跳过 → 无破坏。
- 预存问题（已进 TODO，不阻塞）：`.bak` 可能被 npm prune；托管布局回滚后"新依赖+旧代码"混搭；`engines.node >=18` 名存实亡（4 处 `import.meta.dirname` 需 ≥20.11，minHost 实际 Node ≥22.16）；worker-backup 头注释过时；`upgrade.skipped` 每小时刷屏（预存模式，可顺手去重）；runtime 缺失时 spawner 给 worker 的 env state-dir 兜底理论错位；state.js 无锁 read-modify-write 为已接受模式（upgrade.lock 时序隔离）。

## 影响面与实施清单（已全部执行）

代码（commit 1f2cae34）：`updater.js`（删账本链、L0、L1 并入 `__check`、available 后移、信号去重实例字段）；`updater-check.js`（`inspectPluginInstall` 共置）；`updater-spawn.js`（`--baselineVersion` 接线）；`worker.js` + `worker-verify.js`（L2 矩阵、`isVersionReached` 同构复用）；`scripts/_lib.sh`（CLI 化 + memo + 删回落 + 修硬编码）；测试增删（清单见下）。

文档收尾（2026-06-11）：`docs/auto-upgrade.md` 逐段更新（状态行、频率预存漂移 5-10min→实为 60-120min 顺带修正、skippedVersions 语义补 no-op、state 格式补 noop-skip token、流程图改三层防线、验证策略保留原句 + L2 注记、link 判定改 inspect 口径、实现备注表对齐现状）；`docs/local-plugin-update-sop.md`（账本验法 → inspect 验法）；TODO.md 闭环 / 更正 / 预存问题追加；patch 级 changeset。

**必增测试用例（场景级）**：
- L0：包根内/外；state-dir 含软链 realpath 归一；runtime 缺失→放行 L1；realpath 抛错→放行 + 信号；谓词边角（`..` 前缀名、兄弟目录前缀、盘符）；默认实现路径。
- L1：source npm 放行 + available 后移断言；非 npm / 无记录跳过 + 去重（同周期重入不重发）；inspect 失败跳过 + 下周期重试；installPath 缺失回退 + 降级日志 + 包名核验拒绝错目录。
- L2：exit≠0 → 现行回滚路回归（不 skip）；exit 0 + 版本相等 → 真升级（**等号用例防严格大于回归**）；exit 0 + 版本更新（dist-tag 前移）→ 真升级；exit 0 + record 未推进（=== 基线）→ no-op（不重启、删 .bak、skipVersion、noop-skip token）；exit 0 + record 推进未达标 → verify 实装版本 + skipVersion(toVersion)；exit 0 + 基线缺失且未达标 → 退化 verify(toVersion)；exit 0 + inspect 失败 → 保守重启。
- scheduler 集成：启/跳两态；noop-skip 经下轮 upgrade.result 上报断言。
- `_lib.sh`：手测清单（link 模式 sourcePath 实测先行）。

测试注入：L0/L1 沿用 `__opts` DI（pluginRoot/stateDir/inspectInstallFn 注入 + 默认实现双测）；L2 沿用 worker execFileFn 注入 + tmp pluginDir 模式。覆盖率门禁 100/100/95/100 经评估可达。
