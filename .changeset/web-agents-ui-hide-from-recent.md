---
"@coclaw/ui": minor
---

feat(ui): add hide-from-recent action on Web Agents list

Each item in the MainList "Web Agents" group now has a kebab-menu "Remove from list" action. Clicking it instantly removes the item from the recent list (no toast, no confirmation) and persists `hiddenAt` server-side. Re-clicking the same agent from the picker automatically un-hides it. Store gains a `hide(id)` action with optimistic update; `recordClick` now also clears local `hiddenAt`; `loadAll` merge uses `lastClickedAt` as a freshness anchor so stale list responses cannot resurrect a just-cleared `hiddenAt` nor overwrite a just-fired `hide`.
