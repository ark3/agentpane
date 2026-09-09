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
