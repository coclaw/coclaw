---
'@coclaw/ui': patch
---

fix(ui): drop the success toast after adding a provider

Adding a provider already shows its result directly — the new credential
appears in the list the moment it refreshes — so the success toast was
redundant. Remove it to match the no-success-toast convention already applied
to the primary-model change and remove-provider flows (the success toast there
was dropped, but the add flow was missed). Failures still notify. Also remove
the now-dead `modelConfig.providerAuth.add.success` i18n key across all 12
locales.
