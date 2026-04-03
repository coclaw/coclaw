<template>
	<div class="inline-flex items-center gap-2 rounded-xl border border-default bg-elevated py-2 pl-3 pr-2 text-sm text-muted">
		<!-- 波形/图标 -->
		<SoundWave v-if="playing" :playing="true" size="sm" class="w-6 text-success" />
		<UIcon v-else name="i-lucide-audio-waveform" class="size-5 shrink-0" />

		<!-- 时长 -->
		<span v-if="durationLabel" class="whitespace-nowrap">{{ durationLabel }}</span>

		<!-- 时长比例填充条 -->
		<span :style="barStyle" />

		<!-- 控制按钮 -->
		<UButton
			v-if="playing"
			class="cc-icon-btn"
			icon="i-lucide-pause"
			variant="ghost"
			color="neutral"
			size="md"
			:title="$t('chat.audioPause')"
			@click="pause"
		/>
		<UButton
			v-else
			class="cc-icon-btn"
			icon="i-lucide-play"
			variant="ghost"
			color="neutral"
			size="md"
			:disabled="!src"
			:title="$t('chat.audioPlay')"
			@click="playOrResume"
		/>
		<UButton
			v-if="started"
			class="cc-icon-btn"
			icon="i-lucide-square"
			variant="ghost"
			color="neutral"
			size="md"
			:title="$t('chat.audioStop')"
			@click="stop"
		/>
	</div>
</template>

<script>
import SoundWave from './SoundWave.vue';

const MAX_DURATION = 60;
const MAX_BAR_PX = 40;

export default {
	name: 'ChatAudio',
	components: { SoundWave },
	props: {
		/** 音频文件 URL（blob URL 或 http URL） */
		src: {
			type: String,
			default: null,
		},
		/** 时长（毫秒） */
		durationMs: {
			type: Number,
			default: null,
		},
	},
	data() {
		return {
			audio: null,
			playing: false,
			started: false, // 已开始播放（含暂停状态）
		};
	},
	computed: {
		durationSec() {
			if (!this.durationMs || this.durationMs <= 0) return null;
			return Math.round(this.durationMs / 1000);
		},
		durationLabel() {
			return this.durationSec ? `${this.durationSec}″` : '';
		},
		barStyle() {
			if (!this.durationSec) return {};
			const w = Math.min((this.durationSec / MAX_DURATION) * MAX_BAR_PX, MAX_BAR_PX);
			return { width: `${w}px` };
		},
	},
	watch: {
		src() {
			// src 变更时丢弃旧的 Audio 实例，下次播放时重建
			this.__cleanup();
		},
	},
	beforeUnmount() {
		this.__cleanup();
	},
	methods: {
		__ensureAudio() {
			if (this.audio) return this.audio;
			if (!this.src) return null;
			const el = new Audio(this.src);
			el.addEventListener('ended', this.__onEnded);
			el.addEventListener('pause', this.__onPause);
			el.addEventListener('play', this.__onPlay);
			el.addEventListener('error', this.__onError);
			this.audio = el;
			return el;
		},
		__cleanup() {
			if (!this.audio) return;
			this.audio.pause();
			this.audio.removeEventListener('ended', this.__onEnded);
			this.audio.removeEventListener('pause', this.__onPause);
			this.audio.removeEventListener('play', this.__onPlay);
			this.audio.removeEventListener('error', this.__onError);
			this.audio = null;
			this.playing = false;
			this.started = false;
		},
		async playOrResume() {
			const el = this.__ensureAudio();
			if (!el) return;
			try {
				await el.play();
			} catch (err) {
				console.warn('[ChatAudio] play failed:', err);
			}
		},
		pause() {
			this.audio?.pause();
		},
		stop() {
			if (!this.audio) return;
			this.audio.pause();
			this.audio.currentTime = 0;
			this.playing = false;
			this.started = false;
		},
		__onPlay() {
			this.playing = true;
			this.started = true;
		},
		__onPause() {
			this.playing = false;
		},
		__onEnded() {
			this.playing = false;
			this.started = false;
		},
		__onError(evt) {
			console.warn('[ChatAudio] audio error:', evt);
			this.playing = false;
			this.started = false;
		},
	},
};
</script>
