---
labels: [deferral, d27]
blocked-by: [OW-66]
closed: promoted
---

# Forks pile up in the list as sessions nobody wants back, and nothing hides the kinds of fork that are known dead

The owner's answer to fork clutter, named on 2026-08-19 when OW-vezipo was first deferred, is to hide some kinds of fork automatically.
`docs/DESIGN.md` D27 kept that deferred when it rewrote OW-vezipo into the `forkedFrom` field and a fork marker in each client, and this card is where the deferral lives.
It cannot be built before hiding exists, which is OW-66, and which forks deserve hiding is a verdict to take from use rather than predict.
D13 places the mark store server-side so that a mark could originate there, at the fork the server performs, and deliberately does not decide whether anything does.

One kind is already known: `docs/MANUAL_TESTING.md`, in the paragraph beginning "What a fork with no subsequent prompt costs is therefore a real file", records that a Pi fork with no prompt after it leaves a session file the walk lists.

## Revisit when

OW-66 has landed and forking has been used long enough for the owner to say which forks they want out of sight.
Closing this means a decision recorded in `docs/DESIGN.md` beside D13 and D27, whether to set a mark at fork time or not at all, and, if one is set, the cards that build it in both clients' terms per `AGENTS.md`, "Both clients".

## Close note

Promoted to ark3/agentpane#7 during the card triage, 2026-10-31.
The owner considers the design this card carries out of date: the issue keeps it as prior thinking and opens with a design discussion, after which the work is split into fresh cards.
