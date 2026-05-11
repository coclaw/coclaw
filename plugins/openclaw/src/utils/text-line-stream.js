export const DEFAULT_YIELD_EVERY = 100;

/**
 * 流式扫描大字符串的行，分批让出 event loop。
 *
 * 不预先 split——按 \n 游标推进，避免大字符串一次性 split 卡主线程。
 *
 * 行终止与 split(/\r?\n/) 的语义差异：
 * - 把 \n 视为"行终止符"而非"分隔符"。末尾 \n 之后**不产生**额外空段，即
 *   `'foo\n'` 仅产 `['foo']`（split 会得 `['foo','']`）。`skipEmpty: false`
 *   下亦如此——空段是"两个分隔符之间没字符"，末尾 \n 之后没有内容也没有下
 *   一个分隔符，所以本来就不应该产空段。
 * - 仅剥紧贴 \n 之前的 \r（CRLF 折行）。**孤立的 \r**（行内或末尾段无 \n）
 *   按字面保留，与 split(/\r?\n/) 一致。
 *
 * 空行（连续 \n\n 之间的空段）按 skipEmpty 选项过滤，默认跳过。
 *
 * 让出策略：每处理 yieldEvery 行 await 一次 setImmediate，让 I/O 回调（如 RTC
 * 数据通道帧、其它 RPC handler）有机会插入。Node 中首选 setImmediate 而非
 * setTimeout(0)：后者最小延迟被钳制到 1ms，让出净开销显著更大。
 *
 * @param {string} text - 待扫描文本
 * @param {{ yieldEvery?: number, skipEmpty?: boolean }} [opts]
 * @returns {AsyncGenerator<string>}
 */
export async function* iterTextLines(text, opts = {}) {
	if (typeof text !== 'string' || text.length === 0) return;
	const yieldEvery = Number.isFinite(opts.yieldEvery) && opts.yieldEvery > 0
		? Math.trunc(opts.yieldEvery)
		: DEFAULT_YIELD_EVERY;
	const skipEmpty = opts.skipEmpty !== false;

	const len = text.length;
	let start = 0;
	let count = 0;

	while (start < len) {
		const lfIdx = text.indexOf('\n', start);
		const terminatedByLf = lfIdx !== -1;
		const end = terminatedByLf ? lfIdx : len;

		// 仅当本段确实由 LF 终止时才剥末尾 \r（CRLF）。
		// 末尾段（无 LF）保留原文，与 split(/\r?\n/) 行为一致——
		// 否则 'a\r' 会被剥成 'a' 静默丢失，违反"行为等价"约定。
		let lineEnd = end;
		if (terminatedByLf && lineEnd > start && text.charCodeAt(lineEnd - 1) === 13) {
			lineEnd--;
		}

		if (!skipEmpty || lineEnd > start) {
			yield text.slice(start, lineEnd);
		}

		start = end + 1;

		if (++count % yieldEvery === 0) {
			await new Promise((resolve) => setImmediate(resolve));
		}
	}
}
