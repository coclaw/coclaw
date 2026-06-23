# CoClaw 插件自动升级方案

> 状态：已实现（2026-03-12）；2026-06-11 摆脱安装账本改造落地——账本文件直读归零，
> 改为三层防线（L0 启动位置短路 → L1 逐周期 inspect 来源门禁 → L2 升级后结局核对）；
> 同日升级链缺陷修复落地——worker cgroup 脱逃（systemd-run scope）、inflight 对账、
> 回滚链加固（备份迁出 npm 树 / install --force / rollback-failed 终态）、prerelease 闸、错因富化。
> 创建：2026-03-11

## 背景与动机

- 插件短期内升级频率高，前后端版本不匹配会导致前端无法正常运行
- 多数用户难以直接在 OpenClaw 侧手动操作升级
- 用户应只安装一次插件，后续升级对其透明
- 无论自动还是手动升级，"新版本不能导致 gateway 无法启动"都是发布质量底线，与升级策略无关

## 设计决策

| 项目 | 决定 | 理由 |
|---|---|---|
| 实现语言 | JS（内置于插件） | 回滚逻辑有一定复杂度；bash 在 Windows 上不可靠 |
| 版本检查源 | npm registry（当前阶段）| 直接可用，无需 server 配合；后续迁移到 CoClaw server 推送 |
| 检查频率 | gateway 启动后延迟 60–120 分钟（随机抖动）首次检查，之后每 1 小时 | 启动阶段不增加开销；拉长"失败→worker 触发重启→再检查"的循环周期；每小时对 npm registry 无压力 |
| 安装来源判定 | `openclaw plugins inspect <id> --json`（官方 CLI，逐周期重验） | 账本文件直读已废弃（上游 ≥2026.6.1 迁 SQLite，旧 JSON 停更）；逐周期重验让瞬时失败下周期自愈，结构上消灭"一次误判 → 永久静默停摆" |
| 升级执行方式 | spawn detached node 进程运行 worker.js；linux+systemd 下经 `systemd-run --scope` 包装脱离 gateway service cgroup | 升级会触发 gateway 重启，执行者不能在 gateway 进程内；detached 不等于脱离 cgroup，`KillMode=control-group` 的重启清场会连带杀 worker（见"spawn detached 进程"节） |
| Node 路径 | `process.execPath` | 确保与 gateway 使用同一 node 版本 |
| npm registry | 通过 `npm view` 命令查询 | 自动继承用户完整的 npm 环境配置（registry、proxy、auth 等），无需自行解析 `.npmrc` |
| 备份方式 | `fs.cp()` 物理复制插件目录 | Node 16.7+ 内置 API，跨平台，无依赖；插件目录很小（纯 JS，无 node_modules） |
| 回滚策略 | 首选 mv 备份目录，兜底从 npm 安装旧版本 | 回滚时网络状况未知，物理备份更可靠 |
| 验证标准 | gateway running + 插件已加载 + 升级模块可响应 | 最低保证：插件还能继续自我升级 |
| 失败版本处理 | 记录在 upgrade-state.json 中，后续跳过；L2 no-op 跳过（update 假成功、记录未推进）与 host 封顶（记录推进但到不了目标）同样进 skippedVersions | 避免反复升级到已知有问题或注定到不了的版本 |
| 升级日志 | `upgrade-log.jsonl`，只追加 | 仅用于运维可观测性，不承担兜底职责 |
| 并发控制 | `__checking` 标志位 + `upgrade.lock` 文件锁（PID 检活 + 110min TTL 兜底） | 标志位防止 interval 重叠检查；文件锁防止 gateway 重启后新 scheduler 与旧 worker 并发；锁超过 TTL 一律视为过期清理，兜住 PID 复用误判与 worker 被强杀未清锁的场景；清锁若遇系统性故障（权限/只读 FS 等）会 warn 日志 + `remoteLog('upgrade.lock-cleanup-failed')` 上报，避免与 writeUpgradeLock 同源故障叠加时陷入无感循环 |
| 用户通知 | 暂不做 | channel 机制尚未启用，后续接入成本低 |
| 独立升级插件 | 不采用 | 鸡生蛋问题；OpenClaw 插件生态尚早期；Node.js 插件不存在二进制锁定 |

## 文件布局

```
~/.openclaw/coclaw/
├── bindings.json          # 已有，绑定信息（不变）
├── upgrade-state.json     # 升级运行时状态
├── upgrade-log.jsonl      # 升级历史记录（只追加）
├── upgrade.lock           # 升级锁（记录 worker PID，防止并发）
└── upgrade-backup/<pluginId>/  # 升级备份（npm 树外，回滚物理来源，见"备份目录"节）

plugins/openclaw/src/
├── auto-upgrade/
│   ├── updater.js          # gateway：updater 服务入口（调度 + 编排 + 升级锁）
│   ├── updater-check.js    # gateway：版本检查（查询 npm registry）
│   ├── updater-spawn.js    # gateway：spawn worker 进程
│   ├── worker.js           # worker：升级主流程（备份 → 升级 → 验证 → 回滚）
│   ├── worker-backup.js    # worker：备份与恢复
│   ├── worker-verify.js    # worker：升级后验证（gateway + 插件 + health）
│   └── state.js            # 共享：upgrade-state.json / upgrade-log.jsonl 读写
└── ...
```

## upgrade-state.json 格式

```json
{
  "skippedVersions": ["0.2.1"],
  "lastCheck": "2026-03-11T10:00:00Z",
  "inflight": {
    "from": "0.2.0",
    "to": "0.2.1",
    "verifyTarget": "0.2.1",
    "pluginDir": "/home/u/.openclaw/npm/projects/.../openclaw-coclaw",
    "phase": "verify",
    "ts": "2026-03-11T09:28:00Z"
  },
  "lastUpgrade": {
    "from": "0.2.0",
    "to": "0.2.1",
    "result": "rollback",
    "error": "update failed: ...",
    "ts": "2026-03-11T09:30:00Z"
  }
}
```

- `skippedVersions`：以下情形加入（`openclaw plugins update` 命令自身失败视为瞬态故障，不加入）：
  - **验证超时并回滚**
  - **L2 no-op 跳过**：update exit 0 但安装记录未推进（干净 skip / registry 假成功），重试无意义
  - **host 封顶**：记录推进但到不了目标版本（latest-compatible），实装版本验证通过后对目标版本记跳过

  当 npm 上出现比所有 skippedVersions 更新的版本时，正常触发升级
- `lastCheck`：上次版本检查时间，用于调度器判断是否该检查
- `inflight`：worker 进 update 前写入的在途标记；`phase` 随 `update` / `verify` / `rollback` 推进（纯信息字段）。终态记账时与 `lastUpgrade` 同锁原子清除（state.js 的 terminal helper：写 lastUpgrade + 清 inflight + 可选 skipVersion 一次完成）；锁空闲时仍残留 = worker 中途死亡，由 scheduler 对账消化（见"inflight 对账"节）
- `lastUpgrade`：上次升级的摘要信息。`result` 取值：
  - `ok`（验证通过）
  - `rollback`（验证失败回滚；语义=**文件态已恢复**，运行态恢复交还重启与上游 watcher）
  - `noop-skip`（L2 判定记录未推进的 no-op 跳过）
  - `rollback-failed`（备份恢复与兜底 install 双失败，坏版本仍在位，`error` 带真因）
  - `interrupted`（scheduler 对账补记：worker 中途死亡且运行态未达 verifyTarget，附 phase）

  失败终态附 `error`（子命令双流尾部截断 + 脱敏，见 upgrade-log 节）。scheduler 下轮经 `upgrade.result` 上报链统一推送 server，上报行附 `error=`

## upgrade-log.jsonl 格式

每行一个 JSON 对象，只追加写入（`fs.appendFile`）：

```jsonl
{"ts":"2026-03-11T09:30:00Z","from":"0.2.0","to":"0.2.1","result":"ok"}
{"ts":"2026-03-12T10:00:00Z","from":"0.2.1","to":"0.2.2","result":"rollback","error":"gateway failed to start within timeout"}
```

文件超过 200 行时可截断旧记录（保留最近 100 行）。

- `error`：失败记录携带真实错因——子命令 stdout 与 stderr **各取尾部 ≤500 字符**、脱敏（剥 URL userinfo `://***@` 与 `_authToken=`）后拼接。真因常在 stdout（上游错误 outcome 走 console.log，execFile 的 err.message 只附 stderr）
- 终态行之外的事件行：`rollback-restart-failed`——回滚记账完成后触发 `openclaw gateway restart` 命令失败时追加（worker 进程不调 remoteLog 的红线保持，此事件仅入账本）
- 追加在终态记账（state 写入）之后 best-effort 执行，自身失败不影响账本

## 升级流程

### 整体时序

```
gateway 启动
  → 插件 register()
    → L0 启动短路（同步）：
       Nix mode → 跳过；自身包根（realpath）在 state-dir 外 → dev/link 装置，跳过整个 scheduler
       （只信 runtime 注入的 resolveStateDir；runtime 不可用 / 判定抛错 → 不下"在外"结论，
         放行到 L1 + remoteLog upgrade.state-dir-failed）
    → scheduler 启动（不立即检查）
      → 延迟 60–120 分钟后首次检查
      → 此后每 1 小时检查一次

检查流程（__check，逐周期）：
  升级锁被持有（worker 仍在跑）→ 跳过本次
  → 锁空闲且 state.inflight 残留 → 先对账补记终态（见"inflight 对账"节），再继续
  → checker 查询 npm registry（npm view，读取用户 .npmrc 配置）
  → 对比本地版本 vs latest；跳过 skippedVersions 中的版本
  → latest 为 prerelease（semver 语义）→ 视为无新版：不 spawn、不写 skip / lastUpgrade
     （lastCheck 照旧），去重上报 upgrade.prerelease-skip
  → 有新版才走 L1 来源门禁：execFile `openclaw plugins inspect <id> --json`
     ├─ install.source === 'npm' → 放行，此时才 remoteLog upgrade.available
     ├─ source 非 npm 或无安装记录（source=none）→ 本周期跳过（去重的 upgrade.source-skip）
     └─ inspect 真失败（exit≠0 / 非 JSON）→ 本周期跳过（去重的 upgrade.gate-inspect-failed），
        下周期自动重试（瞬时自愈、持续可见）
  → pluginDir 取记录 installPath（缺失 → 回退自推包根 + 包名核验）；install.version 作 L2 基线
  → spawner 启动 upgrade-worker（detached 子进程，argv 含 --baselineVersion；linux+systemd 下
     探针通过则包成 systemd-run scope 脱离 gateway service cgroup，失败降级裸 spawn +
     去重 upgrade.cgroup-escape-failed，见"spawn detached 进程"节）
  → 写入 upgrade.lock（记录 worker PID）

upgrade-worker（独立 node 进程）：
  1. 物理备份插件目录 → <state-dir>/coclaw/upgrade-backup/<pluginId>/
  2. 备份就绪后、进 update 前写 state.inflight（含 phase），终态记账时原子清除
     （先备份后 inflight 是有意设计：死在备份阶段未动盘、无账可记，不留 inflight、不触发对账）
  3. 执行 openclaw plugins update @coclaw/openclaw-coclaw（裸 npm 包名，顺带解除 exact spec 钉死）
     （失败时用反向 mirror 切换 registry 重试一次；仍失败 → 回滚，不 skipVersion）
  4. L2 结局核对：inspect 升级后安装记录，按结局矩阵分流（见下节）
  5. 真升级路径：触发 openclaw gateway restart，轮询 coclaw.upgradeHealth 直到版本达标
  6a. 成功 → 删除备份，终态记账（result=ok）
  6b. 失败 → 恢复备份 → 记失败版本 + 终态记账（result=rollback / rollback-failed）
      → 之后才触发 gateway restart（fire-and-forget）
```

### upgrade-worker 详细流程

记账契约（贯穿全流程）：进 update 前写 `state.inflight`（phase 随 update / verify / rollback 推进）；所有终态经 state.js 的**原子 terminal helper**——同一把锁内一次完成"写 lastUpgrade + 清 inflight + 可选 skipVersion"，upgrade-log 追加放其后 best-effort；worker 内一切 state 写入**非致命**（独立 try/catch，失败记日志继续——升级成败以实际文件态为准，inflight 未清由 scheduler 对账兜底补记）。

1. 备份：插件目录 cp 到 `<state-dir>/coclaw/upgrade-backup/<pluginId>/`（先临时目录再 rename 就位，见"备份目录"节）
2. `openclaw plugins update @coclaw/openclaw-coclaw`——**裸 npm 包名**而非插件 id：update 按包名匹配产生 specOverride，成功后把安装记录 spec 重写为裸名，一次 update 同时"装 latest + 解除 exact spec 钉死"（裸包名须恰好单匹配一条 npm 安装记录；0/多匹配退回按 id 处理 → no-op skip）
   - 失败：切换 registry（npmjs ⇄ npmmirror）重试一次
   - 仍失败：进入回滚（skipVersion=false，瞬态故障不跳过）；错因经 `formatCmdFailure` 富化——子命令 stdout/stderr 各取尾部 ≤500 字符、脱敏后拼进 error（兜底 install 失败同此处理），经 handleRollback 自动进账
3. **L2 结局核对**：update exit 0 ≠ 真升级（老 host 出错也 exit 0、path/缺记录干净 skip 也
   exit 0、registry 假成功、latest-compatible 封顶）。经 `inspectPluginInstall` 读升级后
   安装记录分流；update 的 stdout 文本仅记日志不作判据（人面文案无契约承诺）：

| update 结果 | inspect 核对 | 处置 |
|---|---|---|
| exit≠0 | — | 回滚（记账先于重启）+ 不 skipVersion（瞬态故障，下周期重试） |
| exit 0 | record 达标（`isVersionReached`：=== toVersion 或更新） | 真升级：restart + 健康轮询，失败回滚 |
| exit 0 | record 推进但未达标（latest-compatible 封顶等） | verify 目标参数化为实装版本：验证通过 → skipVersion(toVersion) + 记 `ok`；失败 → 现行回滚 |
| exit 0 | record 未推进（=== `--baselineVersion` 基线） | **no-op**：不重启、不回滚、删备份、立即 skipVersion、lastUpgrade result=`noop-skip` |
| exit 0 | 基线不可得（`--baselineVersion` 缺失）且未达标 | 退化为现行 restart + verify(toVersion) |
| exit 0 | inspect 自身失败 / 记录缺 version | 保守按真升级走 restart + verify（避免工具故障静默压制激活） |

4. 验证（verifyUpgrade）：
   a. 触发 `openclaw gateway restart`（命令失败不阻断）
   b. 记录磁盘 package.json 版本（仅诊断）
   c. 轮询 `openclaw gateway call coclaw.upgradeHealth` 直到版本 ≥ verify 目标
      （总超时 5 分钟，间隔 3 秒）
5. 收尾：
   - 验证通过：删备份 → 终态记账（result=`ok`；记账失败非致命，仍 exit 0，inflight 残留由对账补记）→ 退出
   - 验证失败：恢复备份（rename 回原位，跨设备 EXDEV 退化 fs.cp + rm；失败则
     `plugins install <pkg>@<旧版> --force` 单命令覆盖装兜底）→ 终态记账：skippedVersions += 新版本
     + 恢复成功记 `rollback`（语义=**文件态已恢复**，运行态恢复交还重启 / 上游 watcher）、
     双路径都失败记 `rollback-failed`（坏版本仍在位，error 带真因）→ **记账之后**才触发
     gateway restart（fire-and-forget，不验证；命令失败追加 jsonl 事件 `rollback-restart-failed`）→ 退出

### inflight 对账（scheduler 兜底）

worker 中途死亡（探针降级形态被重启连带杀死、强杀、断电等）会留下 inflight 残留。scheduler 每周期 `__check` 顶部：升级锁空闲且 `state.inflight` 存在 → 先对账、再允许新检查（避免双 spawn）：

- 成功判据用**模块加载时刻钉住的自身版本**（即当前进程真正加载的代码；`coclaw.upgradeHealth` handler 返回同一快照，对账与 worker 验证真正同源）；**禁止对账时刻再读磁盘 package.json**——中断的升级可能已把磁盘写成新版本而新代码从未被加载，按磁盘判会把"磁盘新、运行未验证"误记成功并删掉唯一的回滚备份
- 达 verifyTarget → terminal helper 补记 `ok`（verifyTarget ≠ toVersion 时复刻 worker 语义补 skip）+ 删备份
- 未达 → 补记终态 `interrupted`（账目与告警带 phase）+ remoteLog；**不自动 skip**——误伤瞬态的风险与 v3.1 砍重试计数器同类判断；"死在回滚中途"的下周期重验自然走正常 skip，自愈有界
- 畸形 inflight（verifyTarget 与 to 皆缺，永远无法判定达标）→ 按 `interrupted`（phase=`malformed`）消化、不清备份，管线恢复正常检查；只有自身版本快照不可得才 defer 等下轮（"无法判定就不动盘"）
- 对账延迟最长一个检查周期（首检 60–120min）：账目最终一致、告警不即时，可接受

### 验证策略

验证的核心目标：**确认新版本代码已在 gateway 进程内被加载且可响应**。

实现上只保留一条权威信号——轮询 `openclaw gateway call coclaw.upgradeHealth --json` 直到返回的 `version` 字段 ≥ `toVersion`：

- 把 gateway 存活、插件加载、RPC 注册链路、新代码执行这几件事**隐含包在同一次 RPC 成功里**。不再单独跑 `openclaw gateway status` / `openclaw plugins list`：前者等价于"RPC 能否返回"，后者的 stdout 曾出现折行/别名导致 `.includes()` 误判，权威性不如 RPC 自报版本
- **判定用 "≥" 而非严格等于**：scheduler 观察到 `latest=x` 并发起升级后，到 worker 实际执行 `plugins update` 之间 npm dist-tag 可能已前移到 `x+1`；严格等 `x` 会把"装上更新版本"误判为失败并回滚。用 semver 比较避免这个窗口误判
- 磁盘 `package.json` 的版本号仅写入本地诊断日志，不参与判定（symlink / installPath 漂移等场景下磁盘版本可能骗人）
- handler 侧同样不读磁盘：`coclaw.upgradeHealth` 返回**模块加载时刻钉住的版本快照**（快照不可得时返回 `{ version: null }`，轮询按"未达标"保守处理）。若按调用时磁盘现值回答，restart 命令失败被吞、旧 gateway 仍活着时，"磁盘已是新版"会让轮询假阳性通过 → 删备份 → 未验证的新版本在下次自然重启静默激活且无回滚物料

L2 注记（2026-06-11）：进入验证前，worker 先经 L2 结局核对确定 verify 目标——record 推进但未达标时，目标参数化为**实际安装版本**（而非 toVersion）；record 未推进则根本不进验证（no-op 跳过）。验证策略本身（单一权威信号 + ≥ 判定 + 磁盘版本仅诊断）不变；L2 判据是权威安装记录（经官方 inspect），不是磁盘文件。

`coclaw.upgradeHealth` 目前只返回 `{ version }`，因此"版本已升上去但其它东西坏了"这类情况**没有办法在验证阶段检出**。`skipVersion` 的实际入口有三个：**验证失败回滚**、**L2 no-op 跳过**、**host 封顶**（record 推进未达标，实装版本验证通过后对目标版本记跳过）；升级命令自身失败**不**写 skip（瞬态语义）。若未来需要更严的验证（如 scheduler 是否在跑、service 是否注册），可在 `upgradeHealth` 返回里加字段，并由 worker 把"观察到新版本但深层 health 失败"单独归类以决定是否 skip。

## 版本检查细节

### npm view 查询

```js
// 通过 npm 命令查询最新版本，自动使用用户的 .npmrc 配置
execFile('npm', ['view', '@coclaw/openclaw-coclaw', 'version'])
// → "0.2.1"
```

- 使用 `npm view` 而非直接 fetch registry API
  - 自动继承用户完整的 npm 环境配置（registry 镜像、proxy、scoped registry、auth token 等）
  - `.npmrc` 解析规则复杂（项目级/用户级/全局级三层 + scoped registry 语法），不值得自行实现
  - 每小时一次的频率下，npm 进程启动开销（数百毫秒）完全可忽略
- 与本地 `package.json` 中的 version 对比（semver）
- 新版本且不在 skippedVersions 中 → 触发升级

### prerelease 排除

- 判出"有新版"后，latest 为 **prerelease** → 按无新版处理：不 spawn、不写 skip / lastUpgrade（lastCheck 照旧），scheduler 经 `__gateSignalOnce` 去重上报 `upgrade.prerelease-skip version=...`
- 判定用 **semver 语义**（区分 prerelease 与 build metadata，对齐上游口径），不裸看 `-` 后缀
- Why：上游 `plugins update` 对裸 spec / latest 一律拒装 prerelease——prerelease 误挂 latest dist-tag 时若放行，每周期"spawn → update 失败 → 回滚 → 重启网关"无限循环（2026-06-11 实测坐实）。闸不落判定性持久状态，真正式新版出现时正常放行

### 后续演进：CoClaw server 推送

Bridge 握手时上报 `pluginVersion`，server 回传：

```json
{
  "updateAvailable": true,
  "latestVersion": "0.3.0",
  "urgency": "normal"
}
```

届时可替代 npm 轮询，并支持灰度发布等高级能力。

## 安全与稳定性考量

### 不在 gateway_start 时立即检查

- Gateway 启动阶段应尽快完成加载，不做网络 I/O
- 延迟 60–120 分钟（随机抖动），确保 gateway 和所有插件稳定运行后再启动检查，并拉长"升级失败 → worker 触发重启 → 再检查"的循环周期

### spawn detached 进程（含 cgroup 脱逃）

- 升级会触发 gateway 重启，upgrade-worker 不能运行在 gateway 进程内
- 使用 `child_process.spawn(process.execPath, [...], { detached: true, stdio: 'ignore' })`；父进程（gateway）`unref()` 后不会等待子进程
- **detached 不等于脱离 systemd cgroup**：npm+systemd 形态下 service `KillMode=control-group`，worker 触发 `gateway restart` 时整组收 SIGTERM 连自己一起杀掉——重启后半程（健康验证 / 回滚 / 记账 / 上报）整段不可达（2026-06-11 实测坐实）
- 因此 linux+systemd 下 spawn 前先跑毫秒级探针 `systemd-run --user --scope --quiet --collect -- /bin/true`（失败再试无 `--user` 变体，覆盖 system service 形态）；探针通过 → 真 spawn 包成 `systemd-run [--user] --scope --quiet --collect -- <node> worker.js ...`。scope 是 service 的兄弟 cgroup，重启清场打不到；`--scope` 自挪 cgroup 后 exec、不产生 wrapper 进程，child.pid 即 worker 真 pid，锁机制零改动、env 全继承
- 探针失败（容器内 systemd、无 user bus 等）→ 降级裸 spawn + 去重 remoteLog `upgrade.cgroup-escape-failed`；降级形态 worker 仍会被重启杀死，账目由 inflight 对账兜底
- 真 worker **永远只 spawn 一次**，无失败重拉（重拉会把 worker 早期业务失败误判为 spawn 失败拉起第二个 worker，且与锁机制有竞态）
- 非 systemd 形态（macOS / docker / 裸跑）不走 scope 分支，行为不变

### 备份目录

- 位置：`<state-dir>/coclaw/upgrade-backup/<pluginId>/`（2026-06-11 起；worker 经 `OPENCLAW_STATE_DIR` 既有通道解析）。原 `<pluginDir>.bak` 落在 npm 托管目录树内，实测 `plugins update` 后约 46s 被 npm 当 extraneous 修剪，回滚必丢备份；自管目录在 npm 树外免疫 prune
- 原子性保留：先 cp 到临时目录，再 rename 就位；升级前若已存在残留备份，先删除再备份
- restore 首选 rename 回原位；跨设备（EXDEV）退化为 fs.cp + rm
- 残留语义：interrupted 等异常分支**不主动清备份**——保留给人工恢复，下次备份前覆盖；固定目录 + 升级锁保证每插件至多一份，无累积风险。边角知会：interrupted 后磁盘若仍是旧版，下周期会重 spawn 并覆盖旧备份（内容等价，无损失）；仅"磁盘=坏新版 + 又出更新版"的三重巧合窗口下，留给人工恢复的备份可能被新一轮备份（坏新版内容）覆盖
- 历史注记：旧布局下备份在 `extensions/` 内，须以 `.bak` 结尾才不被 gateway 目录扫描误加载；备份迁出插件目录树后该约束不再适用

### dev/link 与非 npm 装置不自动升级

- L0（启动时，同步）：自身包根（realpath）在 state-dir 外 ⇒ dev/link 装置，跳过整个 scheduler——正式安装三代均落 state-dir 内，且不依赖 CLI 可用性（dev/worktree 网关恰是 CLI 异常高发地）
- L1（逐周期）：`openclaw plugins inspect <id> --json` 的 `install.source !== 'npm'`（path/archive/git/...）或无安装记录 ⇒ 本周期跳过（去重的 `upgrade.source-skip` 远程可见）
- 这是本地开发 / 手动装置场景，自动升级会覆盖开发者的代码或无从升级

### Node.js 兼容性

- 插件是纯 ES Module，无 native addon，跨平台风险小
- `fs.cp` 要求 Node.js 16.7+，与 OpenClaw 自身的 Node 版本要求一致
- Windows 路径由 OpenClaw 和 Node.js 内置 API 处理

## 对插件测试的影响

自动升级将发布质量的压力转移到测试环节。要求：

- 维持现有 100% 覆盖率门禁
- prerelease 验证流程必须覆盖"升级场景"（`--upgrade` flag 已支持）
- 新增 auto-upgrade 模块自身的单元测试
- 验证逻辑（`coclaw.upgradeHealth`）的稳定性是升级安全网的基石

## 待定事项

- [ ] 用户通知机制——channel 可用后接入
- [ ] CoClaw server 版本推送——替代 npm 轮询

## 实现备注（2026-03-12）

与原设计的差异和补充：

| 项 | 原设计 | 实现 | 原因 |
|---|---|---|---|
| 适用范围 | 仅跳过 `source === "path"`（link 模式） | 仅对 `source === "npm"` 生效（2026-06-11 起判定经 `plugins inspect --json` 逐周期重验，见下节） | `openclaw plugins update` 仅支持 npm 安装的插件，archive 安装也应跳过 |
| 首次延迟 | 5–10 分钟（待定） | 60–120 分钟随机抖动（早期实现为 5–10 分钟，后调大） | 避免多实例同时发起检查；拉长失败-重启循环周期 |
| 日志轮转 | 待定 | 超过 200 行截断至 100 行 | 已实现 |
| `coclaw.upgradeHealth` 返回格式 | 待定 | `{ "version": "x.y.z" }`（模块加载时刻钉住的版本快照，调用时不读磁盘 package.json；快照不可得返回 `{ "version": null }`） | 已实现（2026-06-11 起改加载时快照，与 inflight 对账同源，见"验证策略"节） |
| 并发控制 | 不加锁 | `__checking` 标志位 + `upgrade.lock` 文件锁（PID 检活 + 110min TTL 超龄清理） | 标志位防止 interval 重叠；文件锁防止 gateway 重启后新 scheduler 与旧 worker 并发；TTL 兜住 worker 被强杀未清锁、PID 被 OS 复用给长命进程导致"永久锁死"的场景（worker 最坏耗时约 36min，TTL 给到约 3 倍余量；选 110min 而非整点 120min 是为了避开巡检间隔 60min 的整数倍临界——否则年龄刚好卡在"未过期"边界会多等一轮巡检才清；超龄即清，不 kill 进程以免误伤被复用 PID 的其他程序） |
| worker 进程 state dir | 未提及 | 通过 `OPENCLAW_STATE_DIR` 环境变量传递给 worker | worker 作为 detached 进程无 runtime，需显式传递 |
| version 参数校验 | 未提及 | `fallbackInstallOldVersion` 校验 semver 格式 | 防御 shell 注入（`shell: true` 下的额外安全层） |
| 备份临时目录命名 | `.bak-tmp` | `.tmp.bak`（历史；2026-06-11 起备份整体迁出插件目录树，`.bak` 后缀扫描约束不再适用，见"备份目录"节） | 旧布局下 OpenClaw gateway 扫描 extensions/ 时仅跳过以 `.bak` 结尾的目录；`.bak-tmp` 不匹配，会在 fs.cp 窗口期被误加载 |
| Gateway 重启方式 | 等待 chokidar 自动重启 | 主动 `openclaw gateway restart` 后进入 upgradeHealth 轮询 | 不依赖文件变更检测机制；gateway 就绪由 RPC 能否成功隐式判定，不再单跑 status |
| 验证链路 | `gateway status` + `plugins list` + `upgradeHealth` 三段串行 | 只轮询 `coclaw.upgradeHealth --json` 直到版本 ≥ toVersion | 前两步对"是否真加载了新代码"无权威判定能力；status 等价于 RPC 可响应，plugins list 的 stdout 曾折行导致 `.includes()` 误判 |
| 验证版本比较 | 未提及 | `got === toVersion` 或 `isNewerVersion(got, toVersion)` | 覆盖 scheduler 发起升级后 npm dist-tag 前移到 `toVersion+1` 的窗口，避免把"装上更新版本"误判为失败 |
| 回滚后 gateway 恢复 | 等待 gateway 重启 | 仅触发 restart，fire-and-forget，不验证旧版本是否回到运行态；2026-06-11 起记账先于 restart，restart 命令失败追加 jsonl 事件 `rollback-restart-failed` | 已知权衡：`rollback` 语义=文件态已恢复，运行态恢复交还重启 / 上游 watcher，不重试——保持实现简单 |
| 回滚是否 skipVersion | 未提及 | 升级命令失败 → 不 skip（瞬态）；验证超时 → skip（保守，避免每小时反复回滚影响用户使用） | 现阶段妥协：upgradeHealth 只返回版本号，无法把"瞬时故障"与"新版本真坏了"彻底分开；选择 skip 防抖动，等真修好的新版本出来再自动升 |
| worker 参数传递 | 未提及 | 通过 `--` 命名参数传递，worker 用 `util.parseArgs` 解析（`--pluginDir/--fromVersion/--toVersion/--pluginId/--pkgName/--baselineVersion`，最后一个可缺——缺时 L2 按"基线不可得"退化） | 清晰的参数传递，避免位置参数歧义 |
| 超时配置 | 未提及 | npm view 30s、plugins update 10min、gateway restart / upgradeHealth 单次调用 30s、回滚兜底 install 10min、upgradeHealth 轮询总超时 5min | plugins update 走 npm 下载，慢网下需 10 分钟；回滚兜底走同一条链路且前置通常已是异常态（本地备份丢失），与 update 对齐给足恢复机会 |
| registry 重试 | 未提及 | 首次 `plugins update` 失败时，自动在 npmjs ⇄ npmmirror 间切换 registry 重试一次 | 国内网络对单一源不稳定；反向 fallback 提升一次 update 成功率 |
| scheduler 注册 | 未提及 | 注册为 gateway service `coclaw-auto-upgrade`（start/stop 生命周期） | 随 gateway 自动启停，无需手动管理生命周期 |
| state.js 职责 | upgrade-state.json 读写 + 升级锁 | state.js 仅处理 state + log；升级锁（upgrade.lock）在 updater.js | 锁逻辑与调度器耦合更紧密 |

## 实现备注（2026-06-11 摆脱安装账本）

设计稿见 `docs/designs/auto-upgrade-ledger-free-gate.md`（已归档）。相对 2026-03-12 实现的增量：

| 项 | 旧实现 | 现实现 | 原因 |
|---|---|---|---|
| 安装记录读取 | 直读账本 JSON（`loadInstallRecord` / legacy loadConfig 回落） | 账本函数全部删除；统一走 `inspectPluginInstall`（updater-check.js，gateway L1 与 worker L2 共用；归一化返回 `{ok,install}/{ok:false,reason}`，永不抛） | 上游 ≥2026.6.1 迁 SQLite，旧 JSON 停更，直读必错 |
| dev/link 判定 | 读账本 `source === "path"` | L0 位置自检：`isPathInside(realpath(stateDir), realpath(pkgRoot))`，包根在外即跳过 scheduler；只信 runtime `resolveStateDir`，runtime 不可用 / 判定抛错不下"在外"结论 | 不依赖 CLI 可用性；env/home 兜底可能与上游真实 state-dir 分叉 |
| 来源门禁时序 | start() 一次性判定 | L1 在 `__check` 内逐周期重验（有新版才 inspect，~3s 子进程不冻结网关；局部 try/catch 防外层 catch-all 吞信号） | 瞬时失败下周期自愈，消灭"一次误判 → 永久停摆" |
| 达标判据 | 各处各写比较式 | `isVersionReached`（worker-verify.js）：`===` 或 `isNewerVersion`，健康轮询与 L2 同构复用 | `isNewerVersion` 是严格大于，等号须显式 |
| 升级后处置 | exit 0 即无条件 restart + 轮询 | L2 结局矩阵（见"upgrade-worker 详细流程"）；新增 `noop-skip` result token 与 verify 目标参数化 | update exit 0 不代表真升级 |
| 远程信号 | available 在来源判定前发 | `upgrade.available` 后移到 L1 放行后；稳定态信号（available / source-skip / gate-inspect-failed / install-path-fallback）经 `__gateSignalOnce` 按 (原因, toVersion) 去重，重启重置 | 永不升级的装置不该每小时刷屏 |
| worker 基线 | 无 | spawner 经 `--baselineVersion` 传 `install.version`（缺失不传 flag） | L2 区分"record 推进 / 未推进"的判定基线 |
| 脚本侧 | `_lib.sh` 直读账本 JSON + 硬编码 `$HOME/.openclaw` | 改走 `plugins inspect --json`（主 shell memo 化、无 JSON 回落、CLI 失败响亮报错）；state-dir 尊重 `OPENCLAW_STATE_DIR` | 与 updater 同一契约来源 |
