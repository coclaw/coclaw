// placeholder: 当前 CoClaw 消息通过 realtime-bridge WebSocket 桥接收发，
// 此适配层预留用于未来通过 OpenClaw channel outbound 接口发送消息。
import { buildOutboundEnvelope, normalizeInboundEnvelope } from './message-model.js';

export function createTransportAdapter(deps = {}) {
	const {
		/* c8 ignore next */
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
