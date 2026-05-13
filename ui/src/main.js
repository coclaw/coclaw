import { createPinia } from 'pinia';
import ui from '@nuxt/ui/vue-plugin';
import { createApp } from 'vue';

import App from './App.vue';
import { i18n } from './i18n/index.js';
import { router } from './router/index.js';
import { installGlobalErrorHandlers } from './utils/global-error-handler.js';
import { initCapacitorApp } from './utils/capacitor-app.js';
import { initTauriApp } from './utils/tauri-app.js';
import { initElectronApp } from './utils/electron-app.js';
import { startUpdateCheck } from './services/app-update.js';
import { buildUiStartText } from './services/env-snapshot.js';
import { useRemoteLog } from './services/remote-log.js';
import { useDraftStore } from './stores/draft.store.js';
import './stores/claw-lifecycle.js'; // 注册 claw 生命周期回调（须在 claws.store action 被调用前）
// notify-hook-bridge 的 wireNotifyHooks() 由 App.vue 的 setup 内调用，无需在此 side-effect import
import 'highlight.js/styles/vs2015.css';
import './assets/main.css';
import './assets/markdown.scss';

// 早于 auth 初始化挂起 remote-log 单例：登录前 / 登录失败窗口的诊断 log 也能上送 server。
// 首条 log 是 ui.start 环境快照，便于 server 侧诊断（platform / viewport / ua 等）。
// 包一层 try/catch 防御：第三方注入的 Capacitor/electronAPI 全局若在调用时抛错，
// 不应阻塞 Vue app mount（保持与旧 useRemoteLog 内部兜底一致的启动可用性）。
const __rl = useRemoteLog();
try {
	__rl.log(buildUiStartText(__rl.uiId));
} catch (err) {
	console.warn('[remote-log] ui.start build failed:', err?.message);
}

const app = createApp(App);

installGlobalErrorHandlers(app);

app.use(createPinia());
app.use(router);
app.use(i18n);
app.use(ui);
app.mount('#app');
useDraftStore().initPersist();
initCapacitorApp(router);
initTauriApp(router);
initElectronApp(router);
startUpdateCheck();

console.log('[app] mounted');
