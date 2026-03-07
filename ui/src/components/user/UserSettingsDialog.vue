<template>
	<UModal
		v-model:open="openProxy"
		:title="$t('settings.title')"
		:fullscreen="isMobile"
		@after:leave="$emit('after:leave')"
	>
		<template #body>
			<UserSettingsPanel />
		</template>
	</UModal>
</template>

<script>
import UserSettingsPanel from './UserSettingsPanel.vue';

export default {
	name: 'UserSettingsDialog',
	components: {
		UserSettingsPanel,
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
