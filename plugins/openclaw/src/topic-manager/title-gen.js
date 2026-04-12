import { randomUUID } from 'node:crypto';

const TITLE_SYSTEM_PROMPT = [
	'You are a title generator. Your ONLY job is to output a short title.',
	'',
	'STRICT RULES:',
	'- Output ONLY the title itself. Nothing else.',
	'- Do NOT add any prefix like "Title:", "标题:", "Here is the title:", "好的" etc.',
	'- Do NOT add quotes around the title.',
	'- Do NOT add any explanation, greeting, or preamble.',
	'- Do NOT call any tools or functions.',
	'- Keep it concise: max 15 words.',
	'- Use the same language as the conversation.',
	'',
	'GOOD examples of valid output:',
	'  量子计算基础概念',
	'  How to deploy a Node.js app',
	'',
	'BAD examples (DO NOT do this):',
	'  好的，标题是：量子计算基础概念',
	'  "量子计算基础概念"',
	'  Title: How to deploy a Node.js app',
].join('\n');

const TITLE_MAX_LEN = 128;

// 清洗 LLM 返回的标题文本
const QUOTE_PAIRS = [
	['"', '"'],
	["'", "'"],
	['\u300C', '\u300D'], // 「」
	['\u201C', '\u201D'], // ""
	['\u2018', '\u2019'], // ''
];

// 弱模型常见的前缀模式（贪婪匹配到冒号/换行后的实际标题）
const PREFIX_PATTERNS = [
	// 中文前缀：好的，标题是：xxx / 以下是标题：xxx / 标题：xxx
	/^(?:好的[，,]?\s*)?(?:以下是|这是|生成的)?(?:对话)?标题(?:是|为)?[：:]\s*/,
	// 英文前缀：Title: xxx / Here is the title: xxx / Sure, the title is: xxx
	/^(?:sure[,.]?\s*)?(?:here\s+is\s+)?(?:the\s+)?title(?:\s+is)?[:\s]+/i,
	// 通用客气开头：好的，让我... / 好的，xxx
	/^好的[，,]\s*(?:让我[^：:]*[：:]|我[^：:]*[：:])\s*/,
];

function cleanTitle(raw) {
	if (!raw || typeof raw !== 'string') return '';
	let s = raw.trim();
	// 多行响应时只取第一行（LLM 可能附加解释）
	const firstLine = s.split(/\r?\n/)[0].trim();
	if (firstLine) s = firstLine;
	// 去除常见前缀
	for (const re of PREFIX_PATTERNS) {
		s = s.replace(re, '');
	}
	s = s.trim();
	// 去除首尾成对引号
	for (const [open, close] of QUOTE_PAIRS) {
		if (s.startsWith(open) && s.endsWith(close) && s.length >= 2) {
			s = s.slice(open.length, -close.length).trim();
		}
	}
	// 截断
	if (s.length > TITLE_MAX_LEN) {
		s = s.slice(0, TITLE_MAX_LEN);
	}
	return s;
}

/**
 * 从 agent 两阶段响应中提取 assistant 文本
 * @param {object} response - gateway 响应
 * @returns {string | null}
 */
function extractAssistantText(response) {
	const payloads = response?.payload?.result?.payloads;
	if (!Array.isArray(payloads)) return null;
	for (const p of payloads) {
		if (typeof p?.text === 'string' && p.text.trim()) {
			return p.text.trim();
		}
	}
	return null;
}

/**
 * 为 Topic 生成 AI 标题
 *
 * @param {object} opts
 * @param {string} opts.topicId
 * @param {object} opts.topicManager - TopicManager 实例
 * @param {Function} opts.agentRpc - gatewayAgentRpc 函数
 * @param {object} [opts.logger]
 * @returns {Promise<{ title: string }>}
 */
export async function generateTitle({ topicId, topicManager, agentRpc, logger }) {
	const log = logger ?? console;

	// 验证 topic 存在
	const { topic } = topicManager.get({ topicId });
	if (!topic) {
		throw new Error(`Topic not found: ${topicId}`);
	}
	const { agentId } = topic;

	// 复制 .jsonl → 临时文件
	const { tempId, tempPath } = await topicManager.copyTranscript({ agentId, topicId });

	try {
		// 通过 gateway WS 发起 agent 两阶段请求
		const result = await agentRpc('agent', {
			sessionId: tempId,
			extraSystemPrompt: TITLE_SYSTEM_PROMPT,
			message: '请为这段对话生成标题',
			idempotencyKey: randomUUID(),
		}, {
			timeoutMs: 60_000,
			acceptTimeoutMs: 10_000,
		});

		if (!result.ok) {
			throw new Error(`Agent RPC failed: ${result.error ?? 'unknown'}`);
		}

		const rawTitle = extractAssistantText(result.response);
		if (!rawTitle) {
			throw new Error('No assistant text in agent response');
		}

		const title = cleanTitle(rawTitle);
		if (!title) {
			throw new Error('Title is empty after cleaning');
		}

		// 更新 topic title
		await topicManager.updateTitle({ topicId, title });
		return { title };
	} catch (err) {
		/* c8 ignore next -- ?./?? fallback */
		log.warn?.(`[coclaw] generateTitle failed for topic ${topicId}: ${String(err?.message ?? err)}`);
		throw err;
	} finally {
		// 清理临时文件
		/* c8 ignore next -- .catch() 防御 */
		await topicManager.cleanupTempFile(tempPath).catch(() => {});
	}
}

export { cleanTitle, extractAssistantText, TITLE_SYSTEM_PROMPT };
