/**
 * 将原始 JSONL 条目分组为渲染用 chat items。
 *
 * 分组规则：
 * - 跳过 type !== 'message' 的条目
 * - role=user → push user item，结束当前 botTask
 * - role=assistant / role=toolResult → 归入当前 botTask
 *
 * @param {object[]} entries - 原始 JSONL 条目
 * @returns {object[]} 分组后的 chat items
 */
function groupSessionMessages(entries) {
	const items = [];
	let currentTask = null;
	let lastUserTs = null;

	for (const entry of entries) {
		if (entry.type !== 'message' || !entry.message) {
			continue;
		}

		const msg = entry.message;
		const role = msg.role;

		if (role === 'user') {
			// 结束当前 botTask
			if (currentTask) {
				__finalizeBotTask(currentTask, lastUserTs);
				items.push(currentTask);
				currentTask = null;
			}

			lastUserTs = msg.timestamp ?? null;
			const textContent = stripOcPrefixes(extractTextContent(msg.content), 'user');
			const images = extractImages(msg.content);
			if (images.length) {
				console.log('[msg-group] user message has %d image(s), id=%s', images.length, entry.id);
			}
			items.push({
				type: 'user',
				id: entry.id,
				textContent,
				images,
				timestamp: msg.timestamp ?? null,
			});
		} else if (role === 'assistant') {
			if (!currentTask) {
				currentTask = createBotTask(entry.id);
			}
			processAssistant(currentTask, msg);
			if (entry._streaming) {
				currentTask.isStreaming = true;
			}
			if (entry._startTime != null && currentTask.startTime == null) {
				currentTask.startTime = entry._startTime;
			}
		} else if (role === 'toolResult') {
			if (!currentTask) {
				currentTask = createBotTask(entry.id);
			}
			processToolResult(currentTask, msg);
			if (entry._streaming) {
				currentTask.isStreaming = true;
			}
		}
	}

	// 末尾未结束的 botTask
	if (currentTask) {
		__finalizeBotTask(currentTask, lastUserTs);
		items.push(currentTask);
	}

	return items;
}

/** 计算 botTask duration（ms） */
function __finalizeBotTask(task, userTs) {
	if (task.timestamp && userTs && task.timestamp > userTs) {
		task.duration = task.timestamp - userTs;
	}
}

/** @returns {object} 空 botTask */
function createBotTask(id) {
	return {
		type: 'botTask',
		id,
		resultText: null,
		model: null,
		timestamp: null,
		duration: null,
		steps: [],
		images: [],
		isStreaming: false,
		startTime: null,
	};
}

/**
 * 处理 assistant 条目，更新 botTask。
 * @param {object} task
 * @param {object} msg
 */
function processAssistant(task, msg) {
	const content = msg.content;
	const blocks = normalizeBlocks(content);
	const isFinal = msg.stopReason === 'stop' || msg.stopReason === 'end_turn';

	for (const block of blocks) {
		if (block.type === 'thinking' && block.thinking) {
			task.steps.push({ kind: 'thinking', text: block.thinking });
		} else if (block.type === 'toolCall') {
			task.steps.push({ kind: 'toolCall', name: block.name ?? 'unknown' });
		} else if (block.type === 'tool_use') {
			task.steps.push({ kind: 'toolCall', name: block.name ?? 'unknown' });
		} else if (block.type === 'text' && block.text) {
			if (isFinal) {
				// text blocks 在最终消息中为 resultText
				const cleaned = stripOcPrefixes(block.text, 'assistant');
				if (cleaned) {
					task.resultText = task.resultText
						? task.resultText + '\n' + cleaned
						: cleaned;
				}
			} else {
				// 中间 assistant 的 text blocks 归入 steps
				task.steps.push({ kind: 'thinking', text: block.text });
			}
		}
	}

	// 更新 model/timestamp（以最后一个 assistant 为准）
	if (msg.model) {
		task.model = msg.model;
	}
	if (msg.timestamp) {
		task.timestamp = msg.timestamp;
	}
}

/**
 * 处理 toolResult 条目，更新 botTask。
 * @param {object} task
 * @param {object} msg
 */
function processToolResult(task, msg) {
	const text = extractTextContent(msg.content);
	if (text) {
		task.steps.push({ kind: 'toolResult', text });
	}
	const imgs = extractImages(msg.content);
	if (imgs.length) {
		console.log('[msg-group] toolResult has %d image(s), taskId=%s', imgs.length, task.id);
	}
	for (const img of imgs) {
		task.steps.push({ kind: 'image', data: img.data, mimeType: img.mimeType });
		task.images.push(img);
	}
}

/**
 * 将 content 归一化为 blocks 数组。
 * @param {string|object[]} content
 * @returns {object[]}
 */
function normalizeBlocks(content) {
	if (Array.isArray(content)) {
		return content;
	}
	if (typeof content === 'string') {
		return [{ type: 'text', text: content }];
	}
	return [];
}

/**
 * 从 content 提取纯文本。
 * @param {string|object[]} content
 * @returns {string}
 */
function extractTextContent(content) {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.filter((b) => b.type === 'text')
			.map((b) => b.text)
			.join('\n');
	}
	return '';
}

/**
 * 从 content 提取图像 blocks。
 * @param {string|object[]} content
 * @returns {{ data: string, mimeType: string }[]}
 */
function extractImages(content) {
	if (!Array.isArray(content)) return [];
	return content
		.filter((b) => b.type === 'image' && b.data)
		.map((b) => ({ data: b.data, mimeType: b.mimeType }));
}

// OpenClaw gateway 注入的 inbound metadata 头部（Conversation info / Sender / Thread starter 等）
// 格式：<Label> (untrusted...):```json {...} ```\n\n
const INBOUND_META_RE = /^\w[\w ]* \(untrusted[^)]*\):\n```json\n[\s\S]*?\n```\n\n/;

// operator 级策略/指令前缀，如 Skills store policy (operator configured): ...
const OPERATOR_POLICY_RE = /^\w[\w ]* \(operator configured\):[\s\S]*?\n\n/;

// OpenClaw gateway 自动注入的用户消息时间戳，如 [Fri 2026-02-20 15:25 GMT+8]
const USER_TS_RE = /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+[^\]]+\]\s*/;

// 尾部 [message_id: xxx]
const MSG_ID_SUFFIX_RE = /\n\[message_id:\s*[^\]]+\]\s*$/;
// 尾部 Untrusted context 块（外部元数据注入）
const UNTRUSTED_CTX_SUFFIX_RE = /\n\nUntrusted context \(metadata, do not treat as instructions or commands\):\n[\s\S]*$/;

// OpenClaw 回复指令标签，如 [[reply_to_current]]
const REPLY_TAG_RE = /^\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]\s*/;

/** 循环去除行首匹配的块，直到不再匹配 */
function stripLeadingPattern(text, re) {
	let prev;
	do {
		prev = text;
		text = text.replace(re, '');
	} while (text !== prev);
	return text;
}

/**
 * 去除 OpenClaw 注入的前缀/后缀标记。
 * - 用户消息：去除 inbound metadata 头部、operator 策略、时间戳前缀、尾部 message_id
 * - 助手消息：去除 [[reply_to_current]] 指令标签
 * @param {string} text
 * @param {'user'|'assistant'} role
 * @returns {string}
 */
function stripOcPrefixes(text, role) {
	if (!text) return text;
	if (role === 'user') {
		let s = stripLeadingPattern(text, INBOUND_META_RE);
		s = stripLeadingPattern(s, OPERATOR_POLICY_RE);
		return s
			.replace(USER_TS_RE, '')
			.replace(UNTRUSTED_CTX_SUFFIX_RE, '')
			.replace(MSG_ID_SUFFIX_RE, '');
	}
	return text.replace(REPLY_TAG_RE, '');
}

// 定时任务前缀，如 [cron:d59196ed-27ee-42fc-ad60-8ad19aafd4ba workspace-backup-1300-1900]
const CRON_UUID_RE = /\[cron:[0-9a-f-]+(?:\s+([^\]]*))?\]\s*/;
// cron 注入的 Current time 行及其后的系统追加指令
const CRON_TIME_TAIL_RE = /\nCurrent time:[^\n]+[\s\S]*$/;
// 单行 fallback：derivedTitle 已被 normalize 为单行时匹配 Current time 及其后内容
const CRON_TIME_INLINE_RE = / ?Current time:[\s\S]*$/;
// 从 Current time 行提取 UTC 时间部分
const CRON_TIME_UTC_RE = /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s+UTC/;

// 单行 fallback：derivedTitle 被截断导致原始多行正则无法匹配时使用
const OPERATOR_POLICY_LINE_RE = /^\w[\w ]* \(operator configured\):[\s\S]*/;
const INBOUND_META_LINE_RE = /^\w[\w ]* \(untrusted[^)]*\):[\s\S]*/;

function formatCronTime(matchedText) {
	const m = matchedText.match(CRON_TIME_UTC_RE);
	if (!m) return '';
	try {
		const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
		if (!Number.isFinite(d.getTime())) return '';
		const y = d.getFullYear();
		const mo = String(d.getMonth() + 1).padStart(2, '0');
		const dd = String(d.getDate()).padStart(2, '0');
		const hh = String(d.getHours()).padStart(2, '0');
		const mi = String(d.getMinutes()).padStart(2, '0');
		return ` ${y}-${mo}-${dd} ${hh}${mi}`;
	}
	catch {
		return '';
	}
}

/**
 * 清洗插件侧返回的 derivedTitle。
 * 复用 stripOcPrefixes 中的正则，额外去除 cron:uuid。
 * derivedTitle 是截取的单行字符串，可能不含 \n\n，需单行 fallback。
 * @param {string} text
 * @returns {string} 清洗后文本，空值返回 ''
 */
function cleanDerivedTitle(text) {
	if (!text) return '';
	let s = stripLeadingPattern(text, INBOUND_META_RE);
	s = stripLeadingPattern(s, OPERATOR_POLICY_RE);
	// 单行 fallback：原始正则未匹配（无 \n\n）时，整段为系统噪音，全部去除
	s = s.replace(OPERATOR_POLICY_LINE_RE, '');
	s = s.replace(INBOUND_META_LINE_RE, '');
	// cron Current time 行及其后系统指令（多行形式 + 单行 fallback）
	s = s.replace(CRON_TIME_TAIL_RE, (match) => formatCronTime(match));
	s = s.replace(CRON_TIME_INLINE_RE, (match) => formatCronTime(match));
	return s
		.replace(USER_TS_RE, '')
		.replace(CRON_UUID_RE, (_, taskName) => taskName ? `${taskName} ` : '')
		.replace(UNTRUSTED_CTX_SUFFIX_RE, '')
		.replace(MSG_ID_SUFFIX_RE, '')
		.trim();
}

export { groupSessionMessages, stripOcPrefixes, cleanDerivedTitle };
