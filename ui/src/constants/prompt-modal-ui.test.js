import { describe, test, expect } from 'vitest';
import { promptModalUi } from './prompt-modal-ui.js';

describe('promptModalUi — 轻量 prompt/confirm 弹窗的 :ui 覆盖形态', () => {
	test('content：窄卡片 max-w-sm + 去分割线 + 视口内自适应宽度', () => {
		expect(promptModalUi.content).toContain('max-w-sm');
		expect(promptModalUi.content).toContain('divide-y-0');
		expect(promptModalUi.content).toContain('w-[calc(100vw-2rem)]');
	});

	test('header：放宽顶部间距 pt-2 pb-1 min-h-14（盖住全局紧凑的 py-1 min-h-13）', () => {
		// 经 :ui 合并叠在全局 header 上，tailwind-merge 用 pt-2/pb-1 顶掉 py-1、min-h-14 顶掉 min-h-13
		expect(promptModalUi.header).toContain('pt-2');
		expect(promptModalUi.header).toContain('pb-1');
		expect(promptModalUi.header).toContain('min-h-14');
		// 不应残留紧凑值（本覆盖自身不再写 py-1/min-h-13，避免与放宽值在同串内自相矛盾）
		expect(promptModalUi.header).not.toContain('py-1');
		expect(promptModalUi.header).not.toContain('min-h-13');
	});

	test('body / footer：统一间距，不区分 sm 断点的纵向 padding', () => {
		expect(promptModalUi.body).toContain('px-4');
		expect(promptModalUi.body).toContain('py-3');
		expect(promptModalUi.footer).toContain('px-4');
		expect(promptModalUi.footer).toContain('py-4');
	});
});
