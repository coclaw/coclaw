import { app } from 'electron';

/**
 * 系统是否为中文环境
 */
export function isZhLocale() {
	return app.getLocale().startsWith('zh');
}

/**
 * 获取本地化的应用标题
 * 中文环境（简体/繁体）显示"可虾"，其它语种显示"CoClaw"
 */
export function getAppTitle() {
	return isZhLocale() ? '可虾' : 'CoClaw';
}

/**
 * 获取本地化文本
 * @param {string} zh - 中文文本
 * @param {string} en - 英文文本
 */
export function t(zh, en) {
	return isZhLocale() ? zh : en;
}
