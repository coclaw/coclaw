import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// 通过 spy addEventListener 捕获注册的事件处理器
function getErrorHandler() {
	const calls = vi.mocked(window.addEventListener).mock.calls;
	const errorCall = calls.find(([type]) => type === 'error');
	return errorCall[1];
}

describe('global-error-handler', () => {
	let mod;
	let consoleErrorSpy;
	beforeEach(async () => {
		vi.resetModules();
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(window, 'addEventListener');
		mod = await import('./global-error-handler.js');
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('setGlobalErrorNotify 设置 notify 函数', () => {
		// 不抛异常即可
		expect(() => mod.setGlobalErrorNotify(vi.fn())).not.toThrow();
	});

	test('installGlobalErrorHandlers 设置 app.config.errorHandler', () => {
		const app = { config: {} };
		mod.installGlobalErrorHandlers(app);
		expect(typeof app.config.errorHandler).toBe('function');
	});

	test('Vue errorHandler 调用 console.error 和 notifyFn', () => {
		const notify = vi.fn();
		mod.setGlobalErrorNotify(notify);
		const app = { config: {} };
		mod.installGlobalErrorHandlers(app);

		const err = new Error('test error');
		app.config.errorHandler(err, null, 'render');

		expect(consoleErrorSpy).toHaveBeenCalledWith('[global-error]', '[Vue render] test error');
		expect(notify).toHaveBeenCalledWith('[Vue render] test error');
	});

	test('Vue errorHandler 处理 err 无 message 的情况', () => {
		const notify = vi.fn();
		mod.setGlobalErrorNotify(notify);
		const app = { config: {} };
		mod.installGlobalErrorHandlers(app);

		// 传入字符串而非 Error 对象
		app.config.errorHandler('raw string error', null, 'setup');

		expect(notify).toHaveBeenCalledWith('[Vue setup] raw string error');
	});

	test('window error 事件触发 showError', () => {
		const notify = vi.fn();
		mod.setGlobalErrorNotify(notify);
		const app = { config: {} };
		mod.installGlobalErrorHandlers(app);

		// jsdom 中 ErrorEvent.message 可能不正确，通过 spy 捕获处理器直接调用
		const handler = getErrorHandler();
		handler({ target: window, message: 'Script error' });

		expect(notify).toHaveBeenCalledWith('Script error');
	});

	test('window error 事件忽略非 window target（资源加载错误）', () => {
		const notify = vi.fn();
		mod.setGlobalErrorNotify(notify);
		const app = { config: {} };
		mod.installGlobalErrorHandlers(app);

		const handler = getErrorHandler();
		// 资源加载错误的 target 是具体元素
		handler({ target: document.createElement('img'), message: 'load error' });

		expect(notify).not.toHaveBeenCalled();
	});

	test('window error 事件 message 为空时使用 Unknown error', () => {
		const notify = vi.fn();
		mod.setGlobalErrorNotify(notify);
		const app = { config: {} };
		mod.installGlobalErrorHandlers(app);

		const handler = getErrorHandler();
		handler({ target: window, message: '' });

		expect(notify).toHaveBeenCalledWith('Unknown error');
	});

	test('unhandledrejection 事件触发 showError', () => {
		const notify = vi.fn();
		mod.setGlobalErrorNotify(notify);
		const app = { config: {} };
		mod.installGlobalErrorHandlers(app);

		const event = new Event('unhandledrejection');
		event.reason = new Error('promise failed');
		window.dispatchEvent(event);

		expect(notify).toHaveBeenCalledWith('promise failed');
	});

	test('unhandledrejection reason 无 message 时使用 toString', () => {
		const notify = vi.fn();
		mod.setGlobalErrorNotify(notify);
		const app = { config: {} };
		mod.installGlobalErrorHandlers(app);

		const event = new Event('unhandledrejection');
		event.reason = { toString: () => 'custom reason' };
		window.dispatchEvent(event);

		expect(notify).toHaveBeenCalledWith('custom reason');
	});

	test('未设置 notifyFn 时只 console.error 不崩溃', () => {
		const app = { config: {} };
		mod.installGlobalErrorHandlers(app);

		// 不设置 notifyFn，直接触发错误
		app.config.errorHandler(new Error('no notify'), null, 'lifecycle');

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			'[global-error]',
			'[Vue lifecycle] no notify',
		);
		// 不应崩溃
	});
});
