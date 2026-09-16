---
labels: [question, emacs]
---

# Which Emacs client agentpane builds, agent-shell over an ACP shim or a native mode over its own JSON-RPC helper, is undecided and closes as D21

Filed 2026-09-15.
Two streams of cards now describe an Emacs client, and nothing records which one the project is building.

- `agent-shell` over an ACP shim: OW-fenobo, OW-basoga, OW-limejo, with OW-mikuyo deferred behind it.
  Its case, in OW-basoga: no Emacs rendering is written, and every fork and session fact stays agentpane's.
- A native `agentpane-mode` over a JSON-RPC helper agentpane owns: OW-mutufa, OW-refibu, OW-wavone, OW-gunuke, OW-fojike.
  Its case, in OW-mutufa: the owner used `agent-shell` and found the fit costs more than it saves, and a protocol agentpane owns has a field for everything ACP had to smuggle, chiefly the fork point, the model gate and `request` events.

OW-wawipu belongs to neither stream and stands whichever is chosen.

The two streams share their first module in all but output type, so the cost of deciding late is small until either stream's second card starts.
Both may also be explored: the reader who has used both for a week is the one this card is written for, and a rough cut of each is what `docs/DESIGN.md` D14's own history says UI decisions come from.

## Done when

The decision is recorded in `docs/DESIGN.md` as D21, with the reason, on the same day the other stream's open cards close `--declined` citing D21.
The closing act also writes the sentence OW-basoga planned for D14, scoping it to the browser client, since it is true of both streams.
