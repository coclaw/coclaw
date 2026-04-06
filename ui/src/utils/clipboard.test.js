import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const platformMock = vi.hoisted(() => ({
	isCapacitorApp: false,
	isElectronApp: false,
	isTauriApp: false,
}));

vi.mock('./platform.js', () => platformMock);

const capacitorWriteMock = vi.fn();
vi.mock('@capacitor/clipboard', () => ({ Clipboard: { write: capacitorWriteMock } }));

describe('writeClipboardText', () => {
	let writeClipboardText;
	let tauriWriteTextMock;

	beforeEach(async () => {
		platformMock.isCapacitorApp = false;
		platformMock.isElectronApp = false;
		platformMock.isTauriApp = false;
		capacitorWriteMock.mockReset();
		// jsdom 中无 navigator.clipboard，手动填充
		if (!navigator.clipboard) {
			Object.defineProperty(navigator, 'clipboard', {
				value: { writeText: vi.fn() },
				writable: true,
				configurable: true,
			});
		}

		const mod = await import('./clipboard.js');
		writeClipboardText = mod.writeClipboardText;
	});

	afterEach(() => {
		delete window.__TAURI__;
		delete window.electronAPI;
	});

	test('web 环境使用 navigator.clipboard.writeText', async () => {
		navigator.clipboard.writeText = vi.fn().mockResolvedValue();
		await writeClipboardText('hello');
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello');
	});

	test('Capacitor 环境使用 @capacitor/clipboard', async () => {
		platformMock.isCapacitorApp = true;
		capacitorWriteMock.mockResolvedValue();
		await writeClipboardText('hello');
		expect(capacitorWriteMock).toHaveBeenCalledWith({ string: 'hello' });
	});

	test('Electron 环境使用 electronAPI', async () => {
		platformMock.isElectronApp = true;
		const mockFn = vi.fn().mockResolvedValue();
		window.electronAPI = { clipboardWriteText: mockFn };
		await writeClipboardText('hello');
		expect(mockFn).toHaveBeenCalledWith('hello');
	});

	test('Tauri 环境使用 __TAURI__.clipboardManager', async () => {
		platformMock.isTauriApp = true;
		tauriWriteTextMock = vi.fn().mockResolvedValue();
		window.__TAURI__ = { clipboardManager: { writeText: tauriWriteTextMock } };
		await writeClipboardText('hello');
		expect(tauriWriteTextMock).toHaveBeenCalledWith('hello');
	});

	test('写入失败时抛出异常', async () => {
		navigator.clipboard.writeText = vi.fn().mockRejectedValue(new Error('denied'));
		await expect(writeClipboardText('x')).rejects.toThrow('denied');
	});
});
