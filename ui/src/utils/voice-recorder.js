import WaveSurfer from 'wavesurfer.js';
import RecordMod from 'wavesurfer.js/dist/plugins/record.esm.js';
import { queryMicPerm, hasMicDev, getPrefAudioType } from './media-helper.js';

const RecordPlugin = RecordMod.default || RecordMod;

const AUTH_HINT_DELAY = 2000;

// WaveSurfer 默认选项
const WS_DEFAULTS = {
	waveColor: 'rgb(200, 0, 200)',
	progressColor: 'rgba(100, 0, 100, 0)',
	height: 'auto',
	barWidth: 3,
	barHeight: 1.25,
	barGap: 2,
	barRadius: 3,
	minPxPerSec: 1,
	hideScrollbar: true,
};

/**
 * 状态机：IDLE → STARTING → RECORDING → STOPPING → STOPPED / CANCELED / FAILED
 */
export const RecorderStatus = Object.freeze({
	IDLE: 'IDLE',
	STARTING: 'STARTING',
	RECORDING: 'RECORDING',
	STOPPING: 'STOPPING',
	STOPPED: 'STOPPED',
	CANCELED: 'CANCELED',
	FAILED: 'FAILED',
});

const S = RecorderStatus;

/**
 * 基于 WaveSurfer 的语音录制器
 * @example
 * const recorder = new VoiceRecorder({
 *   container: domEl,
 *   onStatusChange(status, data) { ... },
 * });
 * await recorder.start();
 */
export class VoiceRecorder {
	/**
	 * @param {object} opts
	 * @param {HTMLElement} opts.container - 波形容器
	 * @param {number} [opts.maxDuration=60000] - 最大录音时长(ms)
	 * @param {string} [opts.waveColor] - 波形颜色
	 * @param {function} opts.onStatusChange - 状态回调 (status, data?)
	 */
	constructor(opts) {
		this.__opts = opts;
		this.__status = S.IDLE;
		this.__wavesurfer = null;
		this.__record = null;
		this.__startTime = null;
		this.__mimeType = null;
		this.__abortPending = false;
		this.__maxDuration = opts.maxDuration || 60000;
		this.__maxTimer = null;
	}

	get status() {
		return this.__status;
	}

	__setStatus(status, data) {
		this.__status = status;
		this.__opts.onStatusChange?.(status, data);
	}

	async start() {
		let hintTimer = null;

		// 检查浏览器是否支持
		if (typeof MediaRecorder === 'undefined') {
			return this.__fail('NotSupportedError');
		}

		// 检查麦克风权限
		try {
			const perm = await queryMicPerm();
			if (perm === 'denied') {
				return this.__fail('NotAllowedError');
			}
		}
		catch { /* ignore */ }

		try {
			this.__setStatus(S.STARTING);
			hintTimer = setTimeout(() => {
				this.__opts.onStatusChange?.('AUTH_HINT');
			}, AUTH_HINT_DELAY);

			this.__mimeType = getPrefAudioType();
			this.__wavesurfer = WaveSurfer.create({
				...WS_DEFAULTS,
				container: this.__opts.container,
				...(this.__opts.waveColor ? { waveColor: this.__opts.waveColor } : {}),
			});

			this.__record = this.__wavesurfer.registerPlugin(RecordPlugin.create({
				scrollingWaveform: false,
				renderRecordedAudio: false,
				mimeType: this.__mimeType,
			}));

			await this.__record.startRecording();
			this.__startTime = Date.now();

			// 用户在启动过程中请求了取消
			if (this.__abortPending) {
				this.__setStatus(S.RECORDING);
				return this.cancel();
			}

			this.__setStatus(S.RECORDING);

			// 最大录音时长定时器
			this.__maxTimer = setTimeout(() => {
				if (this.__status === S.RECORDING) {
					this.stop();
				}
			}, this.__maxDuration);
		}
		catch (err) {
			const msg = (err.message || '').toLowerCase();
			if (msg.includes('device') && msg.includes('not') && msg.includes('found')) {
				this.__fail('NotFoundError');
			}
			else if (msg.includes('permission') && (msg.includes('denied') || msg.includes('dismissed'))) {
				this.__fail('NotAllowedError');
			}
			else {
				// 回退检查是否有麦克风
				// Capacitor WebView 未授权前 enumerateDevices 可能返回空列表，不可靠
				const isCapacitor = window.Capacitor?.isNativePlatform();
				const hasMic = await hasMicDev();
				if (!isCapacitor && hasMic === false) {
					this.__fail('NotFoundError');
				}
				else {
					this.__fail('UnknownError');
				}
			}
		}
		finally {
			if (hintTimer) clearTimeout(hintTimer);
		}
	}

	stop() {
		if (this.__status !== S.RECORDING) return;
		this.__setStatus(S.STOPPING);
		this.__clearMaxTimer();

		this.__record.once('record-end', (blob) => {
			const durationMs = this.__startTime ? (Date.now() - this.__startTime) : 0;
			// 重建 blob 以确保 type 干净
			const cleanBlob = new Blob([blob], { type: this.__mimeType || blob.type });
			this.__setStatus(S.STOPPED, { blob: cleanBlob, durationMs });
			setTimeout(() => this.destroy(), 0);
		});
		this.__record.stopRecording();
	}

	cancel() {
		if (this.__status === S.RECORDING) {
			this.__clearMaxTimer();
			this.__record?.stopRecording();
			this.__setStatus(S.CANCELED);
			this.destroy();
		}
		else if (this.__status === S.STARTING) {
			this.__abortPending = true;
		}
		else {
			this.destroy();
		}
	}

	destroy() {
		this.__clearMaxTimer();
		if (this.__record) {
			this.__record.destroy();
			this.__record = null;
		}
		if (this.__wavesurfer) {
			this.__wavesurfer.destroy();
			this.__wavesurfer = null;
		}
	}

	__fail(errName) {
		if (this.__record?.isRecording?.()) {
			this.__record.stopRecording();
		}
		this.__setStatus(S.FAILED, { errName });
		this.destroy();
	}

	__clearMaxTimer() {
		if (this.__maxTimer) {
			clearTimeout(this.__maxTimer);
			this.__maxTimer = null;
		}
	}
}
