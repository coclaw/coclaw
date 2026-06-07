import { describe, test, expect, vi } from 'vitest';

const mockContextMenu = vi.hoisted(() => vi.fn(() => () => {}));
// t 返回带 'T:' 前缀的标记值，便于断言 labels 确实经过 t()（而非硬编码英文恰好对齐）
const mockT = vi.hoisted(() => vi.fn((zh, en) => `T:${en}`));
vi.mock('electron-context-menu', () => ({ default: mockContextMenu }));
vi.mock('./locale.js', () => ({ t: mockT }));

const { setupContextMenu } = await import('./context-menu.js');

describe('setupContextMenu', () => {
	test('给目标窗口注册 electron-context-menu', () => {
		mockContextMenu.mockClear();
		const fakeWin = { id: 1 };
		setupContextMenu(fakeWin);
		expect(mockContextMenu).toHaveBeenCalledTimes(1);
		expect(mockContextMenu.mock.calls[0][0].window).toBe(fakeWin);
	});

	test('强制开启检查元素，关闭全选与 Google 搜索', () => {
		mockContextMenu.mockClear();
		setupContextMenu({});
		const opts = mockContextMenu.mock.calls[0][0];
		expect(opts.showInspectElement).toBe(true);
		expect(opts.showSelectAll).toBe(false);
		expect(opts.showSearchWithGoogle).toBe(false);
	});

	test('菜单文案全部走壳子 i18n（labels 经过 t()，非硬编码）', () => {
		mockContextMenu.mockClear();
		mockT.mockClear();
		setupContextMenu({});
		const { labels } = mockContextMenu.mock.calls[0][0];
		// 每一项 label 都必须带 'T:' 标记，才能证明确实经过 t()——
		// 若实现被改成硬编码字面量、绕过 t()，此断言会挂
		for (const v of Object.values(labels)) {
			expect(v).toMatch(/^T:/);
		}
		// 且确实以 (zh, en) 形式调用过 t()（含本次补的链接/检查元素项）
		expect(mockT).toHaveBeenCalledWith('复制', 'Copy');
		expect(mockT).toHaveBeenCalledWith('复制链接', 'Copy Link');
		expect(mockT).toHaveBeenCalledWith('检查元素', 'Inspect Element');
	});

	test('返回 electron-context-menu 的注销函数', () => {
		const dispose = vi.fn();
		mockContextMenu.mockReturnValueOnce(dispose);
		expect(setupContextMenu({})).toBe(dispose);
	});
});
