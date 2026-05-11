export const DEFAULT_YIELD_EVERY = 100;

/**
 * 流式扫描大字符串的行，分批让出 event loop。
 *
 * 不预先 split——按 \n 游标推进，避免大字符串一次性 split 卡主线程。
 * 兼容 LF / CRLF。空行（含末尾换行后的空段）按 skipEmpty 选项过滤，默认跳过。
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
		let end = text.indexOf('\n', start);
		if (end === -1) end = len;

		// strip trailing \r for CRLF
		let lineEnd = end;
		if (lineEnd > start && text.charCodeAt(lineEnd - 1) === 13) lineEnd--;

		if (!skipEmpty || lineEnd > start) {
			yield text.slice(start, lineEnd);
		}

		start = end + 1;

		if (++count % yieldEvery === 0) {
			await new Promise((resolve) => setImmediate(resolve));
		}
	}
}
