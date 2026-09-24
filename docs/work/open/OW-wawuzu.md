---
labels: [unverified]
---

# Codex accepts any model string with 204 and fails only at the next turn

Left open by OW-pizaki, which made a model the backend refuses answer 400 `backend_refused` for Pi and Claude Code, and deliberately left Codex alone.

`CodexAdapter.setModel` in `src/server/adapters/codex/adapter.ts` checks nothing: it stores the string for the next `turn/start` and consults `listModels` only to reset an effort the new model does not list.
So `POST /api/sessions/codex/<id>/model` with a bogus model answers 204, and the failure surfaces only when the next prompt goes out, as whatever the submit route and the adapter's error path make of it.

Unmeasured, and the thing to settle first: what `codex -m gpt-5.6-luna`'s app-server answers on `turn/start` with an unknown `model`, on the version installed on the home server (name it), and how that reaches the browser today.
Also whether `model/list` is complete enough to validate against — whether Codex accepts ids it does not list — because validating `setModel` against `listModels` is only safe if it is.
`CodexRpcError` in `src/server/adapters/codex/jsonrpc.ts` is no help as it stands: it is thrown both for a backend error response and for a transport shutdown.

## What the owner licensed for the live run

On 2026-09-24 the owner granted an exception to the `gpt-5.6-luna` pin in `AGENTS.md`, "Evidence", for this card alone: `turn/start` may be sent with a made-up model id that names no real model, such as `agentpane-no-such-model`, since such a turn is expected to fail before any model runs.
Send as few such turns as the measurement needs, and record in `docs/MANUAL_TESTING.md` whether any tokens or cost were reported for them.
The exception does not cover a real model other than `gpt-5.6-luna`: never send a turn naming one, even one `model/list` does not list, because that turn would run it.
So settle whether Codex accepts ids it does not list without such a turn: compare `model/list` with and without `includeHidden` (`resources/codex-protocol/v2/ModelListParams.ts`), and read the rest from Codex's own behaviour on the made-up id.
If that leaves the question open, the card closes on its second branch, with the reason written beside `CodexAdapter.setModel`.

Done when the live answer is recorded in `docs/MANUAL_TESTING.md` with the CLI version, and either `setModel` refuses an unknown model as `BackendRefusedError` (400), pinned by a test seen red first, or the reason Codex cannot be validated up front is written where the next reader of `CodexAdapter.setModel` will meet it.
