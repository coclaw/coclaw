<template>
	<div :class="['flex justify-center space-x-[2px]', sizeClass]" :style="customStyle">
		<div
			v-for="n in 3"
			:key="n"
			:class="['cc-wave rounded-full bg-current', `cc-wave-delay-${n}`, { 'cc-wave-playing': playing }]"
		/>
	</div>
</template>

<script>
const SIZE_MAP = {
	sm: 'h-2',
	md: 'h-4',
};
const WIDTH_MAP = {
	sm: '3px',
	md: '6px',
};

export default {
	name: 'SoundWave',
	props: {
		playing: {
			type: Boolean,
			default: false,
		},
		size: {
			type: String,
			default: 'sm',
			validator: (v) => ['sm', 'md'].includes(v),
		},
	},
	computed: {
		sizeClass() {
			return SIZE_MAP[this.size];
		},
		customStyle() {
			return { '--cc-wave-w': WIDTH_MAP[this.size] };
		},
	},
};
</script>

<style scoped>
.cc-wave {
	width: var(--cc-wave-w, 3px);
	transform: scaleY(1);
	transition: transform 0.3s ease-in-out;
}
.cc-wave-playing {
	animation: cc-wave-bounce 1s infinite ease-in-out;
}
.cc-wave-delay-1 { animation-delay: 0s; }
.cc-wave-delay-2 { animation-delay: 0.2s; }
.cc-wave-delay-3 { animation-delay: 0.4s; }

@keyframes cc-wave-bounce {
	0%, 100% { transform: scaleY(1); }
	50% { transform: scaleY(2.5); }
}
</style>
