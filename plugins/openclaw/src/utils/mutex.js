/**
 * 进程内异步互斥锁。
 * 用于保护 read-modify-write 等需要串行化的异步操作序列。
 *
 * 参照 OpenClaw createAsyncLock() 实现，基于 Promise 链的 FIFO 队列。
 */

/**
 * 创建一把互斥锁，返回 `{ withLock }` 对象。
 *
 * 用法：
 * ```js
 * const mutex = createMutex();
 * const result = await mutex.withLock(async () => {
 *   const data = await readFile(path);
 *   data.count += 1;
 *   await writeFile(path, data);
 *   return data;
 * });
 * ```
 *
 * @returns {{ withLock: <T>(fn: () => Promise<T>) => Promise<T> }}
 */
function createMutex() {
	let lock = Promise.resolve();

	/**
	 * 排队执行 fn，同一时刻只有一个 fn 在运行。
	 * fn 的返回值原样返回，fn 的异常原样抛出。
	 * @param {() => Promise<*>} fn
	 * @returns {Promise<*>}
	 */
	async function withLock(fn) {
		const prev = lock;
		let release;
		lock = new Promise((resolve) => {
			release = resolve;
		});
		await prev;
		try {
			return await fn();
		} finally {
			release?.();
		}
	}

	return { withLock };
}

export { createMutex };
