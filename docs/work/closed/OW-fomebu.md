---
labels: [question]
closed: done
---

# Codex warning notifications are dropped, so neither client says a turn ran on fallback model metadata

Found while executing OW-vofawi, from the live run in `docs/MANUAL_TESTING.md`, section "What a Codex turn on a model that does not exist does".
As of `codex-cli 0.156.0`, a `turn/start` naming a model Codex had no metadata for drew a `warning` notification 8 ms later: ``Model metadata for `agentpane-no-such-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.``
That section records that the warning did not reach the SSE stream, because `CodexReducer.handle` in `src/server/adapters/codex/reducer.ts` has no `case "warning"` and its `default` branch drops it.
The vendored protocol carries four such methods beside it, in `resources/codex-protocol/ServerNotification.ts`: `warning` (`v2/WarningNotification.ts`), `guardianWarning`, `deprecationNotice` and `configWarning`.

Nobody has decided whether agentpane surfaces any of these, and this card is that decision.
The upstream refusal that followed in that run is already reported, once and unwrapped, since OW-vofawi, so the warning adds nothing to a turn that fails; it matters for a model the upstream accepts but Codex runs on fallback metadata, which nobody has measured.
A fresh live run naming an unknown model needs the owner's leave: the exception granted OW-wawuzu did not carry over.

Surfacing a warning is a user-facing capability, so under "Both clients" in `AGENTS.md` it lands in the browser and the Emacs client together, or goes onto both wires with a card per client.
Done when the decision — which of the four methods surface, if any, and as what (the existing `error` effect, a new effect, or a transcript node) — is recorded in the docblock of `CodexReducer`'s `default` branch or `docs/DESIGN.md`, and, where it says to surface one, the cards that build it are filed.

## Close note

Decided by the owner on 2026-09-24: agentpane surfaces all four of Codex's warning notifications -- `warning`, `guardianWarning`, `deprecationNotice` and `configWarning` -- as a non-fatal notice, distinct from the error banner, in the browser and in `agentpane-mode`.
Deferring until one was seen was considered and rejected, because nothing could show one: the reducer's `default` branch drops them without a trace, and across the home server's 119 Codex rollouts on 2026-09-24 no warning or error event type was ever stored, so a rollout cannot serve as the tripwire either.
The work is OW-tujiya, one card landing the notice in both clients as `AGENTS.md`, "Both clients", allows; it also rewrites the `default` branch's comment in `CodexReducer`, which is where this card asked for the decision to be recorded.
