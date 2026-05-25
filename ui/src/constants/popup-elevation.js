// 弹出层「浮起来」的投影配方 —— 补 @nuxt/ui 弹出菜单/对话框在背景上辨识度低的观感。
// @nuxt/ui 默认带 shadow-lg + ring ring-default，但暗色模式下黑色投影几乎不可见、ring-default 对比度又低，
// 面板和背景糊在一起。这里分亮/暗两套：
//   - 亮色：quasar 多层 Material elevation 投影（菜单 shadow-2 档、对话框再叠高到 shadow-4 档），层次紧实
//   - 暗色：黑投影没用，改用「白色光晕 + 提亮描边」把面板从深色背景里拎出来——和 ChatPage「滚动到底部」
//     按钮同思路（按钮用 dark:shadow-[...rgba(255,255,255,...)] 的白光晕）。dark: 变体特异性更高，盖过黑投影。
//     强度对标 quasar：那是柔和弥散的薄晕、几乎不见硬边，所以这里把按钮的 0.14/ring-15 收到 0.10/ring-10——
//     面板比按钮大一圈，同强度光晕绕一周会偏重；收一档后接近 quasar 的观感（具体 alpha 仍可按实际再微调）。
// 注入口：popover/select 经 vite.config.js，modal 经 modal-theme.js，均按「base slot 拼接」叠在内置 content 上
//   （tailwind-merge 把内置 shadow-lg 去重换掉，尺寸/圆角/ring 保留）。
// ⚠ arbitrary 投影值里的空格必须写成下划线，否则 tailwind 不识别；层与层之间用逗号、不留空格。

// 弹出菜单（popover / select）：亮色 quasar shadow-2 / 暗色柔和白光晕 + 淡描边
export const MENU_ELEVATION = 'shadow-[0_1px_5px_rgba(0,0,0,0.2),0_2px_2px_rgba(0,0,0,0.14),0_3px_1px_-2px_rgba(0,0,0,0.12)] dark:shadow-[0_2px_12px_rgba(255,255,255,0.10)] dark:ring-white/10';

// 非全屏对话框：亮色再叠高一档 quasar shadow-4 / 暗色更大范围柔和白光晕 + 淡描边
export const MODAL_ELEVATION = 'shadow-[0_2px_4px_-1px_rgba(0,0,0,0.2),0_4px_5px_0_rgba(0,0,0,0.14),0_1px_10px_0_rgba(0,0,0,0.12)] dark:shadow-[0_4px_20px_rgba(255,255,255,0.10)] dark:ring-white/10';
