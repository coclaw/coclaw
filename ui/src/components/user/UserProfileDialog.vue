<template>
	<UModal
		v-model:open="openProxy"
		:title="$t('layout.menu.profile')"
		description=" "
		:fullscreen="isMobile"
		:ui="isMobile ? safeAreaUi : undefined"
		@after:leave="$emit('after:leave')"
	>
		<template #body>
			<UserProfilePanel />
		</template>
	</UModal>
</template>

<script>
import UserProfilePanel from './UserProfilePanel.vue';
import { popDialogState } from '../../utils/dialog-history.js';

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
			safeAreaUi: {
				header: 'pt-[max(0.25rem,var(--safe-area-inset-top))]',
				body: 'pb-[var(--safe-area-inset-bottom)]',
			},
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
	watch: {
		open(val) {
			if (!val) popDialogState();
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
