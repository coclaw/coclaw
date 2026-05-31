import { test, describe, expect } from 'vitest';

import { mapModelConfigErrorKey, isCanceledError } from './model-config-errors.js';

describe('mapModelConfigErrorKey', () => {
	test('INVALID_ARGS → errInvalidArgs', () => {
		const err = Object.assign(new Error('bad input'), { code: 'INVALID_ARGS' });
		expect(mapModelConfigErrorKey(err, 'fallback')).toBe('modelConfig.common.errInvalidArgs');
	});

	test('IO_FAILED → errIoFailed', () => {
		const err = Object.assign(new Error('io'), { code: 'IO_FAILED' });
		expect(mapModelConfigErrorKey(err, 'fallback')).toBe('modelConfig.common.errIoFailed');
	});

	test('CONNECT_TIMEOUT → connError', () => {
		const err = Object.assign(new Error('ct'), { code: 'CONNECT_TIMEOUT' });
		expect(mapModelConfigErrorKey(err, 'fallback')).toBe('modelConfig.common.connError');
	});

	test('RTC_LOST → connError', () => {
		const err = Object.assign(new Error('rl'), { code: 'RTC_LOST' });
		expect(mapModelConfigErrorKey(err, 'fallback')).toBe('modelConfig.common.connError');
	});

	test('DC_CLOSED → connError', () => {
		const err = Object.assign(new Error('dc'), { code: 'DC_CLOSED' });
		expect(mapModelConfigErrorKey(err, 'fallback')).toBe('modelConfig.common.connError');
	});

	test('RPC_TIMEOUT → connError', () => {
		const err = Object.assign(new Error('to'), { code: 'RPC_TIMEOUT' });
		expect(mapModelConfigErrorKey(err, 'fallback')).toBe('modelConfig.common.connError');
	});

	test('RTC_SEND_FAILED → connError', () => {
		const err = Object.assign(new Error('sf'), { code: 'RTC_SEND_FAILED' });
		expect(mapModelConfigErrorKey(err, 'fallback')).toBe('modelConfig.common.connError');
	});

	test('unknown code → fallback', () => {
		const err = Object.assign(new Error('weird'), { code: 'SOMETHING_ELSE' });
		expect(mapModelConfigErrorKey(err, 'modelConfig.providerAuth.add.submitFailed')).toBe('modelConfig.providerAuth.add.submitFailed');
	});

	test('no code → fallback', () => {
		expect(mapModelConfigErrorKey(new Error('plain'), 'fb')).toBe('fb');
	});

	test('null err → fallback', () => {
		expect(mapModelConfigErrorKey(null, 'fb')).toBe('fb');
	});

	test('undefined err → fallback', () => {
		expect(mapModelConfigErrorKey(undefined, 'fb')).toBe('fb');
	});

	test('non-object err (string) → fallback', () => {
		expect(mapModelConfigErrorKey('some-message', 'fb')).toBe('fb');
	});

	test('ERR_CANCELED is NOT mapped to connError → falls through to fallback', () => {
		// 显式取消由调用方自行处理；不该被映射成"连接异常"
		const err = Object.assign(new Error('cancel'), { code: 'ERR_CANCELED' });
		expect(mapModelConfigErrorKey(err, 'fb')).toBe('fb');
	});
});

describe('isCanceledError', () => {
	test('true for ERR_CANCELED', () => {
		const err = Object.assign(new Error('cancel'), { code: 'ERR_CANCELED' });
		expect(isCanceledError(err)).toBe(true);
	});

	test('false for other codes', () => {
		const err = Object.assign(new Error('x'), { code: 'IO_FAILED' });
		expect(isCanceledError(err)).toBe(false);
	});

	test('false for plain Error', () => {
		expect(isCanceledError(new Error('x'))).toBe(false);
	});

	test('false for null / undefined / non-object', () => {
		expect(isCanceledError(null)).toBe(false);
		expect(isCanceledError(undefined)).toBe(false);
		expect(isCanceledError('cancel')).toBe(false);
	});
});

