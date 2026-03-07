import { afterEach, describe, expect, test, vi } from 'vitest';
import { queryMicPerm, hasMicDev, getPrefAudioType } from './media-helper.js';

describe('queryMicPerm', () => {
	const origPermissions = navigator.permissions;

	afterEach(() => {
		Object.defineProperty(navigator, 'permissions', {
			value: origPermissions,
			writable: true,
			configurable: true,
		});
	});

	test('returns permission state when available', async () => {
		Object.defineProperty(navigator, 'permissions', {
			value: { query: vi.fn().mockResolvedValue({ state: 'granted' }) },
			writable: true,
			configurable: true,
		});
		expect(await queryMicPerm()).toBe('granted');
	});

	test('returns null when permissions API not available', async () => {
		Object.defineProperty(navigator, 'permissions', {
			value: undefined,
			writable: true,
			configurable: true,
		});
		expect(await queryMicPerm()).toBeNull();
	});

	test('returns null when query throws', async () => {
		Object.defineProperty(navigator, 'permissions', {
			value: { query: vi.fn().mockRejectedValue(new Error('fail')) },
			writable: true,
			configurable: true,
		});
		expect(await queryMicPerm()).toBeNull();
	});
});

describe('hasMicDev', () => {
	const origMediaDevices = navigator.mediaDevices;

	afterEach(() => {
		Object.defineProperty(navigator, 'mediaDevices', {
			value: origMediaDevices,
			writable: true,
			configurable: true,
		});
	});

	test('returns true when audioinput device exists', async () => {
		Object.defineProperty(navigator, 'mediaDevices', {
			value: {
				enumerateDevices: vi.fn().mockResolvedValue([
					{ kind: 'audioinput', deviceId: '1' },
				]),
			},
			writable: true,
			configurable: true,
		});
		expect(await hasMicDev()).toBe(true);
	});

	test('returns false when no audioinput device', async () => {
		Object.defineProperty(navigator, 'mediaDevices', {
			value: {
				enumerateDevices: vi.fn().mockResolvedValue([
					{ kind: 'videoinput', deviceId: '1' },
				]),
			},
			writable: true,
			configurable: true,
		});
		expect(await hasMicDev()).toBe(false);
	});

	test('returns null when enumerateDevices throws', async () => {
		Object.defineProperty(navigator, 'mediaDevices', {
			value: {
				enumerateDevices: vi.fn().mockRejectedValue(new Error('fail')),
			},
			writable: true,
			configurable: true,
		});
		expect(await hasMicDev()).toBeNull();
	});
});

describe('getPrefAudioType', () => {
	test('returns null when MediaRecorder is undefined', () => {
		const orig = globalThis.MediaRecorder;
		globalThis.MediaRecorder = undefined;
		expect(getPrefAudioType()).toBeNull();
		globalThis.MediaRecorder = orig;
	});

	test('returns first supported type', () => {
		const orig = globalThis.MediaRecorder;
		globalThis.MediaRecorder = {
			isTypeSupported: vi.fn((type) => type === 'audio/mp4'),
		};
		expect(getPrefAudioType()).toBe('audio/mp4');
		globalThis.MediaRecorder = orig;
	});

	test('returns null when no type is supported', () => {
		const orig = globalThis.MediaRecorder;
		globalThis.MediaRecorder = {
			isTypeSupported: vi.fn(() => false),
		};
		expect(getPrefAudioType()).toBeNull();
		globalThis.MediaRecorder = orig;
	});
});
