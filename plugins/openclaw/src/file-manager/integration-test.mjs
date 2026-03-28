/**
 * 文件管理集成测试
 *
 * 测试内容：
 * 1. Gateway 加载状态 — 插件是否正常加载
 * 2. Workspace 解析 — agents.files.list 能否返回 workspace 路径
 * 3. File handler 与真实文件系统 — list/delete/GET/PUT/POST/mkdir/create 的端到端正确性
 * 4. 并发操作 — 多个并发文件操作不互相干扰
 * 5. 安全边界 — 路径穿越、符号链接
 * 6. POST 附件上传 — chat-files / topic-files 场景
 * 7. RPC mkdir / create — 递归创建目录和创建空文件
 *
 * 运行方式：node src/file-manager/integration.test.js
 * 前置条件：openclaw gateway 已启动，插件已通过 --link 安装
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import nodePath from 'node:path';
import { createFileHandler, validatePath } from './handler.js';

// --- helpers ---

function gatewayCall(method, params = {}) {
	const paramsJson = JSON.stringify(params).replace(/'/g, "'\\''");
	const cmd = `openclaw gateway call '${method}' --params '${paramsJson}' --json 2>&1`;
	try {
		return JSON.parse(execSync(cmd, { timeout: 15_000, encoding: 'utf8' }));
	} catch (err) {
		const output = err.stdout || err.stderr || err.message;
		try { return JSON.parse(output); }
		catch { return { error: output }; }
	}
}

function silentLogger() {
	return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

// 模拟 DataChannel
function createMockDC(label = 'file:integ-test') {
	const sent = [];
	const dc = {
		label,
		readyState: 'open',
		bufferedAmount: 0,
		bufferedAmountLowThreshold: 0,
		onmessage: null,
		onclose: null,
		onopen: null,
		onbufferedamountlow: null,
		send(data) { sent.push(data); },
		close() { dc.readyState = 'closed'; dc.onclose?.(); },
		__sent: sent,
	};
	return dc;
}

let passed = 0;
let failed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }
function fail(name, err) { failed++; console.error(`  ✗ ${name}: ${err.message || err}`); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${b}, got ${a}`); }

console.log('=== 文件管理集成测试 ===\n');

// --- 1. Gateway 加载状态 ---
console.log('[1. Gateway 加载状态]');

try {
	const output = execSync('openclaw plugins doctor 2>&1', { encoding: 'utf8' });
	assert(!output.includes('issues detected') || output.includes('No plugin issues'), 'plugin doctor ok');
	ok('插件 doctor 检查通过');
} catch (err) { fail('插件 doctor 检查', err); }

// --- 2. Workspace 解析 ---
console.log('\n[2. Workspace 解析]');

let workspace;
try {
	const result = gatewayCall('agents.files.list', { agentId: 'main' });
	assert(result.workspace, 'workspace field present');
	workspace = result.workspace;
	console.log(`  workspace: ${workspace}`);
	ok('agents.files.list 返回 workspace 路径');
} catch (err) {
	fail('workspace 解析', err);
	console.error('无法继续测试');
	process.exit(1);
}

// --- 3. File handler 端到端测试 ---
console.log('\n[3. File handler 端到端测试]');

const testDir = `__coclaw_integ_test_${Date.now()}`;
const testDirPath = nodePath.join(workspace, testDir);

async function cleanup() {
	try { await fs.rm(testDirPath, { recursive: true, force: true }); }
	catch { /* ignore */ }
}

const handler = createFileHandler({
	resolveWorkspace: async (agentId) => {
		const result = gatewayCall('agents.files.list', { agentId });
		if (!result.workspace) throw new Error(`No workspace for agent: ${agentId}`);
		return result.workspace;
	},
	logger: silentLogger(),
});

try {
	// 准备测试数据
	await fs.mkdir(testDirPath, { recursive: true });
	await fs.writeFile(nodePath.join(testDirPath, 'hello.txt'), 'Hello, World!');
	await fs.writeFile(nodePath.join(testDirPath, 'data.json'), '{"key":"value"}');
	await fs.mkdir(nodePath.join(testDirPath, 'subdir'));
	await fs.writeFile(nodePath.join(testDirPath, 'subdir', 'nested.txt'), 'nested');

	// 3a. RPC list
	try {
		const responses = [];
		await handler.handleRpcRequest(
			{ id: 'i1', method: 'coclaw.files.list', params: { agentId: 'main', path: testDir } },
			(r) => responses.push(r),
		);
		assertEqual(responses[0].ok, true, 'list ok');
		const names = responses[0].payload.files.map((f) => f.name);
		assert(names.includes('hello.txt'), 'hello.txt in list');
		assert(names.includes('subdir'), 'subdir in list');
		const hello = responses[0].payload.files.find((f) => f.name === 'hello.txt');
		assertEqual(hello.type, 'file');
		assertEqual(hello.size, 13);
		ok('RPC list 返回正确文件列表');
	} catch (err) { fail('RPC list', err); }

	// 3b. RPC list 子目录
	try {
		const responses = [];
		await handler.handleRpcRequest(
			{ id: 'i2', method: 'coclaw.files.list', params: { path: `${testDir}/subdir` } },
			(r) => responses.push(r),
		);
		assertEqual(responses[0].ok, true);
		assert(responses[0].payload.files.some((f) => f.name === 'nested.txt'), 'nested in subdir');
		ok('RPC list 子目录');
	} catch (err) { fail('RPC list 子目录', err); }

	// 3c. RPC list 路径穿越被拒绝
	try {
		const responses = [];
		await handler.handleRpcRequest(
			{ id: 'i3', method: 'coclaw.files.list', params: { path: '../../../etc' } },
			(r) => responses.push(r),
		);
		assertEqual(responses[0].ok, false);
		assertEqual(responses[0].error.code, 'PATH_DENIED');
		ok('RPC list 路径穿越拒绝');
	} catch (err) { fail('RPC list 路径穿越', err); }

	// 3d. RPC delete 文件
	try {
		await fs.writeFile(nodePath.join(testDirPath, 'del.txt'), 'bye');
		const responses = [];
		await handler.handleRpcRequest(
			{ id: 'i4', method: 'coclaw.files.delete', params: { path: `${testDir}/del.txt` } },
			(r) => responses.push(r),
		);
		assertEqual(responses[0].ok, true);
		try { await fs.access(nodePath.join(testDirPath, 'del.txt')); assert(false, 'file should be gone'); }
		catch { /* expected */ }
		ok('RPC delete 文件');
	} catch (err) { fail('RPC delete 文件', err); }

	// 3e. File DC read（下载）
	try {
		const dc = createMockDC('file:b0000000-0000-0000-0000-000000000001');
		handler.handleFileChannel(dc);
		dc.onmessage({ data: JSON.stringify({ method: 'GET', agentId: 'main', path: `${testDir}/hello.txt` }) });
		await new Promise((r) => setTimeout(r, 500));

		const strings = dc.__sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
		const binaries = dc.__sent.filter((s) => typeof s !== 'string');
		assertEqual(strings[0].ok, true, 'read header ok');
		assertEqual(strings[0].size, 13);
		assertEqual(strings[0].name, 'hello.txt');
		const data = Buffer.concat(binaries).toString();
		assertEqual(data, 'Hello, World!');
		const completion = strings[strings.length - 1];
		assertEqual(completion.ok, true, 'read completion ok');
		assertEqual(completion.bytes, 13);
		ok('File DC read 正确下载文件');
	} catch (err) { fail('File DC read', err); }

	// 3f. File DC write（上传）
	try {
		const content = Buffer.from('uploaded via DC');
		const dc = createMockDC('file:b0000000-0000-0000-0000-000000000002');
		handler.handleFileChannel(dc);
		dc.onmessage({ data: JSON.stringify({ method: 'PUT', agentId: 'main', path: `${testDir}/uploaded.txt`, size: content.length }) });
		await new Promise((r) => setTimeout(r, 100));

		const ready = JSON.parse(dc.__sent[0]);
		assertEqual(ready.ok, true, 'write ready');

		dc.onmessage({ data: content });
		dc.onmessage({ data: JSON.stringify({ done: true, bytes: content.length }) });
		await new Promise((r) => setTimeout(r, 500));

		const strings = dc.__sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
		const result = strings.find((s) => s.ok === true && s.bytes !== undefined);
		assert(result, 'write result received');
		assertEqual(result.bytes, content.length);

		const written = await fs.readFile(nodePath.join(testDirPath, 'uploaded.txt'), 'utf8');
		assertEqual(written, 'uploaded via DC');
		ok('File DC write 正确上传文件');
	} catch (err) { fail('File DC write', err); }

	// 3g. File DC write 自动创建中间目录
	try {
		const content = Buffer.from('nested write');
		const dc = createMockDC('file:b0000000-0000-0000-0000-000000000003');
		handler.handleFileChannel(dc);
		dc.onmessage({ data: JSON.stringify({ method: 'PUT', path: `${testDir}/new/deep/file.txt`, size: content.length }) });
		await new Promise((r) => setTimeout(r, 100));
		dc.onmessage({ data: content });
		dc.onmessage({ data: JSON.stringify({ done: true, bytes: content.length }) });
		await new Promise((r) => setTimeout(r, 500));

		const written = await fs.readFile(nodePath.join(testDirPath, 'new', 'deep', 'file.txt'), 'utf8');
		assertEqual(written, 'nested write');
		ok('File DC write 自动创建中间目录');
	} catch (err) { fail('File DC write 自动创建目录', err); }

	// 3h. File DC read 不存在的文件
	try {
		const dc = createMockDC('file:b0000000-0000-0000-0000-000000000004');
		handler.handleFileChannel(dc);
		dc.onmessage({ data: JSON.stringify({ method: 'GET', path: `${testDir}/nope.txt` }) });
		await new Promise((r) => setTimeout(r, 200));
		const msg = JSON.parse(dc.__sent[0]);
		assertEqual(msg.ok, false);
		assertEqual(msg.error.code, 'NOT_FOUND');
		ok('File DC read 不存在文件返回 NOT_FOUND');
	} catch (err) { fail('File DC read 404', err); }

	// 3i. File DC write size mismatch
	try {
		const dc = createMockDC('file:a0000000-0000-0000-0000-000000000001');
		handler.handleFileChannel(dc);
		dc.onmessage({ data: JSON.stringify({ method: 'PUT', path: `${testDir}/mis.txt`, size: 100 }) });
		await new Promise((r) => setTimeout(r, 100));
		dc.onmessage({ data: Buffer.from('short') });
		dc.onmessage({ data: JSON.stringify({ done: true, bytes: 5 }) });
		await new Promise((r) => setTimeout(r, 300));

		const strings = dc.__sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
		const errMsg = strings.find((s) => s.ok === false);
		assert(errMsg, 'error message received');
		assertEqual(errMsg.error.code, 'WRITE_FAILED');
		ok('File DC write size mismatch 返回 WRITE_FAILED');
	} catch (err) { fail('File DC write mismatch', err); }

	// 3j. File DC write 路径穿越
	try {
		const dc = createMockDC('file:b0000000-0000-0000-0000-000000000005');
		handler.handleFileChannel(dc);
		dc.onmessage({ data: JSON.stringify({ method: 'PUT', path: '../../../tmp/evil.txt', size: 5 }) });
		await new Promise((r) => setTimeout(r, 200));
		const msg = JSON.parse(dc.__sent[0]);
		assertEqual(msg.ok, false);
		assertEqual(msg.error.code, 'PATH_DENIED');
		ok('File DC write 路径穿越拒绝');
	} catch (err) { fail('File DC write 路径穿越', err); }

	// 3k. File DC write 文件覆盖
	try {
		await fs.writeFile(nodePath.join(testDirPath, 'overwrite.txt'), 'old content');
		const content = Buffer.from('new content');
		const dc = createMockDC('file:b0000000-0000-0000-0000-000000000006');
		handler.handleFileChannel(dc);
		dc.onmessage({ data: JSON.stringify({ method: 'PUT', path: `${testDir}/overwrite.txt`, size: content.length }) });
		await new Promise((r) => setTimeout(r, 100));
		dc.onmessage({ data: content });
		dc.onmessage({ data: JSON.stringify({ done: true, bytes: content.length }) });
		await new Promise((r) => setTimeout(r, 500));

		const written = await fs.readFile(nodePath.join(testDirPath, 'overwrite.txt'), 'utf8');
		assertEqual(written, 'new content');
		ok('File DC write 覆盖已有文件');
	} catch (err) { fail('File DC write 覆盖', err); }

	// --- 4. 并发操作 ---
	console.log('\n[4. 并发操作]');

	// 4a. 并发 list
	try {
		const promises = [];
		for (let i = 0; i < 10; i++) {
			promises.push(new Promise((resolve) => {
				const responses = [];
				handler.handleRpcRequest(
					{ id: `c${i}`, method: 'coclaw.files.list', params: { path: testDir } },
					(r) => responses.push(r),
				).then(() => resolve(responses[0]));
			}));
		}
		const results = await Promise.all(promises);
		assert(results.every((r) => r.ok === true), 'all concurrent lists ok');
		ok('10 次并发 list 全部成功');
	} catch (err) { fail('并发 list', err); }

	// 4b. 并发 write（不同文件）
	try {
		const ids = [];
		for (let i = 0; i < 5; i++) {
			const content = Buffer.from(`concurrent ${i}`);
			const uuid = `c000000${i}-0000-0000-0000-000000000000`;
			const dc = createMockDC(`file:${uuid}`);
			handler.handleFileChannel(dc);
			dc.onmessage({ data: JSON.stringify({ method: 'PUT', path: `${testDir}/conc_${i}.txt`, size: content.length }) });
			ids.push({ dc, content, i });
		}
		await new Promise((r) => setTimeout(r, 200));
		for (const { dc, content, i } of ids) {
			dc.onmessage({ data: content });
			dc.onmessage({ data: JSON.stringify({ done: true, bytes: content.length }) });
		}
		await new Promise((r) => setTimeout(r, 1000));
		// 验证所有文件内容
		for (let i = 0; i < 5; i++) {
			const data = await fs.readFile(nodePath.join(testDirPath, `conc_${i}.txt`), 'utf8');
			assertEqual(data, `concurrent ${i}`);
		}
		ok('5 个并发 write 全部成功且内容正确');
	} catch (err) { fail('并发 write', err); }

	// 4c. 并发 read + write + list
	try {
		const content = Buffer.from('mixed ops');
		const writeDC = createMockDC('file:b0000000-0000-0000-0000-000000000007');
		handler.handleFileChannel(writeDC);
		writeDC.onmessage({ data: JSON.stringify({ method: 'PUT', path: `${testDir}/mixed.txt`, size: content.length }) });
		await new Promise((r) => setTimeout(r, 100));
		writeDC.onmessage({ data: content });
		writeDC.onmessage({ data: JSON.stringify({ done: true, bytes: content.length }) });

		const listResponses = [];
		handler.handleRpcRequest(
			{ id: 'ml', method: 'coclaw.files.list', params: { path: testDir } },
			(r) => listResponses.push(r),
		);

		const readDC = createMockDC('file:b0000000-0000-0000-0000-000000000008');
		handler.handleFileChannel(readDC);
		readDC.onmessage({ data: JSON.stringify({ method: 'GET', path: `${testDir}/hello.txt` }) });

		await new Promise((r) => setTimeout(r, 500));
		assert(listResponses[0]?.ok === true, 'mixed list ok');
		const readStrings = readDC.__sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
		assert(readStrings[0]?.ok === true, 'mixed read ok');
		ok('并发 read + write + list 不互相干扰');
	} catch (err) { fail('混合并发操作', err); }

	// --- 5. 安全边界 ---
	console.log('\n[5. 安全边界]');

	// 5a. 符号链接指向沙箱外
	try {
		await fs.symlink('/etc/hosts', nodePath.join(testDirPath, 'evil_link'));
		const dc = createMockDC('file:b0000000-0000-0000-0000-000000000009');
		handler.handleFileChannel(dc);
		dc.onmessage({ data: JSON.stringify({ method: 'GET', path: `${testDir}/evil_link` }) });
		await new Promise((r) => setTimeout(r, 200));
		const msg = JSON.parse(dc.__sent[0]);
		assertEqual(msg.ok, false);
		assertEqual(msg.error.code, 'PATH_DENIED');
		await fs.unlink(nodePath.join(testDirPath, 'evil_link')).catch(() => {});
		ok('符号链接指向沙箱外被拒绝');
	} catch (err) { fail('符号链接安全', err); }

	// 5b. 临时文件不出现在列表中
	try {
		await fs.writeFile(nodePath.join(testDirPath, 'visible.txt'), 'yes');
		await fs.writeFile(nodePath.join(testDirPath, 'visible.txt.tmp.550e8400-e29b-41d4-a716-446655440000'), 'no');
		const responses = [];
		await handler.handleRpcRequest(
			{ id: 'tmp', method: 'coclaw.files.list', params: { path: testDir } },
			(r) => responses.push(r),
		);
		const names = responses[0].payload.files.map((f) => f.name);
		assert(names.includes('visible.txt'), 'normal file visible');
		assert(!names.some((n) => n.includes('.tmp.')), 'tmp file hidden');
		ok('临时文件不出现在列表中');
	} catch (err) { fail('临时文件隐藏', err); }

	// 5c. 大文件上传超限
	try {
		const dc = createMockDC('file:b0000000-0000-0000-0000-00000000000a');
		handler.handleFileChannel(dc);
		dc.onmessage({ data: JSON.stringify({ method: 'PUT', path: `${testDir}/huge.bin`, size: 2_000_000_000 }) });
		await new Promise((r) => setTimeout(r, 100));
		const msg = JSON.parse(dc.__sent[0]);
		assertEqual(msg.ok, false);
		assertEqual(msg.error.code, 'SIZE_EXCEEDED');
		ok('超过 1GB 限制被拒绝');
	} catch (err) { fail('大文件超限', err); }

	// 5d. DC 取消上传清理临时文件
	try {
		const dc = createMockDC('file:b0000000-0000-0000-0000-00000000000b');
		handler.handleFileChannel(dc);
		dc.onmessage({ data: JSON.stringify({ method: 'PUT', path: `${testDir}/cancel.txt`, size: 100 }) });
		await new Promise((r) => setTimeout(r, 100));
		dc.onmessage({ data: Buffer.from('partial data') });
		dc.close(); // 取消
		await new Promise((r) => setTimeout(r, 300));

		const files = await fs.readdir(testDirPath);
		assert(!files.some((f) => f.includes('cancel.txt')), 'cancelled file cleaned up');
		ok('取消上传清理临时文件');
	} catch (err) { fail('取消上传', err); }

	// --- 6. POST 附件上传 ---
	console.log('\n[6. POST 附件上传]');

	// 6a. POST chat-files 上传
	try {
		const content = Buffer.from('chat attachment');
		const dc = createMockDC('file:d0000000-0000-0000-0000-000000000001');
		handler.handleFileChannel(dc);
		dc.onmessage({ data: JSON.stringify({
			method: 'POST',
			agentId: 'main',
			path: `${testDir}/.coclaw/chat-files/main/2026-03`,
			fileName: 'photo.jpg',
			size: content.length,
		}) });
		await new Promise((r) => setTimeout(r, 200));

		const ready = JSON.parse(dc.__sent[0]);
		assertEqual(ready.ok, true, 'POST ready');

		dc.onmessage({ data: content });
		dc.onmessage({ data: JSON.stringify({ done: true, bytes: content.length }) });
		await new Promise((r) => setTimeout(r, 500));

		const strings = dc.__sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
		const result = strings.find((s) => s.ok === true && s.bytes !== undefined);
		assert(result, 'POST result received');
		assertEqual(result.bytes, content.length);
		assert(result.path, 'POST result includes path');
		assert(result.path.includes('photo-'), 'path contains photo-');
		assert(result.path.endsWith('.jpg'), 'path ends with .jpg');

		// 验证文件内容
		const written = await fs.readFile(nodePath.join(workspace, result.path), 'utf8');
		assertEqual(written, 'chat attachment');
		ok('POST chat-files 上传成功，返回唯一路径');
	} catch (err) { fail('POST chat-files', err); }

	// 6b. POST topic-files 上传
	try {
		const content = Buffer.from('topic attachment');
		const dc = createMockDC('file:d0000000-0000-0000-0000-000000000002');
		handler.handleFileChannel(dc);
		dc.onmessage({ data: JSON.stringify({
			method: 'POST',
			path: `${testDir}/.coclaw/topic-files/uuid-topic-id`,
			fileName: 'report.pdf',
			size: content.length,
		}) });
		await new Promise((r) => setTimeout(r, 200));
		dc.onmessage({ data: content });
		dc.onmessage({ data: JSON.stringify({ done: true, bytes: content.length }) });
		await new Promise((r) => setTimeout(r, 500));

		const strings = dc.__sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
		const result = strings.find((s) => s.ok === true && s.bytes !== undefined);
		assert(result, 'POST topic result received');
		assert(result.path.includes('report-'), 'topic path contains report-');
		assert(result.path.endsWith('.pdf'), 'topic path ends with .pdf');

		const written = await fs.readFile(nodePath.join(workspace, result.path), 'utf8');
		assertEqual(written, 'topic attachment');
		ok('POST topic-files 上传成功');
	} catch (err) { fail('POST topic-files', err); }

	// 6c. POST 缺少 fileName
	try {
		const dc = createMockDC('file:d0000000-0000-0000-0000-000000000003');
		handler.handleFileChannel(dc);
		dc.onmessage({ data: JSON.stringify({
			method: 'POST',
			path: `${testDir}/.coclaw/chat-files/main`,
			size: 100,
		}) });
		await new Promise((r) => setTimeout(r, 200));
		const msg = JSON.parse(dc.__sent[0]);
		assertEqual(msg.ok, false);
		assertEqual(msg.error.code, 'INVALID_INPUT');
		ok('POST 缺少 fileName 返回 INVALID_INPUT');
	} catch (err) { fail('POST 缺 fileName', err); }

	// 6d. POST size 超限
	try {
		const dc = createMockDC('file:d0000000-0000-0000-0000-000000000004');
		handler.handleFileChannel(dc);
		dc.onmessage({ data: JSON.stringify({
			method: 'POST',
			path: `${testDir}/.coclaw/chat-files/main`,
			fileName: 'huge.bin',
			size: 2_000_000_000,
		}) });
		await new Promise((r) => setTimeout(r, 200));
		const msg = JSON.parse(dc.__sent[0]);
		assertEqual(msg.ok, false);
		assertEqual(msg.error.code, 'SIZE_EXCEEDED');
		ok('POST size 超限被拒绝');
	} catch (err) { fail('POST 超限', err); }

	// 6e. POST 多次上传到同一目录（唯一文件名不碰撞）
	try {
		const results = [];
		for (let i = 0; i < 5; i++) {
			const content = Buffer.from(`file ${i}`);
			const dc = createMockDC(`file:d000000${i}-0000-0000-0000-000000000010`);
			handler.handleFileChannel(dc);
			dc.onmessage({ data: JSON.stringify({
				method: 'POST',
				path: `${testDir}/.coclaw/chat-files/dedup`,
				fileName: 'same.txt',
				size: content.length,
			}) });
			await new Promise((r) => setTimeout(r, 100));
			dc.onmessage({ data: content });
			dc.onmessage({ data: JSON.stringify({ done: true, bytes: content.length }) });
			await new Promise((r) => setTimeout(r, 300));

			const strings = dc.__sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
			const result = strings.find((s) => s.ok === true && s.bytes !== undefined);
			assert(result, `POST dedup result ${i}`);
			results.push(result.path);
		}
		// 所有路径应不同
		const uniquePaths = new Set(results);
		assertEqual(uniquePaths.size, 5, 'all 5 paths should be unique');
		ok('POST 5 次同名文件上传，路径全部唯一');
	} catch (err) { fail('POST 多次同名上传', err); }

	// 6f. POST 并发上传到同一目录
	try {
		const dcs = [];
		for (let i = 0; i < 5; i++) {
			const content = Buffer.from(`conc ${i}`);
			const dc = createMockDC(`file:e000000${i}-0000-0000-0000-000000000000`);
			handler.handleFileChannel(dc);
			dc.onmessage({ data: JSON.stringify({
				method: 'POST',
				path: `${testDir}/.coclaw/chat-files/concurrent`,
				fileName: 'doc.txt',
				size: content.length,
			}) });
			dcs.push({ dc, content });
		}
		await new Promise((r) => setTimeout(r, 200));
		for (const { dc, content } of dcs) {
			dc.onmessage({ data: content });
			dc.onmessage({ data: JSON.stringify({ done: true, bytes: content.length }) });
		}
		await new Promise((r) => setTimeout(r, 1000));

		const paths = [];
		for (const { dc } of dcs) {
			const strings = dc.__sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
			const result = strings.find((s) => s.ok === true && s.bytes !== undefined);
			assert(result, 'concurrent POST result');
			paths.push(result.path);
		}
		const uniquePaths = new Set(paths);
		assertEqual(uniquePaths.size, 5, 'all concurrent POST paths unique');
		ok('POST 5 次并发同名上传，路径全部唯一');
	} catch (err) { fail('POST 并发同名上传', err); }

	// --- 7. RPC mkdir / create ---
	console.log('\n[7. RPC mkdir / create]');

	// 7a. mkdir 递归创建
	try {
		const responses = [];
		await handler.handleRpcRequest(
			{ id: 'm1', method: 'coclaw.files.mkdir', params: { path: `${testDir}/mkd/a/b/c` } },
			(r) => responses.push(r),
		);
		assertEqual(responses[0].ok, true, 'mkdir ok');
		const stat = await fs.stat(nodePath.join(testDirPath, 'mkd', 'a', 'b', 'c'));
		assert(stat.isDirectory(), 'mkd/a/b/c is directory');
		ok('RPC mkdir 递归创建');
	} catch (err) { fail('RPC mkdir', err); }

	// 7b. mkdir 已存在不报错
	try {
		const responses = [];
		await handler.handleRpcRequest(
			{ id: 'm2', method: 'coclaw.files.mkdir', params: { path: `${testDir}/mkd/a/b/c` } },
			(r) => responses.push(r),
		);
		assertEqual(responses[0].ok, true, 'mkdir existing ok');
		ok('RPC mkdir 已存在不报错');
	} catch (err) { fail('RPC mkdir 已存在', err); }

	// 7c. mkdir 路径穿越
	try {
		const responses = [];
		await handler.handleRpcRequest(
			{ id: 'm3', method: 'coclaw.files.mkdir', params: { path: '../../../tmp/evil' } },
			(r) => responses.push(r),
		);
		assertEqual(responses[0].ok, false);
		assertEqual(responses[0].error.code, 'PATH_DENIED');
		ok('RPC mkdir 路径穿越拒绝');
	} catch (err) { fail('RPC mkdir 路径穿越', err); }

	// 7d. create 创建空文件
	try {
		const responses = [];
		await handler.handleRpcRequest(
			{ id: 'c1', method: 'coclaw.files.create', params: { path: `${testDir}/created.txt` } },
			(r) => responses.push(r),
		);
		assertEqual(responses[0].ok, true, 'create ok');
		const content = await fs.readFile(nodePath.join(testDirPath, 'created.txt'), 'utf8');
		assertEqual(content, '', 'created file is empty');
		ok('RPC create 创建空文件');
	} catch (err) { fail('RPC create', err); }

	// 7e. create 自动创建父目录
	try {
		const responses = [];
		await handler.handleRpcRequest(
			{ id: 'c2', method: 'coclaw.files.create', params: { path: `${testDir}/auto/parent/file.txt` } },
			(r) => responses.push(r),
		);
		assertEqual(responses[0].ok, true, 'create with parent ok');
		ok('RPC create 自动创建父目录');
	} catch (err) { fail('RPC create 自动创建父目录', err); }

	// 7f. create 已存在报 ALREADY_EXISTS
	try {
		const responses = [];
		await handler.handleRpcRequest(
			{ id: 'c3', method: 'coclaw.files.create', params: { path: `${testDir}/created.txt` } },
			(r) => responses.push(r),
		);
		assertEqual(responses[0].ok, false);
		assertEqual(responses[0].error.code, 'ALREADY_EXISTS');
		ok('RPC create 已存在返回 ALREADY_EXISTS');
	} catch (err) { fail('RPC create 已存在', err); }

	// 7g. create 空 path
	try {
		const responses = [];
		await handler.handleRpcRequest(
			{ id: 'c4', method: 'coclaw.files.create', params: {} },
			(r) => responses.push(r),
		);
		assertEqual(responses[0].ok, false);
		assertEqual(responses[0].error.code, 'PATH_DENIED');
		ok('RPC create 空 path 返回错误');
	} catch (err) { fail('RPC create 空 path', err); }

	// 7h. mkdir 空 path
	try {
		const responses = [];
		await handler.handleRpcRequest(
			{ id: 'm4', method: 'coclaw.files.mkdir', params: {} },
			(r) => responses.push(r),
		);
		assertEqual(responses[0].ok, false);
		assertEqual(responses[0].error.code, 'PATH_DENIED');
		ok('RPC mkdir 空 path 返回错误');
	} catch (err) { fail('RPC mkdir 空 path', err); }

} finally {
	await cleanup();
}

console.log(`\n=== 结果：${passed} 通过, ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
