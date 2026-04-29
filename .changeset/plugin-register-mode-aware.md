---
"@coclaw/openclaw-coclaw": patch
---

Make `register(api)` registration-mode aware to align with the OpenClaw plugin SDK contract.

OpenClaw runs a periodic capability scan that calls each plugin's `register(api)` with `api.registrationMode === "discovery"` roughly every 14 seconds. The plugin previously ran every full-mode side effect on each call: instantiating `SessionManager` / `TopicManager` / `ChatHistoryManager` / `AutoUpgradeScheduler`, loading `topics/main.json` and `chat-history/main.json` from disk, calling all `registerService` / `registerGatewayMethod` / `registerCommand` / `api.on` handlers, and overwriting the plugin runtime singleton with the discovery api's empty `{}` runtime.

Although the upstream `api-builder` replaces most `register*` handlers with no-ops in discovery mode (so listener accumulation, service collisions, and double-registration did not actually occur), the plugin still wasted CPU and disk I/O 6000+ times per day, and the runtime singleton was being clobbered to an empty object on every discovery pass — guarded only by optional-chaining fallbacks at every `getRuntime()` callsite.

The new entry now branches on `api.registrationMode` matching the upstream `defineChannelPluginEntry` helper:

- `cli-metadata` → only `api.registerCli(...)` for root command name discovery
- `discovery` / `setup-only` / `setup-runtime` (defensive) → `api.registerChannel(...)` + `api.registerCli(...)` (both captured by upstream `captured-registration` for capability snapshots)
- `full` → all side effects (managers, disk loads, services, RPC methods, `api.on`, command handler)

One intentional deviation from the upstream helper: `setRuntime(api.runtime)` is gated behind `full` only. Upstream's helper invokes `setRuntime?.(api.runtime)` in every non-`cli-metadata` mode, but discovery's empty `{}` runtime should not clobber the live singleton on each capability scan.
