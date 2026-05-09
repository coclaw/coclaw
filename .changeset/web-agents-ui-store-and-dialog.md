---
"@coclaw/ui": minor
---

feat(ui): add web-agents api/store/composable/dialog scaffolding

Introduces the front-end pieces for the public-AI Web Agent feature: REST client (`services/web-agents.api.js`), Pinia store with optimistic-update merge (`stores/web-agents.store.js`), function-style picker dialog composable (`composables/use-web-agent-dialogs.js`), and the dialog/panel components (`components/web-agents/WebAgentPickerDialog.vue`, `WebAgentPickerPanel.vue`). MainList wiring, i18n, svg icons and E2E tests follow in subsequent commits.
