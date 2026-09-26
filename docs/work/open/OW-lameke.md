---
labels: [defect]
---

# The server clears a held turn error at a prompt's admission by matching its text, so a new error with the same text raised before admission completes is cleared while live

Found by the adversarial read of OW-lohubo on 2026-09-26, traced by reading the code, not by a live run.

OW-lohubo retired both clients' reply-time clear of a held turn error, because it compared the error by text and dropped a newer error with the same text.
The server's own clear, which OW-lohubo left alone by design, compares the same way.
`SessionManager.submit` in `src/server/http/session-manager.ts` takes `priorError` (read by the `"prompt"` case in `src/server/http/app.ts`, "Read before the attach") and, after `await adapter.submit(text, images)`, runs `if (priorError !== null && session.error === priorError)` to clear the error and broadcast `error-cleared`.
`session.error` is a message string, so the check cannot tell the error held at send from a new one with identical text.

Sequence: the session holds "The turn ended in an error." and a prompt arrives; `adapter.submit` is awaited, which resolves only once the backend has accepted the turn — for Pi that can include a `get_state` round trip while the id is unresolved, and a steer mid-turn is possible on Pi and Codex (D16); a new turn error with the same text reaches the adapter's `onError` inside that window and the server broadcasts `error`; `submit` resumes, finds the same text, clears it and broadcasts `error-cleared`.
Every client then drops an error the backend just raised, consistently but wrongly.

Whether any backend actually raises a turn error before its `submit` resolves is unmeasured; that is the first thing to settle, and a card that finds it impossible for all three adapters closes on recording why in the `submit` comment, citing the adapter code or the live run and naming the version it was measured on (`AGENTS.md`, "Evidence").

In service of the server being the one owner of the turn error (OW-lohubo): the admission clear should compare the error's identity, not its text — say a per-container generation bumped wherever `session.error` is set, captured where `priorError` is read today.
Load-bearing: an error set after the prompt's `priorError` was read survives admission even when its text matches.
Incidental: the identity's shape, and whether the route still passes something called `priorError`.
The OW-31 and OW-bipume behaviour — an error that stood at send is cleared at admission, and one the session's start raised after the read is not — must still hold, as must OW-bomolu's concern if that card has landed by then.

Done: a test in `src/server/http/session-manager.test.ts`, beside "clears the error when the next prompt is admitted (OW-31)", holds an error, submits with that error as prior, has the fake adapter raise an error with the identical text before its `submit` resolves, and finds `session.error` still set and no `error-cleared` broadcast — red first, green after; the existing OW-31 and OW-bipume tests there and in `src/server/http/app.test.ts` still pass under `bun run check`.
