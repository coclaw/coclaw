---
'@coclaw/openclaw-coclaw': patch
---

Fix: add pc identity guard to onicecandidate / onicegatheringstatechange / onselectedcandidatepairchange handlers. Same race window as the previously fixed ondatachannel — when a connId is reused, the old PC's queued callback can fire after detach (assigning null to a property does not stop already-dispatched events), polluting the new session with stale data. Most severe is onselectedcandidatepairchange, which produced "old pair data + new connId" mixed log lines and forwarded stale transport info to the UI.
