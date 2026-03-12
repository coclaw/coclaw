# CoClaw 插件自动升级方案

> 状态：已实现（2026-03-12）
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
| 检查频率 | gateway 启动后延迟 5–10 分钟首次检查，之后每 1 小时 | 启动阶段不增加开销；每小时对 npm registry 无压力 |
| 升级执行方式 | spawn detached node 进程运行 worker.js | 升级会触发 gateway 重启，执行者不能在 gateway 进程内 |
| Node 路径 | `process.execPath` | 确保与 gateway 使用同一 node 版本 |
| npm registry | 通过 `npm view` 命令查询 | 自动继承用户完整的 npm 环境配置（registry、proxy、auth 等），无需自行解析 `.npmrc` |
| 备份方式 | `fs.cp()` 物理复制插件目录 | Node 16.7+ 内置 API，跨平台，无依赖；插件目录很小（纯 JS，无 node_modules） |
| 回滚策略 | 首选 mv 备份目录，兜底从 npm 安装旧版本 | 回滚时网络状况未知，物理备份更可靠 |
| 验证标准 | gateway running + 插件已加载 + 升级模块可响应 | 最低保证：插件还能继续自我升级 |
| 失败版本处理 | 记录在 upgrade-state.json 中，后续跳过 | 避免反复升级到已知有问题的版本 |
| 升级日志 | `upgrade-log.jsonl`，只追加 | 仅用于运维可观测性，不承担兜底职责 |
| 并发控制 | `__checking` 标志位 + `upgrade.lock` 文件锁（PID 检活） | 标志位防止 interval 重叠检查；文件锁防止 gateway 重启后新 scheduler 与旧 worker 并发 |
| 用户通知 | 暂不做 | channel 机制尚未启用，后续接入成本低 |
| 独立升级插件 | 不采用 | 鸡生蛋问题；OpenClaw 插件生态尚早期；Node.js 插件不存在二进制锁定 |

## 文件布局

```
~/.openclaw/coclaw/
├── bindings.json          # 已有，绑定信息（不变）
├── upgrade-state.json     # 新增，升级运行时状态
├── upgrade-log.jsonl      # 新增，升级历史记录（只追加）
└── upgrade.lock           # 新增，升级锁（记录 worker PID，防止并发）

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
  "lastUpgrade": {
    "from": "0.2.0",
    "to": "0.2.1",
    "result": "rollback",
    "ts": "2026-03-11T09:30:00Z"
  }
}
```

- `skippedVersions`：升级失败并回滚后，将该版本加入；检查时跳过这些版本
- 当 npm 上出现比所有 skippedVersions 更新的版本时，正常触发升级
- `lastCheck`：上次版本检查时间，用于调度器判断是否该检查
- `lastUpgrade`：上次升级的摘要信息

## upgrade-log.jsonl 格式

每行一个 JSON 对象，只追加写入（`fs.appendFile`）：

```jsonl
{"ts":"2026-03-11T09:30:00Z","from":"0.2.0","to":"0.2.1","result":"ok"}
{"ts":"2026-03-12T10:00:00Z","from":"0.2.1","to":"0.2.2","result":"rollback","error":"gateway failed to start within timeout"}
```

文件超过 200 行时可截断旧记录（保留最近 100 行）。

## 升级流程

### 整体时序

```
gateway 启动
  → 插件 register()
    → scheduler 启动（不立即检查）
      → 延迟 5–10 分钟后首次检查
      → 此后每 1 小时检查一次

检查流程：
  checker 查询 npm registry（读取用户 .npmrc 中的 registry 配置）
  → 对比本地版本 vs latest 版本
  → 跳过 skippedVersions 中的版本
  → 有新版本 + 升级锁未被持有 → spawner 启动 upgrade-worker（detached 子进程）
  → 写入 upgrade.lock（记录 worker PID）

upgrade-worker（独立 node 进程）：
  1. 读取当前版本号并记录
  2. 物理备份 extensions/openclaw-coclaw/ → extensions/openclaw-coclaw.bak/
  3. 执行 openclaw plugins update openclaw-coclaw
  4. 主动执行 openclaw gateway restart，然后轮询等待 gateway 就绪
  5. 验证升级结果
  6a. 成功 → 删除备份，记录日志，更新 state
  6b. 失败 → 恢复备份 → 主动重启并等待 gateway → 记录失败版本 → 记录日志
```

### upgrade-worker 详细流程

```
┌─ 开始 ──────────────────────────────────────────────────────┐
│                                                              │
│  1. 读取当前插件版本号（从 extensions 目录的 package.json）    │
│  2. fs.cp extensions/openclaw-coclaw/ → .bak/                │
│                                                              │
│  3. child_process.execFile('openclaw', ['plugins', 'update', │
│     'openclaw-coclaw'])                                      │
│                                                              │
│  4. 主动 openclaw gateway restart，然后轮询                   │
│     openclaw gateway status 等待就绪（超时 60 秒）            │
│                                                              │
│  5. 验证：                                                    │
│     a. openclaw gateway status → running                     │
│     b. openclaw plugins list → openclaw-coclaw 已加载         │
│     c. openclaw gateway call coclaw.upgradeHealth → 响应正常  │
│                                                              │
│  ┌─ 验证通过 ──────────────┐  ┌─ 验证失败 ─────────────────┐ │
│  │ fs.rm .bak/             │  │ fs.rm extensions/openclaw-  │ │
│  │ 写入 upgrade-log.jsonl  │  │   coclaw/ (损坏的新版)      │ │
│  │ 更新 upgrade-state.json │  │ fs.rename .bak/ →           │ │
│  │ 退出                    │  │   extensions/openclaw-coclaw│ │
│  └─────────────────────────┘  │                             │ │
│                               │ 如果 mv 失败：              │ │
│                               │   execFile openclaw plugins │ │
│                               │     install @coclaw/...@旧版│ │
│                               │                             │ │
│                               │ 等待 gateway 重启           │ │
│                               │ skippedVersions += 新版本   │ │
│                               │ 写入 upgrade-log.jsonl      │ │
│                               │ 更新 upgrade-state.json     │ │
│                               │ 退出                        │ │
│                               └─────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 验证策略

验证的核心目标：**确保插件还能继续自我升级**。

验证步骤（按顺序执行，任一失败即判定升级失败）：

1. **Gateway 存活**：轮询 `openclaw gateway status`，等待其返回 `running`（超时 60 秒）
2. **插件已加载**：`openclaw plugins list` 输出中包含 `openclaw-coclaw` 且状态正常
3. **升级模块健康**：`openclaw gateway call coclaw.upgradeHealth --json` 返回成功响应

第 3 步需要插件注册一个轻量级 gateway method `coclaw.upgradeHealth`，仅返回当前版本号即可。这同时验证了插件代码能正常执行、gateway method 注册链路正常。

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
- 延迟 5–10 分钟，确保 gateway 和所有插件稳定运行后再启动检查

### spawn detached 进程

- 升级会触发 gateway 重启，upgrade-worker 不能运行在 gateway 进程内
- 使用 `child_process.spawn(process.execPath, [...], { detached: true, stdio: 'ignore' })`
- 父进程（gateway）`unref()` 后不会等待子进程

### 备份目录命名

- 使用固定名称 `extensions/openclaw-coclaw.bak/`
- 升级前若 `.bak` 已存在（上次异常退出未清理），先删除再备份
- 确保备份操作的原子性：先 cp 到 `.tmp.bak`，再 rename 到 `.bak`
- **命名约束**：备份目录（含临时目录）必须以 `.bak` 结尾。OpenClaw gateway 启动时扫描 `extensions/` 下所有子目录并尝试作为插件加载，但会跳过以 `.bak` 结尾的目录（`discovery.ts` `shouldIgnoreScannedDirectory`）。若临时目录不以 `.bak` 结尾，在 `fs.cp` 窗口期内 gateway 重启会将不完整的目录误加载为插件

### link 模式下不自动升级

- 当 `plugins.installs.openclaw-coclaw.source === "path"`（link 模式）时，跳过自动升级
- 这是本地开发模式，自动升级会覆盖开发者的代码

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
| 适用范围 | 仅跳过 `source === "path"`（link 模式） | 仅对 `source === "npm"` 生效 | `openclaw plugins update` 仅支持 npm 安装的插件，archive 安装也应跳过 |
| 首次延迟 | 5–10 分钟（待定） | 5–10 分钟随机抖动 | 避免多实例同时发起检查 |
| 日志轮转 | 待定 | 超过 200 行截断至 100 行 | 已实现 |
| `coclaw.upgradeHealth` 返回格式 | 待定 | `{ "version": "x.y.z" }`（通过 `getPackageInfo()` 读取 package.json） | 已实现 |
| 并发控制 | 不加锁 | `__checking` 标志位 + `upgrade.lock` 文件锁（PID 检活 + 过期清理） | 标志位防止 interval 重叠；文件锁防止 gateway 重启后新 scheduler 与旧 worker 并发 |
| worker 进程 state dir | 未提及 | 通过 `OPENCLAW_STATE_DIR` 环境变量传递给 worker | worker 作为 detached 进程无 runtime，需显式传递 |
| version 参数校验 | 未提及 | `fallbackInstallOldVersion` 校验 semver 格式 | 防御 shell 注入（`shell: true` 下的额外安全层） |
| 备份临时目录命名 | `.bak-tmp` | `.tmp.bak` | OpenClaw gateway 扫描 extensions/ 时仅跳过以 `.bak` 结尾的目录；`.bak-tmp` 不匹配，会在 fs.cp 窗口期被误加载 |
| Gateway 重启方式 | 等待 chokidar 自动重启 | 主动 `openclaw gateway restart`，再轮询 status | 不依赖文件变更检测机制，确保可靠重启 |
| 验证命令 | `openclaw gateway call coclaw.upgradeHealth` | 添加 `--json` 标志 | 确保输出为可解析 JSON |
| worker 参数传递 | 未提及 | 通过 `--` 命名参数传递，worker 用 `util.parseArgs` 解析（`--pluginDir/--fromVersion/--toVersion/--pluginId/--pkgName`） | 清晰的参数传递，避免位置参数歧义 |
| 超时配置 | 未提及 | npm view 30s、plugins update 120s、命令执行 30s、gateway 就绪 60s | 各环节均有超时保护 |
| scheduler 注册 | 未提及 | 注册为 gateway service `coclaw-auto-upgrade`（start/stop 生命周期） | 随 gateway 自动启停，无需手动管理生命周期 |
| state.js 职责 | upgrade-state.json 读写 + 升级锁 | state.js 仅处理 state + log；升级锁（upgrade.lock）在 updater.js | 锁逻辑与调度器耦合更紧密 |
