# OpenClaw 插件管理机制参考

> 基于 OpenClaw 源码分析，记录插件安装/卸载/更新的实际行为，以及 gateway 自动重启机制。
> 源码版本与本地安装的 OpenClaw 一致。

## 三种安装模式

| | **link** (`--link`) | **npm** | **archive**（本地路径/tarball） |
|---|---|---|---|
| `source` 值 | `"path"` | `"npm"` | `"archive"` |
| 文件是否复制 | 否，直接引用源路径 | 是，到 `~/.openclaw/extensions/<id>/` | 是，到 `~/.openclaw/extensions/<id>/` |
| `plugins.load.paths` | 添加源路径 | 不添加 | 不添加 |
| `openclaw plugins update` | 不支持（skip） | 支持 | 不支持（skip） |
| 卸载时删除文件 | 不删除源目录 | 删除 extensions 副本 | 删除 extensions 副本 |

## openclaw.json 中的配置结构

```jsonc
{
  "plugins": {
    "load": {
      "paths": ["/path/to/local/plugin"]   // 仅 link 模式使用
    },
    "entries": {
      "openclaw-coclaw": {
        "enabled": true
        // config: {} — 插件级配置（可选）
      }
    },
    "installs": {
      "openclaw-coclaw": {
        "source": "path" | "npm" | "archive",
        "spec": "...",            // 原始 spec
        "sourcePath": "...",      // 来源路径
        "installPath": "...",     // 安装位置
        "version": "0.1.6",
        // npm 特有:
        "resolvedName": "@coclaw/openclaw-coclaw",
        "resolvedVersion": "0.1.6",
        "integrity": "sha512-...",
        "resolvedAt": "2026-03-10T..."
      }
    }
  }
}
```

## install 行为

- **已安装同 ID 插件时**：拒绝安装，提示 `"plugin already exists: <dir> (delete it first)"`，exit code 1。
- **不支持 `--force` 覆盖**：必须先 uninstall 再重新 install。
- 内部使用 `mode: "install"`，通过 `ensureInstallTargetAvailable()` 检查目标目录是否存在。

源码：`src/plugins/install.ts`、`src/infra/install-target.ts`、`src/cli/plugins-cli.ts`

## uninstall 行为

- 移除 `plugins.entries[id]`、`plugins.installs[id]`。
- link 模式额外移除 `plugins.load.paths` 中的对应路径。
- 默认删除 `installPath` 目录（link 模式例外，不删除源目录）。
- 支持 `--keep-files`（保留文件）、`--force`（跳过确认）、`--dry-run`。

源码：`src/plugins/uninstall.ts`

## update 行为

- **仅支持 `source: "npm"` 的插件**，对 link 和 archive 直接 skip。
- **不支持本地 tarball**：只从 npm registry 下载。
- 内部使用 `mode: "update"`，允许覆盖已存在的目标目录。
- **同版本时**：仍会重新提取文件，状态标记为 `"unchanged"`，exit code 0。
- **插件不存在时**：skip，提示 `"No install record for "<id>""`，exit code 0。
- 支持 `--all`（更新所有 npm 插件）和 `--dry-run`。

源码：`src/plugins/update.ts`

## Gateway 自动重启机制

### 核心机制

OpenClaw gateway 使用 **chokidar** 监听 `openclaw.json` 的文件变更。当检测到变更时，根据变更路径匹配 reload 规则，决定是 hot reload 还是 restart。

配置：`gateway.reload.mode`（默认 `"hybrid"`）

| 模式 | 行为 |
|------|------|
| `"off"` | 忽略所有配置变更 |
| `"restart"` | 任何变更都全量重启 |
| `"hot"` | 尝试进程内 reload，跳过需要 restart 的变更 |
| `"hybrid"`（默认） | 优先 hot reload，需要时自动 restart |

### Reload 规则

每个 config 路径有对应的 reload 类型：

- `plugins.*` → **restart**（全量重启）
- 其他路径根据类型可能是 hot / restart / none

**关键结论**：`plugins.entries`、`plugins.installs`、`plugins.load` 的任何变更都触发 gateway 全量重启。

### 重启流程

1. chokidar 检测到 `openclaw.json` 变更（stabilityThreshold: 200ms）
2. 构建 reload plan，匹配变更路径的 reload 规则
3. 如果需要 restart：
   - 检查是否有活跃操作（pending replies 等）
   - 如有活跃操作，延迟到空闲后再重启
   - 通过 SIGUSR1 信号触发重启（具体方式因平台而异：launchctl / systemd / Windows）

### 对插件开发的影响

- `openclaw plugins install/uninstall/update` 修改 `openclaw.json` 后，gateway 会**自动重启**
- CLI 打印的 `"Restart the gateway to load plugins"` 是提示信息，实际上 gateway 已经在自动重启
- 脚本中显式调用 `openclaw gateway restart` 会导致**二次重启**（幂等但多余）
- 当前脚本保留显式 restart 作为保险，后续确认稳定后可移除

源码：`src/gateway/config-reload.ts`、`src/gateway/config-reload-plan.ts`、`src/gateway/server-reload-handlers.ts`

## 绑定信息存储（CoClaw 特有）

绑定信息存储在 `~/.openclaw/coclaw/bindings.json`，**不在 `openclaw.json` 中**。因此：

- 绑定变更**不会触发** gateway 自动重启
- CLI bind/unbind 通过 `coclaw.bind` / `coclaw.unbind` gateway RPC 在 gateway 进程内执行，由 RPC handler 内部管理 bridge 生命周期
