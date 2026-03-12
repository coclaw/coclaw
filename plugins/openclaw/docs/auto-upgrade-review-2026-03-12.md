# auto-upgrade 模块代码审查（2026-03-12）

> 审查范围：`src/auto-upgrade/` 全部 7 个源文件 + 7 个测试文件
> 状态：审查完成，待实施

## 整体评估

模块设计扎实，154 个测试全部通过。架构分层清晰（scheduler → checker → spawner → worker），备份策略合理（物理备份 + npm fallback 双层回滚），并发控制到位，安全防御充分。

以下是发现的问题，按优先级排列。

---

## 1. [关键] `upgradeHealth` 未验证自动升级调度器是否在运行

**位置**：`index.js:109-117`

**现状**：`coclaw.upgradeHealth` 仅调用 `getPackageInfo()` 读取版本号，不检查 scheduler 状态。

**风险场景**：
1. 新版本的 `shouldSkipAutoUpgrade` 有 bug（总是返回 true），或 scheduler 启动逻辑有 bug
2. Worker 升级 → gateway 重启 → `upgradeHealth` 返回版本号 ✓
3. 验证通过，备份被删除
4. 但 scheduler 实际未启动，自动升级**永久失效**
5. 必须等用户手动升级

**修复方案**：`upgradeHealth` 同时验证 `scheduler.__running === true`。scheduler 和 handler 在同一闭包内可直接引用：

```js
api.registerGatewayMethod('coclaw.upgradeHealth', async ({ respond }) => {
	try {
		const { version } = await getPackageInfo();
		if (!scheduler.__running) {
			respond(false, { error: 'Auto-upgrade scheduler not running' });
			return;
		}
		respond(true, { version });
	} catch (err) {
		respondError(respond, err);
	}
});
```

**向后兼容性**：旧版本 worker 调用此方法时，`respond(false, ...)` 会导致 `openclaw gateway call` 返回非零退出码，`verifyUpgradeHealth` 抛异常触发回滚。因此此改进**从第一次部署起就有效**。

---

## 2. [重要] Worker 进程退出时未清理 `upgrade.lock`

**位置**：`worker.js` 的 `main()` 函数（`/* c8 ignore start */` 区域）

**现状**：worker 执行完毕直接 `process.exit()`，lock 文件遗留。依赖下次 scheduler 检查时通过 PID 检活清理。

**影响**：
- 最长需等 1 小时才能清理
- 极端情况下 PID 被操作系统重用，误判为"锁被持有"

**修复方案**：worker `main()` 中添加 finally 块清理 lock：

```js
const lockPath = nodePath.join(
	process.env.OPENCLAW_STATE_DIR ?? nodePath.join(os.homedir(), '.openclaw'),
	'coclaw', 'upgrade.lock'
);
try {
	await runUpgrade({ ... });
} finally {
	await fs.rm(lockPath, { force: true }).catch(() => {});
}
```

---

## 3. [重要] `skippedVersions` 只增不减

**位置**：`state.js:72-80`（`addSkippedVersion`）、`updater-check.js:96-99`

**现状**：版本一旦加入 `skippedVersions` 永不移除。成功升级到更新版本后旧条目已无意义。

**影响**：列表缓慢增长（实际增长很慢，每个失败版本一条）。

**修复方案**：升级成功后清理 <= 当前版本的旧条目。在 `worker.js` 成功路径中：

```js
// 成功后清理旧的 skippedVersions
const state = await readState();
if (Array.isArray(state.skippedVersions) && state.skippedVersions.length) {
	state.skippedVersions = state.skippedVersions.filter(
		v => isNewerVersion(v, toVersion)
	);
	await writeState(state);
}
```

---

## 4. [中等] `restoreFromBackup` 的 rm + rename 非原子

**位置**：`worker-backup.js:52-55`

**现状**：
```js
await fs.rm(pluginDir, { recursive: true, force: true });
await fs.rename(backupDir, pluginDir);
```

**风险**：进程在 `fs.rm` 后、`fs.rename` 前被 kill（OOM killer、系统崩溃），pluginDir 已删但 .bak 未到位。Gateway 重启找不到插件目录。

**修复方案**：先 rename 旧目录到 `.old.bak`（被 OpenClaw 忽略），再 rename 备份到位：

```js
const oldDir = `${pluginDir}.old.bak`;
await fs.rm(oldDir, { recursive: true, force: true });
try {
	await fs.rename(pluginDir, oldDir);
} catch {
	// pluginDir 可能已不存在
}
await fs.rename(backupDir, pluginDir);
await fs.rm(oldDir, { recursive: true, force: true }).catch(() => {});
```

**注意**：此场景极端罕见（进程在两个 rename 之间的微秒窗口被 kill），实际风险很低。

---

## 5. [轻微] `openclaw plugins update` 安装版本可能与 `toVersion` 不一致

**位置**：`worker.js:114`（`runPluginUpdate`）

**现状**：checker 检测到 `latestVersion = "1.1.0"` 后 spawn worker，但 `plugins update` 安装的是执行时刻的 latest（可能已是 1.2.0）。`toVersion` 记录与实际不一致。

**影响**：最坏情况多一次无用重试（skippedVersions 记录了错误版本）。不会导致严重后果。

**可选改进**：worker 升级完成后读取实际安装的版本号替代 `toVersion`。

---

## 无需修改的确认项

以下方面经审查确认无问题：

- **备份目录命名**：`.bak` 和 `.tmp.bak` 均以 `.bak` 结尾，不会被 OpenClaw 误加载
- **瞬态故障处理**：update 命令失败不标记 skip，仅验证失败才标记，正确
- **并发控制**：`__checking` 标志 + PID 文件锁双重防护
- **Shell 注入防御**：`fallbackInstallOldVersion` 的 SEMVER_RE 校验
- **Gateway 重启策略**：主动 restart 而非依赖 chokidar
- **State 文件读写**：虽无文件锁，但 scheduler 和 worker 的写操作在时序上不重叠
- **Detached 进程设计**：`process.execPath` + `detached` + `unref` 正确
- **日志轮转**：200 行触发截断到 100 行，合理
