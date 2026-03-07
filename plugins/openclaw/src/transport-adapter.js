import { buildOutboundEnvelope, normalizeInboundEnvelope } from './message-model.js';

export function createTransportAdapter(deps = {}) {
	const {
		sendOutbound = async () => ({ accepted: true }),
		onInbound = async () => undefined,
		logger = console,
	} = deps;

	async function dispatchInbound(rawEnvelope) {
		const inbound = normalizeInboundEnvelope(rawEnvelope);
		await onInbound(inbound);
		return inbound;
	}

	async function dispatchOutbound(rawEnvelope) {
		const outbound = buildOutboundEnvelope(rawEnvelope);
		const result = await sendOutbound(outbound);
		return {
			accepted: Boolean(result?.accepted ?? true),
			messageId: outbound.messageId,
		};
	}

	function safeDispatchInbound(rawEnvelope) {
		return dispatchInbound(rawEnvelope).catch((err) => {
			logger.warn?.(`[coclaw-transport] inbound failed: ${String(err?.message ?? err)}`);
			return null;
		});
	}

	function safeDispatchOutbound(rawEnvelope) {
		/* c8 ignore start */
		return dispatchOutbound(rawEnvelope).catch((err) => {
			logger.warn?.(`[coclaw-transport] outbound failed: ${String(err?.message ?? err)}`);
			return {
				accepted: false,
				error: String(err?.message ?? err),
			};
		});
		/* c8 ignore stop */
	}

	return {
		dispatchInbound,
		dispatchOutbound,
		safeDispatchInbound,
		safeDispatchOutbound,
	};
}
