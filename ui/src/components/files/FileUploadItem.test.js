import { mount } from '@vue/test-utils';
import { describe, test, expect } from 'vitest';

import FileUploadItem from './FileUploadItem.vue';

function mountItem(task) {
	return mount(FileUploadItem, {
		props: { task },
		global: {
			mocks: { $t: (key) => key },
			stubs: {
				UIcon: { template: '<span />' },
				UButton: {
					props: { icon: String },
					template: '<button @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	});
}

describe('FileUploadItem', () => {
	// =================================================================
	// 各状态渲染
	// =================================================================
	test('pending 状态显示文件名和等待文字', () => {
		const w = mountItem({ id: '1', fileName: 'readme.md', status: 'pending', progress: 0 });
		expect(w.text()).toContain('readme.md');
		expect(w.text()).toContain('files.pending');
	});

	test('running 状态显示进度条和百分比', () => {
		const w = mountItem({ id: '2', fileName: 'data.zip', status: 'running', progress: 0.75 });
		expect(w.text()).toContain('data.zip');
		expect(w.text()).toContain('75%');
		const bar = w.find('.bg-primary');
		expect(bar.exists()).toBe(true);
		expect(bar.attributes('style')).toContain('75%');
	});

	test('running 进度 0% 显示 0%', () => {
		const w = mountItem({ id: '3', fileName: 'start.bin', status: 'running', progress: 0 });
		expect(w.text()).toContain('0%');
	});

	test('failed 状态显示错误信息', () => {
		const w = mountItem({ id: '4', fileName: 'fail.txt', status: 'failed', progress: 0, error: 'Network error' });
		expect(w.text()).toContain('Network error');
	});

	test('failed 无 error 时显示默认文本', () => {
		const w = mountItem({ id: '5', fileName: 'fail2.txt', status: 'failed', progress: 0, error: null });
		expect(w.text()).toContain('files.uploadFailed');
	});

	// =================================================================
	// 操作按钮
	// =================================================================
	test('pending 状态显示取消按钮', async () => {
		const w = mountItem({ id: 'p1', fileName: 'a.txt', status: 'pending', progress: 0 });
		const btn = w.find('button');
		expect(btn.exists()).toBe(true);
		await btn.trigger('click');
		expect(w.emitted('cancel')?.[0]).toEqual(['p1']);
	});

	test('running 状态显示取消按钮', async () => {
		const w = mountItem({ id: 'r1', fileName: 'b.txt', status: 'running', progress: 0.5 });
		const btn = w.find('button');
		await btn.trigger('click');
		expect(w.emitted('cancel')?.[0]).toEqual(['r1']);
	});

	test('failed 状态显示重试按钮', async () => {
		const w = mountItem({ id: 'f1', fileName: 'c.txt', status: 'failed', progress: 0, error: 'err' });
		const btn = w.find('button');
		await btn.trigger('click');
		expect(w.emitted('retry')?.[0]).toEqual(['f1']);
	});

	// =================================================================
	// 对齐：pl-4 与 FileListItem 一致
	// =================================================================
	test('容器有 pl-4 类（与 FileListItem 对齐）', () => {
		const w = mountItem({ id: '1', fileName: 'a.txt', status: 'pending', progress: 0 });
		expect(w.find('div').classes()).toContain('pl-4');
	});
});
