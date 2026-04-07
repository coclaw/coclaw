import { mount } from '@vue/test-utils';
import { test, expect, describe, vi } from 'vitest';

const mockNotify = { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() };
vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => mockNotify,
}));

import ChatMsgItem from './ChatMsgItem.vue';

const MarkdownBodyStub = {
	props: ['text'],
	template: '<div class="cc-markdown md-stub">{{ text }}</div>',
};

const UIconStub = {
	props: ['name'],
	template: '<span class="icon-stub">{{ name }}</span>',
};

const UButtonStub = {
	props: ['icon', 'variant', 'color', 'size'],
	template: '<button class="u-btn-stub" @click="$emit(\'click\')"><span class="icon-stub">{{ icon }}</span></button>',
};

// ChatImg 有异步压缩流程，stub 为同步渲染
const ChatImgStub = {
	name: 'ChatImg',
	props: ['src', 'filename', 'customClass'],
	template: '<img :src="src" alt="" class="rounded-lg" :class="customClass" />',
};

const i18nMap = {
	'chat.thought': '已思考',
	'chat.taskIncomplete': 'chat.taskIncomplete',
	'chat.sending': '发送中...',
};

function createWrapper(item = {}) {
	const defaults = item.type === 'botTask'
		? {
			type: 'botTask',
			id: 'bt-1',
			resultText: '回复内容',
			model: null,
			timestamp: null,
			duration: null,
			steps: [],
			images: [],
		}
		: {
			type: 'user',
			id: 'u-1',
			textContent: 'Hello',
			images: [],
			timestamp: null,
		};

	return mount(ChatMsgItem, {
		props: {
			item: { ...defaults, ...item },
		},
		global: {
			stubs: {
				MarkdownBody: MarkdownBodyStub,
				ChatImg: ChatImgStub,
				UIcon: UIconStub,
				UButton: UButtonStub,
			},
			mocks: {
				$t: (key, params) => {
					if (key === 'chat.toolCallLabel' && params?.name) {
						return `Call ${params.name}`;
					}
					if (key === 'chat.thoughtFor' && params?.time) {
						return `已思考 ${params.time}`;
					}
					if (key === 'chat.durationSec' && params?.s != null) {
						return `${params.s}秒`;
					}
					if (key === 'chat.durationMinSec' && params?.m != null) {
						return `${params.m}分${params.s}秒`;
					}
					if (key === 'chat.durationHourMin' && params?.h != null) {
						return `${params.h}时${params.m}分`;
					}
					return i18nMap[key] ?? key;
				},
			},
		},
	});
}

describe('ChatMsgItem', () => {
	test('渲染 user 消息为纯文本', () => {
		const wrapper = createWrapper({ type: 'user', textContent: '你好世界' });
		expect(wrapper.find('.md-stub').exists()).toBe(false);
		expect(wrapper.text()).toContain('你好世界');
	});

	test('渲染 botTask 结果通过 MarkdownBody', () => {
		const wrapper = createWrapper({ type: 'botTask', resultText: '**bold**' });
		const md = wrapper.find('.md-stub');
		expect(md.exists()).toBe(true);
		expect(md.text()).toBe('**bold**');
	});

	test('user 消息无头像', () => {
		const wrapper = createWrapper({ type: 'user' });
		expect(wrapper.find('img[alt="bot"]').exists()).toBe(false);
	});

	test('user 消息右对齐、bg-primary 背景、白色文字', () => {
		const wrapper = createWrapper({ type: 'user' });
		expect(wrapper.find('.bg-primary').exists()).toBe(true);
		expect(wrapper.find('.text-white').exists()).toBe(true);
		expect(wrapper.find('.items-end').exists()).toBe(true);
	});

	test('user 消息使用 text-base 字号', () => {
		const wrapper = createWrapper({ type: 'user' });
		expect(wrapper.find('.text-base').exists()).toBe(true);
	});

	test('botTask 始终显示 bot avatar 行', () => {
		const wrapper = createWrapper({ type: 'botTask', steps: [] });
		const img = wrapper.find('img[alt="claw"]');
		expect(img.exists()).toBe(true);
		expect(img.classes()).toContain('size-6');
	});

	test('显示格式化时间', () => {
		const ts = new Date(2026, 2, 1, 10, 30, 0).getTime();
		const wrapper = createWrapper({ type: 'user', timestamp: ts });
		expect(wrapper.text()).toContain('10:30');
	});

	test('无时间戳时不显示', () => {
		const wrapper = createWrapper({ type: 'user', timestamp: null });
		expect(wrapper.text()).not.toMatch(/\d{2}:\d{2}/);
	});

	test('botTask 显示 model 名称', () => {
		const wrapper = createWrapper({ type: 'botTask', model: 'gpt-5.3-codex' });
		expect(wrapper.text()).toContain('gpt-5.3-codex');
	});

	test('user 不显示 model', () => {
		const wrapper = createWrapper({ type: 'user' });
		expect(wrapper.text()).not.toContain('model');
	});

	test('resultText 为 null 时显示任务未完成', () => {
		const wrapper = createWrapper({ type: 'botTask', resultText: null });
		expect(wrapper.text()).toContain('chat.taskIncomplete');
		expect(wrapper.find('.md-stub').exists()).toBe(false);
	});

	test('有 steps 时点击展开', async () => {
		const wrapper = createWrapper({
			type: 'botTask',
			steps: [
				{ kind: 'thinking', text: '深度推理' },
				{ kind: 'toolCall', name: 'search' },
				{ kind: 'toolResult', text: '搜索结果' },
			],
		});
		// 折叠状态
		expect(wrapper.text()).not.toContain('深度推理');

		const btn = wrapper.findAll('button').find(b => b.text().includes('已思考'));
		await btn.trigger('click');
		expect(wrapper.text()).toContain('深度推理');
		expect(wrapper.text()).toContain('Call search');
		expect(wrapper.text()).toContain('搜索结果');
	});

	test('无 steps 时展开区域不渲染', async () => {
		const wrapper = createWrapper({ type: 'botTask', steps: [] });
		const btn = wrapper.findAll('button').find(b => b.text().includes('已思考'));
		expect(btn).toBeDefined();
		await btn.trigger('click');
		// 展开后因 steps 为空，区域不渲染
		const stepsArea = wrapper.find('.border-l-2');
		expect(stepsArea.exists()).toBe(false);
	});

	test('botTask 无行级背景色', () => {
		const wrapper = createWrapper({ type: 'botTask' });
		expect(wrapper.find('.bg-muted\\/40').exists()).toBe(false);
	});

	test('user 消息有复制按钮', () => {
		const wrapper = createWrapper({ type: 'user', textContent: '复制我' });
		const copyBtn = wrapper.findAll('.u-btn-stub').find(b => b.text().includes('i-lucide-copy'));
		expect(copyBtn).toBeDefined();
	});

	test('botTask 消息有复制按钮（右侧）', () => {
		const wrapper = createWrapper({ type: 'botTask', resultText: '复制我' });
		// 复制按钮位于 cc-icon-btn ml-auto 的 UButton 内
		const copyBtns = wrapper.findAll('.u-btn-stub').filter(b => b.text().includes('i-lucide-copy'));
		expect(copyBtns.length).toBeGreaterThan(0);
	});

	test('点击复制按钮后 icon 变为 check', async () => {
		const writeTextMock = vi.fn(() => Promise.resolve());
		Object.assign(navigator, {
			clipboard: { writeText: writeTextMock },
		});

		const wrapper = createWrapper({ type: 'user', textContent: '复制测试' });
		const copyBtn = wrapper.findAll('.u-btn-stub').find(b => b.text().includes('i-lucide-copy'));
		await copyBtn.trigger('click');
		await wrapper.vm.$nextTick();

		expect(writeTextMock).toHaveBeenCalledWith('复制测试');
		expect(wrapper.text()).toContain('i-lucide-check');
	});

	test('botTask 复制按钮取 DOM innerText 而非原始 Markdown (#127)', async () => {
		const writeTextMock = vi.fn(() => Promise.resolve());
		Object.assign(navigator, {
			clipboard: { writeText: writeTextMock },
		});

		const wrapper = createWrapper({
			type: 'botTask',
			resultText: '> 这是引用\n\n正文',
		});

		// 模拟真实 MarkdownBody 渲染后的 DOM：blockquote 不含 > 前缀
		const mdEl = wrapper.find('.cc-markdown');
		expect(mdEl.exists()).toBe(true);
		// jsdom 不支持 innerText，手动定义以模拟真实浏览器行为
		Object.defineProperty(mdEl.element, 'innerText', {
			get: () => '这是引用\n正文',
			configurable: true,
		});

		const copyBtn = wrapper.findAll('.u-btn-stub').find(b => b.text().includes('i-lucide-copy'));
		await copyBtn.trigger('click');
		await wrapper.vm.$nextTick();

		// 应该复制 DOM innerText，而非原始 Markdown
		const copiedText = writeTextMock.mock.calls[0][0];
		expect(copiedText).not.toContain('> ');
		expect(copiedText).toContain('这是引用');
		expect(copiedText).toContain('正文');
	});

	test('botTask 复制 fallback 到 resultText 当 DOM 不存在时', async () => {
		const writeTextMock = vi.fn(() => Promise.resolve());
		Object.assign(navigator, {
			clipboard: { writeText: writeTextMock },
		});

		const wrapper = createWrapper({
			type: 'botTask',
			resultText: '> fallback 内容',
		});

		// 移除 .cc-markdown 元素模拟 DOM 不可用
		const mdEl = wrapper.find('.cc-markdown');
		mdEl.element.classList.remove('cc-markdown');

		const copyBtn = wrapper.findAll('.u-btn-stub').find(b => b.text().includes('i-lucide-copy'));
		await copyBtn.trigger('click');
		await wrapper.vm.$nextTick();

		// fallback 到原始文本
		expect(writeTextMock).toHaveBeenCalledWith('> fallback 内容');
	});

	test('有 duration 时显示"已思考 X秒"', () => {
		const wrapper = createWrapper({ type: 'botTask', duration: 5000 });
		expect(wrapper.text()).toContain('已思考 5秒');
	});

	test('duration >= 60s 显示分秒', () => {
		const wrapper = createWrapper({ type: 'botTask', duration: 150000 });
		expect(wrapper.text()).toContain('已思考 2分30秒');
	});

	test('duration >= 3600s 显示时分', () => {
		const wrapper = createWrapper({ type: 'botTask', duration: 4500000 });
		expect(wrapper.text()).toContain('已思考 1时15分');
	});

	test('无 duration 时显示"已思考"', () => {
		const wrapper = createWrapper({ type: 'botTask', duration: null });
		expect(wrapper.text()).toContain('已思考');
		expect(wrapper.text()).not.toContain('已思考 ');
	});

	test('duration < 1s 时显示"已思考"不带时间', () => {
		const wrapper = createWrapper({ type: 'botTask', duration: 500 });
		expect(wrapper.text()).toContain('已思考');
		expect(wrapper.text()).not.toMatch(/已思考 \d/);
	});

	test('user 消息渲染内联图片', () => {
		const wrapper = createWrapper({
			type: 'user',
			textContent: '看图',
			images: [{ data: 'abc', mimeType: 'image/png' }],
		});
		const img = wrapper.find('.bg-primary img');
		expect(img.exists()).toBe(true);
		expect(img.attributes('src')).toBe('data:image/png;base64,abc');
		expect(img.classes()).toContain('rounded-lg');
	});

	test('user 无图片时不渲染 img 标签', () => {
		const wrapper = createWrapper({ type: 'user', textContent: '纯文本', images: [] });
		expect(wrapper.find('.bg-primary img').exists()).toBe(false);
	});

	test('botTask 正文区渲染图像', () => {
		const wrapper = createWrapper({
			type: 'botTask',
			resultText: '结果',
			images: [{ data: 'xyz', mimeType: 'image/jpeg' }],
		});
		const imgs = wrapper.findAll('img').filter(i => i.attributes('src')?.startsWith('data:image/jpeg'));
		expect(imgs).toHaveLength(1);
		expect(imgs[0].attributes('src')).toBe('data:image/jpeg;base64,xyz');
		expect(imgs[0].classes()).toContain('rounded-lg');
	});

	test('botTask steps 展开后渲染图像缩略图', async () => {
		const wrapper = createWrapper({
			type: 'botTask',
			steps: [
				{ kind: 'toolCall', name: 'screenshot' },
				{ kind: 'image', data: 'stepimg', mimeType: 'image/png' },
			],
		});
		const btn = wrapper.findAll('button').find(b => b.text().includes('已思考'));
		await btn.trigger('click');
		const stepImgs = wrapper.findAll('.border-l-2 img');
		expect(stepImgs.length).toBe(1);
		expect(stepImgs[0].attributes('src')).toBe('data:image/png;base64,stepimg');
		expect(stepImgs[0].classes()).toContain('max-h-32');
	});

	// --- _pending 状态 ---
	test('user 消息 _pending 时显示发送中指示器，不显示消息内容', () => {
		const wrapper = createWrapper({ type: 'user', textContent: '你好', _pending: true });
		expect(wrapper.text()).toContain('发送中...');
		expect(wrapper.text()).not.toContain('你好');
		expect(wrapper.find('.bg-primary').exists()).toBe(false);
	});

	test('user 消息 _pending 时渲染 spinner 图标且使用 text-primary', () => {
		const wrapper = createWrapper({ type: 'user', textContent: '你好', _pending: true });
		const icon = wrapper.findAll('.icon-stub').find((s) => s.text().includes('i-lucide-loader-2'));
		expect(icon).toBeTruthy();
		expect(wrapper.find('.text-primary').exists()).toBe(true);
	});

	test('user 消息 _pending 时不显示复制按钮和时间戳', () => {
		const ts = new Date(2026, 2, 1, 10, 30, 0).getTime();
		const wrapper = createWrapper({ type: 'user', textContent: '你好', _pending: true, timestamp: ts });
		// 无复制按钮
		const copyBtns = wrapper.findAll('.u-btn-stub').filter((b) => b.text().includes('i-lucide-copy'));
		expect(copyBtns).toHaveLength(0);
		// 无时间戳
		expect(wrapper.text()).not.toContain('10:30');
	});

	test('user 消息无 _pending 时正常渲染消息内容', () => {
		const wrapper = createWrapper({ type: 'user', textContent: '你好' });
		expect(wrapper.text()).toContain('你好');
		expect(wrapper.text()).not.toContain('发送中...');
		expect(wrapper.find('.bg-primary').exists()).toBe(true);
	});

	test('botTask _pending 时整个组件不渲染（包括外层 wrapper）', () => {
		const wrapper = createWrapper({ type: 'botTask', resultText: '回复', _pending: true });
		// 外层 div 的 v-if 为 false，整个组件内容为空
		expect(wrapper.find('.px-3').exists()).toBe(false);
		expect(wrapper.find('.md-stub').exists()).toBe(false);
		expect(wrapper.find('img[alt="claw"]').exists()).toBe(false);
	});

	test('botTask 无 _pending 时正常渲染', () => {
		const wrapper = createWrapper({ type: 'botTask', resultText: '回复' });
		expect(wrapper.find('.px-3').exists()).toBe(true);
		expect(wrapper.find('.md-stub').exists()).toBe(true);
	});
});
