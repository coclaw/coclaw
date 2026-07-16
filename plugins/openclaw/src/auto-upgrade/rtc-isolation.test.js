/**
 * rtc-isolation.test.js — 自动升级链路与 WebRTC/pion/bridge 的隔离红线
 *
 * werift 兜底剔除后 pion 是唯一 WebRTC 实现：某台机器 pion 起不来（impl=none）时，
 * 自动升级是把它"捞回来"的唯一通道（发布修复版 → 自动升级装上 → 恢复）。
 * 若升级链路反过来依赖 RTC/pion，pion 挂掉的机器连升级也挂 → 永久变砖。
 *
 * 本文件静态钉死两条 import 闭包（gateway 侧 scheduler 入口 updater.js、
 * 独立子进程 worker.js）不触碰任何 RTC 面模块，防止未来改动无声引入依赖。
 * 运行时行为由 realtime-bridge 的 impl=none 契约测试与升级链路自身测试共同覆盖。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { test } from 'node:test';

// RTC 面模块特征：webrtc/ 目录、realtime-bridge、pion（SDK 与 preloader）、
// file-manager（挂在 DC 上的文件传输）。命中任何一个即违反隔离红线。
const RTC_FORBIDDEN = /webrtc|werift|pion|realtime-bridge|file-manager/i;

/**
 * 收集一个入口文件的静态 import 闭包（含动态 import 的字面量 specifier）。
 * 相对路径递归展开；node: 内建与外部包记录 specifier 但不展开。
 * @param {string} entryAbs - 入口文件绝对路径
 * @returns {Promise<{ files: Set<string>, specs: { from: string, spec: string }[] }>}
 */
async function collectImportClosure(entryAbs) {
	const files = new Set();
	const specs = [];
	const queue = [entryAbs];
	// 覆盖三种形态：`from 'x'`（静态 import/re-export）、`import('x')`（动态）、`import 'x'`（副作用）
	const re = /(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/g;
	while (queue.length) {
		const file = queue.pop();
		if (files.has(file)) continue;
		files.add(file);
		const src = await fs.readFile(file, 'utf8');
		for (const m of src.matchAll(re)) {
			const spec = m[1];
			specs.push({ from: nodePath.basename(file), spec });
			if (spec.startsWith('.')) {
				queue.push(nodePath.resolve(nodePath.dirname(file), spec));
			}
		}
	}
	return { files, specs };
}

function assertNoRtcSurface(specs) {
	const hits = specs.filter(({ spec }) => RTC_FORBIDDEN.test(spec));
	assert.deepEqual(
		hits, [],
		`升级链路 import 闭包不得触碰 RTC 面（webrtc/pion/bridge/file-manager）：${JSON.stringify(hits)}`,
	);
}

test('红线：scheduler（updater.js）import 闭包不触碰 RTC 面', async () => {
	const { specs } = await collectImportClosure(nodePath.join(import.meta.dirname, 'updater.js'));
	assertNoRtcSurface(specs);
});

test('红线：升级 worker（worker.js）import 闭包不触碰 RTC 面，且零外部依赖', async () => {
	const { specs } = await collectImportClosure(nodePath.join(import.meta.dirname, 'worker.js'));
	assertNoRtcSurface(specs);
	// worker 是独立 spawn 子进程：
	// 1) 无 bridge 连接，禁止 remote-log（既有红线，一并钉死）；
	const remoteLogHits = specs.filter(({ spec }) => /remote-log/.test(spec));
	assert.deepEqual(remoteLogHits, [], `worker 闭包禁止 remote-log：${JSON.stringify(remoteLogHits)}`);
	// 2) 只允许 node: 内建 + 插件内相对模块——升级器在依赖树受损时也必须能跑
	//    （它正是修复依赖树的通道），不得引入外部 npm 包。
	const external = specs.filter(({ spec }) => !spec.startsWith('.') && !spec.startsWith('node:'));
	assert.deepEqual(external, [], `worker 闭包不得有外部依赖：${JSON.stringify(external)}`);
});
