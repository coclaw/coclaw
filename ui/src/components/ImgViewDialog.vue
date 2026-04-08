<template>
	<UModal
		v-model:open="openProxy"
		description=" "
		:ui="modalUi"
		@after:leave="$emit('after:leave')"
	>
		<template #body>
			<div class="relative flex items-center justify-center bg-black">
				<img
					:src="src"
					alt=""
					class="max-w-[90vw] max-h-[85vh] object-contain"
				/>
				<!-- 关闭按钮 -->
				<UButton
					class="absolute top-2 right-2 cc-icon-btn"
					icon="i-lucide-x"
					variant="ghost"
					color="neutral"
					size="lg"
					:ui="{ base: 'text-white hover:bg-white/20' }"
					@click="openProxy = false"
				/>
				<!-- 下载按钮 -->
				<UButton
					class="absolute top-2 left-2 cc-icon-btn"
					icon="i-lucide-download"
					variant="ghost"
					color="neutral"
					size="lg"
					:ui="{ base: 'text-white hover:bg-white/20' }"
					@click="download"
				/>
			</div>
		</template>
	</UModal>
</template>

<script>
import { popDialogState } from '../utils/dialog-history.js';
import { saveBlobToFile } from '../utils/file-helper.js';
import { useNotify } from '../composables/use-notify.js';

export default {
	name: 'ImgViewDialog',
	props: {
		open: {
			type: Boolean,
			default: false,
		},
		src: {
			type: String,
			required: true,
		},
		filename: {
			type: String,
			default: 'image',
		},
	},
	emits: ['update:open', 'after:leave'],
	setup() {
		return { notify: useNotify() };
	},
	data() {
		return {
			modalUi: {
				content: 'max-w-fit bg-black divide-y-0 p-0 ring-0 shadow-none',
				body: 'p-0 sm:p-0',
				header: 'hidden',
				footer: 'hidden',
			},
		};
	},
	computed: {
		openProxy: {
			get() {
				return this.open;
			},
			set(val) {
				this.$emit('update:open', val);
			},
		},
	},
	watch: {
		open(val) {
			if (!val) popDialogState();
		},
	},
	methods: {
		async download() {
			try {
				const resp = await fetch(this.src);
				const blob = await resp.blob();
				await saveBlobToFile(blob, this.filename);
			} catch (err) {
				console.warn('[ImgViewDialog] download failed:', err);
				this.notify.error(this.$t('files.downloadFailed'));
			}
		},
	},
};
</script>
