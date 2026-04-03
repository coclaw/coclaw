<template>
	<footer class="sticky bottom-0 z-10 border-t border-default bg-default py-3">
		<slot name="prepend" />
		<!-- 上传进度区（上传中替代文件预览） -->
		<div
			v-if="uploadProgress"
			class="mx-auto mb-2 flex w-full max-w-3xl flex-wrap gap-2 px-3"
		>
			<div
				v-for="(uf, idx) in uploadProgress.files"
				:key="'up-' + idx"
				class="relative flex h-16 items-center gap-2 rounded-md border border-default px-3"
				:class="uf.status === 'done' ? 'bg-elevated' : 'bg-elevated/60'"
			>
				<UIcon
					:name="uf.status === 'done' ? 'i-lucide-check-circle' : uf.status === 'failed' ? 'i-lucide-x-circle' : 'i-lucide-file'"
					class="text-lg shrink-0"
					:class="uf.status === 'done' ? 'text-success' : uf.status === 'failed' ? 'text-error' : 'text-muted'"
				/>
				<div class="max-w-24 text-xs">
					<div class="truncate font-medium">{{ uf.name }}</div>
					<div class="text-muted">
						<template v-if="uf.status === 'uploading'">{{ Math.round((uf.progress ?? 0) * 100) }}%</template>
						<template v-else-if="uf.status === 'done'">{{ $t('common.done') }}</template>
						<template v-else-if="uf.status === 'failed'">{{ $t('common.failed') }}</template>
						<template v-else>{{ $t('common.pending') }}</template>
					</div>
				</div>
			</div>
		</div>
		<!-- 文件预览区（未上传时） -->
		<div
			v-else-if="inputFiles.length"
			class="mx-auto mb-2 flex w-full max-w-3xl flex-wrap gap-2 px-3"
		>
			<div
				v-for="(f, idx) in inputFiles"
				:key="f.id"
				class="group relative"
			>
				<!-- 图片缩略图 -->
				<img
					v-if="f.isImg"
					:src="f.url"
					:alt="f.name"
					class="h-16 w-16 rounded-md border border-default object-cover"
				/>
				<!-- 语音文件卡片 -->
				<div v-else-if="f.isVoice" class="flex h-16 items-center gap-2 rounded-md border border-default bg-elevated px-3">
					<UIcon name="i-lucide-mic" class="text-lg text-muted" />
					<div class="max-w-24 text-xs">
						<div class="truncate font-medium">{{ voiceDisplayName(f) }}</div>
						<div class="text-muted">{{ f.label }}</div>
					</div>
				</div>
				<!-- 非图片文件卡片 -->
				<div v-else class="flex h-16 items-center gap-2 rounded-md border border-default bg-elevated px-3">
					<UIcon name="i-lucide-file" class="text-lg text-muted" />
					<div class="max-w-24 text-xs">
						<div class="truncate font-medium">{{ f.name }}</div>
						<div class="text-muted">{{ f.label }}</div>
					</div>
				</div>
				<!-- 移除按钮 -->
				<button
					:class="[
						'absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full',
						'bg-error text-white text-xs',
						this.envStore.canHover ? 'opacity-0 group-hover:opacity-100' : '',
					]"
					@click="removeInputFile(idx)"
				>
					<UIcon name="i-lucide-x" class="text-xs" />
				</button>
			</div>
		</div>

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
import { VoiceRecorder, MAX_RECORD_DURATION } from '../utils/voice-recorder.js';
import TouchSpeakOverlay from './TouchSpeakOverlay.vue';

export default {
	name: 'ChatInput',
	components: {
		TouchSpeakOverlay,
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
		uploadProgress: {
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
	beforeUnmount() {
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
			this.clearInputFiles();
		},

		// --- 文件上传 ---
		onClickAddFiles() {
			this.$refs.fileInput?.click();
		},
		onFilesSelected(evt) {
			const files = evt.target?.files;
			if (!files?.length) return;
			for (const file of files) {
				this.inputFiles.push(formatFileBlob(file));
			}
			// 重置 input 以允许再次选择同一文件
			evt.target.value = '';
		},
		removeInputFile(idx) {
			const removed = this.inputFiles.splice(idx, 1);
			if (removed[0]?.url) {
				URL.revokeObjectURL(removed[0].url);
			}
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
				// 重建图片预览 URL（原 URL 已在 onSubmit 时释放）
				if (f.isImg && f.file) {
					restored.url = URL.createObjectURL(f.file);
				}
				this.inputFiles.push(restored);
			}
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
		voiceDisplayName(f) {
			if (f.durationMs) {
				const sec = Math.round(f.durationMs / 1000);
				return this.$t('chat.voiceLabelDuration', { duration: `${sec}″` });
			}
			return this.$t('chat.voiceLabel');
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
