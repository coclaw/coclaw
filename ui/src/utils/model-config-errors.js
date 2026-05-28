/**
 * 把 plugin RPC 错误 + 通道错误统一映射到 modelConfig.common.* i18n key。
 *
 * 控制流仅依赖结构化 err.code（feedback-no-string-match-control-flow）；
 * 不读 err.message——message 含 raw key 风险、且不稳定。
 *
 * 返回 i18n key（调用方负责 $t 翻译），便于组件层在不同语言上下文复用。
 *
 * 已知错误码来源：
 *  - 业务层（plugins/openclaw/docs/model-config-api.md）：
 *      INVALID_ARGS / IO_FAILED
 *  - 通道层（src/services/claw-connection.js reject 路径）：
 *      CONNECT_TIMEOUT / RTC_LOST / DC_CLOSED / RPC_TIMEOUT / RTC_SEND_FAILED
 *  - 显式取消（ERR_CANCELED）由调用方自行处理，不走此映射
 */

const CONN_ERROR_CODES = new Set([
	'CONNECT_TIMEOUT',
	'RTC_LOST',
	'DC_CLOSED',
	'RPC_TIMEOUT',
	'RTC_SEND_FAILED',
]);

/**
 * 把错误转成 i18n key。fallback 给调用方传入——不同场景兜底文案不同
 * （例：撤销失败用 removeFailed、加 key 失败用 errIoFailed）。
 *
 * @param {unknown} err - RPC 抛出的错误对象；非 object 时按未知处理
 * @param {string} fallbackKey - 没有匹配上时的兜底 i18n key
 * @returns {string} i18n key
 */
export function mapModelConfigErrorKey(err, fallbackKey) {
	const code = err && typeof err === 'object' ? err.code : undefined;
	if (code === 'INVALID_ARGS') return 'modelConfig.common.errInvalidArgs';
	if (code === 'IO_FAILED') return 'modelConfig.common.errIoFailed';
	if (typeof code === 'string' && CONN_ERROR_CODES.has(code)) return 'modelConfig.common.connError';
	return fallbackKey;
}

/**
 * 仅判定是否是"显式取消"——业务层用于在 catch 里区分主动取消与真实错误。
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isCanceledError(err) {
	return !!(err && typeof err === 'object' && err.code === 'ERR_CANCELED');
}

/**
 * 判定是否是"方法不存在"——网关对未注册的 RPC method 统一回 `INVALID_REQUEST`
 * （上游 gateway/server-methods.ts：`unknown method: <m>` → errorShape(INVALID_REQUEST)），
 * 经 claw-connection.js 把 payload.error.code 原样挂到 err.code 上。
 *
 * 用途：旧插件没有 `coclaw.model.listUsable` 时该调用 reject 为此码 → 选模型器回退到旧派生。
 * 仅依赖结构化 err.code，不读 message（feedback-no-string-match-control-flow）。
 *
 * 注意：listUsable 新插件自身的业务错误是 INVALID_ARGS / IO_FAILED，绝不返回 INVALID_REQUEST，
 * 故此码可唯一标识"网关层方法分发失败 = 旧插件无此方法"。
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isMethodNotFoundError(err) {
	return !!(err && typeof err === 'object' && err.code === 'INVALID_REQUEST');
}
