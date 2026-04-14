import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTitle, cleanTitle, extractAssistantText, TITLE_SYSTEM_PROMPT } from './title-gen.js';

// --- cleanTitle ---

test('cleanTitle - 普通文本不变', () => {
	assert.equal(cleanTitle('关于部署策略的讨论'), '关于部署策略的讨论');
});

test('cleanTitle - 去除双引号', () => {
	assert.equal(cleanTitle('"关于部署策略的讨论"'), '关于部署策略的讨论');
});

test('cleanTitle - 去除单引号', () => {
	assert.equal(cleanTitle("'标题'"), '标题');
});

test('cleanTitle - 去除中文引号', () => {
	assert.equal(cleanTitle('\u300C标题\u300D'), '标题');
	assert.equal(cleanTitle('\u201C标题\u201D'), '标题');
	assert.equal(cleanTitle('\u2018标题\u2019'), '标题');
});

test('cleanTitle - 超长截断至 128 字符', () => {
	const long = 'a'.repeat(200);
	assert.equal(cleanTitle(long).length, 128);
});

test('cleanTitle - 空值和非字符串', () => {
	assert.equal(cleanTitle(null), '');
	assert.equal(cleanTitle(undefined), '');
	assert.equal(cleanTitle(''), '');
	assert.equal(cleanTitle(123), '');
});

test('cleanTitle - 首尾空白', () => {
	assert.equal(cleanTitle('  hello  '), 'hello');
});

test('cleanTitle - 引号内容过短不去除', () => {
	// 只有引号，长度 <= 2
	assert.equal(cleanTitle('""'), '');
});

// --- cleanTitle 前缀清洗 ---

test('cleanTitle - 去除中文前缀"好的，标题是：xxx"', () => {
	assert.equal(cleanTitle('好的，标题是：量子计算入门'), '量子计算入门');
	assert.equal(cleanTitle('好的,标题是：量子计算入门'), '量子计算入门');
});

test('cleanTitle - 去除"标题：xxx"前缀', () => {
	assert.equal(cleanTitle('标题：量子计算入门'), '量子计算入门');
	assert.equal(cleanTitle('标题:量子计算入门'), '量子计算入门');
});

test('cleanTitle - 去除"以下是标题：xxx"前缀', () => {
	assert.equal(cleanTitle('以下是标题：如何部署应用'), '如何部署应用');
	assert.equal(cleanTitle('以下是对话标题：如何部署应用'), '如何部署应用');
});

test('cleanTitle - 去除"好的，让我为你生成标题：xxx"', () => {
	assert.equal(cleanTitle('好的，让我为你生成标题：Docker 部署指南'), 'Docker 部署指南');
});

test('cleanTitle - 去除英文 Title: 前缀', () => {
	assert.equal(cleanTitle('Title: Quantum Computing Basics'), 'Quantum Computing Basics');
	assert.equal(cleanTitle('title: quantum computing'), 'quantum computing');
});

test('cleanTitle - 去除 Here is the title: 前缀', () => {
	assert.equal(cleanTitle('Here is the title: Deploy Guide'), 'Deploy Guide');
	assert.equal(cleanTitle('Sure, the title is: Deploy Guide'), 'Deploy Guide');
});

test('cleanTitle - 多行响应只取第一行', () => {
	assert.equal(cleanTitle('量子计算入门\n\n这个标题概括了对话的主要内容'), '量子计算入门');
	assert.equal(cleanTitle('量子计算入门\r\n解释文字'), '量子计算入门');
});

test('cleanTitle - 前缀 + 引号组合', () => {
	assert.equal(cleanTitle('标题："量子计算入门"'), '量子计算入门');
	assert.equal(cleanTitle('Title: "Deploy Guide"'), 'Deploy Guide');
});

// --- extractAssistantText ---

test('extractAssistantText - 正常提取', () => {
	const res = {
		payload: {
			result: {
				payloads: [{ text: '部署策略讨论' }],
			},
		},
	};
	assert.equal(extractAssistantText(res), '部署策略讨论');
});

test('extractAssistantText - 空文本跳过', () => {
	const res = {
		payload: {
			result: {
				payloads: [{ text: '' }, { text: '  有效  ' }],
			},
		},
	};
	assert.equal(extractAssistantText(res), '有效');
});

test('extractAssistantText - 无有效 payload', () => {
	assert.equal(extractAssistantText({}), null);
	assert.equal(extractAssistantText({ payload: {} }), null);
	assert.equal(extractAssistantText({ payload: { result: {} } }), null);
	assert.equal(extractAssistantText({ payload: { result: { payloads: [] } } }), null);
	assert.equal(extractAssistantText({ payload: { result: { payloads: [{ text: '' }] } } }), null);
	assert.equal(extractAssistantText({ payload: { result: { payloads: [{ noText: true }] } } }), null);
});

// --- TITLE_SYSTEM_PROMPT ---

test('TITLE_SYSTEM_PROMPT 应包含关键指令', () => {
	assert.ok(TITLE_SYSTEM_PROMPT.includes('title generator'));
	assert.ok(TITLE_SYSTEM_PROMPT.includes('Do NOT call any tools'));
});

// --- generateTitle ---

function makeMockTopicManager(opts = {}) {
	const topics = opts.topics ?? [
		{ topicId: 'topic-1', agentId: 'main', title: null, createdAt: 1000 },
	];
	let updatedTitle = null;
	let copyCalled = false;
	let cleanupCalled = false;

	return {
		get({ topicId }) {
			const found = topics.find((t) => t.topicId === topicId);
			return { topic: found ?? null };
		},
		async copyTranscript() {
			copyCalled = true;
			if (opts.copyError) throw opts.copyError;
			return { tempId: 'temp-uuid', tempPath: '/tmp/temp-uuid.jsonl' };
		},
		async updateTitle({ topicId, title }) {
			if (opts.updateError) throw opts.updateError;
			updatedTitle = { topicId, title };
		},
		async cleanupTempFile() {
			cleanupCalled = true;
			if (opts.cleanupError) throw opts.cleanupError;
		},
		// 测试观测用
		get _updatedTitle() { return updatedTitle; },
		get _copyCalled() { return copyCalled; },
		get _cleanupCalled() { return cleanupCalled; },
	};
}

test('generateTitle - 成功生成标题', async () => {
	const mgr = makeMockTopicManager();
	const agentRpc = async () => ({
		ok: true,
		response: {
			payload: {
				status: 'ok',
				result: { payloads: [{ text: '部署策略讨论' }] },
			},
		},
	});
	const result = await generateTitle({
		topicId: 'topic-1',
		topicManager: mgr,
		agentRpc,
		logger: { warn() {} },
	});
	assert.equal(result.title, '部署策略讨论');
	assert.equal(mgr._updatedTitle.title, '部署策略讨论');
	assert.ok(mgr._cleanupCalled);
});

test('generateTitle - 传递 timeoutMs=300_000 / acceptTimeoutMs=10_000 给 agentRpc', async () => {
	const mgr = makeMockTopicManager();
	let capturedOpts = null;
	const agentRpc = async (_method, _params, opts) => {
		capturedOpts = opts;
		return {
			ok: true,
			response: {
				payload: {
					status: 'ok',
					result: { payloads: [{ text: '标题' }] },
				},
			},
		};
	};
	await generateTitle({
		topicId: 'topic-1',
		topicManager: mgr,
		agentRpc,
		logger: { warn() {} },
	});
	assert.equal(capturedOpts.timeoutMs, 300_000);
	assert.equal(capturedOpts.acceptTimeoutMs, 10_000);
});

test('generateTitle - topic 不存在时抛出错误', async () => {
	const mgr = makeMockTopicManager();
	await assert.rejects(
		() => generateTitle({
			topicId: 'nonexistent',
			topicManager: mgr,
			agentRpc: async () => ({ ok: true }),
			logger: { warn() {} },
		}),
		/Topic not found/,
	);
});

test('generateTitle - agent RPC 失败时抛出并清理', async () => {
	const mgr = makeMockTopicManager();
	const agentRpc = async () => ({ ok: false, error: 'timeout' });
	await assert.rejects(
		() => generateTitle({
			topicId: 'topic-1',
			topicManager: mgr,
			agentRpc,
			logger: { warn() {} },
		}),
		/Agent RPC failed: timeout/,
	);
	assert.ok(mgr._cleanupCalled);
});

test('generateTitle - 无 assistant 文本时抛出并清理', async () => {
	const mgr = makeMockTopicManager();
	const agentRpc = async () => ({
		ok: true,
		response: { payload: { status: 'ok', result: { payloads: [] } } },
	});
	await assert.rejects(
		() => generateTitle({
			topicId: 'topic-1',
			topicManager: mgr,
			agentRpc,
			logger: { warn() {} },
		}),
		/No assistant text/,
	);
	assert.ok(mgr._cleanupCalled);
});

test('generateTitle - 清洗后标题为空时抛出', async () => {
	const mgr = makeMockTopicManager();
	const agentRpc = async () => ({
		ok: true,
		response: {
			payload: { status: 'ok', result: { payloads: [{ text: '""' }] } },
		},
	});
	await assert.rejects(
		() => generateTitle({
			topicId: 'topic-1',
			topicManager: mgr,
			agentRpc,
			logger: { warn() {} },
		}),
		/Title is empty/,
	);
});

test('generateTitle - cleanup 失败不影响主流程（成功路径）', async () => {
	const mgr = makeMockTopicManager({ cleanupError: new Error('cleanup fail') });
	const agentRpc = async () => ({
		ok: true,
		response: {
			payload: { status: 'ok', result: { payloads: [{ text: '标题OK' }] } },
		},
	});
	// cleanupTempFile 内部 .catch() 吞掉了，但 mock 直接抛出
	// generateTitle 的 finally 中有 .catch()
	const result = await generateTitle({
		topicId: 'topic-1',
		topicManager: mgr,
		agentRpc,
		logger: { warn() {} },
	});
	assert.equal(result.title, '标题OK');
});

test('generateTitle - 默认 logger', async () => {
	const mgr = makeMockTopicManager();
	const agentRpc = async () => ({ ok: false, error: 'fail' });
	// 不传 logger，使用默认 console
	await assert.rejects(
		() => generateTitle({
			topicId: 'topic-1',
			topicManager: mgr,
			agentRpc,
		}),
		/Agent RPC failed/,
	);
});

test('generateTitle - agent RPC 无 error 字段', async () => {
	const mgr = makeMockTopicManager();
	const agentRpc = async () => ({ ok: false });
	await assert.rejects(
		() => generateTitle({
			topicId: 'topic-1',
			topicManager: mgr,
			agentRpc,
			logger: { warn() {} },
		}),
		/Agent RPC failed: unknown/,
	);
});
