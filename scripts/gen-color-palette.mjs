/**
 * CoClaw 品牌/状态色阶生成脚本
 *
 * 基于 oklch 色彩空间，从 5 个基准色生成 50-950 共 11 级色阶。
 * 色度采用抛物线缩放，确保基准明度处为原始色度，向亮/暗两端自然衰减。
 *
 * 用法: pnpm gen:palette
 * 输出: ui/src/assets/brand-palette.css
 */

import { writeFileSync } from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { converter, formatCss, clampChroma } from 'culori';

const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));

// 基准色定义（修改此处可更换品牌色）
const BASE_COLORS = {
	primary: '#1976d2',
	success: '#198754',
	error: '#961827',
	warning: '#f2c037',
};

// 目标明度分布（参照 Tailwind 默认色阶）
const LIGHTNESS_SCALE = {
	50: 0.97,
	100: 0.93,
	200: 0.87,
	300: 0.79,
	400: 0.70,
	500: 0.60,
	600: 0.50,
	700: 0.42,
	800: 0.34,
	900: 0.27,
	950: 0.20,
};

const toOklch = converter('oklch');

/**
 * 抛物线缩放色度
 * @param {number} cBase - 基准色度
 * @param {number} lBase - 基准明度
 * @param {number} l - 目标明度
 * @returns {number}
 */
function scaleChroma(cBase, lBase, l) {
	const denom = 4 * lBase * (1 - lBase);
	if (denom === 0) return cBase;
	return cBase * (4 * l * (1 - l)) / denom;
}

/**
 * 为单个基准色生成 11 级色阶
 * @param {string} hex - 基准色 HEX
 * @returns {Object<string, string>} step -> oklch CSS 值
 */
function genShades(hex) {
	const base = toOklch(hex);
	const shades = {};

	for (const [step, targetL] of Object.entries(LIGHTNESS_SCALE)) {
		const c = scaleChroma(base.c, base.l, targetL);
		const raw = { mode: 'oklch', l: targetL, c, h: base.h };
		const clamped = clampChroma(raw, 'oklch');
		const oklch = toOklch(clamped);
		shades[step] = `oklch(${oklch.l.toFixed(3)} ${oklch.c.toFixed(3)} ${(oklch.h ?? 0).toFixed(3)})`;
	}

	return shades;
}

// 生成所有色阶
const palette = {};
for (const [name, hex] of Object.entries(BASE_COLORS)) {
	palette[name] = genShades(hex);
}

// 拼接 CSS
const baseDesc = Object.entries(BASE_COLORS)
	.map(([k, v]) => `${k}=${v}`)
	.join(' ');

// CSS 变量名前缀，避免与 Nuxt UI 语义色名循环引用
const PREFIX = 'cc';

let css = `/*
 * CoClaw 品牌/状态色阶 — 由 scripts/gen-color-palette.mjs 生成，勿手动编辑
 * 基准色: ${baseDesc}
 * 重新生成: pnpm gen:palette
 * Nuxt UI 映射: primary -> ${PREFIX}-primary, success -> ${PREFIX}-success, ...
 */
@theme static {
`;

for (const [name, shades] of Object.entries(palette)) {
	for (const [step, value] of Object.entries(shades)) {
		css += `\t--color-${PREFIX}-${name}-${step}: ${value};\n`;
	}
	css += '\n';
}

// 移除末尾空行
css = css.trimEnd() + '\n}\n';

// 写入文件
const outPath = nodePath.resolve(__dirname, '../ui/src/assets/brand-palette.css');
writeFileSync(outPath, css, 'utf-8');
console.log(`色阶已写入: ${outPath}`);
