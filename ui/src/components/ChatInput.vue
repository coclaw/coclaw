<template>
	<footer class="sticky bottom-0 z-10 bg-default py-3">
		<slot name="prepend" />
		<!-- 文件预览区（含上传进度覆层） -->
		<div
			v-if="inputFiles.length"
			class="mx-auto mb-2 flex w-full max-w-3xl flex-wrap gap-2 px-3"
		>
			<div
				v-for="(f, idx) in inputFiles"
				:key="f.id"
				class="group relative"
				:class="[f.isImg ? 'min-h-14 aspect-square' : '', __fileStatus(f.id) === 'uploading' ? 'opacity-70' : '']"
			>
				<!-- 图片缩略图 -->
				<img
					v-if="f.isImg"
					:src="f.url"
					:alt="f.name"
					class="absolute inset-0 size-full cursor-pointer rounded-md border border-accented object-cover"
					@click="previewImg(f)"
				/>
				<!-- 语音文件卡片 -->
				<div v-else-if="f.isVoice" class="flex min-h-14 max-w-60 gap-1 rounded-xl border border-accented py-2 pl-1 pr-3">
					<UIcon name="i-lucide-mic" class="size-8 shrink-0 self-center text-muted" />
					<div class="min-w-0 flex flex-1 flex-col justify-evenly text-xs leading-tight">
						<div class="truncate font-medium">{{ voiceDisplayName(f) }}</div>
						<div class="text-muted">{{ f.label }}</div>
					</div>
				</div>
				<!-- 非图片文件卡片 -->
				<div v-else class="flex min-h-14 max-w-60 gap-1 rounded-xl border border-accented py-2 pl-1 pr-3">
					<UIcon name="i-lucide-file" class="size-8 shrink-0 self-center text-amber-400" />
					<div class="min-w-0 flex flex-1 flex-col justify-evenly text-xs leading-tight">
						<div class="flex text-default">
							<span class="truncate">{{ fileBaseName(f) }}</span>
							<span v-if="f.ext" class="shrink-0">.{{ f.ext }}</span>
						</div>
						<div class="text-muted">{{ f.label }}</div>
					</div>
				</div>
				<!-- 上传进度覆层 -->
				<div
					v-if="__fileStatus(f.id) === 'uploading'"
					class="absolute inset-0 flex items-center justify-center rounded-md bg-default/50"
				>
					<span class="text-xs font-medium text-primary">{{ __filePercent(f.id) }}%</span>
				</div>
				<!-- 移除按钮（上传中不显示） -->
				<button
					v-if="!__fileStatus(f.id)"
					:class="[
						'absolute -right-1.5 -top-3.5 flex size-6 items-center justify-center rounded-full',
						'bg-error text-white',
						this.envStore.canHover ? 'opacity-0 group-hover:opacity-100' : '',
					]"
					@click="removeInputFile(idx)"
				>
					<UIcon name="i-lucide-x" class="size-4" />
				</button>
			</div>
		</div>
		<!-- 图片预览对话框 -->
		<ImgViewDialog
			v-model:open="previewImgOpen"
			:src="previewImgSrc"
			:filename="previewImgName"
		/>

		<form
			class="mx-auto flex w-full max-w-3xl items-end gap-2 pl-1.5 pr-3"
			@submit.prevent="onSubmit"
		>
			<!-- 左侧按钮区 -->
			<div class="flex shrink-0 items-end gap-1">
				<!-- 触屏设备：键盘/语音切换 -->
				<UButton
					v-if="isTouchDevice"
					class="cc-icon-btn-lg"
					:icon="inputMode === 'keyboard' ? 'i-lucide-mic' : 'i-lucide-keyboard'"
					variant="ghost"
					color="primary"
					size="md"
					@click="toggleInputMode"
				/>
				<!-- 桌面端：麦克风 -->
				<UButton
					v-if="!isTouchDevice && !isDesktopRecording"
					class="cc-icon-btn-lg"
					icon="i-lucide-mic"
					variant="ghost"
					color="primary"
					size="md"
					@click="onStartDesktopRecording"
				/>
			</div>

			<!-- 中间输入区 -->
			<div class="min-w-0 flex-1">
				<!-- 桌面录音波形 -->
				<div
					v-if="isDesktopRecording"
					class="flex items-center gap-2"
				>
					<div ref="deskWaveContainer" class="h-10 min-w-0 flex-1 rounded-md bg-elevated" />
					<UButton
						class="cc-icon-btn-lg"
						icon="i-lucide-x"
						variant="ghost"
						color="error"
						size="md"
						@click="onCancelDesktopRecording"
					/>
					<UButton
						class="cc-icon-btn-lg"
						icon="i-lucide-check"
						variant="soft"
						color="success"
						size="md"
						@click="onStopDesktopRecording"
					/>
				</div>
				<!-- 触屏语音模式：按住说话 -->
				<UButton
					v-else-if="isTouchDevice && inputMode === 'voice'"
					variant="outline"
					color="neutral"
					block
					class="rounded-full"
					:disabled="sending || disabled"
					@touchstart.prevent="onTouchSpeakStart"
				>
					{{ $t('chat.voiceHoldToSpeak') }}
				</UButton>
				<!-- 文本输入 -->
				<UTextarea
					v-else
					ref="textareaRef"
					data-testid="chat-textarea"
					:model-value="modelValue"
					:placeholder="$t('chat.inputPlaceholder')"
					:disabled="disabled"
					autoresize
					:rows="1"
					:maxrows="8"
					size="xl"
					class="w-full"
					@update:model-value="$emit('update:modelValue', $event)"
					@keydown="onKeydown"
				/>
			</div>

			<!-- 右侧按钮区 -->
			<div class="flex shrink-0 items-end gap-1">
				<!-- 文件上传 -->
				<UButton
					v-if="!isDesktopRecording"
					data-testid="btn-attach"
					class="cc-icon-btn-lg"
					icon="i-lucide-plus"
					variant="ghost"
					color="primary"
					size="md"
					:disabled="sending || disabled"
					@click="onClickAddFiles"
				/>
				<!-- 终止 -->
				<UButton
					v-if="sending"
					data-testid="btn-stop"
					class="cc-icon-btn-lg"
					icon="i-lucide-square"
					color="error"
					variant="soft"
					size="md"
					:title="$t('chat.stopSending')"
					@click="$emit('cancel')"
				/>
				<!-- 发送 -->
				<UButton
					v-else-if="canSend"
					data-testid="btn-send"
					class="cc-icon-btn-lg"
					icon="i-lucide-send"
					color="primary"
					variant="soft"
					size="md"
					type="submit"
				/>
			</div>
		</form>

		<!-- 隐藏文件选择器 -->
		<input
			ref="fileInput"
			data-testid="file-input"
			type="file"
			multiple
			class="hidden"
			@change="onFilesSelected"
		/>

		<!-- 移动端语音弹窗 -->
		<TouchSpeakOverlay
			v-if="touchSpeakOpen"
			v-model:open="touchSpeakOpen"
			:init-touch-id="touchSpeakTouchId"
			@close="onTouchSpeakClose"
		/>
	</footer>
</template>

<script>
import { useEnvStore } from '../stores/env.store.js';
import { useNotify } from '../composables/use-notify.js';
import { formatFileSize, formatFileBlob } from '../utils/file-helper.js';
import { MAX_UPLOAD_SIZE } from '../services/file-transfer.js';
import { VoiceRecorder, MAX_RECORD_DURATION } from '../utils/voice-recorder.js';
import TouchSpeakOverlay from './TouchSpeakOverlay.vue';
import ImgViewDialog from './ImgViewDialog.vue';

export default {
	name: 'ChatInput',
	components: {
		TouchSpeakOverlay,
		ImgViewDialog,
	},
	props: {
		modelValue: {
			type: String,
			default: '',
		},
		sending: {
			type: Boolean,
			default: false,
		},
		fileUploadState: {
			type: Object,
			default: null,
		},
		disabled: {
			type: Boolean,
			default: false,
		},
	},
	emits: ['update:modelValue', 'send', 'cancel'],
	setup() {
		const notify = useNotify();
		const envStore = useEnvStore();
		return { notify, envStore };
	},
	data() {
		return {
			inputMode: 'keyboard',
			inputFiles: [],
			// 桌面录音
			recorderStatus: 'IDLE',
			voiceRecorder: null,
			// 移动端语音
			touchSpeakOpen: false,
			touchSpeakTouchId: null,
			// 图片预览
			previewImgOpen: false,
			previewImgSrc: '',
			previewImgName: '',
		};
	},
	computed: {
		isTouchDevice() {
			// Capacitor 原生壳：直接判定为触屏设备
			if (this.envStore.isNative) return true;
			// 手机浏览器访问（含 iPadOS）：基于平台判断
			if (this.envStore.isAndroid || this.envStore.isIos) return true;
			// 其余均为桌面系统（Windows/Mac/Linux），即使有触屏也有物理键盘
			return false;
		},
		canSend() {
			const hasText = !!(this.modelValue && this.modelValue.trim());
			return hasText || this.inputFiles.length > 0;
		},
		isDesktopRecording() {
			return !this.isTouchDevice && (
				this.recorderStatus === 'RECORDING'
				|| this.recorderStatus === 'STARTING'
				|| this.recorderStatus === 'STOPPING'
			);
		},
	},
	mounted() {
		// 挂在根元素（footer）上监听 paste，避免 UTextarea 被 v-if 重建导致监听丢失
		this.$el.addEventListener('paste', this.__onPaste);
	},
	beforeUnmount() {
		this.$el.removeEventListener('paste', this.__onPaste);
		this.clearInputFiles();
		if (this.voiceRecorder) {
			this.voiceRecorder.destroy();
			this.voiceRecorder = null;
		}
	},
	methods: {
		onKeydown(evt) {
			if (evt.key !== 'Enter') return;
			// 触屏设备 Enter 默认换行
			if (this.isTouchDevice) return;
			// 桌面端 Shift+Enter 换行
			if (evt.shiftKey) return;
			// 桌面端 Enter 发送（阻止换行 + IME 组合）
			if (evt.isComposing) return;
			evt.preventDefault();
			this.onSubmit();
		},
		onSubmit() {
			if (!this.canSend || this.sending || this.disabled) return;
			this.$emit('send', {
				text: this.modelValue?.trim() || '',
				files: [...this.inputFiles],
			});
			// 不清除文件——文件留在 input 中，由上传过程逐个移除
		},

		// --- 文件上传 ---
		onClickAddFiles() {
			this.$refs.fileInput?.click();
		},
		onFilesSelected(evt) {
			const files = evt.target?.files;
			if (!files?.length) return;
			this.addFiles(Array.from(files));
			// 重置 input 以允许再次选择同一文件
			evt.target.value = '';
		},
		/** 外部（如拖拽）添加文件的公共入口 */
		addFiles(files) {
			if (!files?.length) return;
			for (const file of files) {
				if (file.size > MAX_UPLOAD_SIZE) {
					this.notify.error(this.$t('files.fileTooLarge', { name: file.name }));
					continue;
				}
				this.inputFiles.push(formatFileBlob(file));
			}
		},
		/** 粘贴事件：提取剪贴板中的文件，仅有文件时阻止默认行为 */
		__onPaste(e) {
			const items = e.clipboardData?.items;
			if (!items?.length) return;
			const files = [];
			for (const item of items) {
				if (item.kind === 'file') {
					const file = item.getAsFile();
					if (file) files.push(file);
				}
			}
			if (files.length > 0) {
				e.preventDefault();
				this.addFiles(files);
			}
		},
		removeInputFile(idx) {
			const removed = this.inputFiles.splice(idx, 1);
			if (removed[0]?.url) {
				URL.revokeObjectURL(removed[0].url);
			}
		},
		/** 按文件 id 移除（上传成功后由父组件调用） */
		removeFileById(id) {
			const idx = this.inputFiles.findIndex((f) => f.id === id);
			if (idx === -1) return;
			const [removed] = this.inputFiles.splice(idx, 1);
			if (removed?.url) URL.revokeObjectURL(removed.url);
		},
		clearInputFiles() {
			for (const f of this.inputFiles) {
				if (f.url) URL.revokeObjectURL(f.url);
			}
			this.inputFiles = [];
		},
		/** 恢复之前发送的文件（发送失败回退时由父组件调用） */
		restoreFiles(files) {
			if (!files?.length) return;
			for (const f of files) {
				const restored = { ...f };
				// 重建图片预览 URL（原 URL 可能已在 removeFileById 时释放）
				if (f.isImg && f.file) {
					restored.url = URL.createObjectURL(f.file);
				}
				this.inputFiles.push(restored);
			}
		},
		/** 查询文件上传状态 */
		__fileStatus(id) {
			return this.fileUploadState?.[id]?.status ?? null;
		},
		__filePercent(id) {
			return Math.round((this.fileUploadState?.[id]?.progress ?? 0) * 100);
		},

		// --- 桌面端语音录音 (Phase 3 实现) ---
		async onStartDesktopRecording() {
			try {
				// 先切换状态让波形容器 DOM 渲染出来（v-if="isDesktopRecording"）
				this.recorderStatus = 'STARTING';
				await this.$nextTick();

				const recorder = new VoiceRecorder({
					container: this.$refs.deskWaveContainer,
					maxDuration: MAX_RECORD_DURATION,
					onStatusChange: (status, data) => {
						this.recorderStatus = status;
						if (status === 'STOPPED' && data?.blob) {
							this.procRecordedVoice(data.blob, data.durationMs);
						}
						if (status === 'FAILED') {
							const errKey = {
								NotSupportedError: 'chat.voiceNotSupported',
								NotAllowedError: 'chat.voicePermDenied',
								NotFoundError: 'chat.voiceNoMic',
							}[data?.errName] || 'chat.voiceError';
							this.notify.error(this.$t(errKey));
						}
					},
				});
				this.voiceRecorder = recorder;
				await recorder.start();
			}
			catch {
				this.recorderStatus = 'IDLE';
				this.notify.error(this.$t('chat.voiceError'));
			}
		},
		onStopDesktopRecording() {
			this.voiceRecorder?.stop();
		},
		onCancelDesktopRecording() {
			this.voiceRecorder?.cancel();
			this.recorderStatus = 'IDLE';
		},
		procRecordedVoice(blob, durationMs) {
			const ext = (blob.type || '').includes('webm') ? 'webm'
				: (blob.type || '').includes('mp4') ? 'm4a'
					: (blob.type || '').includes('mpeg') ? 'mp3' : 'wav';
			const name = `voice_${Date.now()}.${ext}`;
			const file = new File([blob], name, { type: blob.type });
			const item = formatFileBlob(file);
			item.isVoice = true;
			item.durationMs = durationMs || null;
			this.inputFiles.push(item);
			this.recorderStatus = 'IDLE';
		},

		// --- 移动端语音 (Phase 4 实现) ---
		/** 文件名去除扩展名部分（扩展名单独渲染以防被截断） */
		fileBaseName(f) {
			if (!f.ext || !f.name) return f.name || '';
			const suffix = '.' + f.ext;
			return f.name.endsWith(suffix) ? f.name.slice(0, -suffix.length) : f.name;
		},
		voiceDisplayName(f) {
			if (f.durationMs) {
				const sec = Math.round(f.durationMs / 1000);
				return this.$t('chat.voiceLabelDuration', { duration: `${sec}″` });
			}
			return this.$t('chat.voiceLabel');
		},
		previewImg(f) {
			if (!f.url) return;
			this.previewImgSrc = f.url;
			this.previewImgName = f.name || 'image';
			this.previewImgOpen = true;
		},
		toggleInputMode() {
			this.inputMode = this.inputMode === 'keyboard' ? 'voice' : 'keyboard';
		},
		onTouchSpeakStart(evt) {
			if (this.sending || this.disabled) return;
			const touch = evt.changedTouches?.[0];
			this.touchSpeakTouchId = touch?.identifier ?? null;
			this.touchSpeakOpen = true;
		},
		onTouchSpeakClose(result) {
			this.touchSpeakOpen = false;
			if (result?.blob) {
				this.procRecordedVoice(result.blob, result.durationMs);
				if (result.autoSend) {
					this.$nextTick(() => this.onSubmit());
				}
			}
		},
	},
};
</script>
