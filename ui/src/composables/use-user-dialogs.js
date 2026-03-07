import { useOverlay } from '@nuxt/ui/composables';

import UserProfileDialog from '../components/user/UserProfileDialog.vue';
import UserSettingsDialog from '../components/user/UserSettingsDialog.vue';

let profileDialog = null;
let settingsDialog = null;

function ensureDialogInstances(overlay) {
	if (!settingsDialog) {
		settingsDialog = overlay.create(UserSettingsDialog, {
			destroyOnClose: false,
		});
	}

	if (!profileDialog) {
		profileDialog = overlay.create(UserProfileDialog, {
			destroyOnClose: false,
		});
	}
}

export function useUserDialogs() {
	const overlay = useOverlay();
	ensureDialogInstances(overlay);

	return {
		openSettingsDialog() {
			settingsDialog?.open();
		},
		openProfileDialog() {
			profileDialog?.open();
		},
		closeUserDialogs() {
			profileDialog?.close();
			settingsDialog?.close();
		},
	};
}
