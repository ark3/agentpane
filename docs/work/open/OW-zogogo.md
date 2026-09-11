---
labels: [question]
---

# Whether any Codex `ServerRequest` kind can reach agentpane under its own configuration, now that the approval kinds cannot

Filed 2026-09-11 at OW-18's close, because OW-18's conditional over OW-bijera came out an answer that fits neither of its branches.

OW-18 settled that agentpane's Codex threads carry `approvalPolicy: "never"` on all three thread-creation paths (`docs/DESIGN.md` D7a) and ran the evidence (`docs/MANUAL_TESTING.md`, "Observed Codex approval policy, and what a fork carries (OW-18)").
Two things came out of that run and they point opposite ways.

The approval kinds are out of reach.
An edit-provoking prompt raised an `item/fileChange/requestApproval` on a `read-only` thread under `on-request` and none under `"never"`; on a `danger-full-access` thread — which is what agentpane uses — none arrived under either policy, because the sandbox grants the write and `on-request` has nothing to ask about.
`item/commandExecution/requestApproval` and the other approval methods were never measured, but they sit behind the same two levers.

`item/tool/requestUserInput` could not be provoked at all.
Two attempts on a `"never"`, `danger-full-access` thread — one naming the tool explicitly and declaring `experimentalApi: true` in `initialize` — both drew "the user-input tool is unavailable in the current mode" and emitted no tool call of any kind.
That is not a finding about `"never"`; it is a finding that nothing in those runs could reach the tool.

## What this card is in service of

OW-bijera says nothing in the client can answer an agent's request, so a `ServerRequest` hangs the turn forever behind one line of text.
Its done-condition is a live run where a backend raises a real approval and the browser answers it.
Nobody can stage that run today, because nothing is known to raise a request agentpane will see.
This card is the prerequisite: it decides whether OW-bijera is moot, real, or real-but-unstageable, and that disposition is the whole reason it exists.

The same question bears on OW-futewo's close note, which assumes children raise approvals under an `on-request` default that no longer exists, and on the `AgentRequest` docblock in `src/shared/protocol.ts`, which states the renderer's dispatch-on-`kind` design for kinds that may now be unreachable.

## Where to start

`resources/probes/approval_policy_probe.py` is the vehicle and needs no rewrite — it already records every server-initiated request with its method and params before answering, and its `APPROVAL_METHODS` set names the five approval methods from `resources/codex-protocol/ServerRequest.ts`.
Read `ServerRequest.ts` for the full variant list rather than working from that set: MCP elicitation (`mcpServer/elicitation/request`) and the dynamic tool call are kinds the OW-18 run never touched, and either may be reachable where the approvals are not.
`codex app-server generate-json-schema --experimental` is how `fork_probe.py`'s `codex_rollback_deprecation` reads the live schema, if the question turns into which requests the server can emit at all.

The load-bearing specifics: the two levers are per-thread `sandbox` and `approvalPolicy`, both set by `CodexAdapterOptions` in `src/server/adapters/codex/adapter.ts`; the CLI flags sbox injects are no-ops for `app-server` (OW-37, D7a); and `danger-full-access` plus `"never"` is agentpane's actual configuration, so a request that only arrives under some other pair does not count.

Incidental: which model runs the cells. The OW-18 run took whatever `~/.codex/config.toml` selected, read back as `gpt-5.6-luna`.
A tool-gating result may well be model-dependent, so record the model either way — the probe now does.

Needs a live Codex run and no work-laptop trip: `codex` is on the home server, and only Pi is confined to the laptop.

## Done when

`docs/MANUAL_TESTING.md` carries a run, phrased over what was seen, that either exhibits a `ServerRequest` of some kind arriving on a thread configured the way the adapter configures one, or records what was tried for each kind in `ServerRequest.ts` and why none arrived.

Then, whichever way it comes out, record the disposition in OW-bijera: an arriving kind makes that card real and names the kind its live run should use, and a clean sweep with nothing reachable makes it a candidate for `--moot` — the owner's call, not this card's.
If the answer is instead that a kind is reachable only under a configuration agentpane does not use, that is a third outcome and belongs in OW-bijera as such, not forced into either of the first two.
