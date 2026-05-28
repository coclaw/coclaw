import { expect } from '@playwright/test';
import { evalStore } from './helpers.js';

/**
 * model-config E2E 的 RPC 边界 mock 工具。
 *
 * 为什么 mock 而不打真实 plugin：
 * - model-config 的 RPC（coclaw.providerAuth.* / coclaw.model.* / models.list view:all）
 *   走 WebRTC DataChannel 直达 plugin，page.route() 这类 HTTP 拦截碰不到。
 * - 场景 S1 需要"零 provider"起始态、S2 需要"撤掉一个真实 provider"，二者用真实 RPC 都会
 *   破坏测试 claw 真实且不可恢复的 API key（连带毁掉其它 chat E2E）。
 * - mock 把 auth-profiles.json 完全留白：跑完不残留任何真实 claw 改动，teardown 天然干净。
 *
 * 实现：在 document_start 把 `/src/services/claw-connection.js`（与 app 同一份 Vite 缓存
 * 模块）里 ClawConnection.prototype.request 包一层，按 method 返回有状态的合成响应；
 * 其余 RPC（status / agents / sessions / models.list 非 all view 等）原样透传真实链路。
 * 状态存 sessionStorage，跨整页刷新（page.goto）持久；每个 test 独立 context → 起始态干净。
 */

/**
 * 固定的 models.list view:"all" catalog（仅含 E2E 用到的 provider/model）。
 * 供子页 picker / add-dialog / "模型下架"校验用（/claws 已不再拉全量目录，§7.4）。
 */
export const MOCK_CATALOG = [
	{ id: 'llama-3.3-70b-versatile', provider: 'groq', name: 'Llama 3.3 70B' },
	{ id: 'llama-3.1-8b-instant', provider: 'groq', name: 'Llama 3.1 8B' },
	{ id: 'claude-sonnet-4-6', provider: 'anthropic', name: 'Claude Sonnet 4.6' },
	{ id: 'claude-opus-4-6', provider: 'anthropic', name: 'Claude Opus 4.6' },
];

/** 用于断言的常量，避免 spec 与 catalog 写散 */
export const GROQ_PRIMARY = 'groq/llama-3.3-70b-versatile';
export const GROQ_PRIMARY_ALT = 'groq/llama-3.1-8b-instant';
export const GROQ_PRIMARY_LABEL = 'Llama 3.3 70B';
export const GROQ_PRIMARY_ALT_LABEL = 'Llama 3.1 8B';

/**
 * 构造一条账本来源（source='profile'）的 api_key profile（providerAuth.list 出参形态）
 * @param {string} provider
 * @returns {{ profileId: string, provider: string, type: string, keyPreview: string, source: string, removable: boolean }}
 */
export function mockProfile(provider) {
	return {
		profileId: `${provider}:default`,
		provider,
		type: 'api_key',
		keyPreview: 'sk-t…3333',
		source: 'profile',
		removable: true,
	};
}

/**
 * 安装 RPC 边界 mock。必须在任何导航（含 login 的 goto）之前调用——
 * addInitScript 对该 page 后续所有页面加载生效。
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ profiles?: object[], inlineProviders?: string[], envProviders?: string[], primary?: string|null, catalog?: object[], legacy?: boolean }} initialState
 *   - inlineProviders: provider id 列表，模拟写在 openclaw.json 的内联 key（source='inline'，可撤）
 *   - envProviders: provider id 列表，模拟环境变量 key（source='env'，只读；仅 sole-source 才列）
 *   - legacy: true → 模拟旧插件：coclaw.model.list 出参不带凭据信号字段
 *     （default.providerUsable / 顶层 hasAnyUsableCredential）；且 coclaw.model.listUsable 整方法不存在
 *     （reject code=INVALID_REQUEST，镜像网关 unknown-method），用于验证"不再特判旧插件、该弹就弹"
 *     + "选模型器回退到旧交集派生不空白"
 *
 * coclaw.model.listUsable（修订 6）：非 legacy 时按"干净目录(catalog) ∩ 三源已配 provider（含别名变体）"
 * 合成 { byProvider, configuredProviders }。内置别名映射 volcengine→volcengine-plan：持 volcengine 基座 key
 * 时 byProvider 同时含基座与变体条目，configuredProviders 仅含基座（归一）。
 */
export function setupModelConfigMock(page, initialState) {
	const initial = {
		profiles: Array.isArray(initialState?.profiles) ? initialState.profiles : [],
		inlineProviders: Array.isArray(initialState?.inlineProviders) ? initialState.inlineProviders : [],
		envProviders: Array.isArray(initialState?.envProviders) ? initialState.envProviders : [],
		primary: initialState?.primary ?? null,
		catalog: Array.isArray(initialState?.catalog) ? initialState.catalog : MOCK_CATALOG,
		legacy: initialState?.legacy === true,
	};
	return page.addInitScript((init) => {
		const KEY = '__mcMockState';
		const read = () => {
			try {
				const v = JSON.parse(sessionStorage.getItem(KEY) || 'null');
				return v && typeof v === 'object' ? v : null;
			}
			catch { return null; }
		};
		const write = (s) => {
			try { sessionStorage.setItem(KEY, JSON.stringify(s)); }
			catch { /* 隐私模式等 sessionStorage 不可用时忽略 */ }
		};
		// 仅在尚无状态时种入初始态：保证同一 scenario 内整页刷新不丢已变更状态
		if (!read()) write(init);

		const preview = (k) => {
			const s = String(k || '');
			return s.length <= 8 ? s : `${s.slice(0, 4)}…${s.slice(-4)}`;
		};

		const wrap = (ClawConnection) => {
			if (!ClawConnection || ClawConnection.__mcWrapped) return;
			ClawConnection.__mcWrapped = true;
			const orig = ClawConnection.prototype.request;
			ClawConnection.prototype.request = function (method, params = {}, options = {}) {
				const st = read() || { profiles: [], primary: null, catalog: [] };
				st.profiles = Array.isArray(st.profiles) ? st.profiles : [];
				st.inlineProviders = Array.isArray(st.inlineProviders) ? st.inlineProviders : [];
				st.envProviders = Array.isArray(st.envProviders) ? st.envProviders : [];
				st.catalog = Array.isArray(st.catalog) ? st.catalog : [];

				// 别名基座→变体映射：镜像厂商 manifest，一把基座 key 同时点亮基座 + 变体 id。
				// model.list 凭据信号与 listUsable 枚举共用，保证两处口径一致（别名感知）。
				const ALIAS_VARIANTS = { volcengine: ['volcengine-plan'] };
				const aliasBaseOf = (p) => {
					for (const b of Object.keys(ALIAS_VARIANTS)) {
						if (ALIAS_VARIANTS[b].indexOf(p) !== -1) return b;
					}
					return p;
				};

				if (method === 'coclaw.providerAuth.list') {
					// 镜像插件三源合并（§2.4）：账本 + 内联 + env（仅 sole-source）
					const out = [];
					const covered = new Set();
					for (const p of st.profiles) {
						out.push(Object.assign({}, p, { source: 'profile', removable: true }));
						covered.add(p.provider);
					}
					for (const prov of st.inlineProviders) {
						out.push({ profileId: `${prov}#inline`, provider: prov, type: 'api_key', keyPreview: 'sk-i…nlin', source: 'inline', removable: true });
						covered.add(prov);
					}
					for (const prov of st.envProviders) {
						if (covered.has(prov)) continue; // env 仅在未被账本/内联覆盖时才列
						out.push({ profileId: `${prov}#env`, provider: prov, type: 'api_key', source: 'env', removable: false });
					}
					return Promise.resolve({ profiles: out });
				}
				if (method === 'coclaw.providerAuth.setApiKey') {
					const provider = params && params.provider;
					const apiKey = params && params.apiKey;
					// 镜像合约：provider / apiKey 为空或非串 → INVALID_ARGS（catch UI 构造空参的回归）
					if (!provider || typeof provider !== 'string' || !apiKey || typeof apiKey !== 'string') {
						return Promise.reject(Object.assign(new Error('invalid args'), { code: 'INVALID_ARGS' }));
					}
					const profileId = `${provider}:default`;
					st.profiles = st.profiles.filter((p) => p.provider !== provider);
					st.profiles.push({ profileId, provider, type: 'api_key', keyPreview: preview(apiKey) });
					write(st);
					return Promise.resolve({ profileId });
				}
				if (method === 'coclaw.providerAuth.remove') {
					const provider = params && params.provider;
					const source = (params && params.source) || 'profile';
					// 镜像 § 2.5 分派：inline 删内联 key 字段；profile（缺省）删账本；
					// env 不可撤（UI 已禁用按钮，到这也不动）
					if (source === 'inline') {
						st.inlineProviders = st.inlineProviders.filter((p) => p !== provider);
					}
					else if (source !== 'env') {
						st.profiles = st.profiles.filter((p) => p.provider !== provider);
					}
					write(st);
					// 按设计 § 5.4：撤销不主动清 primary，让"失效"橙条自然引导重选
					return Promise.resolve({});
				}
				if (method === 'coclaw.model.list') {
					// 旧插件：出参不带凭据信号字段 → 前端当 false（不再特判压制，该弹 noKey/invalid 就弹）
					if (st.legacy) {
						return Promise.resolve({
							default: { primary: st.primary ?? null },
							agents: { main: { primary: null } },
						});
					}
					// 镜像插件简化契约（§7.4）：凭据信号回传在 model.list 出参里。
					// 凭据信号跨三源（账本 + 内联 + env），与 providerAuth.list 口径一致。
					const providerOf = (p) => {
						if (typeof p !== 'string') return null;
						const i = p.indexOf('/');
						return (i > 0 && i < p.length - 1) ? p.slice(0, i) : null;
					};
					const provs = st.profiles.map((p) => p && p.provider).filter(Boolean)
						.concat(st.inlineProviders, st.envProviders);
					const primaryProvider = providerOf(st.primary);
					// 别名感知：变体 primary（如 volcengine-plan/*）在持基座 key（volcengine）时也算可用，
					// 与 listUsable 枚举同口径（杜绝"选得到却判失效"）
					const providerUsable = !!primaryProvider
							&& (provs.indexOf(primaryProvider) !== -1 || provs.indexOf(aliasBaseOf(primaryProvider)) !== -1);
					return Promise.resolve({
						default: { primary: st.primary ?? null, providerUsable },
						agents: { main: { primary: null, providerUsable: false } },
						hasAnyUsableCredential: provs.length > 0,
					});
				}
				if (method === 'coclaw.model.listUsable') {
					// 旧插件：网关对未注册 method 回 INVALID_REQUEST（unknown method）→ UI 回退到旧交集派生
					if (st.legacy) {
						return Promise.reject(Object.assign(new Error('unknown method: coclaw.model.listUsable'), { code: 'INVALID_REQUEST' }));
					}
					// 三源已配 provider，归一到别名基座 id（镜像真插件 resolveProviderIdForAuth：
					// 变体凭据 volcengine-plan 归一为基座 volcengine）；账本∪内联∪env
					const configuredProviders = [];
					const seenCfg = new Set();
					const addCfg = (p) => {
						if (!p || typeof p !== 'string') return;
						const base = aliasBaseOf(p);
						if (!seenCfg.has(base)) { seenCfg.add(base); configuredProviders.push(base); }
					};
					for (const p of st.profiles) addCfg(p && p.provider);
					for (const p of st.inlineProviders) addCfg(p);
					for (const p of st.envProviders) addCfg(p);
					configuredProviders.sort();
					// 可用 provider 集 = 已配基座 ∪ 其别名变体（基座 key 点亮变体）
					const usableSet = new Set(configuredProviders);
					for (const base of configuredProviders) {
						for (const v of (ALIAS_VARIANTS[base] || [])) usableSet.add(v);
					}
					// byProvider = 干净目录(catalog) 里属于可用 provider 的条目（含变体一等公民）
					const byProvider = {};
					for (const m of st.catalog) {
						if (!m || typeof m.provider !== 'string' || typeof m.id !== 'string') continue;
						if (!usableSet.has(m.provider)) continue;
						(byProvider[m.provider] = byProvider[m.provider] || []).push(m.id);
					}
					return Promise.resolve({ byProvider, configuredProviders });
				}
				if (method === 'coclaw.model.set') {
					const pr = params && params.primary;
					// 镜像合约：primary 须 <provider>/<model> 形态（/ 不在首尾）→ 否则 INVALID_ARGS
					if (typeof pr !== 'string' || pr.indexOf('/') <= 0 || pr.indexOf('/') === pr.length - 1) {
						return Promise.reject(Object.assign(new Error('invalid args'), { code: 'INVALID_ARGS' }));
					}
					st.primary = pr;
					write(st);
					return Promise.resolve({});
				}
				if (method === 'models.list' && params && params.view === 'all') {
					return Promise.resolve({ models: st.catalog.slice() });
				}
				if (method === 'status') {
					// 合成 status，model/provider = 当前 primary 拆分，供 dashboard 的 instance.model/provider。
					// 不透传真实 status：真实 status RPC 受 OpenClaw manifest-cache mismatch 影响每次卡 ~10s，
					// 会把 dashboard 的 loadDashboard 拖在 in-flight，触发飞行去重返回陈旧快照（橙条不刷新）。
					let provider = null;
					let model = null;
					const p = st.primary;
					if (p && typeof p === 'string') {
						const i = p.indexOf('/');
						if (i > 0 && i < p.length - 1) {
							provider = p.slice(0, i);
							model = p.slice(i + 1);
						}
					}
					return Promise.resolve({ model, provider });
				}
				return orig.call(this, method, params, options);
			};
		};
		window.__mcWrap = wrap;

		// document_start 即急切加载并包裹（与 app 同一份模块），抢在 app 首个 RPC 之前生效
		let tries = 0;
		const tryInstall = () => {
			import('/src/services/claw-connection.js')
				.then((m) => {
					if (m && m.ClawConnection) wrap(m.ClawConnection);
					else if (tries++ < 100) setTimeout(tryInstall, 20);
				})
				.catch(() => { if (tries++ < 100) setTimeout(tryInstall, 20); });
		};
		tryInstall();
	}, initial);
}

/**
 * 兜底：导航后再确保一次 wrap 已生效（document_start 急切安装的二次保险，幂等）。
 * @param {import('@playwright/test').Page} page
 */
export async function ensureMockReady(page) {
	await page.evaluate(async () => {
		if (typeof window.__mcWrap === 'function') {
			const m = await import('/src/services/claw-connection.js');
			if (m && m.ClawConnection) window.__mcWrap(m.ClawConnection);
		}
	});
}

/**
 * 取应用当前语言下某个 i18n key 的渲染值，让断言与具体语言解耦
 * （测试 DB 用户可能持久化了 lang=zh-CN，会在登录时覆盖浏览器语言）。
 * @param {import('@playwright/test').Page} page
 * @param {string} key
 * @param {object} [params]
 * @returns {Promise<string>}
 */
export async function tr(page, key, params = {}) {
	return page.evaluate(async ([k, p]) => {
		const m = await import('/src/i18n/index.js');
		return m.i18n.global.t(k, p);
	}, [key, params]);
}

/**
 * 等 dashboard.store 对某台 claw 的状态满足期望（loading=false + 指定派生字段命中）。
 *
 * 两个用途：
 *  1) 两次写操作（如 add→pick）之间让前一次 loadDashboard(force) 先结束，避免后一次因
 *     force-dedup 命中尚在飞行的旧快照（dashboard.store 已知陈旧窗口）。
 *  2) 写操作后、在导航回 /claws 之前，直接断言写回调（onProviderAdded/onPrimaryPicked）触发的
 *     loadDashboard(force) 已把外层 store 刷成期望值——锁住"写回调的强刷新路径"本身，
 *     而非依赖 ManageClawsPage 挂载时各自的 loadData 把断言"救活"。
 *
 * 断言期望"值"（不只是 loading 标志）：dashboard.store 在 entry.loading=false 之后才删
 * _loadingByClaw（两者间隔一个微任务），只看 loading 可能命中那个窗口；命中期望值则无此问题。
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} clawId
 * @param {{ hasAny?: boolean, primaryModel?: string|null, primaryEffective?: boolean }} [expect_]
 * @param {number} [timeout=30000]
 */
export async function waitDashboardSettled(page, clawId, expect_ = {}, timeout = 30_000) {
	await expect(async () => {
		const d = await evalStore(page, 'dashboard', `return store.byClaw['${clawId}'] || null`);
		expect(d, 'dashboard entry should exist').toBeTruthy();
		expect(d.loading, 'dashboard should not be loading').toBeFalsy();
		if (expect_.hasAny !== undefined) {
			expect(d.hasUsableCredential).toBe(expect_.hasAny);
		}
		if (expect_.primaryModel !== undefined) {
			expect(d.primaryModel).toBe(expect_.primaryModel);
		}
		if (expect_.primaryEffective !== undefined) {
			// 仪表盘的"主模型那家有无凭据"信号（§7.4：只看凭据、不查目录）
			expect(d.primaryProviderUsable).toBe(expect_.primaryEffective);
		}
	}).toPass({ timeout });
}

/**
 * 轮询 claws store，返回第一台在线 claw 的 id（无在线 claw 时超时抛错）。
 * @param {import('@playwright/test').Page} page
 * @param {number} [timeout=30000]
 * @returns {Promise<string>}
 */
export async function getOnlineClawId(page, timeout = 30_000) {
	let clawId = '';
	await expect(async () => {
		const ids = await evalStore(page, 'claws', 'return store.items.filter(c => c.online).map(c => String(c.id))');
		expect(Array.isArray(ids) && ids.length).toBeTruthy();
		clawId = ids[0];
	}).toPass({ timeout });
	return clawId;
}
