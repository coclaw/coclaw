#!/usr/bin/env node

/**
 * E2E 测试 runner —— 根据平台和环境自动选择执行方式。
 *
 * 背景：WSL2 环境下 Chrome（headless 和 headed + WSLg）的动画帧渲染异常，
 * 导致 Playwright actionability "stable" 检查永远无法通过，所有 click() 超时。
 * 只有 Xvfb 提供的虚拟 display 能产生正常的动画帧。
 * 详见 docs/e2e-troubleshooting.md 卡点 4。
 *
 * 用法：
 *   pnpm e2e      — 开发者日常使用，有 GUI 时可看到浏览器
 *   pnpm e2e:ci   — CI / 无 GUI 环境
 *
 * 各环境行为：
 *   环境            pnpm e2e              pnpm e2e:ci
 *   ──────────────  ────────────────────   ────────────────────
 *   macOS           直接运行，可见浏览器   直接运行，可见浏览器
 *   桌面 Linux      直接运行，可见浏览器   xvfb-run，不可见
 *   WSL2            xvfb-run，不可见       xvfb-run，不可见
 *   CI (Linux)      xvfb-run，不可见       xvfb-run，不可见
 */

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const isLinux = process.platform === 'linux';
const isCi = process.argv.includes('--ci');

// 透传给 playwright 的参数：先滤掉 run.js 自己的 --ci。
const forwarded = process.argv.slice(2).filter(a => a !== '--ci');
// `pnpm e2e:ci -- <args>` 时 pnpm 会注入一个分隔符 `--`（在 --ci 之后、用户参数之前，
// 滤掉 --ci 后落在首位）。若原样透传，playwright 会把 `--` 之后的一切（含 --grep <title>）
// 当成位置式文件过滤 → --grep 失效、报 "No tests found"。故剥掉这个前导分隔符；
// 文件路径形式（e2e/x.e2e.spec.js）剥掉后仍作位置过滤照常工作。
// 只剥一个前导 --：兼容 pnpm 未注入分隔符的情形（首位非 -- 时不动），
// 也保留用户显式再加一个 -- 强制位置过滤的能力。
if (forwarded[0] === '--') forwarded.shift();
const pwArgs = ['test', ...forwarded];

function isWSL() {
	if (!isLinux) return false;
	try {
		const release = readFileSync('/proc/version', 'utf-8');
		return /microsoft|wsl/i.test(release);
	} catch {
		return false;
	}
}

function hasXvfbRun() {
	try {
		execFileSync('which', ['xvfb-run'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

function run(cmd, args) {
	try {
		execSync([cmd, ...args].map(a => JSON.stringify(a)).join(' '), {
			stdio: 'inherit',
			env: process.env,
		});
	} catch (err) {
		process.exit(err.status ?? 1);
	}
}

// 跑测试前确保 Playwright 浏览器已安装（幂等：已装则秒过）。
// 这样新机器 / CI / 升级 Playwright 后首次跑会自动补齐，而非以
// "Executable doesn't exist" 失败。浏览器二进制不走 npm registry，
// 故不硬编码镜像；下载源由开发者环境的 PLAYWRIGHT_DOWNLOAD_HOST 决定。
function ensureBrowsers() {
	try {
		// 加 timeout：下载卡死（坏网络/限速）时也转成下方显著提示，而非无限 hang
		execFileSync('npx', ['playwright', 'install', 'chromium'], {
			stdio: 'inherit',
			env: process.env,
			timeout: 300_000,
		});
	} catch {
		// 安装失败时给出显著提示——开发者常让 agent 代跑，醒目的指引能快速定位
		const bar = '═'.repeat(74);
		console.error(`\n${bar}`);
		console.error('  ✗ Playwright 浏览器安装失败 —— E2E 无法运行');
		console.error(bar);
		console.error('  浏览器二进制不走 npm registry，registry 镜像（.npmrc）对它无效。');
		console.error('  国内若卡在官方 CDN，设 Playwright 专用下载源后重试：');
		console.error('');
		console.error('    export PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright');
		console.error('    pnpm exec playwright install chromium');
		console.error('');
		console.error('  该镜像偶尔暂缺最新版本（404）→ 等镜像追上，或临时用全局代理。');
		console.error('  详见 docs/e2e-troubleshooting.md 卡点 8。');
		console.error(`${bar}\n`);
		process.exit(1);
	}
}

const useXvfb = isLinux && (isCi || isWSL()) && hasXvfbRun();

ensureBrowsers();

if (useXvfb) {
	run('xvfb-run', ['--auto-servernum', 'npx', 'playwright', ...pwArgs]);
} else {
	run('npx', ['playwright', ...pwArgs]);
}
