export function isMobileViewport(width) {
	if (typeof width !== 'number') {
		return false;
	}
	return width <= 767;
}

/**
 * 判断当前设备是否以触屏为主输入方式（手机/平板）
 * 桌面端即使有触屏，主输入设备仍是鼠标，返回 false
 */
export function isTouchDevice() {
	if (typeof window === 'undefined') return false;
	return window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
}
