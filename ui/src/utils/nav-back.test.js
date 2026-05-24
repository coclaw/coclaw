import { test, expect, vi, beforeEach } from 'vitest';

import { navBack } from './nav-back.js';

let routerBackMock;
let routerReplaceMock;
let router;

beforeEach(() => {
	routerBackMock = vi.fn();
	routerReplaceMock = vi.fn();
	router = { back: routerBackMock, replace: routerReplaceMock };
});

test('history 中存在 back 时调用 router.back()', () => {
	const orig = history.state;
	history.replaceState({ ...history.state, back: '/somewhere' }, '');
	try {
		navBack(router, '/claws');
		expect(routerBackMock).toHaveBeenCalledTimes(1);
		expect(routerReplaceMock).not.toHaveBeenCalled();
	}
	finally {
		history.replaceState(orig, '');
	}
});

test('history 无 back 时 replace 到 fallback', () => {
	const orig = history.state;
	history.replaceState({ back: null }, '');
	try {
		navBack(router, '/claws');
		expect(routerReplaceMock).toHaveBeenCalledTimes(1);
		expect(routerReplaceMock).toHaveBeenCalledWith('/claws');
		expect(routerBackMock).not.toHaveBeenCalled();
	}
	finally {
		history.replaceState(orig, '');
	}
});

test('fallback 缺省时使用 "/"', () => {
	const orig = history.state;
	history.replaceState({ back: null }, '');
	try {
		navBack(router);
		expect(routerReplaceMock).toHaveBeenCalledWith('/');
	}
	finally {
		history.replaceState(orig, '');
	}
});

test('history.state 为 null 时走 fallback 分支', () => {
	const orig = history.state;
	history.replaceState(null, '');
	try {
		navBack(router, '/home');
		expect(routerReplaceMock).toHaveBeenCalledWith('/home');
		expect(routerBackMock).not.toHaveBeenCalled();
	}
	finally {
		history.replaceState(orig, '');
	}
});
