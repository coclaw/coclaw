import { test, expect, describe } from 'vitest';
import { groupSessionMessages, stripOcPrefixes, cleanDerivedTitle } from './session-msg-group.js';

// 辅助：创建 JSONL 条目
function userEntry(id, text, ts = null) {
	return {
		type: 'message',
		id,
		message: {
			role: 'user',
			content: [{ type: 'text', text }],
			timestamp: ts,
		},
	};
}

function assistantEntry(id, { text = null, thinking = null, toolCalls = [], stopReason = 'stop', model = 'test-model', ts = null, _streaming = false, _startTime = undefined } = {}) {
	const content = [];
	if (thinking) {
		content.push({ type: 'thinking', thinking });
	}
	for (const tc of toolCalls) {
		content.push({ type: 'toolCall', id: tc.id ?? 'call_1', name: tc.name });
	}
	if (text) {
		content.push({ type: 'text', text });
	}
	const entry = {
		type: 'message',
		id,
		message: {
			role: 'assistant',
			content,
			stopReason,
			model,
			timestamp: ts,
		},
	};
	if (_streaming) entry._streaming = true;
	if (_startTime !== undefined) entry._startTime = _startTime;
	return entry;
}

function toolResultEntry(id, text, ts = null, { _streaming = false } = {}) {
	const entry = {
		type: 'message',
		id,
		message: {
			role: 'toolResult',
			toolCallId: 'call_1',
			toolName: 'some_tool',
			content: [{ type: 'text', text }],
			isError: false,
			timestamp: ts,
		},
	};
	if (_streaming) entry._streaming = true;
	return entry;
}

describe('groupSessionMessages', () => {
	test('基本 user→assistant 分组', () => {
		const entries = [
			userEntry('u1', '你好', 1000),
			assistantEntry('a1', { text: '你好！', ts: 2000 }),
		];
		const result = groupSessionMessages(entries);

		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			type: 'user',
			id: 'u1',
			textContent: '你好',
			images: [],
			timestamp: 1000,
		});
		expect(result[1]).toEqual({
			type: 'botTask',
			id: 'a1',
			resultText: '你好！',
			model: 'test-model',
			timestamp: 2000,
			duration: 1000,
			steps: [],
			images: [],
			isStreaming: false,
			startTime: null,
		});
	});

	test('多轮 tool call 合并为一个 botTask', () => {
		const entries = [
			userEntry('u1', '帮我查一下'),
			assistantEntry('a1', {
				thinking: '需要查询',
				toolCalls: [{ name: 'search' }],
				stopReason: 'toolUse',
				ts: 1000,
			}),
			toolResultEntry('tr1', '搜索结果：xxx', 1500),
			assistantEntry('a2', {
				thinking: '还需要确认',
				toolCalls: [{ name: 'verify' }],
				stopReason: 'toolUse',
				ts: 2000,
			}),
			toolResultEntry('tr2', '确认结果：ok', 2500),
			assistantEntry('a3', { text: '查询结果如下...', ts: 3000 }),
		];

		const result = groupSessionMessages(entries);
		expect(result).toHaveLength(2);

		const task = result[1];
		expect(task.type).toBe('botTask');
		expect(task.id).toBe('a1');
		expect(task.resultText).toBe('查询结果如下...');
		expect(task.model).toBe('test-model');
		expect(task.timestamp).toBe(3000);

		// 中间步骤
		expect(task.steps).toEqual([
			{ kind: 'thinking', text: '需要查询' },
			{ kind: 'toolCall', name: 'search' },
			{ kind: 'toolResult', text: '搜索结果：xxx' },
			{ kind: 'thinking', text: '还需要确认' },
			{ kind: 'toolCall', name: 'verify' },
			{ kind: 'toolResult', text: '确认结果：ok' },
		]);
	});

	test('steer 中断：botTask 无 resultText', () => {
		const entries = [
			userEntry('u1', '开始任务'),
			assistantEntry('a1', {
				thinking: '正在处理',
				toolCalls: [{ name: 'do_something' }],
				stopReason: 'toolUse',
				ts: 1000,
			}),
			toolResultEntry('tr1', '处理中...', 1500),
			// 没有 stopReason=stop 的 assistant，直接下一个 user
			userEntry('u2', '换个话题'),
		];

		const result = groupSessionMessages(entries);
		expect(result).toHaveLength(3);

		const task = result[1];
		expect(task.type).toBe('botTask');
		expect(task.resultText).toBeNull();
		expect(task.steps).toHaveLength(3);
	});

	test('跳过非 message 条目', () => {
		const entries = [
			{ type: 'session', id: 's1', data: {} },
			userEntry('u1', '你好'),
			{ type: 'model_change', id: 'mc1', data: {} },
			assistantEntry('a1', { text: '嗨！' }),
			{ type: 'custom', id: 'c1', data: {} },
		];

		const result = groupSessionMessages(entries);
		expect(result).toHaveLength(2);
		expect(result[0].type).toBe('user');
		expect(result[1].type).toBe('botTask');
	});

	test('content 为字符串的兜底', () => {
		const entries = [
			{
				type: 'message',
				id: 'u1',
				message: {
					role: 'user',
					content: '纯字符串内容',
					timestamp: 1000,
				},
			},
			{
				type: 'message',
				id: 'a1',
				message: {
					role: 'assistant',
					content: '助手回复',
					stopReason: 'stop',
					model: 'test',
					timestamp: 2000,
				},
			},
		];

		const result = groupSessionMessages(entries);
		expect(result).toHaveLength(2);
		expect(result[0].textContent).toBe('纯字符串内容');
		expect(result[1].resultText).toBe('助手回复');
	});

	test('空数组返回空结果', () => {
		expect(groupSessionMessages([])).toEqual([]);
	});

	test('多轮对话交替分组', () => {
		const entries = [
			userEntry('u1', '第一句'),
			assistantEntry('a1', { text: '回复一' }),
			userEntry('u2', '第二句'),
			assistantEntry('a2', { text: '回复二' }),
		];

		const result = groupSessionMessages(entries);
		expect(result).toHaveLength(4);
		expect(result.map((i) => i.type)).toEqual(['user', 'botTask', 'user', 'botTask']);
	});

	test('assistant 带 thinking 但无 tool call（直接回复）', () => {
		const entries = [
			userEntry('u1', '问题'),
			assistantEntry('a1', { text: '回答', thinking: '思考中...' }),
		];

		const result = groupSessionMessages(entries);
		const task = result[1];
		expect(task.resultText).toBe('回答');
		expect(task.steps).toEqual([
			{ kind: 'thinking', text: '思考中...' },
		]);
	});

	test('中间 assistant 的 text blocks 归入 steps', () => {
		const entries = [
			userEntry('u1', '问题'),
			assistantEntry('a1', {
				text: '中间文本',
				toolCalls: [{ name: 'tool1' }],
				stopReason: 'toolUse',
			}),
			toolResultEntry('tr1', '结果'),
			assistantEntry('a2', { text: '最终回答' }),
		];

		const result = groupSessionMessages(entries);
		const task = result[1];
		// 中间 assistant 的 text 归入 steps
		expect(task.steps).toContainEqual({ kind: 'thinking', text: '中间文本' });
		expect(task.resultText).toBe('最终回答');
	});

	test('末尾未结束的 botTask 也被收集', () => {
		const entries = [
			userEntry('u1', '问题'),
			assistantEntry('a1', {
				toolCalls: [{ name: 'tool1' }],
				stopReason: 'toolUse',
			}),
		];

		const result = groupSessionMessages(entries);
		expect(result).toHaveLength(2);
		expect(result[1].type).toBe('botTask');
		expect(result[1].resultText).toBeNull();
	});

	test('跳过缺少 message 字段的条目', () => {
		const entries = [
			{ type: 'message', id: 'bad1' },
			userEntry('u1', '正常消息'),
		];

		const result = groupSessionMessages(entries);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('u1');
	});

	test('去除用户消息的时间戳前缀', () => {
		const entries = [
			userEntry('u1', '[Fri 2026-02-20 15:25 GMT+8] 你好'),
		];
		const result = groupSessionMessages(entries);
		expect(result[0].textContent).toBe('你好');
	});

	test('去除用户消息带秒的时间戳前缀', () => {
		const entries = [
			userEntry('u1', '[Sun 2026-03-01 17:08:30 GMT+8] 测试'),
		];
		const result = groupSessionMessages(entries);
		expect(result[0].textContent).toBe('测试');
	});

	test('去除 assistant 的 [[reply_to_current]] 标签', () => {
		const entries = [
			userEntry('u1', '问题'),
			assistantEntry('a1', { text: '[[reply_to_current]] 回答内容' }),
		];
		const result = groupSessionMessages(entries);
		expect(result[1].resultText).toBe('回答内容');
	});

	test('去除 assistant 的 [[reply_to:xxx]] 标签', () => {
		const entries = [
			userEntry('u1', '问题'),
			assistantEntry('a1', { text: '[[reply_to: msg_123]] 回答内容' }),
		];
		const result = groupSessionMessages(entries);
		expect(result[1].resultText).toBe('回答内容');
	});

	test('botTask duration 等于 task.timestamp - user.timestamp', () => {
		const entries = [
			userEntry('u1', '你好', 5000),
			assistantEntry('a1', { text: '嗨！', ts: 8000 }),
		];
		const result = groupSessionMessages(entries);
		expect(result[1].duration).toBe(3000);
	});

	test('无时间戳时 duration 为 null', () => {
		const entries = [
			userEntry('u1', '你好'),
			assistantEntry('a1', { text: '嗨！' }),
		];
		const result = groupSessionMessages(entries);
		expect(result[1].duration).toBeNull();
	});

	test('user 消息提取 images', () => {
		const entries = [
			{
				type: 'message',
				id: 'u1',
				message: {
					role: 'user',
					content: [
						{ type: 'text', text: '看这张图' },
						{ type: 'image', data: 'abc123', mimeType: 'image/png' },
					],
					timestamp: 1000,
				},
			},
		];
		const result = groupSessionMessages(entries);
		expect(result[0].images).toEqual([{ data: 'abc123', mimeType: 'image/png' }]);
		expect(result[0].textContent).toBe('看这张图');
	});

	test('toolResult 中的 image 同时进入 steps 和 botTask.images', () => {
		const entries = [
			userEntry('u1', '截图'),
			assistantEntry('a1', {
				toolCalls: [{ name: 'screenshot' }],
				stopReason: 'toolUse',
				ts: 1000,
			}),
			{
				type: 'message',
				id: 'tr1',
				message: {
					role: 'toolResult',
					toolCallId: 'call_1',
					toolName: 'screenshot',
					content: [
						{ type: 'text', text: '截图完成' },
						{ type: 'image', data: 'imgdata', mimeType: 'image/jpeg' },
					],
					isError: false,
					timestamp: 1500,
				},
			},
			assistantEntry('a2', { text: '这是截图结果', ts: 2000 }),
		];
		const result = groupSessionMessages(entries);
		const task = result[1];
		// steps 中有 image
		expect(task.steps).toContainEqual({ kind: 'image', data: 'imgdata', mimeType: 'image/jpeg' });
		// 顶层 images
		expect(task.images).toEqual([{ data: 'imgdata', mimeType: 'image/jpeg' }]);
	});

	test('无图像时 images 为空数组', () => {
		const entries = [
			userEntry('u1', '纯文本'),
			assistantEntry('a1', { text: '回复' }),
		];
		const result = groupSessionMessages(entries);
		expect(result[0].images).toEqual([]);
		expect(result[1].images).toEqual([]);
	});

	test('image block 缺少 data 时被忽略', () => {
		const entries = [
			{
				type: 'message',
				id: 'u1',
				message: {
					role: 'user',
					content: [
						{ type: 'image', mimeType: 'image/png' },
						{ type: 'image', data: 'valid', mimeType: 'image/png' },
					],
					timestamp: 1000,
				},
			},
		];
		const result = groupSessionMessages(entries);
		expect(result[0].images).toHaveLength(1);
		expect(result[0].images[0].data).toBe('valid');
	});

	test('tool_use block type 也被识别', () => {
		const entries = [
			userEntry('u1', '问题'),
			{
				type: 'message',
				id: 'a1',
				message: {
					role: 'assistant',
					content: [{ type: 'tool_use', name: 'my_tool', id: 'tu_1' }],
					stopReason: 'toolUse',
					model: 'test',
					timestamp: 1000,
				},
			},
			toolResultEntry('tr1', '结果'),
			assistantEntry('a2', { text: '完成' }),
		];

		const result = groupSessionMessages(entries);
		const task = result[1];
		expect(task.steps).toContainEqual({ kind: 'toolCall', name: 'my_tool' });
	});

	test('_streaming 条目标记传递到 botTask.isStreaming', () => {
		const entries = [
			userEntry('u1', '你好'),
			assistantEntry('a1', { text: '回复中', _streaming: true }),
		];
		const result = groupSessionMessages(entries);
		expect(result[1].isStreaming).toBe(true);
	});

	test('_startTime 条目标记传递到 botTask.startTime', () => {
		const entries = [
			userEntry('u1', '你好'),
			assistantEntry('a1', { text: '回复', _startTime: 12345 }),
		];
		const result = groupSessionMessages(entries);
		expect(result[1].startTime).toBe(12345);
	});

	test('多个 _streaming 条目中只取第一个 _startTime', () => {
		const entries = [
			userEntry('u1', '问题'),
			assistantEntry('a1', {
				toolCalls: [{ name: 'tool1' }],
				stopReason: 'toolUse',
				_streaming: true,
				_startTime: 1000,
			}),
			toolResultEntry('tr1', '结果'),
			assistantEntry('a2', {
				text: '最终回答',
				_streaming: true,
				_startTime: 2000,
			}),
		];
		const result = groupSessionMessages(entries);
		const task = result[1];
		expect(task.isStreaming).toBe(true);
		// startTime 取第一个条目的值
		expect(task.startTime).toBe(1000);
	});

	test('toolResult 条目的 _streaming 也传递到 botTask', () => {
		const entries = [
			userEntry('u1', '问题'),
			assistantEntry('a1', {
				toolCalls: [{ name: 'tool1' }],
				stopReason: 'toolUse',
			}),
			toolResultEntry('tr1', '结果', null, { _streaming: true }),
			assistantEntry('a2', { text: '完成' }),
		];
		const result = groupSessionMessages(entries);
		expect(result[1].isStreaming).toBe(true);
	});

	test('无 _streaming 标记时 isStreaming 为 false', () => {
		const entries = [
			userEntry('u1', '你好'),
			assistantEntry('a1', { text: '回复' }),
		];
		const result = groupSessionMessages(entries);
		expect(result[1].isStreaming).toBe(false);
		expect(result[1].startTime).toBeNull();
	});
});

describe('stripOcPrefixes', () => {
	test('去除用户时间戳前缀', () => {
		expect(stripOcPrefixes('[Fri 2026-02-20 15:25 GMT+8] 你好', 'user')).toBe('你好');
	});

	test('去除带秒的用户时间戳前缀', () => {
		expect(stripOcPrefixes('[Sun 2026-03-01 17:08:30 UTC] msg', 'user')).toBe('msg');
	});

	test('不影响非时间戳开头的用户消息', () => {
		expect(stripOcPrefixes('普通消息', 'user')).toBe('普通消息');
	});

	test('去除 [[reply_to_current]]', () => {
		expect(stripOcPrefixes('[[reply_to_current]] 内容', 'assistant')).toBe('内容');
	});

	test('去除带空格的 [[ reply_to_current ]]', () => {
		expect(stripOcPrefixes('[[ reply_to_current ]] 内容', 'assistant')).toBe('内容');
	});

	test('去除 [[reply_to: msg_id]]', () => {
		expect(stripOcPrefixes('[[reply_to: msg_123]] 内容', 'assistant')).toBe('内容');
	});

	test('不影响无标签的 assistant 消息', () => {
		expect(stripOcPrefixes('普通回复', 'assistant')).toBe('普通回复');
	});

	test('不删除正文中间的 [[reply_to_current]]', () => {
		const text = '前面的内容 [[reply_to_current]] 后面的内容';
		expect(stripOcPrefixes(text, 'assistant')).toBe(text);
	});

	test('不删除正文中间的时间戳格式文本', () => {
		const text = '他说 [Fri 2026-02-20 15:25 GMT+8] 这个时间有问题';
		expect(stripOcPrefixes(text, 'user')).toBe(text);
	});

	test('空字符串返回空', () => {
		expect(stripOcPrefixes('', 'user')).toBe('');
	});

	test('null/undefined 原样返回', () => {
		expect(stripOcPrefixes(null, 'user')).toBeNull();
	});

	test('去除 Conversation info 头部 + 时间戳前缀', () => {
		const text = 'Conversation info (untrusted metadata):\n```json\n{\n  "message_id": "2fb109dc",\n  "sender": "openclaw-control-ui"\n}\n```\n\n[Wed 2026-02-18 20:12 GMT+8] 这是我截图的权限信息';
		expect(stripOcPrefixes(text, 'user')).toBe('这是我截图的权限信息');
	});

	test('去除 Sender (untrusted metadata) 头部 + 时间戳前缀', () => {
		const text = 'Sender (untrusted metadata):\n```json\n{\n  "label": "openclaw-control-ui",\n  "id": "openclaw-control-ui"\n}\n```\n\n[Wed 2026-03-04 01:03 GMT+8] 现在能自动完成操作，不会僵住了。';
		expect(stripOcPrefixes(text, 'user')).toBe('现在能自动完成操作，不会僵住了。');
	});

	test('去除尾部 [message_id: xxx]', () => {
		const text = '[Wed 2026-02-18 17:51 GMT+8] 好，按方案 A 执行\n[message_id: bb7a9007-ad9e-4f13-bcf5-9b32c383a247]';
		expect(stripOcPrefixes(text, 'user')).toBe('好，按方案 A 执行');
	});

	test('同时去除 Conversation info 头部、时间戳和尾部 message_id', () => {
		const text = 'Conversation info (untrusted metadata):\n```json\n{\n  "message_id": "abc",\n  "sender": "openclaw-control-ui"\n}\n```\n\n[Wed 2026-02-18 18:53 GMT+8] 实际内容\n[message_id: abc]';
		expect(stripOcPrefixes(text, 'user')).toBe('实际内容');
	});

	test('不影响正文中的 message_id 格式文本', () => {
		const text = '[Wed 2026-02-18 17:49 GMT+8] 日志中出现 [message_id: xxx] 这样的内容';
		expect(stripOcPrefixes(text, 'user')).toBe('日志中出现 [message_id: xxx] 这样的内容');
	});
});

describe('cleanDerivedTitle', () => {
	test('去除时间戳前缀', () => {
		expect(cleanDerivedTitle('[Mon 2026-03-02 16:16 GMT+8] 你好世界')).toBe('你好世界');
	});

	test('去除 cron:uuid 并保留 task-name（无方括号）', () => {
		expect(cleanDerivedTitle('[cron:d59196ed-27ee-42fc-ad60-8ad19aafd4ba workspace-backup-1300-1900]'))
			.toBe('workspace-backup-1300-1900');
	});

	test('同时去除时间戳和 cron:uuid', () => {
		const text = '[Mon 2026-03-02 16:16 GMT+8] [cron:d59196ed-27ee-42fc-ad60-8ad19aafd4ba workspace-backup-1300-1900] 请备份工作区';
		expect(cleanDerivedTitle(text)).toBe('workspace-backup-1300-1900 请备份工作区');
	});

	test('仅有 cron:uuid 无 task-name 时整体移除', () => {
		expect(cleanDerivedTitle('[cron:aabbccdd-1122-3344-5566-778899aabbcc]')).toBe('');
	});

	test('cron:uuid 后跟正文', () => {
		expect(cleanDerivedTitle('[cron:aabbccdd-1122-3344-5566-778899aabbcc] 正文内容'))
			.toBe('正文内容');
	});

	test('null/undefined 返回空字符串', () => {
		expect(cleanDerivedTitle(null)).toBe('');
		expect(cleanDerivedTitle(undefined)).toBe('');
	});

	test('空字符串返回空字符串', () => {
		expect(cleanDerivedTitle('')).toBe('');
	});

	test('无特殊前缀时原样返回（trim）', () => {
		expect(cleanDerivedTitle('  普通标题  ')).toBe('普通标题');
	});

	test('去除 Conversation info 头部', () => {
		const text = 'Conversation info (untrusted metadata):\n```json\n{"sender":"ui"}\n```\n\n[Wed 2026-02-18 20:12 GMT+8] 实际内容';
		expect(cleanDerivedTitle(text)).toBe('实际内容');
	});

	test('去除 Sender (untrusted metadata) 头部', () => {
		const text = 'Sender (untrusted metadata):\n```json\n{"label":"openclaw-control-ui","id":"openclaw-control-ui"}\n```\n\n[Wed 2026-03-04 01:03 GMT+8] 实际内容';
		expect(cleanDerivedTitle(text)).toBe('实际内容');
	});
});
