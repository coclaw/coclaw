---
'@coclaw/ui': patch
---

Keep STOP button disabled until run truly ends. Previously, when cancel coordination resolved early via the immediate-hit path, `__cancelling` was cleared but the run could still be in flight (cancelled=true, ended=false), letting the STOP button appear active again. Now `isCancelling` getter falls back to `cancelled && !ended` so the button stays disabled (with loader icon) for the full lifetime of the run, decoupling "should we keep sending abort RPCs" from "are we in cancel state".
