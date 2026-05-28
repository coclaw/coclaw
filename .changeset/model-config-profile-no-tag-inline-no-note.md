---
"@coclaw/ui": patch
---

Model-config UX: hide the source badge on CoClaw-stored credentials and drop the config-file note when revoking an inline key

Finalizes two UX simplifications from the model-config design revision that the prior implementation missed:

- The API-keys list no longer shows a source tag on account-stored (profile) credentials — only inline (`Config file`) and environment (`Environment`) rows are tagged. Most users only ever have profile-stored keys, so they now see no tag at all.
- Revoking an inline credential no longer appends a separate "this edits your config file" note; the confirm dialog now reads the same for every source. The primary-model carrier strong warning is preserved.

Also bottom-aligns the source badge with the provider name to fix its optical vertical alignment.
