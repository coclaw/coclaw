/**
 * 图片压缩工具
 *
 * 将图片 Blob 等比缩放为缩略图，输出 JPEG 压缩格式。
 * 支持 OffscreenCanvas 渐进增强（Safari 16.4+ / Chrome 69+），
 * 不支持时回退到普通 canvas（主线程绘制，对小缩略图耗时可忽略）。
 */

// 跳过压缩的 MIME 类型（动图/矢量/图标，保留原数据更有价值）
const SKIP_TYPES = new Set(['image/gif', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon']);

// 可能含透明通道的 MIME 类型
const ALPHA_TYPES = new Set(['image/png', 'image/webp', 'image/bmp']);

/**
 * 在 canvas 上绘制棋盘格透明背景
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {number} w
 * @param {number} h
 * @param {number} [cell=8] - 格子边长（px）
 */
function fillCheckerboard(ctx, w, h, cell = 8) {
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, 0, w, h);
	ctx.fillStyle = '#ccc';
	for (let y = 0; y < h; y += cell) {
		for (let x = 0; x < w; x += cell) {
			if ((x / cell + y / cell) & 1) {
				ctx.fillRect(x, y, cell, cell);
			}
		}
	}
}

/**
 * 将图片 Blob 压缩为缩略图
 *
 * 等比缩放使图片 fit 在 maxWidth × maxHeight 的矩形内，
 * 若原图已小于目标尺寸则直接返回原 Blob。
 * GIF / SVG / ICO 等类型跳过压缩，直接返回。
 * 含透明通道的格式（PNG / WebP / BMP）绘制前填充棋盘格背景。
 *
 * @param {Blob} blob - 原始图片 Blob
 * @param {object} [opts]
 * @param {number} [opts.maxWidth=256] - 最大宽度（px）
 * @param {number} [opts.maxHeight=256] - 最大高度（px）
 * @param {string} [opts.type='image/jpeg'] - 输出 MIME 类型
 * @param {number} [opts.quality=0.7] - 压缩质量 (0-1)
 * @returns {Promise<{ blob: Blob, width: number, height: number, skipped: boolean }>}
 */
export async function compressImage(blob, opts = {}) {
	const {
		maxWidth = 256,
		maxHeight = 256,
		type = 'image/jpeg',
		quality = 0.7,
	} = opts;

	// 跳过不适合压缩的类型
	if (SKIP_TYPES.has(blob.type)) {
		return { blob, width: 0, height: 0, skipped: true };
	}

	// 解码获取原始尺寸
	const bmp = await createImageBitmap(blob);
	const { width: ow, height: oh } = bmp;

	// 计算缩放比例（fit-in-box，保持宽高比）
	const scale = Math.min(1, maxWidth / ow, maxHeight / oh);

	if (scale >= 1) {
		bmp.close();
		return { blob, width: ow, height: oh, skipped: false };
	}

	const tw = Math.max(1, Math.round(ow * scale));
	const th = Math.max(1, Math.round(oh * scale));
	const needAlphaBg = ALPHA_TYPES.has(blob.type);

	// 渐进增强：优先 OffscreenCanvas（异步，离主线程）
	if (typeof OffscreenCanvas !== 'undefined' && OffscreenCanvas.prototype.convertToBlob) {
		const oc = new OffscreenCanvas(tw, th);
		const ctx = oc.getContext('2d');
		if (needAlphaBg) fillCheckerboard(ctx, tw, th);
		ctx.drawImage(bmp, 0, 0, tw, th);
		bmp.close();
		const thumbBlob = await oc.convertToBlob({ type, quality });
		return { blob: thumbBlob, width: tw, height: th, skipped: false };
	}

	// fallback：普通 canvas（主线程，对小缩略图耗时可忽略）
	const canvas = document.createElement('canvas');
	canvas.width = tw;
	canvas.height = th;
	const ctx = canvas.getContext('2d');
	if (needAlphaBg) fillCheckerboard(ctx, tw, th);
	ctx.drawImage(bmp, 0, 0, tw, th);
	bmp.close();

	const thumbBlob = await new Promise((resolve) => {
		canvas.toBlob(resolve, type, quality);
	});

	return { blob: thumbBlob, width: tw, height: th, skipped: false };
}
