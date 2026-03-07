import { describe, expect, test } from 'vitest';

import { getAuthedHomeRoute, isMobileViewport } from './layout.js';

describe('layout utils', () => {
	test('isMobileViewport should return true for mobile widths', () => {
		expect(isMobileViewport(390)).toBe(true);
		expect(isMobileViewport(767)).toBe(true);
	});

	test('isMobileViewport should return false for desktop widths and invalid values', () => {
		expect(isMobileViewport(768)).toBe(false);
		expect(isMobileViewport(1440)).toBe(false);
		expect(isMobileViewport()).toBe(false);
		expect(isMobileViewport('390')).toBe(false);
	});

	test('getAuthedHomeRoute should match viewport mode', () => {
		expect(getAuthedHomeRoute(360)).toBe('/topics');
		expect(getAuthedHomeRoute(1280)).toBe('/home');
	});
});
