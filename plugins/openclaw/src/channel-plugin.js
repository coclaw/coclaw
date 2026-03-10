import { DEFAULT_ACCOUNT_ID } from './config.js';

function resolveAccount(_cfg, accountId) {
	const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
	return {
		accountId: resolvedAccountId,
		enabled: true,
		configured: true,
		name: 'CoClaw',
	};
}

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
		// placeholder: CoClaw 消息实际通过 realtime-bridge WebSocket 桥接发送，
		// 此 sendText 仅满足 OpenClaw channel 注册要求。
		sendText: async ({ to }) => ({
			channel: 'coclaw',
			messageId: `coclaw-${Date.now()}`,
			to,
		}),
	},
	// TODO: status.defaultRuntime.running 应反映 realtime-bridge 实际连接状态
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
