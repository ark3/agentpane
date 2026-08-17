---
kind: deferral
where: 'client SSE adapter'
---

# Every native `error` callback is reported as a disconnect, and no reconnect/backoff policy exists anywhere — the browser's own `EventSource` retry is the whole story.

Fine on loopback; nothing owns it if that stops being true.
