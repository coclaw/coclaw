---
'@coclaw/openclaw-coclaw': patch
---

fix(plugin/file-manager): defer tmp unlink until ws close on cancel/error paths

The `dc.onclose` (not-done branch) and `dc.onerror` cleanup paths used to
fire `ws.destroy()` and `safeUnlink(tmpPath)` side-by-side. When fopen had
not yet completed, unlink could reach the kernel before the file was
created; the ENOENT was swallowed and a subsequent fopen would re-create
the file, leaving an orphan tmp file with no one to clean it up.

Now both paths register `ws.on('close', () => safeUnlink(tmpPath))` before
calling `ws.destroy()`, mirroring the existing ack-send-failed branch.
This ensures unlink always runs after the stream is fully closed, whether
fopen completed normally or failed.
