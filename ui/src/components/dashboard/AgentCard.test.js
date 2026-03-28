import { describe, test, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

// mock useBotsStore，返回可控的 byId 结构
const mockById = {};

vi.mock('../../stores/bots.store.js', () => ({
	useBotsStore: () => ({
		byId: mockById,
	}),
}));

import AgentCard from './AgentCard.vue';

const mockT = (key, params) => {
	if (params?.n !== undefined) return `${params.n} ${key}`;
	return key;
};

function mountCard(props) {
	setActivePinia(createPinia());
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

function resetMockStates() {
	Object.keys(mockById).forEach(k => delete mockById[k]);
}

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

describe('AgentCard RTC status', () => {
	test('rtcState=connected + host → shows RTC Direct with green dot', () => {
		resetMockStates();
		mockById['bot1'] = { rtcState: 'connected', rtcTransportInfo: { localType: 'host' } };
		const wrapper = mountCard({ agent: baseAgent, online: true, botId: 'bot1' });
		expect(wrapper.text()).toContain('dashboard.rtcDirect');
		expect(wrapper.find('.bg-green-400').exists()).toBe(true);
	});

	test('rtcState=connected + relay → shows RTC Relay with yellow dot', () => {
		resetMockStates();
		mockById['bot2'] = { rtcState: 'connected', rtcTransportInfo: { localType: 'relay' } };
		const wrapper = mountCard({ agent: baseAgent, online: true, botId: 'bot2' });
		expect(wrapper.text()).toContain('dashboard.rtcRelay');
		expect(wrapper.find('.bg-yellow-400').exists()).toBe(true);
	});

	test('rtcState=connecting → shows RTC Connecting with blue dot', () => {
		resetMockStates();
		mockById['bot3'] = { rtcState: 'connecting' };
		const wrapper = mountCard({ agent: baseAgent, online: true, botId: 'bot3' });
		expect(wrapper.text()).toContain('dashboard.rtcConnecting');
		expect(wrapper.find('.bg-blue-400').exists()).toBe(true);
	});

	test('no rtcState + online → shows WebSocket with gray dot', () => {
		resetMockStates();
		const wrapper = mountCard({ agent: baseAgent, online: true, botId: 'bot4' });
		expect(wrapper.text()).toContain('dashboard.wsTransport');
		expect(wrapper.find('.bg-gray-400').exists()).toBe(true);
	});

	test('online=false → no RTC status row', () => {
		resetMockStates();
		mockById['bot5'] = { rtcState: 'connected', rtcTransportInfo: { localType: 'host' } };
		const wrapper = mountCard({ agent: baseAgent, online: false, botId: 'bot5' });
		expect(wrapper.text()).not.toContain('dashboard.rtcDirect');
		expect(wrapper.text()).not.toContain('dashboard.wsTransport');
	});

	test('no botId → no RTC status row (shows WebSocket fallback)', () => {
		resetMockStates();
		const wrapper = mountCard({ agent: baseAgent, online: true });
		// transportLabel 为 'dashboard.wsTransport' 因为 rtcState 为 null
		expect(wrapper.text()).toContain('dashboard.wsTransport');
	});

	test('rtcState=failed → shows RTC Failed with red dot', () => {
		resetMockStates();
		mockById['bot6'] = { rtcState: 'failed' };
		const wrapper = mountCard({ agent: baseAgent, online: true, botId: 'bot6' });
		expect(wrapper.text()).toContain('dashboard.rtcFailed');
		expect(wrapper.text()).not.toContain('dashboard.wsTransport');
		expect(wrapper.find('.bg-red-400').exists()).toBe(true);
	});

	test('rtcState=closed → shows RTC Closed with red dot', () => {
		resetMockStates();
		mockById['bot7'] = { rtcState: 'closed' };
		const wrapper = mountCard({ agent: baseAgent, online: true, botId: 'bot7' });
		expect(wrapper.text()).toContain('dashboard.rtcClosed');
		expect(wrapper.text()).not.toContain('dashboard.wsTransport');
		expect(wrapper.find('.bg-red-400').exists()).toBe(true);
	});
});
