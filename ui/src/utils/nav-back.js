/**
 * 通用"返回"导航：有上一页就 router.back()，没有就 replace 到 fallback
 *
 * 适用场景：移动端子页面 header / 桌面端子页面 header 的返回按钮。
 * 覆盖 Electron / Capacitor 冷启动直进 deep link 的边界——此时 history 栈里
 * 没有 back，单纯 router.back() 会卡在原页。
 *
 * @param {object} router - vue-router 实例（一般是组件的 this.$router）
 * @param {string} [fallback='/'] - 没有上一页时跳转的目标路径
 */
export function navBack(router, fallback = '/') {
	if (history.state?.back) {
		router.back();
	}
	else {
		router.replace(fallback);
	}
}
