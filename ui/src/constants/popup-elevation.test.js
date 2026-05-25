import { describe, test, expect } from 'vitest';
import { MENU_ELEVATION, MODAL_ELEVATION } from './popup-elevation.js';

describe('popup-elevation — quasar 风格弹出层投影', () => {
	for (const [name, cls] of [['MENU_ELEVATION', MENU_ELEVATION], ['MODAL_ELEVATION', MODAL_ELEVATION]]) {
		describe(name, () => {
			test('亮色：quasar 多层黑投影（三层）', () => {
				const light = cls.slice(0, cls.indexOf(' dark:'));
				expect(light).toContain('shadow-[');
				expect(light.match(/rgba\(0,0,0/g)?.length).toBe(3);
			});

			test('暗色：柔和白光晕（对标 quasar 收一档）+ 淡描边，盖过黑投影', () => {
				expect(cls).toContain('dark:shadow-[');
				expect(cls).toContain('rgba(255,255,255,0.10)');
				expect(cls).toContain('dark:ring-white/10');
			});

			test('arbitrary 值内不得出现裸空格（否则 tailwind 不识别 class）', () => {
				for (const m of cls.matchAll(/\[([^\]]*)\]/g)) {
					expect(m[1]).not.toContain(' ');
				}
			});
		});
	}

	test('对话框档位比菜单高：两者投影字符串不同', () => {
		expect(MODAL_ELEVATION).not.toBe(MENU_ELEVATION);
	});
});
