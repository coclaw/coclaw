/**
 * 生成 THIRD-PARTY-NOTICES（第三方开源许可告知）→ public/third-party-notices.txt
 *
 * 用法：pnpm licenses:generate（cwd = ui/；依赖变更后需重新生成并随代码提交）
 *
 * 机制：
 * - 依赖树解析交给 pnpm 本身（`pnpm list --prod --depth Infinity --json`），
 *   精确限定为 ui 的生产依赖子树（不含 server / plugin 等其它 workspace 包）；
 * - 脚本只做：读各包的 LICENSE/NOTICE 文件（含 LICENSE-MIT / license.md 等变体）
 *   与 package.json → 按相同文本分组汇总；
 * - 发布包未内嵌许可证文件的，回读 README 抽取版权行（保留真实归属），
 *   再按声明的 SPDX id 输出权威模板文本兜底；
 * - 手工收录条目（MANUAL_ENTRIES）：精确版 tarball 无内嵌文本、已另行取证的包；
 * - 附录：FFmpeg（LGPL，桌面 Electron 动态链接组件）与 Electron/Chromium 指引；
 *   附录中的 Electron/Chromium 版本固化在 ELECTRON_VERSIONS，main() 会校验其与
 *   实际安装的 electron 一致，bump electron 后须同步更新再重新生成。
 *
 * 注意：输出仅包含本机已安装的包——其它平台专属的可选二进制包（如 darwin 版
 * esbuild）不在树上时不会列出；其许可证与所属主包一致，主包始终在列。
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import nodePath from 'path';
import { fileURLToPath } from 'url';
import { FALLBACK_LICENSE_TEXTS } from './license-fallback-texts.js';

const UI_ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT_REL_PATH = 'public/third-party-notices.txt';

/** 不随任何产物分发的构建期专用包，从告知中排除（lightningcss 已在 electron-builder 裁剪） */
const EXCLUDED_NAME_RE = /^lightningcss($|-)/;

const MIT_TEXT = FALLBACK_LICENSE_TEXTS['MIT'];

/**
 * 手工收录：精确版发布包内无许可证文本、或不在 pnpm 依赖树上的组件，按已取证结论补入。
 * 收录范围 = 进入任一客户端出货物的组件：
 *   - ui 分发产物内、但发布包未内嵌许可证文本的包（如 vaul-vue，据上游仓 MIT 取证）；
 *   - iOS 原生 SPM 远程依赖（编入 IPA，属 iOS 客户端出货物）——它们不在 pnpm 树上，
 *     故上面基于 pnpm 的扫描扫不到，须在此静态补充。SPM 版本在此硬编码，权威来源是
 *     ios/App/App.xcodeproj/.../Package.resolved；单测与其对账，SPM 升级后须同步更新。
 * 不收录：插件专属依赖（如 rx.mini，随 OpenClaw 插件走 npm 逐包分发、从不进任何客户端出货物）。
 */
export const MANUAL_ENTRIES = [
	{
		name: 'vaul-vue',
		version: '0.4.1',
		note: 'The published package omits the license file — package.json declares no license field and the "files" whitelist ships only README and dist — but the upstream repository (https://github.com/unovue/vaul-vue) is MIT licensed, with the LICENSE present at the vaul-vue@0.4.1 release tag (Copyright (c) 2025 unovue). The tarball omission is a packaging oversight, not a missing grant.',
		licenseText: `MIT License\n\nCopyright (c) 2025 unovue\n\n${MIT_TEXT.split('\n').slice(2).join('\n')}`,
	},
	{
		name: 'capacitor-swift-pm',
		version: '8.2.0',
		note: 'Remote Swift Package Manager dependency compiled into the iOS app (https://github.com/ionic-team/capacitor-swift-pm, pinned to 8.2.0); it provides the Capacitor/Cordova iOS runtime and is not part of the pnpm tree. MIT licensed (LICENSE.md in the upstream repository).',
		licenseText: `MIT License\n\nCopyright (c) 2022-present Drifty Co.\n\n${MIT_TEXT.split('\n').slice(2).join('\n')}`,
	},
	{
		name: 'ion-ios-filesystem',
		version: '1.1.2',
		note: 'Remote Swift Package Manager dependency compiled into the iOS app (https://github.com/ionic-team/ion-ios-filesystem, pinned to 1.1.2); the iOS filesystem native library used by @capacitor/filesystem, not part of the pnpm tree. MIT licensed (LICENSE in the upstream repository).',
		licenseText: `MIT License\n\nCopyright (c) 2025 Ionic\n\n${MIT_TEXT.split('\n').slice(2).join('\n')}`,
	},
];

/**
 * Apache Cordova 兼容层源文件统一携带 ASF 许可头（无独立版权行，署名即该 ASF 授权声明），
 * 编入移动出货物。以下常量供多个 FILE_LEVEL_ENTRIES 复用：探针作升级漂移检测，正文附 Apache-2.0 全文。
 */
const ASF_CORDOVA_PROBE = 'Licensed to the Apache Software Foundation (ASF) under one';
const APACHE_CORDOVA_LICENSE_TEXT = `Licensed to the Apache Software Foundation (ASF) under one or more contributor license agreements. See the NOTICE file distributed with these files for additional information regarding copyright ownership. The ASF licenses them to you under the Apache License, Version 2.0. The full license text follows:\n\n${FALLBACK_LICENSE_TEXTS['Apache-2.0']}`;

// @capacitor/ios 编入 IPA 的 Apache Cordova 兼容层源文件（另有 CDVPluginManager.* 为 Capacitor 自有 MIT，不在此列）
const CAPACITOR_IOS_CORDOVA_FILES = [
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDV.h',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVAvailability.h',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVAvailabilityDeprecated.h',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVCommandDelegate.h',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVCommandDelegateImpl.h',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVCommandDelegateImpl.m',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVConfigParser.h',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVConfigParser.m',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVInvokedUrlCommand.h',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVInvokedUrlCommand.m',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVPlugin+Resources.h',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVPlugin+Resources.m',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVPlugin.h',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVPlugin.m',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVPluginResult.h',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVPluginResult.m',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVScreenOrientationDelegate.h',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVURLProtocol.h',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVURLProtocol.m',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVViewController.h',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVViewController.m',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVWebViewProcessPoolFactory.h',
	'CapacitorCordova/CapacitorCordova/Classes/Public/CDVWebViewProcessPoolFactory.m',
	'CapacitorCordova/CapacitorCordova/Classes/Public/NSDictionary+CordovaPreferences.h',
	'CapacitorCordova/CapacitorCordova/Classes/Public/NSDictionary+CordovaPreferences.m',
];

/**
 * 文件级归属：包的主许可之外，个别源文件按另一宽松许可编入客户端出货物，
 * 在此补充其版权行与许可全文（包本体仍走上面的自动扫描，不从扫描中剔除）。
 * 文本静态取证自对应版本源文件头；probes 是各文件头里的版权行（无独立版权行时取其许可声明行），
 * 单测据此与实际安装包对账，升级相关包后若文件头变化会先红提醒复核。
 */
export const FILE_LEVEL_ENTRIES = [
	{
		name: '@capacitor/network',
		files: ['ios/Sources/NetworkPlugin/Reachability.swift'],
		probes: ['Copyright (c) 2014, Ashley Mills'],
		note: 'This Swift source file is compiled into the iOS app by the @capacitor/network plugin (whose primary license is MIT, listed above). The file carries a BSD-2-Clause header; its copyright notice and license terms follow:',
		licenseText: `BSD 2-Clause License\n\nCopyright (c) 2014, Ashley Mills\nAll rights reserved.\n\n${FALLBACK_LICENSE_TEXTS['BSD-2-Clause'].split('\n').slice(2).join('\n')}`,
	},
	{
		name: '@capacitor/android',
		files: [
			'capacitor/src/main/java/com/getcapacitor/UriMatcher.java',
			'capacitor/src/main/java/com/getcapacitor/WebViewLocalServer.java',
		],
		probes: [
			'Copyright (C) 2006 The Android Open Source Project',
			'Copyright 2015 Google Inc. All rights reserved.',
		],
		note: 'These Java source files are compiled into the Android app by the @capacitor/android platform package (whose primary license is MIT, listed above). They carry Apache-2.0 headers; their copyright notices and the license text follow:',
		licenseText: `Copyright (C) 2006 The Android Open Source Project (UriMatcher.java)\nCopyright 2015 Google Inc. All rights reserved. (WebViewLocalServer.java)\n\n${FALLBACK_LICENSE_TEXTS['Apache-2.0']}`,
	},
	{
		name: '@capacitor/keyboard',
		files: ['ios/Sources/KeyboardPlugin/Keyboard.m'],
		probes: [ASF_CORDOVA_PROBE],
		note: 'This Objective-C source file is compiled into the iOS app by the @capacitor/keyboard plugin (whose primary license is MIT, listed above). It carries the Apache Cordova header (Apache-2.0, ASF contributor license agreement — no per-file copyright line); the license terms follow:',
		licenseText: APACHE_CORDOVA_LICENSE_TEXT,
	},
	{
		name: '@capacitor/ios',
		files: CAPACITOR_IOS_CORDOVA_FILES,
		probes: CAPACITOR_IOS_CORDOVA_FILES.map(() => ASF_CORDOVA_PROBE),
		note: 'These Objective-C source files (the Apache Cordova compatibility layer) are compiled into the iOS app by the @capacitor/ios platform package (whose primary license is MIT, listed above). They carry the Apache Cordova header (Apache-2.0, ASF contributor license agreement — no per-file copyright line); the license terms follow:',
		licenseText: APACHE_CORDOVA_LICENSE_TEXT,
	},
	{
		name: '@capacitor/core',
		files: ['cordova.js'],
		probes: [ASF_CORDOVA_PROBE],
		note: 'This JavaScript file (the Cordova-compatibility bridge shim loaded in the native WebView) is shipped in the Android and iOS app builds by @capacitor/core (whose primary license is MIT, listed above). It carries the Apache Cordova header (Apache-2.0, ASF contributor license agreement — no per-file copyright line); the license terms follow:',
		licenseText: APACHE_CORDOVA_LICENSE_TEXT,
	},
];

/**
 * 桌面壳精确版本，供 FFmpeg/Electron 附录给出可定位的对应源码指针。
 * bump electron 后须同步更新（chromium 版本见对应 Electron release notes），
 * main() 与单测都会校验 electron 与实际安装版一致。
 */
export const ELECTRON_VERSIONS = { electron: '41.0.2', chromium: '146.0.7680.72' };

const HEADER = `================================================================================
CoClaw — Third-Party Software Notices
================================================================================

This document is generated. Do not edit by hand; regenerate with
"pnpm licenses:generate" in the ui workspace.

This document lists third-party open source software components that may be
included in one or more CoClaw client distributions (web application,
Windows/macOS desktop application, Android/iOS mobile application), together
with their copyright notices and license texts.

Components are grouped by identical license text; the applicable text is
reproduced below each group. Components whose published package does not
bundle a license file are listed with their declared SPDX license identifier
and any copyright lines recovered from their README, followed by the
canonical text of that license.

The component list below is derived from the production dependency tree as
resolved for the build that generated this document. Platform-specific
optional native binaries that are only installed on other build platforms
(for example, prebuilt binaries for another operating system or CPU
architecture) may not be listed individually; such binaries are covered by
the same license terms as their parent package, which is listed.

Desktop (Electron) builds additionally ship LICENSE.electron.txt and
LICENSES.chromium.html covering Electron, Chromium and their bundled
components. Android builds additionally include license notices for native
(Maven) components via the in-app open source licenses screen. See the
appendices at the end of this document for FFmpeg and Electron/Chromium
details.`;

const APPENDIX = `================================================================================
APPENDIX A — FFmpeg (desktop / embedded component)
================================================================================

The CoClaw desktop application is built on the Electron framework, which
bundles FFmpeg as a separate, dynamically linked shared library
(ffmpeg.dll on Windows / libffmpeg.dylib on macOS / libffmpeg.so on Linux).
FFmpeg is licensed under the GNU Lesser General Public License version 2.1
or later (LGPL-2.1-or-later).

- Dynamic linking: FFmpeg ships as an independent shared library alongside
  the Electron runtime and is NOT statically linked into this application.
  You may replace the bundled FFmpeg library with a compatible build of your
  own.
- Exact versions: this desktop build uses Electron ${ELECTRON_VERSIONS.electron},
  which bundles Chromium ${ELECTRON_VERSIONS.chromium}.
- Source code availability: FFmpeg upstream sources are available at
  https://ffmpeg.org. The FFmpeg library shipped with the desktop
  application is built by the Electron project from Chromium's FFmpeg source
  tree (https://chromium.googlesource.com/chromium/third_party/ffmpeg), at
  the revision pinned in the DEPS file of Chromium ${ELECTRON_VERSIONS.chromium}. The
  corresponding build configuration and build scripts are part of the
  Electron source tree for the exact release in use:
  https://github.com/electron/electron/tree/v${ELECTRON_VERSIONS.electron}
  (release downloads: https://github.com/electron/electron/releases/tag/v${ELECTRON_VERSIONS.electron}).
  The corresponding source for the shipped FFmpeg library — including the
  build and install scripts used by the Electron project — can be obtained
  via these version-pinned references (Electron v${ELECTRON_VERSIONS.electron} and the FFmpeg
  revision pinned by Chromium ${ELECTRON_VERSIONS.chromium}'s DEPS).
- License text: the full LGPL-2.1 text is included in LICENSES.chromium.html
  shipped with the desktop application, and is also available at
  https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html.

================================================================================
APPENDIX B — Electron & Chromium
================================================================================

Desktop builds of CoClaw include the Electron framework (MIT licensed) and
Chromium. Their license terms, and the licenses of their bundled third-party
components, are distributed with the desktop application as
LICENSE.electron.txt and LICENSES.chromium.html.`;

const SEPARATOR = '--------------------------------------------------------------------------------';

/**
 * 从 pnpm list --json 的依赖树收集唯一包列表（按 name@version 去重）。
 * @param {object} tree - pnpm list JSON 根节点（含 dependencies）
 * @returns {{ name: string, version: string, path: string }[]} 按名称排序
 */
export function collectPackages(tree) {
	const seen = new Map();
	function walk(deps) {
		if (!deps) return;
		for (const [name, info] of Object.entries(deps)) {
			const key = `${name}@${info.version}`;
			if (seen.has(key)) continue;
			seen.set(key, { name, version: info.version, path: info.path });
			walk(info.dependencies);
		}
	}
	walk(tree.dependencies);
	const manualNames = new Set(MANUAL_ENTRIES.map((e) => e.name));
	return [...seen.values()]
		.filter((p) => !EXCLUDED_NAME_RE.test(p.name) && !manualNames.has(p.name))
		.sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
}

// 许可证文件名：LICENSE / LICENCE / COPYING 本体及其变体（LICENSE-MIT、license.md、
// LICENSE.BSD 等，大小写不敏感）；排除同名代码/数据文件（如 license.js）
const LICENSE_FILE_RE = /^(license|licence|copying)([-._][a-z0-9._-]+)?$/i;
const LICENSE_FILE_EXCLUDE_RE = /\.(js|cjs|mjs|ts|cts|mts|json)$/i;
const NOTICE_FILE_RE = /^notice(\.(md|txt|markdown))?$/i;
const README_FILE_RE = /^readme(\.(md|txt|markdown))?$/i;
// 真实版权行：`Copyright (c) ...` / `Copyright © ...` / `Copyright 2012 ...`；
// 不匹配 "The above copyright notice..." 这类许可证条款行
const COPYRIGHT_LINE_RE = /copyright\s*(\(c\)|©|[0-9]{4})/i;

/**
 * 从 README 文本抽取真实版权行（供无内嵌许可证文件的包保留归属）。
 * @param {string} text - README 全文
 * @returns {string[]} 去重后的版权行（剥掉 markdown/HTML 标记，最多 5 条）
 */
export function extractCopyrightLines(text) {
	const lines = [];
	for (const raw of text.split('\n')) {
		const line = raw
			.replace(/<[^>]+>/g, ' ') // 剥 HTML 标签（README 里常见 <sup>/<br />）
			.replace(/^[\s#>*`-]+/, '')
			.replace(/[\s*`]+$/, '')
			.replace(/\s{2,}/g, ' ')
			.trim();
		if (COPYRIGHT_LINE_RE.test(line) && !lines.includes(line)) {
			lines.push(line);
			if (lines.length >= 5) break;
		}
	}
	return lines;
}

/**
 * 读取单个包的许可证信息。
 * 无内嵌许可证文件时回读 README 抽取版权行，避免丢失真实归属（如 bplist-parser
 * 只在 README 里写 Copyright (c) 2012 Near Infinity Corporation）。
 * @param {{ name: string, version: string, path: string }} pkg
 * @returns {{ name: string, version: string, spdx: string, author: string|null, licenseText: string|null, noticeText: string|null, copyrightText: string|null }|null}
 *          包目录不存在（未安装的平台可选依赖）时返回 null
 */
export function readPackageLicense(pkg) {
	let files;
	try {
		files = fs.readdirSync(pkg.path);
	}
	catch {
		return null; // 未安装（其它平台的可选依赖）
	}
	let meta = {};
	try {
		meta = JSON.parse(fs.readFileSync(nodePath.join(pkg.path, 'package.json'), 'utf8'));
	}
	catch {
		// 保留空 meta，走 UNKNOWN 分支
	}
	const spdx = typeof meta.license === 'string' && meta.license.trim()
		? meta.license.trim()
		: (meta.license?.type || 'UNKNOWN');
	const author = typeof meta.author === 'string' ? meta.author : (meta.author?.name ?? null);
	const licFile = files.find((f) => LICENSE_FILE_RE.test(f) && !LICENSE_FILE_EXCLUDE_RE.test(f));
	const noticeFile = files.find((f) => NOTICE_FILE_RE.test(f));
	const read = (f) => fs.readFileSync(nodePath.join(pkg.path, f), 'utf8').replace(/\r\n/g, '\n').trim();
	let copyrightText = null;
	if (!licFile) {
		const readmeFile = files.find((f) => README_FILE_RE.test(f));
		if (readmeFile) {
			try {
				const lines = extractCopyrightLines(read(readmeFile));
				if (lines.length) copyrightText = lines.join('\n');
			}
			catch {
				// README 读不出不阻断，仅少一条版权行
			}
		}
	}
	return {
		name: pkg.name,
		version: pkg.version,
		spdx,
		author,
		licenseText: licFile ? read(licFile) : null,
		noticeText: noticeFile ? read(noticeFile) : null,
		copyrightText,
	};
}

/**
 * 从 SPDX 表达式挑选兜底模板文本的 id 列表。
 * OR 取第一个有模板的；AND 全部输出。
 * @param {string} spdx
 * @returns {string[]}
 */
export function pickFallbackIds(spdx) {
	const ids = spdx.replace(/[()]/g, '').split(/\s+(?:AND|OR|WITH)\s+/).map((s) => s.trim()).filter(Boolean);
	if (/\bAND\b/.test(spdx)) {
		return ids;
	}
	const withTemplate = ids.find((id) => FALLBACK_LICENSE_TEXTS[id]);
	return [withTemplate ?? ids[0] ?? spdx];
}

/**
 * 组装告知文档全文（确定性输出：无时间戳，按包名排序）。
 * @param {ReturnType<typeof readPackageLicense>[]} entries - 已读取的包条目（可含 null）
 * @returns {string}
 */
export function buildNotices(entries) {
	// 按「许可证文本 + NOTICE 文本」分组，保留各自版权行
	const groups = new Map();
	for (const e of entries) {
		if (!e) continue;
		let text;
		let fallback = false;
		if (e.licenseText) {
			text = e.licenseText + (e.noticeText ? `\n\nNOTICE:\n\n${e.noticeText}` : '');
		}
		else {
			fallback = true;
			const parts = pickFallbackIds(e.spdx).map((id) => FALLBACK_LICENSE_TEXTS[id]
				?? `License text not bundled with the package; see https://spdx.org/licenses/${id}.html`);
			text = parts.join(`\n\n${SEPARATOR}\n\n`);
		}
		const key = `${fallback ? `FALLBACK:${e.spdx}\n` : ''}${text}`;
		if (!groups.has(key)) groups.set(key, { text, fallback, spdx: e.spdx, pkgs: [] });
		groups.get(key).pkgs.push(e);
	}

	const sortedGroups = [...groups.values()].sort((a, b) => a.pkgs[0].name.localeCompare(b.pkgs[0].name) || a.pkgs[0].version.localeCompare(b.pkgs[0].version));

	const sections = [];
	for (const g of sortedGroups) {
		// 兜底组把 README 回读的版权行缩进列在对应包名下，保留真实归属
		const lines = g.pkgs.map((p) => {
			const head = `${p.name}@${p.version}${g.fallback && p.author ? ` (${p.author})` : ''}`;
			return g.fallback && p.copyrightText
				? `${head}\n  ${p.copyrightText.split('\n').join('\n  ')}`
				: head;
		});
		const hasRecovered = g.fallback && g.pkgs.some((p) => p.copyrightText);
		const preface = g.fallback
			? `\nThe package(s) listed above are declared under "${g.spdx}" but do not bundle\na license text in their published tarball.${hasRecovered ? ' Copyright lines shown above were\nrecovered from the package README files.' : ''} The canonical license text follows:\n`
			: '';
		sections.push(`${SEPARATOR}\n${lines.join('\n')}\n${SEPARATOR}${preface}\n${g.text}`);
	}

	for (const m of MANUAL_ENTRIES) {
		sections.push(`${SEPARATOR}\n${m.name}@${m.version}\n${SEPARATOR}\nNote: ${m.note}\n\n${m.licenseText}`);
	}

	// 文件级归属：标题行列出包名与具体文件路径
	for (const f of FILE_LEVEL_ENTRIES) {
		const head = `${f.name} (file-level attribution)\n${f.files.map((p) => `  ${p}`).join('\n')}`;
		sections.push(`${SEPARATOR}\n${head}\n${SEPARATOR}\nNote: ${f.note}\n\n${f.licenseText}`);
	}

	return `${HEADER}\n\n${sections.join('\n\n')}\n\n${APPENDIX}\n`;
}

/** 读实际安装的 electron 版本（devDependency，恒装于 ui workspace） */
export function getInstalledElectronVersion() {
	return JSON.parse(fs.readFileSync(nodePath.join(UI_ROOT, 'node_modules/electron/package.json'), 'utf8')).version;
}

/** 跑 pnpm 拿 ui 生产依赖树 → 生成并写盘 */
export function main() {
	// 附录里的版本指针不能与实际壳子脱节：bump electron 未更新常量时拒绝生成
	const installedElectron = getInstalledElectronVersion();
	if (installedElectron !== ELECTRON_VERSIONS.electron) {
		throw new Error(`installed electron ${installedElectron} != declared ${ELECTRON_VERSIONS.electron}; update ELECTRON_VERSIONS (electron + chromium) in this script, then regenerate`);
	}
	const stdout = execFileSync('pnpm', ['list', '--prod', '--depth', 'Infinity', '--json'], {
		cwd: UI_ROOT,
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024,
	});
	const parsed = JSON.parse(stdout);
	const tree = Array.isArray(parsed) ? parsed[0] : parsed;
	const pkgs = collectPackages(tree);
	const entries = pkgs.map(readPackageLicense);
	const installed = entries.filter(Boolean);
	const doc = buildNotices(entries);
	const outPath = nodePath.join(UI_ROOT, OUTPUT_REL_PATH);
	fs.writeFileSync(outPath, doc);
	console.log(`third-party notices: ${installed.length} packages (+${MANUAL_ENTRIES.length} manual) → ${nodePath.relative(UI_ROOT, outPath)} (${(doc.length / 1024).toFixed(0)} KB)`);
}

// 直接执行（非被测试 import）时运行
if (process.argv[1] && nodePath.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
