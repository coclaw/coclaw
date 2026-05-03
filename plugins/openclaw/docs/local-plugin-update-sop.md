# CoClaw OpenClaw 插件本地开发 SOP

> 本地开发、模式切换、预发布验证的操作指南。

## 安装模式

插件有两种安装模式，通过脚本可在任意状态间切换：

| 模式 | 用途 | OpenClaw install record |
|------|------|------------------------|
| **link** | 本地开发调试 | `source: "path"` |
| **npm** | 生产 / 升级测试 | `source: "npm"` |

绑定信息（`~/.openclaw/coclaw/bindings.json`）独立于安装模式，切换不会丢失。

## 日常开发（link 模式）

### 首次设置

```bash
pnpm run link
```

脚本会自动：卸载已有安装（如有）→ 构建 stage 目录 → link → restart gateway → 验证。

### stage 目录与安全扫描

OpenClaw 2026-04-10 起的安装时安全扫描（PR #63891）会拒绝 `node_modules/**` 下任何指向 install root 外的 symlink，这与 pnpm workspace 的默认布局冲突——插件 `node_modules/` 里所有依赖都是软链到 monorepo 根 `.pnpm/`。`--dangerously-force-unsafe-install` 仅对代码模式扫描生效，对这一条无效。

解法是 `link.sh` 先用 `pnpm deploy` 在 `plugins/openclaw/.build/link-stage/` 产出**扁平依赖**副本（软链都指向 stage 自身的 `.pnpm/`），再把 `src/` 替换为回指真源目录的 symlink。

为什么只 symlink `src/`：OpenClaw discovery 还有两条**realpath-in-root**检查——入口 `index.js` 经 `checkSourceEscapesRoot`、`package.json` 与 `openclaw.plugin.json` 经 `openBoundaryFileSync`，任何 realpath 跑出 stage 的符号链都会被拒。这三个必须保持 deploy 出的真文件拷贝。`src/**` 只被 Node runtime `require` 加载，自动跟随 symlink，且不经过任何 boundary 检查；这是唯一兼顾"安全扫描"和"改代码即时生效"的交集。

### 日常更新

```bash
# 改 src/** 后
openclaw gateway restart
```

`src/**` 是 symlink，改完重启即可。**改以下任一项都需要重跑 `pnpm run link` 重建 stage**：
- `package.json`（无论是 deps 还是版本号）
- `openclaw.plugin.json`
- `index.js`
- 工作区内 `@coclaw/pion-node` 等依赖升级

### link 模式下的配置状态

- `~/.openclaw/openclaw.json` 中：
  - `plugins.load.paths` 包含 stage 目录路径（`plugins/openclaw/.build/link-stage`）
  - `plugins.entries.openclaw-coclaw.enabled = true`
- `~/.openclaw/plugins/installs.json` 中（OpenClaw 2026.5 起新增的安装记账文件，`plugins.installs` 已被显式标记为 transient 不再持久化到 `openclaw.json`）：
  - `installRecords.openclaw-coclaw.source = "path"`
  - `installRecords.openclaw-coclaw.sourcePath === installPath`（指向 stage 目录）
- 脚本 `_lib.sh` 的 `get_install_mode()` 据此判定当前是否处于 link 模式

## 模式切换

```bash
pnpm run link           # 切换到 link（从任意状态）
pnpm run install:npm    # 切换到 npm（从任意状态）
pnpm run unlink         # 卸载 link
pnpm run uninstall:npm  # 卸载 npm
```

脚本会自动检测当前模式并处理转换，无需手动卸载。

## 预发布验证

发布到 npm 前，验证 tarball 能正确安装和运行：

```bash
# 全新安装验证
pnpm run release:pre

# 升级验证（先装 npm 旧版，再用本地包覆盖）
pnpm run release:pre -- --upgrade
```

流程：`pnpm verify` → `npm pack` → 卸载 → 安装 tarball → 验证 → 手动确认 → 恢复原模式。

## 故障排查

### `unknown channel id: coclaw`

表示配置中有 `channels.coclaw`，但插件未成功加载。恢复顺序：

1. 先修复插件加载（确保 install 成功）
2. 再 `openclaw gateway restart`

不要删除 `channels.coclaw` 作为常规方案。

### 检查配置状态

```bash
openclaw gateway status
openclaw plugins doctor
openclaw plugins list
```

## Gateway 自动重启

OpenClaw gateway 通过 chokidar 监听 `openclaw.json`。`plugins.*` 路径的变更会自动触发全量重启（`gateway.reload.mode` 默认 `"hybrid"`）。

这意味着 `openclaw plugins install/uninstall/update` 修改配置后，gateway 会自动重启。脚本中的显式 `openclaw gateway restart` 实际上会导致二次重启（幂等但多余），当前作为保险保留。

注意：绑定信息存储在 `bindings.json`（非 `openclaw.json`），不会触发自动重启。

详见 `docs/openclaw-plugin-management.md`。

## 已知坑位

### 手动删除 extensions 目录会让 openclaw.json 配置失效（2026-02-28）

**症状**：先 `rm -rf ~/.openclaw/extensions/openclaw-coclaw` 再 `openclaw plugins install <path>`，gateway 启动告警或失败。

**原因**：`openclaw.json` 中 `plugins.load.paths` 仍引用已被删除的目录路径，gateway 启动时会按这条路径去解析 plugin，路径不存在 → 配置无效。OpenClaw plugins install 改写配置的逻辑不会主动检查并修复"指向已不存在路径的旧 entry"。

**正确顺序**（任何场景不要手动删 extensions/<id> 目录）：

```bash
openclaw plugins install <path>      # 让 OpenClaw 统一改写配置
openclaw gateway restart             # 应用新配置
openclaw gateway status              # 确认 channel 已加载
openclaw plugins doctor              # 二次校验
```

**若已经手动删了**：先同步从 `~/.openclaw/openclaw.json` 移除 `plugins.load.paths` 中对应条目和 `plugins.entries.openclaw-coclaw`，再重启 gateway，最后才能重新 install。

## 注意事项

- 插件代码在 gateway 进程内执行，语法错误会导致 gateway 启动失败
- 代码更新不会立即生效，需 restart gateway
- 不要把"反复 uninstall + install"作为日常流程
- 不要手动删除 `~/.openclaw/extensions/` 目录后不校验 config 就重启（详见上节）
