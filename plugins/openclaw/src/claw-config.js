/**
 * claw-config.js — OpenClaw runtime config 的统一访问入口
 *
 * 设计原则：
 * - 业务代码只调 getClawConfig()，不直接摸 rt.config，新旧 API 切换全在此处兜底
 * - OpenClaw v2026.4.27+ 新 API `config.current()`；老 API `config.loadConfig()` 仍可用但触发 deprecation 警告
 * - 两个 API 内部都返回同一个 getRuntimeConfig() 快照，字段语义一致
 * - 异常不在此处吞，让调用方按需处理（取 token 与读账本兜底策略不同）
 *
 * 拆分触发：本文件超约 200 行，或某一类 host 适配独立成块且 ≥ 100 行时再拆出去；
 * 否则 path 之外的 host 适配优先往本文件加（必要时改名 claw-host.js）
 */
import { getRuntime } from './runtime.js';

/**
 * 读取当前 OpenClaw 运行时配置快照
 *
 * 优先 `config.current()`（v2026.4.27+），缺失时回落到 `config.loadConfig()`。
 *
 * @returns {object|null} runtime 未注入或缺 config 访问 API 时返回 null
 */
export function getClawConfig() {
	const rt = getRuntime();
	const reader = rt?.config?.current ?? rt?.config?.loadConfig;
	if (!reader) return null;
	return reader();
}
