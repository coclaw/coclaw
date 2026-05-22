---
'@coclaw/ui': patch
---

Remove row-expand interaction from the admin Claws list to reduce on-screen exposure of agent names. Both the desktop table (chevron + expanded slot) and the mobile card (toggle button + expanded panel) now show summary fields only (status / claw name / bound user / plugin version / created-at). The underlying `agentModels` data is still fetched and pushed through admin SSE so it remains available for a future dedicated detail entry, but is no longer rendered in the list itself. Closes #237.
