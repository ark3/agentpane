---
labels: [defect, now]
closed: done
---

# The composer sends the same prompt twice on a second Ctrl-Enter during the round trip, and discards anything typed while it waits

`src/client/controller.ts`, `submit()`: the only guards are a selected session and a non-empty `view.draft`; `busy` is not consulted.
`src/client/App.svelte`, `send()`: guards on `compaction` and the draft, then calls `controller.submit()`.
The draft is cleared only on success, in the `publish({ draft: "", state })` after `api.prompt` resolves.
So a second Ctrl-Enter, or Enter followed by a click on Send, while the first POST is in flight issues a second identical `POST prompt`.
The server does not reject a second prompt on a streaming session (the only 409 in `src/server/http/app.ts` is `not_attached`), so what happens next depends on the backend, which is OW-rifezo's question.

The same `publish({ draft: "" })` is unconditional, and the textarea (`aria-label="Prompt"` in `App.svelte`) is never disabled while `busy === "submitting"`.
Anything typed between Send and the response is wiped when the response lands.
Clear the draft only if it still equals the text that was sent.

`controller.test.ts`, "clears the draft only after the prompt is accepted", exercises neither the second submit nor typing during the wait.

## Done when

- A test in `controller.test.ts` calls `submit()` twice while the fake API's prompt promise is held open and asserts one request; it fails before the change.
- A test publishes a new draft while the promise is held, resolves it, and asserts the new draft survives; it fails before the change.
- `App.test.ts` covers the Ctrl-Enter path once, since `send()` is where the keyboard reaches it.

## Close note

Landed as 36ec32c on `main`.

Two changes in `src/client/controller.ts`, `submit()`:
`if (busyIs("submitting")) return;` after the selected-session check, so a second Ctrl-Enter or an Enter-then-Send during the round trip issues no second `POST prompt`;
and the success publish became `publish({ ...(view.draft === text ? { draft: "" } : {}), state })`, so the draft clears only when it is still the text that was sent.
The textarea was deliberately left live while `busy === "submitting"`: disabling it would take away the one thing a user does while waiting, and would make the surviving-draft fix pointless.

All three tests the card asked for exist and were watched red before the fix and green after, by the dispatching session as well as the implementer — reverting `controller.ts` to `main` while keeping the tests fails exactly these three, on assertions rather than timeouts:
`controller.test.ts` "ignores a second submit while the first prompt is still in flight" and "keeps a draft typed while the prompt is in flight", and `App.test.ts` "sends one prompt when Ctrl-Enter repeats while the first is still in flight".
That App test drives the **real** controller over an inline `AgentpaneApi` rather than `FakeController`, because `FakeController.submit()` only increments a counter and would not contain the guard under test.
It has to emit a `snapshot` before the composer appears: `applyAttached` puts the session in `state.summaries` but not in `state.sessions`, and App's startup auto-preview effect previews any selected session that has no live view, which renders the Attach button instead of the composer.

An adversarial reader claimed that snapshot was dead scaffolding; removing it turned the test red, so the claim is wrong and the emit stayed.

The reader's real finding, confirmed: **this guard only holds until the first `sessions-changed` re-list.**
`refreshSessions` publishes `busy: "listing"` over `"submitting"` and its `finally` restores `"idle"`, and the server emits `sessions-changed` as part of accepting the very prompt that is in flight.
So a user pressing Ctrl-Enter twice a few hundred milliseconds apart still double-sends.
That stomping is OW-dinuwu, whose done-condition already names `busy` staying `"submitting"` across a re-list; OW-dinuwu is what makes this guard hold for the whole round trip.

Also filed: OW-kelede, for the same two defects on `forkAndSubmit`, which this card scoped out.
