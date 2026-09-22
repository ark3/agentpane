---
labels: [change, emacs, emacs-native]
blocked-by: [OW-mutufa]
closed: done
---

# A Bun helper speaks JSON-RPC over stdio to Emacs, as a client of the HTTP API, exposing the REST verbs and pushing projected nodes as notifications

Filed 2026-09-15, the native-mode stream (see OW-mutufa for the stream and its reason).
D22 chose this stream on 2026-09-22, on OW-dekate's evidence; the shim cards it names are closed and read only for prior art.
The counterpart of OW-basoga: the same process in the same place, speaking to a different client.
OW-basoga's paragraphs on shape, on why the process lives outside `src/server/`, and on the event-stream rules are all true here and are not repeated; read them, then this.

## Why a helper process at all

Emacs could speak HTTP itself, but then the reducer in `src/client/session-state.ts`, the transcript fold, the tool summaries and the diffs would all be rewritten in elisp, which is the second-renderer cost OW-mikuyo named.
With the helper, every semantic decision stays in TypeScript under vitest, and the elisp holds no knowledge of tools, backends or store shapes.

## Transport

An entry script `src/emacs/main.ts` that Bun runs from source the way `src/server/index.ts` is run (`bun run src/emacs/main.ts`); no build, no binary.
It reads and writes JSON-RPC 2.0 with `Content-Length` header framing, which is what `jsonrpc-process-connection` in Emacs's bundled `jsonrpc.el` speaks; that library is what eglot uses and loads on the home server's Emacs 30.2 with no package installed.
Newline-delimited JSON was considered and set aside 2026-09-15 because `jsonrpc.el` gives request ids, timeouts and error objects for free and the framing costs a dozen lines in Bun.

It is a client of the HTTP API through `createAgentpaneApi` in `src/client/api.ts`, whose `fetch` and `openEvents` are injectable; the server's base URL rides on the helper's command line, defaulting to loopback on `DEFAULT_PORT` from `src/shared/protocol.ts`.
Bun's `EventSource` or a hand-rolled SSE reader over `fetch` serves as `openEvents`; pick whichever `bun run` provides without a dependency, and say which in the docblock with the Bun version.
One helper per Emacs session, holding one event stream and serving every buffer in that Emacs, since the wire is already multiplexed per session (D2).

## Requests, one per REST verb

Names and payloads in `src/emacs/protocol.ts` beside the node shape from OW-mutufa, each a thin call through the api client:

- `sessions/list` with an optional `cwd`, returning `SessionSummary[]`.
- `sessions/preview` for a ref, returning that session's nodes from `GET .../preview` through the projection, spawning nothing.
- `sessions/create` with `cwd`, `backend` and optional `model`, returning the ref, and `models/list` for a backend.
- `sessions/attach` for a ref, after which the notifications below flow for it.
- `sessions/prompt`, `sessions/abort`, `sessions/compact`, `sessions/setModel`, `sessions/forkPoints`, `sessions/fork`, and `requests/reply`, each forwarding to its route and returning the route's body.

Errors: an `ApiClientError` becomes the JSON-RPC error with the server's `error` and `detail` text carried through untouched, so a mid-turn prompt rejection (D16) reads in Emacs exactly as it does in the browser.
The helper enforces nothing the server does not; the one gate the browser adds in `src/client/controller.ts` `loadModelsForSelected`, model choice only before the first prompt, is the mode's to enforce, and the mode card says how.

## Text parts carry the browser's HTML

Every text part in a node the helper sends, in `sessions/preview` and in the notifications below alike, carries an `html` field beside `text`: the sanitized string `renderMarkdown` in `src/client/render/markdown.ts` returns for that markdown, which is what OW-wavone's buffer draws through `shr` (D22).
`src/emacs/dump-nodes.ts` already produces it outside a browser, under a jsdom window, for the OW-dekate spike; lift that into the projection so `TextPart` in `src/emacs/protocol.ts` gains the field and the dump script's own `SpikeTextPart` goes away.
`protocol.ts` is a frozen interface in D11's sense and this card is the raise: the change retires its text-part comment "Nothing on this path renders HTML; Emacs fontifies" and the `dump-nodes.ts` docblock's "not part of the node contract in `protocol.ts`, and `projectTranscript` never produces it", both of which the field makes false.
Where the jsdom window is created, and its cost per node on a long transcript, is the implementer's to measure and record in the docblock: the projection runs on every upsert while a turn streams, and `src/emacs/nodes.test.ts` runs in node, so the tests need the window the projection needs.

## Notifications, one per reduced event

The helper feeds every `ServerEvent` through `reduceServerEvent` in `src/client/session-state.ts` and emits what the buffer needs after the reducer has applied the rules the browser learned: re-key on `renamed`, re-snapshot on a `seq` gap, REST and SSE unordered (D2).

- `session/snapshot` with the ref, every node, `isStreaming`, `compaction` and `model`.
- `session/node` with the ref and the one node an upsert replaced.
- `session/status` with the ref's `isStreaming`, `compaction` and `model`.
- `session/error` with the message; a `request` event (D2a) also arrives here as text saying what kind arrived, since nothing in Emacs answers one yet (OW-bijera) and the adapter declines what it can (OW-yikoyo).
- `session/renamed` with `from` and `to`, so the buffer re-keys itself.
- `sessions/changed` with no payload, so the picker refetches.

## Amended 2026-09-22 before dispatch, from a cold read against the code

Each point below overrides the paragraph above it where they differ.

- **SSE reader.** `EventSource` is not a global under the installed `bun 1.4.0` (`bun -e 'console.log(typeof EventSource)'` prints `undefined`, measured 2026-09-22 on the home server), and `defaultOpenEvents` in `src/client/api.ts` would throw at runtime while `svelte-check` passes on the DOM lib types.
  So the hand-rolled reader over `fetch` is the only choice; record that measurement in the docblock.
  A hand-rolled reader does not retry by itself, so the helper reopens the stream after a short delay when it drops, and every open after the first emits `sessions/changed`, which is D21 for this client.
- **Relative paths.** `api.connect` hands `openEvents` the relative `ROUTES.events`, and every request hands `fetch` a relative route, so the helper prefixes its base URL inside both injected functions; `src/emacs/dump-nodes.ts` does it for `fetch` only.
- **Framing and the loop are testable in node.** Nothing in the repo or its dependencies frames `Content-Length` JSON-RPC; write it.
  `bun run test` runs vitest under node, where `Bun.stdin` is undefined, so `src/emacs/main.ts` is only the Bun binding, the way `src/server/index.ts` is, and the loop lives in a sibling module that takes its input and output as injectable streams beside `fetch` and `openEvents`; the tests drive that module.
- **Where the HTML comes from.** `src/client/render/markdown.ts` binds `DOMPurify` to `globalThis.window` at evaluation, so a static import from the projection would bind to no window in node and `sanitize` would throw; `dump-nodes.ts` sets a jsdom window on the global and then imports by dynamic `import()`, and that is the shape to keep.
  Lift it into one module in `src/emacs/` that creates the window and returns `renderMarkdown` as a function, and give `projectTranscript` and `projectUpsert` a `render: (markdown: string) => string` parameter that fills `html`; the projection stays pure and `src/emacs/nodes.test.ts` passes a stub renderer for its structure tests, with one test that loads the real renderer through that module and asserts the `html` a fixture text part carries is non-empty and differs from its `text`.
  `html` is required on `TextPart`; the three places in `nodes.test.ts` that build a `{ type: "text", text }` against `TextPart` are the test's own and change with it.
  Every `Spike*` type in `dump-nodes.ts` goes, not only `SpikeTextPart`.
  `sessions/preview` runs `api.preview` through `previewMessages` in `src/client/preview.ts` before the projection, as `dump-nodes.ts` does.
- **What the reducer does and does not tell the helper.** `ReduceResult` in `src/client/session-state.ts` is `{ state, recover, refreshSessions }` and nothing more.
  The helper dispatches on the raw event's `type` beside that result: the node an `upsert` replaced comes from `projectUpsert` over the pre-reduce view's messages and the event; `session/renamed` carries the event's `from` and `session`; `refreshSessions` true is `sessions/changed`; and an event the reducer ignored, which it signals by returning the same `state` object, emits nothing.
- **A seq gap is healed by an attach, not locally.** The reducer returns the ref in `recover` with state unchanged, and the browser's `recover` in `src/client/controller.ts` answers by calling `api.attach(ref)`, after which the server broadcasts a fresh snapshot over the stream.
  The helper does the same, and the test for it scripts both halves: the injected fetch answers the attach, the injected event source then delivers the snapshot, and that snapshot is what yields `session/snapshot`.
- **One stream, filtered.** The stream opens lazily at the first `sessions/attach`, before that attach's REST call, and stays open; `openEventStream` in `src/server/http/app.ts` sends an opening snapshot for every session holding a live adapter and broadcasts every event to every client, so views Emacs never attached also form in the reducer.
  Notifications are emitted only for refs Emacs attached through the helper, a set the helper keeps and re-keys on `renamed`; `sessions/changed` is unfiltered.
- **Verbs.** `AgentpaneApi` has no `reply` method because the browser never answers a request (OW-bijera); add `reply(requestId, body)` to the api client as the thin wrapper over `ROUTES.reply` it is, then forward `requests/reply` through it.
  Add `sessions/close` forwarding to `api.close`, since a killed buffer needs it; `edit-draft` is the browser composer's and is left out on purpose.
  `sessions/attach` returns the `SessionSummary` the route returns.
- **Errors on the wire.** A JSON-RPC error from an `ApiClientError` carries the HTTP status as `code`, the error's `message` as `message`, and `{ status, error, detail }` as `data`; any other failure is `-32603` with the message.
  A `session/error` is not carried by a snapshot, so a re-snapshot after a gap does not replay it; the mode should not expect it to.

## Done when

Tests in `src/emacs/` drive the stdio loop against an injected fetch and event source, in node: a list request returns summaries; a preview request returns nodes, each text part carrying a non-empty `html` alongside its `text`, and opens no event stream; an attach followed by a snapshot and two upserts yields one `session/snapshot` and two `session/node` notifications in order; a `seq` gap makes the helper call attach, and the snapshot the event source then delivers yields a fresh `session/snapshot`; a snapshot for a session Emacs never attached yields nothing; a `renamed` event yields `session/renamed` before the snapshot that follows it; a prompt whose server rejection arrives yields a JSON-RPC error carrying the server's text.
A framing test feeds two messages in one chunk and one message across two chunks and reads both back intact.
`bun run check` passes; `bun run test:browser` is not involved.

## Close note

Closed 2026-09-22 on the home server.

Amended before dispatch from a cold read against the code (commit 701feb4): `EventSource` is not a global under `bun 1.4.0`, so the SSE reader is hand-rolled; the loop is split from the Bun binding so vitest can drive it in node; the projection takes a `render` parameter and one module owns the jsdom window; the reducer's result is read beside the raw event; a seq gap is healed by `api.attach` as the browser does it; one stream, opened at the first attach and filtered to attached refs; `reply()` added to the api client and `sessions/close` added to the verbs; JSON-RPC errors carry the HTTP status as `code` and `{ status, error, detail }` as `data`.

Built, in `src/emacs/`: `framing.ts` (Content-Length frames over bytes), `sse.ts` (the reader over fetch), `render.ts` (jsdom window plus dynamic import of `renderMarkdown`, loaded through `process.getBuiltinModule("node:module").createRequire` because vitest's vmThreads loader cannot load jsdom's `@exodus/bytes`), `helper.ts` (the loop), `main.ts` (the Bun binding, `bun run src/emacs/main.ts [base-url]`); `protocol.ts` documents every request and notification and `TextPart` gained a required `html`; `dump-nodes.ts` lost its spike types and uses the same renderer; `AGENTS.md` gained one clause on the renderer's window.
Tests: `framing.test.ts`, `sse.test.ts`, `helper.test.ts` (every done-when case, including the seq gap scripted through attach and the unattached snapshot yielding nothing), `nodes.test.ts` with a stub renderer and one real-renderer case, `api.test.ts` for `reply`; each new module's tests were red before the module existed.
Measured render cost, in the `render.ts` docblock: about 1.1s to load once, then about 0.5ms per short text part and about 2ms for a 2.3k-char summary, under `bun 1.4.0`.
`bun run check` passed on `main` after the cherry-pick: 54 files, 1167 tests, 0 svelte-check errors.
Smoked live against a server on port 4199: `sessions/list` answered 314 summaries, `sessions/preview` of a stored Codex session answered 149 nodes with HTML on all 44 text parts, and an abort of a nonexistent session answered `code: 404` with the server's `not_found` text; clean exit on stdin EOF.

Left as built and noted here rather than filed: a seq gap on a session Emacs never attached still triggers an `api.attach`, as in the browser, which re-attaches a session the server already holds live; the attached set keeps a virtual ref's key after the rename until `sessions/close`, harmless.
Commits 701feb4, 3d9d697, ab1e95d, f6a1f4f, e5d75cf, ab0278c.
