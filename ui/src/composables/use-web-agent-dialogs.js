import { useOverlay } from '@nuxt/ui/composables';

import WebAgentPickerDialog from '../components/web-agents/WebAgentPickerDialog.vue';
import { pushDialogState } from '../utils/dialog-history.js';

let pickerDialog = null;

function ensureDialogInstance(overlay) {
	if (!pickerDialog) {
		pickerDialog = overlay.create(WebAgentPickerDialog, {
			destroyOnClose: false,
		});
	}
}

function closeAllDialogs() {
	pickerDialog?.close();
}

export function useWebAgentDialogs() {
	const overlay = useOverlay();
	ensureDialogInstance(overlay);

	return {
		openPickerDialog() {
			pushDialogState(closeAllDialogs);
			pickerDialog?.open();
		},
	};
}
