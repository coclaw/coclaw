---
"@coclaw/ui": minor
---

feat(ui): restructure MainList — mixed agent list and dedicated "Add Claw / Add Web Agent" entries

MainList layout reorganized following PM feedback:

- Claw agents and recently used Web Agents are now merged into a single list, sorted by last-used time descending. The previous standalone "Web Agents" group with its globe entry is removed.
- A persistent bottom actions group renders "Add Claw" and "Add Web Agent" so first-time users see both onboarding entries even when the list above is empty.
- The Capacitor narrow-screen header `+` button becomes a dropdown menu exposing the same two actions.
- Desktop sidebar's avatar pop-up menu and mobile "Me" tab menu both gain "Add Claw" and "Add Web Agent" items below "About".
- Desktop sidebar top group keeps "My Claws" as a single dedicated entry (kept as a primary navigation target).

A new single-color stroke SVG `add-claw.svg` (teal-600) is introduced for the "Add Claw" entry icon, paired with the existing globe icon for "Add Web Agent" so both actions are visually consistent.
