import assert from 'node:assert/strict';
import test from 'node:test';

import {
	isVerificationNote,
	extractVerification,
	findDeviceCodeMethod,
	makeDeviceCodeCtx,
} from './device-code-login.js';

// codex / copilot 实际验证 note 模板（URL 行 + Code 行）
const CODEX_NOTE = [
	'Open this URL in your LOCAL browser and enter the code below.',
	'URL: https://auth.openai.com/codex/device',
	'Code: ABCD-1234',
	'Code expires in 15 minutes. Never share it.',
].join('\n');

const COPILOT_NOTE = [
	'Open this URL in your browser and enter the code below.',
	'URL: https://github.com/login/device',
	'Code: WXYZ-9876',
	'Code expires in 15 minutes. Never share it.',
	'',
	'If a browser does not open automatically after you continue, copy the URL manually.',
].join('\n');

// === isVerificationNote ===

test('isVerificationNote: 含 URL 的验证 note 为真', () => {
	assert.equal(isVerificationNote(CODEX_NOTE), true);
	assert.equal(isVerificationNote(COPILOT_NOTE), true);
});

test('isVerificationNote: 无 URL 的前导语为假（copilot 首条）', () => {
	assert.equal(isVerificationNote('This will open a GitHub device login to authorize Copilot.'), false);
});

test('isVerificationNote: 含 URL 但是帮助/FAQ 文案为假（codex 失败 note）', () => {
	assert.equal(
		isVerificationNote('Trouble with device code login? See https://docs.openclaw.ai/start/faq'),
		false,
	);
});

test('isVerificationNote: 空/非串安全为假', () => {
	assert.equal(isVerificationNote(''), false);
	assert.equal(isVerificationNote(undefined), false);
	assert.equal(isVerificationNote(null), false);
});

// === extractVerification ===

test('extractVerification: 从 URL/Code 行抠出结构化字段', () => {
	assert.deepEqual(extractVerification(CODEX_NOTE), {
		verificationUri: 'https://auth.openai.com/codex/device',
		userCode: 'ABCD-1234',
	});
	assert.deepEqual(extractVerification(COPILOT_NOTE), {
		verificationUri: 'https://github.com/login/device',
		userCode: 'WXYZ-9876',
	});
});

test('extractVerification: 无 URL/Code 行时回退首个链接 + 设备码样式短码', () => {
	const text = 'go to https://example.com/dev now, then enter PQRS-4321 there';
	assert.deepEqual(extractVerification(text), {
		verificationUri: 'https://example.com/dev',
		userCode: 'PQRS-4321',
	});
});

test('extractVerification: 抠不到时返回 null（不抛错）', () => {
	assert.deepEqual(extractVerification('no url and no code here'), {
		verificationUri: null,
		userCode: null,
	});
	assert.deepEqual(extractVerification(undefined), { verificationUri: null, userCode: null });
});

test('extractVerification: 码在 URL 里（minimax 式）也能抠 URL', () => {
	// 本通道主要给 codex/copilot；这里只验证 URL 抠取对「码嵌 URL」形态不挂
	const text = 'Visit https://api.example.com/auth?user_code=AB12CD to continue.';
	const out = extractVerification(text);
	assert.equal(out.verificationUri, 'https://api.example.com/auth?user_code=AB12CD');
});

// === findDeviceCodeMethod ===

test('findDeviceCodeMethod: 命中 device_code 方法', () => {
	const run = async () => ({ profiles: [] });
	const providers = [
		{ id: 'github-copilot', auth: [{ id: 'device', kind: 'device_code', run }] },
	];
	const m = findDeviceCodeMethod(providers, 'github-copilot');
	assert.equal(m?.run, run);
});

test('findDeviceCodeMethod: provider 有 oauth 方法但无 device_code → null（codex 的 oauth 法不入）', () => {
	const providers = [
		{ id: 'openai-codex', auth: [{ id: 'oauth', kind: 'oauth', run: async () => ({}) }] },
	];
	assert.equal(findDeviceCodeMethod(providers, 'openai-codex'), null);
});

test('findDeviceCodeMethod: device_code 方法但 run 不是函数 → null', () => {
	const providers = [{ id: 'x', auth: [{ id: 'device', kind: 'device_code', run: 'nope' }] }];
	assert.equal(findDeviceCodeMethod(providers, 'x'), null);
});

test('findDeviceCodeMethod: provider 不存在 / 无 auth → null', () => {
	assert.equal(findDeviceCodeMethod([], 'missing'), null);
	assert.equal(findDeviceCodeMethod([{ id: 'x' }], 'x'), null);
	assert.equal(findDeviceCodeMethod(undefined, 'x'), null);
});

// === makeDeviceCodeCtx ===

test('makeDeviceCodeCtx: note 转发给 onNote；progress/openUrl/confirm 安全', async () => {
	const notes = [];
	const ctx = makeDeviceCodeCtx({
		config: { foo: 1 },
		agentDir: '/a/dir',
		onNote: (text, title) => notes.push({ text, title }),
	});
	assert.deepEqual(ctx.config, { foo: 1 });
	assert.equal(ctx.agentDir, '/a/dir');
	assert.equal(ctx.isRemote, true);

	await ctx.prompter.note('hello', 'Title');
	assert.deepEqual(notes, [{ text: 'hello', title: 'Title' }]);

	// progress 返回可调对象、不抛
	const spin = ctx.prompter.progress('start');
	assert.doesNotThrow(() => { spin.update('x'); spin.stop('y'); });
	// confirm 答 true（重登放行）
	assert.equal(await ctx.prompter.confirm({ message: 're-login?' }), true);
	// openUrl / intro / outro / plain 空操作不抛
	await ctx.openUrl('https://x');
	await ctx.prompter.intro('i');
	await ctx.prompter.outro('o');
	await ctx.prompter.plain('p');
});

test('makeDeviceCodeCtx: 真交互入口被调即抛（标记需交互不支持）', async () => {
	const ctx = makeDeviceCodeCtx({ config: {}, onNote: () => {} });
	await assert.rejects(() => ctx.prompter.text({ message: 'x' }), /no text input/);
	await assert.rejects(() => ctx.prompter.select({ message: 'x' }), /no selection/);
	await assert.rejects(() => ctx.prompter.multiselect({ message: 'x' }), /no multiselect/);
	assert.throws(() => ctx.oauth.createVpsAwareHandlers({}), /loopback/);
});

test('makeDeviceCodeCtx: config 省略时兜底空对象，runtime 三件套不抛', () => {
	const ctx = makeDeviceCodeCtx({ onNote: () => {} });
	assert.deepEqual(ctx.config, {});
	assert.equal(ctx.agentDir, undefined);
	assert.doesNotThrow(() => { ctx.runtime.log('a'); ctx.runtime.error('b'); ctx.runtime.exit(0); });
});
