import fs from 'fs';
import os from 'os';
import nodePath from 'path';
import { fileURLToPath } from 'url';
import { test, expect } from 'vitest';

import {
	collectPackages,
	readPackageLicense,
	pickFallbackIds,
	extractCopyrightLines,
	buildNotices,
	getInstalledElectronVersion,
	MANUAL_ENTRIES,
	FILE_LEVEL_ENTRIES,
	ELECTRON_VERSIONS,
	OUTPUT_REL_PATH,
} from './generate-third-party-notices.js';

const UI_ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..');

// ---- collectPackages ----

test('collectPackages 递归去重并按名称排序', () => {
	const tree = {
		dependencies: {
			b: { version: '1.0.0', path: '/b', dependencies: {
				a: { version: '2.0.0', path: '/a' },
			} },
			a: { version: '2.0.0', path: '/a-dup' }, // 同 name@version 去重，保留首见 path
		},
	};
	const pkgs = collectPackages(tree);
	expect(pkgs.map((p) => `${p.name}@${p.version}`)).toEqual(['a@2.0.0', 'b@1.0.0']);
	expect(pkgs[0].path).toBe('/a');
});

test('collectPackages 排除 lightningcss 系列与手工收录包', () => {
	const tree = {
		dependencies: {
			'lightningcss': { version: '1.30.0', path: '/l' },
			'lightningcss-linux-x64-gnu': { version: '1.30.0', path: '/lp' },
			'lightningcss-win32-x64-msvc': { version: '1.30.0', path: '/lw' },
			'vaul-vue': { version: '0.4.1', path: '/v' }, // MANUAL_ENTRIES 收录，不重复生成
			'ok-pkg': { version: '1.0.0', path: '/ok' },
		},
	};
	const pkgs = collectPackages(tree);
	expect(pkgs.map((p) => p.name)).toEqual(['ok-pkg']);
});

test('collectPackages 空树返回空数组', () => {
	expect(collectPackages({})).toEqual([]);
});

// ---- pickFallbackIds ----

test('pickFallbackIds 处理单一 id / OR / AND 表达式', () => {
	expect(pickFallbackIds('MIT')).toEqual(['MIT']);
	// OR：取第一个有模板的
	expect(pickFallbackIds('(MIT OR CC0-1.0)')).toEqual(['MIT']);
	expect(pickFallbackIds('(CC0-1.0 OR MIT)')).toEqual(['MIT']);
	// AND：全部输出
	expect(pickFallbackIds('(Apache-2.0 AND BSD-3-Clause)')).toEqual(['Apache-2.0', 'BSD-3-Clause']);
	// 无模板的 id 原样保留（走 SPDX 链接兜底）
	expect(pickFallbackIds('WTFPL')).toEqual(['WTFPL']);
});

// ---- readPackageLicense ----

function makePkgDir(files) {
	const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'tpn-test-'));
	for (const [name, content] of Object.entries(files)) {
		fs.writeFileSync(nodePath.join(dir, name), content);
	}
	return dir;
}

test('readPackageLicense 读取 LICENSE 与 NOTICE 文件', () => {
	const dir = makePkgDir({
		'package.json': JSON.stringify({ license: 'Apache-2.0', author: { name: 'Alice' } }),
		'LICENSE.txt': 'THE LICENSE TEXT\r\n(with CRLF)\r\n',
		'NOTICE': 'THE NOTICE TEXT',
	});
	const e = readPackageLicense({ name: 'p', version: '1.0.0', path: dir });
	expect(e.spdx).toBe('Apache-2.0');
	expect(e.author).toBe('Alice');
	expect(e.licenseText).toBe('THE LICENSE TEXT\n(with CRLF)'); // CRLF 归一 + trim
	expect(e.noticeText).toBe('THE NOTICE TEXT');
});

test('readPackageLicense 无许可证文件时 licenseText 为 null', () => {
	const dir = makePkgDir({
		'package.json': JSON.stringify({ license: 'MIT', author: 'Bob <bob@x.y>' }),
	});
	const e = readPackageLicense({ name: 'p', version: '1.0.0', path: dir });
	expect(e.licenseText).toBeNull();
	expect(e.copyrightText).toBeNull(); // 无 README 时也无版权行
	expect(e.author).toBe('Bob <bob@x.y>');
});

test('readPackageLicense 识别 LICENSE-MIT / license-mit.txt / LICENSE.BSD 等文件名变体', () => {
	for (const fname of ['LICENSE-MIT', 'license-mit.txt', 'LICENSE.BSD', 'LICENCE_MIT.md']) {
		const dir = makePkgDir({
			'package.json': JSON.stringify({ license: 'MIT' }),
			[fname]: `TEXT OF ${fname}`,
		});
		const e = readPackageLicense({ name: 'p', version: '1.0.0', path: dir });
		expect(e.licenseText).toBe(`TEXT OF ${fname}`);
	}
});

test('readPackageLicense 不把 license.js 等代码文件当许可证', () => {
	const dir = makePkgDir({
		'package.json': JSON.stringify({ license: 'MIT' }),
		'license.js': 'module.exports = {};',
		'license.json': '{}',
	});
	const e = readPackageLicense({ name: 'p', version: '1.0.0', path: dir });
	expect(e.licenseText).toBeNull();
});

test('readPackageLicense 无许可证文件时回读 README 抽取版权行', () => {
	const dir = makePkgDir({
		'package.json': JSON.stringify({ license: 'MIT' }),
		'README.md': [
			'# bplist-parser',
			'',
			'## License',
			'',
			'(The MIT License)',
			'',
			'Copyright (c) 2012 Near Infinity Corporation',
			'',
			'Permission is hereby granted, free of charge...',
			'',
			'The above copyright notice and this permission notice shall be included.',
		].join('\n'),
	});
	const e = readPackageLicense({ name: 'p', version: '1.0.0', path: dir });
	expect(e.licenseText).toBeNull();
	// 只抽真实版权行，不误抓 "The above copyright notice..." 条款行
	expect(e.copyrightText).toBe('Copyright (c) 2012 Near Infinity Corporation');
});

test('readPackageLicense 有许可证文件时不读 README（版权行已在许可文本里）', () => {
	const dir = makePkgDir({
		'package.json': JSON.stringify({ license: 'MIT' }),
		'LICENSE': 'Copyright (c) Real Owner\nMIT...',
		'README.md': 'Copyright (c) 2000 Someone Else',
	});
	const e = readPackageLicense({ name: 'p', version: '1.0.0', path: dir });
	expect(e.licenseText).toBe('Copyright (c) Real Owner\nMIT...');
	expect(e.copyrightText).toBeNull();
});

// ---- extractCopyrightLines ----

test('extractCopyrightLines 剥 markdown 标记、去重、封顶 5 条', () => {
	const text = [
		'## Copyright (c) 2020 Alice **',
		'> Copyright © 2021 Bob',
		'Copyright (c) 2020 Alice', // 与首条剥标记后相同 → 去重
		'copyright 2019 Carol',
		'The above copyright notice shall be included.', // 条款行不匹配
		'Copyright (c) A', 'Copyright (c) B', 'Copyright (c) C', 'Copyright (c) D',
	].join('\n');
	const lines = extractCopyrightLines(text);
	expect(lines).toEqual([
		'Copyright (c) 2020 Alice',
		'Copyright © 2021 Bob',
		'copyright 2019 Carol',
		'Copyright (c) A',
		'Copyright (c) B',
	]);
});

test('readPackageLicense 缺 license 字段时 spdx 为 UNKNOWN', () => {
	const dir = makePkgDir({ 'package.json': '{}' });
	const e = readPackageLicense({ name: 'p', version: '1.0.0', path: dir });
	expect(e.spdx).toBe('UNKNOWN');
});

test('readPackageLicense 目录不存在（未安装的平台可选依赖）返回 null', () => {
	expect(readPackageLicense({ name: 'p', version: '1', path: '/nonexistent/tpn-xyz' })).toBeNull();
});

// ---- buildNotices ----

test('buildNotices 相同文本分组、不同文本分开、保留版权行', () => {
	const doc = buildNotices([
		{ name: 'a', version: '1.0.0', spdx: 'MIT', author: null, licenseText: 'SHARED TEXT', noticeText: null },
		{ name: 'b', version: '2.0.0', spdx: 'MIT', author: null, licenseText: 'SHARED TEXT', noticeText: null },
		{ name: 'c', version: '3.0.0', spdx: 'MIT', author: null, licenseText: 'Copyright (c) Carol\nOTHER TEXT', noticeText: null },
		null, // 未安装的包被跳过
	]);
	expect(doc).toContain('a@1.0.0\nb@2.0.0');
	expect(doc).toContain('Copyright (c) Carol');
	// 共享文本只出现一次
	expect(doc.split('SHARED TEXT').length - 1).toBe(1);
});

test('buildNotices 无内嵌文本的包输出权威模板并标注作者', () => {
	const doc = buildNotices([
		{ name: 'nofile', version: '1.0.0', spdx: 'MIT', author: 'Dave', licenseText: null, noticeText: null },
	]);
	expect(doc).toContain('nofile@1.0.0 (Dave)');
	expect(doc).toContain('declared under "MIT"');
	expect(doc).toContain('Permission is hereby granted, free of charge');
	// 组内无回读版权行时不出现 README 回读说明
	expect(doc).not.toContain('recovered from the package README');
});

test('buildNotices 兜底组保留 README 回读的版权行并注明来源', () => {
	const doc = buildNotices([
		{ name: 'withcr', version: '1.0.0', spdx: 'MIT', author: 'Eve', licenseText: null, noticeText: null, copyrightText: 'Copyright (c) 2012 Near Infinity Corporation' },
		{ name: 'nocr', version: '2.0.0', spdx: 'MIT', author: null, licenseText: null, noticeText: null, copyrightText: null },
	]);
	expect(doc).toContain('withcr@1.0.0 (Eve)\n  Copyright (c) 2012 Near Infinity Corporation\nnocr@2.0.0');
	expect(doc).toContain('recovered from the package README files');
});

test('buildNotices 无模板的 SPDX id 走链接兜底', () => {
	const doc = buildNotices([
		{ name: 'odd', version: '1.0.0', spdx: 'WTFPL', author: null, licenseText: null, noticeText: null },
	]);
	expect(doc).toContain('https://spdx.org/licenses/WTFPL.html');
});

test('buildNotices 附带 NOTICE 文本、手工条目与 FFmpeg/Electron 附录', () => {
	const doc = buildNotices([
		{ name: 'apachy', version: '1.0.0', spdx: 'Apache-2.0', author: null, licenseText: 'APACHE TEXT', noticeText: 'ATTRIBUTION' },
	]);
	expect(doc).toContain('NOTICE:\n\nATTRIBUTION');
	// 手工条目（取证收录）
	expect(doc).toContain('vaul-vue@0.4.1');
	expect(doc).toContain('Copyright (c) 2025 unovue');
	// 附录
	expect(doc).toContain('APPENDIX A — FFmpeg');
	expect(doc).toContain('NOT statically linked');
	expect(doc).toContain('https://ffmpeg.org');
	expect(doc).toContain('https://github.com/electron/electron');
	expect(doc).toContain('LICENSE.electron.txt');
});

test('FFmpeg 附录给出精确版本对应源码指针，且 Windows 文件名为 ffmpeg.dll', () => {
	const doc = buildNotices([]);
	expect(doc).toContain(`Electron ${ELECTRON_VERSIONS.electron}`);
	expect(doc).toContain(`Chromium ${ELECTRON_VERSIONS.chromium}`);
	expect(doc).toContain(`https://github.com/electron/electron/tree/v${ELECTRON_VERSIONS.electron}`);
	expect(doc).toContain('https://chromium.googlesource.com/chromium/third_party/ffmpeg');
	expect(doc).toContain('ffmpeg.dll');
	expect(doc).not.toContain('libffmpeg.dll'); // Windows 下实际文件名是 ffmpeg.dll
	// 许可文件不载版本号，不得声称版本写在其中
	expect(doc).not.toContain('versions in use are listed in');
});

test('ELECTRON_VERSIONS 与实际安装的 electron 一致（bump 后须同步更新附录常量）', () => {
	expect(ELECTRON_VERSIONS.electron).toBe(getInstalledElectronVersion());
});

// MANUAL_ENTRIES 里的 SPM 版本是硬编码副本，权威来源是 xcode 的 Package.resolved；
// SPM 升级后忘了同步会在此先红。
test('MANUAL_ENTRIES 的 SPM 版本与 ios Package.resolved 一致', () => {
	const resolved = JSON.parse(fs.readFileSync(
		nodePath.join(UI_ROOT, 'ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved'), 'utf8'));
	const pins = new Map(resolved.pins.map((p) => [p.identity, p.state?.version]));
	for (const name of ['capacitor-swift-pm', 'ion-ios-filesystem']) {
		const entry = MANUAL_ENTRIES.find((e) => e.name === name);
		expect(entry, `${name} 应在 MANUAL_ENTRIES`).toBeTruthy();
		expect(entry.version).toBe(pins.get(name));
	}
});

// ---- 文件级归属（FILE_LEVEL_ENTRIES）----

test('buildNotices 输出文件级归属条目（包名 + 文件路径 + 版权行）', () => {
	const doc = buildNotices([]);
	for (const f of FILE_LEVEL_ENTRIES) {
		expect(doc).toContain(`${f.name} (file-level attribution)`);
		for (const p of f.files) expect(doc).toContain(`  ${p}`);
		for (const probe of f.probes) expect(doc).toContain(probe);
	}
	// 静态取证文本抽查：BSD-2 归属须带条款与免责，Apache 归属须带全文
	expect(doc).toContain('Copyright (c) 2014, Ashley Mills');
	expect(doc).toContain('Redistributions of source code must retain the above copyright notice');
	expect(doc).toContain('Copyright (C) 2006 The Android Open Source Project (UriMatcher.java)');
});

// 文件级归属的静态取证与实际安装包对账：升级包后源文件头若变化（文件移走 / 版权行变），
// 这条先红，提醒重新取证再重生成。
test('FILE_LEVEL_ENTRIES 与安装包内源文件头一致', () => {
	for (const f of FILE_LEVEL_ENTRIES) {
		expect(f.files.length).toBe(f.probes.length);
		f.files.forEach((rel, i) => {
			const src = fs.readFileSync(nodePath.join(UI_ROOT, 'node_modules', f.name, rel), 'utf8');
			expect(src, `${f.name}/${rel} 应含取证版权行`).toContain(f.probes[i]);
		});
	}
});

// lightningcss 被生成器无条件排除的前提是 electron-builder 把它裁出 asar。
// 收紧后白名单先整棵排除 node_modules，再逐个重新纳入壳子运行时闭环；lightningcss
// 不在重新纳入之列，故不进 asar。若有人删了整棵排除、或把 lightningcss 加进白名单，
// 这条先红，防"实际分发却不披露"。
test('electron-builder 把 lightningcss 裁出 asar（整棵排除 + 不重新纳入）', () => {
	const yaml = fs.readFileSync(nodePath.join(UI_ROOT, 'electron-builder.yaml'), 'utf8');
	expect(yaml).toContain('!**/node_modules/**');
	expect(yaml).not.toMatch(/^\s*-\s*"?node_modules\/lightningcss/m);
});

// ---- 生成产物（已入库文件）守卫 ----

test('public/third-party-notices.txt 已生成且内容完整', () => {
	const p = nodePath.join(UI_ROOT, OUTPUT_REL_PATH);
	expect(fs.existsSync(p)).toBe(true);
	const doc = fs.readFileSync(p, 'utf8');
	expect(doc.length).toBeGreaterThan(100_000);
	for (const m of MANUAL_ENTRIES) {
		expect(doc).toContain(`${m.name}@${m.version}`);
	}
	// 文件级归属（编入 IPA/APK 的 BSD-2 / Apache-2.0 文件）须在产物中
	for (const f of FILE_LEVEL_ENTRIES) {
		expect(doc).toContain(`${f.name} (file-level attribution)`);
		for (const probe of f.probes) expect(doc).toContain(probe);
	}
	// 文件级归属不剔除包本体：@capacitor/network 的 MIT 主许可条目仍在
	expect(doc).toContain('@capacitor/network@');
	expect(doc).toContain('APPENDIX A — FFmpeg');
	// README 回读生效：bplist-parser 的真实版权行须在产物里（其只写在 README）
	expect(doc).toContain('Copyright (c) 2012 Near Infinity Corporation');
	// 附录版本指针与措辞诚实性
	expect(doc).toContain(`Electron ${ELECTRON_VERSIONS.electron}`);
	expect(doc).not.toContain('libffmpeg.dll');
	expect(doc).not.toContain('Copyright (c) 2024 Shin Yoshiaki');
	// 裁剪包不应出现在告知中
	expect(doc).not.toMatch(/^lightningcss/m);
});
