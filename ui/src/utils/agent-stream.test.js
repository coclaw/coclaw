import { describe, test, expect } from 'vitest';
import { applyAgentEvent } from './agent-stream.js';

// --- Helper ---

function makeStreamingMsgs() {
	return [
		{
			id: '__local_bot_1',
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
		expect(result.settled).toBe(false);
	});

	test('assistant stream：过滤 NO_REPLY 静默回复', () => {
		const msgs = makeStreamingMsgs();
		const result = applyAgentEvent(msgs, { stream: 'assistant', data: { text: 'NO_REPLY' } });

		const entry = msgs.find((m) => m._streaming && m.message.role === 'assistant');
		const textBlocks = Array.isArray(entry.message.content)
			? entry.message.content.filter((b) => b.type === 'text')
			: [];
		expect(textBlocks).toHaveLength(0);
		expect(entry.message.stopReason).toBe('stop');
		expect(result.changed).toBe(true);
	});

	test('assistant stream：过滤带空白的 NO_REPLY', () => {
		const msgs = makeStreamingMsgs();
		applyAgentEvent(msgs, { stream: 'assistant', data: { text: '  NO_REPLY  ' } });

		const entry = msgs.find((m) => m._streaming && m.message.role === 'assistant');
		const textBlocks = Array.isArray(entry.message.content)
			? entry.message.content.filter((b) => b.type === 'text')
			: [];
		expect(textBlocks).toHaveLength(0);
	});

	test('assistant stream：不过滤包含 NO_REPLY 的正常文本', () => {
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

	test('lifecycle end：返回 settled=true', () => {
		const msgs = makeStreamingMsgs();
		const result = applyAgentEvent(msgs, { stream: 'lifecycle', data: { phase: 'end' } });

		expect(result.settled).toBe(true);
		expect(result.error).toBe(false);
		expect(result.changed).toBe(true);
	});

	test('lifecycle error：返回 settled=true, error=true', () => {
		const msgs = makeStreamingMsgs();
		const result = applyAgentEvent(msgs, { stream: 'lifecycle', data: { phase: 'error' } });

		expect(result.settled).toBe(true);
		expect(result.error).toBe(true);
	});

	test('ensureContentArray：非空字符串 content 被转换为 text block 数组', () => {
		const msgs = [
			{
				id: '__local_bot_1',
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
		expect(result.settled).toBe(false);
	});
});
