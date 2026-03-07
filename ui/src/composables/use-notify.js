import { useToast } from '@nuxt/ui/composables';

const PRESETS = {
	success: {
		color: 'success',
		icon: 'i-lucide-circle-check',
		duration: 3000,
	},
	info: {
		color: 'info',
		icon: 'i-lucide-info',
		duration: 3000,
	},
	warning: {
		color: 'warning',
		icon: 'i-lucide-triangle-alert',
		duration: 5000,
	},
	error: {
		color: 'error',
		icon: 'i-lucide-circle-x',
		duration: 8000,
	},
};

function normalize(titleOrOpts) {
	return typeof titleOrOpts === 'string'
		? { title: titleOrOpts }
		: titleOrOpts;
}

export function useNotify() {
	const toast = useToast();

	return {
		success(titleOrOpts) {
			return toast.add({ ...PRESETS.success, ...normalize(titleOrOpts) });
		},
		info(titleOrOpts) {
			return toast.add({ ...PRESETS.info, ...normalize(titleOrOpts) });
		},
		warning(titleOrOpts) {
			return toast.add({ ...PRESETS.warning, ...normalize(titleOrOpts) });
		},
		error(titleOrOpts) {
			return toast.add({ ...PRESETS.error, ...normalize(titleOrOpts) });
		},
	};
}
