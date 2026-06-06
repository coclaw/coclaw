import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * E2E 真实环境的孤儿 claw 清理。
 *
 * 背景：server 端 bind/claim 每次都新建一条 claw、从不复用；e2e 跑真实本机网关 +
 * 真实 bindings.json，无隔离。若测试新建的 claw 不清理，会在测试账号名下越积越多。
 *
 * 机制（基线快照 diff）：globalSetup 跑测试前抓一次「基线 claw id 集合」，
 * 凡运行结束后不在基线里的 claw = 本轮测试新建的孤儿 → 待清。bind 测试结尾刻意
 * 保留的一条 claw 记入 keeper，清理时跳过。
 *
 * 安全：删除唯一入口是 unbind-by-user，server 带归属校验、只能删当前登录用户自己的
 * claw；测试账号 test 名下所有 claw 都属测试域，碰不到他人数据。
 *
 * 失败兜底：基线未能抓取（server 不可达等）时，sidecar 标记 captured:false，清理一律
 * 跳过（绝不把真实绑定当孤儿误删）；清理是兜底，不能因它阻断或污染测试。
 */

const SERVER = 'http://127.0.0.1:3000';
const TEST_LOGIN_NAME = 'test';
const TEST_PASSWORD = '12345678';

const dir = nodePath.dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = nodePath.join(dir, '.baseline-claws.json');
const KEEPER_FILE = nodePath.join(dir, '.keeper-claws.json');

/** 登录 test 账号，返回拼接好的 cookie 串 */
export async function loginAndGetCookies() {
	const res = await fetch(`${SERVER}/api/v1/auth/local/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ loginName: TEST_LOGIN_NAME, password: TEST_PASSWORD }),
	});
	if (!res.ok) {
		throw new Error(`login failed: ${res.status}`);
	}
	const setCookie = res.headers.getSetCookie?.() ?? [];
	return setCookie.map((c) => c.split(';')[0]).join('; ');
}

/**
 * 列出当前用户所有 claw id。
 * @returns {Promise<Set<string>>}
 */
export async function listClawIds(cookies) {
	const res = await fetch(`${SERVER}/api/v1/claws`, {
		headers: { cookie: cookies },
	});
	if (!res.ok) {
		throw new Error(`list claws failed: ${res.status}`);
	}
	const data = await res.json();
	return new Set((data.items || []).map((c) => String(c.id)));
}

/** 简易 sleep（毫秒） */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 返回当前用户第一条 online:true 的 claw id；无则 null。
 * @returns {Promise<string|null>}
 */
async function findOnlineClawId(cookies) {
	const res = await fetch(`${SERVER}/api/v1/claws`, {
		headers: { cookie: cookies },
	});
	if (!res.ok) {
		throw new Error(`list claws failed: ${res.status}`);
	}
	const data = await res.json();
	const online = (data.items || []).find((c) => c.online);
	return online ? String(online.id) : null;
}

/**
 * 自愈绑定：确保 test 账号有在线 claw，供 RTC/file 类用例真跑而非 skip。
 *
 * 幂等：已存在 online:true 的 claw 时直接返回，不重复绑定。
 * 否则生成绑定码（POST binding-codes）→ 本机 CLI `openclaw coclaw bind`（换绑语义：
 * 自动解旧绑新）→ 轮询 GET /claws 直到出现 online:true（上限 ~30s）。
 *
 * 绑定码生成失败、bind 子进程失败会抛错；轮询期间瞬时失败忽略重试。是否容错由调用方
 * 决定（globalSetup 绑定失败不阻断整轮测试）。
 *
 * @param {string} cookies - test 账号登录后的 cookie 串
 * @returns {Promise<{ alreadyOnline: boolean, bound: boolean, online: boolean, clawId: string|null }>}
 */
export async function ensureBoundClaw(cookies) {
	// 幂等：已有在线 claw 直接返回，不重复绑
	const existing = await findOnlineClawId(cookies);
	if (existing) {
		return { alreadyOnline: true, bound: false, online: true, clawId: existing };
	}

	// 生成绑定码（仅需 session cookie，server 不读 body）
	const res = await fetch(`${SERVER}/api/v1/claws/binding-codes`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: cookies },
		body: JSON.stringify({}),
	});
	if (!res.ok) {
		throw new Error(`create binding code failed: ${res.status}`);
	}
	const { code } = await res.json();
	if (!code) {
		throw new Error('create binding code returned no code');
	}

	// 本机 CLI 执行绑定（换绑语义；插件已预装，不走安装步骤）
	execSync(`openclaw coclaw bind ${code} --server ${SERVER}`, {
		timeout: 30_000,
		encoding: 'utf-8',
		stdio: 'pipe',
	});

	// 轮询直到出现 online:true（上限 ~30s）；瞬时失败忽略，继续重试至上限
	const deadline = Date.now() + 30_000;
	let onlineId = null;
	while (Date.now() < deadline) {
		try {
			onlineId = await findOnlineClawId(cookies);
			if (onlineId) {
				break;
			}
		}
		catch {
			// 轮询期间瞬时失败忽略，继续重试
		}
		await sleep(1000);
	}

	return { alreadyOnline: false, bound: true, online: Boolean(onlineId), clawId: onlineId };
}

/**
 * 删除一条 claw（幂等：404/已删、其它非 2xx 都吞掉不抛，清理是兜底）。
 * @returns {Promise<boolean>} 是否已不存在（删除成功或本就不在）
 */
export async function deleteClaw(cookies, clawId) {
	try {
		const res = await fetch(`${SERVER}/api/v1/claws/unbind-by-user`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: cookies },
			body: JSON.stringify({ clawId: String(clawId) }),
		});
		return res.ok || res.status === 404;
	}
	catch {
		return false;
	}
}

/** 写基线快照（captured:true 表示成功抓到了测试前的真实状态） */
export function writeBaseline(ids) {
	writeFileSync(BASELINE_FILE, JSON.stringify({ captured: true, ids: ids ? [...ids] : [] }));
}

/** 标记基线未能抓取 → 后续清理一律跳过，绝不误删真实绑定 */
export function writeBaselineUncaptured() {
	writeFileSync(BASELINE_FILE, JSON.stringify({ captured: false, ids: [] }));
}

/**
 * 读基线。
 * @returns {{ captured: boolean, ids: Set<string> }}
 */
export function readBaseline() {
	if (!existsSync(BASELINE_FILE)) {
		return { captured: false, ids: new Set() };
	}
	try {
		const obj = JSON.parse(readFileSync(BASELINE_FILE, 'utf-8'));
		return { captured: Boolean(obj.captured), ids: new Set(obj.ids || []) };
	}
	catch {
		return { captured: false, ids: new Set() };
	}
}

/** 清空 keeper sidecar（globalSetup 调用，避免上轮残留） */
export function resetKeepers() {
	writeFileSync(KEEPER_FILE, JSON.stringify({ ids: [] }));
}

/**
 * 读 keeper 集合。
 * @returns {Set<string>}
 */
export function readKeepers() {
	if (!existsSync(KEEPER_FILE)) {
		return new Set();
	}
	try {
		const obj = JSON.parse(readFileSync(KEEPER_FILE, 'utf-8'));
		return new Set(obj.ids || []);
	}
	catch {
		return new Set();
	}
}

/** 追加一条 keeper（清理时跳过它） */
export function addKeeper(id) {
	const ids = readKeepers();
	ids.add(String(id));
	writeFileSync(KEEPER_FILE, JSON.stringify({ ids: [...ids] }));
}

/**
 * 清理孤儿 claw：删除「当前 - 基线 - keepers」的差集。
 * 基线未抓取（captured:false）时一律跳过，避免误删真实绑定。
 * @returns {Promise<string[]>} 实际删除的 claw id 列表（供日志）
 */
export async function sweepOrphans(cookies) {
	const baseline = readBaseline();
	if (!baseline.captured) {
		console.warn('[e2e-cleanup] baseline not captured, skip sweep (fail-safe)');
		return [];
	}
	const keepers = readKeepers();
	const current = await listClawIds(cookies);
	const deleted = [];
	for (const id of current) {
		if (baseline.ids.has(id) || keepers.has(id)) {
			continue;
		}
		await deleteClaw(cookies, id);
		deleted.push(id);
	}
	return deleted;
}
