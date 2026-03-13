<template>
	<footer class="sticky bottom-0 z-10 border-t border-default bg-default px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:px-8 md:py-3">
		<!-- 文件预览区 -->
		<div
			v-if="inputFiles.length"
			class="mx-auto mb-2 flex w-full max-w-3xl flex-wrap gap-2"
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
						isMobile ? '' : 'opacity-0 group-hover:opacity-100',
					]"
					@click="removeInputFile(idx)"
				>
					<UIcon name="i-lucide-x" class="text-xs" />
				</button>
			</div>
		</div>

		<form
			class="mx-auto flex w-full max-w-3xl items-end gap-2"
			@submit.prevent="onSubmit"
		>
			<!-- 左侧按钮区 -->
			<div class="flex shrink-0 items-end gap-1 pb-1">
				<!-- 移动端：键盘/语音切换 -->
				<UButton
					v-if="isMobile"
					class="cc-icon-btn md:hidden"
					:icon="inputMode === 'keyboard' ? 'i-lucide-mic' : 'i-lucide-keyboard'"
					variant="ghost"
					color="primary"
					size="md"
					@click="toggleInputMode"
				/>
				<!-- 文件上传按钮 -->
				<UButton
					v-if="inputMode === 'keyboard'"
					data-testid="btn-attach"
					class="cc-icon-btn"
					icon="i-lucide-plus"
					variant="ghost"
					color="primary"
					size="md"
					@click="onClickAddFiles"
				/>
				<!-- 桌面端麦克风按钮 -->
				<UButton
					v-if="!isMobile && inputMode === 'keyboard' && !isDesktopRecording"
					class="cc-icon-btn hidden md:flex"
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
						class="cc-icon-btn"
						icon="i-lucide-x"
						variant="ghost"
						color="error"
						size="md"
						@click="onCancelDesktopRecording"
					/>
					<UButton
						class="cc-icon-btn"
						icon="i-lucide-check"
						variant="soft"
						color="success"
						size="md"
						@click="onStopDesktopRecording"
					/>
				</div>
				<!-- 移动端语音模式：按住说话 -->
				<button
					v-else-if="isMobile && inputMode === 'voice'"
					class="flex h-10 w-full items-center justify-center rounded-lg bg-elevated text-sm text-muted md:hidden"
					@touchstart.prevent="onTouchSpeakStart"
				>
					{{ $t('chat.voiceHoldToSpeak') }}
				</button>
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
			<div class="flex shrink-0 items-end pb-1">
				<UButton
					v-if="sending"
					data-testid="btn-stop"
					class="cc-icon-btn"
					icon="i-lucide-square"
					color="error"
					variant="soft"
					size="md"
					:title="$t('chat.stopSending')"
					@click="$emit('cancel')"
				/>
				<UButton
					v-else
					data-testid="btn-send"
					class="cc-icon-btn"
					icon="i-lucide-send"
					color="primary"
					variant="soft"
					size="md"
					:disabled="!canSend"
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
import { isMobileViewport } from '../utils/layout.js';
import { useUiStore } from '../stores/ui.store.js';
import { useNotify } from '../composables/use-notify.js';
import { formatFileSize, formatFileBlob } from '../utils/file-helper.js';
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
		disabled: {
			type: Boolean,
			default: false,
		},
	},
	emits: ['update:modelValue', 'send', 'cancel'],
	setup() {
		const notify = useNotify();
		return { notify };
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
		isMobile() {
			return isMobileViewport(useUiStore().screenWidth);
		},
		canSend() {
			const hasText = !!(this.modelValue && this.modelValue.trim());
			return hasText || this.inputFiles.length > 0;
		},
		isDesktopRecording() {
			return !this.isMobile && (
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
			// 移动端 Enter 默认换行
			if (this.isMobile) return;
			// 桌面端 Shift+Enter 换行
			if (evt.shiftKey) return;
			// 桌面端 Enter 发送（阻止换行 + IME 组合）
			if (evt.isComposing) return;
			evt.preventDefault();
			this.onSubmit();
		},
		onSubmit() {
			if (!this.canSend || this.sending) return;
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

				const { VoiceRecorder } = await import('../utils/voice-recorder.js');
				const recorder = new VoiceRecorder({
					container: this.$refs.deskWaveContainer,
					maxDuration: 60000,
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
			this.inputFiles.push(item);
			this.recorderStatus = 'IDLE';
		},

		// --- 移动端语音 (Phase 4 实现) ---
		toggleInputMode() {
			this.inputMode = this.inputMode === 'keyboard' ? 'voice' : 'keyboard';
		},
		onTouchSpeakStart(evt) {
			const touch = evt.changedTouches?.[0];
			this.touchSpeakTouchId = touch?.identifier ?? null;
			this.touchSpeakOpen = true;
		},
		onTouchSpeakClose(result) {
			this.touchSpeakOpen = false;
			if (result?.blob) {
				this.procRecordedVoice(result.blob, result.durationMs);
			}
		},
	},
};
</script>
