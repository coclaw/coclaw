---
'@coclaw/ui': patch
---

Allow creating file-transfer DataChannels while the RTC is in `restarting` state.

Previously `WebRtcConnection.createDataChannel()` rejected four states (`closed`, `failed`, `restarting`, no PC). `restarting` was added defensively when ICE-restart-first was introduced, but it contradicts that feature's own design goal ("file DC survives restart"): during ICE restart the SCTP/DTLS layers are preserved, so a newly created DC merely sits in `connecting` until the UDP path is re-nominated, then opens — exactly as the existing DCs do.

The spurious reject manifested as broken images in chat/topic pages right after app foreground resume: many `ChatImg` components concurrently call `downloadFile` during the several-second `restarting` window; `waitReady` fast-paths (rpc DC is still `open`) but `createFileDC` is then shot down with `RTC_NOT_READY`, leaving `ChatImg` stuck in the error-card state (no auto-retry, and silent reload cannot heal it because the `src` prop value is unchanged).

Fix: drop `restarting` from the reject list; `closed` / `failed` / no-PC still reject. Both download (`downloadFile`) and upload (`postFile` / `uploadFile`) benefit since they share the same `createFileDC` helper. The inverted unit test now asserts that a restart-time `createDataChannel` call returns a valid DC with `binaryType='arraybuffer'`.
