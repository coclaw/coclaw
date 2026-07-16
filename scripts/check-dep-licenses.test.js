import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLicenseId, scanLicensesMap } from './check-dep-licenses.js';

test('strong copyleft ids classify as strong', () => {
	assert.equal(classifyLicenseId('GPL-3.0'), 'strong');
	assert.equal(classifyLicenseId('GPL-2.0-only'), 'strong');
	assert.equal(classifyLicenseId('AGPL-3.0-or-later'), 'strong');
	assert.equal(classifyLicenseId('SSPL-1.0'), 'strong');
});

test('weak copyleft ids classify as weak', () => {
	assert.equal(classifyLicenseId('LGPL-2.1'), 'weak');
	assert.equal(classifyLicenseId('MPL-2.0'), 'weak');
	assert.equal(classifyLicenseId('EPL-1.0'), 'weak');
	assert.equal(classifyLicenseId('CDDL-1.0'), 'weak');
});

test('permissive ids classify as ok', () => {
	assert.equal(classifyLicenseId('MIT'), 'ok');
	assert.equal(classifyLicenseId('Apache-2.0'), 'ok');
	assert.equal(classifyLicenseId('BSD-3-Clause'), 'ok');
	assert.equal(classifyLicenseId('ISC'), 'ok');
});

test('OR expression takes the most permissive branch', () => {
	// 双许可可择宽路：含 permissive 分支即放行
	assert.equal(classifyLicenseId('(MIT OR GPL-3.0)'), 'ok');
	assert.equal(classifyLicenseId('(MIT OR CC0-1.0)'), 'ok');
});

test('AND expression takes the most severe part', () => {
	assert.equal(classifyLicenseId('(GPL-2.0 AND MIT)'), 'strong');
	assert.equal(classifyLicenseId('(Apache-2.0 AND BSD-3-Clause)'), 'ok');
});

test('SPDX WITH exception strips to the base license', () => {
	assert.equal(classifyLicenseId('Apache-2.0 WITH LLVM-exception'), 'ok');
});

test('unknown ids classify as unknown', () => {
	assert.equal(classifyLicenseId('Unknown'), 'unknown');
});

test('scanLicensesMap flags a map containing a GPL package as a violation', () => {
	const map = {
		'GPL-3.0': [{ name: 'evil-pkg', versions: ['1.0.0'] }],
		MIT: [{ name: 'nice-pkg', versions: ['2.0.0'] }]
	};
	const { violations, warnings, packageCount } = scanLicensesMap(map);
	assert.equal(violations.length, 1);
	assert.equal(violations[0].licenseId, 'GPL-3.0');
	assert.equal(violations[0].packages[0].name, 'evil-pkg');
	assert.equal(warnings.length, 0);
	assert.equal(packageCount, 2);
});

test('scanLicensesMap reports zero violations for a purely permissive map', () => {
	const map = {
		MIT: [{ name: 'a', versions: ['1.0.0'] }],
		'Apache-2.0': [{ name: 'b', versions: ['2.0.0'] }],
		ISC: [{ name: 'c', versions: ['3.0.0'] }]
	};
	const { violations, warnings, packageCount } = scanLicensesMap(map);
	assert.equal(violations.length, 0);
	assert.equal(warnings.length, 0);
	assert.equal(packageCount, 3);
});
