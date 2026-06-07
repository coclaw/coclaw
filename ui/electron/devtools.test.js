import { describe, test, expect, vi, beforeEach } from 'vitest';
import { setupDevtoolsShortcut } from './devtools.js';

describe('setupDevtoolsShortcut', () => {
	let fakeWin;
	let handler;      // 主窗口 before-input-event 处理器
	let dtHandler;    // DevTools webContents 的 before-input-event 处理器
	let triggerOpen;  // 触发 devtools-opened

	beforeEach(() => {
		handler = null;
		dtHandler = null;
		triggerOpen = null;
		const devToolsWebContents = {
			on: vi.fn((event, fn) => {
				if (event === 'before-input-event') dtHandler = fn;
			}),
		};
		fakeWin = {
			webContents: {
				on: vi.fn((event, fn) => {
					if (event === 'before-input-event') handler = fn;
					if (event === 'devtools-opened') triggerOpen = fn;
				}),
				toggleDevTools: vi.fn(),
				devToolsWebContents,
			},
		};
		setupDevtoolsShortcut(fakeWin);
	});

	test('绑定窗口级 before-input-event', () => {
		expect(fakeWin.webContents.on).toHaveBeenCalledWith('before-input-event', expect.any(Function));
	});

	test('F12 keyDown → 切换 DevTools 并阻止默认', () => {
		const e = { preventDefault: vi.fn() };
		handler(e, { type: 'keyDown', key: 'F12' });
		expect(fakeWin.webContents.toggleDevTools).toHaveBeenCalledTimes(1);
		expect(e.preventDefault).toHaveBeenCalledTimes(1);
	});

	test('Ctrl+Shift+I keyDown → 切换 DevTools（大小写 I 均识别）', () => {
		for (const key of ['I', 'i']) {
			fakeWin.webContents.toggleDevTools.mockClear();
			const e = { preventDefault: vi.fn() };
			handler(e, { type: 'keyDown', key, control: true, shift: true });
			expect(fakeWin.webContents.toggleDevTools).toHaveBeenCalledTimes(1);
			expect(e.preventDefault).toHaveBeenCalledTimes(1);
		}
	});

	test('缺 ctrl 或缺 shift 的 I 不触发', () => {
		const e = { preventDefault: vi.fn() };
		handler(e, { type: 'keyDown', key: 'I', control: true, shift: false });
		handler(e, { type: 'keyDown', key: 'I', control: false, shift: true });
		expect(fakeWin.webContents.toggleDevTools).not.toHaveBeenCalled();
		expect(e.preventDefault).not.toHaveBeenCalled();
	});

	test('Ctrl+Shift+ 非 I 键不触发（防"任意 Ctrl+Shift 组合"误实现）', () => {
		const e = { preventDefault: vi.fn() };
		handler(e, { type: 'keyDown', key: 'A', control: true, shift: true });
		expect(fakeWin.webContents.toggleDevTools).not.toHaveBeenCalled();
		expect(e.preventDefault).not.toHaveBeenCalled();
	});

	test('带额外修饰键的 F12 / Ctrl+Shift+I 不触发（严格匹配）', () => {
		const e = { preventDefault: vi.fn() };
		handler(e, { type: 'keyDown', key: 'F12', control: true });
		handler(e, { type: 'keyDown', key: 'F12', shift: true });
		handler(e, { type: 'keyDown', key: 'F12', alt: true });
		handler(e, { type: 'keyDown', key: 'I', control: true, shift: true, alt: true });
		handler(e, { type: 'keyDown', key: 'I', control: true, shift: true, meta: true });
		expect(fakeWin.webContents.toggleDevTools).not.toHaveBeenCalled();
		expect(e.preventDefault).not.toHaveBeenCalled();
	});

	test('其它按键不触发', () => {
		const e = { preventDefault: vi.fn() };
		handler(e, { type: 'keyDown', key: 'A' });
		expect(fakeWin.webContents.toggleDevTools).not.toHaveBeenCalled();
		expect(e.preventDefault).not.toHaveBeenCalled();
	});

	test('keyUp 不触发（仅认 keyDown，避免一次按键切两下）', () => {
		const e = { preventDefault: vi.fn() };
		handler(e, { type: 'keyUp', key: 'F12' });
		handler(e, { type: 'keyUp', key: 'I', control: true, shift: true });
		expect(fakeWin.webContents.toggleDevTools).not.toHaveBeenCalled();
	});

	test('DevTools 打开后，在其 webContents 上按 F12 也能切换（即关闭 DevTools）', () => {
		// 触发 devtools-opened：应把同一处理器挂到 DevTools 的 webContents
		triggerOpen();
		expect(fakeWin.webContents.devToolsWebContents.on)
			.toHaveBeenCalledWith('before-input-event', expect.any(Function));
		// 在 DevTools 的 webContents 上按 F12 → 调用主窗口 toggleDevTools（关闭）
		const e = { preventDefault: vi.fn() };
		dtHandler(e, { type: 'keyDown', key: 'F12' });
		expect(fakeWin.webContents.toggleDevTools).toHaveBeenCalledTimes(1);
		expect(e.preventDefault).toHaveBeenCalledTimes(1);
	});

	test('win 为空时静默返回，不抛', () => {
		expect(() => setupDevtoolsShortcut(null)).not.toThrow();
		expect(() => setupDevtoolsShortcut(undefined)).not.toThrow();
	});
});
