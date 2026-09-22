---
labels: [change, emacs, emacs-native]
blocked-by: [OW-mutufa]
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

## Done when

Tests in `src/emacs/` drive the stdio loop against an injected fetch and event source, in node: a list request returns summaries; a preview request returns nodes, each text part carrying a non-empty `html` alongside its `text`, and opens no event stream; an attach followed by a snapshot and two upserts yields one `session/snapshot` and two `session/node` notifications in order; a `seq` gap yields a fresh snapshot; a `renamed` event yields `session/renamed` before the snapshot that follows it; a prompt whose server rejection arrives yields a JSON-RPC error carrying the server's text.
A framing test feeds two messages in one chunk and one message across two chunks and reads both back intact.
`bun run check` passes; `bun run test:browser` is not involved.
