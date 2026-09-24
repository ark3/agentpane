---
labels: [change, emacs]
blocked-by: [OW-zobiro]
closed: done
---

# agentpane-mode's mode line falls back to the model's defaultEffort when the status reports no effort, as the browser's select does

OW-zobiro put the session's reported effort in agentpane-mode's mode line and took the simple cut its body offered: when `session/status` or `session/snapshot` carries a null `effort`, the mode line names none.
The browser does not stop there: `selectedEffort` in `src/client/App.svelte` is `selectedSession?.effort ?? selectedModelInfo?.defaultEffort ?? null`, so before any effort is chosen its "Conversation effort" select shows the model's default (OW-kivahe).
The two clients therefore differ before a first turn on a model whose session reports no effort, and `AGENTS.md`, "Both clients", asks for parity.
Filed 2026-09-23 from the implementer's report on OW-zobiro.

## Where it lives

- `agentpane--set-status` in `emacs/agentpane.el` builds `agentpane--status-fields`; since OW-zobiro it appends `(plist-get params :effort)` right after the model, and its docstring says no default stands in because that "would take a `models/list'".
- `models/list` is the JSON-RPC request documented in the docblock of `src/emacs/protocol.ts`, answering `{ id, label, efforts, defaultEffort }` per model; `agentpane--read-effort` in `emacs/agentpane.el` already calls it for `agentpane-set-effort`.
- What is load-bearing is where the fallback's model listing comes from without a request on every status notification — cached per backend, or fetched once when the model changes — and that the fallback is presented as the same field; the exact caching shape is the implementer's first cut.
- Whether the fallback should look different from a reported effort (the browser's select does not distinguish them) is a first cut too; matching the browser is the default.

## Done when

- An ERT test in `emacs/agentpane-test.el`, against the fake helper answering `models/list` with a `defaultEffort`, shows a status with a null effort naming that default in the mode line, and one with a reported effort naming the reported one, shown red first; the Commentary's test count in `emacs/agentpane.el` is updated, and `agentpane--set-status`'s docstring no longer says no default stands in.
- The whole ERT suite passes, run as the Commentary of `emacs/agentpane.el` gives it.

## Close note

`agentpane--set-status` in `emacs/agentpane.el` now names the model's `defaultEffort` in the mode line when the status's `effort` is null, as the same field and unmarked, matching `selectedEffort` in `src/client/App.svelte`.
The default comes from `agentpane--list-default-effort`, which sends one async `models/list` per model a status names, on the first status and on each change of model, never once per status; it is async because it runs inside the notification handler, bypasses `agentpane--request` so it cannot displace a view refetch as the buffer's latest request, is sent only through a helper already running, and re-shows the last status (`agentpane--status`) when the reply arrives for the model still current.
Until the listing answers, or when it names no default (as of this change only Codex's listing carries a non-null `defaultEffort`), no effort is named.
ERT test `agentpane-test-mode-line-falls-back-to-the-default-effort` failed red against the old code (no `models/list` sent) and passes now; with the once-per-model guard removed it also goes red; the full suite reads `Ran 85 tests, 85 results as expected, 0 unexpected` on main, and `bun run check` passes there too.
Two test helpers that stand in a fake connection now stub `jsonrpc-async-request`, since they measure each command's own request sequence.
Left as is: the fallback also applies after the first turn, where the browser hides its effort select; the mode line already named a reported effort there since OW-zobiro.
