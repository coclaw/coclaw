import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// mock 媒体检测函数
vi.mock('./media-helper.js', () => ({
	queryMicPerm: vi.fn().mockResolvedValue('granted'),
	hasMicDev: vi.fn().mockResolvedValue(true),
	getPrefAudioType: vi.fn().mockReturnValue('audio/webm'),
}));

// mock wavesurfer 动态导入
const mockStopRecording = vi.fn();
const mockStartRecording = vi.fn().mockResolvedValue(undefined);
const mockIsRecording = vi.fn().mockReturnValue(false);
const mockRecordDestroy = vi.fn();
const mockRecordOnce = vi.fn();

const mockRegisterPlugin = vi.fn().mockReturnValue({
	startRecording: mockStartRecording,
	stopRecording: mockStopRecording,
	isRecording: mockIsRecording,
	destroy: mockRecordDestroy,
	once: mockRecordOnce,
});

const mockWsDestroy = vi.fn();
const mockWsCreate = vi.fn().mockReturnValue({
	registerPlugin: mockRegisterPlugin,
	destroy: mockWsDestroy,
});

vi.mock('wavesurfer.js', () => ({
	default: { create: mockWsCreate },
}));

vi.mock('wavesurfer.js/dist/plugins/record.esm.js', () => ({
	default: { create: vi.fn((opts) => opts) },
}));

// 提供 MediaRecorder
beforeEach(() => {
	globalThis.MediaRecorder = {
		isTypeSupported: vi.fn(() => true),
	};
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('VoiceRecorder', () => {
	test('initial status is IDLE', async () => {
		const { VoiceRecorder } = await import('./voice-recorder.js');
		const recorder = new VoiceRecorder({
			container: document.createElement('div'),
			onStatusChange: vi.fn(),
		});
		expect(recorder.status).toBe('IDLE');
	});

	test('start transitions IDLE → STARTING → RECORDING', async () => {
		const { VoiceRecorder } = await import('./voice-recorder.js');
		const statuses = [];
		const recorder = new VoiceRecorder({
			container: document.createElement('div'),
			onStatusChange: (s) => statuses.push(s),
		});

		await recorder.start();
		expect(statuses).toContain('STARTING');
		expect(statuses).toContain('RECORDING');
		expect(recorder.status).toBe('RECORDING');
		recorder.destroy();
	});

	test('cancel during RECORDING transitions to CANCELED', async () => {
		const { VoiceRecorder } = await import('./voice-recorder.js');
		const statuses = [];
		const recorder = new VoiceRecorder({
			container: document.createElement('div'),
			onStatusChange: (s) => statuses.push(s),
		});

		await recorder.start();
		recorder.cancel();
		expect(statuses).toContain('CANCELED');
		expect(mockStopRecording).toHaveBeenCalled();
	});

	test('stop during RECORDING transitions to STOPPING', async () => {
		const { VoiceRecorder } = await import('./voice-recorder.js');
		const statuses = [];
		const recorder = new VoiceRecorder({
			container: document.createElement('div'),
			onStatusChange: (s) => statuses.push(s),
		});

		await recorder.start();
		recorder.stop();
		expect(statuses).toContain('STOPPING');
		expect(mockRecordOnce).toHaveBeenCalledWith('record-end', expect.any(Function));
	});

	test('stop calls onStatusChange with STOPPED and blob data', async () => {
		vi.useFakeTimers();
		const { VoiceRecorder } = await import('./voice-recorder.js');
		const statusData = [];
		const recorder = new VoiceRecorder({
			container: document.createElement('div'),
			onStatusChange: (s, d) => statusData.push({ s, d }),
		});

		await recorder.start();

		// 模拟 record-end 回调
		mockRecordOnce.mockImplementation((evt, cb) => {
			const fakeBlob = new Blob(['audio'], { type: 'audio/webm' });
			cb(fakeBlob);
		});

		recorder.stop();
		vi.runAllTimers();

		const stopped = statusData.find((x) => x.s === 'STOPPED');
		expect(stopped).toBeTruthy();
		expect(stopped.d.blob).toBeInstanceOf(Blob);
		expect(typeof stopped.d.durationMs).toBe('number');
		vi.useRealTimers();
	});

	test('fails with FAILED when MediaRecorder is undefined', async () => {
		globalThis.MediaRecorder = undefined;
		const { VoiceRecorder } = await import('./voice-recorder.js');
		const statuses = [];
		const recorder = new VoiceRecorder({
			container: document.createElement('div'),
			onStatusChange: (s) => statuses.push(s),
		});

		await recorder.start();
		expect(statuses).toContain('FAILED');
	});

	test('fails when mic permission is denied', async () => {
		const { queryMicPerm } = await import('./media-helper.js');
		queryMicPerm.mockResolvedValueOnce('denied');

		const { VoiceRecorder } = await import('./voice-recorder.js');
		const statuses = [];
		const recorder = new VoiceRecorder({
			container: document.createElement('div'),
			onStatusChange: (s) => statuses.push(s),
		});

		await recorder.start();
		expect(statuses).toContain('FAILED');
	});

	test('start logs warning and triggers FAILED when WaveSurfer.create throws', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const err = new Error('device not found in system');
		mockWsCreate.mockImplementationOnce(() => { throw err; });

		const { VoiceRecorder } = await import('./voice-recorder.js');
		const statuses = [];
		const recorder = new VoiceRecorder({
			container: document.createElement('div'),
			onStatusChange: (s, d) => statuses.push({ s, d }),
		});

		await recorder.start();
		expect(warnSpy).toHaveBeenCalledWith('[VoiceRecorder] start failed:', err);
		expect(statuses.find(x => x.s === 'FAILED')).toBeTruthy();
		warnSpy.mockRestore();
	});

	test('start logs warning on permission denied error from startRecording', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const err = new Error('permission denied by user dismissed');
		mockStartRecording.mockRejectedValueOnce(err);

		const { VoiceRecorder } = await import('./voice-recorder.js');
		const statuses = [];
		const recorder = new VoiceRecorder({
			container: document.createElement('div'),
			onStatusChange: (s, d) => statuses.push({ s, d }),
		});

		await recorder.start();
		expect(warnSpy).toHaveBeenCalledWith('[VoiceRecorder] start failed:', err);
		const failed = statuses.find(x => x.s === 'FAILED');
		expect(failed).toBeTruthy();
		expect(failed.d.errName).toBe('NotAllowedError');
		warnSpy.mockRestore();
	});

	test('destroy cleans up wavesurfer and record', async () => {
		const { VoiceRecorder } = await import('./voice-recorder.js');
		const recorder = new VoiceRecorder({
			container: document.createElement('div'),
			onStatusChange: vi.fn(),
		});

		await recorder.start();
		recorder.destroy();
		expect(mockRecordDestroy).toHaveBeenCalled();
		expect(mockWsDestroy).toHaveBeenCalled();
	});

	test('cancel 在 IDLE/STOPPED 等非 RECORDING 非 STARTING 状态下直接 destroy', async () => {
		const { VoiceRecorder } = await import('./voice-recorder.js');
		const statuses = [];
		const recorder = new VoiceRecorder({
			container: document.createElement('div'),
			onStatusChange: (s) => statuses.push(s),
		});

		// 此时 status 为 IDLE，cancel 应走 else 分支，仅 destroy
		recorder.cancel();
		// 不应变为 CANCELED，因为不是 RECORDING 状态
		expect(statuses).not.toContain('CANCELED');
	});

	test('cancel 在 STARTING 状态下设置 abortPending', async () => {
		const { VoiceRecorder } = await import('./voice-recorder.js');
		// 让 startRecording 挂起，使 status 停留在 STARTING
		let resolveStart;
		const pendingPromise = new Promise((r) => { resolveStart = r; });
		mockStartRecording.mockImplementationOnce(() => pendingPromise);

		const statuses = [];
		const recorder = new VoiceRecorder({
			container: document.createElement('div'),
			onStatusChange: (s) => statuses.push(s),
		});

		const startPromise = recorder.start();
		// 等一个微任务，确保已进入 STARTING 且 startRecording 被调用
		await new Promise((r) => setTimeout(r, 10));
		// 此时处于 STARTING
		recorder.cancel();
		// 让 startRecording resolve 以完成 start 流程
		resolveStart();
		await startPromise;
		// abortPending 生效，最终转为 CANCELED
		expect(statuses).toContain('CANCELED');
	});

	test('__fail 在录音进行中时先停止录音', async () => {
		const { VoiceRecorder } = await import('./voice-recorder.js');
		mockIsRecording.mockReturnValueOnce(true);

		const statuses = [];
		const recorder = new VoiceRecorder({
			container: document.createElement('div'),
			onStatusChange: (s, d) => statuses.push({ s, d }),
		});

		await recorder.start();
		// 手动触发 __fail 来测试 isRecording 分支
		recorder.__fail('TestError');
		expect(mockStopRecording).toHaveBeenCalled();
		const failed = statuses.find((x) => x.s === 'FAILED');
		expect(failed).toBeTruthy();
		expect(failed.d.errName).toBe('TestError');
	});

	test('start 未知错误且 Capacitor 环境下回退到 UnknownError', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		// 设置 Capacitor 环境
		window.Capacitor = { isNativePlatform: () => true };
		const err = new Error('something random went wrong');
		mockStartRecording.mockRejectedValueOnce(err);

		const { VoiceRecorder } = await import('./voice-recorder.js');
		const statuses = [];
		const recorder = new VoiceRecorder({
			container: document.createElement('div'),
			onStatusChange: (s, d) => statuses.push({ s, d }),
		});

		await recorder.start();
		const failed = statuses.find((x) => x.s === 'FAILED');
		expect(failed).toBeTruthy();
		expect(failed.d.errName).toBe('UnknownError');
		warnSpy.mockRestore();
		delete window.Capacitor;
	});

	test('start 未知错误且无麦克风时回退到 NotFoundError', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { hasMicDev } = await import('./media-helper.js');
		hasMicDev.mockResolvedValueOnce(false);
		// 确保非 Capacitor 环境
		delete window.Capacitor;

		const err = new Error('something unexpected');
		mockStartRecording.mockRejectedValueOnce(err);

		const { VoiceRecorder } = await import('./voice-recorder.js');
		const statuses = [];
		const recorder = new VoiceRecorder({
			container: document.createElement('div'),
			onStatusChange: (s, d) => statuses.push({ s, d }),
		});

		await recorder.start();
		const failed = statuses.find((x) => x.s === 'FAILED');
		expect(failed).toBeTruthy();
		expect(failed.d.errName).toBe('NotFoundError');
		warnSpy.mockRestore();
	});
});
