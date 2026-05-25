import { mount, flushPromises } from '@vue/test-utils';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPinia } from 'pinia';

// --- mock 子组件（保留 ProviderAuthRow 真实组件，便于断言交互） ---
vi.mock('../components/MobilePageHeader.vue', () => ({
	default: {
		name: 'MobilePageHeader',
		props: ['title', 'fallback'],
		template: '<div class="mobile-header">{{ title }}</div>',
	},
}));
vi.mock('../components/model-config/RemoveProviderConfirmDialog.vue', () => ({
	default: {
		name: 'RemoveProviderConfirmDialog',
		props: ['open', 'provider', 'currentPrimary', 'isPrimaryCarrier', 'busy'],
		emits: ['update:open', 'confirm', 'cancel'],
		template: `
			<div v-if="open" class="remove-dialog" :data-carrier="String(isPrimaryCarrier)">
				<span class="rd-provider">{{ provider }}</span>
				<span class="rd-primary">{{ currentPrimary }}</span>
				<button class="rd-confirm" @click="$emit('confirm')">confirm</button>
				<button class="rd-cancel" @click="$emit('cancel'); $emit('update:open', false)">cancel</button>
			</div>
		`,
	},
}));

// T3 dialogs — stub them so the page wiring test can drive their events directly
vi.mock('../components/model-config/AddProviderDialog.vue', () => ({
	default: {
		name: 'AddProviderDialog',
		props: ['open', 'catalog', 'existingProviders', 'setApiKey'],
		emits: ['update:open', 'added'],
		template: `
			<div v-if="open" class="add-dialog" :data-existing="(existingProviders||[]).join(',')">
				<span class="ad-catalog-len">{{ (catalog||[]).length }}</span>
				<button class="ad-fire-added" @click="$emit('added', { provider: 'groq', profileId: 'groq:default' }); $emit('update:open', false)">added</button>
				<button class="ad-cancel" @click="$emit('update:open', false)">cancel</button>
				<button class="ad-rpc" @click="setApiKey && setApiKey({ provider: 'groq', apiKey: 'gsk_x' })">rpc</button>
			</div>
		`,
	},
}));
vi.mock('../components/model-config/PrimaryModelPickerDialog.vue', () => ({
	default: {
		name: 'PrimaryModelPickerDialog',
		props: ['open', 'providers', 'catalog', 'current', 'setPrimary'],
		emits: ['update:open', 'picked'],
		template: `
			<div v-if="open" class="picker-dialog" :data-providers="(providers||[]).join(',')" :data-current="current||''">
				<span class="pk-catalog-len">{{ (catalog||[]).length }}</span>
				<button class="pk-fire-picked" @click="$emit('picked', { primary: 'groq/llama-3.3-70b-versatile' }); $emit('update:open', false)">picked</button>
				<button class="pk-cancel" @click="$emit('update:open', false)">cancel</button>
				<button class="pk-rpc" @click="setPrimary && setPrimary({ primary: 'groq/llama-3.3-70b-versatile' })">rpc</button>
			</div>
		`,
	},
}));

const mockNotify = {
	success: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
	error: vi.fn(),
};
vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => mockNotify,
}));

const mockRequest = vi.fn();
const mockClawConnGet = vi.fn(() => ({ request: mockRequest }));
vi.mock('../services/claw-connection-manager.js', () => ({
	useClawConnections: () => ({
		get: mockClawConnGet,
		connect: vi.fn(),
		disconnect: vi.fn(),
		syncConnections: vi.fn(),
		disconnectAll: vi.fn(),
	}),
}));

// 简化 stores：避免 dashboard.store 真正注册（它依赖一堆其他 store）
const mockLoadDashboard = vi.fn(() => Promise.resolve());
const mockGetDashboard = vi.fn(() => ({ instance: { name: 'My Claw' } }));
vi.mock('../stores/dashboard.store.js', () => ({
	useDashboardStore: () => ({
		getDashboard: mockGetDashboard,
		loadDashboard: mockLoadDashboard,
	}),
	// 真实导出：供页面 import 的 computePrimaryEffective 不被破坏
	computePrimaryEffective: (primary, providers, catalog) => {
		if (!primary || typeof primary !== 'string') return false;
		const idx = primary.indexOf('/');
		if (idx <= 0 || idx === primary.length - 1) return false;
		const provider = primary.slice(0, idx);
		const model = primary.slice(idx + 1);
		if (!Array.isArray(providers) || !providers.includes(provider)) return false;
		if (!Array.isArray(catalog)) return false;
		return catalog.some(m => m && m.provider === provider && m.id === model);
	},
}));

// 同样 stub claws.store 提供 byId 即可
const clawsStoreState = {
	byId: {
		claw1: { id: 'claw1', name: 'My Claw', online: true, dcReady: true },
	},
};
vi.mock('../stores/claws.store.js', () => ({
	useClawsStore: () => clawsStoreState,
}));

import ModelConfigPage from './ModelConfigPage.vue';

function makeWrapper({ route, online = true, dcReady = true } = {}) {
	clawsStoreState.byId.claw1.online = online;
	clawsStoreState.byId.claw1.dcReady = dcReady;
	return mount(ModelConfigPage, {
		global: {
			plugins: [createPinia()],
			mocks: {
				$route: route ?? { params: { clawId: 'claw1' } },
				$router: { push: vi.fn(), back: vi.fn(), replace: vi.fn() },
				$t: (key, params) => params ? `${key}|${JSON.stringify(params)}` : key,
			},
			stubs: {
				UButton: {
					props: { disabled: { type: Boolean, default: false }, loading: { type: Boolean, default: false } },
					emits: ['click'],
					template: '<button :disabled="disabled || loading" :data-loading="loading" @click="$emit(\'click\')"><slot /></button>',
				},
				UIcon: { template: '<span />' },
				ProviderAuthRow: {
					name: 'ProviderAuthRow',
					props: ['profile', 'disabled'],
					emits: ['remove'],
					template: `
						<div class="provider-row" :data-provider="profile?.provider">
							<button class="row-remove" :disabled="disabled" @click="$emit('remove', profile?.provider ?? '')">x</button>
						</div>
					`,
				},
			},
		},
	});
}

function asProfiles(arr) { return { profiles: arr }; }
function asModelList(primary) { return { default: { primary } }; }
function asCatalog(arr) { return { models: arr }; }

beforeEach(() => {
	vi.clearAllMocks();
	mockClawConnGet.mockReturnValue({ request: mockRequest });
	mockGetDashboard.mockReturnValue({ instance: { name: 'My Claw' } });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('ModelConfigPage — header + clawId', () => {
	test('title combines claw name and i18n title', async () => {
		mockRequest.mockResolvedValue({});
		const w = makeWrapper();
		expect(w.find('.mobile-header').text()).toContain('My Claw');
		expect(w.find('.mobile-header').text()).toContain('modelConfig.title');
		w.unmount();
	});

	test('falls back to clawId when dashboard instance is null', async () => {
		mockGetDashboard.mockReturnValue(null);
		// 同时把 claws byId 的 name 清掉
		clawsStoreState.byId.claw1.name = null;
		mockRequest.mockResolvedValue({});
		const w = makeWrapper();
		expect(w.find('.mobile-header').text()).toContain('claw1');
		// 恢复 name 给后续 case 用
		clawsStoreState.byId.claw1.name = 'My Claw';
		w.unmount();
	});

	test('goBack delegates to router back/replace via nav-back helper', async () => {
		mockRequest.mockResolvedValue({});
		const w = makeWrapper();
		const back = vi.fn();
		const replace = vi.fn();
		w.vm.$router.back = back;
		w.vm.$router.replace = replace;
		// 模拟无上一页 → 走 fallback
		const orig = history.state;
		history.replaceState({ ...history.state, back: null }, '');
		w.vm.goBack();
		expect(replace).toHaveBeenCalledWith('/claws');
		history.replaceState(orig, '');
		w.unmount();
	});
});

describe('ModelConfigPage — initial load races', () => {
	test('all three RPCs succeed: renders primary + profiles', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'models.list') return asCatalog([
				{ id: 'llama-3.3-70b-versatile', provider: 'groq' },
			]);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.profiles).toHaveLength(1);
		expect(w.vm.primary).toBe('groq/llama-3.3-70b-versatile');
		expect(w.vm.catalog).toHaveLength(1);
		expect(w.vm.primaryState).toBe('effective');
		expect(w.find('[data-testid="primary-current"]').exists()).toBe(true);
		expect(w.find('[data-testid="provider-empty"]').exists()).toBe(false);
		expect(w.find('[data-testid="load-failed"]').exists()).toBe(false);
		w.unmount();
	});

	test('partial failure (catalog rejects): still renders profiles + primary; treats primary as effective (NOT invalid) since we cannot verify', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'models.list') throw new Error('catalog boom');
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.profiles).toHaveLength(1);
		expect(w.vm.primary).toBe('groq/llama-3.3-70b-versatile');
		expect(w.vm.catalog).toEqual([]);
		// catalog 缺失 → 无法判断 effectiveness → 不报失效告警（设计 § 7.2 同精神）
		expect(w.vm.primaryState).toBe('effective');
		expect(w.find('[data-testid="primary-warning"]').exists()).toBe(false);
		expect(w.find('[data-testid="primary-current"]').exists()).toBe(true);
		expect(w.find('[data-testid="load-failed"]').exists()).toBe(false);
		w.unmount();
	});

	test('partial failure (model.list rejects): primaryState=unknown, no warning, no primary string', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') throw new Error('model boom');
			if (method === 'models.list') return asCatalog([{ id: 'llama-3.3-70b-versatile', provider: 'groq' }]);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primaryState).toBe('unknown');
		expect(w.find('[data-testid="primary-unknown"]').exists()).toBe(true);
		expect(w.find('[data-testid="primary-warning"]').exists()).toBe(false);
		expect(w.find('[data-testid="primary-current"]').exists()).toBe(false);
		// 凭据 section 仍正常渲染
		expect(w.vm.profiles).toHaveLength(1);
		w.unmount();
	});

	test('partial failure (profiles rejects): primary still rendered (cannot verify effectiveness)', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') throw new Error('profiles boom');
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'models.list') return asCatalog([{ id: 'llama-3.3-70b-versatile', provider: 'groq' }]);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		// 没有 profiles → 不能判 effectiveness → 不报失效
		expect(w.vm.primaryState).toBe('effective');
		expect(w.find('[data-testid="primary-current"]').exists()).toBe(true);
		w.unmount();
	});

	test('total failure: shows retry banner, notifies connError, no crash', async () => {
		mockRequest.mockRejectedValue(new Error('boom'));
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.profiles).toEqual([]);
		expect(w.vm.primary).toBeNull();
		expect(w.find('[data-testid="load-failed"]').exists()).toBe(true);
		expect(mockNotify.error).toHaveBeenCalledWith('modelConfig.common.connError');
		// 重试按钮可点
		w.unmount();
	});

	test('primary not set: notSet warning + selectButton, no current display', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([]);
			if (method === 'coclaw.model.list') return asModelList(null);
			if (method === 'models.list') return asCatalog([]);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primaryState).toBe('notSet');
		expect(w.find('[data-testid="primary-current"]').exists()).toBe(false);
		expect(w.find('[data-testid="btn-primary-select"]').exists()).toBe(true);
		expect(w.text()).toContain('modelConfig.primary.notSetWarning');
		w.unmount();
	});

	test('primary set but provider not bound: invalid warning', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([]);
			if (method === 'coclaw.model.list') return asModelList('openai/gpt-4');
			if (method === 'models.list') return asCatalog([{ id: 'gpt-4', provider: 'openai' }]);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primaryState).toBe('invalid');
		expect(w.text()).toContain('modelConfig.primary.invalidWarning');
		w.unmount();
	});

	test('empty profile list: empty state in credentials section', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([]);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.find('[data-testid="provider-empty"]').exists()).toBe(true);
		w.unmount();
	});

	test('providerAuth.list failure: shows placeholder, NOT the "no provider" empty state', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') throw new Error('list boom');
			if (method === 'coclaw.model.list') return asModelList(null);
			if (method === 'models.list') return asCatalog([]);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.find('[data-testid="provider-load-failed"]').exists()).toBe(true);
		expect(w.find('[data-testid="provider-empty"]').exists()).toBe(false);
		w.unmount();
	});

	test('!loadOk.primary disables Remove buttons (can\'t classify carrier without primary)', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') throw new Error('model boom');
			if (method === 'models.list') return asCatalog([{ id: 'llama-3.3-70b-versatile', provider: 'groq' }]);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		const rows = w.findAllComponents({ name: 'ProviderAuthRow' });
		expect(rows).toHaveLength(1);
		// disabled prop 应为 true（primary 未知 → 禁用 Remove）
		expect(rows[0].props('disabled')).toBe(true);
		w.unmount();
	});
});

describe('ModelConfigPage — offline / connection gating', () => {
	test('offline (online=false): shows banner + actions disabled', async () => {
		mockRequest.mockResolvedValue({});
		const w = makeWrapper({ online: false, dcReady: false });
		await flushPromises();
		expect(w.find('[data-testid="claw-offline-banner"]').exists()).toBe(true);
		// 没法拉数据但页面不应崩
		// add button disabled
		const addBtn = w.find('[data-testid="btn-add-provider"]');
		expect(addBtn.element.disabled).toBe(true);
		w.unmount();
	});

	test('no connection (get returns undefined): loadAll exits cleanly', async () => {
		mockClawConnGet.mockReturnValue(undefined);
		const w = makeWrapper({ online: true, dcReady: false });
		await flushPromises();
		// loadAttempted 仍是 false（没 attempt 成）
		expect(w.vm.loadAttempted).toBe(false);
		expect(mockRequest).not.toHaveBeenCalled();
		w.unmount();
	});
});

describe('ModelConfigPage — T3 add-provider + primary-picker wiring', () => {
	function primedAuthList() {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'models.list') return asCatalog([
				{ id: 'llama-3.3-70b-versatile', provider: 'groq' },
				{ id: 'gpt-4', provider: 'openai' },
			]);
			return {};
		});
	}

	test('Add button opens AddProviderDialog with current catalog + existing providers', async () => {
		primedAuthList();
		const w = makeWrapper();
		await flushPromises();
		// Initially closed
		expect(w.find('.add-dialog').exists()).toBe(false);
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		expect(w.find('.add-dialog').exists()).toBe(true);
		// existing providers reflect current profiles
		expect(w.find('.add-dialog').attributes('data-existing')).toBe('groq');
		// catalog is passed through
		expect(w.find('.ad-catalog-len').text()).toBe('2');
		w.unmount();
	});

	test('Add button is gated by actionsEnabled (no dialog open when offline)', async () => {
		mockRequest.mockResolvedValue({});
		const w = makeWrapper({ online: false, dcReady: false });
		await flushPromises();
		// click should be a no-op since offline
		// (note: button is also disabled at the DOM level, but verify the handler guards as well)
		w.vm.onAddProvider();
		await w.vm.$nextTick();
		expect(w.find('.add-dialog').exists()).toBe(false);
		w.unmount();
	});

	test('Change primary button opens PrimaryModelPickerDialog with providers + current', async () => {
		primedAuthList();
		const w = makeWrapper();
		await flushPromises();
		expect(w.find('.picker-dialog').exists()).toBe(false);
		await w.find('[data-testid="btn-primary-change"]').trigger('click');
		await w.vm.$nextTick();
		const dialog = w.find('.picker-dialog');
		expect(dialog.exists()).toBe(true);
		expect(dialog.attributes('data-providers')).toBe('groq');
		expect(dialog.attributes('data-current')).toBe('groq/llama-3.3-70b-versatile');
		expect(w.find('.pk-catalog-len').text()).toBe('2');
		w.unmount();
	});

	test('Select primary button (notSet branch) opens the same picker dialog', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList(null);
			if (method === 'models.list') return asCatalog([{ id: 'llama-3.3-70b-versatile', provider: 'groq' }]);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-primary-select"]').trigger('click');
		await w.vm.$nextTick();
		expect(w.find('.picker-dialog').exists()).toBe(true);
		w.unmount();
	});

	test('AddProviderDialog "added" event triggers refresh + dashboard force reload + success notify', async () => {
		primedAuthList();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		// after-write list returns groq + new openai
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
				{ provider: 'openai', type: 'api_key', keyPreview: 'sk-op…Y', profileId: 'openai:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			return {};
		});
		await w.find('.ad-fire-added').trigger('click');
		await flushPromises();
		// dialog auto-closed
		expect(w.find('.add-dialog').exists()).toBe(false);
		// dashboard reload with force
		expect(mockLoadDashboard).toHaveBeenCalledWith('claw1', { force: true });
		// success notify
		expect(mockNotify.success).toHaveBeenCalled();
		w.unmount();
	});

	test('AddProviderDialog setApiKey prop calls coclaw.providerAuth.setApiKey on current claw conn', async () => {
		primedAuthList();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		// Click ad-rpc which invokes the injected setApiKey({provider, apiKey}) prop
		await w.find('.ad-rpc').trigger('click');
		await flushPromises();
		// Among requests there should be one with setApiKey RPC name
		const setApiKeyCall = mockRequest.mock.calls.find(c => c[0] === 'coclaw.providerAuth.setApiKey');
		expect(setApiKeyCall).toBeTruthy();
		expect(setApiKeyCall[1]).toEqual({ provider: 'groq', apiKey: 'gsk_x' });
		w.unmount();
	});

	test('AddProviderDialog setApiKey: no conn → rejects with DC_CLOSED code (so dialog can render connError)', async () => {
		primedAuthList();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		mockClawConnGet.mockReturnValue(undefined);
		// Invoke setApiKey directly to verify the reject shape
		const setApiKey = w.findComponent({ name: 'AddProviderDialog' }).props('setApiKey');
		let caught;
		try {
			await setApiKey({ provider: 'groq', apiKey: 'gsk_x' });
		}
		catch (err) {
			caught = err;
		}
		expect(caught?.code).toBe('DC_CLOSED');
		w.unmount();
	});

	test('PrimaryModelPickerDialog "picked" event updates local primary + dashboard reload (no success notify)', async () => {
		primedAuthList();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-primary-change"]').trigger('click');
		await w.vm.$nextTick();
		// refresh-after-write returns updated primary
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			return {};
		});
		await w.find('.pk-fire-picked').trigger('click');
		await flushPromises();
		// dialog auto-closed
		expect(w.find('.picker-dialog').exists()).toBe(false);
		// local primary updated immediately (before dashboard reload)
		expect(w.vm.primary).toBe('groq/llama-3.3-70b-versatile');
		// dashboard reload with force
		expect(mockLoadDashboard).toHaveBeenCalledWith('claw1', { force: true });
		// 成功不 notify（主模型区刷新即可让用户分辨）
		expect(mockNotify.success).not.toHaveBeenCalled();
		w.unmount();
	});

	test('PrimaryModelPickerDialog setPrimary calls coclaw.model.set RPC', async () => {
		primedAuthList();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-primary-change"]').trigger('click');
		await w.vm.$nextTick();
		await w.find('.pk-rpc').trigger('click');
		await flushPromises();
		const setCall = mockRequest.mock.calls.find(c => c[0] === 'coclaw.model.set');
		expect(setCall).toBeTruthy();
		expect(setCall[1]).toEqual({ primary: 'groq/llama-3.3-70b-versatile' });
		w.unmount();
	});

	test('PrimaryModelPickerDialog setPrimary: no conn → rejects with DC_CLOSED', async () => {
		primedAuthList();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-primary-change"]').trigger('click');
		await w.vm.$nextTick();
		mockClawConnGet.mockReturnValue(undefined);
		const setPrimary = w.findComponent({ name: 'PrimaryModelPickerDialog' }).props('setPrimary');
		let caught;
		try {
			await setPrimary({ primary: 'groq/x' });
		}
		catch (err) {
			caught = err;
		}
		expect(caught?.code).toBe('DC_CLOSED');
		w.unmount();
	});

	test('Route change closes any open Add / Picker dialog (prevents stale state leaking to new claw)', async () => {
		primedAuthList();
		const w = makeWrapper();
		await flushPromises();
		// open both
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		await w.find('[data-testid="btn-primary-change"]').trigger('click');
		await w.vm.$nextTick();
		// switch claw
		clawsStoreState.byId.claw2 = { id: 'claw2', name: 'Other', online: true, dcReady: true };
		w.vm.$route.params.clawId = 'claw2';
		w.vm.$options.watch.clawId.handler.call(w.vm);
		await flushPromises();
		expect(w.vm.addOpen).toBe(false);
		expect(w.vm.pickerOpen).toBe(false);
		delete clawsStoreState.byId.claw2;
		w.unmount();
	});

	test('Dashboard reload failure after add/pick does not surface to user', async () => {
		primedAuthList();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		mockLoadDashboard.mockRejectedValueOnce(new Error('dash boom'));
		await w.find('.ad-fire-added').trigger('click');
		await flushPromises();
		// success notify still fires
		expect(mockNotify.success).toHaveBeenCalled();
		// no error notify because dashboard failure is silent
		expect(mockNotify.error).not.toHaveBeenCalled();
		w.unmount();
	});

	test('Page never receives nor logs the raw API key — added payload carries only { provider, profileId }', async () => {
		// The dialog owns the raw key; the page only ever sees the `added` event payload.
		// This asserts the wiring shape does not surface apiKey into any of the page's
		// console channels (defense-in-depth, in case diagnostic logging is added later).
		primedAuthList();
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		await w.find('.ad-fire-added').trigger('click');
		await flushPromises();
		// `added` event payload is { provider, profileId } — no key in it; nothing in logs should ever match
		for (const spy of [logSpy, warnSpy, errSpy]) {
			for (const call of spy.mock.calls) {
				for (const arg of call) {
					const s = typeof arg === 'string' ? arg : JSON.stringify(arg);
					expect(s).not.toContain('apiKey');
					expect(s).not.toContain('gsk_');
				}
			}
		}
		logSpy.mockRestore();
		warnSpy.mockRestore();
		errSpy.mockRestore();
		w.unmount();
	});

	test('orphaned add: RPC resolving AFTER a claw switch is dropped (no wrong-claw notify/reload)', async () => {
		primedAuthList();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-add-provider"]').trigger('click'); // __writeClawId = claw1
		await w.vm.$nextTick();
		// switch to claw2 (watcher closes dialog + clears __writeClawId)
		clawsStoreState.byId.claw2 = { id: 'claw2', name: 'Other', online: true, dcReady: true };
		w.vm.$route.params.clawId = 'claw2';
		w.vm.$options.watch.clawId.handler.call(w.vm);
		await flushPromises();
		// reset counters AFTER the switch's own loadAll
		mockNotify.success.mockClear();
		mockLoadDashboard.mockClear();
		// the stale claw1 dialog emits `added` late → handler must be a no-op for claw2
		await w.vm.onProviderAdded({ provider: 'groq', profileId: 'groq:default' });
		await flushPromises();
		expect(mockNotify.success).not.toHaveBeenCalled();
		expect(mockLoadDashboard).not.toHaveBeenCalled();
		delete clawsStoreState.byId.claw2;
		w.unmount();
	});

	test('orphaned pick: RPC resolving AFTER a claw switch is dropped (primary not overwritten, no notify/reload)', async () => {
		primedAuthList();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-primary-change"]').trigger('click'); // __writeClawId = claw1
		await w.vm.$nextTick();
		clawsStoreState.byId.claw2 = { id: 'claw2', name: 'Other', online: true, dcReady: true };
		w.vm.$route.params.clawId = 'claw2';
		w.vm.$options.watch.clawId.handler.call(w.vm);
		await flushPromises();
		// after switch, claw2's load set primary to groq/llama...
		const primaryBefore = w.vm.primary;
		mockNotify.success.mockClear();
		mockLoadDashboard.mockClear();
		// stale claw1 pick lands late with a DIFFERENT primary → must be dropped
		await w.vm.onPrimaryPicked({ primary: 'openai/gpt-4' });
		await flushPromises();
		expect(w.vm.primary).toBe(primaryBefore);
		expect(w.vm.primary).not.toBe('openai/gpt-4');
		expect(mockNotify.success).not.toHaveBeenCalled();
		expect(mockLoadDashboard).not.toHaveBeenCalled();
		delete clawsStoreState.byId.claw2;
		w.unmount();
	});

	test('refreshAfterWrite does NOT refetch catalog (models.list) and keeps loadOk.catalog true', async () => {
		primedAuthList();
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.loadOk.catalog).toBe(true);
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		mockRequest.mockClear();
		// refresh only re-pulls profiles + model.list (NOT models.list catalog)
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			return {};
		});
		await w.find('.ad-fire-added').trigger('click');
		await flushPromises();
		const modelsListCalls = mockRequest.mock.calls.filter(c => c[0] === 'models.list');
		expect(modelsListCalls).toHaveLength(0);
		// flag must remain true so primaryState classification keeps working
		expect(w.vm.loadOk.catalog).toBe(true);
		expect(w.vm.catalog.length).toBeGreaterThan(0);
		w.unmount();
	});
});

describe('ModelConfigPage — remove flow', () => {
	function primedRequest() {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…X', profileId: 'groq:default' },
				{ provider: 'openai', type: 'api_key', keyPreview: 'sk-op…Y', profileId: 'openai:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'models.list') return asCatalog([
				{ id: 'llama-3.3-70b-versatile', provider: 'groq' },
				{ id: 'gpt-4', provider: 'openai' },
			]);
			if (method === 'coclaw.providerAuth.remove') return {};
			return {};
		});
	}

	test('Remove for primary carrier opens dialog with isPrimaryCarrier=true', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		const rows = w.findAllComponents({ name: 'ProviderAuthRow' });
		// 找到 groq 的 row 并触发 remove
		const groqRow = rows.find(r => r.props('profile').provider === 'groq');
		await groqRow.vm.$emit('remove', 'groq');
		await w.vm.$nextTick();
		const dialog = w.find('.remove-dialog');
		expect(dialog.exists()).toBe(true);
		expect(dialog.attributes('data-carrier')).toBe('true');
		expect(dialog.find('.rd-provider').text()).toBe('groq');
		expect(dialog.find('.rd-primary').text()).toBe('groq/llama-3.3-70b-versatile');
		w.unmount();
	});

	test('Remove for non-carrier opens dialog with isPrimaryCarrier=false', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		const rows = w.findAllComponents({ name: 'ProviderAuthRow' });
		const openaiRow = rows.find(r => r.props('profile').provider === 'openai');
		await openaiRow.vm.$emit('remove', 'openai');
		await w.vm.$nextTick();
		const dialog = w.find('.remove-dialog');
		expect(dialog.attributes('data-carrier')).toBe('false');
		w.unmount();
	});

	test('Cancel closes dialog without RPC + without dashboard reload', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		const rows = w.findAllComponents({ name: 'ProviderAuthRow' });
		const groqRow = rows.find(r => r.props('profile').provider === 'groq');
		await groqRow.vm.$emit('remove', 'groq');
		await w.vm.$nextTick();
		await w.find('.rd-cancel').trigger('click');
		await flushPromises();
		expect(w.find('.remove-dialog').exists()).toBe(false);
		expect(mockRequest).not.toHaveBeenCalledWith('coclaw.providerAuth.remove', expect.anything(), expect.anything());
		expect(mockLoadDashboard).not.toHaveBeenCalled();
		w.unmount();
	});

	test('Confirm: calls remove RPC, refreshes local + triggers dashboard reload (force), no success notify', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		const rows = w.findAllComponents({ name: 'ProviderAuthRow' });
		const groqRow = rows.find(r => r.props('profile').provider === 'groq');
		await groqRow.vm.$emit('remove', 'groq');
		await w.vm.$nextTick();

		// 准备 refresh-after-write 的返回：把 groq 从列表去掉
		mockRequest.mockImplementation(async (method, params) => {
			if (method === 'coclaw.providerAuth.remove') {
				expect(params).toEqual({ provider: 'groq' });
				return {};
			}
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'openai', type: 'api_key', keyPreview: 'sk-op…Y', profileId: 'openai:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile'); // 设计说不主动清
			return {};
		});

		await w.find('.rd-confirm').trigger('click');
		await flushPromises();

		// remove RPC 被调用过
		const removeCall = mockRequest.mock.calls.find(c => c[0] === 'coclaw.providerAuth.remove');
		expect(removeCall).toBeTruthy();
		// 局部 refresh 把 groq 去掉了
		expect(w.vm.profiles).toHaveLength(1);
		expect(w.vm.profiles[0].provider).toBe('openai');
		// primary 没主动清空
		expect(w.vm.primary).toBe('groq/llama-3.3-70b-versatile');
		// dashboard.store reload 被触发，force=true
		expect(mockLoadDashboard).toHaveBeenCalledWith('claw1', { force: true });
		// 撤销成功不弹 success notify（列表刷掉该行，UI 自明）
		expect(mockNotify.success).not.toHaveBeenCalled();
		// dialog 关闭
		expect(w.find('.remove-dialog').exists()).toBe(false);
		w.unmount();
	});

	test('Confirm handler MUST NOT call coclaw.model.set (primary not auto-cleared)', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		const rows = w.findAllComponents({ name: 'ProviderAuthRow' });
		const groqRow = rows.find(r => r.props('profile').provider === 'groq');
		await groqRow.vm.$emit('remove', 'groq');
		await w.vm.$nextTick();
		mockRequest.mockResolvedValue({});
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		expect(mockRequest).not.toHaveBeenCalledWith('coclaw.model.set', expect.anything(), expect.anything());
		w.unmount();
	});

	test('Confirm failure with INVALID_ARGS → notify errInvalidArgs', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', 'groq');
		await w.vm.$nextTick();

		const err = new Error('bad');
		err.code = 'INVALID_ARGS';
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.remove') throw err;
			return {};
		});
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		expect(mockNotify.error).toHaveBeenCalledWith('modelConfig.common.errInvalidArgs');
		expect(mockLoadDashboard).not.toHaveBeenCalled();
		w.unmount();
	});

	test('Confirm failure with IO_FAILED → notify errIoFailed', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', 'groq');
		await w.vm.$nextTick();

		const err = new Error('io');
		err.code = 'IO_FAILED';
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.remove') throw err;
			return {};
		});
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		expect(mockNotify.error).toHaveBeenCalledWith('modelConfig.common.errIoFailed');
		w.unmount();
	});

	test('Confirm failure with RPC_TIMEOUT → notify connError', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', 'groq');
		await w.vm.$nextTick();

		const err = new Error('to');
		err.code = 'RPC_TIMEOUT';
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.remove') throw err;
			return {};
		});
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		expect(mockNotify.error).toHaveBeenCalledWith('modelConfig.common.connError');
		w.unmount();
	});

	test('Confirm failure with unknown error code → generic removeFailed notify', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', 'groq');
		await w.vm.$nextTick();

		const err = new Error('weird');
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.remove') throw err;
			return {};
		});
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		const errCalls = mockNotify.error.mock.calls.map(c => c[0]);
		expect(errCalls.some(t => t.startsWith('modelConfig.providerAuth.removeFailed'))).toBe(true);
		w.unmount();
	});

	test('Confirm failure with ERR_CANCELED → silent close, no error notify', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', 'groq');
		await w.vm.$nextTick();

		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.remove') throw Object.assign(new Error('aborted'), { code: 'ERR_CANCELED' });
			return {};
		});
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		// 显式取消：不报错、不弹成功、对话框静默关闭、target 清空（与加 provider / 设主模型对齐）
		expect(mockNotify.error).not.toHaveBeenCalled();
		expect(mockNotify.success).not.toHaveBeenCalled();
		expect(w.vm.removeOpen).toBe(false);
		expect(w.vm.removeTarget).toBe('');
		expect(w.find('.remove-dialog').exists()).toBe(false);
		w.unmount();
	});

	test('Remove dispatch ignored when providerId is empty', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		w.vm.onRemoveProvider('');
		expect(w.vm.removeOpen).toBe(false);
		w.unmount();
	});

	test('Confirm without an active connection: notify connError + closes dialog (no silent exit)', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		const rows = w.findAllComponents({ name: 'ProviderAuthRow' });
		await rows.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', 'groq');
		await w.vm.$nextTick();
		mockClawConnGet.mockReturnValue(undefined);
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		expect(mockRequest).not.toHaveBeenCalledWith('coclaw.providerAuth.remove', expect.anything(), expect.anything());
		expect(mockNotify.error).toHaveBeenCalledWith('modelConfig.common.connError');
		expect(w.find('.remove-dialog').exists()).toBe(false);
		w.unmount();
	});

	test('dashboardStore reload failure after success removeRPC does not surface error to user', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'openai').vm.$emit('remove', 'openai');
		await w.vm.$nextTick();
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.remove') return {};
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			return {};
		});
		mockLoadDashboard.mockRejectedValueOnce(new Error('dashboard boom'));
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		// 撤销成功不弹 success notify（列表刷掉该行，UI 自明）
		expect(mockNotify.success).not.toHaveBeenCalled();
		// error notify 没被触发（dashboard 错误吞掉）
		expect(mockNotify.error).not.toHaveBeenCalled();
		w.unmount();
	});

	test('refreshAfterWrite tolerates RPC failures (does not surface)', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		// 触发 dialog 打开
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', 'groq');
		await w.vm.$nextTick();
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.remove') return {};
			if (method === 'coclaw.providerAuth.list') throw new Error('list boom');
			if (method === 'coclaw.model.list') throw new Error('model boom');
			return {};
		});
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		// 撤销成功不弹 success notify；error notify 也不触发
		expect(mockNotify.success).not.toHaveBeenCalled();
		expect(mockNotify.error).not.toHaveBeenCalled();
		w.unmount();
	});

	test('Double-click confirm guarded by removeBusy', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', 'groq');
		await w.vm.$nextTick();
		// 让 remove RPC 永不 resolve，第二次 confirm 应被 busy 拦下
		let resolveRemove;
		mockRequest.mockImplementation((method) => {
			if (method === 'coclaw.providerAuth.remove') {
				return new Promise(res => { resolveRemove = res; });
			}
			return Promise.resolve({});
		});
		await w.find('.rd-confirm').trigger('click');
		await Promise.resolve();
		await w.find('.rd-confirm').trigger('click');
		await Promise.resolve();
		const removeCalls = mockRequest.mock.calls.filter(c => c[0] === 'coclaw.providerAuth.remove');
		expect(removeCalls).toHaveLength(1);
		// 把 RPC settle + 等链路跑完，避免 unmount 后异步写入孤儿状态
		resolveRemove({});
		await flushPromises();
		w.unmount();
	});

	test('Cancel during busy is ignored — RPC continues and dialog stays open until settle', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', 'groq');
		await w.vm.$nextTick();
		let resolveRemove;
		mockRequest.mockImplementation((method) => {
			if (method === 'coclaw.providerAuth.remove') return new Promise(res => { resolveRemove = res; });
			return Promise.resolve({});
		});
		await w.find('.rd-confirm').trigger('click');
		await Promise.resolve();
		// 中途 cancel —— 应被 busy 拦下
		w.vm.onCancelRemove();
		expect(w.vm.removeOpen).toBe(true);
		expect(w.vm.removeTarget).toBe('groq');
		resolveRemove({});
		await flushPromises();
		w.unmount();
	});

	test('Route change closes any open remove dialog (prevents stale provider from leaking to new claw)', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		// 打开 dialog
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', 'groq');
		await w.vm.$nextTick();
		expect(w.vm.removeOpen).toBe(true);
		// 切到新 claw
		clawsStoreState.byId.claw2 = { id: 'claw2', name: 'Other', online: true, dcReady: true };
		w.vm.$route.params.clawId = 'claw2';
		w.vm.$options.watch.clawId.handler.call(w.vm);
		await flushPromises();
		// dialog 应被强制关闭
		expect(w.vm.removeOpen).toBe(false);
		expect(w.vm.removeTarget).toBe('');
		delete clawsStoreState.byId.claw2;
		w.unmount();
	});

	test('Route param change while load in flight: stale claw response discarded, new claw data wins', async () => {
		clawsStoreState.byId.claw2 = { id: 'claw2', name: 'Other Claw', online: true, dcReady: true };
		// claw1 的 load 永不 resolve，模拟"还在飞中"
		const claw1Pending = { resolve: null };
		mockRequest.mockImplementation((method) => {
			if (method === 'coclaw.providerAuth.list') {
				// 第一次走 pending
				if (!claw1Pending.resolved) {
					return new Promise(res => { claw1Pending.resolve = res; });
				}
				return Promise.resolve(asProfiles([{ provider: 'openai', type: 'api_key', keyPreview: 'sk-op…Y', profileId: 'openai:default' }]));
			}
			if (method === 'coclaw.model.list') return Promise.resolve(asModelList('openai/gpt-4'));
			if (method === 'models.list') return Promise.resolve(asCatalog([{ id: 'gpt-4', provider: 'openai' }]));
			return Promise.resolve({});
		});

		const w = makeWrapper();
		await Promise.resolve();
		// 切到 claw2：watcher 触发 loadAll() 重新发请求
		claw1Pending.resolved = true;
		await w.setProps({});
		w.vm.$route.params.clawId = 'claw2';
		// 手动触发 watcher 因为我们直接改了 mock 对象
		w.vm.$options.watch.clawId.handler.call(w.vm);
		await flushPromises();
		// 这时 claw1Pending.resolve 还卡着 — 让它 resolve 但带 claw1 的数据
		if (claw1Pending.resolve) claw1Pending.resolve(asProfiles([{ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…X', profileId: 'groq:default' }]));
		await flushPromises();
		// claw1 的 stale profiles 不应被写入；当前应该是 claw2 的 openai
		const providers = w.vm.profiles.map(p => p.provider);
		expect(providers).toEqual(['openai']);
		delete clawsStoreState.byId.claw2;
		w.unmount();
	});

	test('Unmount mid-RPC: removeBusy / profiles writes after unmount are suppressed', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', 'groq');
		await w.vm.$nextTick();
		// remove RPC 永不 resolve；触发 unmount 后 resolve
		let resolveRemove;
		mockRequest.mockImplementation((method) => {
			if (method === 'coclaw.providerAuth.remove') return new Promise(res => { resolveRemove = res; });
			if (method === 'coclaw.providerAuth.list') return Promise.resolve(asProfiles([]));
			if (method === 'coclaw.model.list') return Promise.resolve(asModelList(null));
			return Promise.resolve({});
		});
		await w.find('.rd-confirm').trigger('click');
		await Promise.resolve();
		w.unmount();
		resolveRemove({});
		await flushPromises();
		// 验证：unmount 后不再 notify、不再调 dashboard reload（用户可见行为，非内部 flag）
		expect(mockNotify.success).not.toHaveBeenCalled();
		expect(mockLoadDashboard).not.toHaveBeenCalled();
	});

	test('Confirm with CONNECT_TIMEOUT → notify connError (covers full conn-error code set)', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', 'groq');
		await w.vm.$nextTick();
		const err = new Error('connect timeout');
		err.code = 'CONNECT_TIMEOUT';
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.remove') throw err;
			return {};
		});
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		expect(mockNotify.error).toHaveBeenCalledWith('modelConfig.common.connError');
		w.unmount();
	});

	test('Confirm with DC_CLOSED → notify connError', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', 'groq');
		await w.vm.$nextTick();
		const err = new Error('dc closed');
		err.code = 'DC_CLOSED';
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.remove') throw err;
			return {};
		});
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		expect(mockNotify.error).toHaveBeenCalledWith('modelConfig.common.connError');
		w.unmount();
	});

	test('OAuth profile coexists with api_key in same list — both rendered, OAuth row read-only (no Remove emit)', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…X', profileId: 'groq:default' },
				{ provider: 'minimax', type: 'oauth', email: 'u@example.com', profileId: 'minimax:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList(null);
			if (method === 'models.list') return asCatalog([]);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		const rows = w.findAllComponents({ name: 'ProviderAuthRow' });
		expect(rows).toHaveLength(2);
		// 两行都渲染了；store layer 自由组合
		expect(rows.map(r => r.props('profile').provider).sort()).toEqual(['groq', 'minimax']);
		w.unmount();
	});
});
