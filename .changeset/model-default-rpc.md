---
'@coclaw/openclaw-coclaw': minor
---

Add model-default RPC handlers: `coclaw.model.set` configures the default model
primary (or per-agent primary when `agentId` is given) by writing
`cfg.agents.defaults.model.primary` / `cfg.agents.list[i].model.primary` via
field-level config mutation (preserves sibling `fallbacks` / `timeoutMs`,
hot-reload, zero gateway restart). `coclaw.model.list` returns both scopes
in a symmetric `{ default, agents }` map (always includes `main`). Inputs are
validated against the provider catalog (`view: 'all'`) and the configured
auth profiles before write.
