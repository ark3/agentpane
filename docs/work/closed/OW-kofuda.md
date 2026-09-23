---
labels: [defect, emacs, emacs-native]
closed: done
---

# The Emacs helper outlives its stdin while an HTTP request to the server is still in flight

Filed 2026-09-22 from OW-bonode, whose live run found it; the evidence is in `docs/MANUAL_TESTING.md`, section "The Emacs helper connection: a nested request stalls, and the helper exits on stdin close (OW-bonode)", paragraph "An HTTP request that never completes holds the helper alive".
Measured there on `bun 1.4.0`: with a stand-in server that held every `GET` open, closing the helper's stdin aborted the event stream but the helper was still running 30s later.

`runHelper` in `src/emacs/helper.ts` ("Runs until `input` ends; then closes the stream and resolves") stops the event stream when its input ends, but each JSON-RPC request is answered by a detached `void respond(...)`, and the HTTP call behind it goes through the api client in `src/client/api.ts` (`createAgentpaneApi`, whose `fetchImpl(url, init)` calls carry no abort signal).
A request still waiting on the server therefore keeps Bun's event loop, and the process, alive.
`src/emacs/main.ts` builds the `fetch` it injects as `loopback`, which already forwards `init`.

What it costs today: `agentpane-shutdown` in `emacs/agentpane.el` closes stdin and then calls `jsonrpc-shutdown`, which after 0.3s warns "Sentinel ... still hasn't run, deleting it!" and SIGKILLs the helper.
So the helper does go away, but by a kill and with a warning, whenever the server is slow or hung at the moment the user quits; its docstring records this case.

In service of the helper ending on its own when Emacs lets go of it, which is the contract `src/emacs/main.ts` and `agentpane-shutdown` both assume.
Load-bearing: the abort has to reach the in-flight `fetch`, not merely the reply; answering the request with an error while the socket stays open changes nothing.
A likely shape is an `AbortController` owned by `runHelper` whose signal the helper's injected `fetch` adds to every call and which is aborted when input ends, but `src/client/api.ts` is shared with the browser client, so a change there must leave that client's behaviour alone.

Done when a test in `src/emacs/helper.test.ts` fails before the change and passes after: with an injected `fetch` that never resolves on its own and a request in flight, ending `input` aborts that fetch (its signal fires, or its promise rejects with an abort).
Record in `docs/MANUAL_TESTING.md`, beside the paragraph named above, a rerun of that stand-in showing the helper exits with code 0 after stdin closes, naming the bun version, and retire the "holds the helper alive" claim there and the in-flight caveat in `agentpane-shutdown`'s docstring in the same change.

## Close note

Landed on main as the one OW-kofuda commit after 1b9cb66 ("fix: abort the helper's in-flight requests when its stdin ends").

`runHelper` in `src/emacs/helper.ts` owns an `AbortController`, wraps the injected `fetch` so every api call carries its signal, and aborts it after `closeStream()` when input ends; `src/client/api.ts` is untouched, so the browser client is unchanged, and no api method passes a signal of its own to combine with.
An aborted request is still answered, since stdout stays open: Emacs receives `-32603 "The operation was aborted."`.

Verified: `bun run check`, 1180 tests; the new test in `src/emacs/helper.test.ts` ("aborts a request still waiting on the server when the input ends…") was red on the old code with no signal on the fetch.
Rerun of OW-bonode's stand-in (a server holding every `GET` open) on the home server, `bun 1.4.0`, Emacs 31.1: before the fix the helper was alive 30s after stdin closed; after it, it exited with code 0 in 0.03–0.07s over three runs, and `agentpane-shutdown` ended with status `exit` and no sentinel warning.
Recorded in `docs/MANUAL_TESTING.md` beside "An HTTP request that never completes holds the helper alive", which is now past tense, and the in-flight caveat in `agentpane-shutdown`'s docstring is retired.
Not probed: a write of the abort answer after Emacs has already closed stdout.
