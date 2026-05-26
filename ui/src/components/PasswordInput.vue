<template>
	<!-- $attrs 必须放在 :type 之前：受控的显隐 type 要盖过调用方可能误传的 type -->
	<UInput
		ref="input"
		:model-value="modelValue"
		v-bind="$attrs"
		:type="revealed ? 'text' : 'password'"
		:size="size"
		@update:model-value="$emit('update:modelValue', $event)"
	>
		<template #trailing>
			<UButton
				type="button"
				color="neutral"
				variant="link"
				:size="size"
				:icon="revealed ? 'i-lucide-eye-off' : 'i-lucide-eye'"
				:aria-label="revealed ? $t('common.hidePassword') : $t('common.showPassword')"
				:aria-pressed="revealed"
				@click="revealed = !revealed"
			/>
		</template>
	</UInput>
</template>

<script>
// 带明文/密文切换（小眼睛）的密码输入框。
// 包裹 UInput：尾部放一个切换按钮，点一下在 password/text 之间切。
// 其余属性（data-testid、autocomplete、placeholder 等）经 $attrs 透传给内部 UInput。
//
// 关于浏览器自动填充背景色：本组件不做任何 :-webkit-autofill 覆盖。
// 实测（暗色 + 亮色）浏览器自动填充会铺满整个输入框且背景色与主题协调，无突兀白底，
// 估计是 @nuxt/ui 或新版 Chrome 已处理。若日后某环境出现自动填充白底不协调，
// 再考虑声明 CSS color-scheme（轻量首选）或加 :-webkit-autofill 覆盖样式兜底。
export default {
	name: 'PasswordInput',
	inheritAttrs: false,
	props: {
		modelValue: {
			type: String,
			default: '',
		},
		// 同时作用于输入框和眼睛按钮，保证两者尺寸一致
		size: {
			type: String,
			default: undefined,
		},
	},
	emits: ['update:modelValue'],
	data() {
		return {
			revealed: false,
		};
	},
};
</script>
