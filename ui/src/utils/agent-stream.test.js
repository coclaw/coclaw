import { describe, test, expect } from 'vitest';
import { applyAgentEvent } from './agent-stream.js';

// --- Helper ---

function makeStreamingMsgs() {
	return [
		{
			id: '__local_claw_1',
			_local: true,
			_streaming: true,
			_startTime: 1000,
			message: { role: 'assistant', content: '', stopReason: null },
		},
	];
}

// --- Tests ---

describe('applyAgentEvent', () => {
	test('assistant stream：更新 streaming bot 条目的文本内容', () => {
		const msgs = makeStreamingMsgs();
		const result = applyAgentEvent(msgs, { stream: 'assistant', data: { text: 'hello world' } });

		const entry = msgs.find((m) => m._streaming && m.message.role === 'assistant');
		const textBlock = Array.isArray(entry.message.content)
			? entry.message.content.find((b) => b.type === 'text')
			: null;
		expect(textBlock?.text).toBe('hello world');
		expect(entry.message.stopReason).toBe('stop');
		expect(result.changed).toBe(true);
	});

	test('assistant stream：NO_REPLY 文本被原样写入，由分组器识别为 systemNote', () => {
		const msgs = makeStreamingMsgs();
		const result = applyAgentEvent(msgs, { stream: 'assistant', data: { text: 'NO_REPLY' } });

		const entry = msgs.find((m) => m._streaming && m.message.role === 'assistant');
		const textBlock = Array.isArray(entry.message.content)
			? entry.message.content.find((b) => b.type === 'text')
			: null;
		expect(textBlock?.text).toBe('NO_REPLY');
		expect(entry.message.stopReason).toBe('stop');
		expect(result.changed).toBe(true);
	});

	test('assistant stream：HEARTBEAT_OK 文本被原样写入', () => {
		const msgs = makeStreamingMsgs();
		applyAgentEvent(msgs, { stream: 'assistant', data: { text: 'HEARTBEAT_OK' } });

		const entry = msgs.find((m) => m._streaming && m.message.role === 'assistant');
		const textBlock = entry.message.content.find((b) => b.type === 'text');
		expect(textBlock?.text).toBe('HEARTBEAT_OK');
	});

	test('assistant stream：包含 NO_REPLY 的正常文本被原样写入', () => {
		const msgs = makeStreamingMsgs();
		applyAgentEvent(msgs, { stream: 'assistant', data: { text: 'The agent said NO_REPLY here' } });

		const entry = msgs.find((m) => m._streaming && m.message.role === 'assistant');
		const textBlock = entry.message.content.find((b) => b.type === 'text');
		expect(textBlock?.text).toBe('The agent said NO_REPLY here');
	});

	test('assistant stream：无 streaming 条目时不报错', () => {
		const msgs = [];
		const result = applyAgentEvent(msgs, { stream: 'assistant', data: { text: 'hello' } });
		expect(result.changed).toBe(false);
	});

	test('tool stream start：向 streaming bot 条目追加 toolCall', () => {
		const msgs = makeStreamingMsgs();
		const result = applyAgentEvent(msgs, { stream: 'tool', data: { phase: 'start', name: 'search' } });

		const entry = msgs.find((m) => m._streaming && m.message.role === 'assistant');
		const content = entry.message.content;
		expect(Array.isArray(content)).toBe(true);
		expect(content.some((b) => b.type === 'toolCall' && b.name === 'search')).toBe(true);
		expect(entry.message.stopReason).toBe('toolUse');
		expect(result.changed).toBe(true);
	});

	test('tool stream start：toolCallId/args 透传到 toolCall block', () => {
		const msgs = makeStreamingMsgs();
		applyAgentEvent(msgs, { stream: 'tool', data: {
			phase: 'start',
			name: 'shell',
			toolCallId: 'call_42',
			args: { command: 'ls -la', cwd: '/tmp' },
		} });

		const entry = msgs.find((m) => m._streaming && m.message.role === 'assistant');
		const block = entry.message.content.find((b) => b.type === 'toolCall');
		expect(block).toEqual({
			type: 'toolCall',
			name: 'shell',
			toolCallId: 'call_42',
			args: { command: 'ls -la', cwd: '/tmp' },
		});
	});

	test('tool stream result：追加 toolResult 和新 streaming bot 条目', () => {
		const msgs = makeStreamingMsgs();
		applyAgentEvent(msgs, { stream: 'tool', data: { phase: 'result', result: 'search result text' } });

		const toolResultEntry = msgs.find((m) => m.message?.role === 'toolResult');
		expect(toolResultEntry).toBeTruthy();
		expect(toolResultEntry.message.content).toBe('search result text');

		const newBotEntry = msgs[msgs.length - 1];
		expect(newBotEntry._streaming).toBe(true);
		expect(newBotEntry.message.role).toBe('assistant');
	});

	test('tool stream result：result 为对象时序列化为 JSON', () => {
		const msgs = makeStreamingMsgs();
		applyAgentEvent(msgs, { stream: 'tool', data: { phase: 'result', result: { key: 'val' } } });

		const toolResultEntry = msgs.find((m) => m.message?.role === 'toolResult');
		expect(toolResultEntry.message.content).toBe('{"key":"val"}');
	});

	test('tool stream result：data.result 被网关剥离时兜底为空字符串', () => {
		const msgs = makeStreamingMsgs();
		applyAgentEvent(msgs, { stream: 'tool', data: { phase: 'result' } });

		const toolResultEntry = msgs.find((m) => m.message?.role === 'toolResult');
		expect(toolResultEntry).toBeTruthy();
		expect(toolResultEntry.message.content).toBe('');
	});

	test('tool stream result：继承 startTime', () => {
		const msgs = makeStreamingMsgs();
		applyAgentEvent(msgs, { stream: 'tool', data: { phase: 'result', result: 'ok' } });

		const newBotEntry = msgs[msgs.length - 1];
		expect(newBotEntry._startTime).toBe(1000);
	});

	test('tool stream result：toolCallId/name/isError/meta 透传到 toolResult message', () => {
		const msgs = makeStreamingMsgs();
		applyAgentEvent(msgs, { stream: 'tool', data: {
			phase: 'result',
			name: 'shell',
			toolCallId: 'call_42',
			isError: true,
			meta: { kind: 'exec', exitCode: 1 },
			result: 'permission denied',
		} });

		const trEntry = msgs.find((m) => m.message?.role === 'toolResult');
		expect(trEntry.message).toEqual({
			role: 'toolResult',
			content: 'permission denied',
			toolCallId: 'call_42',
			name: 'shell',
			isError: true,
			meta: { kind: 'exec', exitCode: 1 },
		});
	});

	test('thinking stream：追加 thinking block', () => {
		const msgs = makeStreamingMsgs();
		applyAgentEvent(msgs, { stream: 'thinking', data: { text: '思考中...' } });

		const entry = msgs.find((m) => m._streaming && m.message.role === 'assistant');
		const content = entry.message.content;
		expect(Array.isArray(content)).toBe(true);
		expect(content.some((b) => b.type === 'thinking' && b.thinking === '思考中...')).toBe(true);
	});

	test('thinking stream：更新已有 thinking block（不重复追加）', () => {
		const msgs = makeStreamingMsgs();
		applyAgentEvent(msgs, { stream: 'thinking', data: { text: '初始思考' } });
		applyAgentEvent(msgs, { stream: 'thinking', data: { text: '更新思考' } });

		const entry = msgs.find((m) => m._streaming && m.message.role === 'assistant');
		const thinkingBlocks = entry.message.content.filter((b) => b.type === 'thinking');
		expect(thinkingBlocks).toHaveLength(1);
		expect(thinkingBlocks[0].thinking).toBe('更新思考');
	});

	// lifecycle:end / lifecycle:error 不再产生任何副作用——上游一次 run 内会 emit 多次
	// 中间段 lifecycle:end，把它当终态会导致提前 endRun + 后续事件丢失。终态判定全部走
	// store 端的 RPC 二阶段 res / agent.wait(0) 探测 / 主 RPC reject。
	test('lifecycle end：无副作用（不改 msgs，不返回 settled）', () => {
		const msgs = makeStreamingMsgs();
		const before = JSON.stringify(msgs);
		const result = applyAgentEvent(msgs, { stream: 'lifecycle', data: { phase: 'end' } });

		expect(result.changed).toBe(false);
		expect(result.error).toBe(false);
		expect(result.settled).toBeUndefined();
		expect(JSON.stringify(msgs)).toBe(before);
	});

	test('lifecycle error：无副作用（不改 msgs，不返回 settled）', () => {
		const msgs = makeStreamingMsgs();
		const before = JSON.stringify(msgs);
		const result = applyAgentEvent(msgs, { stream: 'lifecycle', data: { phase: 'error' } });

		expect(result.changed).toBe(false);
		expect(result.error).toBe(false);
		expect(result.settled).toBeUndefined();
		expect(JSON.stringify(msgs)).toBe(before);
	});

	test('ensureContentArray：非空字符串 content 被转换为 text block 数组', () => {
		const msgs = [
			{
				id: '__local_claw_1',
				_local: true,
				_streaming: true,
				message: { role: 'assistant', content: 'initial', stopReason: null },
			},
		];

		applyAgentEvent(msgs, { stream: 'assistant', data: { text: 'new text' } });

		const entry = msgs.find((m) => m._streaming && m.message.role === 'assistant');
		expect(Array.isArray(entry.message.content)).toBe(true);
		const textBlock = entry.message.content.find((b) => b.type === 'text');
		expect(textBlock?.text).toBe('new text');
	});

	test('未知 stream 类型不影响消息', () => {
		const msgs = makeStreamingMsgs();
		const result = applyAgentEvent(msgs, { stream: 'unknown', data: {} });

		expect(result.changed).toBe(false);
	});
});
