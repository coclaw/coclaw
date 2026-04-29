---
'@coclaw/ui': patch
---

Fix `rtcPhase` being momentarily clobbered to `'failed'` during active RTC init.

`__ensureRtc`'s entry path sets `rtcPhase` to `'building'` / `'recovering'`, then synchronously calls `closeRtcForClaw()` to tear down the previous RTC. The synchronous teardown fires `onStateChange('closed')`, whose store callback unconditionally wrote `rtcPhase = 'failed'`, overwriting the entry value. Since `_rtcInitInProgress` was set, no retry was scheduled — leaving `rtcPhase='failed' && retryNextAt===0`, which `unreachableClaws` matches. The UI thus briefly flashed an unreachable warning during every PC rebuild before the final `'connected'` callback restored `'ready'`.

The fix tightens the existing `_rtcInitInProgress` guard so the `failed/closed` callback skips both `rtcPhase` writes **and** retry scheduling during active init. `dcReady`, `disconnectedAt`, and `rtcPeerTransportInfo` are still written (they reflect real DC state). Phase remains exclusively managed by `__ensureRtc`'s entry / completion / bail dispatch.

Three UI surfaces benefit without code changes — the existing `rtcPhase`-driven reactive state now stays accurate end-to-end:
- `MainList` mobile header: spinner stays on throughout rebuild instead of flashing unreachable warning
- `ChatPage` connection banner: shows `connRecovering` / `connBuilding` instead of briefly flashing `connRetryExhausted`
- `ManageClawsPage` connection dot: stays in connecting color instead of briefly flashing red
