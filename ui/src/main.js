import { createPinia } from 'pinia';
import ui from '@nuxt/ui/vue-plugin';
import { createApp } from 'vue';

import App from './App.vue';
import { i18n } from './i18n/index.js';
import { router } from './router/index.js';
import './assets/main.css';
import './assets/markdown.scss';

const app = createApp(App);

app.config.errorHandler = (err, vm, info) => {
	console.error('[vue] unhandled error in %s:', info, err);
};

app.use(createPinia());
app.use(router);
app.use(i18n);
app.use(ui);
app.mount('#app');

console.log('[app] mounted');
