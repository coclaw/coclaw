import { describe, test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import InstanceOverview from './InstanceOverview.vue';

const mockT = (key) => key;

function mountOverview(props) {
	return mount(InstanceOverview, {
		props,
		global: {
			mocks: { $t: mockT },
			stubs: { UBadge: { template: '<span><slot /></span>' } },
		},
	});
}

describe('InstanceOverview', () => {
	test('renders instance name', () => {
		const wrapper = mountOverview({
			instance: { name: 'MyBot', online: true, channels: [] },
			agentCount: 2,
		});
		expect(wrapper.text()).toContain('MyBot');
	});

	test('online shows green pulse dot', () => {
		const wrapper = mountOverview({
			instance: { name: 'Bot', online: true, channels: [] },
		});
		expect(wrapper.find('.animate-pulse').exists()).toBe(true);
	});

	test('offline shows gray dot without pulse', () => {
		const wrapper = mountOverview({
			instance: { name: 'Bot', online: false, channels: [] },
		});
		expect(wrapper.find('.animate-pulse').exists()).toBe(false);
		expect(wrapper.find('.bg-gray-500').exists()).toBe(true);
	});

	test('formatCost with valid total', () => {
		const wrapper = mountOverview({
			instance: { name: 'Bot', online: true, monthlyCost: { total: 12.5 }, channels: [] },
		});
		expect(wrapper.text()).toContain('$12.50');
	});

	test('formatCost without total shows —', () => {
		const wrapper = mountOverview({
			instance: { name: 'Bot', online: true, monthlyCost: {}, channels: [] },
		});
		expect(wrapper.text()).toContain('—');
	});

	test('displays plugin and claw version', () => {
		const wrapper = mountOverview({
			instance: { name: 'Bot', online: true, pluginVersion: '1.0', clawVersion: '2.0', channels: [] },
		});
		expect(wrapper.text()).toContain('1.0');
		expect(wrapper.text()).toContain('2.0');
	});

	test('displays channel status icons', () => {
		const wrapper = mountOverview({
			instance: { name: 'Bot', online: true, channels: [{ id: 'discord', connected: true }, { id: 'slack', connected: false }] },
		});
		expect(wrapper.text()).toContain('✅');
		expect(wrapper.text()).toContain('❌');
	});

	test('displays agent count', () => {
		const wrapper = mountOverview({
			instance: { name: 'Bot', online: true, channels: [] },
			agentCount: 5,
		});
		expect(wrapper.text()).toContain('5');
	});
});
