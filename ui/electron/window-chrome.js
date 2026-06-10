/**
 * 窗口外观（标题栏）平台决策 —— 自定义标题栏方案的壳侧单一真相源。
 *
 * 设计稿：docs/designs/electron-custom-titlebar.md（§3/§4）。
 * 抽成独立模块的原因：main.js 顶层全是副作用（单实例锁 / app.quit / whenReady），
 * 无测试敢 import；本仓既定模式是把可测的纯逻辑抽成独立模块（url-guard / locale 同档）。
 *
 * 关键约束：平台判定 + forceNative override 只在 buildWindowChrome 一处定，
 * preload 只读主进程经 additionalArguments 下发的 custom 标志、不重算（见设计稿 §4.2）。
 */

/** 标题栏条高度（px）；与 web 侧作用域 CSS 的 --cc-titlebar-h 保持一致 */
export const TITLEBAR_HEIGHT = 38;

// 窗口创建期固定背景色（暗色 bg-default，app 默认 dark 主题），避免首帧前露白底闪。
// 取舍见设计稿 §4.1：dark 用户受益、light 用户 reload 时新增一道暗闪，固有取舍不另处理。
const BACKGROUND_COLOR = '#202122';

// Windows WCO 按钮初值硬编码暗色（app 默认 dark）；运行时由 web 侧 theme-mode 按主题刷新。
// 这两个常量是「首帧防闪」用，运行时权威色值见设计稿 §6（dark color=#1b1b1b / symbolColor 近白）。
const WCO_DARK_COLOR = '#1b1b1b';
const WCO_DARK_SYMBOL_COLOR = '#e5e5e5';

// mac 红绿灯自定义位：系统默认位按标准矮栏（≈28px）设计，落在 38px 条里偏高。
// 按钮直径 12px（macOS 固定值），y 取 (条高-12)/2 垂直居中；x 维持系统惯用左距，不动横向。
const TRAFFIC_LIGHT_POSITION = { x: 7, y: (TITLEBAR_HEIGHT - 12) / 2 };

/**
 * @typedef {Object} WindowChrome
 * @property {boolean} custom - 本壳是否隐藏了原生栏（平台决策单一真相源，经 additionalArguments 下发 preload）
 * @property {string|null} titleBarStyle - BrowserWindow titleBarStyle；custom 时为 'hidden'，否则 null（原生栏）
 * @property {{color:string,symbolColor:string,height:number}|null} titleBarOverlay - 仅 Windows custom 时给出（系统画 WCO）
 * @property {{x:number,y:number}|null} trafficLightPosition - 仅 macOS custom 时给出（红绿灯在条内垂直居中）
 * @property {string} backgroundColor - 窗口创建期背景色
 */

/**
 * 据平台决定窗口外观。
 * - macOS：titleBarStyle 'hidden' → 原生栏消失、系统保留红绿灯（自定义位，垂直居中到 38px 条）。
 * - Windows：'hidden' + titleBarOverlay（系统画最小/最大/关闭，颜色由我们给）。单写 hidden 会连按钮删掉。
 * - Linux 及其它：本期保持原生栏（窗口装饰由桌面环境画、WCO 支持不统一），custom:false。
 * - forceNative：构建期应急回退（见设计稿 §8），三平台一律回落原生栏、custom:false、无 hidden。
 * @param {string} platform - process.platform 值（'darwin' | 'win32' | 'linux' | ...）
 * @param {{ forceNative?: boolean }} [opts]
 * @returns {WindowChrome}
 */
export function buildWindowChrome(platform, { forceNative = false } = {}) {
	if (forceNative) {
		return { custom: false, titleBarStyle: null, titleBarOverlay: null, trafficLightPosition: null, backgroundColor: BACKGROUND_COLOR };
	}
	if (platform === 'darwin') {
		return {
			custom: true,
			titleBarStyle: 'hidden',
			titleBarOverlay: null,
			trafficLightPosition: TRAFFIC_LIGHT_POSITION,
			backgroundColor: BACKGROUND_COLOR,
		};
	}
	if (platform === 'win32') {
		return {
			custom: true,
			titleBarStyle: 'hidden',
			titleBarOverlay: {
				color: WCO_DARK_COLOR,
				symbolColor: WCO_DARK_SYMBOL_COLOR,
				height: TITLEBAR_HEIGHT,
			},
			trafficLightPosition: null,
			backgroundColor: BACKGROUND_COLOR,
		};
	}
	// linux 及其它平台：本期不走自定义栏
	return { custom: false, titleBarStyle: null, titleBarOverlay: null, trafficLightPosition: null, backgroundColor: BACKGROUND_COLOR };
}

// 记录哪些窗口在创建时确实启用了 WCO（titleBarOverlay）。
// setTitleBarOverlay 要求窗口创建时已启用 WCO，否则崩（Electron #34137）；
// ipc 层据此「按 WCO 是否启用再调」护栏，不能只判 win32（win32 + forceNative 下窗口没 WCO）。
const wcoWindows = new WeakSet();

/**
 * 标记某窗口创建时启用了 WCO（main.js 在 chrome.titleBarOverlay 存在时调用）。
 * @param {object} win - BrowserWindow 实例
 */
export function markWindowWco(win) {
	wcoWindows.add(win);
}

/**
 * 该窗口是否启用了 WCO（供 ipc 层 setTitleBarOverlay 护栏判定）。
 * @param {object} win - BrowserWindow 实例
 * @returns {boolean}
 */
export function isWindowWcoEnabled(win) {
	return wcoWindows.has(win);
}
