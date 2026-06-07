/**
 * 给窗口绑定 DevTools 快捷键：F12 与 Ctrl+Shift+I 切换 DevTools（生产也生效）。
 * 用窗口级 before-input-event，而非 globalShortcut——后者在 app 未聚焦时也会触发，对 F12 不合适。
 * DevTools 打开后会抢走焦点、其自身是独立 webContents，此时按键不走主窗口；故 DevTools 打开时
 * 把同一处理器也挂到它上面，保证再按一次 F12 能把它关掉。
 * @param {Electron.BrowserWindow} win - 目标窗口
 */
export function setupDevtoolsShortcut(win) {
	if (!win) return;
	const wc = win.webContents;
	const onInput = (e, input) => {
		if (input.type !== 'keyDown') return;
		// 严格匹配：排除带额外修饰键的组合（如 Ctrl+F12、Ctrl+Alt+Shift+I）误触发
		const isF12 = input.key === 'F12' && !input.control && !input.shift && !input.alt && !input.meta;
		const isInspect = input.control && input.shift && !input.alt && !input.meta && input.key?.toLowerCase() === 'i';
		if (isF12 || isInspect) {
			wc.toggleDevTools();
			e.preventDefault();
		}
	};
	wc.on('before-input-event', onInput);
	// DevTools 每次打开都是新的 webContents，挂上同一处理器；关闭时它被销毁、监听器随之释放
	wc.on('devtools-opened', () => {
		wc.devToolsWebContents?.on('before-input-event', onInput);
	});
}
