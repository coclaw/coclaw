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
		<template v-if="loading">
			<UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-dimmed" />
		</template>
		<template v-else>
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
		</template>
	</div>
</template>

<script>
import SoundWave from './SoundWave.vue';
import { isCoclawUrl, fetchCoclawFile } from '../services/coclaw-file.js';
import { useNotify } from '../composables/use-notify.js';

const MAX_DURATION = 60;
const MAX_BAR_PX = 40;

export default {
	name: 'ChatAudio',
	components: { SoundWave },
	props: {
		/**
		 * 音频来源。支持两种格式：
		 * - blob URL / http URL → 直接播放
		 * - coclaw-file://botId:agentId/path → 按需下载后播放
		 */
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
	setup() {
		return { notify: useNotify() };
	},
	data() {
		return {
			audio: null,
			playing: false,
			started: false,
			loading: false,
			// coclaw-file URL 下载后缓存的 blob URL，避免重复下载
			resolvedUrl: null,
			// 正在进行的下载 promise（防止重复下载）
			__downloadPromise: null,
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
			this.__cleanup();
			this.__revokeResolved();
		},
	},
	beforeUnmount() {
		this.__cleanup();
		this.__revokeResolved();
	},
	methods: {
		/**
		 * 获取可直接播放的 URL。
		 * - blob/http URL 直接返回
		 * - coclaw-file URL 按需下载，返回 blob URL 并缓存
		 */
		async __resolveUrl() {
			if (this.resolvedUrl) return this.resolvedUrl;
			if (!this.src) return null;
			if (!isCoclawUrl(this.src)) return this.src;

			// 已有下载在进行中，复用同一 promise
			if (this.__downloadPromise) return this.__downloadPromise;

			const srcAtStart = this.src;
			this.loading = true;
			this.__downloadPromise = fetchCoclawFile(srcAtStart)
				.then((blob) => {
					// src 在下载期间已变更，丢弃结果
					if (this.src !== srcAtStart) return null;
					this.resolvedUrl = URL.createObjectURL(blob);
					return this.resolvedUrl;
				})
				.finally(() => {
					this.__downloadPromise = null;
					this.loading = false;
				});

			return this.__downloadPromise;
		},

		__ensureAudio(url) {
			if (this.audio) return this.audio;
			if (!url) return null;
			const el = new Audio(url);
			el.addEventListener('ended', this.__onEnded);
			el.addEventListener('pause', this.__onPause);
			el.addEventListener('play', this.__onPlay);
			el.addEventListener('error', this.__onError);
			this.audio = el;
			return el;
		},

		__cleanup() {
			this.__downloadPromise = null;
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

		__revokeResolved() {
			if (this.resolvedUrl) {
				URL.revokeObjectURL(this.resolvedUrl);
				this.resolvedUrl = null;
			}
		},

		async playOrResume() {
			if (this.loading) return;
			try {
				const url = await this.__resolveUrl();
				if (!url) return;
				const el = this.__ensureAudio(url);
				if (!el) return;
				await el.play();
			} catch (err) {
				console.warn('[ChatAudio] play failed:', err);
				this.loading = false;
				this.notify.error(this.$t('chat.audioPlayFailed'));
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
