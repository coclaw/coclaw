# @coclaw/openclaw-coclaw

## 0.22.3

### Patch Changes

- bf04b14: fix(plugin): expose awaitPluginInit so callers can drain register's fire-and-forget init

  `plugin.register()` in full mode kicks off topic and chat-history load +
  reconcile as fire-and-forget promises with no done signal. Tests that share a
  sessions directory cannot wait for these tasks before `fs.rm`, causing
  intermittent ENOTEMPTY when `reconcileAll`'s `atomicWriteJsonFile` lands during
  the `rmdir` step.

  Bundle both init promises into a module-level signal and export
  `awaitPluginInit()`. Production gateway behaviour is unchanged (the gateway
  does not call it); tests and future stop-and-restart flows can now drain
  register's pending background work cleanly.

- 3f9d05e: fix(plugin/file-manager): defer tmp unlink until ws close on cancel/error paths

  The `dc.onclose` (not-done branch) and `dc.onerror` cleanup paths used to
  fire `ws.destroy()` and `safeUnlink(tmpPath)` side-by-side. When fopen had
  not yet completed, unlink could reach the kernel before the file was
  created; the ENOENT was swallowed and a subsequent fopen would re-create
  the file, leaving an orphan tmp file with no one to clean it up.

  Now both paths register `ws.on('close', () => safeUnlink(tmpPath))` before
  calling `ws.destroy()`, mirroring the existing ack-send-failed branch.
  This ensures unlink always runs after the stream is fully closed, whether
  fopen completed normally or failed.

## 0.22.2

### Patch Changes

- 2a5cca7: Best-effort tracking of cron-driven main-session eviction so an evicted user
  session no longer ends up as an invisible head entry in chat-history.

  OpenClaw cron jobs configured with `sessionTarget: "current"` (or an explicit
  `session:<sessionKey>`) rotate the target chat's current `sessionId` whenever
  the freshness window has elapsed (default daily, 04:00 boundary). That code
  path does not emit `session_start` hooks and does not broadcast
  `sessions.changed reason=create`, so before this change the chat-history
  pipeline never learned about the rotation — the evicted user session ended up
  as a head entry with no `archivedAt`, and the chat-history UI filtered it out.

  Three complementary, idempotent paths now keep chat-history in sync; any one
  of them is sufficient for routine cases:

  - **`cron_changed` hook (primary).** The plugin listens for `cron_changed`
    hook events (available since OpenClaw v2026.4.29). On
    `action === 'finished'` events that carry both a `sessionKey` and a
    `sessionId`, the rotation is routed through the same
    `recordSessionTransition` helper used by `session_start`. The `agentId` is
    derived from `sessionKey` (`agent:<agentId>:<channel>`) because older hook
    payloads do not expose `event.agentId`. Main-mode cron events (which only
    `enqueueSystemEvent` and never launch a run) carry no `sessionId` and are
    filtered out by an early return.
  - **Startup reconciliation (gap coverage).** During `register()` (full mode
    only), after `ChatHistoryManager.load('main')` settles, the plugin calls
    `sessionManager.listAllEntries('main')` and feeds the result into
    `ChatHistoryManager.reconcileAll(agentId, entries)`. This covers the
    window when both the plugin and gateway were down: the gateway does not
    replay successfully-finished cron events on restart, so without a startup
    pass an overnight rotation that completes while the gateway is offline
    would never reach `recordSessionTransition`. The existing idempotency
    (head-already-current is a no-op) absorbs the reconciliation cost when
    there is nothing to fix.
  - **Persist-time sanitize guard (self-heal).** Every write through
    `ChatHistoryManager.__persist` runs `__sanitizeAllSessionKeys(store,
agentId)`, which walks every `sessionKey`'s `list[1..]` and forces
    `archivedAt = Date.now()` on any non-tail entry still missing it. Each
    coercion logs a local `warn` and a `chat-history.sanitize-coerce`
    `remoteLog` so the signal is observable. Pre-existing dirty files (from
    earlier cron evictions, abnormal-process races, or older plugin versions)
    are repaired the next time a write occurs.

  `sessions.changed phase=message` is **not** used as a fallback channel: the
  `cron_changed` hook is sufficient for the cron eviction case, and routing
  every transcript message append through chat-history would impose a
  disk-reload cost on every chat for a problem that only matters for cron
  rotation. UI-only paths (`sessions.compact`, `compaction.branch`,
  `compaction.restore`) that mutate `sessionId` without emitting
  `session_start` are similarly out of scope — the chat-history UI tolerates a
  brief mismatch on the next message append.

  Robustness hardening:

  - `recordSessionTransition` and the `handleSessionCreated` entry point both
    reject non-string `sessionKey` / `sessionId` / `archivedSessionId` so a
    malformed hook payload cannot persist garbage values.
  - `classifyChatHistorySessionKey` (the shared guard used by both the event
    path and `reconcileAll`) matches the upstream
    `isCronSessionKey` schema by requiring `cron` to appear at the third
    segment, not any later segment. Without this, an IM per-account DM
    sessionKey such as `agent:main:telegram:cron:direct:<peer>`
    (`accountId === "cron"`, which the upstream account-id regex permits)
    would be skipped from chat-history.
  - `__persist` evicts the in-memory cache for the affected `agentId` when the
    atomic write fails, so the next `recordSessionTransition` re-reads the
    on-disk state instead of persisting the speculative in-memory mutations
    from the failed attempt.

  Supporting addition on the session-manager side:

  - `createSessionManager()` returns a new `listAllEntries(agentId)` thin
    wrapper that reads `sessions.json` and returns
    `[{ sessionKey, sessionId }]`. It skips entries whose `sessionId` is
    missing or not a non-empty string, returns `[]` if `sessions.json` is
    missing, corrupt, or stored as an array, and skips entries with empty
    string `sessionKey`. It does not read transcripts or stat files, so it is
    safe to call eagerly from startup.

  The historical `A→B→C` triple-rotate double-source race documented in
  `plugins/openclaw/src/chat-history-manager/manager.test.js`
  (`REPRO 双源乱序`) remains out of scope; the repro test is left skipped
  pending a separate root-cause fix tracked in `plugins/openclaw/TODO.md`.

- d6f2e44: Fix `coclaw.sessions.getById`: include `.deleted` archives in fallback and lift the silent 500-message cap.

  When the live `<sid>.jsonl` file is missing, the manager now scans both
  `<sid>.jsonl.reset.<iso-ts>` and `<sid>.jsonl.deleted.<iso-ts>` archives and
  picks the one with the latest archive timestamp (OpenClaw's ISO
  `YYYY-MM-DDTHH-MM-SS[.sss]Z` format — same `(?:\.\d{3})?` pattern as
  `artifacts.ts ARCHIVE_TIMESTAMP_RE` — guarantees lexicographic order = time order).
  Previously only `.reset.*` was scanned, so sessions whose only archive was a
  `.deleted.*` file (13 such sessions observed locally) returned an empty
  transcript via this RPC.

  `getById` also no longer clamps `params.limit` to a `[1, 500]` range with a
  default of 500. The two UI callsites do not pass `limit`, and silently
  truncating a long session to the last 500 messages dropped earlier turns
  without any signal to the caller. New semantics:

  - `limit` omitted / `null` / non-`number` type (string, boolean, array, object) /
    `NaN` / `Infinity` / `< 1` → return all messages
  - `limit >= 1` (finite number) → return the last `Math.trunc(limit)` messages
    (so `2.9 → 2`, `1 → 1`; `0.5` is treated as "no limit" rather than
    `slice(-0)` which would silently return everything)

  Strict `typeof === 'number'` is enforced to keep `Number('42') === 42`,
  `Number(true) === 1`, `Number([5]) === 5` from being silently accepted as a
  valid limit through `Number()` coercion.

  The archive scan now validates each candidate's timestamp suffix against
  OpenClaw's ISO `YYYY-MM-DDTHH-MM-SS[.sss]Z` format (mirroring the upstream
  `ARCHIVE_TIMESTAMP_RE`), so trailing-garbage files such as
  `<sid>.jsonl.reset.<ts>.bak` (rsync / manual backup leftovers) no longer
  outrank the legitimate archive in lexicographic ordering.

  Note: `resolveTranscriptFile` is shared by `getById` and `nativeui.sessions.get`
  / `coclaw.topics.getHistory`, so the `.deleted.*` fallback also applies to
  those RPCs. This is a deliberate side-effect — the OpenClaw archive
  `reset.*` / `deleted.*` pair represents the same "final transcript" state
  (both produced by `archiveSessionTranscripts*` in `session-transcript-files.fs.ts`)
  and the consumer impact for `get` is zero in current UI code (no UI caller
  of `nativeui.sessions.get`; `coclaw.topics.getHistory` is already marked for
  deprecation in favor of `getById`). The `get` RPC's own `limit` clamp
  (`clamp(..., 1, 500, 100)`) is intentionally left untouched.

  UI consumers (`__loadTopicMessages`, `loadNextHistorySession` in
  `ui/src/stores/chat.store.js`) will now receive complete transcripts for
  sessions exceeding 500 messages.

## 0.22.1

### Patch Changes

- d0fad51: Update plugin description to highlight the WebRTC-based transport. The npm
  description, `openclaw.plugin.json` manifest, plugin metadata, and channel
  blurb are all reworded to read "OpenClaw plugin for remote chat over WebRTC"
  (plus the existing `openclaw coclaw enroll` setup hint on user-facing surfaces).
  No behavior change.

## 0.22.0

### Minor Changes

- ce59ae4: Add developer-helper CLI subcommands for the provider-auth RPCs:
  `openclaw coclaw auth set-api-key <provider> --key <value>` stores an API
  key (optionally with `--profile-id`), `openclaw coclaw auth list
[--provider <p>]` prints stored profiles with masked previews, and
  `openclaw coclaw auth remove <provider>` clears them. All three are thin
  CLIs that delegate to the corresponding gateway RPCs and share the
  existing retry / restart helpers used by `bind` / `unbind`.
- 19baae8: Fix chat-history session-archival gap on OpenClaw `agent.send` auto-reset paths.

  Previously chat-history only tracked archives via the `session_start` plugin
  hook, but OpenClaw 2026.5.7's `agent.send` RPC creates new sessions without
  firing that hook — so the prior session was silently lost from the history
  index.

  This change adds a second listener path: the plugin now subscribes to gateway
  `sessions.changed` events (reason=create) and archives the prior session
  through the same code path as the hook. The chat-history file schema is
  extended so the head item may be unarchived (no `archivedAt`), representing
  the current active session. Both sources are idempotent: the second source
  is a no-op when state is already settled, mutex-serialized per agent; stale
  events (where `currentSessionId` already exists in the list) are dropped.

  The on-disk `coclaw-chat-history.json` is forward-compatible: existing
  all-archived files migrate naturally on first new transition. The
  `coclaw.chatHistory.list` RPC returns the raw array; UI is expected to filter
  unarchived heads in client code.

  The `chatHistoryManager.recordArchived(...)` method has been replaced with
  `recordSessionTransition({ agentId, sessionKey, currentSessionId, archivedSessionId? })`.
  Only the in-plugin hook handler called it, so the API change is internal.

  The `RealtimeBridge` `onSessionCreated` callback is now injected at the
  constructor (`new RealtimeBridge({ onSessionCreated })`) instead of `start()`
  options. `restartRealtimeBridge(opts)` forwards `opts.onSessionCreated` to the
  new instance's deps on each restart; the callback is fixed for the instance's
  lifetime (refresh()'s internal stop+start does not touch it).

  **Gateway compatibility & reconnect.** The gateway-side `sessions.subscribe`
  binding is per-WS (registered against the active connection's `connId`) and
  is automatically released when the WS closes (see openclaw-repo
  `src/gateway/server/ws-connection.ts:391`'s `unsubscribeAllSessionEvents`).
  The plugin therefore (re-)sends `sessions.subscribe` on every successful
  gateway handshake, without distinguishing first-time vs reconnect. The RPC
  timeout is 60s, sized for gateway restarts that block the main thread for
  seconds. Subscribe failures (only possible from transport-layer faults — the
  gateway handler has no business-error branch) emit one warning + remoteLog
  and otherwise no-op; the next handshake retries naturally. The plugin's
  `minHostVersion` is `>=2026.3.22` (the version where the gateway
  `sessions.subscribe` RPC first ships — see openclaw commit `7b61ca1b06`;
  also ensures the `session_start` hook carries `sessionKey`, available since
  `2026.3.2`); installation on older gateways is rejected by OpenClaw.

  **UI counterpart.** The UI side filter for unarchived heads ships in commit
  `2a00e56` (CoClaw UI). Without that UI change, the current active session
  would appear at the top of the orphan-history list.

  **Rollback compatibility.** Rolling back to plugin <= 0.21.5 is functionally
  safe: the old code returns the raw array verbatim and does not crash on the
  new schema, and the on-disk file remains valid. The only visible effect is
  that an old UI will render the current active session as an extra orphan
  entry at the top of the history list — a cosmetic blip that resolves on the
  next session reset (which writes the entry as fully archived). Clearing or
  migrating `coclaw-chat-history.json` is therefore only necessary if that
  cosmetic correctness matters during the rollback window; it is not required
  for data integrity.

- e24e6b9: Add model-default RPC handlers: `coclaw.model.set` configures the default model
  primary (or per-agent primary when `agentId` is given) by writing
  `cfg.agents.defaults.model.primary` / `cfg.agents.list[i].model.primary` via
  field-level config mutation (preserves sibling `fallbacks` / `timeoutMs`,
  hot-reload, zero gateway restart). `coclaw.model.list` returns both scopes
  in a symmetric `{ default, agents }` map (always includes `main`). Inputs are
  validated against the provider catalog (`view: 'all'`) and the configured
  auth profiles before write.
- 468c44a: Add provider-auth RPC handlers: `coclaw.providerAuth.setApiKey` writes an API key
  profile via the OpenClaw Plugin SDK (no gateway restart), `coclaw.providerAuth.list`
  returns bound profiles across api_key/oauth/token types with masked `keyPreview`
  only, and `coclaw.providerAuth.remove` clears all profiles for a provider.
- 520093f: Apply a minimal default ICE interface filter on the pion path to reduce phantom
  ICE pairs from local virtual bridges. The pion `pcConfig.settings` now ships
  `interfaceFilter.denyPrefixes: ['docker0']`, matching Docker's default bridge by
  its fixed lowercase name. The match is byte-level case-sensitive (Go
  `strings.HasPrefix`); docker daemon hardcodes `docker0` lowercase, so there is
  no case-mismatch risk. The prefix is invisible from inside container/VM/Pod
  netns (Docker bridge containers see `eth0` instead; WSL2 mirrored still has the
  physical NIC mirrored alongside; all hypervisor Guests cannot see host bridges),
  so it cannot misfire as a plugin's only path.

  Docker user-defined bridges (`br-XXXX`) and the `'br-'` prefix were considered
  but rejected: OpenWrt-style systems may use `br-lan` as the only outbound
  interface, and the user red line forbids any chance of breaking that. IP CIDR
  filtering also stays off by default — container/VM eth0 lives in private ranges
  (10/8, 172.16/12, 192.168/16), so any IP-segment deny would break those
  deployments (this is exactly the failure mode go2rtc admits to in its docs).

  Red-line prefixes that must NEVER enter this list (including `'br-'`) are
  encoded as an explicit test so future contributors cannot regress without
  breaking the suite. Rationale, industry references and rejection reasons for
  each near-miss candidate are recorded in
  `plugins/openclaw/docs/webrtc-ice-if-filter.md`.

### Patch Changes

- 504fd5e: Make `bindOk` / `unbindOk` message helpers tolerate missing/undefined data
  so the `coclaw bind` / `coclaw unbind` CLI no longer crashes if the
  `callGatewayMethod` helper falls back to its "non-JSON stdout" branch
  (returning `{ ok: true }` without a payload). In that fallback the CLI
  now prints `OK. Claw (unknown) bound to CoClaw.` / `OK. Claw (unknown)
unbound from CoClaw.` instead of throwing `TypeError: Cannot destructure
property 'clawId' of undefined`.

  Behavior on the normal JSON path is unchanged.

- a135cf4: Surface `archivedSessionId === currentSessionId` upstream-contract anomaly via
  `remoteLog('chat-history.archived-equals-current ...')` instead of swallowing
  it. The case happens when the gateway `session_start` hook delivers
  `resumedFrom === sessionId` (an upstream-contract anomaly that should not
  occur). The normalization (drop `archivedSessionId` to avoid a duplicate
  head/archived entry in the same on-disk list) is unchanged; only the
  diagnostic signal is added so a future upstream regression surfaces in remote
  logs instead of silently disappearing.

  No behavior change on the happy path — the log is only emitted on the
  anomaly. Issue surfaced by the 8th-round deep-review (R-A SHOULD-S2).

- b249d0a: Skip subagent `sessionKey` shapes in chat-history tracking.

  OpenClaw spawns subagents with the sessionKey shape `agent:<id>:subagent:<uuid>`
  (and nested `:subagent:` segments for grand-subagents). Previously the plugin
  treated every `sessions.changed reason=create` event the same and recorded
  those subagent sessionKeys into `coclaw-chat-history.json`, causing
  unbounded growth of orphan unarchived heads (subagents only emit `create`,
  never an archive/end event).

  `handleSessionCreated` now early-returns when `parts[2]` (or any later
  position) equals `'subagent'`, dropping the entry from chat-history and
  emitting `remoteLog('chat-history.skip-subagent ...')` for observability.
  The judgement starts at `parts[2]` so an agent literally named `subagent`
  (sessionKey `agent:subagent:main`) is not affected.

  Rationale: chat-history is for human-machine conversation streams, not for
  internal subagent runs. The parent agent's transcript already contains the
  subagent's final output (re-injected as a user message on completion), so no
  user-visible data is lost.

  Other non-main shapes (cron, IM, etc.) remain recorded — they are still
  human-machine conversation streams that the UI may surface later.

  No behavior change on `agent:<id>:main` or any other recorded shape. Plugin
  patch only; no upstream version requirement change.

- 8433ac1: Drop the `{ status: <data> }` wrap on the 6 RPC methods that had a CLI entry
  (`coclaw.bind` / `unbind` / `enroll` / `providerAuth.setApiKey` / `list` /
  `remove`). Handlers now return business payload directly. The shared
  `callGatewayMethod` helper changes from extracting `.status` to passing the
  parsed wire payload through as a `payload` field, and the in-package CLI
  registrar reads `result.payload.xxx` accordingly.

  The `{ status: <data> }` form was never a protocol requirement — it was a
  private convention of the helper's `.status` unwrap behavior, originally
  introduced to satisfy the upstream `openclaw gateway call --json` rule that
  the payload must be a non-undefined JSON object (otherwise `endsWith`
  TypeError). Each of the 6 handlers now returns a plain non-empty object
  (`{}` for the empty case), so the upstream constraint remains satisfied.

  External behavior is unchanged:

  - CLI users see the same stdout text and exit codes
  - The only wire-form consumer of these 6 methods is the same-package CLI
    registrar (verified by repo-wide grep; server / UI / e2e / other plugins
    do not consume them)
  - `coclaw.upgradeHealth` (used by the auto-upgrade worker) was never wrapped
    and is untouched; the worker's verification path is independent of the
    helper and not affected

- 4385130: Drop `peerDependencies.openclaw` and `peerDependenciesMeta.openclaw.optional`
  from `package.json`. On pnpm v10 with `auto-install-peers` enabled (the
  default), the `optional: true` marker was not honored in this monorepo setup
  and pnpm pulled the entire `openclaw` package plus its transitive dependency
  graph into `pnpm-lock.yaml` (~2700 line bloat). The OpenClaw plugin loader's
  literal-import alias mechanism resolves `openclaw/plugin-sdk/*` independently
  of any plugin-local `node_modules/openclaw` symlink, so the loader's reassert
  step (gated on the peer declaration) is not required for runtime resolution.

  Verified end-to-end on both install paths:

  - `--link` (plugin-dir): stage has no `openclaw` symlink, RPC calls succeed
  - `plugin-archive` (`npm pack` + install): installed `node_modules/` has no
    `openclaw` symlink, RPC calls succeed

  If SDK import ever fails at runtime, the chain of defenses is intact: no
  top-level `openclaw` import exists in plugin source; the literal dynamic
  imports live in arrow-function factories; first-call resolution is wrapped in
  a `try/catch` that returns a structured `IO_FAILED` error; and the upstream
  loader catches plugin load/register failures. The gateway main process is
  never at risk.

- 54500e5: Internal refactor of bridge ↔ chat-history wiring (no runtime behavior
  change):

  - `restartBridge` in the plugin entry now passes `handleSessionCreated`
    directly as `onSessionCreated`; the previous inline `({ sessionKey,
sessionId }) => handleSessionCreated({...})` adapter is removed. The
    semantics are unchanged because `handleSessionCreated` already falls
    back when `agentId` and `archivedSessionId` are missing (which is the
    case for the `sessions.changed reason=create` event payload). The
    adapter's documentation has been folded into the
    `handleSessionCreated` jsdoc so the bridge-vs-hook input contract is
    co-located with the function it describes.
  - A test-only `__getSingletonForTest()` export is added to
    `realtime-bridge.js`. It lets the bridge test suite pin the wiring
    contract `restartRealtimeBridge({ onSessionCreated }) ⇒ singleton.__onSessionCreated === cb`,
    including the negative case where a subsequent restart without the
    callback recreates a singleton with `__onSessionCreated = null`.

- 4d97ff9: Fix the provider-auth RPCs (`coclaw.providerAuth.setApiKey` / `list` /
  `remove`) so the plugin-sdk import is actually picked up by OpenClaw's
  plugin loader.

  The SDK is now loaded via a literal `import('openclaw/plugin-sdk/provider-auth')`
  in the plugin entry, and the resolved module is passed into the handler
  registrar. OpenClaw's plugin loader only triggers the
  `openclaw/plugin-sdk/*` alias rewrite when the bare specifier appears as a
  string literal in the entry file's source. The previous variable-based
  dynamic import sat in a sub-module, missed the loader scan, fell through
  to native Node resolution, and failed because the link-stage
  `node_modules/` doesn't bundle `openclaw`.

  Note: the original `{ status: <data> }` response wrap shipped with this
  commit has since been removed by the "drop coclaw status wrap" changeset;
  the optional `openclaw` peerDependency declaration has since been removed
  by the "drop optional openclaw peerDependency" changeset. See those
  changesets for the current state of those concerns.

## 0.21.5

### Patch Changes

- a145aa6: Aggregate the per-connId offer mutex into the WebRTC session so the lock lifetime always tracks the session it serializes. The sync entry-gate in `__handleOffer` now performs the five-step atomic session-replace for non-ICE offers (detach handlers, clear timers, delete from map, fire-and-forget finalize, build new session), with `__handleOfferLocked` reduced to SDP negotiation only — including a new four-point identity recheck on the first-offer path that mirrors the ICE restart path. `closeByConnId` gains an `expectedSession` argument and short-circuits when the table no longer points to that session, closing the structural race between mutex deletion and concurrent offers without introducing reference counting or fire-and-forget cleanup of the close itself.
- 10176b1: Skip the redundant JSON.stringify on the gateway WS → plugin → DC forward path to remove a recurring main-thread CPU burst. Inbound `event:agent` frames carrying multi-MB tool_result / compaction-summary payloads previously paid one `JSON.parse` on the WS handler entry plus another `JSON.stringify` inside `webrtcPeer.broadcast` / `sendTo` before being chunked and sent — the second pass was a 30–100ms synchronous block per big frame that stalled RTC keepalives, RPC delivery, and PC events. `broadcast(payload, rawStr?)` and `sendTo(connId, payload, rawStr?)` now accept an optional pre-serialized string and pass it straight to the rpcQueue when the gateway WS handler already has it; the three forward exits (rpc-res unicast / agent-event unicast / fallback broadcast) wire the original `event.data` through. Existing call sites that build small frames in code (error responses, plugin-probe, broadcastPluginEvent) are unchanged. The raw fastpath rejects strings containing literal `\n`/`\r` and falls back to stringify so the FBQ JSONL spill format stays intact even if upstream ever sends pretty-printed JSON.
- 5db98c0: Tighten rtc signaling diagnostics and reclaim semantics. The realtime-bridge outer catch on `handleSignaling` now logs and remoteLogs `rtc.signaling-error` with structured `type=<rtc:offer|rtc:closed|rtc:ice>` and `conn=<connId>` fields, so server-side ops can locate the signaling path that failed without parsing the message string. `WebRtcPeer.closeAll` becomes a while-drain loop — any session that lands in the table while the first round is awaiting `pc.close` is reclaimed by the next round, structurally eliminating the previously documented snapshot race instead of relying on the 12h failed-TTL fallback. The rtc:closed handler reverts to a one-line bare await; the original close-failure rethrow contract is preserved through the new structured outer-catch fields.
- 805b452: Stream session JSONL parsing to keep the gateway event loop responsive on large transcripts. `coclaw.sessions.get` / `getById` previously did `text.split(/\r?\n/)` on the full file then a tight synchronous loop of `JSON.parse` per line — both were single CPU bursts that could stall the WebRTC ack/event-forwarding path for hundreds of milliseconds on a multi-MB transcript. The new path scans line boundaries with a cursor (no whole-string split) and yields to the event loop via `setImmediate` every 100 lines, so other I/O callbacks (RTC frames, concurrent RPC handlers) can interleave. Adds a reusable `iterTextLines` helper in `src/utils/text-line-stream.js` for any future large-text line scanning.
- 043d8d9: Make session-manager fully async to remove synchronous fs reads from the gateway event loop. Listing sessions and loading a session by id (`coclaw.sessions.getById`, `nativeui.sessions.listAll` / `.get`, `coclaw.topics.getHistory`) previously did blocking `readFileSync` on JSONL transcripts during UI refresh, freezing the plugin's WebRTC ack/event-forwarding path for seconds at a time. All reads now use `fs.promises`, with ENOENT-tolerant directory walks. Also drops the unused `derivedTitle` field from `listAll` results (the UI consumers were removed earlier) so listing no longer reads any transcript content.
- d934de7: Serialize WS signaling per `connId` via an in-memory FIFO drain and retire the per-session `offerMutex`. The previous mutex implementation forced an `await prev` microtask hop in front of `pc.setRemoteDescription`, which on pion-ipc let nearly-simultaneous ICE candidates win the underlying IPC byte order and made pion reject the first few candidates with "remote description is not set". The new design queues every `rtc:*` message by `connId`, drains them strictly in arrival order, and removes the mutex hop entirely. `closeAll` flips a sticky `__stopping` flag that the drain (and `__handleOffer` entry) honour to drop further signaling during shutdown without leaking orphan sessions; per-item errors are caught inside the drain (with each diagnostic wrapped in its own try/catch and a `.catch()` on the drain Promise itself, so a misbehaving logger cannot turn into an unhandled rejection or leave queued resolvers hanging) and surfaced as `rtc.signaling-error` remoteLog so the bridge's outer catch is no longer the only diagnostic source. Three identity-rechecks around SDP `await`s remain to defend against `closeByConnId` paths that bypass the queue (failed-TTL, `connectionState=closed`, `closeAll`).

  Behavioural note: when the UI happens to send two back-to-back non-ICE-restart offers on the same `connId` (atypical — UI normally cycles `connId` on rebuild), the plugin now emits an answer for each (FIFO first-wins) instead of suppressing the first via the previous mutex-driven last-wins. The UI already wraps `setRemoteDescription` for stale answers in a `try/catch`, so the duplicate answer is logged and ignored rather than crashing the page.

  `rtc:closed` is also routed through the same FIFO drain, so a `rtc:closed` that arrives while an `rtc:offer` for the same `connId` is mid-flight (SRD/createAnswer/SLD) now queues behind the offer instead of pre-empting it. The offer completes, an `rtc:answer` is emitted, and only then is the session closed. Under the previous mutex design `rtc:closed` bypassed the lock and could tear the session down mid-negotiation, causing the offer's identity rechecks to drop the answer. The UI's `setRemoteDescription` is already optional-chained (`pcAtAnswer?.setRemoteDescription(...)`) and `.catch()`-wrapped, so a stale answer arriving after the UI's PC has been torn down is logged and dropped without a regression.

## 0.21.4

### Patch Changes

- 751a1c7: Fix concurrent ICE restart offer race causing user-facing "Agent run failed" notifications. The plugin now serializes per-connId offer handling with a mutex so multiple near-simultaneous restart offers from the UI run sequentially (last-write-wins), avoiding the pion `InvalidModificationError` that previously triggered an over-eager session teardown. The ICE restart success path additionally re-checks session identity after each await so close-during-lock paths (rtc:closed / connectionState transitions / closeAll) abort silently instead of emitting a stale answer or restart-rejected.

## 0.21.3

### Patch Changes

- ab4a8c7: Drop unused `pluginConfig.gatewayWsUrl` fallback. Plugin and gateway always share a host/port resolved from `OPENCLAW_GATEWAY_PORT`, and the `COCLAW_GATEWAY_WS_URL` env override remains for dev/debug. Also removes the field from the plugin config schema; any leftover entry under `plugins.entries.<id>.config.gatewayWsUrl` should be cleaned up since `additionalProperties: false` will reject it.
- ac3ec72: Extend the gateway handshake retry tail with six more `20s` slots, taking the table from 9 retries (~80s budget) to 15 retries (~200s budget). Once the table is exhausted the bridge enters a sticky `gave-up` state and only `stop+start` can revive it, so the budget needs to cover slow-start scenarios (profile init, cold disk, first-time pion subprocess spawn) — `~80s` was easy to exceed and led to a permanent offline state on chat RPCs until the user restarted the plugin. The front-loaded head and existing semantics are unchanged.
- 9675b88: Front-load four short delays (`1s`, then three `1.5s`) in the gateway handshake retry table so the first retry happens well before the previous `5s` floor. This shortens recovery from the boot-time race where the gateway server replies `gateway starting; retry shortly` (`retryAfterMs=500`) on the very first connect; the second attempt now lands roughly a second after the failure instead of five. The original `5s/10s/20s/20s/20s` tail is preserved, so the budget grows from 5 to 9 retries (10 total attempts) before entering the gave-up state.
- 60fa11e: Skip realtime bridge startup when no gateway auth token is resolvable, and align the default token resolver with the upstream server's priority. The bridge's `service.start` entry now bails out early (with a single `info` log) instead of opening the inner-line WebSocket and producing `token_missing` noise on the gateway. The default resolver (`defaultResolveGatewayAuthToken`) reads `config.gateway.auth.token` first and falls back to the `OPENCLAW_GATEWAY_TOKEN` env variable, mirroring the upstream `auth-surface-resolution` order so a stale env value can no longer mask a fresh config token.
- 7c331f4: Harden the realtime bridge token guard introduced in the previous patch. Resolve the gateway auth token before tearing down any existing singleton, so a transient resolver failure can no longer kill a healthy bridge. When the resolver itself throws, log the underlying error via the injected logger instead of swallowing it silently. Also export `GATEWAY_RETRY_DELAYS_MS` so the retry-timer test helper imports the same constant the production code uses, removing the duplicated retry table that was prone to silent drift.
- 248c908: Remove the realtime-bridge startup gate that skipped bridge creation whenever the resolver returned no gateway auth token. The gate broke users running OpenClaw with `gateway.auth.mode: "none"` (an officially supported loopback-only mode) — for them no token is the _correct_ state, but the gate stopped the bridge and made remote chat unusable. The bridge's gateway-connect path already handles an empty token gracefully (omits `auth` in the connect request), so the gate's only effect on those users was the regression. Restoring the previous behaviour makes the bridge start in `service.start` regardless of token presence; the existing retry/give-up table remains the bound on first-install token-missing noise.
- 596f896: Surface `openclaw coclaw enroll` as the next step for fresh installs. The OpenClaw plugin manifest and the npm `description` now point users at the enroll command, and the gateway log emits a one-time hint (`[coclaw] not bound — run \`openclaw coclaw enroll\` to connect to CoClaw`) at register time when no binding token is present. Already-bound installs see no change.

## 0.21.2

### Patch Changes

- 2d7e257: fix(plugin): decouple server WS / gateway WS / WebRTC P2P lifecycles (step 1: pure decoupling)

  Round 2 refactor for the realtime bridge. The three connections — external (plugin↔CoClaw server WS), internal (plugin↔local OpenClaw gateway WS), and P2P (WebRTC PC + DC routing tables) — are now lifecycle-independent.

  Server WS non-auth-close (4000 / 1006 / 1011 etc.) no longer cascades to closing the gateway WS, clearing `__dcPendingRequests`, clearing `__runEventRoutes`, or canceling gateway retry/attempts. Auth-close (4001 / 4003) still tears down PC + fileHandler + token (plugin loses operating right) but no longer cascades to the gateway WS.

  This is pure decoupling — no new behavior added. The push-splitting (action 3 in the plan) lands separately in step 2.

- d1dceaa: fix(plugin): re-push instance info on outer line up when inner line already ready (step 2)

  Round 2 step 2 follow-up to the three-line decoupling. Previously `__pushInstanceInfo` was triggered only on inner line (gateway WS) connect-ok. After step 1 the inner line can become ready before the outer line (CoClaw server WS) — that first broadcast then drops on the server path because `__forwardToServer` rejects sends while the outer line is still down.

  This change adds a guarded re-push at outer line `sock.open`: when `gatewayReady === true` we call `__pushInstanceInfo` again so the server / admin dashboard sees the plugin's `name / hostName / pluginVersion / agentModels` as soon as the outer line comes up. The guard is essential — `__pushInstanceInfo` collects `agentModels` via the gateway `agents.list` RPC, so pushing while inner line is down would emit incomplete data.

  Naming note: this is "re-push" semantics, not a true split — the inner-line trigger remains in place. The "splitting" framing in the step 1 changeset was approximate.

- cc0eb36: chore(plugin): promote inner-line handshake logs from debug to info

  Promote four plugin↔gateway WebSocket handshake milestones from `debug` to `info` so they survive the default log level (which usually filters out debug):

  - `[coclaw] gateway ws open, waiting for connect.challenge`
  - `[coclaw] gateway event <- connect.challenge legacyMode=...`
  - `[coclaw] gateway connect request -> id=...`
  - `[coclaw] gateway connect ok <- id=...`

  These are first-class lifecycle events for the inner line and align with the existing outer-line `[coclaw] realtime bridge connected: ...` (also `info`). Previously they only showed up under verbose logging, making it harder to diagnose handshake races (e.g. plugin startup colliding with `gateway starting; retry shortly`). Higher-volume RPC routing logs (`rpc-res-route` / `run-event-route`) remain `debug`.

  No behavior change.

## 0.21.1

### Patch Changes

- ce546d3: fix(plugin): keep WebRTC sessions across server WS reconnect; tighten heartbeat miss limit to 3

  Plugin side:

  - Decouple PeerConnection lifecycle from server WS lifecycle. On non-auth WS close (heartbeat timeout 4000, abnormal 1006, etc.), the bridge now retains `webrtcPeer` and `fileHandler` instances so existing UI <-> plugin data channels survive a WS reconnect. Auth-close (4001/4003) still tears down PCs and clears the local token. `stop()` continues to close all PCs deliberately.
  - Tighten `SERVER_HB_MAX_MISS` from 4 to 3 so detection lands at ~135s instead of ~180s. Real-world worst observed main-thread spike (~89.5s, OpenClaw upstream issue #75069) still has ~1.5x margin.
  - `__forwardToServer` now logs a warning instead of silently dropping when WS is not ready or `send` throws, so signaling drops during a WS-down window become visible. Full queue/rollback behavior is tracked in plugins/openclaw/TODO.md.

  Server side:

  - Mirror the `CLAW_PING_MAX_MISS` heartbeat limit from 4 to 3 to keep both directions of the plugin <-> server WS in sync.

## 0.21.0

### Minor Changes

- 9ee3459: Round out FBQ/MemoryQueue stability after the closure deep-review:

  - Close the same-connId rpc DC rebuild race in `WebRtcPeer.__setupDataChannel`. Sync ondatachannel had already swapped `session.rpcChannel` to the new dc (with `readyState='open'`), but `session.rpcQueue / rpcDcSender / rpcConsumeLoop / rpcDropMonitor` were retained until `await session.rpcQueue.destroy()` finished. Concurrent `broadcast()` / `sendTo()` in that window saw "old queue + new dc open" and pushed messages into the queue that was about to be destroyed. The assembly section now captures old refs to locals and **synchronously** nullifies the four session fields before awaiting old destroy, so producers in the await window observe `rpcQueue=null` and skip (equivalent to "channel not ready").
  - Add a 10s `Promise.race` timeout around `cleanupResiduals` + `measureDiskCap` in `RealtimeBridge.start()`. The internal helpers are designed to never throw (only warn + fallback), but a hung fs operation (NFS / mounted disk / blocked statfs) used to keep `bridge.start()` stuck indefinitely, blocking native WebRTC preload. The prep is now wrapped in an IIFE that returns `{ queueDir, diskCap }`; if the race times out, the catch branch leaves `__diskCap` / `__queueDir` null and the queue assembly falls back to `MemoryQueue`. The IIFE no longer mutates `this.__diskCap` directly, so a backgrounded prep that finishes after timeout cannot re-overwrite the degraded state. `clearTimeout` runs in `finally` to suppress the no-op timer fire when prep wins the race.
  - Pin the `spillActive` flag into `rpc-drop-monitor.summarize()` anomaly detection. The `hasAnomaly` check now includes `spillActive`, and the `rpc-queue.close` log line carries an explicit `spillActive=bool` field (between `fsBroken=` and `lastReason=`). With FBQ as the production default, "queue destroyed mid-spill" now surfaces in the close log even if `residualWrittenBytes` / `residualDiskBytes` paths drift in the future.
  - Replace the silent `.catch(() => {})` on `dc.onclose`'s fire-and-forget `rpcQueue.destroy(...)` with a `logger.warn?.()` call. Destroy failure on dc.onclose is a cold path (mutex-internal exception during teardown), but silent swallow left ops with zero visibility on potential disk residual leaks.
  - New tests pin the fixes:
    - "WebRtcPeer: 同 connId 重建期 broadcast/sendTo 不进入旧 queue（race 闭合）" — the red test for the assembly nullify P1.
    - The existing "旧 destroy 完成前不构造新 queue" test updates its assertion from `session.rpcQueue === queue1` to `session.rpcQueue === null` to reflect the new sync-nullify contract.
    - "bridge.start should bail out via 10s timeout if rpc-queues prep hangs" using `t.mock.timers` + `tick(10000)` to deterministically cover the timeout path.
    - "summarize: spillActive=true 单独触发 anomaly close" + "spill-start → spill-end → 干净状态不 emit" + "overflow + spill 同时 active 两 flag 完全独立" — three monitor tests pinning the new spillActive contract and the independence of overflow/spill flags.
    - "WebRtcPeer (FBQ 镜像): \_\_setupDataChannel 在 FBQ.init() 期间不挂 session 三件套" — mirrors the existing MemoryQueue stale-init invariant onto the FBQ path (production default). The `withQueueLifecycleMock` helper gains an optional `target` parameter.
  - Documentation realigned with code:
    - `docs/rpc-dc-file-queue.md` `onSpillEnd` now lists both `drain` and `clear()` as triggers.
    - `docs/rpc-dc-file-queue.md` `overflow-end` clarifies that `dropped` / `droppedBytes` are monitor-lifetime cumulative, not reset per overflow cycle.
    - `docs/rpc-dc-send-queue.md` `fs-error` source describes the actual two-step async path: writeStream `error` listeners only set `fsBroken`, and the `fs-error` drop is reported when a subsequent non-bypass enqueue hits the fsBroken short-circuit.
  - Closure deep-review surfaced a pre-existing concurrent same-connId ondatachannel setup race (two setups overlapping, second skips teardown after the first nullified the fields). The race exists in both pre- and post-fix code paths (sync-nullify did not introduce it; the prior await-destroy form had the symmetric problem via `destroy` fast-return). Recorded in `TODO.md` as follow-up; no known UI/server flow currently triggers it.

- 0d13e19: Round out FBQ after the multi-end stress test and a follow-up deep-review:

  - Align admission decision style with `MemoryQueue` across all three positions (disk-cap admission, mem entry, refill stop condition): `current >= threshold` with single overshoot. The `ENTRY_OVERHEAD` constant is removed so neither implementation accounts for metadata overhead. This collapses the FBQ↔MemoryQueue semantic divergence to just "physical storage" + "fsBroken degraded path"; admission decisions are now identical.
  - Add `onSpillStart()` / `onSpillEnd(drainedBytes)` edge hooks on `FileBackedQueue`. The rpc drop monitor wires them through with edge-debounced local + remote logs and a `spillActive` flag in `getStats`. Field tests showed jsonl files appearing and draining without any log signal, leaving operators unable to distinguish "drain finished" from "fs-broken deleted it".
  - `onDrop('disk-cap', size, ...)` now passes `{ memBytes, writtenBytes, diskCap }` as the third arg; the monitor expands all three components in the `disk-cap-start` log. The `disk-cap` reason name was being misread as "the on-disk file is full" when its actual semantics is "mem + writtenBytes total occupancy hit threshold".
  - Stop the `fbq.drop` warn spam: `__dispatchDrop` no longer logs locally — diagnostics flow exclusively through the monitor (which already does edge-debounced state-machine logging), restoring the contract `MemoryQueue` established.
  - Enforce fsBroken precedence over disk-cap admission. A `!this.fsBroken` guard on the disk-cap check ensures non-bypass messages in the degraded mem-only mode drop with reason `fs-error` (carrying `lastFsErr`) instead of `disk-cap`, matching red-line 3 in `docs/rpc-dc-file-queue.md`. The previous behavior could mislead operators when persistent bypass overshoots pushed mem past the diskCap threshold.
  - `clear()` now mirrors `__dropFile()`: snapshot `wasSpilled` and `drainedBytes` before resetting state, then dispatch `onSpillEnd` if the queue was spilled. Without this, the monitor's `spillActive` flag would stay stuck after `clear()` and silently swallow the next real `spill-start` signal.
  - Tighten boundary tests: true single-overshoot first message (size > threshold), refill per-step stop condition pinned via `readOffset` progression, lazy bypass predicate exercised on a real spill path, logger-throw with `spillActive` state-flip assertion, partial `disk-cap` payload fallback, exhaustive monitor method count via `Object.keys.length`. Three dispatch-site tests pin that `__handleFsError` and `destroy` do NOT invoke `onSpillEnd` (those signals are covered by `fs-broken` and the close summary respectively).

- 5262477: Restore `FileBackedQueue` (FBQ) as the default rpc DC send-queue implementation after the multi-round deep-review hardening. The 0.20.1 emergency rollback to `MemoryQueue` was a temporary measure while bypass-overshoot semantics, monitor close-log signal coverage, and the destroy synchronous contract were being pinned down; those follow-ups have all landed in the preceding patch releases. With FBQ back as default, long-background / ICE-restart / Capacitor backgroundRestore paths once again spill to disk instead of dropping on memory budget, while the `'fbq' + queueDir unavailable` automatic fallback to `MemoryQueue` keeps gateway assembly resilient when the on-disk queue dir cannot be prepared (e.g., bridge startup `prep` failed, `state-dir` not writable). The module-level `RPC_QUEUE_IMPL` constant remains a single-line knob — flipping back to `'mem'` only requires changing one line if a future emergency rollback is ever needed again. The corresponding production-default invariant test was reversed to pin FBQ-as-default, and the two `bypassAdmission` reference-equality / behavior pins were converted to explicit `rpcQueueImpl: 'mem'` overrides so the mem and fbq assembly paths are each covered by an explicit, default-independent test.

### Patch Changes

- 989eaf3: Skip the auto-upgrade scheduler when the host is in OpenClaw Nix mode (`OPENCLAW_NIX_MODE=1`).

  Starting with OpenClaw 2026.5, `openclaw plugins update|install|uninstall` calls `assertConfigWriteAllowedInCurrentMode()` and throws `NixModeConfigMutationError` (code `OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE`) on Nix-managed installs, where `~/.openclaw/openclaw.json` is treated as an immutable Nix-built artifact. The plugin's auto-upgrade worker would have repeatedly invoked `openclaw plugins update <id>` on these hosts, generating noisy failures with no possibility of success (any runtime mutation gets reverted on the next Nix rebuild).

  The scheduler now short-circuits at `start()` with an info log (`Skipping: host is in Nix mode (config is immutable)`) and a one-shot `upgrade.nix-mode-skip` remoteLog event so user-visible "auto-upgrade not running" reports can be correlated server-side without needing to ask the user about their install method. The Nix-mode probe is strict-equality with the string `"1"`, mirroring upstream's `resolveIsNixMode` semantics — `"true"`, `"yes"`, etc. are intentionally not honored.

- aa908bf: Fix `FileBackedQueue` so `bypassAdmission`-eligible messages keep getting accepted into the in-memory tier while the queue is in the sticky `fsBroken` degraded mode, mirroring the `MemoryQueue` overshoot semantics.

  Before this fix, once `fsBroken` latched (sticky after any spill IO failure), the in-memory tier became the de facto capacity layer because spill was permanently disabled. But the bypass exemption was anchored only to the `diskCap` admission gate, not to the in-memory `memBudget` gate — so once the in-memory tier filled, even agent-response (`type === 'res' && payload.runId`) frames fell through to the `fsBroken` short-circuit and were dropped with reason `fs-error`. Pure `MemoryQueue` would have kept accepting those same bypass-eligible messages via overshoot, so the two implementations diverged precisely where users see degraded service.

  The fix narrows the divergence: in `fsBroken` mode, when the in-memory tier is full and the message hits `bypassAdmission`, FBQ now overshoots `memBudget` and accepts the message. Healthy-path behavior is unchanged — bypass-eligible messages still spill to disk normally when the in-memory tier fills under healthy IO, so spill is not bypassed for ordinary load. Bypass still does NOT exempt the actual write-IO failure (mkdir / writeStream emit error / write callback err) that initially latched `fsBroken`; only the post-latch capacity layer is exempted.

  Docs and the `bypassAdmission does NOT exempt physical IO failure` test are updated to match the corrected red-line-3 semantics: bypass exempts the capacity layer (including degraded-mem-only mode), but never the actual write attempt nor the per-message `oversize` cap. A new red-then-green test (`bypass admission overshoots memBudget under fsBroken`) pins the new behavior.

- f083758: Tighten the FBQ bypass-overshoot fix after multi-round deep-review:

  - `RpcDropMonitor.summarize()` now reads `residualStats.fsBroken` and surfaces `fsBroken=true` in the `rpc-queue.close` log even when no `onDrop('fs-error')` was ever delivered. Without this, the bypass-overshoot path (and other async fs-error paths) could silently flip the queue into degraded mode while the close-log claimed `fsBroken=false`, hiding the degradation from operators.
  - `FileBackedQueue.enqueue()` now memoizes the `bypassAdmission` predicate lazily — the predicate is invoked at most once per `enqueue()`, only when the admission or the fsBroken-overshoot branch actually needs the verdict. The uncongested fast path (under-`diskCap` and mem fits) now skips the predicate entirely, restoring the short-circuit semantics that the previous round-2 fix had inadvertently dropped by eagerly evaluating the predicate on every enqueue. Behavior on contended paths is unchanged; the cached result keeps the admission and overshoot branches consistent even when the predicate is non-idempotent.
  - New regression tests pin: predicate is lazy on the uncongested path; predicate invokes exactly once on the admission-hit and overshoot-hit paths; monitor close emits `fsBroken=true` when only `residualStats.fsBroken` carries the signal; monitor close emits exactly once when both the internal `fs-error` onDrop and `residualStats.fsBroken` agree; `isAgentRunResponse` rejects JSON arrays / non-`res` types with `runId` / `null` input. The `destroy(onBeforeClear)` synchronous-contract tests for both queues are rewritten to use a thenable awaited-flag instead of a 200ms wall-clock race.
  - Docs (`rpc-dc-file-queue.md` / `rpc-dc-send-queue.md`) are synced with the corrected red-line-3 boundary: bypass exempts the capacity layer including the fsBroken degraded mem tier, but never the per-message size cap nor the actual write-IO failure. The current production default (`MemoryQueue`) and the FBQ "reserved path until fully validated" framing are restated to match the post-rollback state.

- e6ad975: Clarify gateway WS close logging so plugin-initiated and peer-initiated closes are no longer indistinguishable. Previously, when the plugin actively closed its connection to the local OpenClaw gateway WS (e.g. after the upstream server WS dropped), the close handler logged `gateway ws closed (code=1000 reason=server-disconnect)` — the literal `server-disconnect` token was a self-supplied close reason, but read like the upstream CoClaw server had hung up the gateway WS, leading to misdiagnosis. The plugin now tags `ws.__closedByPlugin` before each of its own `close()` calls (`__closeGatewayWs`, error-handler `close(1011, 'ws_error')`, and the handshake-failure `close(1008, 'gateway_connect_failed')`) and the close handler emits distinct messages: `gateway ws closed by plugin (reason=…)` for self-initiated closes (with the self-supplied reason renamed from `server-disconnect` to `local-close`), and `gateway ws closed by peer (code=… reason=…)` only for genuine peer-initiated closes. The remote log mirrors the split — a new `ws.local-close peer=gateway reason=…` event is emitted for plugin-initiated closes while the existing `ws.disconnected peer=gateway code=… reason=…` event now fires only on peer-initiated closes — preserving server-side observability of any abnormal local-close loops while removing the overloaded "server-disconnect" wording from the gateway WS path. Close codes (1000 / 1008 / 1011) are unchanged; no consumer reads them as business signals on this WS, but keeping them stable minimizes surface area. The unrelated server WS close codes (4000 / 4001 / 4003 / 1000-on-stop) are not touched — those remain a contract consumed by the CoClaw server's claw-ws-hub.
- 876501c: Mirror `rpc-queue.close` summary to the local logger so developers debugging on a single host can grep the close anomaly in the gateway log file. Previously `summarize()` only emitted via `remoteLog`, which routes to the server side — leaving operators on a local machine unable to see drop counts, residual bytes, fsBroken / spillActive flags, or `lastReason` at session teardown without server-side access.

  The local emission uses the existing tagged form `[rpc-queue conn=X] close <fields>` (consistent with `overflow-start` / `disk-cap-start` / `spill-start` etc.), gated by the same `hasAnomaly` check so clean sessions stay silent. Field order and values are identical to the remoteLog counterpart so a single grep regex works against both sources.

## 0.20.2

### Patch Changes

- 5358bc8: Speed up the file-manager handler test suite by replacing ~80 fixed `setTimeout` sleeps with event-driven waits. The mock DataChannel now hooks `send()` to wake any pending wait whose predicate has become true, and a generic `waitFor(predicate)` helper polls at 1 ms intervals for cases without a `send` signal (filesystem state, `remoteLog` entries, exposed counters, etc.). Each former sleep is replaced with a predicate aligned to whatever the next assertion was about to check, so the test moves on the moment the SUT is actually ready instead of blocking for whichever round-number ms the original author guessed. Handler test file dropped from ~10.5 s to ~2.0 s (80% reduction); overall plugin suite ~9 s faster. A handful of negative-timing tests ("should not crash", race-prone tmp-file cleanup) intentionally retain a short fixed sleep where there is no positive signal to wait on. The handler implementation itself is not modified.
- 358de0c: Speed up the test-only mock HTTP helper by force-closing all keep-alive connections before `server.close()`. Without this, Node's `http.Server.close()` waits for every existing client connection to be terminated by the client side, and undici (Node's built-in fetch) keeps connections alive for a few seconds by default. The `coclaw.bind`/`coclaw.unbind` cancel-enroll test in particular dropped from ~13 s to ~70 ms after this change, and the overall plugin test suite is ~10 s faster. The helper itself is excluded from the published package (declared in `package.json` `files`), so this change has no production impact.
- b106430: Speed up the realtime-bridge test suite by replacing fixed `setTimeout` sleeps with event-driven waits. Three changes in one pass:

  1. The `ensureAgentSession should NOT reset on resolve timeout` test no longer waits for the production code's hardcoded 2 s `sessions.resolve` timer — it stubs `bridge.__gatewayRpc` to return `{ok:false, error:'timeout'}` immediately and verifies that no `sessions.reset` is sent. The end-to-end `__gatewayRpc` timeout path remains covered by the dedicated `__gatewayAgentRpc` timeout tests.
  2. A small `waitFor(predicate, opts)` helper replaces 26 × 50 ms, 2 × 100 ms, and the 80 ms TTL-scan sleep across the rtc-signaling, WebRTC-peer init, broadcast, gateway-DC routing, and remote-log flush tests. Each replacement targets the specific signal the next assertion needs (peer created, answer forwarded to server, broadcast queue advanced, buffer drained, `__sessions` populated, etc.) so each test proceeds the moment the SUT is actually ready.
  3. Two intentional fixed sleeps are preserved: the `setTimeout(50)` inside the slow-preload mock (the test verifies `start()` waits for it) and the multi-step `setTimeout(0)/(5)/(100)` sequence in the `rpc/unbound/close/send-fail branches` test (deeply entangled async chain with no single positive signal).

  The bridge implementation is not modified. Coverage stays at 100/100/100 lines/functions/statements with branches unchanged. realtime-bridge test file drops from ~18.2 s to ~16.2 s (-11%); the whole plugin suite drops by ~2 s.

- 317dbd6: Fix a flaky "post-upgrade health verification" failure where `pollUpgradeHealth` would occasionally report `ok: false` after just one attempt with a tiny duration, even though the upgrade had succeeded. Root cause: the polling loop measured elapsed time with `Date.now()` (wall clock), so any forward jump of the system clock during the loop — NTP step adjustment, host suspend/resume, WSL2 vmtime sync, container time domain change — would make the loop think the total timeout had been exceeded and break out after the first attempt. Switched the loop's elapsed-time calculation to a monotonic clock based on `process.hrtime.bigint()`, which is guaranteed wall-clock-independent on Linux/macOS/Windows. The reported `elapsedMs` field stays integer milliseconds with the same units as before. Beyond fixing the test flake, this also closes a real production bug where a wall-clock jump during the 5-minute health-check window would falsely roll back a successful upgrade. Added a regression test that monkey-patches `Date.now` to jump forward and confirms the function still completes correctly.

## 0.20.1

> Released as a patch (special case): the auto-upgrade ledger fix is the only runtime-behaviour change shipped to users in this cycle. The FBQ swap recorded under `Minor Changes` was rolled back to `MemoryQueue` in the same release, so the net production queue impl is unchanged from 0.20.0. FBQ will become the default again only when a future release flips `RPC_QUEUE_IMPL` back to `'fbq'`.

### Minor Changes

- 6cd7f1c: Swap the per-session WebRTC RPC send queue from `MemoryQueue` to `FileBackedQueue` (B-stage2 B9b). Selection is gated by a single module-level constant `RPC_QUEUE_IMPL` in `webrtc-peer.js`; the default is `'fbq'`, and `'mem'` remains a one-line revert path for dev / test / emergency rollback.

  When the queue dir is unavailable (the bridge's startup `cleanupResiduals` / `measureDiskCap` prep failed), the assembly automatically falls back to `MemoryQueue` for that session — the `'fbq'` path never blocks `webrtc` setup. Each FBQ session id is suffixed with `${Date.now()}-<uuid8>` so concurrent same-`connId` rebuilds (e.g. ICE restart failure → new offer landing during the previous instance's `await destroy`) target physically different `*.jsonl` files and never race on disk IO. Startup `cleanupResiduals` already whitelists `*.jsonl`, so suffixed leftovers are reclaimed at next start.

  Each session's chosen impl is logged locally (`info`) and pushed via `remoteLog` (`rtc.queue-impl conn=… impl=fbq|mem [fallback=queue-dir-null]`) once on assembly so operators can see the actual runtime behaviour, including silent fallbacks. The four queue cleanup sites in `WebRtcPeer` are unchanged thanks to B6/B7/B8 already aligning the FBQ contract.

### Patch Changes

- 728f824: Fix auto-upgrade detection on OpenClaw 2026.4.25+ hosts. The host now strips
  `plugins.installs` from `loadConfig()` and persists the source-of-truth in a
  managed ledger at `<state-dir>/plugins/installs.json`, so the previous
  `loadConfig().plugins.installs[pluginId]` lookup always saw `undefined` —
  `shouldSkipAutoUpgrade` returned `true` on every check and the scheduler never
  spawned the upgrade worker. The plugin now reads the install record from the
  new ledger first and only falls back to the legacy `plugins.installs` field
  when the ledger file is absent (ENOENT), keeping compatibility with hosts
  ≤ 2026.4.24. Read-side errors other than ENOENT (permissions / corrupt JSON /
  missing pluginId) are treated as "no install info" rather than falling back,
  to avoid misclassifying a freshly-migrated host. These error paths now emit
  `remoteLog` diagnostics (`upgrade.ledger-read-failed`,
  `upgrade.ledger-parse-failed`, `upgrade.state-dir-failed`) so a corrupted or
  unreadable ledger surfaces a triageable signal instead of a silent
  "Skipping: not an npm-installed plugin" message.
- eab42c5: Centralize OpenClaw runtime config access behind a single host-adapter helper
  (`getClawConfig` in `src/claw-config.js`) and prefer the new `config.current()`
  API over the deprecated `config.loadConfig()`. OpenClaw v2026.4.27+ ships the
  new accessor and emits a one-time `runtime-config-load-write` deprecation
  warning the first time `loadConfig()` is called; both APIs return the same
  `getRuntimeConfig()` snapshot, so the switch is purely about avoiding the
  warning while staying
  compatible with hosts ≤ v2026.4.26 (which only have `loadConfig`). Two
  callsites — gateway auth-token resolution and the legacy install-record
  fallback in auto-upgrade — now go through the helper instead of touching
  `runtime.config` directly, so future host-API churn lands in one place.
- ffde43c: Fold the rpc DC send queue design docs into a B-stage2-complete shape. `rpc-dc-send-queue.md` no longer reads "FBQ swap pending" — the pipeline diagram now treats the queue slot as an abstract `Queue` filled by `FileBackedQueue` (default) or `MemoryQueue` (degraded / emergency revert), and a new "queue impl selection" section explains the dual-layer guard (module-level constant + runtime queueDir-availability check), the assembly-time `rtc.queue-impl` log convention, and why `MemoryQueue` is intentionally kept as an interface-mirror reference instead of being deleted. A new "race handling overview" section catalogs the two queue races the design has accumulated (plan-1's `monitor.summarize` vs in-flight enqueue, B-stage2's same-connId destroy/init file collision) and points to where each is solved.

  `rpc-dc-file-queue.md` switches from a Stage-2 design proposal to the FBQ-as-default-production-path reference. A new "interface red-lines" section anchors the seven cross-implementation invariants both queue implementations must respect (business-agnostic container, loud-on-loss + destroyed-silent, bypass exempts capacity layer only, agent-run predicate not extended to lifecycle:end, sync-only destroy hook, deps-injected diskCap, FBQ-side same-connId unique-suffix isolation). A new "same-connId race isolation design" section records why option A (unique filename suffix) was chosen over the per-connId mutex / pendingClose Map alternatives. A new "queueDir unavailable degradation" section explains the assemble-never-blocked invariant. The integration-layer test list switches from "B-stage2 待实施" markers to "✅ 已实施" with concrete test-file pointers. A new "evolution history" appendix records each phase's motivation (RpcSendQueue → plan-1 monitor extraction → plan-2 startup prep → B-stage2 single-point swap) and the explicit design trade-offs taken (race handling, MemoryQueue retention, diskCap injection, sync hook contract, predicate scope).

  No code changes — design docs only.

- 099f430: Add `bypassAdmission` option to `FileBackedQueue`, mirroring `MemoryQueue` semantics: callers may inject a predicate that exempts whitelisted messages from the `diskCap` admission check. Capacity-layer exemption only — physical IO failures (`fsBroken`) still drop with `'fs-error'`, even for whitelisted messages. The predicate is invoked under try/catch; an exception is treated as non-bypass (conservative drop). Non-function values are coerced to no-op for backward compatibility. Prepares the queue for B-stage2 swap into the WebRTC RPC send path so agent-run responses can survive sustained backpressure that would otherwise hit `diskCap`.
- 4de117a: Add optional synchronous `onBeforeClear` hook to `FileBackedQueue.destroy`, mirroring `MemoryQueue.destroy`. The hook fires inside the destroy mutex — after `destroyed = true` but before stream close / file removal / state reset — and receives an atomic 6-field residual snapshot (`memCount`, `memBytes`, `diskBytes`, `writtenBytes`, `spilled`, `fsBroken`) reflecting the real disk state. In-flight enqueues that won the mutex race ahead of destroy are reflected in the snapshot; enqueues that queue up behind destroy short-circuit on `destroyed = true` and return false (silent drop). Synchronous throws inside the callback are swallowed; if the callback returns a Promise, its rejection is unhandled (not awaited) — by design, matching the MemoryQueue contract: callers must pass a synchronous function. Lets `WebRtcPeer` keep its 4 `destroy((residual) => monitor.summarize(residual))` call sites unchanged after the B-stage2 swap to FBQ.
- 8898c54: Pass underlying error through `FileBackedQueue.onDrop` for `'fs-error'` drops. `__handleFsError` now caches the error in `this.lastFsErr`; subsequent enqueues that hit the sticky `fsBroken` short-circuit forward the cached error to `onDrop(reason, size, err?)` so the drop monitor (and operators) see the actual errno / message instead of an opaque drop. `clear()` and `destroy()` reset `lastFsErr`. Non-`fs-error` drops (e.g. `'disk-cap'`) still pass `undefined` for the third arg, matching the existing monitor contract from plan-1 round-2.
- a776d0a: Harden B-stage2 after deep-review. The B9b cut from `MemoryQueue` to `FileBackedQueue` accidentally dropped the `maxMessageBytes: MAX_SINGLE_MSG_BYTES` admission that `MemoryQueue` had been enforcing — single frames > 50 MB could enter the FBQ backlog and only get rejected later inside `RpcDcSender` (with `MESSAGE_OVERSIZED`), bypassing the `onDrop('oversize', size)` loud-on-loss accounting that the rpc-drop-monitor relies on, and letting `bypassAdmission` whitelist traffic skip even the `diskCap` ceiling.

  `FileBackedQueue` now mirrors `MemoryQueue` exactly: optional `maxMessageBytes` constructor option (default `Infinity`), validated as `Infinity` or finite positive, enforced before the disk-cap admission and before the bypass predicate (so whitelisted messages do **not** escape the per-message hard cap, matching red-line 3). The webrtc-peer assembly site explicitly passes `maxMessageBytes: MAX_SINGLE_MSG_BYTES` to FBQ so the FBQ path now drops oversize frames at enqueue time with `reason: 'oversize'`, just like the legacy `MemoryQueue` path.

  Three smaller follow-throughs from the same review pass:

  - The `rpc queue impl=…` info log + `rtc.queue-impl` remoteLog now fire **after** the stale-identity guard, so stale assemblies that destroy and exit do not emit a misleading "fbq" line.
  - `__setupDataChannel`'s opening comment and the FBQ `__handleFsError` inner `catch` binding (`rmErr`) are updated so they no longer reference the old `MemoryQueue`-only world / shadow the outer `err` parameter.
  - B9b's default-fbq and mem-fallback tests now assert on the actual `diskCap` / `memBudget` / `maxMessageBytes` values, so a wiring mistake at the assembly site is detectable.

  Also records a PRE-EXISTING TODO entry (`sendPeerTransport sig` rollback has no re-trigger) caught during the review — the race exists since plan-1 round-2 introduced async `MemoryQueue.init()`, but the FBQ swap stretches the window from microsecond-level to tens-of-milliseconds, making the bug far easier to hit. Diagnostic-only impact (peer-transport candidate info missing in the UI), not RPC business; deferred out-of-scope.

- 3e274a7: Roll back the rpc DC send queue default from `FileBackedQueue` (FBQ) back to `MemoryQueue` for the next emergency npm release. The B-stage2 swap (B9b) made FBQ the production default, but FBQ has not been validated end-to-end in real-world deployments — and an unrelated OpenClaw upgrade has broken auto-upgrade, so we need to ship a release fast without also shipping an under-tested queue change. The module-level constant `RPC_QUEUE_IMPL` in `src/webrtc/webrtc-peer.js` now reads `'mem'` instead of `'fbq'`; flipping it back to `'fbq'` is the one-line revert path the design always called out.

  To preserve coverage of the FBQ assembly path (so we can flip back safely later), `WebRtcPeer` now accepts an optional `rpcQueueImpl: 'fbq' | 'mem'` constructor option. Production code does not pass it (so the module default applies); tests that need to exercise the FBQ branch (`rpc DC 装配走 FBQ 路径` / `同 connId 重建 race 隔离` / `queueDir 为 null 时降级到 MemoryQueue`) explicitly pass `rpcQueueImpl: 'fbq'`. Invalid values (anything other than the two literal strings) silently fall back to the module default. A new test pins the production-default invariant: when `rpcQueueImpl` is omitted, the queue is `MemoryQueue` even when `queueDir` is provided, and the assembly log emits `impl=mem` without the `fallback=` suffix.

  Docs (`rpc-dc-send-queue.md`, `rpc-dc-file-queue.md`) updated to reflect the temporary `'mem'` default — the FBQ design and assembly path stay documented as the long-term direction, just gated on more validation. No bridge or queue-module changes; the FBQ infrastructure (cleanupResiduals, measureDiskCap, `__queueDir`, `__diskCap`) keeps running at startup so re-enabling FBQ remains a one-line flip.

- 8b63de7: Plumbing for B-stage2 FBQ swap: `WebRtcPeer` constructor accepts a `getDiskCap` function dep and stores it as `__getDiskCap` (non-functions coerce to `null` for backward compat). `RealtimeBridge.__initWebrtcPeer` wires `() => this.__diskCap` into the constructor — bridge measured the disk cap once at startup (Phase B-stage1 plan-2), and B9b will read it via this getter when it instantiates `FileBackedQueue` per session. The getter is stored only; nothing consumes it yet, so behavior is unchanged.

## 0.20.0

### Minor Changes

- c77160f: Unify OpenClaw state directory and session path resolution through a new `src/claw-paths.js` module that delegates to the gateway-injected runtime API instead of hardcoding `~/.openclaw`. Fixes a longstanding correctness bug where `topic-manager`, `chat-history-manager`, and `session-manager` defaulted to `os.homedir() + '.openclaw/agents'` regardless of the actual gateway state directory — under system-level installs, custom `OPENCLAW_STATE_DIR`, profile-based deployments, or containerized state mounts, topics and chat history were silently written to an orphan location and the OpenClaw session index could not be found at all.

  `claw-paths.js` exports `clawStateDir`, `pluginDir`, `agentSessionsDir`, `sessionStorePath`, and `sessionTranscriptPath`. `clawStateDir` directly trusts `runtime.state.resolveStateDir()` (stable since 2026-02-19) and throws when runtime is not injected — bugs in plugin lifecycle now surface immediately instead of writing to the wrong directory. The session-related helpers prefer `runtime.agent.session.resolveStorePath` / `resolveSessionFilePath` (added 2026-03-16) and fall back to the long-stable `<state-dir>/agents/<agentId>/sessions/...` layout for users on slightly older OpenClaw versions. We deliberately call the helpers without an agent-specific `store` override or sessions-index `entry`, so the plugin always targets OpenClaw's default per-agent sessions layout; honoring user-configured `agents.<id>.store` overrides or persisted `sessionFile` rewrites is left as a follow-up.

  Migrates `config.js`, `device-identity.js`, `settings.js`, and `realtime-bridge.js` (rpc-queues path) to consume `pluginDir` from `claw-paths.js`, removing several duplicated `~/.openclaw` defaults: the per-module `resolveStateDir` copies in `config.js` and `device-identity.js`, the inline `~/.openclaw/openclaw.json` fallback in `realtime-bridge.js`'s gateway-token reader, and the `os.homedir() + '.openclaw/agents'` default that the three managers used to fall back on. The auto-upgrade state module is intentionally kept on its own dual-track resolver because the worker subprocess has no runtime injection and must read `OPENCLAW_STATE_DIR` from env; a comment marks it as the sole exception.

  Adds `package.json#openclaw.install.minHostVersion: ">=2026.2.19"`, the date `runtime.state.resolveStateDir` first became available on the plugin runtime — OpenClaw's plugin installer reads this exact field (`install.minHostVersion`, semver floor in `">=x.y.z"` form) to gate installation, so older hosts will refuse to install this plugin instead of installing it and crashing on the first state-dir lookup. `CLAUDE.md` gains hard constraints prohibiting `os.homedir() + '.openclaw'` hardcoding, direct `@openclaw/plugin-sdk/state-paths` imports in plugin code, and reading `OPENCLAW_STATE_DIR` from the gateway main process; the auto-upgrade exception is documented in place.

  The three managers no longer accept `rootDir` constructor options. They now accept narrower `resolveSessionsDir` / `resolveStorePath` / `resolveTranscriptPath` injection points instead, used by tests to drive isolated tmpdirs without a runtime mock. `index.js` instantiates them with only a logger.

### Patch Changes

- 89cff0d: Strip diagnostics responsibility from `MemoryQueue` (`src/utils/memory-queue.js`). Remove the internal overflow edge state machine (`droppedCount`/`droppedBytes`/`queueOverflowActive` fields, `overflow-start`/`overflow-end` warn/info/remoteLog), the `destroy`-time close summary remoteLog, the `oversize` per-call warn, and the `__safeRemoteLog`/`__safeInfo` helpers. `stats()` now returns only six FBQ-aligned fields (`memCount`/`memBytes`/`diskBytes`/`writtenBytes`/`spilled`/`fsBroken`) — no `droppedCount`/`droppedBytes`/`queueOverflowActive`. The container is now purely business-agnostic: drop events are surfaced exclusively via the existing `onDrop(reason, size)` callback, and consumers (e.g. the new `rpc-drop-monitor`) own all logging, accumulation and close summary. Behavior outside diagnostics is unchanged: admission rules, bypassAdmission whitelist, maxMessageBytes hard cap, the iterator and the lazy compaction all remain bit-for-bit identical. WebRtcPeer's dump output and `closeByConnId` close summary will be reconnected through the monitor in the next commit; in the meantime three webrtc-peer tests temporarily fail until that wiring lands.
- 9a1e1cd: Introduce `rpc-drop-monitor` factory module (`src/webrtc/rpc-drop-monitor.js`) carrying the rpc DC drop diagnostics responsibility outside of the queue container. The module accepts `onDrop(reason, size, err?)` events and produces edge-state warn/info/remoteLog (overflow-start/overflow-end/disk-cap-start/fs-broken/oversize/close), accumulates dropCount/dropBytes counters, and emits a close summary via `summarize(residualStats?)`. `maybeEmitOverflowEnd` debounces the active→inactive transition until both the in-memory and on-disk buffers are drained (candidate-A debouncing). All logger and remoteLog calls are defensively wrapped, so userland callbacks throwing cannot poison the producer. This is the first step of B-stage1 toward decoupling diagnostics from the queue container; subsequent commits will slim `MemoryQueue` and wire the monitor into `WebRtcPeer` session lifecycle. Behavior unchanged at runtime — module not yet referenced by any consumer.
- 8cfc6ed: Round-2 hardening of rpc-drop-monitor wiring after multi-dimensional deep review:

  - **Race fix between in-flight broadcast and DC close**: `MemoryQueue.destroy()` now accepts an optional synchronous `onBeforeClear(residual)` callback that fires inside the mutex, immediately before the in-memory queue is cleared. `WebRtcPeer` (`closeByConnId`, `dc.onclose`, `setupDataChannel` rebuild cleanup, consume-loop finally) drives `monitor.summarize` through this callback so the residual snapshot reflects every enqueue that arrived in the same tick — including in-flight `broadcast()` calls whose mutex-queued enqueue had not yet executed when `dc.onclose` fired. Previously the synchronous `queue.stats()` read happened before the in-flight enqueue could land, undercounting the residual.
  - **`rpc-queue.close` log gains residual disk tokens**: the close summary now appends `residualDiskBytes` and `residualWrittenBytes` between the existing memory residual tokens and `fsBroken`/`lastReason`. On `MemoryQueue` they stay zero; on the upcoming `FileBackedQueue` they will surface disk-side residual data without further wiring changes. `monitor.summarize` `hasAnomaly` decision now also considers these two fields, so a session ending with disk-only residual still emits a close log.
  - **`maybeEmitOverflowEnd` null-stat guard**: the helper now returns early if `stats` is null/undefined, preventing a TypeError if a future caller forgets to pass `queue.stats()`.
  - **WebRtcPeer outer try/catch removed**: now that `monitor` internals defensively wrap every logger/remoteLog call and the new `destroy` callback contract is synchronous, the outer `try { monitor.X() } catch {}` wrappers in the four cleanup paths are gone — keeping a single defensive line inside the monitor instead of two redundant ones, and clearing the dead-branch noise from coverage reports.
  - **JSDoc + monitor module header refreshed** to describe the new close-log token order and document `onBeforeClear` as strictly synchronous.

  No public-facing behavior change beyond the additive close-log tokens (operator greps on the existing tokens still match). Tests added: `MemoryQueue.destroy(callback)` covers the in-flight snapshot, callback-throw-swallowed, idempotency, and residual-zero paths; `rpc-drop-monitor` covers `oversize`-only `dropCount` summarize, residual-disk-only summarize, and stats-null guards; `WebRtcPeer` race-fix test asserts the `dc.onclose` snapshot sees an in-flight broadcast.

- d45ea1a: Prep `rpc-queues/` startup hook on bridge start. Once per start the bridge now (1) creates `~/.openclaw/coclaw/rpc-queues/` and removes any `*.jsonl` residuals from prior runs, and (2) probes available disk via `fs.statfs` to derive a `diskCap` value (`min(1GB, max(64MB, free × 50%))`) which is stored on the bridge instance. The value is **not yet consumed** — B-stage2 will inject it when the FileBackedQueue replaces MemoryQueue. Cleanup is whitelisted to `*.jsonl` files only and never recursive. `fs.statfs` requires Node 18.15+; older runtimes non-fatally fall back to a fixed 1GB cap (a single warning is logged via the injected logger). Runtime behavior of the MemoryQueue path is unchanged.
- 89737cc: Harden `rpc-queues/` startup prep on bridge.start after deep-review:

  - Wrap the prep block (`resolveStateDir() → cleanup → measure`) in a try/catch. If `resolveStateDir()` throws synchronously (e.g. a runtime-injected resolver fails), the bridge logs a single warning, leaves `__diskCap` as `null`, and continues startup instead of rejecting `bridge.start()`.
  - Re-check `this.started` immediately after the prep block. If `stop()` raced during the cleanup/measure awaits, the bridge now exits before invoking the WebRTC preload (avoiding an unnecessary native subprocess spawn).
  - `cleanupResiduals()` defends against non-string `readdir` entries (e.g. `Buffer` / `Dirent` returned by an unusual `fsOps` injection) by warning and skipping rather than throwing — keeping the "module never throws" contract.
  - Integration tests now clean up their tmp state-dir in `finally`, the default-path test asserts `bridge.__diskCap` is a positive number, and two new tests cover the prep-failure path and the cleanup/measure stop() race.

- aefaf2a: Harden `rpc-queue-startup.js` defenses surfaced by the combined plan-1+plan-2 deep review:

  - `measureDiskCap` now falls back to the fixed 1GB cap whenever `fs.statfs` returns non-finite fields (NaN/undefined `bavail` or `bsize`, missing fields) or negative `free`. Without this, `Number(NaN) * Number(_)` is `NaN` and the value would propagate through the `min/max/floor` chain and store `NaN` on `bridge.__diskCap`. Real production environments (containers, network mounts, exotic filesystems) occasionally surface such fields. A single warn (`rpc-queues statfs failed (non-finite, fallback 1GB): bavail=X bsize=Y`) is logged via the injected logger.
  - `cleanupResiduals` pulls `nodePath.join` inside the same `try/catch` that wraps `unlink`. The "module never throws" contract was technically violated when `dir` was non-string (production paths always pass a string from `nodePath.join` upstream, but the defensive layer keeps the contract honest under future refactors and unusual `fsOps` injections).

  Both fixes are paired with new edge-case tests (non-finite statfs fields, negative free, non-string dir over five shapes). Two orthogonal coverage gaps from the same review pass are also closed: multi-connId `rpc-drop-monitor` isolation (mobile 5-8 concurrent DC overflow scenario — three monitors must keep their `dropCount`/`dropBytes`, warn lines, remoteLog and close-summary streams independent) and `MemoryQueue` destroy/enqueue mutex race (`destroy` enqueued first into the mutex queue must run its `onBeforeClear` then set `destroyed=true`; the pending `enqueue`, when it acquires the mutex, sees `destroyed=true` and returns `false` silently). `MemoryQueue.enqueue`'s JSDoc now explicitly documents that the destroyed short-circuit is silent by design — no `onDrop` is fired — which is distinct from the loud-on-loss contract that governs live-connection drops (`oversize` / `queue-full`).

  Coverage stays at the same 100/96.43/100/100 baseline. No public API or runtime behavior change beyond the additive defensive warn lines.

- e22dd01: Add diagnostic logs around the rpc-routing tables in `realtime-bridge.js` for local verification of the recently-introduced unicast paths. Five permanent `debug` lines tag routing-table mutations: `[coclaw/run-event-route] add` / `[coclaw/run-event-route] remove` (runId → connId table) and `[coclaw/rpc-res-route] add` / `[coclaw/rpc-res-route] remove reason=final-res` / `[coclaw/rpc-res-route] remove reason=send-failed` (reqId → connId table) — kept at debug level since add/remove fires on every UI RPC and would be too noisy at info on a busy gateway. Four additional `debug` lines (each preceded by `/* c8 ignore next -- TODO: 2026-05-20 后删除 */`) report hit/miss outcomes for both tables in the form `hit, <id>=X → connId=Y` and `miss, broadcast, <id>=X` to confirm unicast vs. broadcast-fallback behavior in dev. The c8-ignore guard means the temporary lines can be deleted on the cleanup date without touching tests or affecting coverage. The `event:agent` block keeps its original shape (no extra `else` branch added for log purposes); the no-runId case is folded into the same miss log via `runId=${runId ?? '<missing>'}`. The SEND_FAILED catch path's remove log is guarded by Map.delete's boolean return value, so orphan "remove" lines (broadcast-fallback path with no prior add) are suppressed. All log tags follow the project `[coclaw/<module>]` namespacing convention. No behavior change beyond the added log calls.
- 05e24ce: Route gateway-pushed `event:agent` frames by runId to the originating data channel instead of broadcasting to every rpc DC. Adds `RunEventRoutes` class (`src/rpc-routing/run-event-routes.js`) — a runId → connId routing table with a 24h TTL and 1h scan, exposing `add(runId, connId, reqId)` / `remove(runId, reqId)` / `lookup(runId)` / `clear()` / `init()` / `destroy()`. Write strategy is "first-writer-wins": same reqId only refreshes `expireAt` while connId is locked to the original; different reqId is debug-logged and skipped, defending against `agent.wait` attach stealing the route. Delete requires `entry.reqId === input reqId` to avoid cross-RPC misdeletion (e.g. `chat.send` res frames carrying an unrelated runId). The 1h scan timer is `unref()`-d and try/catch wrapped so callback throws cannot crash the gateway process. `realtime-bridge.js` integrates the table at five points: lazy instantiation in `start()` (so the real logger is captured), table maintenance inside the existing reqId unicast branch (add on `accepted`, remove on non-accepted), a new agent-event unicast branch before the broadcast fallback (lookup → sendTo, hit always returns; sendTo failure drops without logging — PC-state-change logs already cover that signal), `clear()` on gateway WS close (both manual and event-driven), and `destroy()` plus null-out in `stop()`. Miss / non-agent event / missing runId still falls through to the broadcast path. Eliminates the multi-PC bug where agent events for one run reached every connected DC including dead ones.
- 7eddbcc: Wire `createRpcDropMonitor` into `WebRtcPeer` session lifecycle. Each rpc DC session now owns a dedicated drop monitor (`session.rpcDropMonitor`) created before the `MemoryQueue` so the queue's `onDrop` callback delegates straight to the monitor. The consume loop calls `monitor.maybeEmitOverflowEnd(queue.stats())` after every successful send so the active-to-inactive transition is debounced once both the in-memory and on-disk buffers (the latter is constant zero on `MemoryQueue`) are drained. Three tear-down paths — `dc.onclose`, `closeByConnId`, and the consume-loop `finally` — now invoke `monitor.summarize(queue.stats())` before `queue.destroy()`, capturing the residual snapshot while the queue still has data; the monitor's idempotent `summarized` flag absorbs the inevitable double-call between `dc.onclose` and the loop finally. `__dumpSessionState` keeps the historical eight-token output byte-for-byte: the `dropped`/`droppedBytes` tokens are now sourced from `monitor.getStats()` (`dropCount`/`dropBytes` underlying fields) and the six FBQ-aligned fields from `queue.stats()`. The stale-init path (queue.init blocked, `closeByConnId` mid-init) deliberately does not attach the monitor to the session, so a never-used monitor is GC'd without emitting a noisy close summary. Operator-visible dump and `rpc-queue.close` log formats are preserved; `overflow-start` payload now carries the rejected-message size instead of the queue depth (single intentional drift documented in the rpc-drop-monitor commit).

## 0.19.2

### Patch Changes

- 7070229: Add `activation.onStartup: true` to the plugin manifest so the gateway includes us in its startup plan. New OpenClaw versions filter the startup plugin set to those that declare an explicit activation path (`onStartup`, manifest channels matching configured channels, `onConfigPaths`, memory/agent-harness binding, etc.). Since CoClaw bindings are stored externally and the manifest no longer declares channels (commit b7afd1e), our plugin matched none of these paths and was silently skipped — `register()` was never invoked, so neither the realtime bridge nor any `coclaw.*` gateway method came up.

## 0.19.1

### Patch Changes

- 0eb56f4: Expand `__dumpSessionState` queue diagnostics in webrtc-peer to surface six `MemoryQueue.stats()` fields (`memCount`/`memBytes`/`diskBytes`/`writtenBytes`/`spilled`/`fsBroken`) alongside the existing `droppedCount`/`droppedBytes`. The historical `queueLen` token is preserved as the `memCount` rendering; the four disk-related fields are constant zero/false on top of `MemoryQueue` and reserve the dump shape for the upcoming `FileBackedQueue` swap, when they will start carrying real values without requiring downstream parser changes.
- af9b6e6: Tighten rpc DataChannel setup timing in webrtc-peer: `__setupDataChannel` is now async, awaits `queue.init()` before assigning the session triplet (queue/sender/consumeLoop), and re-checks identity (session still in map and `rpcChannel` still this dc) so concurrent `closeByConnId` or same-connId rebuilds during the init window cannot leave half-wired state. Same-connId rebuild also awaits the old `queue.destroy()` before constructing the new one. DC handlers (reassembler / onopen / onclose / onerror / onmessage) remain wired in the synchronous prologue so external code can dispatch dc events immediately. Behavior preserved with `MemoryQueue` (init is a no-op); the await + identity guard reserve the contract for the upcoming `FileBackedQueue` swap.

## 0.19.0

### Minor Changes

- e0b4212: Add gone-fallback heuristic to `coclaw.agent.abort`:

  - Accept new request fields `runDuration` and `abortDuration` (both ms, wall-clock) from UI.
  - When the side-door abort returns `not-found` and both gates are met (`runDuration >= 3min` AND `abortDuration >= 1min`), upgrade the response to `{ ok: false, reason: 'gone' }` so the UI can settle the cancel coordination instead of ticking forever.
  - Old UIs that omit the duration fields keep getting `not-found` (no behavior change, full backward compatibility).
  - Emit `abort.gone sid=… runDur=… abortDur=…` remoteLog on each upgrade as an early signal to monitor heuristic accuracy.

  The pure decision logic lives in the new `src/agent-cancel-heuristic.js` (thresholds exported as constants for tuning).

### Patch Changes

- bac081b: Fix: switch auto-upgrade `writeState` / `trimLog` / `writeUpgradeLock` to `atomicWriteFile` (tmp + rename). The previous bare `fs.writeFile` could leave `upgrade-state.json`, `upgrade-log.jsonl`, or `upgrade.lock` in a half-written / truncated state if the process crashed mid-syscall, which violates the project's hard rule against bare `fs.writeFile` for plugin-managed files. With atomic writes, a write failure leaves the original file untouched.
- f7363e2: Fix: `bindClaw` rolls back the server-side claw via `unbindServer` when local `writeCfg` fails after the server has already issued a token, mirroring unbind's strict-no-tolerance contract. The original `writeCfg` error is rethrown wrapped with code `BIND_LOCAL_WRITE_FAILED`. If rollback also fails, do not mask the root cause — server-side leftovers can still be cleaned up by the next enroll/bind via 401/404/410.
- bd6dd61: Fix: `coclaw.bind` and `coclaw.unbind` proactively cancel any in-flight enroll on entry, so that a late-arriving token from the old enroll cannot pollute local config after the new bind/unbind completes. Extract a shared `cancelActiveEnroll` helper used by the enroll RPC, the slash command, and bind/unbind paths.
- f983017: Fix: wrap gateway WebSocket message listener in a top-level try/catch (via IIFE + .catch) so an exception thrown during async paths (await sendTo, settle, broadcast, etc.) cannot escape as `unhandledRejection` and crash the gateway process. Previously only `JSON.parse` was guarded; any future or upstream-injected throw past that point would leak.
- c3f7a8b: Fix: dc-chunking receiver now caps incoming string frames by `Buffer.byteLength(data, 'utf8')` rather than `data.length`. The original check counted UTF-16 code units, so multi-byte characters (CJK, emoji) were under-counted by ~3x — a payload could occupy ~150MB of bytes and still pass the 50MB limit.
- 796ab85: Fix: add three edge defenses to dc-chunking. (1) Receiver rejects unknown flag bytes (non BEGIN/MIDDLE/END) so malformed frames cannot pollute the pending entry of the same msgId. (2) Receiver caps string frame length at 50MB to align with sender-side `MAX_REASSEMBLY_BYTES` and stop a peer from bypassing the cap. (3) `buildChunks` throws early when the math would produce more than `MAX_CHUNKS_PER_MSG` (10000) chunks, since under a tiny `maxMessageSize` the receiver would reject the trailing chunk and the message could never be reassembled.
- c545128: Fix: `__handleGatewayRequestFromDc` validates `id` and `method` are non-empty strings before forwarding to gateway. Previously a malicious or misconfigured peer sending `{ "type": "req", "params": {...} }` (missing fields) would forward `id: undefined / method: undefined` to gateway and pollute the RPC protocol. Now drop+warn when fields are missing; if `id` is valid but `method` is missing, reply with an `INVALID_REQUEST` frame so the peer stops waiting.
- 4120b02: Fix: rpc DC reassembler callback adds an `sess.rpcChannel === dc` identity guard before the branch dispatch, mirroring the guard already on `dc.onclose`. Without it, a stale message event from a torn-down DC could still be in the microtask queue after rebuild, enter `__onRequest` or `__onFileRpc`, and inject the old request into the new session — polluting connId-reuse scenarios.
- 13f4c55: Fix: `loadOrCreateDeviceIdentity` switches to the new `atomicWriteFileSync` instead of bare `fs.writeFileSync`. A crash mid-write could previously truncate `device-identity.json`; on next startup the parse would fail and a fresh deviceId would be regenerated, invalidating all existing device bindings. The new sync atomic helper follows the standard tmp + rename + finally cleanup pattern.
- df7ec73: Fix: `waitForClaimAndSave` re-checks the abort signal after `waitClaimCode` returns BOUND data and before writing local config; if aborted, roll back the server-side token (same partial-failure pattern as the D-stage fix) and throw `enroll cancelled`. Previously abort was only checked at the loop top, so an abort that arrived during the long-poll await alongside a token would persist the now-orphaned token to local config and pollute concurrent new-enroll state.
- b85f61c: Fix: `waitForClaimAndSave` treats server `408 + CLAIM_TIMEOUT` as a terminal expired state and throws `claim code expired` immediately. Previously every non-404 error (including the server's own 408 expiration response) was treated as transient and retried, so a background enroll would keep polling every 2s after the claim code was permanently invalid and never release the `activeEnrollAbort` slot.
- b5b976c: Fix: enroll's `waitForClaimAndSave` now rolls back the server-side token via `unbindServer` when local `writeCfg` fails after the server has issued a token, mirroring the bind path. Reuses the `BIND_LOCAL_WRITE_FAILED` error code.
- e5f8df2: Fix: `coclaw.files.delete` now requires `force` to strictly equal boolean `true`. Previously `if (params?.force)` accepted any truthy value (string `"false"`, number `1`, an object, etc.); a misconfigured client could accidentally trigger non-empty directory recursive deletion.
- f710e31: Fix: gateway WS close handler moves `__clearAllLagProbes` / `gatewayPendingRequests.clear` / `__dcPendingRequests.clear` / reconnect scheduling to after the `this.gatewayWs !== ws` stale guard. All three cleanups touch per-bridge shared state; running them before the guard meant a stale-ws close would wipe the new ws's lag probes, pending RPCs, and DC routes. Per-WS log lines (disconnected / handshake info) stay above the guard since they reference closure-local variables.
- b10ec2e: Fix: gateway WS message handler adds a `this.gatewayWs !== ws` stale guard at the top, mirroring the server sock open/message guards. Without it, late-arriving `connect.challenge` / `res` / `event` frames from a torn-down gateway ws would still write to `this.gatewayConnectReqId` / `this.gatewayReady` / forward responses, polluting the current ws's handshake or RPC routing.
- 6f6e551: Fix: add per-message hard cap to MemoryQueue admission. Previously the 50 MB ceiling was only enforced inside RpcDcSender.send(), so an oversized frame (especially one that hit the bypassAdmission whitelist) could be enqueued first and only rejected later by the sender — letting `memBytes` balloon while the sender was blocked on backpressure. Now MemoryQueue takes a `maxMessageBytes` option and rejects oversized frames at enqueue time without bypass exemption, mirroring the sender's hard limit. webrtc-peer wires it to `MAX_SINGLE_MSG_BYTES` so the rpc DC pipeline stays bounded end-to-end.
- b864ddc: Fix: harden two edge paths in realtime-bridge. (1) Server socket `open` and `message` listeners get a `serverWs !== sock` guard so a late-arriving open from a stale sock cannot reset the sender / heartbeat after reconnect, and a late-arriving message cannot reset the current sock's heartbeat timeout. (2) `__closeGatewayWs()` calls `__clearAllLagProbes()` synchronously on intentional close, no longer relying on the close-event callback timing — preventing probe leaks during the close-event delay.
- 89f9718: Fix: add pc identity guard to onicecandidate / onicegatheringstatechange / onselectedcandidatepairchange handlers. Same race window as the previously fixed ondatachannel — when a connId is reused, the old PC's queued callback can fire after detach (assigning null to a property does not stop already-dispatched events), polluting the new session with stale data. Most severe is onselectedcandidatepairchange, which produced "old pair data + new connId" mixed log lines and forwarded stale transport info to the UI.
- 1e15d7b: Refactor: split rpc DataChannel send path into `MemoryQueue` (FBQ-API compatible in-memory buffer) + `RpcDcSender` (async blocking sender) + a consume loop. Behavior facing producers (`broadcast` / `sendTo` / files `sendFn`) is unchanged; the structural split makes the upcoming disk-spillover (FileBackedQueue) drop-in. Replaced the old `RpcSendQueue` and aligned admission, drop semantics, and overflow logging with the FBQ contract.

  Stage 1 edge fixes shipped alongside the refactor:

  - `RpcDcSender.__sendOne`: close the BAL-then-close race so a sender that wakes from `bufferedamountlow` finds the dc already `closing`/`closed` rejects with `SENDER_CLOSED` instead of throwing `InvalidStateError`.
  - consumeLoop `finally`: identity-guard `session.rpcQueue === queue` before nulling the triple, so a stale loop from a previous DC instance can't wipe fields owned by the new instance after rebuild.
  - DC rebuild: close the old `{ rpcChannel, rpcQueue, rpcDcSender, rpcConsumeLoop }` triple before installing the new one, and detach PC handlers earlier in `closeByConnId` to avoid handler firings against a torn-down session.
  - `dc.onclose`: identity-guard against stale rebuild events so a delayed close from the previous DC can't null the new instance's fields.
  - `dc.onbufferedamountlow`: bind to the local sender reference captured in closure, not `session.rpcDcSender`, so a rebuild between event registration and event fire doesn't dispatch BAL into the wrong sender.
  - `pc.ondatachannel`: identity-guard against stale connId reuse — a queued ondatachannel from the old PC firing after detach used to install rpc/file channels onto the new session.
  - `pc.onicegatheringstatechange`: detach in `closeByConnId` so the old PC's pending callback can't log against a freshly reused connId.

- 8af8c02: Fix: tighten param validation across several gateway RPC handlers. `nativeui.sessions.get` returns `INVALID_INPUT` for missing/non-string `sessionId` instead of `INTERNAL_ERROR`. `coclaw.topics.update` returns `NOT_FOUND` when the topic doesn't exist instead of `INTERNAL_ERROR`. `coclaw.bind` / `coclaw.unbind` / `coclaw.enroll` validate that `code` and `serverUrl` are strings. Aligns error codes with the OpenClaw gateway protocol contract.
- b494324: Fix: server sock close handler moves `__clearServerHeartbeat` and `__clearConnectTimer` to after the stale guard. Both cleanups touch per-bridge global single-slot state; running them before the guard meant a stale-sock late close event would wipe the new sock's heartbeat / connect timer. The `stop()` path still cleans up correctly since `serverWs` is already set to null and the guard does not block.
- 641fc43: Fix: `coclaw.bind` / `coclaw.unbind` / `coclaw.enroll` now reject empty-string `serverUrl`. Previously only the `typeof === 'string'` check ran; once `""` passed, `serverUrl ?? api.pluginConfig?.serverUrl` did not fall back (because `""` is not nullish), and `unbindClaw`'s `if (baseUrl)` would skip the server-side unbind and clear the local config — producing an orphan bot. The error message also changes from `serverUrl must be a string` to `serverUrl must be a non-empty string`.
- cef3c9d: Fix: bind/unbind/enroll handlers now reject whitespace-only `serverUrl` (e.g. `"   "` or `"\t\n "`) with INVALID_INPUT instead of letting it fall through to `new URL()` and surface as INTERNAL_ERROR. Tighten the existing length check to `.trim().length === 0`.
- 44095e7: Fix: rtc:offer handling now defensively validates `turnCreds.urls`. The original `for of urls` loop threw a TypeError when `urls` was missing and char-iterated when `urls` was a single string (producing malformed iceServers entries) — both broke offer handling or yielded a malformed PC config. After the fix, `urls` must be a string array; otherwise it's skipped with a warn and the PC continues negotiating with host-only candidates.

## 0.18.0

### Minor Changes

- b032f9d: feat(plugin): unicast DC RPC responses to the originating UI

  Plugin now keeps a `reqId → connId` routing table for UI-forwarded DC RPC requests. When the gateway responds, the plugin sends the response only to the originating UI PC instead of broadcasting to all connected PCs. Falls back to broadcast when the mapping is missing (collision, old UI, upstream introducing a new intermediate status, etc.), so no response is ever lost. Includes a 24h TTL and an hourly sweep to clear stale entries; resets the table on gateway WS close.

### Patch Changes

- e1c1949: fix(plugin): drop duplicate `[pion-ipc]` prefix from local logger output

  `pion-node` SDK already prepends `[pion-ipc] ` to every message handed to its logger callback. The plugin was wrapping that string with another `[pion-ipc] ` prefix, producing gateway log lines like `[pion-ipc] [pion-ipc] [stderr] ...`. Forward the SDK message verbatim so each line carries a single prefix.

- c5d0227: fix(plugin): make rpc send queue a total function and correct single-msg cap accounting

  - Catch `buildChunks` exception inside `RpcSendQueue.send` so a malformed peer SDP (`maxMessageSize <= header`) cannot crash the gateway.
  - Compare `MAX_SINGLE_MSG_BYTES` against payload bytes instead of frame bytes (which include 5-byte chunk headers), so a payload at the 50 MB receiver cap is no longer falsely dropped.
  - Wrap all `logger.*` and `remoteLog` calls in safe helpers and validate the input is a string, so `send`/`__drain`/`onBufferedAmountLow` are guaranteed not to throw under any input or downstream-logger fault.
  - Remove the now-redundant `try/catch` around `q.send` in `webrtc-peer.broadcast`/`sendTo`/files `sendFn`, harden the three `JSON.stringify` call sites against cyclic/BigInt payloads, and propagate the `q.send` return value in `sendTo`.

## 0.17.9

### Patch Changes

- 5a2ad33: Whitelist agent-run RPC responses from the rpc-send-queue soft-cap drop.

  When the per-DC outgoing queue reaches the 10MB soft cap, the queue normally drops new messages so it cannot grow without bound. That rule is too coarse for agent-run terminal frames: a dropped phase-2 `agent` response (or any `agent.wait` terminal) leaves the UI watcher with no way to learn the run ended, and the run sticks in the "incomplete + stop button gone" state.

  A frame is now exempt from the soft-cap drop when its top-level `type === 'res'` and `payload.runId` is truthy. The intended targets are the six `agent` / `agent.wait` respond branches (`accepted` / `ok` / `error` / `timeout` / `dedupe` terminal / race terminal). The same condition also catches `chat.send` acks and any other RPC whose response payload happens to carry a top-level `runId` (e.g. `send`/`poll`, `sessions.send`/`steer` which forward `chat.send`'s payload) — the rule is intentionally hardcoded with no per-method allowlist; those incidental responses are small and whitelisting them is harmless. The 50MB single-message hard cap is not exempted (the receiver's reassembly limit — exempting it would only delay an inevitable drop).

  Whitelist passes do not increment `droppedCount` / `droppedBytes`, do not flip `queueOverflowActive`, and do not emit overflow-start logs; they are intentionally silent enqueues that may push `queueBytes` above the soft cap until drained.

## 0.17.8

### Patch Changes

- feat(plugin): add agent run main-thread lag probe

  Observability-only addition. While an `agent` RPC is in-flight, the realtime
  bridge runs an event-loop lag probe every 200 ms and logs a `lag.spike` warn
  whenever the wakeup drift exceeds 100 ms. On phase-2 termination (`status` !==
  `accepted`, or a validation-failure `ok=false`) it emits a `lag.summary` info
  line with attempts, max lag, count of >100 ms ticks, and total over-budget
  milliseconds. The probe is started after the gateway WS send succeeds and
  stopped via the outgoing `res` stream, with a 60 s hard backstop and explicit
  cleanup on WS close, `bridge.stop()`, and `bridge.refresh()`.

  Motivation: upstream OpenClaw has known synchronous work on the gateway main
  thread (see `docs/openclaw-upstream-issues.md`) that occasionally produces
  multi-second send-path stalls. Until those upstream fixes land, this probe
  gives us a continuous, per-run diagnostic signal so we can correlate user
  reports with actual main-thread blockage.

  No product behavior changes. All timer callbacks are wrapped in `try/catch`
  to honor the plugin-process "no global exception fallbacks" rule, and timers
  are `unref()`-ed so the probe never keeps the process alive.

- 2957e15: fix(plugin): preserve string type in rpc send queue to prevent silent drop on UI side

  The plugin-side `RpcSendQueue` previously coerced non-chunked JSON strings into
  `Buffer` when enqueuing under back-pressure (queue non-empty or
  `bufferedAmount >= 1 MB`). On drain, those messages went out as binary frames
  (SCTP PPID 53), but the UI reassembler treats binary frames strictly as chunked
  fragments — the JSON's first byte (`{` = 0x7B) doesn't match BEGIN/MIDDLE/END
  flags, so the frame was silently dropped at the UI. Symptoms: agent runs
  appeared stuck on "task not finished" while the plugin run was still progressing
  in the background, with no `agent.run.*` remote log because UI never registered
  the run.

  The queue now records each item as `{ data, isString, bytes }` and lets
  `dc.send` dispatch the original type at drain time. Strings go out as string
  frames (PPID 51), binary chunks remain binary. Byte accounting is unchanged.

## 0.17.7

### Patch Changes

- d7fdee4: Make `register(api)` registration-mode aware to align with the OpenClaw plugin SDK contract.

  OpenClaw runs a periodic capability scan that calls each plugin's `register(api)` with `api.registrationMode === "discovery"` roughly every 14 seconds. The plugin previously ran every full-mode side effect on each call: instantiating `SessionManager` / `TopicManager` / `ChatHistoryManager` / `AutoUpgradeScheduler`, loading `topics/main.json` and `chat-history/main.json` from disk, calling all `registerService` / `registerGatewayMethod` / `registerCommand` / `api.on` handlers, and overwriting the plugin runtime singleton with the discovery api's empty `{}` runtime.

  Although the upstream `api-builder` replaces most `register*` handlers with no-ops in discovery mode (so listener accumulation, service collisions, and double-registration did not actually occur), the plugin still wasted CPU and disk I/O 6000+ times per day, and the runtime singleton was being clobbered to an empty object on every discovery pass — guarded only by optional-chaining fallbacks at every `getRuntime()` callsite.

  The new entry now branches on `api.registrationMode` matching the upstream `defineChannelPluginEntry` helper:

  - `cli-metadata` → only `api.registerCli(...)` for root command name discovery
  - `discovery` / `setup-only` / `setup-runtime` (defensive) → `api.registerChannel(...)` + `api.registerCli(...)` (both captured by upstream `captured-registration` for capability snapshots)
  - `full` → all side effects (managers, disk loads, services, RPC methods, `api.on`, command handler)

  One intentional deviation from the upstream helper: `setRuntime(api.runtime)` is gated behind `full` only. Upstream's helper invokes `setRuntime?.(api.runtime)` in every non-`cli-metadata` mode, but discovery's empty `{}` runtime should not clobber the live singleton on each capability scan.

## 0.17.6

### Patch Changes

- fa201f2: Throttle rpc DC queue-full drop logs to state transitions only.

  When a UI instance disconnects and ICE fails, the plugin-side rpc DataChannel can stay technically open while its application-layer send queue stays permanently full — `bufferedamountlow` never fires, so `__drain` never runs, and the queue never returns below `MAX_QUEUE_BYTES`. Every subsequent `send()` from gateway then takes the queue-full branch. Previously this branch emitted a `logger.warn('drop reason=queue-full ...')` line on every drop, while only `remoteLog overflow-start` was state-gated. In practice one stuck connection produced 1641 warn lines over 5+ hours, swamping the gateway log.

  Both `logger` and `remoteLog` now fire only on the false→true and true→false transitions of `queueOverflowActive`. Drops while already in overflow are silently counted into `droppedCount` / `droppedBytes`; the cumulative numbers are reported on the next state flip (`overflow-end`, with matching `info` and remoteLog) or on `close()` (existing summary). `single-msg-oversize` drops still warn on every occurrence — they reflect application bugs rather than queue pressure, and aren't gated by `queueOverflowActive`. The 10 MB drop threshold and existing drain semantics are unchanged.

## 0.17.5

### Patch Changes

- cfef3aa: Raise pion-ipc request timeout from 10s to 20s and stream pion-node internal logs to the plugin's local logger in addition to `remoteLog`. Severe events (IPC `request timeout` and `orphan response`) are logged at `error` level locally so operators can spot them immediately during on-host debugging; other messages go to `info`. Also renames the preloader option `startTimeout` to `ipcRequestTimeout` (same value controls both the startup ping and every subsequent IPC request, so the old name was misleading).

  Motivation: a production incident on 0.17.3 surfaced a `dc.send` IPC timeout whose details were only visible server-side via `remoteLog`, making local diagnosis difficult. The longer window provides a safety margin against rare process-wide stalls without changing any IPC semantics.

- a4aa32a: Make stale upgrade-lock cleanup failures observable (local warn + remoteLog upstream).

  Previously every `fs.rm` call that cleaned a stale `upgrade.lock` swallowed errors with `.catch(() => {})`. Since `{ force: true }` already suppresses "file not found", any error reaching the catch is a real system-level failure — permission denied, read-only filesystem, lock path replaced by a directory, etc. Swallowing it was dangerous: if the cleanup failure co-occurs with a `writeUpgradeLock` failure (same underlying fault), the lock file retains the stale (expired) contents forever. Every subsequent hourly scheduler check then re-enters the same "judge as expired → fail to remove → spawn parallel worker" loop, piling up workers that race against each other on the same backup directory and state files. Before this change there was no local warn log and no remote signal, so the issue could only be diagnosed post-mortem.

  Three stale-lock branches (`missing-pid`, `ttl-exceeded`, `pid-dead`) are now routed through a single `removeStaleLock(lockPath, reason, logger)` helper. On success it logs an info line as before; on failure it logs a `warn` with the reason and error message, and emits `upgrade.lock-cleanup-failed reason=<reason> msg=<err>` via `remoteLog` so server-side observability sees it. The helper itself does not throw, so the gateway-stability guarantee of `isUpgradeLocked` is preserved. The `reason` values are short tokens (no spaces) so they work as `key=value` fields in the remote-log wire format and are easy to bucket.

  Incidental fix: the old code emitted `Stale lock removed` before attempting the removal, which meant the log claimed success even when the removal had actually failed. The new helper logs only on actual success.

- 07d1fc7: Add a 110-minute TTL to the auto-upgrade worker lock so the scheduler cannot be permanently blocked.

  The lock (`~/.openclaw/coclaw/upgrade.lock`) previously relied solely on `process.kill(pid, 0)` liveness checks. Two rare-but-real scenarios could leave the lock forever "held": (1) the worker is killed by `SIGKILL` / OOM / power loss and never cleans up; (2) the OS recycles the dead worker's PID to an unrelated long-lived process (e.g. the gateway itself, or a system daemon), so `kill(pid, 0)` keeps succeeding. Under either scenario every subsequent hourly check short-circuits and auto-upgrade stays disabled until someone manually removes the lock file. The recent rollback-timeout widening (worst-case worker run ~36 min) makes the exposure window noticeably larger.

  Fix: `isUpgradeLocked` now treats any lock whose recorded `ts` is older than 110 minutes — or whose `ts` is missing/unparseable — as stale and removes it. No process is killed; we only drop the lock file, because at TTL expiry the owning PID is almost always either already dead (current code path handles it) or has been reassigned to an unrelated process that we must not harm.

  The TTL is ~3× the worst-case worker runtime, so a worker that genuinely runs long does not trip the cleanup. 110 min is deliberately chosen over an even 120 min: the scheduler polls every 60 min, and if the TTL landed on an integer multiple of that interval the lock age would sit right on the "not yet expired" boundary at the Nth poll (due to second-level jitter between lock write and poll), forcing the scheduler to wait an extra full hour until the N+1th poll. 110 min guarantees the 2nd poll after a stuck worker clears the lock. In the vanishingly unlikely event a real worker is still alive past 110 min, the scheduler will launch a parallel worker; any concurrent `plugins update` conflicts surface as install/rollback errors rather than permanent plugin damage — an acceptable price for regaining autonomous recovery. Lock ownership remains with the gateway (scheduler writes/reads/removes); the worker still does not touch the lock, preserving single-owner mental model.

- 5f2c94d: Tighten two leftover edges in the auto-upgrade worker:

  - **Rollback fallback install timeout raised from 120 s to 10 min** (aligned with the forward `plugins update` timeout). The fallback path is only reached when the local backup is missing, so the situation is already anomalous; giving npm download the same budget it has on the upgrade path makes recovery far more likely to actually succeed instead of tripping the timer. Trade-off: the fallback flow uninstalls the plugin before reinstalling the old version, and the final `gateway restart` only fires after install completes. This widens the "uninstalled in `openclaw.json` but old code still live in the gateway process" inconsistency window from ~2 min to ~10 min — accepted as the lesser evil than aborting recovery halfway. Scheduler's hourly check honors the existing PID-keyed `upgrade.lock`, so no concurrent worker is spawned during this window.
  - **Removed the `?? toVersion` fallback** when recording the installed version into `lastUpgrade.to` / `upgrade-log.jsonl`. Under the current `pollUpgradeHealth` contract `result.version` is guaranteed to be a string whenever `result.ok` is true, so the fallback was dead code. Worse, if that contract were ever broken, the fallback would silently paper the break over with the scheduled target version — turning a "verify succeeded without a version" bug into an invisible one. With the fallback gone, such a break would surface as `undefined` in state/logs, which is exactly what we want during diagnosis.

- 378f0da: Auto-upgrade verification now accepts any installed version that is **greater than or equal to** the originally scheduled `toVersion`, not only a strict string match. Also records the **actually installed** version in `upgrade-state.json.lastUpgrade.to` (and `upgrade-log.jsonl`) instead of the scheduled target.

  Motivation: between the moment the scheduler observes `latest=x` on the npm registry and the moment the worker actually runs `openclaw plugins update`, the dist-tag can advance to `x+1`. Under the old strict-equal verification this was reported as "version mismatch", triggering a rollback and permanently skipping `x` — even though the install had succeeded and produced an even newer version. The plugin would be stuck on the prior version until the next manual intervention.

  The worker now uses the same semver comparison as the scheduler (locally duplicated to avoid cross-process imports from the gateway), and reports `version-too-old got=X want>=Y` as the failure reason when the observed version is still older than the target. Documentation in `docs/auto-upgrade.md` has been brought back in sync with the current single-path (upgradeHealth polling) verification flow.

## 0.17.4

### Patch Changes

- 6abcc8e: Harden upgrade worker's post-restart verification. Replace the `openclaw gateway status` polling plus `openclaw plugins list` stdout substring match with a single poll loop on the `coclaw.upgradeHealth` RPC, requiring the returned version to strictly equal `toVersion`. The old check could falsely report success when `plugins update` silently no-op'd (upgradeHealth returned an old version that still satisfied the truthy-only check) and could falsely fail when the CLI table wrapped the plugin id across lines. Poll window extended to 5 minutes to accommodate cold-start delays (AWS probes, ollama detection, plugin bootstrap). On-disk `package.json` version is read for diagnostic logging only and does not gate the decision.

## 0.17.3

### Patch Changes

- cffb8e4: Stop shipping `src/homedir-mock.helper.js` in the published npm tarball. The file is a test-only helper referenced exclusively by `*.test.js` and was leaking into the published package as dead code. Added as an explicit entry alongside the existing `!src/mock-server.helper.js` exclusion. No runtime behavior change.

  Explicit per-file exclusion is intentional — business modules may legitimately use the `.helper.js` suffix in the future, so a broad `!src/**/*.helper.js` glob would risk silently dropping them from the tarball.

- 8fa21ab: Bound plugin→gateway handshake retry with exponential backoff (5s/10s/20s/20s/20s, max 5 retries) and add v3→legacy fallback within the same WebSocket. Fixes log flooding where a persistent handshake failure (e.g., `device signature invalid`) could emit hundreds of `ws.connect-failed` / `ws.disconnected` lines per minute to the CoClaw server, drowning out unrelated diagnostics.

  - On `connect.challenge`, the plugin still sends v3 (with `device` field) by default. If the response is `ok:false` and the error message matches `/signature|device|scope|protocol/i`, the plugin retries once with a legacy (no-device) handshake on the **same WebSocket** — no new connection, no counted failure. The learned legacy preference is cached in memory and used for subsequent WebSockets (reset on plugin/gateway restart).
  - Handshake failures that are not signature/protocol-related — or legacy retries that also fail — close the WebSocket and schedule the next attempt per the backoff table. After 5 retries are exhausted (6 total attempts, ~75s), the bridge enters a terminal `gave-up` state and does not attempt gateway reconnection again until the plugin or gateway restarts.
  - Duplicated `ws.disconnected peer=gateway` log is suppressed when the close was a direct consequence of a just-reported `ws.connect-failed`, collapsing two lines into one per failed attempt. Genuine "connected then dropped" disconnects still log as before.
  - The existing successful-handshake path is byte-identical for modern OpenClaw gateways: no v3 regression.

## 0.17.2

### Patch Changes

- f29dfd6: Add `FileBackedQueue` utility in `src/utils/file-backed-queue.js` — generic string queue with memory-first storage that spills to a JSONL file when the memory budget is exceeded. Internal module only; not yet wired into the plugin.
- b3d3443: Shrink `rtc.dump` file channel summary on disconnect/failed.

  `__dumpSessionState` previously concatenated `<label>=<readyState>` for every tracked file DC (up to the FIFO cap of 20). On long-lived PCs that accumulated many already-closed file transfers, the line grew to ~1KB and was duplicated into remoteLog. The dump now aggregates by `readyState`: closed channels collapse to a single count (`closed:N`), and only non-closed states list their labels (e.g. `open:1(file:abc)`). This keeps the diagnostic value — labels of DCs that failed to close cleanly — while bounding the line size regardless of session age.

- 1ea9523: Cap pion SCTP RTO backoff at 10s and emit SCTP diagnostic samples on disconnect/recovery.

  - Pass `settings: { sctpRtoMax: 10000 }` to the pion PeerConnection so that post-background-wake retransmission backoff is bounded by 10s instead of pion's 60s default. This lets the UI's 15s READY_TIMEOUT window cover the recovery path, fixing the "chat/topic spinner" symptom after long APK backgrounds.
  - Add `__dumpSctpStats` that, on pion-impl sessions, samples `getSctpStats()` and emits a separate `rtc.sctp conn=... state=... cwnd=... srtt=...ms sent=... recv=... mtu=...` remoteLog line alongside `rtc.dump` (or `sctp=none` before the association is up, `error=<msg>` on rejection). Triggers piggyback on the existing `__dumpSessionState` call sites (ICE restart recovery + disconnected/failed), so `cwnd` collapsing to ~1×MTU with flat `bytesSent` is now observable.
  - Both changes are gated by `__impl === 'pion'`; werift fallback is untouched. Bumps `@coclaw/pion-node` to `^0.3.0`.

## 0.17.1

### Patch Changes

- 39cd433: fix(rtc): filter gateway admin-broadcast events from DC forwarding + expand ICE gathering diagnostics

  Two small, complementary changes on the plugin side:

  **Gateway event filter (`realtime-bridge.js`)**

  The bridge currently forwards every `res` / `event` frame from the
  gateway WS to every open rpc DataChannel. Two gateway-maintenance events
  carry no business meaning for WebChat / plugin clients but are pushed
  unconditionally on a timer:

  - `health` — a full state snapshot (~3 KB: channels, every agent,
    recent sessions, stateVersion) broadcast on a 60 s tick and again on
    every client-issued `health` RPC. Intended for the Admin UI
    dashboard.
  - `tick` — gateway WS keepalive, emitted every 30 s. The DC side
    already has its own transport probe (`probe` / `plugin-probe`) so
    the UI does not need it, and it is piggy-backed through the DC for
    no purpose.

  When the Android APK is backgrounded the WebView stops draining the
  DC; these two streams alone fill the plugin's 10 MB app-layer send
  queue in ~1–2 h, after which real events start being dropped. The
  upstream gateway has no subscription mechanism for filtering event
  broadcasts per client (not in `EVENT_SCOPE_GUARDS`), so until that is
  added we drop both event names at the bridge before they reach
  `webrtcPeer.broadcast`. `res` frames and all other events are
  forwarded unchanged.

  **ICE gathering diagnostics (`webrtc-peer.js`)**

  Under pion-node the existing `rtc.ice-gathered` summary never emits
  because pion does not fire `onicecandidate(null)` at gather-complete.
  Install an `onicegatheringstatechange` handler as a fallback: on the
  `complete` state transition we flush the same summary, guarded against
  double-emission when the null-candidate path fires too (e.g. werift).
  The summary now also includes a `hosts=addr:port,...` list for each
  host candidate so we can observe whether pion is gathering docker /
  bridge / loopback interfaces as host candidates. The `gathering` state
  resets the flag so ICE restart cycles also get a fresh summary.

  **Diagnostic logs in `rpc-send-queue.js`**

  Commented-out `info` payload dumps left in place (one on every queued
  message, one on queue-full drop) so they can be temporarily enabled to
  sample what the gateway is still pushing without editing the release
  build.

- d11cc40: feat(rtc): expand ICE restart diagnostics on both UI and plugin

  Investigating a reproducible failure where a backgrounded APK (~20 min) comes
  back foreground, the plugin's pion reports `ice connection state: connected`
  for every ICE restart, but the UI's RTCPeerConnection never fires another
  `connectionState=connected` and eventually gives up, forcing a full PC rebuild.
  Existing logs could not distinguish between "ICE agent never left checking",
  "new pair nominated but DTLS transport did not migrate", and "WS/signaling
  lost an ICE candidate". This change adds a minimal, low-noise set of log
  anchors plus a bidirectional plugin-initiated probe so the next reproduction
  can be diagnosed without further instrumentation.

  UI (`ui/src/services/webrtc-connection.js`):

  - Wire the previously absent `iceconnectionstatechange`, `icegatheringstatechange`,
    `signalingstatechange`, and `icecandidateerror` handlers; each emits a single
    `remoteLog` line on state change. `iceconnectionstatechange` exposes the
    ICE-only `checking/connected/failed` transitions that `connectionState` hides.
  - Classify each local ICE candidate by `typ` (host / srflx / relay / prflx) and
    emit a `iceGathered host=N srflx=N relay=N prflx=N` summary when gathering
    completes. Counters reset at each `gathering` entry (including ICE restart).
  - `__attemptRestart` now logs a `restart.trigger reason=... connState=...
iceState=... sigState=... dc=[...] dcIdleAgo=... attempt=N` snapshot on the
    first entry of each restart epoch, making it possible to distinguish "we
    fired restart while UI still believed itself connected" from "UI already
    went to failed".
  - New `__dumpStats(reason)` helper walks `getStats()` and emits one line
    summarising the nominated candidate-pair (state / nominated / bytes /
    RTT / STUN req-resp counts), DTLS+ICE transport state and bytes, and
    rpc DataChannel stats (state / messages / buffered). Called at four
    points: before the first restart offer, 3s after a restart-answer is
    applied, on restart-timeout (awaited before close), and 2s after a
    `connectionState=connected` restart-success.
  - New `plugin-probe` frame type on the rpc DC: when the plugin sends one,
    the UI echoes `plugin-probe-ack` (bypassing the send queue, same as the
    existing UI→plugin `probe-ack` path) and logs the echo.

  Plugin (`plugins/openclaw/src/webrtc/webrtc-peer.js`):

  - Wire `oniceconnectionstatechange` on pion PCs (guarded by `in pc` so werift
    is unaffected); emit `rtc.iceState conn=X <state>` on each transition, and
    detach the handler in `closeByConnId` alongside the other listeners.
  - Log `rtc.restart-answer-sent conn=X` after a successful ICE restart answer
    is emitted, mirroring the existing `rtc.ice-restart` on the receive side.
  - On `pion` PC transition to `connected` when the previous dump state was
    `disconnected`/`failed` (i.e. an ICE restart just recovered): run one
    `rtc.dump state=connected` snapshot of the current session, then schedule
    a `plugin-probe` on the rpc DC with a 500 ms delay. The probe is bypasses
    the send queue, tracks a single in-flight id per session, and logs the
    RTT on `plugin-probe-ack`, a `timeout` line after 5 s unref'd, or a
    `send-failed` line if `dc.send` throws. `closeByConnId` clears the
    in-flight probe timer so a late timeout does not fire after session
    teardown. The probe bypasses the send queue, mirroring the existing
    `probe-ack` fast-path. The branch is gated on `impl === 'pion'` so
    werift/ndc compatibility paths are untouched.

  No existing recovery/retry/rebuild behaviour is changed; this commit is
  purely additive instrumentation plus the symmetric probe plumbing.

## 0.17.0

### Minor Changes

- f32b8e5: Harden plugin auto-upgrade against slow npm downloads and registry-side throttling, fixing the upgrade loop observed on slow / firewalled networks.

  - Raise the `openclaw plugins update` execution timeout from 2 minutes to 10 minutes, so first-time installs of native deps (e.g. `node-datachannel`) no longer get killed mid-download.
  - Add a one-shot reverse-mirror retry: if the first attempt fails (timeout / 429 / network error), the worker reads the user's current `npm config get registry` and retries once with the opposite side — `npmjs.org` users fall back to `registry.npmmirror.com`, and `npmmirror` users fall back to `registry.npmjs.org`. Either side being healthy is enough to escape the failure.
  - Increase the scheduler's first-check delay from 5 minutes to 60 minutes (effective range 60-120 minutes random). Prevents the failed-upgrade → gateway-restart → re-check cycle from disturbing gateway availability every few minutes when an upgrade keeps failing.
  - Preserve the original `skipVersion: false` semantics on update-command failures: failures are still treated as transient and re-attempted on the next cycle (now an hour later, not minutes).

### Patch Changes

- 88e1b46: Drop the `node-datachannel` dependency and its `vendor/ndc-prebuilds/**` publish entry to shrink the npm tarball from ~50 MB to ~82 kB, removing the main source of auto-upgrade stalls on slow networks.

  - Pion has been validated as the reliable primary WebRTC implementation; werift remains as the runtime fallback when pion fails to load.
  - `src/webrtc/ndc-preloader.js` is deliberately left in place during this transition. With the package missing, `require.resolve('node-datachannel')` throws synchronously and the preloader's existing `try/catch` falls through to werift via the unchanged fallback path — no consumer ever reaches an ndc-only code path.
  - No change to gateway RPC methods, plugin events, or binding protocol.

- 42b37e8: Add `credRemain` field to all ICE restart remoteLog lines on the plugin side.

  `credRemain` reports the seconds remaining until the embedded TURN credential expires (negative when already expired, `none` when no creds or unparseable). Helps diagnose whether ICE restart failures correlate with stale credentials (PC lifetime > 24h cred TTL window). Pure telemetry — no behavior change. Plugin reads it from `msg.turnCreds.username`.

- 87e953c: Tighten WebRTC peer session limits to cut idle resource usage.

  - `MAX_SESSIONS`: 20 → 10 — caps active + failed PeerConnections per peer. Eviction policy unchanged: only the oldest failed session is reclaimed; connected sessions are never evicted, and when none is failed the new offer still proceeds with a warning.
  - `FAILED_SESSION_TTL_MS`: 24h → 12h — failed sessions reclaim their IPC listeners and Go-side resources sooner. ICE restart after foreground resume still works within the new window; beyond it the UI falls back to a fresh offer/answer.

## 0.16.0

### Minor Changes

- bea05ad: claws 页面中继连接展示两段链路协议（浏览器 ↔coturn↔plugin），避免仅显示浏览器侧协议导致的误导。

  - Plugin（`@coclaw/openclaw-coclaw`）：pion 路径下新增 `coclaw.rtc.peerTransport` DC 事件单播。rpc DC 建立时和 ICE 选中 pair 变化时，把本端 candidate 的 `{ candidateType, protocol, relayProtocol }` 推送给对应 UI；签名去重避免重复发送，`queueMicrotask` 避让竞态，`sendTo` 失败回滚签名允许后续重试。顺手增强 `__logNominatedPair` 远程日志，带出 protocol 和 relayProtocol。werift 路径保持不变（其 candidate 对象无 relayProtocol，UI 自动走降级兜底）。
  - UI（`@coclaw/ui`）：`claws.store` 监听新事件更新 `claw.rtcPeerTransportInfo`（与 `rtcTransportInfo` 字段解耦，避免被浏览器 getStats 轮询整体覆盖）；`failed/closed` 时清空。`ManageClawsPage.connLabel` 在 relay 分支合并双端信息：两端协议相同时简化为 `中继·UDP`，不同时展示 `UDP ↔ 中继 ↔ TCP`；详情面板新增"对端候选/对端中继协议"一行。新增 i18n keys `rtcRelayBothSides` / `peerCandidate` / `peerRelayProtocol`，12 语言全同步。
  - 兼容性：依赖 `@coclaw/pion-node` 0.1.3+（新增 `relayProtocol` 字段透传）。老 plugin / 老 pion-ipc 二进制下事件不发，UI 自动回退老文案，不报错。

### Patch Changes

- 8ce4cbb: Bump `@coclaw/pion-node` dependency from `^0.1.2` to `^0.1.3`.

  The plugin's WebRTC layer (`webrtc-peer.js` — `__sendPeerTransport` /
  `__logNominatedPair`) reads `selectedCandidatePair.local.relayProtocol`
  to surface the plugin-side relay protocol for the `coclaw.rtc.peerTransport`
  DC event and nominated-pair logs. This field is only populated starting
  from pion-node 0.1.3 (which exposes pion-ipc's `RelayProtocol` passthrough
  on the local candidate). Under 0.1.2 the field was always `undefined`, so
  relay connections showed only the browser-side protocol in the UI. Pinning
  the floor to 0.1.3 makes the behavior reliable.

## 0.15.0

### Minor Changes

- 1eedb69: plugin: 扩展 coclaw.info.updated payload

  - `__pushInstanceName` 改名为 `__pushInstanceInfo`
  - 事件 payload 新增 `pluginVersion`（从 `plugin-version.js` 获取）和 `agentModels`（agent × 有效主模型，通过 `agents.list` RPC 采集）
  - 新增 `__collectAgentModels` 方法；采集失败时 `agentModels` 为 null，不影响其它字段上报

## 0.14.1

### Patch Changes

- b2da826: chore(plugin): trim cancel-related diag log noise

  阶段 2.5 上线后实测发现取消相关日志噪音过大：注册空窗期内 UI 每 500ms 重试 `coclaw.agent.abort`，每次都打 `request` / `result not-found` / `not-found diag` 三条，单次取消可累积数十行；且 `installAbortRegistryDiag` 默认 patch 4 个 Map（其中 `reply.*` 在当前 OpenClaw 版本根本不暴露）+ 启动时每 label 一条 `installed ${label} patch (size=N)`。

  清理方案：

  - 删除已注释的 `[coclaw.agent.abort] request` info + `abort.request` remoteLog 行
  - `[coclaw.agent.abort] result` 在 `reason=not-found` 时跳过；`ok=true` / `not-supported` / `abort-threw` 仍 info
  - 删除 `agent-abort.js` 的 `not-found diag` 块 + `describeReplyRunRegistry` 助手 + 不再使用的 `logger` 形参
  - `PATCH_LABELS` 缩到只剩 `embedded.activeRuns`（取消路径实际读取的就是这张表；`sessionIdsByKey` 与之 1:1 同步触发，冗余；`reply.*` 当前 OpenClaw 不存在）
  - `patchMapLogging` 删掉 `clear` 包装（实测从未触发）+ 启动时的 `[coclaw.diag] installed ${label} patch` 日志（与 `abort.patch installed=` remoteLog 重复）

  最终噪音模型：每次 run 2 条 info（`embedded.activeRuns.set` + `.delete`）；取消成功 1 条 info + 1 条 remoteLog；`not-found` 重试期间完全静默。

  RPC 契约不变。

- 9c3833d: feat(plugin): add coclaw.env diag log with platform/version info on ws connect

  插件间接依赖平台相关二进制（`@coclaw/pion-ipc-*` 的 npm 平台子包），诊断问题时需要快速获取 claw 端的运行环境。新增 `coclaw.env` 单行诊断日志，覆盖 webrtc 选型 + 插件/OpenClaw 版本 + OS/arch/CPU/内存：

  ```
  coclaw.env impl=pion plugin=0.14.0 openclaw=4.5.0 platform=linux arch=x64 node=v22.22.0 osrel=6.6.87 cpu="AMD Ryzen 7 8745H" cores=8 mem=11.7GB
  ```

  **输出时机**：

  - `bridge.start()` 完成后：**只本地** `logger.info` 一次（gateway 日志可见，便于本地排查）
  - 每次 `ws.open`（首次连接 + 每次重连）：**只远程** `remoteLog` 一次

  两端互不重复：ws.open 是唯一的远程来源，避免 "start 入 buffer + ws.open 再发" 的重复问题；server 重启重连后能立即看到当前 claw 的环境信息。

  **关键设计**：

  - `getPlatformInfoLine()` 纯缓存的同步轻量调用（`process.*` 常量 + `os.release/cpus/totalmem`），模块级缓存一次后零开销，可被 ws 重连路径放心频繁调用
  - 显式避免 `process.report.getReport()`（重量级同步调用，曾怀疑与 native 模块初始化期产生时序冲突）
  - `ws.open` 内**先 `setRemoteLogSender` 再 `remoteLog(envLine)`**：保证环境信息随当前 sock 立即 flush；sender 闭包仅 `sock.send`，不回调 `remoteLog`，无循环依赖
  - 每字段独立 `try/catch` 尽力而为：单项失败不影响其它字段；CPU model 的控制字符（C0 + DEL）被清洗为空格以保证 `key="value"` 解析格式

  RPC 契约不变；gateway 方法注册不变；仅新增一条 remoteLog 日志。

- a9e209f: fix(ui,plugin): UI 主导的 cancel 协调状态机解决注册空窗期 race；插件诊断 patch 产品化 + remoteLog 触点

  阶段 2 上线后实测发现 topic "永远不能取消"、main chat "要等几秒才能取消"。根因：`agent()` RPC 的 `onAccepted` 帧毫秒级返回（UI 亮 STOP）但 OpenClaw 的 `setActiveEmbeddedRun`（`attempt.ts:1572`）要等 session/workspace/skills/provider 等异步准备完成才执行——main chat ~4s，topic 冷启 10-30s+。窗口内 `coclaw.agent.abort` 全部返回 not-found。

  阶段 2.5 实施 UI 主导 + 插件无状态方案：

  **UI 侧（`ui/src/stores/chat.store.js`）**

  - 新增 state `__cancelling = { sid, promise, resolve, tickTimer, tickSeq } | null`
  - 新增 getter `isCancelling`
  - 新增内部方法 `__startCancelCoordination(sid, conn)`：按 `CANCEL_TICK_MS = 500` 重试 `coclaw.agent.abort` RPC，**无 TTL**（生命期=run 生命期）
  - 终止信号：RPC ok=true → `{ok:true, aborted:'immediate'}`；RPC `not-supported` → 立即静默降级；每 tick 头检 `agentRunsStore.isRunning(runKey)`=false → `{ok:false, reason:'run-ended'}`；`sendMessage`/`sendSlashCommand` 入口 `__clearCancelling('superseded')` → `{ok:false, reason:'superseded'}`（deep-review 发现：缺此分支则 chat 模式同 sessionId 的新 run 会被残留 tick 误 abort）
  - `cancelSend` accepted 分支幂等：二次调用返回同一 promise（按钮已被 `cancelDisabled` 禁用）
  - `cleanup()` 同步清理 `tickTimer` 防止页面离开后继续重试
  - `ChatPage.vue` 的 `cancel-disabled` 集成 `isCancelling`——用户点 STOP 后按钮立刻禁用直到 run 结束
  - `onCancelSend` 简化：终态 `immediate`/`run-ended` 静默，仅 `not-supported` notify warning
  - UI remoteLog 触点：`cancel.start` / `cancel.immediate` / `cancel.not-supported` / `cancel.run-ended`

  **插件侧（`plugins/openclaw/`）**

  - `coclaw.agent.abort` 保持单次同步查询 + 现有 logger.info；新增 5 条 remoteLog 触点：`abort.request` / `abort.success` / `abort.not-supported` / `abort.patch installed=...` / `abort.patch-failed reason=...`
  - `installAbortRegistryDiag` 从 `/* c8 ignore */` 临时诊断**产品化**为常驻 patch：监控 `embedded.activeRuns` / `embedded.sessionIdsByKey` / `reply.activeRunsByKey` / `reply.activeKeysBySessionId` 四个 Map 的 `.set`/`.delete`/`.clear`，输出 `[coclaw.diag] <label>.set/delete/clear` 本地日志；installed/missing 列表上报 remoteLog 作为 OpenClaw 内部契约变更早期警报
  - `agent-abort.js` 的 `describeReplyRunRegistry` 与 not-found diag dump 同步产品化（去 c8 ignore + 补单测覆盖各种缺失/异常分支）

  **调研依据**：subagent 复核 OpenClaw 源码确认 sessionId → run 是 1:1（`runs.ts:359` 直接覆盖），run 中再发消息走 reply queue 4 模式但**无并发同 sid**；handle 不带 runId、`chat.abort` 的 runId 路径不覆盖 `agent()` RPC；故 CoClaw 维持 sid 粒度协调。queue 模式下 run A→B 转换由 lifecycle:end 自然清除 UI 协调状态，无残留意图误伤 B。

  详见 `docs/designs/agent-run-cancellation.md` 阶段 2.5、`docs/openclaw-research/agent-run-cancellation.md` §6.7。

- 397b36f: fix(ui,plugin): review followups for agent run cancellation

  deep review 发现的一致性/稳健性改进：

  - **ui**: 触屏"按住说话"按钮 gating 与 textarea / "+" 按钮对齐，改为仅受 `disabled` 控制（`sending` 单独禁用违反"accepted 后允许准备下次消息附件"的设计意图）
  - **ui**: `cancelSend` accepted 分支新增 settling(cancel) 守卫，避免双击 STOP / watcher 重入（如 `isClawOffline`）导致重复 `coclaw.agent.abort` RPC
  - **plugin**: `agent-abort.js` 增加 `typeof handle.abort !== 'function'` shape 守卫，归类为 `not-supported`（而非 `abort-threw`），让 UI notify 显示"升级 OpenClaw"而不是"执行失败"
  - **ui**: `POST_ACCEPT_TIMEOUT_MS` 注释修正 —— 这是客户端侧 fallback 上限，非与后端 run 生命周期对齐
  - 文档：`docs/architecture/communication-model.md` 超时表同步到最新值（agent post-accept 30min → 24h；generateTitle 300s → 600s，含层级说明）
  - 测试：补 `conn=null` 降级、双击 STOP 守卫、`title-gen.js` 传递 `timeoutMs=300_000` 断言、触屏语音按钮 gating

## 0.14.0

### Minor Changes

- 3d21a5e: feat(plugin): 新增 `coclaw.agent.abort` RPC，通过 OpenClaw 全局 symbol 侧门真正终止 embedded agent run

  该 RPC 接受 `{ sessionId: string }`，通过 `globalThis[Symbol.for('openclaw.embeddedRunState')].activeRuns.get(sessionId)?.abort()` 触发 OpenClaw 底层 `AbortController`，停止 LLM、工具调用和 compaction。

  响应语义是"请求是否被接纳"，并非"run 是否已终止"：

  - `{ ok: true }`：handle.abort 已调用，取消是否真生效由随后的 `lifecycle:end` 事件反映
  - `{ ok: false, reason: 'not-supported' }`：侧门不存在（OpenClaw < v2026.3.12）
  - `{ ok: false, reason: 'not-found' }`：sessionId 未在 activeRuns 中（已完成 / 从未开始 / 竞态）
  - `{ ok: false, reason: 'abort-threw', error }`：handle.abort 抛异常（不期望但防御）

  侧门访问封装在新文件 `src/agent-abort.js`，未来上游若提供正式 `agent.abort` RPC 或在 `api.runtime.agent` 暴露 abort 家族可集中替换。

  详见 `docs/designs/agent-run-cancellation.md` 阶段 2。

- 1aa1345: feat(plugin): 为 rpc DC 引入应用层发送流控（RpcSendQueue）

  - 每条 rpc DC 绑定一个 `RpcSendQueue` 实例，`broadcast` / files RPC sendFn 经此出口
  - 阈值：HIGH=1MB / LOW=256KB 水位背压；队列软上限 10MB（单条可溢出）；单条硬上限 50MB
  - 溢出静默丢弃（logger.warn 每次；remoteLog 仅状态转换汇总）
  - probe-ack 故意绕过 queue，独立测量传输层健康
  - 避免 pion/webrtc Go 侧 SCTP pendingQueue 无界堆积导致 gateway OOM

### Patch Changes

- ecebf2a: bump @coclaw/pion-node to ^0.1.2（新增 linux-arm 平台二进制支持）
- 3f9c0ef: fix(plugin): topic 标题生成内部 agentRpc 超时 60s → 5min

  原 60s 在慢模型 / 复杂对话下普遍超时，导致 `coclaw.topics.generateTitle` 失败。调高到 300s 给 LLM 足够的推理时间。`acceptTimeoutMs` 保持 10s（accept 阶段一般秒级完成）。

- 6dddcf9: fix(plugin): rpc DC 生命周期与诊断收尾（深度 review followups）

  - `closeByConnId`：显式关闭 `RpcSendQueue`（避免 `dc.onclose` 路径因 session 已 delete 而短路，导致 drop 汇总 remoteLog 缺失）
  - ICE restart：重协商 SDP 后同步刷新 `remoteMaxMessageSize` 与 queue 分片阈值（避免 renegotiation 变更 `a=max-message-size` 时新消息按旧值错误分片）
  - `rtc.dump` 诊断增加 `queueLen/queueBytes/dropped` 字段，便于定位队列积压
  - `agent-abort`：`activeRuns.get()` 也纳入 try/catch，duck-typed 实现抛出时归入 `abort-threw`（原先仅保护 `handle.abort()`）

## 0.13.2

### Patch Changes

- fix(plugin): 修复 PionIpc listener 泄漏并添加 failed session 清理机制

  - failed 状态的 session 增加 24h TTL 定时器，超时后自动回收释放 IPC listeners 和 Go 侧资源
  - session 总数上限 20，溢出时淘汰最旧的 failed session
  - closed 状态通过 closeByConnId 完整释放资源（此前仅删除 Map 条目）

## 0.13.1

### Patch Changes

- 优化 ICE restart 恢复时序与实现门控

## 0.13.0

### Minor Changes

- feat: pion-ipc WebRTC 实现 + ICE restart 恢复策略 + 文件传输诊断增强

  - 新增 pion-ipc preloader（autoRestart watchdog），WebRTC 优先级：pion → ndc → werift
  - ICE restart-first 连接恢复：断连时优先 ICE restart，失败发送 restart-rejected 由 UI 驱动 full rebuild
  - connectionState failed 保留 session 以支持 ICE restart 恢复
  - 文件传输增加 dc.onerror 处理（兼容 pion 异步 send 错误）、进度日志、诊断 dump
  - dc.close() 改为 await（pion graceful close 支持）
  - 分片阈值取 min(远端 max-message-size, 本地 maxMessageSize)
  - pion-node 依赖升级至 ^0.1.1

## 0.12.3

### Patch Changes

- fix: improve Windows compat for auto-upgrade subprocess calls; use ws package for WebSocket to bypass undici proxy dispatcher

## 0.12.2

### Patch Changes

- Register libdatachannel initLogger to capture native ICE/DTLS/SCTP diagnostics via remoteLog

## 0.12.1

### Patch Changes

- fix: upgrade node-datachannel to v0.32.2, add backpressure and diagnostic logging to DC file upload

## 0.12.0

### Minor Changes

- refactor: rename bot→claw in API paths, config persistence, WS messages, and internal identifiers

## 0.11.6

### Patch Changes

- fix(plugin): 修正 ndc-preloader 的 pluginRoot 路径计算（`..` → `../..`），修复 npm 安装用户无法加载 vendor 预编译包导致 fallback 到 werift 的问题

## 0.11.5

### Patch Changes

- 77afc35: feat(plugin): 启动时 remoteLog 插件版本号；自动升级检测到结果时远程上报（成功/回滚/跳过）

## 0.11.4

### Patch Changes

- fix(plugin): stop() 不调用 ndc.cleanup() 避免阻塞事件循环 10s+ 导致 bind/unbind 超时；修复 callGatewayMethod 未传递 --timeout 给 openclaw gateway call 的问题

## 0.11.3

### Patch Changes

- fix: percent-encode TURN credentials for node-datachannel

## 0.11.2

### Patch Changes

- fix: support turns: URL scheme in ICE server credential mapping

## 0.11.1

### Patch Changes

- ui: add cloud deploy guide, debug build variant, reconnection optimization, remove per-bot inline loading
  server: simplify coverage config, raise test coverage to 90%+

## 0.11.0

### Minor Changes

- feat: add claw instance naming support

  - New `coclaw.info.get` / `coclaw.info.patch` gateway methods for reading/setting claw name
  - Claw name stored in `~/.openclaw/coclaw/settings.json`, independent of bindings
  - `coclaw.info.updated` event broadcast to server (persists bot.name) and UI instances (DC)
  - `coclaw.info` response now includes `name` and `hostName` fields

## 0.10.0

### Minor Changes

- Integrate node-datachannel as primary WebRTC implementation with werift fallback

  - Add ndc-preloader module with vendor prebuild deployment, timeout protection, and graceful fallback
  - Unify PeerConnection resolution: preloader provides implementation, webrtc-peer requires it
  - Await preload before WS connection to eliminate RTC timing gap
  - Add self-explanatory diagnostic logging for WebRTC implementation selection
  - Include precompiled binaries for linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64

## 0.9.2

### Patch Changes

- fix: WebRTC init race condition + reconnect unhandled rejection

## 0.9.1

### Patch Changes

- fix: add error listener on spawned upgrade worker to prevent gateway crash

## 0.9.0

### Minor Changes

- 4152fcd: 文件管理协议升级：采用 HTTP 动词语义（GET/PUT/POST），新增 POST 附件上传（唯一文件名生成）、mkdir/create RPC、force delete 非空目录支持

## 0.8.2

### Patch Changes

- feat(rtc): DataChannel 应用层分片/重组，消除 SCTP maxMessageSize 限制，所有 RPC 消息统一走 DataChannel

## 0.8.1

### Patch Changes

- fix(webrtc): correct ICE restart handling and fix session cleanup race

## 0.8.0

### Minor Changes

- feat: implement file management via WebRTC DataChannel (list/delete/read/write with path security, backpressure flow control, and temp file cleanup)

## 0.7.1

### Patch Changes

- fix: rename internal function to avoid OpenClaw install-time security scanner warning

## 0.6.2

### Patch Changes

- Delegate bind/unbind to gateway RPC, harden config I/O with atomic writes and mutex, improve error handling in realtime bridge

## 0.6.1

### Patch Changes

- e2528cc: coclaw.info RPC 新增 clawVersion 字段，返回 OpenClaw 版本号（当上游 resolveVersion() 可用时）

## 0.6.0

### Minor Changes

- Add claim-bind (enroll) flow for OpenClaw-initiated binding; align gateway method error response format with OpenClaw protocol; fix shell mangling JSON params in gateway RPC calls

## 0.5.2

### Patch Changes

- fix(bridge): 从环境变量 OPENCLAW_GATEWAY_PORT 自动检测 gateway 端口，不再硬编码 18789。修复非默认端口的 OpenClaw 实例绑定后所有 RPC 失败（"Gateway is offline"）的问题。

## 0.5.1

### Patch Changes

- fix(plugin): coclaw.info 等待 ensureAllAgentSessions 完成后再响应，修复新 OC 实例首次连接时空 session 导致无法进入对话页面的问题

## 0.5.0

### Minor Changes

- 新增 chat 历史追踪与统一消息加载能力：
  - ChatHistoryManager：通过 session_start 钩子追踪 chat reset 产生的孤儿 session，持久化到 coclaw-chat-history.json
  - coclaw.chatHistory.list RPC：供 UI 查询指定 chat 的孤儿 session 链
  - coclaw.sessions.getById RPC：按 sessionId 返回完整 JSONL 行级消息（type + id + message），替代 nativeui.sessions.get
  - coclaw.info capabilities 新增 chatHistory
  - 修复 recordArchived 竞态：在 mutex 内先从磁盘重载，防止 list() 无锁覆写缓存导致数据丢失

## 0.4.1

### Patch Changes

- 新增 coclaw.topics.update gateway 方法，支持通过 RPC 更新 topic 标题；修复 changes 不含有效字段时静默成功的问题

## 0.4.0

### Minor Changes

- feat(plugin): add Topic management support

  - New `src/topic-manager/` module with `TopicManager` class (in-memory model + `coclaw-topics.json` persistence per agentId, using mutex + atomicWriteJsonFile)
  - New `src/topic-manager/title-gen.js` for AI-powered title generation (copy `.jsonl` transcript, invoke agent via gateway WS two-phase RPC, clean title text, update topic metadata, cleanup temp files)
  - Extended `realtime-bridge.js` with `__gatewayAgentRpc` method supporting agent() two-phase response protocol (accepted -> final), exposed via singleton `gatewayAgentRpc()`
  - Registered 7 new gateway methods: `coclaw.info`, `coclaw.topics.create`, `coclaw.topics.list`, `coclaw.topics.get`, `coclaw.topics.getHistory`, `coclaw.topics.generateTitle`, `coclaw.topics.delete`
  - `coclaw.info` returns plugin version and capabilities list for UI version/feature checking
  - Topic data stored at `~/.openclaw/agents/<agentId>/sessions/coclaw-topics.json`, leveraging OpenClaw's per-agent sessions directory isolation

## 0.3.2

### Patch Changes

- fix: declare tool-events capability for gateway connection, enabling tool call streaming events

## 0.3.1

### Patch Changes

- fix: bind 后 OpenClaw 始终离线的回归问题（需重启 gateway 才能上线）

## 0.3.0

### Minor Changes

- feat: add multi-agent session ensure support for OpenClaw nativeui.sessions.ensure gateway method

## 0.2.4

### Patch Changes

- 4f89f91: fix(plugin): add device identity to gateway WS connection for OpenClaw 3.12+ scope enforcement

  OpenClaw 3.12 introduced a security fix (CVE GHSA-rqpp-rjj8-7wv8) that strips scopes from WS connections without device identity. This caused `nativeui.sessions.listAll` and `agent.identity.get` calls to fail with "missing scope" errors.

  - Add `src/device-identity.js`: Ed25519 key pair generation, storage (`~/.openclaw/coclaw/device-identity.json`), and v3 auth payload signing
  - Modify `realtime-bridge.js`: capture nonce from `connect.challenge`, build signed `device` field in connect params
  - Device identity is auto-generated on first connection and cached for subsequent reconnects
  - Backward compatible with OpenClaw >= 2026.2.19

## 0.2.3

### Patch Changes

- realtime-bridge 心跳超时改为连续 miss 计数策略（4 次 ~3 分钟），避免大消息传输期间误断连

## 0.2.1

### Patch Changes

- fix: auto-upgrade logger 兼容 gateway pino 风格，修复 "log is not a function" 导致升级流程中断的问题

## 0.1.7

### Patch Changes

- - fix: prevent bot.unbound race condition and fix bridge reconnect after rebind
  - feat: auto-rebind on bind and add request timeouts
  - fix: strip operator-configured policy prefix in derivedTitle
  - fix: enhance derivedTitle cleaning for cron time and untrusted context
  - refactor: architecture cleanup before auto-upgrade feature

## 0.1.6

### Patch Changes

- fix: unbind 时无论 server 通知是否成功，都清理本地绑定信息，避免用户陷入无法 unbind 也无法 bind 的死锁状态

## 0.1.5

### Patch Changes

- Fix server URL resolution: correct plugin entries key, default to im.coclaw.net, unbind and realtime-bridge use bindings.json as authoritative source

## 0.1.4

### Patch Changes

- fix(plugin): session get returns empty messages instead of throwing when transcript file missing

## 0.1.3

### Patch Changes

- fix(plugin): handle missing .jsonl for agent:main:main sessionKey and ensure it exists on startup

## 0.1.2

### Patch Changes

- fix(plugin): align plugin id with npm package name (openclaw-coclaw)
