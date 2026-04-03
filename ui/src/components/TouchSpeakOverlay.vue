<template>
	<div
		v-if="open"
		class="fixed inset-0 z-50 flex select-none flex-col pt-[var(--safe-area-inset-top)] pb-[var(--safe-area-inset-bottom)]"
		@contextmenu.prevent
		@touchmove.prevent
	>
		<!-- 上半区：信息面板 -->
		<div class="flex-1" />

		<div
			class="mx-auto flex w-[70%] max-w-64 flex-col items-center gap-2 rounded-xl p-4 text-sm transition-colors"
			:class="withinTouchZone ? 'bg-success/80' : 'bg-error/80'"
		>
			<!-- 波形容器 -->
			<div ref="waveContainer" class="h-12 w-32" />

			<!-- 授权提示 -->
			<div v-if="shouldHintAuth" class="text-white/85">
				{{ $t('chat.voiceAuthHint') }}
			</div>

			<!-- 状态提示 -->
			<template v-if="isRecording">
				<div v-if="touchId == null && !isClosing" class="text-white/85 font-medium">
					{{ $t('chat.voiceHoldToSpeak') }}
				</div>
				<div v-else-if="!withinTouchZone" class="text-white/85 font-medium">
					{{ $t('chat.voiceCancel') }}
				</div>
				<div v-else-if="withinTouchPadding" class="text-white/85">
					{{ $t('chat.voiceReleaseEnd') }}
				</div>
				<div v-else class="text-white/85">
					{{ $t('chat.voiceRelease') }}
				</div>
			</template>

			<!-- 倒计时 -->
			<div v-if="showCountdown" class="text-white/85">
				{{ $t('chat.maxRecordCountdown', { s: countdown }) }}
			</div>
		</div>

		<div class="flex-1" />

		<!-- 下半区：触控区 -->
		<div
			ref="touchZone"
			class="flex h-28 items-center justify-center rounded-t-2xl transition-opacity"
			:class="[
				withinTouchZone ? 'opacity-80' : 'opacity-50',
				'bg-elevated',
			]"
		>
			<UIcon name="i-lucide-radio" class="text-4xl text-muted" />
		</div>
	</div>
</template>

<script>
import WaveSurfer from 'wavesurfer.js';
import RecordMod from 'wavesurfer.js/dist/plugins/record.esm.js';
import { queryMicPerm, getPrefAudioType } from '../utils/media-helper.js';
import { MAX_RECORD_DURATION } from '../utils/voice-recorder.js';
import { useNotify } from '../composables/use-notify.js';

const RecordPlugin = RecordMod.default || RecordMod;

const AUTH_HINT_DELAY = 2000;
const MIN_DURATION = 300;
const TOUCH_ZONE_PX = 16;
const TOUCH_ZONE_PB = 16;
const WARN_THRESHOLD = 10;

export default {
	name: 'TouchSpeakOverlay',
	props: {
		open: { type: Boolean, default: false },
		initTouchId: { type: Number, default: null },
		maxDuration: { type: Number, default: MAX_RECORD_DURATION },
	},
	emits: ['update:open', 'close'],
	setup() {
		const notify = useNotify();
		return { notify };
	},
	data() {
		return {
			touchId: this.initTouchId,
			withinTouchZone: true,
			withinTouchPadding: false,
			countdown: 0,
			isRecording: false,
			isStarting: false,
			isStopping: false,
			isClosing: false,
			shouldHintAuth: false,
			startTime: null,
			recordingTimer: null,
			countdownTimer: null,
			// WaveSurfer 实例（不放 reactive）
			wavesurfer: null,
			record: null,
			mimeType: null,
		};
	},
	computed: {
		showCountdown() {
			return this.isRecording && this.countdown <= WARN_THRESHOLD;
		},
	},
	created() {
		window.addEventListener('touchmove', this.onTouchMove);
		window.addEventListener('touchend', this.onTouchEnd);
		window.addEventListener('touchstart', this.onTouchStart);
	},
	mounted() {
		this.startRecording();
	},
	beforeUnmount() {
		this.clearTimers();
		this.removeListeners();
		if (this.record) {
			this.record.destroy();
			this.record = null;
		}
		if (this.wavesurfer) {
			this.wavesurfer.destroy();
			this.wavesurfer = null;
		}
	},
	methods: {
		async startRecording() {
			let hintTimer = null;

			if (typeof MediaRecorder === 'undefined') {
				this.notify.error(this.$t('chat.voiceNotSupported'));
				return this.closeAborted();
			}

			try {
				const perm = await queryMicPerm();
				if (perm === 'denied') {
					this.notify.error(this.$t('chat.voicePermDenied'));
					return this.closeAborted();
				}
			}
			catch { /* ignore */ }

			if (this.touchId == null) {
				return this.closeAborted();
			}

			try {
				this.isStarting = true;
				hintTimer = setTimeout(() => {
					this.shouldHintAuth = true;
				}, AUTH_HINT_DELAY);

				this.mimeType = getPrefAudioType();

				this.wavesurfer = WaveSurfer.create({
					container: this.$refs.waveContainer,
					waveColor: 'rgba(255,255,255,0.85)',
					progressColor: 'rgba(100, 0, 100, 0)',
					height: 'auto',
					barWidth: 3,
					barHeight: 1.5,
					barGap: 2,
					barRadius: 3,
					minPxPerSec: 1,
					hideScrollbar: true,
				});

				this.record = this.wavesurfer.registerPlugin(RecordPlugin.create({
					scrollingWaveform: false,
					renderRecordedAudio: false,
					mimeType: this.mimeType,
				}));

				await this.record.startRecording();
				this.startTime = Date.now();
				this.isRecording = true;

				if (this.touchId == null) {
					return this.stopRecording(true);
				}

				const maxSec = Math.round(this.maxDuration / 1000);
				this.countdown = maxSec;
				this.recordingTimer = setTimeout(() => this.onRecordTimeout(), this.maxDuration);
				this.countdownTimer = setInterval(() => this.updateCountdown(), 1000);
			}
			catch (err) {
				console.warn('[TouchSpeakOverlay] startRecording failed:', err);
				const msg = (err.message || '').toLowerCase();
				if (msg.includes('device') && msg.includes('not') && msg.includes('found')) {
					this.notify.error(this.$t('chat.voiceNoMic'));
				}
				else if (msg.includes('permission') && (msg.includes('denied') || msg.includes('dismissed'))) {
					this.notify.error(this.$t('chat.voicePermDenied'));
				}
				else {
					this.notify.error(this.$t('chat.voiceError'));
				}

				if (this.record?.isRecording?.()) {
					this.stopRecording(true);
				}
				else {
					// 清理半初始化的实例，避免资源泄漏
					if (this.record) { this.record.destroy(); this.record = null; }
					if (this.wavesurfer) { this.wavesurfer.destroy(); this.wavesurfer = null; }
					this.closeAborted();
				}
			}
			finally {
				this.isStarting = false;
				this.shouldHintAuth = false;
				if (hintTimer) clearTimeout(hintTimer);
			}
		},

		stopRecording(isAborted) {
			this.clearTimers();
			this.removeListeners();
			this.isClosing = true;

			if (!this.isRecording || !this.record) {
				return this.closeAborted();
			}

			this.isStopping = true;
			this.record.once('record-end', (blob) => {
				this.isStopping = false;

				if (isAborted) {
					this.closeAborted();
					return;
				}

				const durationMs = this.startTime ? (Date.now() - this.startTime) : 0;
				if (durationMs < MIN_DURATION || !blob?.size) {
					this.notify.warning(this.$t('chat.voiceTooShort'));
					this.closeAborted();
					return;
				}

				const cleanBlob = new Blob([blob], { type: this.mimeType || blob.type });
				const autoSend = !this.withinTouchPadding;
				this.$emit('close', { blob: cleanBlob, durationMs, autoSend });
				this.$emit('update:open', false);
			});
			this.record.stopRecording();
		},

		closeAborted() {
			this.$emit('close', null);
			this.$emit('update:open', false);
		},

		onRecordTimeout() {
			if (this.isRecording && !this.isStopping) {
				this.stopRecording(false);
			}
		},

		// --- Touch 事件 ---
		onTouchStart(evt) {
			if (this.touchId != null) {
				// 检查当前 touch 是否还存在
				if (this.findTouch(evt.touches, this.touchId)) {
					if (this.touchId === evt.changedTouches[0]?.identifier) {
						this.updateTouchPos(evt.changedTouches[0]);
					}
					return;
				}
				this.touchId = null;
			}

			if (this.isStopping) return;
			const touch = evt.changedTouches[0];
			this.touchId = touch.identifier;
			this.updateTouchPos(touch);
		},

		onTouchEnd(evt) {
			if (this.touchId == null) return;
			const touch = this.findTouch(evt.changedTouches, this.touchId);
			if (!touch) return;

			this.updateTouchPos(touch);
			this.touchId = null;

			if (this.isRecording && !this.isStopping) {
				this.stopRecording(!this.withinTouchZone);
			}
		},

		onTouchMove(evt) {
			if (this.touchId == null) return;
			const touch = this.findTouch(evt.changedTouches, this.touchId);
			if (!touch) return;
			this.updateTouchPos(touch);
		},

		updateTouchPos({ clientX, clientY }) {
			const el = this.$refs.touchZone;
			if (!el) return;

			const rect = el.getBoundingClientRect();
			this.withinTouchZone = (
				clientX >= rect.left && clientX <= rect.right
				&& clientY >= rect.top && clientY <= rect.bottom
			);

			this.withinTouchPadding = this.withinTouchZone && !(
				clientX >= rect.left + TOUCH_ZONE_PX
				&& clientX <= rect.right - TOUCH_ZONE_PX
				&& clientY >= rect.top
				&& clientY <= rect.bottom - TOUCH_ZONE_PB
			);
		},

		findTouch(touchList, id) {
			for (let i = 0; i < touchList.length; i++) {
				if (touchList[i].identifier === id) return touchList[i];
			}
			return null;
		},

		updateCountdown() {
			if (this.countdown > 0) {
				this.countdown--;
			}
		},

		clearTimers() {
			if (this.recordingTimer) {
				clearTimeout(this.recordingTimer);
				this.recordingTimer = null;
			}
			if (this.countdownTimer) {
				clearInterval(this.countdownTimer);
				this.countdownTimer = null;
			}
		},

		removeListeners() {
			window.removeEventListener('touchmove', this.onTouchMove);
			window.removeEventListener('touchend', this.onTouchEnd);
			window.removeEventListener('touchstart', this.onTouchStart);
		},
	},
};
</script>
