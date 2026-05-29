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
		props: ['open', 'usable', 'fallback', 'providers', 'catalog', 'current', 'setPrimary'],
		emits: ['update:open', 'picked'],
		template: `
			<div v-if="open" class="picker-dialog"
				:data-providers="(providers||[]).join(',')"
				:data-current="current||''"
				:data-fallback="String(fallback)"
				:data-usable="Object.keys(usable||{}).join(',')"
			>
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
	// 真实导出：供页面 import 的 computePrimaryEffective 不被破坏（新签名 §7.4）
	computePrimaryEffective: (primary, providerUsable, catalog) => {
		if (!primary || typeof primary !== 'string') return false;
		const idx = primary.indexOf('/');
		if (idx <= 0 || idx === primary.length - 1) return false;
		const provider = primary.slice(0, idx);
		const model = primary.slice(idx + 1);
		if (!providerUsable) return false;
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
/**
 * 构造 coclaw.model.list 出参（§7.4 新契约）。
 * 默认模拟新插件：带顶层 hasAnyUsableCredential、default.providerUsable。
 * @param {string|null} primary
 * @param {{ providerUsable?: boolean, hasAny?: boolean, legacy?: boolean }} [opts]
 *   - providerUsable: 主模型那家是否有可用凭据（不传时按 primary 是否存在推断）
 *   - hasAny: 顶层 hasAnyUsableCredential 值（不传时按 primary 是否存在推断）
 *   - legacy: true → 模拟旧插件：出参既无顶层 hasAnyUsableCredential，default 也不含 providerUsable
 */
function asModelList(primary, opts = {}) {
	if (opts.legacy) {
		// 真实旧插件形态：只有 default.primary + agents，无凭据信号字段
		return {
			default: { primary },
			agents: { main: { primary: null } },
		};
	}
	const providerUsable = opts.providerUsable !== undefined ? opts.providerUsable : !!primary;
	return {
		default: { primary, providerUsable },
		agents: { main: { primary: null, providerUsable: false } },
		hasAnyUsableCredential: opts.hasAny !== undefined ? opts.hasAny : !!primary,
	};
}
function asCatalog(arr) { return { models: arr }; }
/**
 * 构造 coclaw.model.listUsable 出参（修订 6 契约）。
 * @param {Record<string, string[]>} [byProvider] - 可用 provider→modelId 枚举（含别名变体）
 * @param {string[]} [configuredProviders] - 别名归一已配 provider 基座 id 集
 */
function asUsable(byProvider = {}, configuredProviders = []) {
	return { byProvider, configuredProviders };
}

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

	test('primary set but provider has no usable credential (providerUsable=false): invalid warning', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([]);
			// 插件判定主模型那家无凭据 → providerUsable=false，子页据此报失效（不依赖目录）
			if (method === 'coclaw.model.list') return asModelList('openai/gpt-4', { providerUsable: false, hasAny: false });
			if (method === 'models.list') return asCatalog([{ id: 'gpt-4', provider: 'openai' }]);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primaryState).toBe('invalid');
		expect(w.text()).toContain('modelConfig.primary.invalidWarning');
		w.unmount();
	});

	test('primary set, providerUsable=true but model not in catalog (模型下架): invalid warning', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…X', profileId: 'groq:default' },
			]);
			// 主模型那家有凭据，但目录里没这个 model（上游下架）→ 子页保留下架检测，报失效
			if (method === 'coclaw.model.list') return asModelList('groq/llama-deprecated', { providerUsable: true });
			if (method === 'models.list') return asCatalog([{ id: 'llama-3.3-70b-versatile', provider: 'groq' }]);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primaryState).toBe('invalid');
		expect(w.text()).toContain('modelConfig.primary.invalidWarning');
		w.unmount();
	});

	test('旧插件（出参无 hasAnyUsableCredential / providerUsable）：不再压制 → 报 invalid（feature-detect-suppress 已移除）', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([]);
			// 旧插件：legacy=true → 出参不带凭据信号字段；不再特判压制，providerUsable 缺省按无凭据
			if (method === 'coclaw.model.list') return asModelList('openai/gpt-4', { legacy: true });
			if (method === 'models.list') return asCatalog([{ id: 'gpt-4', provider: 'openai' }]);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		// 成功拿到出参即视信号新鲜（旧插件也算）；缺 providerUsable → 当无凭据 → 报失效
		expect(w.vm.credSignalFresh).toBe(true);
		expect(w.vm.primaryState).toBe('invalid');
		expect(w.find('[data-testid="primary-warning"]').exists()).toBe(true);
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
			if (method === 'coclaw.model.listUsable') return asUsable(
				{ groq: ['llama-3.3-70b-versatile'] }, ['groq']);
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

	test('AddProviderDialog "added" event triggers refresh + dashboard force reload (no success notify)', async () => {
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
		// 成功不 notify：新 provider 立即出现在凭据列表，用户可直接分辨
		expect(mockNotify.success).not.toHaveBeenCalled();
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
		// 切主模型走 trustPrimary：onPrimaryPicked 直接用 picked 值置 primary，refreshAfterWrite 跳过 model.list
		// （下方 model.list mock 此路径不会被调用，保留仅作兜底）
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
		// dashboard 失败静默：不弹 error（成功本就不 notify）
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

describe('ModelConfigPage — listUsable (selmodel source + add-provider exclusion) + fallback', () => {
	function splitAttr(v) {
		return String(v || '').split(',').filter(Boolean).sort();
	}

	test('4 RPCs allSettled: listUsable success feeds picker (byProvider, fallback=false)', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'models.list') return asCatalog([{ id: 'llama-3.3-70b-versatile', provider: 'groq' }]);
			if (method === 'coclaw.model.listUsable') return asUsable(
				{ groq: ['llama-3.3-70b-versatile'], 'volcengine-plan': ['ark-code-latest'] },
				['groq', 'volcengine']);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.loadOk.usable).toBe(true);
		expect(w.vm.usableUnsupported).toBe(false);
		// 选模型器拿到 byProvider（含别名变体），fallback=false
		await w.find('[data-testid="btn-primary-change"]').trigger('click');
		await w.vm.$nextTick();
		const picker = w.find('.picker-dialog');
		expect(picker.attributes('data-fallback')).toBe('false');
		expect(splitAttr(picker.attributes('data-usable'))).toEqual(['groq', 'volcengine-plan']);
		w.unmount();
	});

	test('listUsable success: add-provider exclusion = configuredProviders ∪ usable keys (base+variant)', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'volcengine', type: 'api_key', keyPreview: 'v…X', profileId: 'volcengine:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('volcengine/doubao-pro', { providerUsable: true });
			if (method === 'models.list') return asCatalog([
				{ id: 'doubao-pro', provider: 'volcengine' },
				{ id: 'ark-code-latest', provider: 'volcengine-plan' },
				{ id: 'gpt-4', provider: 'openai' },
			]);
			// 持基座 volcengine key：byProvider 同时点亮基座 + 变体；configuredProviders 归一为基座
			if (method === 'coclaw.model.listUsable') return asUsable(
				{ volcengine: ['doubao-pro'], 'volcengine-plan': ['ark-code-latest'] },
				['volcengine']);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		// 加 provider 排除既剔基座也剔变体（关键：configuredProviders 只有基座，靠合并 usable.keys 覆盖变体）
		expect(splitAttr(w.vm.addProviderExclusion.join(','))).toEqual(['volcengine', 'volcengine-plan']);
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		expect(splitAttr(w.find('.add-dialog').attributes('data-existing'))).toEqual(['volcengine', 'volcengine-plan']);
		w.unmount();
	});

	test('method-not-found (INVALID_REQUEST): old-plugin fallback — fallback=true, exclusion=raw providerIds', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'models.list') return asCatalog([{ id: 'llama-3.3-70b-versatile', provider: 'groq' }]);
			if (method === 'coclaw.model.listUsable') {
				throw Object.assign(new Error('unknown method: coclaw.model.listUsable'), { code: 'INVALID_REQUEST' });
			}
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.loadOk.usable).toBe(false);
		expect(w.vm.usableUnsupported).toBe(true); // 确诊旧插件
		expect(w.vm.usable).toEqual({});
		expect(w.vm.configuredProviders).toBeNull();
		// 选模型器回退态
		await w.find('[data-testid="btn-primary-change"]').trigger('click');
		await w.vm.$nextTick();
		expect(w.find('.picker-dialog').attributes('data-fallback')).toBe('true');
		// 加 provider 排除回退到 raw providerIds
		expect(w.vm.addProviderExclusion).toEqual(['groq']);
		w.unmount();
	});

	test('transient failure (RPC_TIMEOUT): conservative fallback, NOT marked as old plugin', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'models.list') return asCatalog([{ id: 'llama-3.3-70b-versatile', provider: 'groq' }]);
			if (method === 'coclaw.model.listUsable') {
				throw Object.assign(new Error('rpc timeout'), { code: 'RPC_TIMEOUT' });
			}
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.loadOk.usable).toBe(false);
		// 瞬时失败不确诊旧插件（写后刷新仍会重拉以恢复）
		expect(w.vm.usableUnsupported).toBe(false);
		// 仍回退、不空白
		await w.find('[data-testid="btn-primary-change"]').trigger('click');
		await w.vm.$nextTick();
		expect(w.find('.picker-dialog').attributes('data-fallback')).toBe('true');
		expect(w.vm.addProviderExclusion).toEqual(['groq']);
		w.unmount();
	});

	test('plugin error IO_FAILED on listUsable: treated as transient (NOT old plugin), conservative fallback', async () => {
		// listUsable 自身业务错误（cfg 不可读等）是 IO_FAILED，而非网关 method-not-found（INVALID_REQUEST）。
		// 必须按瞬时态处理：回退但不确诊旧插件（写后刷新仍重拉 listUsable 以恢复），别被误判为旧插件。
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'models.list') return asCatalog([{ id: 'llama-3.3-70b-versatile', provider: 'groq' }]);
			if (method === 'coclaw.model.listUsable') {
				throw Object.assign(new Error('runtime config not available'), { code: 'IO_FAILED' });
			}
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.loadOk.usable).toBe(false);
		// 关键：IO_FAILED 不得被当成旧插件
		expect(w.vm.usableUnsupported).toBe(false);
		// 回退到旧派生、不空白
		await w.find('[data-testid="btn-primary-change"]').trigger('click');
		await w.vm.$nextTick();
		expect(w.find('.picker-dialog').attributes('data-fallback')).toBe('true');
		expect(w.vm.addProviderExclusion).toEqual(['groq']);
		w.unmount();
	});

	test('listUsable success but empty byProvider is authoritative (no fallback, exclusion from configuredProviders)', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'models.list') return asCatalog([{ id: 'llama-3.3-70b-versatile', provider: 'groq' }]);
			// 干净目录∩凭据为空（authoritative）→ 不该回退到旧交集
			if (method === 'coclaw.model.listUsable') return asUsable({}, ['groq']);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.loadOk.usable).toBe(true);
		await w.find('[data-testid="btn-primary-change"]').trigger('click');
		await w.vm.$nextTick();
		// 成功（即便空）→ 非回退；picker 据空 usable 自行显示空态
		expect(w.find('.picker-dialog').attributes('data-fallback')).toBe('false');
		expect(w.find('.picker-dialog').attributes('data-usable')).toBe('');
		w.unmount();
	});

	test('catalog still feeds primaryEffective (模型下架) independently of listUsable', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			// 主模型那家有凭据，但 catalog 里没这个 model（上游下架）→ 子页仍报失效
			if (method === 'coclaw.model.list') return asModelList('groq/llama-deprecated', { providerUsable: true });
			if (method === 'models.list') return asCatalog([{ id: 'llama-3.3-70b-versatile', provider: 'groq' }]);
			if (method === 'coclaw.model.listUsable') return asUsable({ groq: ['llama-3.3-70b-versatile'] }, ['groq']);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.loadOk.usable).toBe(true);
		// 模型下架检测仍走 catalog（与 listUsable 解耦）
		expect(w.vm.primaryState).toBe('invalid');
		expect(w.text()).toContain('modelConfig.primary.invalidWarning');
		w.unmount();
	});

	test('refreshAfterWrite re-pulls listUsable so picker/exclusion stay fresh after a write', async () => {
		// 初始：无 provider、空 usable
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([]);
			if (method === 'coclaw.model.list') return asModelList(null);
			if (method === 'models.list') return asCatalog([
				{ id: 'llama-3.3-70b-versatile', provider: 'groq' },
			]);
			if (method === 'coclaw.model.listUsable') return asUsable({}, []);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.usable).toEqual({});
		// 打开 add（记录 __writeClawId），随后 added 触发 refreshAfterWrite
		await w.find('[data-testid="btn-add-provider"]').trigger('click');
		await w.vm.$nextTick();
		mockRequest.mockClear();
		// 写后：groq 已配，listUsable 现返回 groq 枚举 + configuredProviders
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'coclaw.model.listUsable') return asUsable({ groq: ['llama-3.3-70b-versatile'] }, ['groq']);
			return {};
		});
		await w.find('.ad-fire-added').trigger('click');
		await flushPromises();
		// refresh 确实重拉了 listUsable，且 usable/exclusion 刷新
		const usableCalls = mockRequest.mock.calls.filter(c => c[0] === 'coclaw.model.listUsable');
		expect(usableCalls.length).toBeGreaterThanOrEqual(1);
		expect(w.vm.usable).toEqual({ groq: ['llama-3.3-70b-versatile'] });
		expect(w.vm.addProviderExclusion).toEqual(['groq']);
		// refresh 不重拉 catalog（models.list）
		expect(mockRequest.mock.calls.filter(c => c[0] === 'models.list')).toHaveLength(0);
		w.unmount();
	});

	test('refreshAfterWrite SKIPS listUsable when plugin is confirmed old (usableUnsupported)', async () => {
		// 初始 load：listUsable method-not-found → usableUnsupported=true
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'models.list') return asCatalog([{ id: 'llama-3.3-70b-versatile', provider: 'groq' }]);
			if (method === 'coclaw.model.listUsable') {
				throw Object.assign(new Error('unknown method'), { code: 'INVALID_REQUEST' });
			}
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.usableUnsupported).toBe(true);
		await w.find('[data-testid="btn-primary-change"]').trigger('click'); // 记 __writeClawId
		await w.vm.$nextTick();
		mockRequest.mockClear();
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			return {};
		});
		await w.find('.pk-fire-picked').trigger('click');
		await flushPromises();
		// 旧插件确诊后 refresh 不再徒劳重拉 listUsable
		expect(mockRequest.mock.calls.filter(c => c[0] === 'coclaw.model.listUsable')).toHaveLength(0);
		w.unmount();
	});

	test('claw switch resets usable / configuredProviders / usableUnsupported', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' },
			]);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'models.list') return asCatalog([{ id: 'llama-3.3-70b-versatile', provider: 'groq' }]);
			if (method === 'coclaw.model.listUsable') return asUsable({ groq: ['llama-3.3-70b-versatile'] }, ['groq']);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.usable).toEqual({ groq: ['llama-3.3-70b-versatile'] });
		// 切到一台无连接的 claw → 状态应立刻清空（旧 load 落地会被 seq 拦下）
		clawsStoreState.byId.claw2 = { id: 'claw2', name: 'Other', online: true, dcReady: true };
		w.vm.$route.params.clawId = 'claw2';
		w.vm.$options.watch.clawId.handler.call(w.vm);
		// 同步断言：reset 在 loadAll 的首个 await 之前已发生
		expect(w.vm.usable).toEqual({});
		expect(w.vm.configuredProviders).toBeNull();
		expect(w.vm.usableUnsupported).toBe(false);
		expect(w.vm.loadOk.usable).toBe(false);
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

		// 准备 refresh-after-write 的返回：把 groq 从列表去掉
		mockRequest.mockImplementation(async (method, params) => {
			if (method === 'coclaw.providerAuth.remove') {
				expect(params).toEqual({ provider: 'groq', source: 'profile' });
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
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', { provider: 'groq', source: 'profile' });
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

	test('refreshAfterWrite: model.list 拒绝时不残留旧 providerUsable 误报 invalid（§7.4 宁可少提示）', async () => {
		// 初始：主模型那家无凭据（providerUsable=false）→ 显示失效
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([]);
			if (method === 'coclaw.model.list') return asModelList('openai/gpt-4', { providerUsable: false, hasAny: false });
			if (method === 'models.list') return asCatalog([{ id: 'gpt-4', provider: 'openai' }]);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primaryState).toBe('invalid');

		// 模拟"配好 key 的写操作成功 + 写后 refresh 的 model.list 失败"：
		// providerAuth.list 成功刷新（profiles 已变），但 model.list 拒绝（新凭据信号没拿到）
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'openai', type: 'api_key', keyPreview: 'sk-o…Y', profileId: 'openai:default' },
			]);
			if (method === 'coclaw.model.list') throw new Error('model boom');
			return {};
		});
		await w.vm.refreshAfterWrite();
		await flushPromises();
		// 关键：不得用写入前的旧 providerUsable=false 误报失效；信号标记为陈旧 → 保守视为 effective
		expect(w.vm.credSignalFresh).toBe(false);
		// 收紧断言到 'effective'（而非仅 not 'invalid'）：堵住"退化成 unknown 也算过"的假绿
		expect(w.vm.primaryState).toBe('effective');
		expect(w.find('[data-testid="primary-warning"]').exists()).toBe(false);
		w.unmount();
	});

	test('Double-click confirm guarded by removeBusy', async () => {
		primedRequest();
		const w = makeWrapper();
		await flushPromises();
		await w.findAllComponents({ name: 'ProviderAuthRow' })
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', { provider: 'groq', source: 'profile' });
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
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', { provider: 'groq', source: 'profile' });
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
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', { provider: 'groq', source: 'profile' });
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
			.find(r => r.props('profile').provider === 'groq').vm.$emit('remove', { provider: 'groq', source: 'profile' });
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

describe('ModelConfigPage — three-source credentials (§2.4)', () => {
	function primedThreeSource() {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default', source: 'profile', removable: true },
				{ provider: 'minimax', type: 'api_key', keyPreview: 'm…Y', profileId: 'minimax#inline', source: 'inline', removable: true },
				{ provider: 'openai', type: 'api_key', profileId: 'openai#env', source: 'env', removable: false },
			]);
			// 主模型落在内联的 minimax 上 → 撤内联时是 carrier，验证强提示对内联也适用
			if (method === 'coclaw.model.list') return asModelList('minimax/M2.7', { providerUsable: true });
			if (method === 'models.list') return asCatalog([
				{ id: 'M2.7', provider: 'minimax' },
				{ id: 'llama', provider: 'groq' },
				{ id: 'gpt-4', provider: 'openai' },
			]);
			if (method === 'coclaw.providerAuth.remove') return {};
			return {};
		});
	}

	test('renders all three sources as rows; providerIds dedupes across sources', async () => {
		primedThreeSource();
		const w = makeWrapper();
		await flushPromises();
		const rows = w.findAllComponents({ name: 'ProviderAuthRow' });
		expect(rows).toHaveLength(3);
		expect(rows.map(r => r.props('profile').source).sort()).toEqual(['env', 'inline', 'profile']);
		// 三个不同 provider → providerIds 三条
		expect(w.vm.providerIds.slice().sort()).toEqual(['groq', 'minimax', 'openai']);
		w.unmount();
	});

	test('providerIds dedupes when the same provider appears in multiple sources', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'minimax', type: 'api_key', keyPreview: 'a…1', profileId: 'minimax:default', source: 'profile', removable: true },
				{ provider: 'minimax', type: 'api_key', keyPreview: 'b…2', profileId: 'minimax#inline', source: 'inline', removable: true },
			]);
			if (method === 'coclaw.model.list') return asModelList('minimax/M2.7', { providerUsable: true });
			if (method === 'models.list') return asCatalog([{ id: 'M2.7', provider: 'minimax' }]);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.profiles).toHaveLength(2);
		// 同 provider 两来源 → providerIds 去重为一条（picker/add-dialog 不重复）
		expect(w.vm.providerIds).toEqual(['minimax']);
		w.unmount();
	});

	test('profile+inline same provider: removing the profile row still warns as primary carrier', async () => {
		// minimax 同时有账本+内联、且是主模型载体 → 撤任一来源都应强警告（provider 段匹配，宁可过警告）
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([
				{ provider: 'minimax', type: 'api_key', keyPreview: 'a…1', profileId: 'minimax:default', source: 'profile', removable: true },
				{ provider: 'minimax', type: 'api_key', keyPreview: 'b…2', profileId: 'minimax#inline', source: 'inline', removable: true },
			]);
			if (method === 'coclaw.model.list') return asModelList('minimax/M2.7', { providerUsable: true });
			if (method === 'models.list') return asCatalog([{ id: 'M2.7', provider: 'minimax' }]);
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
		// minimax 是主模型载体 → 强提示分支（provider 段匹配，对内联也适用）
		expect(dialog.attributes('data-carrier')).toBe('true');
		await w.find('.rd-confirm').trigger('click');
		await flushPromises();
		const removeCall = mockRequest.mock.calls.find(c => c[0] === 'coclaw.providerAuth.remove');
		expect(removeCall[1]).toEqual({ provider: 'minimax', source: 'inline' });
		w.unmount();
	});

	test('env credential is passed through to the row with removable=false (row disables its own button)', async () => {
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

	// removeSource 必须在所有关闭路径复位回 'profile'：否则下次撤销默认 source 会被上次的 inline/env 污染
	// （先开 inline 让 removeSource 非默认，再分别走各关闭路径验证复位）
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
	// 复现并钉死：连接抖动重连触发的整页 loadAll 若在切主模型「写后刷新」之后才落地，
	// 不得用写前的陈旧 primary 覆盖写后的新值（否则页面先显示新模型、~2s 后跳回旧模型）。
	test('a stale loadAll resolving after a primary switch must NOT clobber the freshly-picked primary', async () => {
		const profiles = [{ provider: 'groq', source: 'profile' }];
		const catalog = [{ id: 'old-model', provider: 'groq' }, { id: 'llama-3.3-70b-versatile', provider: 'groq' }];

		// 1) 初始加载：primary = 旧模型
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.list') return asModelList('groq/old-model');
			if (method === 'models.list') return asCatalog(catalog);
			if (method === 'coclaw.model.listUsable') return asUsable({ groq: ['old-model', 'llama-3.3-70b-versatile'] }, ['groq']);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primary).toBe('groq/old-model');

		// 打开 picker（记录 __writeClawId）
		w.vm.onChangePrimary();

		// 2) 模拟"重连触发、写之前发出、写之后才落地"的在飞 loadAll：deferred 卡住其 RPC
		const staleResolvers = [];
		mockRequest.mockImplementation((method) => new Promise((resolve) => {
			staleResolvers.push(() => {
				if (method === 'coclaw.providerAuth.list') resolve(asProfiles(profiles));
				else if (method === 'coclaw.model.list') resolve(asModelList('groq/old-model'));
				else if (method === 'models.list') resolve(asCatalog(catalog));
				else if (method === 'coclaw.model.listUsable') resolve(asUsable({ groq: ['old-model', 'llama-3.3-70b-versatile'] }, ['groq']));
				else resolve({});
			});
		}));
		w.vm.loadAll();
		await Promise.resolve();

		// 3) 用户选了新模型 → onPrimaryPicked：乐观置新值 + refreshAfterWrite（fresh 立即 resolve）
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.list') return asModelList('groq/llama-3.3-70b-versatile');
			if (method === 'coclaw.model.listUsable') return asUsable({ groq: ['llama-3.3-70b-versatile'] }, ['groq']);
			if (method === 'models.list') return asCatalog(catalog);
			return {};
		});
		await w.vm.onPrimaryPicked({ primary: 'groq/llama-3.3-70b-versatile' });
		await flushPromises();
		expect(w.vm.primary).toBe('groq/llama-3.3-70b-versatile');

		// 4) 在飞旧 loadAll 落地（慢 RPC 终于返回）——必须被 __writeEpoch 判陈旧而丢弃
		staleResolvers.forEach((fn) => fn());
		await flushPromises();
		expect(w.vm.primary).toBe('groq/llama-3.3-70b-versatile');

		// loading 仍由 seq 机制正常归位（被丢弃的 loadAll 不应卡住"加载中"）
		expect(w.vm.loading).toBe(false);
		w.unmount();
	});

	test('a normal reconnect loadAll (no intervening write) still applies its result', async () => {
		const profiles = [{ provider: 'groq', source: 'profile' }];
		const catalog = [{ id: 'old-model', provider: 'groq' }];
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.list') return asModelList('groq/old-model');
			if (method === 'models.list') return asCatalog(catalog);
			if (method === 'coclaw.model.listUsable') return asUsable({ groq: ['old-model'] }, ['groq']);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primary).toBe('groq/old-model');

		// 无写操作的纯重连刷新：服务端此时 primary 已是新值 → 必须照常应用
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.list') return asModelList('groq/new-model');
			if (method === 'models.list') return asCatalog([{ id: 'new-model', provider: 'groq' }]);
			if (method === 'coclaw.model.listUsable') return asUsable({ groq: ['new-model'] }, ['groq']);
			return {};
		});
		await w.vm.loadAll();
		await flushPromises();
		expect(w.vm.primary).toBe('groq/new-model');
		w.unmount();
	});
});

describe('ModelConfigPage — primary switch "success is authoritative" (§7.4 / no re-read clobber)', () => {
	// 修复"切主模型回跳"：写成功后不重读 model.list 覆盖 primary；陈旧快照不再把新值盖回旧值。
	test('switch trusts set success: does NOT re-read model.list; primary stays the picked value (no revert)', async () => {
		const profiles = [{ provider: 'groq', source: 'profile', profileId: 'groq:default' }];
		const catalog = [{ id: 'old-model', provider: 'groq' }, { id: 'new-model', provider: 'groq' }];
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.list') return asModelList('groq/old-model');
			if (method === 'models.list') return asCatalog(catalog);
			if (method === 'coclaw.model.listUsable') return asUsable({ groq: ['old-model', 'new-model'] }, ['groq']);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primary).toBe('groq/old-model');

		w.vm.onChangePrimary(); // 记 __writeClawId
		await w.vm.$nextTick();

		// 模拟写后运行时陈旧快照：model.list 仍返回旧值（若被 apply 就会回跳）
		mockRequest.mockClear();
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.list') return asModelList('groq/old-model'); // 陈旧
			if (method === 'coclaw.model.listUsable') return asUsable({ groq: ['old-model', 'new-model'] }, ['groq']);
			if (method === 'models.list') return asCatalog(catalog);
			return {};
		});
		await w.vm.onPrimaryPicked({ primary: 'groq/new-model' });
		await flushPromises();

		expect(w.vm.primary).toBe('groq/new-model'); // 不回跳
		// 切主模型路径不重读 model.list（成功即权威，不重读确认）
		const modelListCalls = mockRequest.mock.calls.filter((c) => c[0] === 'coclaw.model.list');
		expect(modelListCalls).toHaveLength(0);
		// §7.4：凭据信号按 set 成功置真
		expect(w.vm.primaryProviderUsable).toBe(true);
		expect(w.vm.credSignalFresh).toBe(true);
		expect(w.vm.primaryState).toBe('effective');
		w.unmount();
	});

	test('§7.4: switching to an alias-plan variant present in this.catalog stays effective (no false-invalid)', async () => {
		// 别名套餐变体：picker 能选 + view:all(this.catalog) 含它（实测 view:all ⊇ picker 集）
		const profiles = [{ provider: 'minimax-portal', source: 'profile', profileId: 'minimax-portal:default' }];
		const catalog = [
			{ id: 'MiniMax-M2.7', provider: 'minimax-portal' },
			{ id: 'MiniMax-M2.7-highspeed', provider: 'minimax-portal' },
		];
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.list') return asModelList('minimax-portal/MiniMax-M2.7');
			if (method === 'models.list') return asCatalog(catalog);
			if (method === 'coclaw.model.listUsable') return asUsable({ 'minimax-portal': ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed'] }, ['minimax-portal']);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		w.vm.onChangePrimary();
		await w.vm.$nextTick();
		await w.vm.onPrimaryPicked({ primary: 'minimax-portal/MiniMax-M2.7-highspeed' });
		await flushPromises();
		expect(w.vm.primary).toBe('minimax-portal/MiniMax-M2.7-highspeed');
		expect(w.vm.primaryState).toBe('effective'); // 目录里有该变体 → 不误报失效
		w.unmount();
	});

	test('switch credential signal is NOT clobbered by a stale model.list reporting providerUsable=false', async () => {
		// 切到另一家 provider；陈旧 model.list 仍报旧 primary 视角 providerUsable=false（若被 apply 会误报失效）
		const profiles = [
			{ provider: 'groq', source: 'profile', profileId: 'groq:default' },
			{ provider: 'openai', source: 'profile', profileId: 'openai:default' },
		];
		const catalog = [{ id: 'old', provider: 'groq' }, { id: 'gpt-4', provider: 'openai' }];
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.list') return asModelList('groq/old', { providerUsable: true });
			if (method === 'models.list') return asCatalog(catalog);
			if (method === 'coclaw.model.listUsable') return asUsable({ groq: ['old'], openai: ['gpt-4'] }, ['groq', 'openai']);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		w.vm.onChangePrimary();
		await w.vm.$nextTick();
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.list') return asModelList('groq/old', { providerUsable: false, hasAny: false });
			if (method === 'coclaw.model.listUsable') return asUsable({ groq: ['old'], openai: ['gpt-4'] }, ['groq', 'openai']);
			if (method === 'models.list') return asCatalog(catalog);
			return {};
		});
		await w.vm.onPrimaryPicked({ primary: 'openai/gpt-4' });
		await flushPromises();
		expect(w.vm.primary).toBe('openai/gpt-4');
		expect(w.vm.primaryProviderUsable).toBe(true); // 未被陈旧读覆盖
		expect(w.vm.primaryState).toBe('effective');
		w.unmount();
	});

	test('remove provider path still applies model.list: removing the primary carrier flips state to invalid', async () => {
		const catalog = [{ id: 'gpt-4', provider: 'openai' }];
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([{ provider: 'openai', source: 'profile', profileId: 'openai:default' }]);
			if (method === 'coclaw.model.list') return asModelList('openai/gpt-4', { providerUsable: true });
			if (method === 'models.list') return asCatalog(catalog);
			if (method === 'coclaw.model.listUsable') return asUsable({ openai: ['gpt-4'] }, ['openai']);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primaryState).toBe('effective');

		// 删掉 openai（主模型那家）：写后 model.list 报 providerUsable=false → 必须翻失效（默认路径放行）
		w.vm.onRemoveProvider({ provider: 'openai', source: 'profile' });
		await w.vm.$nextTick();
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.remove') return {};
			if (method === 'coclaw.providerAuth.list') return asProfiles([]);
			if (method === 'coclaw.model.list') return asModelList('openai/gpt-4', { providerUsable: false, hasAny: false });
			if (method === 'coclaw.model.listUsable') return asUsable({}, []);
			if (method === 'models.list') return asCatalog(catalog);
			return {};
		});
		await w.vm.onConfirmRemove();
		await flushPromises();
		expect(w.vm.primaryProviderUsable).toBe(false);
		expect(w.vm.primaryState).toBe('invalid');
		w.unmount();
	});

	test('add provider path still re-reads model.list (default path applies fresh credential signal)', async () => {
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([{ provider: 'groq', source: 'profile', profileId: 'groq:default' }]);
			if (method === 'coclaw.model.list') return asModelList('groq/old', { providerUsable: false, hasAny: false });
			if (method === 'models.list') return asCatalog([{ id: 'old', provider: 'groq' }]);
			if (method === 'coclaw.model.listUsable') return asUsable({ groq: ['old'] }, ['groq']);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primaryProviderUsable).toBe(false);

		w.vm.onAddProvider();
		await w.vm.$nextTick();
		mockRequest.mockClear();
		// 加完 key 后该家有凭据：model.list 现报 providerUsable=true → 默认路径必须重读并 apply
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles([{ provider: 'groq', source: 'profile', profileId: 'groq:default' }]);
			if (method === 'coclaw.model.list') return asModelList('groq/old', { providerUsable: true });
			if (method === 'coclaw.model.listUsable') return asUsable({ groq: ['old'] }, ['groq']);
			if (method === 'models.list') return asCatalog([{ id: 'old', provider: 'groq' }]);
			return {};
		});
		await w.vm.onProviderAdded({ provider: 'groq', profileId: 'groq:default' });
		await flushPromises();
		const modelListCalls = mockRequest.mock.calls.filter((c) => c[0] === 'coclaw.model.list');
		expect(modelListCalls.length).toBeGreaterThan(0); // 默认路径仍重读 model.list
		expect(w.vm.primaryProviderUsable).toBe(true); // 已 apply 新凭据信号
		w.unmount();
	});

	test('an older default refreshAfterWrite resolving AFTER a later primary switch must NOT clobber the new primary (writeEpoch self-guard)', async () => {
		// 复现并钉死：删/加 provider 的默认刷新（重读 model.list）若在飞期间用户又切了主模型，
		// 这次更早的刷新落地时不得用写前旧 primary 覆盖刚切的新值——靠 refreshAfterWrite 自身的 writeEpoch 守卫拦下。
		const profiles = [{ provider: 'groq', source: 'profile', profileId: 'groq:default' }];
		const catalog = [{ id: 'old', provider: 'groq' }, { id: 'new', provider: 'groq' }];
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.list') return asModelList('groq/old');
			if (method === 'models.list') return asCatalog(catalog);
			if (method === 'coclaw.model.listUsable') return asUsable({ groq: ['old', 'new'] }, ['groq']);
			return {};
		});
		const w = makeWrapper();
		await flushPromises();
		expect(w.vm.primary).toBe('groq/old');

		// 1) 起一个默认路径 refreshAfterWrite（模拟 add/remove 后的刷新），其 RPC 用 deferred 卡住
		const resolvers = [];
		mockRequest.mockImplementation((method) => new Promise((resolve) => {
			resolvers.push(() => {
				if (method === 'coclaw.providerAuth.list') resolve(asProfiles(profiles));
				else if (method === 'coclaw.model.list') resolve(asModelList('groq/old')); // 写前旧值
				else if (method === 'coclaw.model.listUsable') resolve(asUsable({ groq: ['old', 'new'] }, ['groq']));
				else resolve({});
			});
		}));
		const stalePromise = w.vm.refreshAfterWrite(); // 默认路径，epoch+1，RPC 在飞
		await Promise.resolve();

		// 2) 用户切主模型：onPrimaryPicked 置新值 + trustPrimary refresh（epoch 再+1）
		w.vm.onChangePrimary();
		await w.vm.$nextTick();
		mockRequest.mockImplementation(async (method) => {
			if (method === 'coclaw.providerAuth.list') return asProfiles(profiles);
			if (method === 'coclaw.model.listUsable') return asUsable({ groq: ['new'] }, ['groq']);
			if (method === 'models.list') return asCatalog(catalog);
			return {}; // trustPrimary 路径不会调 model.list
		});
		await w.vm.onPrimaryPicked({ primary: 'groq/new' });
		await flushPromises();
		expect(w.vm.primary).toBe('groq/new');

		// 3) 更早的默认 refresh 现在才落地（model.list 返回写前旧值）——必须被 writeEpoch 判陈旧丢弃
		resolvers.forEach((fn) => fn());
		await stalePromise;
		await flushPromises();
		expect(w.vm.primary).toBe('groq/new'); // 不被旧 refresh 覆盖回 old
		w.unmount();
	});
});
