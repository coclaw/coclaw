import contextMenu from 'electron-context-menu';
import { t } from './locale.js';

/**
 * 给窗口注册右键上下文菜单（基于 electron-context-menu）。
 * 选区→复制；可编辑框→剪切/复制/粘贴/全选；并强制开启"检查元素"（生产下也多给一条开 DevTools 的路）。
 * 菜单文案走壳子 i18n（中/英），在窗口创建时按系统语言定文案。
 * @param {Electron.BrowserWindow} win - 目标窗口
 * @returns {() => void} 注销函数
 */
export function setupContextMenu(win) {
	return contextMenu({
		window: win,
		showSelectAll: true,
		// 强制开启（默认仅非生产才显示），与 F12 常开保持一致
		showInspectElement: true,
		// 聊天场景不需要"用 Google 搜索"，避免选区文本外泄到搜索引擎
		showSearchWithGoogle: false,
		labels: {
			cut: t('剪切', 'Cut'),
			copy: t('复制', 'Copy'),
			paste: t('粘贴', 'Paste'),
			selectAll: t('全选', 'Select All'),
			copyLink: t('复制链接', 'Copy Link'),
			copyImage: t('复制图片', 'Copy Image'),
			// macOS 限定：选中文字时的系统词典查询（{selection} 由库回填）
			lookUpSelection: t('查询“{selection}”', 'Look Up “{selection}”'),
			// 可编辑框中右键拼写错误词时出现
			learnSpelling: t('加入词典', 'Learn Spelling'),
			inspect: t('检查元素', 'Inspect Element'),
		},
	});
}
