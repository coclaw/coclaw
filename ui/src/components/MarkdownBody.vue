<template>
	<div ref="mdRoot" class="cc-markdown" v-html="mdHtml" @click="onLinkClick"></div>
</template>

<script>
import { renderMarkdown, reviseMdText } from '../utils/markdown-engine.js';
import { openExternalUrl } from '../utils/external-url.js';
import { useNotify } from '../composables/use-notify.js';

export default {
	name: 'MarkdownBody',
	props: {
		text: {
			type: String,
			required: true,
		},
	},
	setup() {
		return { notify: useNotify() };
	},
	computed: {
		revisedText() {
			return reviseMdText(this.text);
		},
		mdHtml() {
			return renderMarkdown(this.revisedText);
		},
	},
	watch: {
		mdHtml() {
			this.$nextTick(() => this.__postProcess());
		},
	},
	mounted() {
		this.$nextTick(() => this.__postProcess());
	},
	methods: {
		// DOM 后处理：复制按钮绑定 + 表格包裹
		__postProcess() {
			const root = this.$refs.mdRoot;
			if (!root) return;

			this.__bindCopyButtons(root);
			this.__wrapTables(root);
			this.__applyI18n(root);
		},

		// 绑定代码块复制按钮
		__bindCopyButtons(root) {
			const containers = root.querySelectorAll('.hljs-code-container');
			const copyLabel = this.$t('markdown.copy');
			const copiedLabel = this.$t('markdown.copied');

			containers.forEach((container) => {
				const btn = container.querySelector('.hljs-copy-button');
				const codeEl = container.querySelector('code');
				if (!btn || !codeEl) return;

				btn.onclick = () => {
					const text = (codeEl.textContent ?? '').trim();
					navigator.clipboard.writeText(text).then(() => {
						btn.innerHTML = copiedLabel;
						btn.style.padding = '0 8px';
						btn.dataset.copied = 'true';

						setTimeout(() => {
							btn.innerHTML = copyLabel;
							btn.style.padding = '0';
							btn.dataset.copied = 'false';
						}, 3000);
					}).catch(() => {
						this.notify.error(this.$t('common.copyFailed'));
					});
				};
			});
		},

		// 表格外层包裹 .table-box 容器（实现圆角）
		__wrapTables(root) {
			const tables = root.querySelectorAll('table');
			tables.forEach((table) => {
				if (table.parentNode?.classList.contains('table-box')) return;
				const wrapper = document.createElement('div');
				wrapper.classList.add('table-box');
				table.parentNode.insertBefore(wrapper, table);
				wrapper.appendChild(table);
			});
		},

		// 替换 data-i18n 占位为翻译文本
		__applyI18n(root) {
			const textLabel = this.$t('markdown.codeLangText');
			const copyLabel = this.$t('markdown.copy');
			const copiedLabel = this.$t('markdown.copied');

			root.querySelectorAll('[data-i18n-text]').forEach((el) => {
				el.textContent = textLabel;
			});
			root.querySelectorAll('[data-i18n-copy]').forEach((el) => {
				if (el.dataset.copied !== 'true') {
					el.innerHTML = copyLabel;
				}
			});
			// data-i18n-copied 仅在运行时由 __bindCopyButtons 使用
			void copiedLabel;
		},

		/**
		 * 链接点击统一拦截
		 *
		 * 各 scheme 处理策略：
		 * - http/https：preventDefault 后走 openExternalUrl 统一分发（Capacitor 必需，否则无法正确打开）
		 * - mailto/tel：不拦截，各平台系统默认行为均正常
		 * - #anchor：不拦截，页面内跳转
		 * - javascript/vbscript/data：安全拦截，直接吞掉（markdown-it 默认已过滤，此处为防御性兜底）
		 *
		 * 已知未处理：
		 * - 自定义协议（vscode://、obsidian:// 等）：Capacitor WebView 中点击无响应，
		 *   需原生层 intent 转发支持，当前未实现；Browser/Electron 可正常唤起
		 */
		onLinkClick(event) {
			const anchor = event.target.closest('a[href]');
			if (!anchor) return;

			const href = anchor.getAttribute('href');
			if (!href) return;

			// 防御性拦截危险 scheme（防止 markdown-it 配置变更后产生此类 <a>）
			if (/^(?:javascript|vbscript|data):/i.test(href)) {
				event.preventDefault();
				return;
			}

			if (href.startsWith('http://') || href.startsWith('https://')) {
				event.preventDefault();
				openExternalUrl(href);
			}
		},
	},
};
</script>
