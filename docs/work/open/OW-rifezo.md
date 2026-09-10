---
labels: [question]
---

# Submit-while-busy means three different things: Codex rejects, Pi steers, Claude queues, and the contract does not say which is right

`src/server/adapters/types.ts`, `submit`: "Resolves once the backend admits the turn, not when the turn completes."
That is the whole of what the contract says, and the three adapters answer a second prompt during a turn three ways:

- Codex throws `TURN_ACTIVE_ERROR` (`src/server/adapters/codex/adapter.ts`), even though the generated bindings carry `turn/steer`.
  The route turns that throw into a 500 and the browser preserves the draft.
- Pi sends the prompt with `streamingBehavior: "steer"` (`src/server/adapters/pi/process.ts`, the comment "should pick"), so it is delivered after the current tool call.
- Claude writes it to stdin and the CLI queues it for after the turn, with the transcript defect OW-toyeru.

The same user action therefore yields an error, a mid-turn interjection, or a follow-up, depending on which backend the session happens to be on, and the composer draws the same Send button for all three.

The decision is what agentpane promises: one behaviour the adapters implement, with a backend that cannot honour it rejecting so the client can say so, and OW-nasofa's double submit becomes that rejection on every backend; or a per-backend capability the client reads and draws differently; or a gate in the client that refuses to send while `isStreaming`, which would make the question moot and OW-zekuhe's edit-stops-the-turn first cut the only mid-turn path.
OW-zekuhe is already open on the adjacent decision and should be read first.
OW-7 records that only the tail entry is marked streaming, which bears on any client gate.

## Done when

The decision is recorded as a D-numbered entry in `docs/DESIGN.md`, `types.ts`'s `submit` docblock states the promise, and the cards this creates for the adapters that do not yet honour it are filed and named in the close note.

**Amended 2026-09-09 at execution.**
Every claim above was re-checked at the source and holds verbatim: the `submit` docblock (`types.ts:65`), `TURN_ACTIVE_ERROR` (`codex/adapter.ts:68`, thrown at `:278` and `:361`), Pi's `streamingBehavior: "steer"` (`pi/process.ts:295`), Claude's stdin write with "Admission is the stdin write; the CLI queues messages sent mid-turn" (`claude/adapter.ts:198-199`), and the ungated Send button (`App.svelte:1296`, disabled only on an empty draft or an active compaction).

Three things this card did not know, all of which bear on the choice.

**Pi already supports both behaviours.**
`src/server/adapters/pi/protocol.ts:31` types `streamingBehavior?: "steer" | "followUp"`.
The adapter picks `"steer"` not because Pi is a steering backend but because, in its own comment, `submit()` "has no way for the caller to express steer-vs-follow-up".
So the three-way split is partly an artefact of the contract's arity, not of what the backends can do, and one candidate resolution is to widen `submit` rather than to pick a winner among the current behaviours.

**Codex's steer binding is real but unused.**
`resources/codex-protocol/v2/TurnSteerParams.ts` exists and carries an `expectedTurnId` "required active turn id precondition. The request fails when it does not match the currently active turn."
Nothing in `src/` calls `turn/steer` (grep is empty).
So Codex's rejection is the adapter's choice, not the protocol's limit — but nobody has run `turn/steer` live, so what it does is unverified.

**A client gate cannot be built on `isStreaming` today.**
Option three above assumed it could.
OW-7 records that only the tail entry is marked streaming, and OW-toyeru records that on Claude the first `result` drops `isStreaming` to false while a queued turn is still pending — so the composer already offers Send on a session that is about to stream again.
A gate would need that fixed first.

**OW-zekuhe has since closed** (2026-09-09, D15): submitting an edit stops the running turn on every backend, deliberately and no longer as a first cut.
So option three's consequence — that the edit path becomes the only mid-turn route — is now a statement about settled behaviour rather than about a provisional one.
