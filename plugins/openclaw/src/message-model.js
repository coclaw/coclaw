// placeholder: 当前仅被 transport-adapter 使用，预留用于未来 channel outbound 消息规范化。

function isNonEmptyString(value) {
	return typeof value === 'string' && value.trim() !== '';
}

export function normalizeInboundEnvelope(input) {
	if (!input || typeof input !== 'object') {
		throw new Error('inbound envelope must be an object');
	}

	const channel = isNonEmptyString(input.channel) ? input.channel.trim() : 'coclaw';
	const chatId = isNonEmptyString(input.chatId) ? input.chatId.trim() : null;
	const senderId = isNonEmptyString(input.senderId) ? input.senderId.trim() : null;
	const text = typeof input.text === 'string' ? input.text : '';
	const messageId = isNonEmptyString(input.messageId)
		? input.messageId.trim()
		: `coclaw-in-${Date.now()}`;
	const chatType = isNonEmptyString(input.chatType) ? input.chatType.trim() : 'direct';
	const timestamp = Number.isFinite(input.timestamp)
		? Number(input.timestamp)
		: Date.now();

	if (!chatId) {
		throw new Error('chatId is required');
	}
	if (!senderId) {
		throw new Error('senderId is required');
	}

	return {
		channel,
		chatId,
		senderId,
		text,
		messageId,
		chatType,
		timestamp,
		raw: input,
	};
}

export function buildOutboundEnvelope(input) {
	if (!input || typeof input !== 'object') {
		throw new Error('outbound envelope must be an object');
	}

	const channel = isNonEmptyString(input.channel) ? input.channel.trim() : 'coclaw';
	const to = isNonEmptyString(input.to) ? input.to.trim() : null;
	const text = typeof input.text === 'string' ? input.text : '';
	const messageId = isNonEmptyString(input.messageId)
		? input.messageId.trim()
		: `coclaw-out-${Date.now()}`;
	const timestamp = Number.isFinite(input.timestamp)
		? Number(input.timestamp)
		: Date.now();

	if (!to) {
		throw new Error('to is required');
	}

	return {
		channel,
		to,
		text,
		messageId,
		timestamp,
	};
}
