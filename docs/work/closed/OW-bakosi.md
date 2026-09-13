---
labels: [change]
blocked-by: [OW-razoki]
closed: done
---

# The fork abort and the stop-first labels become Pi-only, once Codex and Claude both leave the parent turn running

Filed 2026-09-13 from `OW-ziyobe`, whose own terms require it: "If the decision is to take the asymmetry, the behaviour change and the label change are work, and belong in their own cards filed from this one -- do not fold them in here."
Both are here rather than in two cards because they are one change in one module: the label is derived from the same fact the behaviour keys off, and landing either alone ships a control whose name is false.

## What changes

`src/client/controller.ts` `forkAndSubmit` holds the whole behaviour in one line -- `if (view.state.sessions[sessionKey(ref)]?.isStreaming) await api.abort(ref);` -- with a comment above it stating the reasoning that this card retires.
That abort becomes conditional on the backend, and survives only on Pi.

`src/client/App.svelte`:

- `sendLabel`, currently `editing ? (streamingAction ? "Stop and fork" : "Fork") : "Send"`, reads "Stop and fork" only on Pi.
  On Codex and Claude an edit submitted mid-stream is just "Fork".
- The composer shortcut's text, `streamingAction ? "Stop and edit" : "Edit last message"`, follows the same rule.
- `editLastMessage`'s own `if (streamingAction) void controller.abort();` is the click-time stop behind "Stop and edit", so it goes with the label.

`SessionRef.backend` is already on the ref the client holds, so nothing new is plumbed.

## Why the abort stays on Pi

Not uniformity, and not a preference.
Pi's CLI abandons the in-flight turn on a fork whatever the client does -- the active `sessionFile` moves, `isStreaming` goes false, and `agent_settled` arrives with no assistant text (`docs/MANUAL_TESTING.md`, OW-yudoni, work laptop 2026-08-20, `pi 0.84.2`).
The abort there does not cause the loss; it makes it deliberate and visible, and the label is the only warning the user gets.
That is why this card leaves Pi exactly as it is rather than treating it as the odd one out to be smoothed over.

## Why it goes on Codex and Claude

Codex's parent turn survives a mid-stream `thread/fork` and completes with its whole reply durable on disk -- measured, home server 2026-09-11, `codex-cli 0.154.0` (`docs/MANUAL_TESTING.md`, OW-gojado).
Claude's survives too once `OW-razoki` stops `replaceProcess` killing the child, and the abort costs more there than on Codex: nothing reaches the store file until after the wire says the turn is over, so aborting destroys the entire reply rather than racing it (`docs/MANUAL_TESTING.md`, OW-japuzo, `claude 2.1.268`).

## Do not start before OW-razoki

On Claude this card is a lie until that one lands.
Dropping the abort while `fork()` still calls `replaceProcess` means the turn dies anyway, silently, under a button that no longer warns -- strictly worse than today, where the warning is at least true.
That is the same failure mode `OW-yikoyo` hit and recorded: a control whose label outruns its behaviour.

## Done when

`src/client/controller.test.ts` and `src/client/App.test.ts` both pin the split, each going red first.
Those suites assert the current labels by name -- `controller.test.ts` around the "the button says 'Stop and fork'" comment is where the contract is pinned today -- so the existing cases are rewritten per backend rather than deleted, and any that cannot be are named in the close note.

A streaming Pi session in edit mode still aborts before forking and still says "Stop and fork".
A streaming Codex or Claude session in edit mode forks without aborting and says "Fork", and the parent turn is still streaming afterwards.

The comment above the abort in `forkAndSubmit` is rewritten, not deleted: it currently argues for uniformity across backends, which is the position this card ends, and the next reader needs to know the asymmetry is deliberate rather than an oversight.

`bun run check` passes.
The action row is one of the places `AGENTS.md` names for a hand-run of `bun run test:browser` before committing, so run it and say so in the close note; this changes button text and a conditional control, not layout, so it is expected to be uneventful.

## Close note

Landed in b0bd306 (the change) and 113970b (review fixes).
`bun run check` green at 1057 tests, ~44s; `bun run test:browser` run by hand at the final state, 20 passed, uneventful as the card expected.

## What was built

`forkAndSubmit`'s abort is now `ref.backend === "pi" && view.state.sessions[sessionKey(ref)]?.isStreaming`, and the comment above it states the asymmetry instead of arguing the uniformity it used to -- with the version and machine behind each backend's behaviour, which is where the evidence for this split now lives.
`App.svelte` carries one derived `stopsBeforeFork`, read off the selected ref so the label cannot disagree with the controller about which backend it is on; `sendLabel`, the shortcut's text and `editLastMessage`'s click-time abort all key off it.
So "Stop and fork" / "Stop and edit" on Pi, "Fork" / "Edit last message" on Codex and Claude, and the abort exactly where the label promises one.

A rename cannot move the two apart: `SessionManager.#adoptRef` takes `next` from the adapter's own ref, so a rename never changes `backend`.
A session switched mid-edit is not reachable either -- `App.svelte`'s selection `$effect` clears `editing` on any selection-key change.

## Tests, and none dropped

Every existing case was rewritten per backend; none had to be deleted, so this note names nothing.
The Pi cases already used a Pi ref and became the Pi half as-is, retitled and with a docblock saying why the abort stands there; `it.each(["codex", "claude"])` siblings carry the other half in both suites.

Red-first was checked by the dispatching session rather than taken from the implementer's report: with the two source files reverted and the tests kept, exactly the six new cases failed and nothing else.
Both halves were then mutation-checked -- forcing the Pi condition false in both files failed exactly the four cases that pin the Pi behaviour, including `D17, OW-miyemo`'s abort-window test.

## What review found

An adversarial reader found no reachable divergence in the split and no other client site assuming the old uniform behaviour -- the edit-mode banner and the per-message "Edit message" control were already backend-neutral, and two files were enough.
It found prose defects instead, and they were real.
The `stopsBeforeFork` docblock stated three backends' fork behaviour in the present tense with card ids as the evidence, which is exactly the defect `AGENTS.md` names; it now defers to `forkAndSubmit`'s comment, where the versions are.
Its claim that the shared ref meant label and behaviour "cannot drift apart" was stronger than what holds -- the compaction halves are kept aligned by `send()`'s early return and the submit button's `disabled`, not by that line -- and is narrowed to the backend half.
One of the new `App.test.ts` pairs asserted nothing an idle session would not also satisfy, so it now pins its own premise on the Stop button the way its sibling does.

## The copies this retired

`docs/DESIGN.md` D15's opening sentence still described the abort unqualified, corrected two lines below -- the shape `AGENTS.md` warns about -- and now carries "on Pi, and only there"; its closing paragraph records that the behaviour landed rather than that it has not.
`docs/MANUAL_TESTING.md` carried four live present-tense claims about code as it now stands: the abort "remains" a choice on Codex, the `forkAndSubmit` `isStreaming` check being backend-agnostic (naming that symbol, so a reader grepping it lands there), Claude's abort destroying a reply, and the adapter not running two children.
Each run's narrative was left standing in its own past tense with a dated correction filed beside the claim rather than a section below it.
That last one was OW-razoki's residue rather than this card's, and was verified against the code before being corrected: `replaceProcess` has no occurrences under `src/server/`, and `SessionManager` parks the fork's recipe in `#pendingForks`.
The same paragraph quoted D15's pre-`aafde65` heading, so that went too.

## What this does not settle

No live run: the split is client-side and the suites pin it, but nobody has driven a streaming Codex or Claude session through an edit in a real browser to watch the parent finish.
`e2e/composer-shortcut.spec.ts` covers the Pi half only, and by accident of `harness.ts` pinning `backend: "pi"` -- now said out loud in a comment there, so repointing the harness fails legibly rather than silently.
