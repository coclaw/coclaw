/**
 * 图片压缩工具
 *
 * 将图片 Blob 等比缩放为缩略图，输出 JPEG 压缩格式。
 * 支持 OffscreenCanvas 渐进增强（Safari 16.4+ / Chrome 69+），
 * 不支持时回退到普通 canvas（主线程绘制，对小缩略图耗时可忽略）。
 */

/**
 * 将图片 Blob 压缩为缩略图
 *
 * 等比缩放使图片 fit 在 maxWidth × maxHeight 的矩形内，
 * 若原图已小于目标尺寸则直接返回原 Blob。
 *
 * @param {Blob} blob - 原始图片 Blob
 * @param {object} [opts]
 * @param {number} [opts.maxWidth=256] - 最大宽度（px）
 * @param {number} [opts.maxHeight=256] - 最大高度（px）
 * @param {string} [opts.type='image/jpeg'] - 输出 MIME 类型
 * @param {number} [opts.quality=0.7] - 压缩质量 (0-1)
 * @returns {Promise<{ blob: Blob, width: number, height: number }>}
 */
export async function compressImage(blob, opts = {}) {
	const {
		maxWidth = 256,
		maxHeight = 256,
		type = 'image/jpeg',
		quality = 0.7,
	} = opts;

	// 解码获取原始尺寸
	const bmp = await createImageBitmap(blob);
	const { width: ow, height: oh } = bmp;

	// 计算缩放比例（fit-in-box，保持宽高比）
	const scale = Math.min(1, maxWidth / ow, maxHeight / oh);

	if (scale >= 1) {
		bmp.close();
		return { blob, width: ow, height: oh };
	}

	const tw = Math.round(ow * scale);
	const th = Math.round(oh * scale);

	// 渐进增强：优先 OffscreenCanvas（异步，离主线程）
	if (typeof OffscreenCanvas !== 'undefined') {
		const oc = new OffscreenCanvas(tw, th);
		oc.getContext('2d').drawImage(bmp, 0, 0, tw, th);
		bmp.close();
		const thumbBlob = await oc.convertToBlob({ type, quality });
		return { blob: thumbBlob, width: tw, height: th };
	}

	// fallback：普通 canvas（主线程，对小缩略图耗时可忽略）
	const canvas = document.createElement('canvas');
	canvas.width = tw;
	canvas.height = th;
	canvas.getContext('2d').drawImage(bmp, 0, 0, tw, th);
	bmp.close();

	const thumbBlob = await new Promise((resolve) => {
		canvas.toBlob(resolve, type, quality);
	});

	return { blob: thumbBlob, width: tw, height: th };
}
