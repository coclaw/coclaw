import { loginAndGetCookies, sweepOrphans } from './claw-cleanup.js';

export default async function globalTeardown() {
	// 清理本轮测试新建的孤儿 claw（基线 diff，跳过 keepers）。
	// 此时 webServer 尚未被 playwright 拆除（globalTeardown 的 teardown 早于 webServer 插件 teardown），
	// 故 server 仍可访问。容错：任何异常只 warn 不抛，不影响测试结果汇报。
	try {
		const cookies = await loginAndGetCookies();
		const deleted = await sweepOrphans(cookies);
		if (deleted.length) {
			console.info(`[e2e-cleanup] swept ${deleted.length} orphan claw(s): ${deleted.join(', ')}`);
		}
		else {
			console.info('[e2e-cleanup] no orphan claws to sweep');
		}
	}
	catch (err) {
		console.warn(`[e2e-cleanup] teardown sweep failed: ${err?.message}`);
	}
}
