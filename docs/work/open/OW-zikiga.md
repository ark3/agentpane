---
labels: [defect]
---

# The browser's send() overwrites a running turn's favicon watch and its refusal then abandons it, so a prompt refused mid-turn loses that turn's badge

Filed 2026-09-27 from the OW-dunahe implementer's report; read at the code, not reproduced.

In `src/client/App.svelte`, `send()` calls `armBadge()`, which calls `watchSubmit(turnWatch, keyOf(ref))` in `src/client/favicon.ts`.
`watchSubmit` sets the key to `false` (not yet seen streaming) whether or not a watch already stands on it.
When `controller.submit()` resolves `false`, `send()` calls `disarmSubmit(armedKey)`, which calls `watchAbandon` and deletes the key.
So if a turn this tab submitted is running and a second Send is refused, the running turn's watch is gone and its end badges nothing.
The `if (view.sending) return;` guard in `send()` covers only a second send while the first POST is in flight, not a send during a turn whose POST has already answered.

Whether this is reachable is the first question: the Claude Code adapter rejects `submit()` while a turn is active (`AGENTS.md`, "Evidence", OW-jihete; DESIGN D16), but the composer may disable Send while streaming on that backend.
Find out whether any backend's composer lets Send through mid-turn and then refuses it; if none does, close this card `--moot` with that evidence.

The Emacs client already keeps the watch in this case: OW-dunahe's `agentpane--watch-submit` in `emacs/agentpane.el` joins a watch already standing on the handle and does not own it, pinned by `agentpane-test-turn-done-kept-armed-by-a-prompt-refused-mid-turn` in `emacs/agentpane-test.el`.
That is the parity target (`AGENTS.md`, "Both clients").

Done when a test in `src/client/favicon.test.ts` or `src/client/App.test.ts` in which a submit is refused while an earlier submit's turn is streaming goes red before the change and green after, and the turn's end still badges an unfocused tab; `bun run check` passes.
