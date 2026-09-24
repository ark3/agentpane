---
labels: [defect]
---

# A Pi resume that fell back from its recorded model is labelled with the fallback as if chosen, and the next turn makes the loss permanent

D23 in `docs/DESIGN.md` promises a conversation runs at the model it recorded, or says why not.
For Pi that promise is unmet on the fallback path, and OW-zujofa established that Pi will not help: as of `pi 0.87.1`, a `--session` resume whose recorded model had left the catalogue ran the settings default, one whose provider had lost its auth ran another keyed provider's default or resolved no model at all, and in every case Pi said nothing over RPC — no event, no response field, no stderr, direct or through `sbox`.
`docs/MANUAL_TESTING.md`, section "A Pi resume that cannot restore its recorded model falls back without a word over RPC (OW-zujofa)", holds the run and the source reading (`modelFallbackMessage` reaches only Pi's `InteractiveMode`; `runRpcMode` never reads it).

So any "says why not" has to be agentpane's own inference.
The evidence for it is already fetched: on a resume, `hydrateMessages` in `src/server/adapters/pi/process.ts` asks for `get_messages` and `get_entries`, which still name the recorded model (the last `model_change` entry or assistant message on the branch, per `getSessionContextSettings`), while `get_state` names the model in force.
A mismatch between the two at start is the fallback.
In the lost-everything case `get_state` answers provider and id `"unknown"`, which `modelToInfo` in `src/server/adapters/pi/protocol.ts` turns into the model id `unknown/unknown`.

Load-bearing: the detection at resume, and that it reaches the user before the first turn — read at the source in that section's "Not established", not run, the first turn on the fallback records the fallback model, and every later resume restores it as though chosen, so the chance to say anything ends there.
Incidental: the wording, and how each client renders it.
Which channel carries it is open; `onError` is not it, since its frozen contract is "a turn failed in a way the transcript does not convey" and a fallback at resume is neither a turn nor a failure (the comment on the stderr handler in `process.ts` says why that contract is guarded).
Session state, the same update that carries the model in force, is the implementer's suggestion from OW-zujofa.

Per AGENTS.md "Both clients", this is a user-facing capability: this card carries it onto both wires, the HTTP API and the Emacs helper's JSON-RPC in `src/emacs/protocol.ts`, and the browser and Emacs clients each get a card of their own blocked by this one, the Emacs one labelled `emacs`.

Done when a server test in `src/server/**`, fed a resume whose `get_entries` names a model other than the one `get_state` reports, shows the adapter surfacing the fallback on both wires, red first and green after, and a resume whose models agree surfaces nothing.
