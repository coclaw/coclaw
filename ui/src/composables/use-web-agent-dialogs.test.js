// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from 'vitest';

const useOverlayMock = vi.hoisted(() => vi.fn());
const pushDialogStateMock = vi.hoisted(() => vi.fn());

vi.mock('@nuxt/ui/composables', () => ({
	useOverlay: useOverlayMock,
}));

vi.mock('../utils/dialog-history.js', () => ({
	pushDialogState: pushDialogStateMock,
}));

vi.mock('../components/web-agents/WebAgentPickerDialog.vue', () => ({
	default: { name: 'WebAgentPickerDialog' },
}));

describe('useWebAgentDialogs', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
	});

	test('首次调用时创建 overlay 实例（destroyOnClose: false）', async () => {
		const instances = [];
		const overlay = {
			create: vi.fn((component, options = {}) => {
				const instance = { component, options, open: vi.fn(), close: vi.fn() };
				instances.push(instance);
				return instance;
			}),
		};
		useOverlayMock.mockReturnValue(overlay);

		const { useWebAgentDialogs } = await import('./use-web-agent-dialogs.js');
		useWebAgentDialogs();

		expect(overlay.create).toHaveBeenCalledTimes(1);
		expect(instances[0].options.destroyOnClose).toBe(false);
	});

	test('多次调用复用同一 overlay 实例', async () => {
		const overlay = {
			create: vi.fn(() => ({ open: vi.fn(), close: vi.fn() })),
		};
		useOverlayMock.mockReturnValue(overlay);

		const { useWebAgentDialogs } = await import('./use-web-agent-dialogs.js');
		useWebAgentDialogs();
		useWebAgentDialogs();
		useWebAgentDialogs();

		expect(overlay.create).toHaveBeenCalledTimes(1);
	});

	test('openPickerDialog 调用 pushDialogState 并 open dialog', async () => {
		const dialogInstance = { open: vi.fn(), close: vi.fn() };
		const overlay = {
			create: vi.fn(() => dialogInstance),
		};
		useOverlayMock.mockReturnValue(overlay);

		const { useWebAgentDialogs } = await import('./use-web-agent-dialogs.js');
		const dialogs = useWebAgentDialogs();
		dialogs.openPickerDialog();

		expect(pushDialogStateMock).toHaveBeenCalledTimes(1);
		expect(typeof pushDialogStateMock.mock.calls[0][0]).toBe('function');
		expect(dialogInstance.open).toHaveBeenCalledTimes(1);
	});

	test('pushDialogState 收到的回调能关闭 picker dialog', async () => {
		const dialogInstance = { open: vi.fn(), close: vi.fn() };
		const overlay = {
			create: vi.fn(() => dialogInstance),
		};
		useOverlayMock.mockReturnValue(overlay);

		const { useWebAgentDialogs } = await import('./use-web-agent-dialogs.js');
		const dialogs = useWebAgentDialogs();
		dialogs.openPickerDialog();

		const closeCb = pushDialogStateMock.mock.calls[0][0];
		dialogInstance.close.mockClear();
		closeCb();
		expect(dialogInstance.close).toHaveBeenCalledTimes(1);
	});
});
