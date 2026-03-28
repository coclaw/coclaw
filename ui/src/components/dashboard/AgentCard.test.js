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
	recentSessions: [],
	contextPressure: -1,
	sparkline: [],
	cronCount: 0,
	hasError: false,
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

	test('context pressure bar renders when contextPressure >= 0', () => {
		const agent = { ...baseAgent, contextPressure: 75 };
		const wrapper = mountCard({ agent, online: true });
		expect(wrapper.text()).toContain('Context');
		expect(wrapper.text()).toContain('75%');
	});

	test('context pressure bar hidden when contextPressure is -1', () => {
		const agent = { ...baseAgent, contextPressure: -1 };
		const wrapper = mountCard({ agent, online: true });
		expect(wrapper.text()).not.toContain('Context');
	});

	test('context pressure color is red at 90+', () => {
		const agent = { ...baseAgent, contextPressure: 95 };
		const wrapper = mountCard({ agent, online: true });
		expect(wrapper.find('.text-red-500').exists()).toBe(true);
	});

	test('sparkline renders when data has nonzero values', () => {
		const agent = { ...baseAgent, sparkline: [0, 10, 20, 30, 40, 50, 60] };
		const wrapper = mountCard({ agent, online: true });
		const bars = wrapper.findAll('.bg-primary\\/40');
		expect(bars.length).toBe(7);
	});

	test('sparkline hidden when all zeros', () => {
		const agent = { ...baseAgent, sparkline: [0, 0, 0, 0, 0, 0, 0] };
		const wrapper = mountCard({ agent, online: true });
		const bars = wrapper.findAll('.bg-primary\\/40');
		expect(bars.length).toBe(0);
	});

	test('error badge renders when hasError is true', () => {
		const agent = { ...baseAgent, hasError: true };
		const wrapper = mountCard({ agent, online: true });
		expect(wrapper.find('.bg-red-500').exists()).toBe(true);
	});

	test('error badge hidden when hasError is false', () => {
		const agent = { ...baseAgent, hasError: false };
		const wrapper = mountCard({ agent, online: true });
		expect(wrapper.find('.bg-red-500').exists()).toBe(false);
	});

	test('cron count badge renders when cronCount > 0', () => {
		const agent = { ...baseAgent, cronCount: 3 };
		const wrapper = mountCard({ agent, online: true });
		expect(wrapper.text()).toContain('⏰');
		expect(wrapper.text()).toContain('3');
	});

	test('recent sessions list renders', () => {
		const agent = {
			...baseAgent,
			recentSessions: [
				{ key: 'agent:main:s1', label: 'Chat 1', updatedAt: new Date(Date.now() - 60000).toISOString() },
				{ key: 'agent:main:s2', label: 'Chat 2', updatedAt: new Date(Date.now() - 120000).toISOString() },
			],
		};
		const wrapper = mountCard({ agent, online: true });
		expect(wrapper.text()).toContain('dashboard.recentChats');
		expect(wrapper.text()).toContain('Chat 1');
		expect(wrapper.text()).toContain('Chat 2');
	});

	test('clicking recent session emits open-session', async () => {
		const agent = {
			...baseAgent,
			recentSessions: [
				{ key: 'agent:main:s1', label: 'Chat 1', updatedAt: new Date().toISOString() },
			],
		};
		const wrapper = mountCard({ agent, online: true });
		await wrapper.find('li').trigger('click');
		expect(wrapper.emitted('open-session')).toBeTruthy();
		expect(wrapper.emitted('open-session')[0]).toEqual(['agent:main:s1']);
	});
});
