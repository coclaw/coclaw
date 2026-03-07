<template>
	<UModal
		v-model:open="openProxy"
		:title="$t('layout.menu.profile')"
		:fullscreen="isMobile"
		@after:leave="$emit('after:leave')"
	>
		<template #body>
			<UserProfilePanel />
		</template>
	</UModal>
</template>

<script>
import UserProfilePanel from './UserProfilePanel.vue';

export default {
	name: 'UserProfileDialog',
	components: {
		UserProfilePanel,
	},
	props: {
		open: {
			type: Boolean,
			default: false,
		},
	},
	emits: ['update:open', 'after:leave'],
	data() {
		return {
			isMobile: false,
			mediaQuery: null,
		};
	},
	computed: {
		openProxy: {
			get() {
				return this.open;
			},
			set(val) {
				this.$emit('update:open', val);
			},
		},
	},
	mounted() {
		this.mediaQuery = window.matchMedia('(max-width: 767px)');
		this.isMobile = this.mediaQuery.matches;
		this.mediaQuery.addEventListener('change', this.onMediaQueryChange);
	},
	beforeUnmount() {
		this.mediaQuery?.removeEventListener('change', this.onMediaQueryChange);
	},
	methods: {
		onMediaQueryChange(evt) {
			this.isMobile = evt.matches;
		},
	},
};
</script>
