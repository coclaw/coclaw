import { beforeEach, describe, expect, test, vi } from 'vitest';

const useOverlayMock = vi.hoisted(() => vi.fn());

vi.mock('@nuxt/ui/composables', () => ({
	useOverlay: useOverlayMock,
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

});
