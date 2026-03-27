import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import App from './App.vue';

const warningMock = vi.fn();

vi.mock('./composables/use-notify.js', () => ({
	useNotify: () => ({
		success: vi.fn(),
		info: vi.fn(),
		warning: warningMock,
		error: vi.fn(),
	}),
}));

vi.mock('./utils/global-error-handler.js', () => ({
	setGlobalErrorNotify: vi.fn(),
}));

vi.mock('./stores/env.store.js', () => ({
	useEnvStore: () => ({
		screen: { ltMd: false },
	}),
}));

vi.mock('./stores/ui.store.js', () => ({
	useUiStore: () => ({
		initResize: vi.fn(),
		destroyResize: vi.fn(),
	}),
}));

const UAppStub = {
	props: ['toaster'],
	template: '<div><slot /></div>',
};

function createWrapper() {
	return mount(App, {
		global: {
			stubs: {
				UApp: UAppStub,
				'router-view': { template: '<div />' },
			},
			mocks: {
				$t: (key, params) => {
					if (params) return `${key}:${JSON.stringify(params)}`;
					return key;
				},
			},
		},
	});
}

describe('App screenshot key failed listener', () => {
	let origElectronAPI;

	beforeEach(() => {
		origElectronAPI = window.electronAPI;
		warningMock.mockClear();
	});

	afterEach(() => {
		if (origElectronAPI === undefined) {
			delete window.electronAPI;
		} else {
			window.electronAPI = origElectronAPI;
		}
	});

	test('should listen to onScreenshotKeyFailed and show warning with key', () => {
		let capturedCb;
		window.electronAPI = {
			onScreenshotKeyFailed: (cb) => { capturedCb = cb; },
		};

		createWrapper();

		expect(capturedCb).toBeDefined();
		capturedCb({ key: 'Ctrl+Shift+A' });

		expect(warningMock).toHaveBeenCalledTimes(1);
		const callArg = warningMock.mock.calls[0][0];
		expect(callArg).toContain('Ctrl+Shift+A');
	});

	test('should not throw when electronAPI is undefined', () => {
		delete window.electronAPI;
		expect(() => createWrapper()).not.toThrow();
	});

	test('should not throw when onScreenshotKeyFailed is missing from electronAPI', () => {
		window.electronAPI = {};
		expect(() => createWrapper()).not.toThrow();
	});
});
