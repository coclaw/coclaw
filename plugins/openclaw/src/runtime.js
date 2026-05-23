// runtime 单例：在 plugin 模式下由 register() 注入。
// link-UNSAFE：`--link` 安装模式下 hook 与 RPC handler 可能跑在不同 ESM 实例 →
// 两份独立 runtime；hook 实例从未被 setRuntime → getRuntime() 返回 null。
// **不要在 hook 回调内调用 getRuntime()**——hook 入参 `api` 已带 runtime。
// 详见 docs/module-boundaries.md。
let runtime = null;

export function setRuntime(rt) {
	runtime = rt;
}

export function getRuntime() {
	return runtime;
}
