import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { compressImage } from './image-helper.js';

// 构造 mock ImageBitmap
function makeBitmap(w, h) {
	return { width: w, height: h, close: vi.fn() };
}

// 构造 mock canvas context
function makeCtx() {
	return { drawImage: vi.fn() };
}

describe('compressImage', () => {
	const origCreateImageBitmap = globalThis.createImageBitmap;
	const origOffscreenCanvas = globalThis.OffscreenCanvas;
	const origCreateElement = document.createElement.bind(document);

	let mockBitmap;
	let mockCtx;
	let mockCanvas;
	let mockConvertToBlob;
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

		expect(result.blob).toBe(blob); // 同一引用
		expect(result.width).toBe(100);
		expect(result.height).toBe(80);
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
		mockConvertToBlob = vi.fn().mockResolvedValue(thumbData);

		globalThis.OffscreenCanvas = vi.fn().mockImplementation((w, h) => ({
			width: w,
			height: h,
			getContext: vi.fn(() => mockOcCtx),
			convertToBlob: mockConvertToBlob,
		}));

		const blob = new Blob(['img'], { type: 'image/jpeg' });
		const result = await compressImage(blob, { quality: 0.6 });

		expect(globalThis.OffscreenCanvas).toHaveBeenCalledWith(256, 128);
		expect(mockOcCtx.drawImage).toHaveBeenCalledWith(mockBitmap, 0, 0, 256, 128);
		expect(mockConvertToBlob).toHaveBeenCalledWith({ type: 'image/jpeg', quality: 0.6 });
		expect(result.blob).toBe(thumbData);
		// 不应使用普通 canvas
		expect(document.createElement).not.toHaveBeenCalledWith('canvas');
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
});
