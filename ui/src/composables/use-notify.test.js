import { beforeEach, describe, expect, test, vi } from 'vitest';

const addMock = vi.fn();
const useToastMock = vi.hoisted(() => vi.fn());

vi.mock('@nuxt/ui/composables', () => ({
	useToast: useToastMock,
}));

describe('useNotify', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		addMock.mockReset();
		useToastMock.mockReturnValue({ add: addMock });
	});

	test('success(string) should call toast.add with success preset', async () => {
		const { useNotify } = await import('./use-notify.js');
		const notify = useNotify();

		notify.success('保存成功');

		expect(addMock).toHaveBeenCalledWith({
			color: 'success',
			icon: 'i-lucide-circle-check',
			duration: 3000,
			title: '保存成功',
		});
	});

	test('info(string) should call toast.add with info preset', async () => {
		const { useNotify } = await import('./use-notify.js');
		const notify = useNotify();

		notify.info('保存成功');

		expect(addMock).toHaveBeenCalledWith({
			color: 'info',
			icon: 'i-lucide-info',
			duration: 3000,
			title: '保存成功',
		});
	});

	test('warning(string) should call toast.add with warning preset', async () => {
		const { useNotify } = await import('./use-notify.js');
		const notify = useNotify();

		notify.warning('请注意');

		expect(addMock).toHaveBeenCalledWith({
			color: 'warning',
			icon: 'i-lucide-triangle-alert',
			duration: 5000,
			title: '请注意',
		});
	});

	test('error(string) should call toast.add with error preset', async () => {
		const { useNotify } = await import('./use-notify.js');
		const notify = useNotify();

		notify.error('操作失败');

		expect(addMock).toHaveBeenCalledWith({
			color: 'error',
			icon: 'i-lucide-circle-x',
			duration: 8000,
			title: '操作失败',
		});
	});

	test('info(object) should merge with preset, allowing overrides', async () => {
		const { useNotify } = await import('./use-notify.js');
		const notify = useNotify();

		notify.info({ title: '已复制', description: '内容已复制到剪贴板', duration: 2000 });

		expect(addMock).toHaveBeenCalledWith({
			color: 'info',
			icon: 'i-lucide-info',
			duration: 2000,
			title: '已复制',
			description: '内容已复制到剪贴板',
		});
	});

	test('error(object) should allow overriding icon', async () => {
		const { useNotify } = await import('./use-notify.js');
		const notify = useNotify();

		notify.error({ title: '网络错误', icon: 'i-lucide-wifi-off' });

		expect(addMock).toHaveBeenCalledWith({
			color: 'error',
			icon: 'i-lucide-wifi-off',
			duration: 8000,
			title: '网络错误',
		});
	});

	test('each method should return the toast instance from toast.add', async () => {
		const fakeToast = { id: 'test-123', open: true };
		addMock.mockReturnValue(fakeToast);

		const { useNotify } = await import('./use-notify.js');
		const notify = useNotify();

		expect(notify.success('test')).toBe(fakeToast);
		expect(notify.info('test')).toBe(fakeToast);
		expect(notify.warning('test')).toBe(fakeToast);
		expect(notify.error('test')).toBe(fakeToast);
	});
});
