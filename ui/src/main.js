import { createPinia } from 'pinia';
import ui from '@nuxt/ui/vue-plugin';
import { createApp } from 'vue';

import App from './App.vue';
import { i18n } from './i18n/index.js';
import { router } from './router/index.js';
import { installGlobalErrorHandlers } from './utils/global-error-handler.js';
import { initCapacitorApp } from './utils/capacitor-app.js';
import { initTauriApp } from './utils/tauri-app.js';
import 'highlight.js/styles/vs2015.css';
import './assets/main.css';
import './assets/markdown.scss';

const app = createApp(App);

installGlobalErrorHandlers(app);

app.use(createPinia());
app.use(router);
app.use(i18n);
app.use(ui);
app.mount('#app');
initCapacitorApp(router);
initTauriApp(router);

console.log('[app] mounted');
