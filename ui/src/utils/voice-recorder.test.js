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
});
