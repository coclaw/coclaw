# OpenClaw Scoped Plugin Name Bug 分析

> 日期：2026-03-07
> 影响版本：OpenClaw 2026.3.2 (85377a2)

## 问题描述

将插件 npm 包名从 `openclaw-coclaw`（无 scope）改为 `@coclaw/openclaw-coclaw`（scoped）后，`install` 命令成功，但 `update` 和 `uninstall` 命令无法找到已安装的插件。

```bash
# install 成功
openclaw plugins install @coclaw/openclaw-coclaw
# -> Installed plugin: openclaw-coclaw

# update 失败
openclaw plugins update @coclaw/openclaw-coclaw
# -> No install record for "@coclaw/openclaw-coclaw".

# uninstall 失败
openclaw plugins uninstall @coclaw/openclaw-coclaw
# -> Plugin not found: @coclaw/openclaw-coclaw
```

## 根因

`install`、`update`、`uninstall` 三个命令对 scoped 包名的处理不一致。

### install 流程（正确）

源码位置：`src/plugins/install.ts:237`

```typescript
const npmPluginId = pkgName ? unscopedPackageName(pkgName) : "plugin";
```

`install` 会通过 `unscopedPackageName()` 将 `@coclaw/openclaw-coclaw` 归一化为 `openclaw-coclaw`，以此作为 plugin ID 用于：
- 安装目录：`~/.openclaw/extensions/openclaw-coclaw/`
- `plugins.entries` 的 key
- `plugins.installs` 的 key

### update 流程（有 bug）

源码位置：`src/cli/plugins-cli.ts:738` + `src/plugins/update.ts:200`

```typescript
// plugins-cli.ts:738 — 用户输入原样传入
const targets = opts.all ? Object.keys(installs) : id ? [id] : [];

// update.ts:200 — 用原始输入查找 install record
const record = installs[pluginId];
```

用户输入 `@coclaw/openclaw-coclaw` 被原样作为 key 查找 `plugins.installs`，但实际 key 是 `openclaw-coclaw`，因此找不到。

### uninstall 流程（有 bug）

源码位置：`src/cli/plugins-cli.ts:603`

```typescript
const plugin = report.plugins.find((p) => p.id === id || p.name === id);
const pluginId = plugin?.id ?? id;
```

用 `@coclaw/openclaw-coclaw` 去匹配 `p.id`（值为 `openclaw-coclaw`），匹配不上。fallback 到原始输入，后续查 `entries`/`installs` 同样找不到。

## 临时解决方案

使用 plugin ID（而非 npm 包名）来执行 update/uninstall 操作：

```bash
openclaw plugins update coclaw
openclaw plugins uninstall coclaw
```

> 注：我们已将 `openclaw.plugin.json` 的 `id` 从 `openclaw-coclaw` 改为 `coclaw`。
> OpenClaw 优先使用 manifest id 作为 plugin ID，因此实际 plugin ID 为 `coclaw`。

## 补充：plugin ID 确定优先级

OpenClaw 确定 plugin ID 的优先顺序（`src/plugins/install.ts:243-249`）：
1. `openclaw.plugin.json` 中的 `id`（经 `unscopedPackageName()` 处理）
2. `package.json` 中的 `name`（经 `unscopedPackageName()` 处理）

## 建议

向 OpenClaw 提 issue/PR，在 `update` 和 `uninstall` 的 CLI 入口对用户输入做 `unscopedPackageName()` 归一化，与 `install` 保持一致。
