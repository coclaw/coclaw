---
"@coclaw/ui": patch
---

Add a Back button to the add-provider API-key configure step. It replaces the former Cancel button and routes through the existing `onMethodBack` navigation: providers reached straight from the list (single method) return to the provider picker, while providers reached via the method chooser (e.g. API key + OAuth) return to that chooser. Closing the dialog is handled by the modal's X / Esc / overlay (consistent with the method-chooser step). The Back button stays disabled while a submit is in flight, so the user cannot navigate away mid-request.
