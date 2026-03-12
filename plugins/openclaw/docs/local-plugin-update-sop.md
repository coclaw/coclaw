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

脚本会自动：卸载已有安装（如有）→ link → restart gateway → 验证。

### 日常更新

```bash
# 改代码后
openclaw gateway restart
```

不需要重新 install。Gateway 重启时会重新加载 link 路径下的代码。

### link 模式下的配置状态

- `plugins.load.paths` 包含插件源码路径
- `plugins.entries.openclaw-coclaw.enabled = true`
- `plugins.installs.openclaw-coclaw.source = "path"`

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

## 注意事项

- 插件代码在 gateway 进程内执行，语法错误会导致 gateway 启动失败
- 代码更新不会立即生效，需 restart gateway
- 不要把"反复 uninstall + install"作为日常流程
- 不要手动删除 `~/.openclaw/extensions/` 目录后不校验 config 就重启
