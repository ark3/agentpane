---
labels: [question, sweep-0929]
---

# Decide whether D2a becomes final, so agentpane never holds an agent request and the six cards that exist only in case holding returns close

Filed 2026-09-29 by a sweep of the open deck for consolidations (read against e1cf2e6, nothing run).

D2a in `docs/DESIGN.md` ("And when the browser cannot answer either, the adapter declines rather than holding it") calls itself provisional: "OW-bijera is what revisits it: once a human can answer, holding becomes the right behaviour again".
Since OW-zisumi (Codex, `DECLINE_RESPONSES` in `src/server/adapters/codex/protocol.ts`) and OW-yosuzo (Pi, `PI_DIALOG_METHODS` in `src/server/adapters/pi/protocol.ts`) nothing stays pending past its own arrival.
D7a records the owner's 2026-09-11 intent "to avoid permission prompts, not to route them into agentpane's UI".

Yet the holding machinery still stands, kept on purpose by D2a's last paragraph so that bijera "removes the decline, not machinery it would have to rebuild":
- the adapters' pending maps: Codex `pendingRequests` and `externalRequestIds`, Pi `pendingUiRequests`, Claude's no-op `reply`;
- `SessionManager`'s `#pendingRequests`, `ManagedSession.requests` and `clearRequest` (`src/server/http/session-manager.ts`);
- the `request` and `request-resolved` events and every snapshot's `requests` field (`src/shared/protocol.ts`);
- the reply route in `src/server/http/app.ts` and `reply`'s place in `#serially`, whose docblock says why;
- D12's second eviction exemption ("Never evict a session blocked on a pending request").

Each of these open cards exists only because holding might come back:
- OW-bijera, the client half that would answer a request;
- OW-siguzo and OW-nobeko, which each say they are moot if nothing is held;
- OW-bovase, whose own body leans to "Probably a decline";
- OW-zogogo, which exists to decide what becomes of OW-bijera;
- OW-johano, whose blocked tool turn cannot happen on the production server, where a Pi dialog is cancelled on arrival.
OW-25 would shrink to an operational question about Pi's `trust.json`.

## The decision

Either D2a becomes final — agentpane never holds an agent request; the adapter answers each on arrival and reports it — or holding stays a live future and the cards above stay open.
Whatever the answer, record it in D2a in place of its "This is provisional" paragraph, and record in D12 what becomes of its second exemption.

## Done when

The decision is recorded in D2a.
If final: OW-bijera, OW-bovase and OW-zogogo close `--declined` and OW-siguzo, OW-nobeko and OW-johano close `--moot`, each note citing this card; OW-25 is amended to what is left of it; and one card is filed, labelled `sweep-0929`, to retire the holding machinery listed above.
If not final: each of those six cards is amended to say it was re-examined here and stands.
