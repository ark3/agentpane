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

The owner took the decision on 2026-09-09: a prompt submitted mid-turn means **steer**, and a backend that cannot steer **rejects**. Recorded as D16 in `docs/DESIGN.md` and in `types.ts`'s `submit` docblock (973a3d6).

The three-way split this card described was real and re-verified at every site before the decision.
What the card did not know is that it was partly an artefact of the contract's arity rather than of backend capability: `pi/protocol.ts:31` types `streamingBehavior?: "steer" | "followUp"`, and the Pi adapter's own comment says it picks `"steer"` only because `submit()` "has no way for the caller to express steer-vs-follow-up".
Widening `submit` to carry the choice was therefore a fourth option this card had not listed, and it was declined with the others: it pushes onto the user a choice they should not have to make.

Standardising on **follow-up** was the reachable-everywhere option — Claude already does it, Pi flips one string — and was declined because reaching it on Codex would mean holding prompts server-side to simulate a primitive Codex does not have, in order to give every backend the weaker semantic. Steer is what a person typing mid-turn is asking for.

The **client gate** option is not currently buildable and the card assumed it was: OW-7 records that only the tail entry is marked streaming, and OW-toyeru that Claude drops `isStreaming` to false while a queued turn is still pending, so the composer already offers Send on a session about to stream again.

Cards filed for the two adapters that do not honour D16, as this card's done-when required:

- **OW-tifuha** — Codex rejects though `turn/steer` is in the generated bindings and unused. The card requires a live probe *before* wiring, because nothing has ever run `turn/steer`, and specifies what to do in either outcome including amending D16 if steer does not work.
- **OW-jihete** — Claude queues silently, which D16 names as the one unacceptable answer, and must reject.

**OW-toyeru** was blocked on this card and is now re-pointed at OW-jihete instead of being freed by this close: it is the transcript-ordering defect of exactly the queued mid-turn prompt OW-jihete stops producing, so it is likely moot, and OW-jihete carries the instruction to settle that explicitly rather than let it lapse. Its second half — `isStreaming` dropping false while a queued turn is pending — may survive.

**OW-nasofa** is unaffected and its in-flight guard becomes more necessary, not less: post-D16 an accidental double Ctrl-Enter is a regression on Codex (a clean rejection becomes a duplicate steered into the running turn), an improvement on Claude, and unchanged on Pi.

An adversarial reader dispatched at the writeup found four defects in it, all confirmed at the source and corrected before the commit. D16 asserted Claude's mid-turn queueing as fact when the repo's only source for it is that file's own comment and no run in `docs/MANUAL_TESTING.md` has ever sent a mid-turn Claude prompt — it is now hedged to the same standard as Codex's unrun `turn/steer`. It attributed to Pi a motive no source states. Its double-submit paragraph claimed two backends of three reject today, when only Codex does. And OW-tifuha as first filed claimed a second `TURN_ACTIVE_ERROR` throw site inside `submit` at `:361` and told the implementer to weigh it: `:361` is `compact`'s guard, `compact` is one of the two `NonSteerableTurnKind`s, and steering it is protocol-impossible — the card now says leave it, and names the four tests that flipping the real guard will turn red.

Per this repo's rule that a correction retires every copy, the overturned clause at `claude/adapter.ts:13` — "so `submit()` does not gate" — is marked at the code rather than only in DESIGN, since that docblock is where a reader meets it and OW-jihete has not landed yet.
