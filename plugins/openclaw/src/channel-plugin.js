import { DEFAULT_ACCOUNT_ID } from './config.js';
import { createTransportAdapter } from './transport-adapter.js';

function resolveAccount(_cfg, accountId) {
	const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
	return {
		accountId: resolvedAccountId,
		enabled: true,
		configured: true,
		name: 'CoClaw',
	};
}

const transport = createTransportAdapter();

export const coclawChannelPlugin = {
	id: 'coclaw',
	meta: {
		id: 'coclaw',
		label: 'CoClaw',
		selectionLabel: 'CoClaw',
		docsPath: 'https://docs.coclaw.net',
		blurb: 'CoClaw channel plugin for remote chat',
	},
	capabilities: {
		chatTypes: ['direct'],
		nativeCommands: true,
		media: false,
		reactions: false,
		threads: false,
		polls: false,
	},
	config: {
		listAccountIds: () => [DEFAULT_ACCOUNT_ID],
		resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),
		defaultAccountId: () => DEFAULT_ACCOUNT_ID,
		isConfigured: () => true,
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: true,
		}),
	},
	outbound: {
		deliveryMode: 'direct',
		sendText: async ({ to, text }) => {
			const result = await transport.safeDispatchOutbound({
				channel: 'coclaw',
				to,
				text,
			});
			return {
				channel: 'coclaw',
				messageId: result.messageId ?? `coclaw-local-${Date.now()}`,
				to,
				text,
				accepted: Boolean(result.accepted),
			};
		},
	},
	status: {
		defaultRuntime: {
			accountId: DEFAULT_ACCOUNT_ID,
			running: true,
			lastStartAt: null,
			lastStopAt: null,
			lastError: null,
		},
	},
};
