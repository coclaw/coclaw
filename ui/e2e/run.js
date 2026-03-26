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

// 传递给 playwright 的参数（过滤掉 --ci）
const pwArgs = ['test', ...process.argv.slice(2).filter(a => a !== '--ci')];

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

const useXvfb = isLinux && (isCi || isWSL()) && hasXvfbRun();

if (useXvfb) {
	run('xvfb-run', ['--auto-servernum', 'npx', 'playwright', ...pwArgs]);
} else {
	run('npx', ['playwright', ...pwArgs]);
}
