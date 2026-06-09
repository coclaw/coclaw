import { execSync } from 'node:child_process';

import {
	loginAndGetCookies,
	listClawIds,
	ensureBoundClaw,
	ensureNamedAgents,
	writeBaseline,
	writeBaselineUncaptured,
	resetKeepers,
} from './claw-cleanup.js';

export default async function globalSetup() {
	execSync('pnpm --filter @coclaw/server account:create-test-local', {
		stdio: 'inherit',
	});

	// 抓取测试前的基线 claw 集合：teardown 据此识别本轮新建的孤儿 claw 并清理。
	// 此处 webServer（server:3000）已先于 globalSetup 启动（webServer 是 playwright 插件，
	// 插件 setup 早于 globalSetup），故可直接登录列举。
	// 容错：登录/列举失败不抛错（清理是兜底，不能阻断整轮测试），标记基线未抓取 → 清理跳过。
	resetKeepers();
	try {
		const cookies = await loginAndGetCookies();

		// 自愈绑定：测试前确保 test 账号有在线 claw，让 RTC/file/chat-attachment 类用例真跑而非 skip。
		// fail-safe：绑定失败不抛（无在线 claw 时 RTC 类本就 skip，不该阻断其它类）→ warn 后继续抓基线。
		try {
			const result = await ensureBoundClaw(cookies);
			if (result.alreadyOnline) {
				console.info(`[e2e-cleanup] online claw present, skip auto-bind (clawId=${result.clawId})`);
			}
			else if (result.online) {
				console.info(`[e2e-cleanup] auto-bound claw online (clawId=${result.clawId})`);
			}
			else {
				console.warn(`[e2e-cleanup] auto-bind did not reach online; RTC/file tests may skip (bound=${result.bound} clawId=${result.clawId ?? 'n/a'})`);
			}
		}
		catch (bindErr) {
			console.warn(`[e2e-cleanup] auto-bind failed; RTC/file tests may skip: ${bindErr?.message}`);
		}

		// 抓基线必须在自愈绑定之后：新绑的 claw 进基线 → 受 teardown baseline/keeper 保护，不被当孤儿删。
		// 确保命名 agent 夹具（main + tester）就绪，供 multi-agent spec 按 id 断言而非 skip。
		// fail-safe：失败不抛（夹具一旦创建即长期存在，单次瞬时失败不阻断整轮测试）。
		try {
			const r = ensureNamedAgents();
			console.info(`[e2e-cleanup] named agents ready (created=${r.created}, agents=${r.ids.join(',')})`);
		}
		catch (agentErr) {
			console.warn(`[e2e-cleanup] ensure named agents failed; multi-agent tests may skip: ${agentErr?.message}`);
		}

		const ids = await listClawIds(cookies);
		writeBaseline(ids);
		console.info(`[e2e-cleanup] baseline captured: ${ids.size} claw(s)`);
	}
	catch (err) {
		writeBaselineUncaptured();
		console.warn(`[e2e-cleanup] baseline capture failed, sweep disabled: ${err?.message}`);
	}
}
