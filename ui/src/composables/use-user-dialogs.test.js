import { beforeEach, describe, expect, test, vi } from 'vitest';

const useOverlayMock = vi.hoisted(() => vi.fn());
const pushDialogStateMock = vi.hoisted(() => vi.fn());

vi.mock('@nuxt/ui/composables', () => ({
	useOverlay: useOverlayMock,
}));

vi.mock('../utils/dialog-history.js', () => ({
	pushDialogState: pushDialogStateMock,
}));

describe('useUserDialogs', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
	});

	test('should create profile/settings overlays once and open dialogs functionally', async () => {
		const instances = [];
		const overlay = {
			create: vi.fn((component, options = {}) => {
				const instance = {
					component,
					options,
					open: vi.fn(),
					close: vi.fn(),
					patch: vi.fn(),
				};
				instances.push(instance);
				return instance;
			}),
		};
		useOverlayMock.mockReturnValue(overlay);

		const { useUserDialogs } = await import('./use-user-dialogs.js');
		const dialogs = useUserDialogs();

		expect(overlay.create).toHaveBeenCalledTimes(2);

		dialogs.openProfileDialog();
		dialogs.openSettingsDialog();

		expect(instances[1].open).toHaveBeenCalledTimes(1);
		expect(instances[0].open).toHaveBeenCalledTimes(1);
	});

	test('closeAllDialogs 关闭所有已创建的对话框', async () => {
		const instances = [];
		const overlay = {
			create: vi.fn((component, options = {}) => {
				const instance = {
					component,
					options,
					open: vi.fn(),
					close: vi.fn(),
					patch: vi.fn(),
				};
				instances.push(instance);
				return instance;
			}),
		};
		useOverlayMock.mockReturnValue(overlay);

		const { useUserDialogs } = await import('./use-user-dialogs.js');
		const dialogs = useUserDialogs();

		// 打开对话框，pushDialogState 被调用，第一个参数是 closeAllDialogs
		dialogs.openProfileDialog();
		expect(pushDialogStateMock).toHaveBeenCalledTimes(1);

		const closeAllDialogs = pushDialogStateMock.mock.calls[0][0];
		expect(typeof closeAllDialogs).toBe('function');

		// 调用 closeAllDialogs 应关闭 profile 和 settings 对话框
		// instances[0] = settingsDialog, instances[1] = profileDialog
		instances[0].close.mockClear();
		instances[1].close.mockClear();

		closeAllDialogs();

		expect(instances[0].close).toHaveBeenCalledTimes(1);
		expect(instances[1].close).toHaveBeenCalledTimes(1);
	});

});
