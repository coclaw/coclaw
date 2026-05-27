---
'@coclaw/ui': patch
---

fix(ui): stop suppressing model-config guidance for old plugins; drop /claws full-catalog fetch

Two behavior tweaks following the credential-signal work:

- Removed the old-plugin feature-detect-suppress. Previously, when
  `coclaw.model.list` lacked the credential signal (old plugin), the dashboard
  orange bar and the subpage primary-model warning were suppressed (prefer
  fewer prompts over false positives). For the target novice users, proactive
  guidance is itself valuable, and the "new frontend + old plugin" window is
  tiny (plugins auto-upgrade quickly), so old-plugin claws now get the normal
  noKey/invalid guidance.
- `/claws` no longer fetches the full `models.list view:"all"` catalog. Its only
  dashboard consumer was the agent-card model-name badge, which already does not
  render because `status.model` is usually empty — so this is zero visible change
  while saving a ~1000-model pull on every dashboard refresh. The full catalog is
  now fetched only by the model-config subpage (its "model delisted" check is
  unaffected, as it self-fetches).

The subpage's separate "write-time refresh failed → don't falsely report the
primary invalid" guard is preserved (decoupled from old-plugin detection into a
credential-signal-freshness flag).
