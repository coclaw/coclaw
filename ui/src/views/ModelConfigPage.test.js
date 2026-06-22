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

// dialog 子组件 stub —— 页面接线测试直接驱动它们的事件
vi.mock('../components/model-config/AddProviderDialog.vue', () => ({
	default: {
		name: 'AddProviderDialog',
		props: ['open', 'catalog', 'existingProviders', 'setApiKey', 'loginOauth', 'cancelOauth'],
		emits: ['update:open', 'added'],
		template: `
			<div v-if="open" class="add-dialog" :data-existing="(existingProviders||[]).join(',')" :data-has-login="String(!!loginOauth)" :data-has-cancel="String(!!cancelOauth)">
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
		props: ['open', 'usable', 'current', 'setPrimary'],
		emits: ['update:open', 'picked', 'add-provider'],
		template: `
			<div v-if="open" class="picker-dialog"
				:data-current="current||''"
				:data-usable="Object.keys(usable||{}).join(',')"
			>
				<button class="pk-fire-picked" @click="$emit('picked', { primary: 'groq/llama-3.3-70b-versatile' }); $emit('update:open', false)">picked</button>
				<button class="pk-fire-add" @click="$emit('add-provider')">add</button>
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
	// 真实导出：供页面 import 的 computePrimaryEffective（决策4 新签名 (primary, available)）
	computePrimaryEffective: (primary, available) => {
		if (!primary || typeof primary !== 'string') return null;
		const idx = primary.indexOf('/');
		if (idx <= 0 || idx === primary.length - 1) return null;
		if (!available || typeof available !== 'object') return null;
		const provider = primary.slice(0, idx);
		const model = primary.slice(idx + 1);
		const ids = Array.isArray(available[provider]) ? available[provider] : [];
		return ids.includes(model);
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
						<div class="provider-row" :data-provider="profile?.provider" :data-source="profile?.source">
							<button class="row-remove" :disabled="disabled" @click="$emit('remove', { provider: profile?.provider ?? '', source: profile?.source ?? 'profile' })">x</button>
						</div>
					`,
				},
			},
		},
	});
}

function asProfiles(arr) { return { profiles: arr }; }
/** coclaw.model.list 出参：本页只读 default.primary（primary 有效性改由 listAvailable 判，决策4） */
function asModelList(primary) {
	return { default: { primary }, agents: { main: { primary: null } } };
}
/**
 * coclaw.providerAuth.catalog 出参。
 * @param {Array<[string, boolean, string[]?]>} specs - [provider, hasCred, authMethods?] 列表
 */
function asCatalog(specs = []) {
	return {
		providers: specs.map(([provider, hasCred, authMethods]) => ({
			provider,
			authMethods: authMethods || ['api-key'],
			hasCred: !!hasCred,
		})),
	};
}
/** coclaw.model.listAvailable 出参（决策4 去掉 configuredProviders，只剩 byProvider） */
function asAvailable(byProvider = {}) { return { byProvider }; }

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
		clawsStoreState.byId.claw1.name = null;
		mockRequest.mockResolvedValue({});
		const w = makeWrapper();
		expect(w.find('.mobile-header').text()).toContain('claw1');
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
		const orig = history.state;
		history.replaceState({ ...history.state, back: null }, '');
		w.vm.goBack();
		expect(replace).toHaveBeenCalledWith('/claws');
		history.replaceState(orig, '');
		w.unmount();
	});

	test('desktop back button exposes a translated accessible name (aria-label)', async () => {
		mockRequest.mockResolvedValue({});
		const w = makeWrapper();
		// 定位桌面 header 返回键：icon 作为透传属性渲染到 <button>，locator 不依赖 aria-label 本身
		const back = w.find('button[icon="i-lucide-arrow-left"]');
		expect(back.exists()).toBe(true);
		const label = back.attributes('aria-label');
		// locale 安全：断言存在且等于组件取的 $t('common.back')（mock 回传 key），不硬编码英文
		expect(label).toBeTruthy();
		expect(label).toBe('common.back');
		w.unmount();
	});
});

describe('ModelConfigPage — initial load races', () => {
	test('four RPCs succeed: renders primary + profiles; primary in available → effective', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true], ['openai', false]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['llama-3.3-70b-versatile'] });
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.profiles).toHaveLength(1);
		expect(w.vm.primary).toBe('groq/llama-3.3-70b-versatile');
		expect(w.vm.providerCatalog).toHaveLength(2);
		expect(w.vm.available).toEqual({ groq: ['llama-3.3-70b-versatile'] });
		expect(w.vm.primaryState).toBe('effective');
		expect(w.find('[data-testid="primary-current"]').exists()).toBe(true);
		expect(w.find('[data-testid="provider-empty"]').exists()).toBe(false);
		expect(w.find('[data-testid="load-failed"]').exists()).toBe(false);
		w.unmount();
	});

	test('partial failure (providerAuth.catalog rejects): page still renders, primary effective, add-list empty, NOT fullyFailed', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'coclaw.providerAuth.catalog') throw new Error('catalog boom');
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['llama-3.3-70b-versatile'] });
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.providerCatalog).toEqual([]);
		expect(w.vm.loadOk.catalogProviders).toBe(false);
		// 可用清单到位且 primary 在内 → effective（catalog 与 primary 有效性解耦）
		expect(w.vm.primaryState).toBe('effective');
		expect(w.find('[data-testid="load-failed"]').exists()).toBe(false);
		expect(w.find('[data-testid="primary-current"]').exists()).toBe(true);
		w.unmount();
	});

	test('partial failure (listAvailable rejects): available not ready → primary effective (cannot conclude)', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true]]);
			if (method === 'coclaw.model.listAvailable') throw new Error('available boom');
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		// 可用清单未就绪（null）→ 先不下结论 → effective（不误报失效）
		expect(w.vm.available).toBeNull();
		expect(w.vm.primaryState).toBe('effective');
		expect(w.find('[data-testid="primary-warning"]').exists()).toBe(false);
		expect(w.find('[data-testid="primary-current"]').exists()).toBe(true);
		w.unmount();
	});

	test('partial failure (model.list rejects): primaryState=unknown, no warning, no primary string', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') throw new Error('model boom');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['llama-3.3-70b-versatile'] });
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primaryState).toBe('unknown');
		expect(w.find('[data-testid="primary-unknown"]').exists()).toBe(true);
		expect(w.find('[data-testid="primary-warning"]').exists()).toBe(false);
		expect(w.find('[data-testid="primary-current"]').exists()).toBe(false);
		expect(w.vm.profiles).toHaveLength(1);
		w.unmount();
	});

	test('partial failure (profiles rejects): primary still rendered + effective', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') throw new Error('profiles boom');
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['llama-3.3-70b-versatile'] });
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
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
		w.unmount();
	});

	test('primary not set: notSet warning + configure button, no current display', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([]);
			if (method === 'coclaw.model.list') return asModelList(null);
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({});
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primaryState).toBe('notSet');
		expect(w.find('[data-testid="primary-current"]').exists()).toBe(false);
		expect(w.find('[data-testid="btn-primary"]').exists()).toBe(true);
		expect(w.text()).toContain('modelConfig.primary.notSetWarning');
		w.unmount();
	});

	test('primary set but its provider absent from available (no credential) → invalid warning', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([]);
			if (method === 'coclaw.model.list') return asModelList('openai/gpt-4');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['openai', false]]);
			// 可用清单就绪但不含 openai → membership false → 失效
			if (method === 'coclaw.model.listAvailable') return asAvailable({});
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primaryState).toBe('invalid');
		expect(w.text()).toContain('modelConfig.primary.invalidWarning');
		w.unmount();
	});

	test('primary provider present but model not in available (模型下架) → invalid warning', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-deprecated');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true]]);
			// groq 在清单但只有别的 model → 主模型那条不在 → 失效
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['llama-3.3-70b-versatile'] });
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
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({});
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
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['llama-3.3-70b-versatile'] });
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		const rows = w.findAllComponents({ name: 'ProviderAuthRow' });
		expect(rows).toHaveLength(1);
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
		const addBtn = w.find('[data-testid="btn-add-provider"]');
		expect(addBtn.element.disabled).toBe(true);
		w.unmount();
	});

	test('no connection (get returns undefined): loadAll exits cleanly', async () => {
		mockClawConnGet.mockReturnValue(undefined);
		const w = makeWrapper({ online: true, dcReady: false });
		await flushPromises();
		expect(w.vm.loadAttempted).toBe(false);
		expect(mockRequest).not.toHaveBeenCalled();
		w.unmount();
	});

	test('switch to a no-connection claw while a load is in flight resets loading (no stuck initialLoading)', async () => {
		let resolveFirst;
		const firstPending = new Promise((res) => { resolveFirst = res; });
		mockRequest.mockImplementation(() => firstPending);

		const w = makeWrapper();
		await Promise.resolve();
		expect(w.vm.loading).toBe(true);

		mockClawConnGet.mockReturnValue(undefined);
		w.vm.$options.watch.clawId.handler.call(w.vm);
		await flushPromises();

		expect(w.vm.loading).toBe(false);
		expect(w.vm.initialLoading).toBe(false);

		resolveFirst(asProfiles([]));
		await flushPromises();
		expect(w.vm.loading).toBe(false);

		w.unmount();
	});
});

describe('ModelConfigPage — add-provider + primary-picker wiring', () => {
	function primed() {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true], ['openai', false]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['llama-3.3-70b-versatile'] });
			return {};
		});
	}

	test('Add button opens AddProviderDialog with provider catalog + hasCred-derived exclusion', async () => {
		primed();
		const w = makeWrapper();
		await flushPromises();
		expect(w.find('.add-dialog').exists()).toBe(false);
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		expect(w.find('.add-dialog').exists()).toBe(true);
		// 排除集 = catalog 中 hasCred===true（groq 已配）
		expect(w.find('.add-dialog').attributes('data-existing')).toBe('groq');
		// 整个 provider catalog 透传
		expect(w.find('.ad-catalog-len').text()).toBe('2');
		w.unmount();
	});

	test('Add button is gated by actionsEnabled (no dialog open when offline)', async () => {
		mockRequest.mockResolvedValue({});
		const w = makeWrapper({ online: false, dcReady: false });
		await flushPromises();
		w.vm.onAddProvider();
		await w.vm.$nextTick();
		expect(w.find('.add-dialog').exists()).toBe(false);
		w.unmount();
	});

	test('Change primary button opens PrimaryModelPickerDialog with usable (available) + current', async () => {
		primed();
		const w = makeWrapper();
		await flushPromises();
		expect(w.find('.picker-dialog').exists()).toBe(false);
		await w.find('[data-testid="btn-primary"]').trigger('click');
		await w.vm.$nextTick();
		const dialog = w.find('.picker-dialog');
		expect(dialog.exists()).toBe(true);
		expect(dialog.attributes('data-current')).toBe('groq/llama-3.3-70b-versatile');
		expect(dialog.attributes('data-usable')).toBe('groq');
		w.unmount();
	});

	test('Configure button (notSet branch) opens the same picker dialog', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList(null);
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['llama-3.3-70b-versatile'] });
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-primary"]').trigger('click');
		await w.vm.$nextTick();
		expect(w.find('.picker-dialog').exists()).toBe(true);
		w.unmount();
	});

	test('picker "add-provider" event closes picker + opens AddProviderDialog (one-way)', async () => {
		primed();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-primary"]').trigger('click');
		await w.vm.$nextTick();
		expect(w.find('.picker-dialog').exists()).toBe(true);
		expect(w.find('.add-dialog').exists()).toBe(false);
		await w.find('.pk-fire-add').trigger('click');
		await w.vm.$nextTick();
		expect(w.vm.pickerOpen).toBe(false);
		expect(w.vm.addOpen).toBe(true);
		expect(w.find('.picker-dialog').exists()).toBe(false);
		expect(w.find('.add-dialog').exists()).toBe(true);
		w.unmount();
	});

	test('AddProviderDialog "added" event triggers refresh + dashboard force reload (no success notify)', async () => {
		primed();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
				{ provider: 'openai', type: 'api_key', keyPreview: 'sk-op…Y', profileId: 'openai:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true], ['openai', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['llama-3.3-70b-versatile'], openai: ['gpt-4'] });
			return {};
		});
		await w.find('.ad-fire-added').trigger('click');
		await flushPromises();
		expect(w.find('.add-dialog').exists()).toBe(false);
		expect(mockLoadDashboard).toHaveBeenCalledWith('claw1', { force: true });
		expect(mockNotify.success).not.toHaveBeenCalled();
		w.unmount();
	});

	test('AddProviderDialog setApiKey prop calls coclaw.providerAuth.setApiKey on current claw conn', async () => {
		primed();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		await w.find('.ad-rpc').trigger('click');
		await flushPromises();
		const setApiKeyCall = mockRequest.mock.calls.find(c => c[0] === 'coclaw.providerAuth.setApiKey');
		expect(setApiKeyCall).toBeTruthy();
		expect(setApiKeyCall[1]).toEqual({ provider: 'groq', apiKey: 'gsk_x' });
		w.unmount();
	});

	test('AddProviderDialog setApiKey: no conn → rejects with DC_CLOSED code', async () => {
		primed();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		mockClawConnGet.mockReturnValue(undefined);
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

	test('AddProviderDialog loginOauth / cancelOauth props are wired to the OAuth RPCs on current claw conn', async () => {
		primed();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		// 两阶段登录函数透传到 dialog
		expect(w.find('.add-dialog').attributes('data-has-login')).toBe('true');
		expect(w.find('.add-dialog').attributes('data-has-cancel')).toBe('true');
		const dialog = w.findComponent({ name: 'AddProviderDialog' });
		const loginOauth = dialog.props('loginOauth');
		const cancelOauth = dialog.props('cancelOauth');
		const onAccepted = vi.fn();
		const signal = new AbortController().signal;
		mockRequest.mockClear();
		mockRequest.mockResolvedValue({ status: 'ok', profileIds: ['github-copilot:default'] });
		await loginOauth({ provider: 'github-copilot', onAccepted, signal });
		const loginCall = mockRequest.mock.calls.find(c => c[0] === 'coclaw.providerAuth.loginOauth');
		expect(loginCall).toBeTruthy();
		expect(loginCall[1]).toEqual({ provider: 'github-copilot' });
		expect(loginCall[2].onAccepted).toBe(onAccepted);
		expect(loginCall[2].signal).toBe(signal);
		// 账号授权要等用户授权，不设 RPC 超时
		expect(loginCall[2].timeout).toBe(0);

		await cancelOauth({ loginId: 'L1' });
		const cancelCall = mockRequest.mock.calls.find(c => c[0] === 'coclaw.providerAuth.cancelOauth');
		expect(cancelCall).toBeTruthy();
		expect(cancelCall[1]).toEqual({ loginId: 'L1' });
		w.unmount();
	});

	test('AddProviderDialog loginOauth: no conn → rejects DC_CLOSED; cancelOauth: no conn → resolves (best-effort)', async () => {
		primed();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		mockClawConnGet.mockReturnValue(undefined);
		const dialog = w.findComponent({ name: 'AddProviderDialog' });
		const loginOauth = dialog.props('loginOauth');
		const cancelOauth = dialog.props('cancelOauth');
		let caught;
		try {
			await loginOauth({ provider: 'x', onAccepted: () => {}, signal: undefined });
		}
		catch (err) {
			caught = err;
		}
		expect(caught?.code).toBe('DC_CLOSED');
		// 取消 best-effort：无连接静默 resolve（不抛），保证组件清理路径不崩
		await expect(cancelOauth({ loginId: 'L1' })).resolves.toBeDefined();
		w.unmount();
	});

	test('cancelOauth targets the claw the login STARTED on (not the current claw after a switch)', async () => {
		primed();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		const dialog = w.findComponent({ name: 'AddProviderDialog' });
		const loginOauth = dialog.props('loginOauth');
		const cancelOauth = dialog.props('cancelOauth');
		// 在 claw1 发起登录 → 记下 __oauthClawId=claw1
		mockRequest.mockResolvedValue({});
		loginOauth({ provider: 'github-copilot', onAccepted: () => {}, signal: new AbortController().signal });
		// 切到 claw2（路由变 → 子页清状态、关 dialog）；__oauthClawId 不随之清，仍指 claw1
		clawsStoreState.byId.claw2 = { id: 'claw2', name: 'Other', online: true, dcReady: true };
		w.vm.$route.params.clawId = 'claw2';
		w.vm.$options.watch.clawId.handler.call(w.vm);
		await flushPromises();
		// 卸载清理触发 cancelOauth：必须定位登录时那台 claw1，否则原 claw 后台轮询成孤儿
		mockClawConnGet.mockClear();
		await cancelOauth({ loginId: 'L1' });
		expect(mockClawConnGet).toHaveBeenCalledWith('claw1');
		expect(mockClawConnGet).not.toHaveBeenCalledWith('claw2');
		delete clawsStoreState.byId.claw2;
		w.unmount();
	});

	test('PrimaryModelPickerDialog "picked" event updates local primary + dashboard reload (no success notify)', async () => {
		primed();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-primary"]').trigger('click');
		await w.vm.$nextTick();
		await w.find('.pk-fire-picked').trigger('click');
		await flushPromises();
		expect(w.find('.picker-dialog').exists()).toBe(false);
		expect(w.vm.primary).toBe('groq/llama-3.3-70b-versatile');
		expect(mockLoadDashboard).toHaveBeenCalledWith('claw1', { force: true });
		expect(mockNotify.success).not.toHaveBeenCalled();
		w.unmount();
	});

	test('PrimaryModelPickerDialog setPrimary calls coclaw.model.set RPC', async () => {
		primed();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-primary"]').trigger('click');
		await w.vm.$nextTick();
		await w.find('.pk-rpc').trigger('click');
		await flushPromises();
		const setCall = mockRequest.mock.calls.find(c => c[0] === 'coclaw.model.set');
		expect(setCall).toBeTruthy();
		expect(setCall[1]).toEqual({ primary: 'groq/llama-3.3-70b-versatile' });
		w.unmount();
	});

	test('PrimaryModelPickerDialog setPrimary: no conn → rejects with DC_CLOSED', async () => {
		primed();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-primary"]').trigger('click');
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

	test('Route change closes any open Add / Picker dialog', async () => {
		primed();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		await w.find('[data-testid="btn-primary"]').trigger('click');
		await w.vm.$nextTick();
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
		primed();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		mockLoadDashboard.mockRejectedValueOnce(new Error('dash boom'));
		await w.find('.ad-fire-added').trigger('click');
		await flushPromises();
		expect(mockNotify.error).not.toHaveBeenCalled();
		w.unmount();
	});

	test('Page never receives nor logs the raw API key — added payload carries only { provider, profileId }', async () => {
		primed();
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		await w.find('.ad-fire-added').trigger('click');
		await flushPromises();
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
		primed();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		clawsStoreState.byId.claw2 = { id: 'claw2', name: 'Other', online: true, dcReady: true };
		w.vm.$route.params.clawId = 'claw2';
		w.vm.$options.watch.clawId.handler.call(w.vm);
		await flushPromises();
		mockNotify.success.mockClear();
		mockLoadDashboard.mockClear();
		await w.vm.onProviderAdded({ provider: 'groq', profileId: 'groq:default' });
		await flushPromises();
		expect(mockNotify.success).not.toHaveBeenCalled();
		expect(mockLoadDashboard).not.toHaveBeenCalled();
		delete clawsStoreState.byId.claw2;
		w.unmount();
	});

	test('orphaned pick: RPC resolving AFTER a claw switch is dropped (primary not overwritten, no notify/reload)', async () => {
		primed();
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-primary"]').trigger('click');
		await w.vm.$nextTick();
		clawsStoreState.byId.claw2 = { id: 'claw2', name: 'Other', online: true, dcReady: true };
		w.vm.$route.params.clawId = 'claw2';
		w.vm.$options.watch.clawId.handler.call(w.vm);
		await flushPromises();
		const primaryBefore = w.vm.primary;
		mockNotify.success.mockClear();
		mockLoadDashboard.mockClear();
		await w.vm.onPrimaryPicked({ primary: 'openai/gpt-4' });
		await flushPromises();
		expect(w.vm.primary).toBe(primaryBefore);
		expect(w.vm.primary).not.toBe('openai/gpt-4');
		expect(mockNotify.success).not.toHaveBeenCalled();
		expect(mockLoadDashboard).not.toHaveBeenCalled();
		delete clawsStoreState.byId.claw2;
		w.unmount();
	});
});

describe('ModelConfigPage — listAvailable (picker source) + catalog.hasCred (add-provider exclusion)', () => {
	function splitAttr(v) {
		return String(v || '').split(',').filter(Boolean).sort();
	}

	test('listAvailable success feeds picker (byProvider, incl. alias variants)', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true], ['volcengine', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable(
				{ groq: ['llama-3.3-70b-versatile'], 'volcengine-plan': ['ark-code-latest'] });
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		await w.find('[data-testid="btn-primary"]').trigger('click');
		await w.vm.$nextTick();
		const picker = w.find('.picker-dialog');
		expect(splitAttr(picker.attributes('data-usable'))).toEqual(['groq', 'volcengine-plan']);
		w.unmount();
	});

	test('add-provider exclusion = catalog providers with hasCred===true', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'volcengine', type: 'api_key', keyPreview: 'v…X', profileId: 'volcengine:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('volcengine/doubao-pro');
			// 基座归一后的 hasCred：volcengine 已配（true），openai/deepseek 未配（false）
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([
				['volcengine', true], ['openai', false], ['deepseek', false]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable(
				{ volcengine: ['doubao-pro'], 'volcengine-plan': ['ark-code-latest'] });
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.addProviderExclusion).toEqual(['volcengine']);
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		expect(w.find('.add-dialog').attributes('data-existing')).toBe('volcengine');
		w.unmount();
	});

	test('listAvailable failure: available=null → picker empty, primary effective (cannot conclude)', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true]]);
			if (method === 'coclaw.model.listAvailable') throw Object.assign(new Error('io'), { code: 'IO_FAILED' });
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.available).toBeNull();
		expect(w.vm.primaryState).toBe('effective');
		await w.find('[data-testid="btn-primary"]').trigger('click');
		await w.vm.$nextTick();
		expect(w.find('.picker-dialog').attributes('data-usable')).toBe('');
		w.unmount();
	});

	test('listAvailable success but empty byProvider is authoritative (picker empty, primary invalid)', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', false]]);
			// 权威空清单 → primary 不在 → 失效；picker 空
			if (method === 'coclaw.model.listAvailable') return asAvailable({});
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.available).toEqual({});
		expect(w.vm.primaryState).toBe('invalid');
		// invalid 态：统一行显示失效的模型名（信息增益）+ 警告并存；按钮走"更换"（btn-primary）
		expect(w.find('[data-testid="primary-current"]').exists()).toBe(true);
		expect(w.find('[data-testid="primary-warning"]').exists()).toBe(true);
		// 移动端友好：provider/model 拆两行（provider 暗一号 text-muted），各自 truncate 防溢出
		const providerLine = w.find('[data-testid="primary-current-provider"]');
		expect(providerLine.exists()).toBe(true);
		expect(providerLine.text()).toBe('groq');
		expect(providerLine.classes()).toContain('text-muted');
		expect(providerLine.classes()).toContain('truncate');
		expect(w.find('[data-testid="primary-current"]').text()).toBe('llama-3.3-70b-versatile');
		await w.find('[data-testid="btn-primary"]').trigger('click');
		await w.vm.$nextTick();
		expect(w.find('.picker-dialog').attributes('data-usable')).toBe('');
		w.unmount();
	});

	test('refreshAfterWrite re-pulls catalog + listAvailable so add-list/exclusion stay fresh after a write', async () => {
		// 初始：无 provider、空可用清单、空 catalog
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([]);
			if (method === 'coclaw.model.list') return asModelList(null);
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', false]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({});
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.available).toEqual({});
		expect(w.vm.addProviderExclusion).toEqual([]);
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		mockRequest.mockClear();
		// 写后：groq 已配 → catalog.hasCred 翻 true、listAvailable 现有 groq 枚举
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['llama-3.3-70b-versatile'] });
			return {};
		});
		await w.find('.ad-fire-added').trigger('click');
		await flushPromises();
		// refresh 确实重拉 catalog + listAvailable
		expect(mockRequest.mock.calls.filter(c => c[0] === 'coclaw.providerAuth.catalog').length).toBeGreaterThanOrEqual(1);
		expect(mockRequest.mock.calls.filter(c => c[0] === 'coclaw.model.listAvailable').length).toBeGreaterThanOrEqual(1);
		expect(w.vm.available).toEqual({ groq: ['llama-3.3-70b-versatile'] });
		expect(w.vm.addProviderExclusion).toEqual(['groq']);
		w.unmount();
	});

	test('providerAuth.catalog refresh failure clears stale catalog (no stale hasCred after a write)', async () => {
		// 初始：groq 已配（hasCred true），catalog 已填充
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/m1');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true], ['openai', false]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['m1'] });
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.addProviderExclusion).toEqual(['groq']);
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		// 写后 refresh：catalog 这次失败 → 必须清空 providerCatalog（不留写前陈旧 hasCred）
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/m1');
			if (method === 'coclaw.providerAuth.catalog') throw new Error('catalog boom');
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['m1'] });
			return {};
		});
		await w.find('.ad-fire-added').trigger('click');
		await flushPromises();
		expect(w.vm.providerCatalog).toEqual([]);
		expect(w.vm.loadOk.catalogProviders).toBe(false);
		expect(w.vm.addProviderExclusion).toEqual([]); // 不再用写前陈旧 hasCred 排除
		w.unmount();
	});

	test('claw switch resets providerCatalog / available / loadOk', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['llama-3.3-70b-versatile'] });
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.available).toEqual({ groq: ['llama-3.3-70b-versatile'] });
		clawsStoreState.byId.claw2 = { id: 'claw2', name: 'Other', online: true, dcReady: true };
		w.vm.$route.params.clawId = 'claw2';
		w.vm.$options.watch.clawId.handler.call(w.vm);
		// 同步断言：reset 在 loadAll 首个 await 之前
		expect(w.vm.available).toBeNull();
		expect(w.vm.providerCatalog).toEqual([]);
		expect(w.vm.loadOk.catalogProviders).toBe(false);
		await flushPromises();
		delete clawsStoreState.byId.claw2;
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
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true], ['openai', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable(
				{ groq: ['llama-3.3-70b-versatile'], openai: ['gpt-4'] });
			if (method === 'coclaw.providerAuth.remove') return {};
			return {};
		});
	}

	test('Remove for primary carrier opens dialog with isPrimaryCarrier=true', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		const rows = w.findAllComponents({ name: 'ProviderAuthRow' });
		const groqRow = rows.find(r => r.props('profile').provider === 'groq');
		await groqRow.vm.$emit('remove', { provider: 'groq', source: 'profile' });
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
		await openaiRow.vm.$emit('remove', { provider: 'openai', source: 'profile' });
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
		await groqRow.vm.$emit('remove', { provider: 'groq', source: 'profile' });
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
		await groqRow.vm.$emit('remove', { provider: 'groq', source: 'profile' });
		await w.vm.$nextTick();

		mockRequest.mockImplementation(async (method, params) => {
			if (method === 'coclaw.providerAuth.remove') {
				expect(params).toEqual({ provider: 'groq', source: 'profile' });
				return {};
			}
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'openai', type: 'api_key', keyPreview: 'sk-op…Y', profileId: 'openai:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', false], ['openai', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ openai: ['gpt-4'] });
			return {};
		});

		await w.find('.rd-confirm').trigger('click');
		await flushPromises();

		const removeCall = mockRequest.mock.calls.find(c => c[0] === 'coclaw.providerAuth.remove');
		expect(removeCall).toBeTruthy();
		expect(w.vm.profiles).toHaveLength(1);
		expect(w.vm.profiles[0].provider).toBe('openai');
		expect(w.vm.primary).toBe('groq/llama-3.3-70b-versatile');
		expect(mockLoadDashboard).toHaveBeenCalledWith('claw1', { force: true });
		expect(mockNotify.success).not.toHaveBeenCalled();
		expect(w.find('.remove-dialog').exists()).toBe(false);
		w.unmount();
	});

	test('Confirm handler MUST NOT call coclaw.model.set (primary not auto-cleared)', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		const rows = w.findAllComponents({ name: 'ProviderAuthRow' });
		const groqRow = rows.find(r => r.props('profile').provider === 'groq');
		await groqRow.vm.$emit('remove', { provider: 'groq', source: 'profile' });
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
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', { provider: 'groq', source: 'profile' });
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
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', { provider: 'groq', source: 'profile' });
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
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', { provider: 'groq', source: 'profile' });
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
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', { provider: 'groq', source: 'profile' });
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
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', { provider: 'groq', source: 'profile' });
		await w.vm.$nextTick();

		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.remove') throw Object.assign(new Error('aborted'), { code: 'ERR_CANCELED' });
			return {};
		});
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
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
		await rows.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', { provider: 'groq', source: 'profile' });
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
			.find(r => r.props('profile').provider === 'openai').vm.$emit('remove', { provider: 'openai', source: 'profile' });
		await w.vm.$nextTick();
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.remove') return {};
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['llama-3.3-70b-versatile'] });
			return {};
		});
		mockLoadDashboard.mockRejectedValueOnce(new Error('dashboard boom'));
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		expect(mockNotify.success).not.toHaveBeenCalled();
		expect(mockNotify.error).not.toHaveBeenCalled();
		w.unmount();
	});

	test('refreshAfterWrite tolerates RPC failures (does not surface)', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', { provider: 'groq', source: 'profile' });
		await w.vm.$nextTick();
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.remove') return {};
			if (method === 'coclaw.providerAuth.list') throw new Error('list boom');
			if (method === 'coclaw.model.list') throw new Error('model boom');
			if (method === 'coclaw.providerAuth.catalog') throw new Error('catalog boom');
			if (method === 'coclaw.model.listAvailable') throw new Error('available boom');
			return {};
		});
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		expect(mockNotify.success).not.toHaveBeenCalled();
		expect(mockNotify.error).not.toHaveBeenCalled();
		w.unmount();
	});

	test('Double-click confirm guarded by removeBusy', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', { provider: 'groq', source: 'profile' });
		await w.vm.$nextTick();
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
		resolveRemove({});
		await flushPromises();
		w.unmount();
	});

	test('Cancel during busy is ignored — RPC continues and dialog stays open until settle', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', { provider: 'groq', source: 'profile' });
		await w.vm.$nextTick();
		let resolveRemove;
		mockRequest.mockImplementation((method) => {
			if (method === 'coclaw.providerAuth.remove') return new Promise(res => { resolveRemove = res; });
			return Promise.resolve({});
		});
		await w.find('.rd-confirm').trigger('click');
		await Promise.resolve();
		w.vm.onCancelRemove();
		expect(w.vm.removeOpen).toBe(true);
		expect(w.vm.removeTarget).toBe('groq');
		resolveRemove({});
		await flushPromises();
		w.unmount();
	});

	test('Route change closes any open remove dialog', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', { provider: 'groq', source: 'profile' });
		await w.vm.$nextTick();
		expect(w.vm.removeOpen).toBe(true);
		clawsStoreState.byId.claw2 = { id: 'claw2', name: 'Other', online: true, dcReady: true };
		w.vm.$route.params.clawId = 'claw2';
		w.vm.$options.watch.clawId.handler.call(w.vm);
		await flushPromises();
		expect(w.vm.removeOpen).toBe(false);
		expect(w.vm.removeTarget).toBe('');
		delete clawsStoreState.byId.claw2;
		w.unmount();
	});

	test('Route param change while load in flight: stale claw response discarded, new claw data wins', async () => {
		clawsStoreState.byId.claw2 = { id: 'claw2', name: 'Other Claw', online: true, dcReady: true };
		const claw1Pending = { resolve: null };
		mockRequest.mockImplementation((method) => {
			if (method === 'coclaw.providerAuth.list') {
				if (!claw1Pending.resolved) {
					return new Promise(res => { claw1Pending.resolve = res; });
				}
				return Promise.resolve(asProfiles([{ provider: 'openai', type: 'api_key', keyPreview: 'sk-op…Y', profileId: 'openai:default' }]));
			}
			if (method === 'coclaw.model.list') return Promise.resolve(asModelList('openai/gpt-4'));
			if (method === 'coclaw.providerAuth.catalog') return Promise.resolve(asCatalog([['openai', true]]));
			if (method === 'coclaw.model.listAvailable') return Promise.resolve(asAvailable({ openai: ['gpt-4'] }));
			return Promise.resolve({});
		});

		const w = makeWrapper();
		await Promise.resolve();
		claw1Pending.resolved = true;
		await w.setProps({});
		w.vm.$route.params.clawId = 'claw2';
		w.vm.$options.watch.clawId.handler.call(w.vm);
		await flushPromises();
		if (claw1Pending.resolve) claw1Pending.resolve(asProfiles([{ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…X', profileId: 'groq:default' }]));
		await flushPromises();
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
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', { provider: 'groq', source: 'profile' });
		await w.vm.$nextTick();
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
		expect(mockNotify.success).not.toHaveBeenCalled();
		expect(mockLoadDashboard).not.toHaveBeenCalled();
	});

	test('Confirm with CONNECT_TIMEOUT → notify connError', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', { provider: 'groq', source: 'profile' });
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
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', { provider: 'groq', source: 'profile' });
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

	test('OAuth profile coexists with api_key in same list — both rendered as rows', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…X', profileId: 'groq:default' },
				{ provider: 'minimax', type: 'oauth', email: 'u@example.com', profileId: 'minimax:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList(null);
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({});
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		const rows = w.findAllComponents({ name: 'ProviderAuthRow' });
		expect(rows).toHaveLength(2);
		expect(rows.map(r => r.props('profile').provider).sort()).toEqual(['groq', 'minimax']);
		w.unmount();
	});
});

describe('ModelConfigPage — three-source credentials (§2.4)', () => {
	function primedThreeSource() {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default', source: 'profile', removable: true },
				{ provider: 'minimax', type: 'api_key', keyPreview: 'm…Y', profileId: 'minimax#inline', source: 'inline', removable: true },
				{ provider: 'openai', type: 'api_key', profileId: 'openai#env', source: 'env', removable: false },
			]);
			if (method === 'coclaw.model.list') return asModelList('minimax/M2.7');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['minimax', true], ['groq', true], ['openai', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ minimax: ['M2.7'], groq: ['llama'], openai: ['gpt-4'] });
			if (method === 'coclaw.providerAuth.remove') return {};
			return {};
		});
	}

	test('renders all three sources as rows', async () => {
		primedThreeSource();
		const w = makeWrapper();
		await flushPromises();
		const rows = w.findAllComponents({ name: 'ProviderAuthRow' });
		expect(rows).toHaveLength(3);
		expect(rows.map(r => r.props('profile').source).sort()).toEqual(['env', 'inline', 'profile']);
		w.unmount();
	});

	test('profile+inline same provider: removing the profile row still warns as primary carrier', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'minimax', type: 'api_key', keyPreview: 'a…1', profileId: 'minimax:default', source: 'profile', removable: true },
				{ provider: 'minimax', type: 'api_key', keyPreview: 'b…2', profileId: 'minimax#inline', source: 'inline', removable: true },
			]);
			if (method === 'coclaw.model.list') return asModelList('minimax/M2.7');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['minimax', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ minimax: ['M2.7'] });
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		const profileRow = w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').source === 'profile');
		await profileRow.vm.$emit('remove', { provider: 'minimax', source: 'profile' });
		await w.vm.$nextTick();
		expect(w.find('.remove-dialog').attributes('data-carrier')).toBe('true');
		w.unmount();
	});

	test('removing an inline credential passes source=inline to the remove RPC', async () => {
		primedThreeSource();
		const w = makeWrapper();
		await flushPromises();
		const rows = w.findAllComponents({ name: 'ProviderAuthRow' });
		const inlineRow = rows.find(r => r.props('profile').source === 'inline');
		await inlineRow.vm.$emit('remove', { provider: 'minimax', source: 'inline' });
		await w.vm.$nextTick();
		const dialog = w.find('.remove-dialog');
		expect(dialog.attributes('data-carrier')).toBe('true');
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		const removeCall = mockRequest.mock.calls.find(c => c[0] === 'coclaw.providerAuth.remove');
		expect(removeCall[1]).toEqual({ provider: 'minimax', source: 'inline' });
		w.unmount();
	});

	test('env credential is passed through to the row with removable=false', async () => {
		primedThreeSource();
		const w = makeWrapper();
		await flushPromises();
		const rows = w.findAllComponents({ name: 'ProviderAuthRow' });
		const envRow = rows.find(r => r.props('profile').source === 'env');
		expect(envRow.props('profile').removable).toBe(false);
		w.unmount();
	});

	test('removing a profile credential still defaults source=profile end-to-end', async () => {
		primedThreeSource();
		const w = makeWrapper();
		await flushPromises();
		const rows = w.findAllComponents({ name: 'ProviderAuthRow' });
		const profileRow = rows.find(r => r.props('profile').source === 'profile');
		await profileRow.vm.$emit('remove', { provider: 'groq', source: 'profile' });
		await w.vm.$nextTick();
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		const removeCall = mockRequest.mock.calls.find(c => c[0] === 'coclaw.providerAuth.remove');
		expect(removeCall[1]).toEqual({ provider: 'groq', source: 'profile' });
		w.unmount();
	});

	async function openInlineRemove(w) {
		const inlineRow = w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').source === 'inline');
		await inlineRow.vm.$emit('remove', { provider: 'minimax', source: 'inline' });
		await w.vm.$nextTick();
		expect(w.vm.removeSource).toBe('inline');
	}

	test('removeSource resets to profile on cancel', async () => {
		primedThreeSource();
		const w = makeWrapper();
		await flushPromises();
		await openInlineRemove(w);
		await w.find('.rd-cancel').trigger('click');
		await flushPromises();
		expect(w.vm.removeSource).toBe('profile');
		w.unmount();
	});

	test('removeSource resets to profile on successful confirm', async () => {
		primedThreeSource();
		const w = makeWrapper();
		await flushPromises();
		await openInlineRemove(w);
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		expect(w.vm.removeSource).toBe('profile');
		w.unmount();
	});

	test('removeSource resets to profile when connection is gone at confirm', async () => {
		primedThreeSource();
		const w = makeWrapper();
		await flushPromises();
		await openInlineRemove(w);
		mockClawConnGet.mockReturnValue(undefined);
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		expect(mockNotify.error).toHaveBeenCalledWith('modelConfig.common.connError');
		expect(w.vm.removeOpen).toBe(false);
		expect(w.vm.removeSource).toBe('profile');
		w.unmount();
	});

	test('removeSource resets to profile on canceled-error confirm', async () => {
		primedThreeSource();
		const w = makeWrapper();
		await flushPromises();
		await openInlineRemove(w);
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.remove') throw Object.assign(new Error('aborted'), { code: 'ERR_CANCELED' });
			return {};
		});
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		expect(w.vm.removeSource).toBe('profile');
		w.unmount();
	});

	test('removeSource resets to profile on claw switch', async () => {
		primedThreeSource();
		const w = makeWrapper();
		await flushPromises();
		await openInlineRemove(w);
		w.vm.$route.params.clawId = 'claw2';
		w.vm.$options.watch.clawId.handler.call(w.vm);
		await w.vm.$nextTick();
		expect(w.vm.removeSource).toBe('profile');
		w.unmount();
	});
});

describe('ModelConfigPage — write vs in-flight loadAll race (__writeEpoch)', () => {
	test('a stale loadAll resolving after a primary switch must NOT clobber the freshly-picked primary', async () => {
		const profiles = [{ provider: 'groq', source: 'profile' }];
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.list') return asModelList('groq/old-model');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['old-model', 'llama-3.3-70b-versatile'] });
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primary).toBe('groq/old-model');

		w.vm.onOpenPrimaryPicker();

		const staleResolvers = [];
		mockRequest.mockImplementation((method) => new Promise((resolve) => {
			staleResolvers.push(() => {
				if (method === 'coclaw.providerAuth.list') resolve(asProfiles(profiles));
				else if (method === 'coclaw.model.list') resolve(asModelList('groq/old-model'));
				else if (method === 'coclaw.providerAuth.catalog') resolve(asCatalog([['groq', true]]));
				else if (method === 'coclaw.model.listAvailable') resolve(asAvailable({ groq: ['old-model', 'llama-3.3-70b-versatile'] }));
				else resolve({});
			});
		}));
		w.vm.loadAll();
		await Promise.resolve();

		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['llama-3.3-70b-versatile'] });
			return {};
		});
		await w.vm.onPrimaryPicked({ primary: 'groq/llama-3.3-70b-versatile' });
		await flushPromises();
		expect(w.vm.primary).toBe('groq/llama-3.3-70b-versatile');

		staleResolvers.forEach((fn) => fn());
		await flushPromises();
		expect(w.vm.primary).toBe('groq/llama-3.3-70b-versatile');
		expect(w.vm.loading).toBe(false);
		w.unmount();
	});

	test('a normal reconnect loadAll (no intervening write) still applies its result', async () => {
		const profiles = [{ provider: 'groq', source: 'profile' }];
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.list') return asModelList('groq/old-model');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['old-model'] });
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primary).toBe('groq/old-model');

		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.list') return asModelList('groq/new-model');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['new-model'] });
			return {};
		});
		await w.vm.loadAll();
		await flushPromises();
		expect(w.vm.primary).toBe('groq/new-model');
		w.unmount();
	});
});

describe('ModelConfigPage — primary switch "success is authoritative" (no re-read clobber)', () => {
	test('switch trusts set success: does NOT re-read model.list / available; primary stays the picked value (no revert)', async () => {
		const profiles = [{ provider: 'groq', source: 'profile', profileId: 'groq:default' }];
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.list') return asModelList('groq/old-model');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['old-model', 'new-model'] });
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primary).toBe('groq/old-model');

		w.vm.onOpenPrimaryPicker();
		await w.vm.$nextTick();

		mockRequest.mockClear();
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.list') return asModelList('groq/old-model'); // 陈旧
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['old-model', 'new-model'] });
			return {};
		});
		await w.vm.onPrimaryPicked({ primary: 'groq/new-model' });
		await flushPromises();

		expect(w.vm.primary).toBe('groq/new-model'); // 不回跳
		// 切主模型路径不重读 model.list / listAvailable（成功即权威，不重读确认）
		expect(mockRequest.mock.calls.filter((c) => c[0] === 'coclaw.model.list')).toHaveLength(0);
		expect(mockRequest.mock.calls.filter((c) => c[0] === 'coclaw.model.listAvailable')).toHaveLength(0);
		// primary 仍在乐观保留的 available（含 new-model）内 → effective
		expect(w.vm.primaryState).toBe('effective');
		w.unmount();
	});

	test('switching to an alias-plan variant present in available stays effective (no false-invalid)', async () => {
		const profiles = [{ provider: 'minimax-portal', source: 'profile', profileId: 'minimax-portal:default' }];
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.list') return asModelList('minimax-portal/MiniMax-M2.7');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['minimax-portal', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ 'minimax-portal': ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed'] });
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		w.vm.onOpenPrimaryPicker();
		await w.vm.$nextTick();
		await w.vm.onPrimaryPicked({ primary: 'minimax-portal/MiniMax-M2.7-highspeed' });
		await flushPromises();
		expect(w.vm.primary).toBe('minimax-portal/MiniMax-M2.7-highspeed');
		expect(w.vm.primaryState).toBe('effective');
		w.unmount();
	});

	test('remove provider path re-pulls catalog + listAvailable: carrier removal flips state invalid + refreshes hasCred', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([{ provider: 'openai', source: 'profile', profileId: 'openai:default' }]);
			if (method === 'coclaw.model.list') return asModelList('openai/gpt-4');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['openai', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ openai: ['gpt-4'] });
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primaryState).toBe('effective');

		w.vm.onRemoveProvider({ provider: 'openai', source: 'profile' });
		await w.vm.$nextTick();
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.remove') return {};
			if (method === 'coclaw.providerAuth.list') return asProfiles([]);
			if (method === 'coclaw.model.list') return asModelList('openai/gpt-4'); // 服务端不自动清 primary
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['openai', false]]);
			// 删了 openai → 可用清单不再有 openai → membership 翻失效
			if (method === 'coclaw.model.listAvailable') return asAvailable({});
			return {};
		});
		mockRequest.mockClear();
		await w.vm.onConfirmRemove();
		await flushPromises();
		// 写后 refresh 重拉 catalog（hasCred openai→false）+ listAvailable（openai 消失）
		expect(mockRequest.mock.calls.filter((c) => c[0] === 'coclaw.providerAuth.catalog').length).toBeGreaterThan(0);
		expect(w.vm.addProviderExclusion).toEqual([]); // openai hasCred 翻 false → 不再排除
		expect(w.vm.available).toEqual({});
		expect(w.vm.primaryState).toBe('invalid');
		w.unmount();
	});

	test('add provider path re-reads model.list + catalog + listAvailable (default path applies fresh data)', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([{ provider: 'groq', source: 'profile', profileId: 'groq:default' }]);
			if (method === 'coclaw.model.list') return asModelList('groq/m1');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true], ['openai', false]]);
			// 初始：可用清单无主模型 m1 → 失效
			if (method === 'coclaw.model.listAvailable') return asAvailable({});
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primaryState).toBe('invalid');

		w.vm.onAddProvider();
		await w.vm.$nextTick();
		mockRequest.mockClear();
		// 加完别家 key 后，可用清单现含 groq/m1 → 默认路径重读后翻 effective
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([{ provider: 'groq', source: 'profile', profileId: 'groq:default' }]);
			if (method === 'coclaw.model.list') return asModelList('groq/m1');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true], ['openai', false]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['m1'] });
			return {};
		});
		await w.vm.onProviderAdded({ provider: 'openai', profileId: 'openai:default' });
		await flushPromises();
		// 默认路径重读 model.list + providerAuth.catalog + listAvailable
		expect(mockRequest.mock.calls.filter((c) => c[0] === 'coclaw.model.list').length).toBeGreaterThan(0);
		expect(mockRequest.mock.calls.filter((c) => c[0] === 'coclaw.providerAuth.catalog').length).toBeGreaterThan(0);
		expect(mockRequest.mock.calls.filter((c) => c[0] === 'coclaw.model.listAvailable').length).toBeGreaterThan(0);
		expect(w.vm.available).toEqual({ groq: ['m1'] });
		expect(w.vm.primaryState).toBe('effective');
		w.unmount();
	});

	test('an older default refreshAfterWrite resolving AFTER a later primary switch must NOT clobber the new primary (writeEpoch self-guard)', async () => {
		const profiles = [{ provider: 'groq', source: 'profile', profileId: 'groq:default' }];
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.list') return asModelList('groq/old');
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true]]);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['old', 'new'] });
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primary).toBe('groq/old');

		const resolvers = [];
		mockRequest.mockImplementation((method) => new Promise((resolve) => {
			resolvers.push(() => {
				if (method === 'coclaw.providerAuth.list') resolve(asProfiles(profiles));
				else if (method === 'coclaw.model.list') resolve(asModelList('groq/old')); // 写前旧值
				else if (method === 'coclaw.providerAuth.catalog') resolve(asCatalog([['groq', true]]));
				else if (method === 'coclaw.model.listAvailable') resolve(asAvailable({ groq: ['old', 'new'] }));
				else resolve({});
			});
		}));
		const stalePromise = w.vm.refreshAfterWrite(); // 默认路径，epoch+1，RPC 在飞
		await Promise.resolve();

		w.vm.onOpenPrimaryPicker();
		await w.vm.$nextTick();
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.listAvailable') return asAvailable({ groq: ['new'] });
			if (method === 'coclaw.providerAuth.catalog') return asCatalog([['groq', true]]);
			return {}; // trustPrimary 路径不会调 model.list
		});
		await w.vm.onPrimaryPicked({ primary: 'groq/new' });
		await flushPromises();
		expect(w.vm.primary).toBe('groq/new');

		resolvers.forEach((fn) => fn());
		await stalePromise;
		await flushPromises();
		expect(w.vm.primary).toBe('groq/new'); // 不被旧 refresh 覆盖回 old
		w.unmount();
	});
});
