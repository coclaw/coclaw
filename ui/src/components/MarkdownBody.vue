<template>
	<div ref="mdRoot" class="cc-markdown" v-html="mdHtml" @click="onLinkClick"></div>
	<ImgViewDialog
		v-if="imgPreviewSrc"
		v-model:open="imgPreviewOpen"
		:src="imgPreviewSrc"
		:filename="imgPreviewName"
		@after:leave="__onImgPreviewLeave"
	/>
</template>

<script>
import { renderMarkdown, reviseMdText, replaceCoclawFileImages } from '../utils/markdown-engine.js';
import { openExternalUrl } from '../utils/external-url.js';
import { writeClipboardText } from '../utils/clipboard.js';
import { useNotify } from '../composables/use-notify.js';
import { isCoclawScheme, extractCoclawPath, buildCoclawUrl, fetchCoclawFile } from '../services/coclaw-file.js';
import { validateCoclawPath, isImageByExt, saveBlobToFile } from '../utils/file-helper.js';
import ImgViewDialog from './ImgViewDialog.vue';
import { pushDialogState, popDialogState } from '../utils/dialog-history.js';

export default {
	name: 'MarkdownBody',
	components: { ImgViewDialog },
	props: {
		text: {
			type: String,
			required: true,
		},
		/** 用于构建完整 coclaw-file URL，为空时 coclaw-file 链接不可交互 */
		clawId: {
			type: String,
			default: '',
		},
		agentId: {
			type: String,
			default: '',
		},
	},
	setup() {
		return { notify: useNotify() };
	},
	data() {
		return {
			imgPreviewOpen: false,
			imgPreviewSrc: null,
			imgPreviewName: '',
		};
	},
	computed: {
		revisedText() {
			let t = reviseMdText(this.text);
			t = replaceCoclawFileImages(t);
			return t;
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
	beforeUnmount() {
		if (this.imgPreviewOpen) {
			popDialogState();
			this.imgPreviewOpen = false;
		}
		this.__revokeImgPreview();
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
					writeClipboardText(text).then(() => {
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
		 * - coclaw-file：提取路径 → 图片用 ImgViewDialog 预览；其他触发下载
		 * - http/https：preventDefault 后走 openExternalUrl 统一分发（Capacitor 必需）
		 * - mailto/tel：不拦截，各平台系统默认行为均正常
		 * - #anchor：不拦截，页面内跳转
		 * - javascript/vbscript/data：安全拦截，直接吞掉
		 */
		onLinkClick(event) {
			const anchor = event.target.closest('a[href]');
			if (!anchor) return;

			const href = anchor.getAttribute('href');
			if (!href) return;

			// coclaw-file: 链接
			if (isCoclawScheme(href)) {
				event.preventDefault();
				this.__handleCoclawFileClick(href);
				return;
			}

			// 防御性拦截危险 scheme
			if (/^(?:javascript|vbscript|data):/i.test(href)) {
				event.preventDefault();
				return;
			}

			if (href.startsWith('http://') || href.startsWith('https://')) {
				event.preventDefault();
				openExternalUrl(href);
			}
		},

		/** 处理 coclaw-file: 链接点击 */
		async __handleCoclawFileClick(href) {
			const path = extractCoclawPath(href);
			if (!path || !validateCoclawPath(path)) {
				console.warn('[MarkdownBody] invalid coclaw-file path:', href);
				return;
			}
			if (!this.clawId || !this.agentId) {
				console.warn('[MarkdownBody] clawId/agentId not available, cannot fetch file');
				return;
			}

			const fullUrl = buildCoclawUrl(this.clawId, this.agentId, path);
			const filename = path.split('/').pop();

			try {
				const blob = await fetchCoclawFile(fullUrl);
				if (isImageByExt(path)) {
					this.__showImgPreview(blob, filename);
				} else {
					saveBlobToFile(blob, filename);
				}
			} catch (err) {
				console.warn('[MarkdownBody] coclaw-file fetch failed:', err);
				this.notify.error(this.$t('common.downloadFailed'));
			}
		},

		/** 显示图片预览 */
		__showImgPreview(blob, filename) {
			this.__revokeImgPreview();
			this.imgPreviewSrc = URL.createObjectURL(blob);
			this.imgPreviewName = filename;
			pushDialogState(() => { this.imgPreviewOpen = false; });
			this.imgPreviewOpen = true;
		},

		__onImgPreviewLeave() {
			this.__revokeImgPreview();
		},

		__revokeImgPreview() {
			if (this.imgPreviewSrc) {
				URL.revokeObjectURL(this.imgPreviewSrc);
				this.imgPreviewSrc = null;
			}
		},
	},
};
</script>
