import { describe, test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import AgentCard from './AgentCard.vue';

const mockT = (key, params) => {
	if (params?.n !== undefined) return `${params.n} ${key}`;
	return key;
};

function mountCard(props) {
	return mount(AgentCard, {
		props,
		global: {
			mocks: { $t: mockT },
			stubs: {
				UBadge: { template: '<span class="badge"><slot /></span>' },
				UButton: { template: '<button :disabled="$attrs.disabled" @click="$emit(\'click\')"><slot /></button>' },
			},
		},
	});
}

const baseAgent = {
	id: 'main',
	name: 'Assistant',
	avatarUrl: null,
	emoji: '🤖',
	theme: '#3b82f6',
	modelTags: [{ label: 'Claude 3', type: 'name' }],
	capabilities: [{ id: 'web_search', labelKey: 'dashboard.cap.webSearch', icon: '🔍' }],
	totalTokens: 1500,
	activeSessions: 2,
	lastActivity: new Date(Date.now() - 3600000).toISOString(),
};

describe('AgentCard', () => {
	test('renders agent name and emoji', () => {
		const wrapper = mountCard({ agent: baseAgent, online: true });
		expect(wrapper.text()).toContain('Assistant');
		expect(wrapper.text()).toContain('🤖');
	});

	test('renders avatar image when avatarUrl present', () => {
		const agent = { ...baseAgent, avatarUrl: 'https://example.com/avatar.png', emoji: null };
		const wrapper = mountCard({ agent, online: true });
		expect(wrapper.find('img').exists()).toBe(true);
		expect(wrapper.find('img').attributes('src')).toBe('https://example.com/avatar.png');
	});

	test('renders initial letter when no avatar or emoji', () => {
		const agent = { ...baseAgent, avatarUrl: null, emoji: null };
		const wrapper = mountCard({ agent, online: true });
		expect(wrapper.text()).toContain('A');
	});

	test('theme color applied to top bar', () => {
		const wrapper = mountCard({ agent: baseAgent, online: true });
		const bar = wrapper.find('.h-1');
		// jsdom 将 hex 转为 rgb
		expect(bar.attributes('style')).toContain('background');
		expect(bar.attributes('style')).toMatch(/rgb\(59,\s*130,\s*246\)/);
	});

	test('default theme when agent.theme is null', () => {
		const agent = { ...baseAgent, theme: null };
		const wrapper = mountCard({ agent, online: true });
		const bar = wrapper.find('.h-1');
		expect(bar.attributes('style')).toContain('background');
		expect(bar.attributes('style')).toMatch(/rgb\(99,\s*102,\s*241\)/);
	});

	test('model tags rendered', () => {
		const wrapper = mountCard({ agent: baseAgent, online: true });
		expect(wrapper.text()).toContain('Claude 3');
	});

	test('capability badges rendered', () => {
		const wrapper = mountCard({ agent: baseAgent, online: true });
		expect(wrapper.text()).toContain('🔍');
		expect(wrapper.text()).toContain('dashboard.cap.webSearch');
	});

	test('formatTokens 1500 → 1.5K', () => {
		const wrapper = mountCard({ agent: baseAgent, online: true });
		expect(wrapper.text()).toContain('1.5K');
	});

	test('formatTokens 0', () => {
		const agent = { ...baseAgent, totalTokens: 0 };
		const wrapper = mountCard({ agent, online: true });
		expect(wrapper.text()).toContain('0');
	});

	test('formatTokens 2500000 → 2.5M', () => {
		const agent = { ...baseAgent, totalTokens: 2500000 };
		const wrapper = mountCard({ agent, online: true });
		expect(wrapper.text()).toContain('2.5M');
	});

	test('offline applies opacity', () => {
		const wrapper = mountCard({ agent: baseAgent, online: false });
		expect(wrapper.find('.opacity-60').exists()).toBe(true);
	});

	test('chat button emits event', async () => {
		const wrapper = mountCard({ agent: baseAgent, online: true });
		await wrapper.find('button').trigger('click');
		expect(wrapper.emitted('chat')).toBeTruthy();
		expect(wrapper.emitted('chat')[0]).toEqual(['main']);
	});

	test('chat button disabled when offline', () => {
		const wrapper = mountCard({ agent: baseAgent, online: false });
		expect(wrapper.find('button').attributes('disabled')).toBeDefined();
	});

	test('lastActivity null shows —', () => {
		const agent = { ...baseAgent, lastActivity: null };
		const wrapper = mountCard({ agent, online: true });
		expect(wrapper.text()).toContain('—');
	});
});
