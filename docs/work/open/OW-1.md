---
kind: deferral
where: '`src/shared/protocol.ts`'
---

# The wire contract says a snapshot resets the sequence, but not whether it should also clear a transient `error` or a pending `request`.

The client preserves both when a session view already exists, which is a choice
the contract does not sanction either way.
