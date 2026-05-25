---
'@coclaw/ui': patch
---

feat(ui): add desktop back button to file manager + highlight its agent in sidebar

Align the file manager subpage with the model-config subpage's desktop
treatment.

- **Desktop header back button**: the file manager desktop header now
  leads with an `i-lucide-arrow-left` button (mirroring `ModelConfigPage`:
  `pl-2` + `gap-1`, back button before the title, upload action stays
  right). It reuses the shared `navBack` helper with a fallback to the
  owning agent's chat page (`/chat/:clawId/:agentId`), so a cold-start /
  deep-link entry with no history still lands somewhere sensible. The
  mobile `MobilePageHeader` now uses the same fallback for consistent
  back behavior across both layouts.
- **Sidebar highlight**: `MainList`'s active-agent resolution now also
  matches the `files` route (not only `chat`), so opening the file
  manager keeps the corresponding agent item highlighted in the desktop
  sidebar.
- **Title separator**: the file manager title now joins the agent name
  and the "Files" suffix with a middle dot (`name · Files`), matching the
  model-config page (`name · Model settings`).
- **Add-claw sidebar entry**: the add-claw page is a standalone entry
  (with its own sidebar shortcut), not a sub-view of the claws manager.
  The "My Claws" top entry no longer highlights on `/claws/add` (it still
  highlights for `/claws/:id/models`); instead the bottom "Add Claw"
  action now highlights when on `/claws/add`. The exclusion is derived
  from the add-action items' own `activePath`, so the two stay mutually
  exclusive.
