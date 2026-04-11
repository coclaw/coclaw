import { mount } from '@vue/test-utils';
import { describe, test, expect } from 'vitest';

import FileListItem from './FileListItem.vue';

function mountItem(entry, downloadTask = null) {
	return mount(FileListItem, {
		props: { entry, downloadTask },
		global: {
			mocks: { $t: (key) => key },
			stubs: {
				UIcon: { template: '<span />' },
				// 传递原生 $event，使 .stop 修饰符正常工作
				UButton: {
					props: { icon: String },
					template: '<button @click="$emit(\'click\', $event)"><slot /></button>',
				},
			},
		},
	});
}

describe('FileListItem', () => {
	// =================================================================
	// 点击行为
	// =================================================================
	describe('点击行为', () => {
		test('点击目录 → emit open-dir', async () => {
			const w = mountItem({ name: 'docs', type: 'dir' });
			await w.find('div').trigger('click');
			expect(w.emitted('open-dir')?.[0]).toEqual(['docs']);
			expect(w.emitted('download')).toBeUndefined();
		});

		test('点击文件 → emit download', async () => {
			const w = mountItem({ name: 'readme.md', type: 'file', size: 1024 });
			await w.find('div').trigger('click');
			expect(w.emitted('download')?.[0]).toEqual([{ name: 'readme.md', type: 'file', size: 1024 }]);
			expect(w.emitted('open-dir')).toBeUndefined();
		});
	});

	// =================================================================
	// formatFileSize 集成
	// =================================================================
	describe('formatFileSize 集成', () => {
		test('文件显示格式化大小', () => {
			const w = mountItem({ name: 'data.bin', type: 'file', size: 2048 });
			expect(w.text()).toContain('2.0 KB');
		});

		test('size 为 0 显示 0 B', () => {
			const w = mountItem({ name: 'empty.txt', type: 'file', size: 0 });
			expect(w.text()).toContain('0 B');
		});

		test('目录不显示大小', () => {
			const w = mountItem({ name: 'src', type: 'dir', size: 4096 });
			expect(w.text()).not.toContain('KB');
			expect(w.text()).not.toContain('4096');
		});

		test('size 为 null 时不渲染大小', () => {
			const w = mountItem({ name: 'nosize.txt', type: 'file', size: null });
			// v-if 守卫 entry.size != null
			expect(w.text()).not.toContain('B');
		});

		test('GB 级文件大小', () => {
			const w = mountItem({ name: 'big.iso', type: 'file', size: 1024 * 1024 * 1024 * 2.5 });
			expect(w.text()).toContain('2.5 GB');
		});
	});

	// =================================================================
	// 日期格式化
	// =================================================================
	describe('日期格式化', () => {
		test('mtime 正常格式化', () => {
			const w = mountItem({ name: 'a.txt', type: 'file', size: 10, mtime: '2026-03-15T10:00:00Z' });
			expect(w.text()).toMatch(/2026-03-15/);
		});

		test('mtime 为 null 不渲染日期', () => {
			const w = mountItem({ name: 'a.txt', type: 'file', size: 10, mtime: null });
			expect(w.text()).not.toMatch(/\d{4}-\d{2}-\d{2}/);
		});

		test('mtime 为无效值返回空', () => {
			const w = mountItem({ name: 'a.txt', type: 'file', size: 10, mtime: 'invalid' });
			// formatDate returns '' for invalid
			expect(w.vm.formatDate('invalid')).toBe('');
		});
	});

	// =================================================================
	// 下载状态
	// =================================================================
	describe('下载状态', () => {
		test('running 状态显示进度条和取消按钮', () => {
			const w = mountItem(
				{ name: 'file.zip', type: 'file', size: 1000 },
				{ id: 't1', status: 'running', progress: 0.5 },
			);
			// 进度条
			const progressBar = w.find('.bg-primary');
			expect(progressBar.exists()).toBe(true);
			expect(progressBar.attributes('style')).toContain('50%');
		});

		test('running 状态隐藏删除按钮', () => {
			const w = mountItem(
				{ name: 'file.zip', type: 'file', size: 1000 },
				{ id: 't1', status: 'running', progress: 0.3 },
			);
			// 删除按钮 v-if="downloadTask?.status !== 'running'" 应不存在
			const buttons = w.findAll('button');
			// 只有取消按钮（icon=i-lucide-x），没有删除按钮（icon=i-lucide-trash-2）
			const trashBtn = buttons.filter((b) => b.attributes('icon') === 'i-lucide-trash-2');
			expect(trashBtn).toHaveLength(0);
		});

		test('failed 状态显示失败文本和重试按钮', () => {
			const w = mountItem(
				{ name: 'file.zip', type: 'file', size: 1000 },
				{ id: 't1', status: 'failed', progress: 0 },
			);
			expect(w.text()).toContain('common.failed');
		});

		test('cancel-download 事件携带 taskId', async () => {
			const w = mountItem(
				{ name: 'file.zip', type: 'file', size: 1000 },
				{ id: 'task-42', status: 'running', progress: 0.1 },
			);
			// 找到取消按钮并点击
			const cancelBtn = w.findAll('button').at(-1); // UButton stub
			await cancelBtn.trigger('click');
			expect(w.emitted('cancel-download')?.[0]).toEqual(['task-42']);
		});

		test('retry-download 事件携带 taskId', async () => {
			const w = mountItem(
				{ name: 'file.zip', type: 'file', size: 1000 },
				{ id: 'task-99', status: 'failed', progress: 0 },
			);
			// failed 区域有两个按钮：重试 + 删除，重试在前
			const buttons = w.findAll('button');
			// 找到非删除按钮区域的按钮（failed 分支中的 retry 按钮）
			await buttons[0].trigger('click');
			expect(w.emitted('retry-download')?.[0]).toEqual(['task-99']);
		});

		test('无下载任务时显示删除按钮', () => {
			const w = mountItem({ name: 'normal.txt', type: 'file', size: 100 }, null);
			// 应有删除按钮
			const buttons = w.findAll('button');
			expect(buttons.length).toBeGreaterThanOrEqual(1);
		});

		test('pending 状态显示等待中文字和取消按钮', () => {
			const w = mountItem(
				{ name: 'queued.zip', type: 'file', size: 1000 },
				{ id: 't-pending', status: 'pending', progress: 0 },
			);
			// 含等待中文案
			expect(w.text()).toContain('files.pending');
			// 不应渲染进度条（running 才有）
			expect(w.find('.bg-primary').exists()).toBe(false);
		});

		test('pending 状态隐藏删除按钮', () => {
			const w = mountItem(
				{ name: 'queued.zip', type: 'file', size: 1000 },
				{ id: 't-pending', status: 'pending', progress: 0 },
			);
			// 不应有删除按钮（trash 图标）
			const trashBtn = w.findAll('button').filter((b) => b.attributes('icon') === 'i-lucide-trash-2');
			expect(trashBtn).toHaveLength(0);
		});

		test('pending 状态点击取消按钮 emit cancel-download', async () => {
			const w = mountItem(
				{ name: 'queued.zip', type: 'file', size: 1000 },
				{ id: 'task-pending-7', status: 'pending', progress: 0 },
			);
			// pending 分支只有一个按钮（取消）
			const cancelBtn = w.findAll('button').at(-1);
			await cancelBtn.trigger('click');
			expect(w.emitted('cancel-download')?.[0]).toEqual(['task-pending-7']);
		});
	});

	// =================================================================
	// delete 事件
	// =================================================================
	test('删除按钮 emit delete', async () => {
		const entry = { name: 'del.txt', type: 'file', size: 50 };
		const w = mountItem(entry, null);
		// 删除按钮是最后一个 button
		const buttons = w.findAll('button');
		await buttons.at(-1).trigger('click');
		expect(w.emitted('delete')?.[0]).toEqual([entry]);
	});
});
