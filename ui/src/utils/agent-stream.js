/**
 * Agent 流式事件处理纯函数
 * 将 event:agent 事件应用到消息数组，与 store 解耦
 */

/**
 * 从消息数组末尾查找 streaming bot 条目
 * @param {object[]} msgs
 * @returns {object | null}
 */
function findStreamingBotEntry(msgs) {
	for (let i = msgs.length - 1; i >= 0; i--) {
		const e = msgs[i];
		if (e._streaming && e.message?.role === 'assistant') return e;
	}
	return null;
}

/**
 * 确保 entry.message.content 为数组格式
 * @param {object} entry
 * @returns {object[]}
 */
function ensureContentArray(entry) {
	const c = entry.message.content;
	if (Array.isArray(c)) return c;
	entry.message.content = (c && typeof c === 'string') ? [{ type: 'text', text: c }] : [];
	return entry.message.content;
}

/**
 * 将 agent 流式事件应用到消息数组
 * @param {object[]} msgs - 消息数组（原地修改）
 * @param {object} payload - event:agent payload
 * @returns {{ changed: boolean, settled: boolean, error: boolean }}
 */
export function applyAgentEvent(msgs, payload) {
	const { stream, data } = payload;
	const result = { changed: false, settled: false, error: false };

	if (stream === 'assistant' && data?.text != null) {
		const entry = findStreamingBotEntry(msgs);
		if (entry) {
			const content = ensureContentArray(entry);
			const nonText = content.filter((b) => b.type !== 'text');
			entry.message.content = [...nonText, { type: 'text', text: data.text }];
			entry.message.stopReason = 'stop';
			result.changed = true;
		}
	}
	else if (stream === 'tool') {
		if (data?.phase === 'start') {
			const entry = findStreamingBotEntry(msgs);
			if (entry) {
				const content = ensureContentArray(entry);
				content.push({ type: 'toolCall', name: data.name ?? 'unknown' });
				entry.message.stopReason = 'toolUse';
				result.changed = true;
			}
		}
		else if (data?.phase === 'result') {
			const raw = data.result;
			const text = raw != null
				? (typeof raw === 'string' ? raw : JSON.stringify(raw))
				: '';
			const startTime = findStreamingBotEntry(msgs)?._startTime;
			msgs.push(
				{
					type: 'message',
					id: `__local_tr_${Date.now()}`,
					_local: true,
					_streaming: true,
					message: { role: 'toolResult', content: text },
				},
				{
					type: 'message',
					id: `__local_bot_${Date.now() + 1}`,
					_local: true,
					_streaming: true,
					_startTime: startTime,
					message: { role: 'assistant', content: '', stopReason: null },
				},
			);
			result.changed = true;
		}
	}
	else if (stream === 'thinking' && data?.text != null) {
		const entry = findStreamingBotEntry(msgs);
		if (entry) {
			const content = ensureContentArray(entry);
			const lastIdx = content.length - 1;
			if (lastIdx >= 0 && content[lastIdx].type === 'thinking') {
				content[lastIdx] = { type: 'thinking', thinking: data.text };
			}
			else {
				content.push({ type: 'thinking', thinking: data.text });
			}
			result.changed = true;
		}
	}
	else if (stream === 'lifecycle') {
		if (data?.phase === 'end') {
			result.settled = true;
			result.changed = true;
		}
		else if (data?.phase === 'error') {
			result.settled = true;
			result.error = true;
			result.changed = true;
		}
	}

	return result;
}
