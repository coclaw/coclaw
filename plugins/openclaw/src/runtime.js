// runtime 单例：在 plugin 模式下由 register() 注入
let runtime = null;

export function setRuntime(rt) {
	runtime = rt;
}

export function getRuntime() {
	return runtime;
}
