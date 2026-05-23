---
'@coclaw/ui': patch
---

feat(ui): show monthly cost on ManageClawsPage Claw card

`dashboard.store` already loads `usage.cost` and stores the result on
`entry.instance.monthlyCost`, but ManageClawsPage never rendered it —
the cost data was fetched on every page load and silently discarded.

The inline Claw header now mirrors `InstanceOverview.vue`'s "name + cost"
two-column layout: name/status/badge on the left, formatted monthly cost
(via `Intl.NumberFormat` currency) on the right. The block is hidden when
`monthlyCost` is missing or has no `total`.

`<InstanceOverview>` itself is still not mounted — ManageClawsPage already
duplicates the rest of the template inline, so mounting the component
would double-render. The 5-line inline addition keeps the existing layout
untouched.
