import { describe, expect, test, vi } from 'vitest';

import { isMobileViewport, isTouchDevice } from './layout.js';

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

	test('isTouchDevice returns true when pointer is coarse', () => {
		const orig = window.matchMedia;
		window.matchMedia = vi.fn((q) => ({ matches: q === '(pointer: coarse)' }));
		expect(isTouchDevice()).toBe(true);
		window.matchMedia = orig;
	});

	test('isTouchDevice returns false when pointer is fine', () => {
		const orig = window.matchMedia;
		window.matchMedia = vi.fn(() => ({ matches: false }));
		expect(isTouchDevice()).toBe(false);
		window.matchMedia = orig;
	});
});
