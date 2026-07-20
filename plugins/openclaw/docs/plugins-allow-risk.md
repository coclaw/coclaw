# plugins.allow 白名单机制分析与隐患

> 调查日期：2026-03-08
> 涉及版本：OpenClaw 源码 main 分支（截至同日）
> 关键源码：`src/plugins/loader.ts`、`src/plugins/config-state.ts`、`src/config/plugins-allowlist.ts`、`src/plugins/enable.ts`

## 背景

插件安装后，gateway 日志中会出现以下 warn 级别日志：

```
[plugins] plugins.allow is empty; discovered non-bundled plugins may auto-load:
openclaw-coclaw (~/.openclaw/extensions/openclaw-coclaw/index.js).
Set plugins.allow to explicit trusted ids.
```

## 机制分析

### 警告触发条件（loader.ts `warnWhenAllowlistIsOpen`）

同时满足以下三项时触发：

1. `plugins.enabled !== false`（插件系统未被禁用）
2. `plugins.allow` 为空数组或不存在（默认状态）
3. 存在至少一个 origin 不是 `bundled` 的已发现插件

该警告是安全态势提示，**不影响插件加载与运行**。

### `plugins.allow` 的语义（config-state.ts `resolveEnableState`）

```typescript
// allow 为空 → 不做限制，所有插件按其他规则正常加载
// allow 非空 → 严格白名单：不在列表中的非 bundled 插件直接 disable
if (config.allow.length > 0 && !config.allow.includes(id)) {
  return { enabled: false, reason: "not in allowlist" };
}
```

即：**一旦 `plugins.allow` 中有任何条目，它就变成严格白名单模式。**

### 原生命令对 allow 的操作

| 操作 | 是否修改 allow |
|------|----------------|
| `openclaw plugins install <path>` | 仅当 allow 已是数组时追加**当前插件 id**；allow 不存在时不创建 |
| `openclaw plugins enable <id>` | 同上 |
| 手动编辑 `openclaw.json` | 用户完全控制 |

关键函数 `ensurePluginAllowlisted`（plugins-allowlist.ts）：

```typescript
// 只有当 allow 已经是数组时才追加；不存在则跳过
if (!Array.isArray(allow) || allow.includes(pluginId)) {
  return cfg;
}
return { ...cfg, plugins: { ...cfg.plugins, allow: [...allow, pluginId] } };
```

**结论：没有任何原生命令会在 allow 不存在时主动创建它。每次操作也只处理自身的 pluginId，不会遍历已安装插件补齐。**

## 隐患场景

### 场景：用户手动设置 allow 导致我们的插件被禁用

1. 用户先安装我们的插件 → `plugins.allow` 不存在 → 一切正常
2. 用户后来安装了插件 B，出于安全意识（或按日志提示）在 `openclaw.json` 中设置了 `plugins.allow: ["plugin-b"]`
3. 下次 gateway 启动 → 我们的插件因 `"not in allowlist"` 被禁用
4. 用户可能不会立刻察觉，直到发现 CoClaw 功能不可用

### 场景：通过 install 安装第二个插件触发连锁

1. 用户已经出于某种原因设置了 `plugins.allow: []`（空数组，但已是数组类型）
2. 执行 `openclaw plugins install <plugin-b>` → `ensurePluginAllowlisted` 将 `plugin-b` 加入 allow
3. 此时 allow 变为 `["plugin-b"]` → 我们的插件被排除

## 风险评估

- **触发概率**：低。需要用户主动创建/编辑 `plugins.allow`，正常流程不会自动创建
- **影响程度**：高。插件被静默禁用，用户可能难以自行排查
- **可检测性**：中。gateway 日志中会显示 `"not in allowlist"` 的 disable 原因，但普通用户不一定会查看日志

## 当前决策

**不主动设置 `plugins.allow`**，原因：

1. 该警告仅是安全提示，不阻塞功能
2. 设置后会将白名单模式强加给用户，可能导致其他已安装插件失效
3. 没有安全的方式"只消除警告而不引入副作用"

## 未来可考虑的应对

- **文档层面**：在插件安装文档 / README 中提示用户——若已设置 `plugins.allow`，需确保包含 `openclaw-coclaw`
- **运行时检测**：在 bridge 连接失败或插件未注册成功时，检查自身是否因 allowlist 被禁用，向用户输出明确提示（需 OpenClaw 提供诊断 API 支持）
- **向 OpenClaw 反馈**：建议 `openclaw plugins install` 在创建 allow 列表时自动补齐所有已安装的非 bundled 插件，而非仅追加当前安装的插件
