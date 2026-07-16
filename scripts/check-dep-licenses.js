// 依赖许可红线扫描：遍历全部 workspace 的 prod 依赖，命中强/网络 copyleft 即非零退出。
// 判级逻辑为纯函数（供单测直接测），进程调用（spawnSync）收在薄薄的 main 层。
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import nodePath from 'path';

// 级别按严重度排序：strong > unknown > weak > ok
const LEVEL = { ok: 'ok', weak: 'weak', unknown: 'unknown', strong: 'strong' };
const LEVEL_RANK = { ok: 0, weak: 1, unknown: 2, strong: 3 };
const RANK_TO_LEVEL = ['ok', 'weak', 'unknown', 'strong'];

// 强/网络 copyleft 前缀；LGPL 以 'L' 开头，startsWith('GPL') 天然不误伤，勿改 includes
const STRONG_PREFIXES = ['GPL', 'AGPL', 'SSPL', 'OSL', 'EUPL', 'RPL', 'CPAL'];
// 弱 copyleft 前缀
const WEAK_PREFIXES = ['LGPL', 'MPL', 'EPL', 'CDDL'];

// 判定单个部件（已去 SPDX 例外子句）的级别
function classifyPart(rawPart) {
	// 'Apache-2.0 WITH LLVM-exception' 取 WITH 前部分
	const token = String(rawPart).split(/\s+WITH\s+/i)[0].trim().toUpperCase();
	if (token === 'UNKNOWN' || token === 'UNLICENSED' || token.startsWith('SEE LICENSE')) {
		return LEVEL.unknown;
	}
	for (const p of STRONG_PREFIXES) {
		if (token.startsWith(p)) return LEVEL.strong;
	}
	for (const p of WEAK_PREFIXES) {
		if (token.startsWith(p)) return LEVEL.weak;
	}
	return LEVEL.ok;
}

// 判定整个 SPDX 许可 id 表达式的级别（纯函数）
export function classifyLicenseId(id) {
	// 去圆括号 → 按 OR 切分支 → 分支内按 AND 切部件
	const expr = String(id ?? '').replace(/[()]/g, '');
	const branches = expr.split(/\s+OR\s+/i);
	let exprRank = null; // 表达式级别取各 OR 分支里最宽松者（最小 rank）
	for (const branch of branches) {
		const parts = branch.split(/\s+AND\s+/i);
		let branchRank = LEVEL_RANK.ok; // 分支级别取部件里最严者（最大 rank）
		for (const part of parts) {
			const rank = LEVEL_RANK[classifyPart(part)];
			if (rank > branchRank) branchRank = rank;
		}
		if (exprRank === null || branchRank < exprRank) exprRank = branchRank;
	}
	if (exprRank === null) exprRank = LEVEL_RANK.ok;
	return RANK_TO_LEVEL[exprRank];
}

// 把 pnpm licenses 的一个包对象格式化为 name@ver1, ver2
function formatPackage(pkg) {
	const versions = (pkg.versions ?? []).join(', ');
	return versions ? `${pkg.name}@${versions}` : pkg.name;
}

// 对一份 licenses JSON map（按许可 id 分组）做聚合判级（纯函数）
// 返回 { violations, warnings, packageCount }；命中 strong 即入 violations（命中即失败）
export function scanLicensesMap(map) {
	const violations = [];
	const warnings = [];
	let packageCount = 0;
	for (const [licenseId, pkgs] of Object.entries(map ?? {})) {
		const list = Array.isArray(pkgs) ? pkgs : [];
		packageCount += list.length;
		const level = classifyLicenseId(licenseId);
		if (level === LEVEL.ok) continue;
		const packages = list.map((p) => ({ name: p.name, versions: p.versions ?? [] }));
		const entry = { licenseId, level, packages };
		if (level === LEVEL.strong) violations.push(entry);
		else warnings.push(entry); // weak / unknown
	}
	return { violations, warnings, packageCount };
}

// 动态枚举全部 workspace（含仓库根），返回 [{ name, path }]
export function enumerateWorkspaces(repoRoot) {
	const res = spawnSync('pnpm', ['-r', 'ls', '--depth', '-1', '--json'], {
		cwd: repoRoot,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	if (res.status !== 0) {
		throw new Error(`pnpm -r ls failed (status ${res.status}): ${res.stderr || res.stdout}`);
	}
	const list = JSON.parse(res.stdout);
	return list.map((w) => ({ name: w.name, path: w.path }));
}

// 取单个 workspace 的 prod 依赖许可 map；扫描器自身坏掉时抛错（绝不静默绿）
export function getWorkspaceLicenses(name, repoRoot) {
	const res = spawnSync('pnpm', ['licenses', 'list', '--json', '--prod', '--filter', name], {
		cwd: repoRoot,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	const out = res.stdout ?? '';
	if (res.status !== 0) {
		throw new Error(`pnpm licenses list failed for ${name} (status ${res.status}): ${res.stderr || out}`);
	}
	try {
		return JSON.parse(out);
	} catch (err) {
		// exit 0 但非 JSON：仅当明确表明无包时视为空集，否则视为扫描器异常
		if (/No licenses/i.test(out)) return {};
		throw new Error(`Failed to parse licenses JSON for ${name}: ${err.message}`);
	}
}

// 扫描入口：遍历 workspace，打印 violation/warning 明细与汇总，有 violation 则退出码置 1
export function main() {
	const repoRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
	const workspaces = enumerateWorkspaces(repoRoot);
	let totalPackages = 0;
	let violationCount = 0;
	let warningCount = 0;
	for (const ws of workspaces) {
		const map = getWorkspaceLicenses(ws.name, repoRoot);
		const { violations, warnings, packageCount } = scanLicensesMap(map);
		totalPackages += packageCount;
		for (const v of violations) {
			violationCount++;
			console.log(`VIOLATION [${ws.name}] ${v.licenseId} (${v.level}): ${v.packages.map(formatPackage).join(', ')}`);
		}
		for (const w of warnings) {
			warningCount++;
			console.log(`WARNING  [${ws.name}] ${w.licenseId} (${w.level}): ${w.packages.map(formatPackage).join(', ')}`);
		}
	}
	console.log(`Scanned ${workspaces.length} workspaces, ${totalPackages} packages: ${violationCount} violation(s), ${warningCount} warning(s).`);
	if (violationCount > 0) {
		console.log('Dependency license check failed: strong/network copyleft license detected.');
		process.exitCode = 1;
	}
}

// 直接运行时才扫描；被 test import 时不触发真扫描
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
