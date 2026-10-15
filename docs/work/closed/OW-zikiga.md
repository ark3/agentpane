---
labels: [defect]
closed: done
---

# The browser's send() overwrites a running turn's favicon watch and follow, and a refused or handled prompt then abandons them, so the earlier turn loses its badge

Filed 2026-09-27 from the OW-dunahe implementer's report; read at the code, not reproduced.

In `src/client/App.svelte`, `send()` calls `armBadge()`, which calls `watchSubmit(turnWatch, keyOf(ref))` in `src/client/favicon.ts`.
`watchSubmit` sets the key to `false` (not yet seen streaming) whether or not a watch already stands on it.
When `controller.submit()` resolves `false`, `send()` calls `disarmSubmit(armedKey)`, which calls `watchAbandon` and deletes the key.
So if a turn this tab submitted is running and a second Send is refused, the running turn's watch is gone and its end badges nothing.
The `if (view.sending) return;` guard in `send()` covers only a second send while the first POST is in flight, not a send during a turn whose POST has already answered.

## Amended 2026-10-14 from OW-yobayi's adversarial read

It is reachable, and since OW-yobayi through an ordinary action, not only a refusal.
The Send button stays enabled while a turn streams (`disabled={!view.draft || view.sending || compaction !== null}` in `src/client/App.svelte`), so the Claude Code refusal of a mid-turn submit (OW-jihete) reaches `disarmSubmit` as above.
And OW-yobayi made `send()` call `disarmSubmit` for a prompt answered `"handled"` too: on Pi, a `/mcp` sent while this tab's earlier turn streams is answered handled, because Pi runs extension commands immediately even during streaming (`pi 1.2.0`'s `docs/rpc-commands.md`, and `prompt()` in its `agent-session.js` trying the extension command first; read at the source by OW-yobayi's reader, not run).
Before OW-yobayi that path badged correctly, since nothing disarmed a landed prompt, so this is a regression OW-yobayi landed knowingly.
`armFollow` has the same shape: it overwrites the session's `pendingFollow` entry, and `disarmSubmit` deletes it, so an earlier turn whose echoed user message has not yet arrived is never followed.

A second case against the same disarm, from the same read: `disarmSubmit` acts only when the answer arrives, and cannot undo what already happened.
On `pi 1.2.0`, `_tryExecuteExtensionCommand` awaits the command's handler before answering `"handled"`, so a handler that starts a turn through `pi.sendUserMessage` (Pi's `/ask` example) emits that turn's events before the answer, and one that also awaits `ctx.waitForIdle()` runs the whole turn first (read at the source, not run).
Another tab's user message can likewise beat the answer, since the stream and the POST are separate connections.
In that order follow engages (and once engaged, `pendingFollow` is gone, so the disarm releases nothing), and with a whole turn first the badge fires, contrary to the "follows and badges neither" decision stated in `disarmSubmit`'s docblock and in the OW-yobayi test in `src/client/App.test.ts`, which pins only the answer-first order.

Both cases come from the same state: the arms are one slot per session (`pendingFollow` in `App.svelte`, `TurnWatch.waiting` in `src/client/favicon.ts`) that a submit overwrites and its disarm deletes.
The fix gives each submit ownership of what it armed, so a disarm takes down only that and leaves standing whatever an earlier submit put there, and decides what a disarm does to a follow or watch that the stream already advanced before the answer arrived — record that decision in `disarmSubmit`'s docblock.
OW-pohusi changes which failures disarm at all; this card changes what a disarm takes down, and the two touch the same function.

The Emacs client already keeps the watch in this case: OW-dunahe's `agentpane--watch-submit` in `emacs/agentpane.el` joins a watch already standing on the handle and does not own it, pinned by `agentpane-test-turn-done-kept-armed-by-a-prompt-refused-mid-turn` in `emacs/agentpane-test.el`.
That is the parity target (`AGENTS.md`, "Both clients").

## Done when

A test in `src/client/favicon.test.ts` or `src/client/App.test.ts` in which a submit is refused while an earlier submit's turn is streaming goes red before the change and green after, and the turn's end still badges an unfocused tab.
A second does the same for a submit answered `"handled"` mid-turn.
A third, red first, has the session's events for a new turn arrive before a `"handled"` answer and asserts whatever `disarmSubmit`'s docblock now says that order does.
`disarmSubmit` no longer deletes a watch or pending follow an earlier submit owns.
`bun run check` passes.

## Close note

Landed in e1702196 ("client: a refused or handled prompt disarms only what its own submit armed").
Ownership: `armFollow` and `armBadge` in `src/client/App.svelte` now join a pending follow or watch already standing on the session instead of overwriting it, and report what they armed; `send()` hands that to `disarmSubmit(key, armed)`, which takes down only what this submit armed.
Joining is sound because `view.sending` admits one submit in flight per tab, so anything standing belongs to a submit already answered `started`; this matches `agentpane--watch-submit` in agentpane-mode.
Stream-before-answer decision, recorded in `disarmSubmit`'s docblock: the watch this submit armed is dropped even after it saw streaming; a follow its pending follow already engaged gives way to the follow that stood when it armed (none, or an earlier turn's anchor, restored), and a follow already over stays over; a badge already raised stays, because the badge is one bit across sessions.
The adversarial read caught the first cut nulling the anchor on release, which would have stopped following an earlier, still-streaming turn when a foreign user message landed before a handled answer; the restore replaced that.
Tests in `src/client/App.test.ts` (seven tagged OW-zikiga): badge kept for a prompt refused and for one handled mid-turn, an earlier pending follow kept across a refusal, the gated stream-before-handled order, the follow kept across a refused or handled mid-turn prompt, and the follow restored after a foreign message.
Each was shown red, against f3ae3548 or ccbd91dd, or for the follow-kept pair (green on both) under a mutation that clears the anchor on every release.
`bun run check` passed (1686 tests) and `bun run test:browser` passed 29/29.
Known edge left alone: a reader who scrolls off the earlier follow while the second request is in flight, with a foreign message then engaging its pending follow, gets the dismissed follow restored; the window is one request.
