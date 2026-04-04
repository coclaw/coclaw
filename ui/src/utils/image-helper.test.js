import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { compressImage } from './image-helper.js';

// 构造 mock ImageBitmap
function makeBitmap(w, h) {
	return { width: w, height: h, close: vi.fn() };
}

// 构造 mock canvas context
function makeCtx() {
	return { drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '' };
}

describe('compressImage', () => {
	const origCreateImageBitmap = globalThis.createImageBitmap;
	const origOffscreenCanvas = globalThis.OffscreenCanvas;
	const origCreateElement = document.createElement.bind(document);

	let mockBitmap;
	let mockCtx;
	let mockCanvas;
	let mockToBlob;

	beforeEach(() => {
		mockBitmap = makeBitmap(1000, 500); // 宽幅图
		globalThis.createImageBitmap = vi.fn().mockResolvedValue(mockBitmap);

		// 默认无 OffscreenCanvas（测试 fallback 路径）
		delete globalThis.OffscreenCanvas;

		// mock document.createElement('canvas')
		mockCtx = makeCtx();
		mockToBlob = vi.fn((cb, type, _quality) => {
			cb(new Blob(['thumb'], { type: type || 'image/jpeg' }));
		});
		mockCanvas = {
			width: 0,
			height: 0,
			getContext: vi.fn(() => mockCtx),
			toBlob: mockToBlob,
		};
		vi.spyOn(document, 'createElement').mockImplementation((tag) => {
			if (tag === 'canvas') return mockCanvas;
			return origCreateElement(tag);
		});
	});

	afterEach(() => {
		globalThis.createImageBitmap = origCreateImageBitmap;
		if (origOffscreenCanvas) {
			globalThis.OffscreenCanvas = origOffscreenCanvas;
		} else {
			delete globalThis.OffscreenCanvas;
		}
		vi.restoreAllMocks();
	});

	test('宽幅图按 maxWidth 等比缩放', async () => {
		// 1000x500, maxWidth=256, maxHeight=256 → scale=0.256 → 256x128
		const blob = new Blob(['img'], { type: 'image/jpeg' });
		const result = await compressImage(blob);

		expect(result.width).toBe(256);
		expect(result.height).toBe(128);
		expect(result.skipped).toBe(false);
		expect(result.blob).toBeInstanceOf(Blob);
		expect(mockBitmap.close).toHaveBeenCalled();
	});

	test('窄幅图按 maxHeight 等比缩放', async () => {
		// 500x1000, maxWidth=256, maxHeight=256 → scale=0.256 → 128x256
		mockBitmap = makeBitmap(500, 1000);
		globalThis.createImageBitmap = vi.fn().mockResolvedValue(mockBitmap);

		const blob = new Blob(['img'], { type: 'image/jpeg' });
		const result = await compressImage(blob);

		expect(result.width).toBe(128);
		expect(result.height).toBe(256);
	});

	test('原图小于目标尺寸时直接返回原 Blob', async () => {
		mockBitmap = makeBitmap(100, 80);
		globalThis.createImageBitmap = vi.fn().mockResolvedValue(mockBitmap);

		const blob = new Blob(['small'], { type: 'image/png' });
		const result = await compressImage(blob);

		expect(result.blob).toBe(blob);
		expect(result.width).toBe(100);
		expect(result.height).toBe(80);
		expect(result.skipped).toBe(false);
		expect(mockBitmap.close).toHaveBeenCalled();
	});

	test('自定义 maxWidth/maxHeight（非正方形 box）', async () => {
		// 1000x500, maxWidth=300, maxHeight=100 → scale=min(1, 0.3, 0.2)=0.2 → 200x100
		mockBitmap = makeBitmap(1000, 500);
		globalThis.createImageBitmap = vi.fn().mockResolvedValue(mockBitmap);

		const blob = new Blob(['img'], { type: 'image/jpeg' });
		const result = await compressImage(blob, { maxWidth: 300, maxHeight: 100 });

		expect(result.width).toBe(200);
		expect(result.height).toBe(100);
	});

	test('正方形图等比缩放', async () => {
		// 800x800, maxWidth=256, maxHeight=256 → scale=0.32 → 256x256
		mockBitmap = makeBitmap(800, 800);
		globalThis.createImageBitmap = vi.fn().mockResolvedValue(mockBitmap);

		const blob = new Blob(['img'], { type: 'image/jpeg' });
		const result = await compressImage(blob);

		expect(result.width).toBe(256);
		expect(result.height).toBe(256);
	});

	test('���端宽扁图高度 clamp 到 1px', async () => {
		// 10000x1, scale=0.0256 → tw=256, th=max(1, round(0.0256))=1
		mockBitmap = makeBitmap(10000, 1);
		globalThis.createImageBitmap = vi.fn().mockResolvedValue(mockBitmap);

		const blob = new Blob(['img'], { type: 'image/jpeg' });
		const result = await compressImage(blob);

		expect(result.width).toBe(256);
		expect(result.height).toBe(1);
	});

	test('极端窄高图宽度 clamp 到 1px', async () => {
		// 1x10000, scale=0.0256 → tw=max(1, round(0.0256))=1, th=256
		mockBitmap = makeBitmap(1, 10000);
		globalThis.createImageBitmap = vi.fn().mockResolvedValue(mockBitmap);

		const blob = new Blob(['img'], { type: 'image/jpeg' });
		const result = await compressImage(blob);

		expect(result.width).toBe(1);
		expect(result.height).toBe(256);
	});

	// --- 精确边界：scale = 1 ---

	test('恰好等于目标尺寸时直接返回原 Blob', async () => {
		// 256x256 在 256x256 box 内，scale=1
		mockBitmap = makeBitmap(256, 256);
		globalThis.createImageBitmap = vi.fn().mockResolvedValue(mockBitmap);

		const blob = new Blob(['img'], { type: 'image/jpeg' });
		const result = await compressImage(blob);

		expect(result.blob).toBe(blob);
		expect(result.width).toBe(256);
		expect(result.height).toBe(256);
		expect(mockBitmap.close).toHaveBeenCalled();
	});

	test('单维匹配另一维更小时直接返回原 Blob', async () => {
		// 256x100 在 256x256 box 内，scale=min(1, 1, 2.56)=1
		mockBitmap = makeBitmap(256, 100);
		globalThis.createImageBitmap = vi.fn().mockResolvedValue(mockBitmap);

		const blob = new Blob(['img'], { type: 'image/jpeg' });
		const result = await compressImage(blob);

		expect(result.blob).toBe(blob);
		expect(result.width).toBe(256);
		expect(result.height).toBe(100);
	});

	// --- 跳过压缩的类型 ---

	test('GIF 跳过压缩', async () => {
		const blob = new Blob(['gif'], { type: 'image/gif' });
		const result = await compressImage(blob);

		expect(result.blob).toBe(blob);
		expect(result.skipped).toBe(true);
		expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
	});

	test('SVG 跳过压缩', async () => {
		const blob = new Blob(['<svg></svg>'], { type: 'image/svg+xml' });
		const result = await compressImage(blob);

		expect(result.blob).toBe(blob);
		expect(result.skipped).toBe(true);
		expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
	});

	test('ICO 跳过压缩', async () => {
		const blob = new Blob(['ico'], { type: 'image/x-icon' });
		const result = await compressImage(blob);

		expect(result.blob).toBe(blob);
		expect(result.skipped).toBe(true);
	});

	// --- 透明通道处理 ---

	test('PNG 压缩前绘制棋盘格背景', async () => {
		const blob = new Blob(['png'], { type: 'image/png' });
		await compressImage(blob);

		// fillRect 至少被调用（白底 + 灰格）
		expect(mockCtx.fillRect).toHaveBeenCalled();
		// 第一次 fillRect 应为白底全覆盖
		expect(mockCtx.fillRect.mock.calls[0]).toEqual([0, 0, 256, 128]);
	});

	test('WebP 压缩前绘制棋盘格背景', async () => {
		const blob = new Blob(['webp'], { type: 'image/webp' });
		await compressImage(blob);

		expect(mockCtx.fillRect).toHaveBeenCalled();
	});

	test('BMP 压缩前绘制棋盘格背景', async () => {
		const blob = new Blob(['bmp'], { type: 'image/bmp' });
		await compressImage(blob);

		expect(mockCtx.fillRect).toHaveBeenCalled();
	});

	test('JPEG 压缩不绘制棋盘格背景', async () => {
		const blob = new Blob(['jpg'], { type: 'image/jpeg' });
		await compressImage(blob);

		expect(mockCtx.fillRect).not.toHaveBeenCalled();
	});

	test('未知 MIME 类型正常压缩且不绘制棋盘格', async () => {
		const blob = new Blob(['data'], { type: '' });
		const result = await compressImage(blob);

		expect(result.skipped).toBe(false);
		expect(result.blob).toBeInstanceOf(Blob);
		expect(result.width).toBe(256);
		expect(result.height).toBe(128);
		expect(mockCtx.fillRect).not.toHaveBeenCalled();
	});

	// --- 异常传播 ---

	test('createImageBitmap 失败时异常正确传播', async () => {
		globalThis.createImageBitmap = vi.fn().mockRejectedValue(new Error('decode failed'));

		const blob = new Blob(['corrupt'], { type: 'image/jpeg' });
		await expect(compressImage(blob)).rejects.toThrow('decode failed');
	});

	// --- canvas fallback / OffscreenCanvas 路径 ---

	test('canvas fallback 路径正确调用 drawImage 和 toBlob', async () => {
		const blob = new Blob(['img'], { type: 'image/jpeg' });
		await compressImage(blob, { type: 'image/jpeg', quality: 0.8 });

		expect(document.createElement).toHaveBeenCalledWith('canvas');
		expect(mockCanvas.width).toBe(256);
		expect(mockCanvas.height).toBe(128);
		expect(mockCtx.drawImage).toHaveBeenCalledWith(mockBitmap, 0, 0, 256, 128);
		expect(mockToBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.8);
	});

	test('OffscreenCanvas 渐进增强路径', async () => {
		const thumbData = new Blob(['oc-thumb'], { type: 'image/jpeg' });
		const mockOcCtx = makeCtx();
		const mockConvertToBlob = vi.fn().mockResolvedValue(thumbData);

		globalThis.OffscreenCanvas = vi.fn().mockImplementation((w, h) => ({
			width: w,
			height: h,
			getContext: vi.fn(() => mockOcCtx),
			convertToBlob: mockConvertToBlob,
		}));
		globalThis.OffscreenCanvas.prototype.convertToBlob = function () {};

		const blob = new Blob(['img'], { type: 'image/jpeg' });
		const result = await compressImage(blob, { quality: 0.6 });

		expect(globalThis.OffscreenCanvas).toHaveBeenCalledWith(256, 128);
		expect(mockOcCtx.drawImage).toHaveBeenCalledWith(mockBitmap, 0, 0, 256, 128);
		expect(mockConvertToBlob).toHaveBeenCalledWith({ type: 'image/jpeg', quality: 0.6 });
		expect(result.blob).toBe(thumbData);
		expect(document.createElement).not.toHaveBeenCalledWith('canvas');
	});

	test('OffscreenCanvas 存在但缺少 convertToBlob 时回退 canvas', async () => {
		// 模拟 Firefox 90-104：OffscreenCanvas 存在但 prototype 无 convertToBlob
		globalThis.OffscreenCanvas = vi.fn();
		globalThis.OffscreenCanvas.prototype = {};

		const blob = new Blob(['img'], { type: 'image/jpeg' });
		const result = await compressImage(blob);

		expect(document.createElement).toHaveBeenCalledWith('canvas');
		expect(result.blob).toBeInstanceOf(Blob);
		expect(result.width).toBe(256);
		expect(result.height).toBe(128);
	});

	test('OffscreenCanvas 路径对 PNG 也绘制棋盘格', async () => {
		const thumbData = new Blob(['oc-thumb'], { type: 'image/jpeg' });
		const mockOcCtx = makeCtx();

		globalThis.OffscreenCanvas = vi.fn().mockImplementation((w, h) => ({
			width: w,
			height: h,
			getContext: vi.fn(() => mockOcCtx),
			convertToBlob: vi.fn().mockResolvedValue(thumbData),
		}));
		globalThis.OffscreenCanvas.prototype.convertToBlob = function () {};

		const blob = new Blob(['png'], { type: 'image/png' });
		await compressImage(blob);

		expect(mockOcCtx.fillRect).toHaveBeenCalled();
		expect(mockOcCtx.fillRect.mock.calls[0]).toEqual([0, 0, 256, 128]);
	});
});
