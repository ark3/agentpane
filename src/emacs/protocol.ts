/**
 * The node contract between agentpane and the native Emacs mode (OW-mutufa).
 *
 * FROZEN INTERFACE, in the sense of DESIGN D11: both ends are ours, the elisp
 * reads this as JSON with no type checker behind it, and this docblock is what
 * the elisp author reads. It names every field, its JSON type, and when it is
 * present; the TypeScript below says the same thing to the compiler. Change
 * the two together, and raise it before changing either.
 *
 * A transcript projects to a JSON array of **nodes**, one per visible
 * transcript entry, in transcript order. The Emacs buffer draws one section
 * per node and replaces a node in place when a streaming turn re-sends it.
 *
 * Node -- an object with these fields:
 *
 * - `index` (integer, always). The position of this entry in the session's
 *   flat message array -- the very number a `snapshot`'s `messages` is indexed
 *   by, an `upsert.index` addresses, and a fork point's `index` names. Tool
 *   results folded into their calls have no node, so consecutive nodes can
 *   skip indices. Replace by `index`, never by array position.
 * - `role` (string, always). One of `"user"`, `"assistant"`, `"tool-result"`
 *   (a result whose call is not in the transcript -- a truncated or forked
 *   slice can start mid-turn), `"compactionSummary"` (the seam the backend
 *   folded its context at), or another backend-defined role the elisp should
 *   draw generically.
 * - `parts` (array, always, possibly empty). The node's content in display
 *   order; each element is one of the parts below, told apart by `type`.
 * - `meta` (object, only on `role: "assistant"`). The turn's footer facts,
 *   present on every assistant node including a streaming one; see below.
 * - `timestamp` (number, only on `role: "user"` and `role: "assistant"`, and
 *   only when the message carries a usable one). When the message happened,
 *   as epoch milliseconds, exactly as the message holds it; the drawer
 *   formats it in its own zone, as the browser's `formatTimestamp` does in
 *   the browser's. Absent for a stored turn whose record had no time.
 * - `tokensBefore` (integer, only on `role: "compactionSummary"`, always
 *   there). The context size the backend folded, `0` when it reported none;
 *   the browser's marker names it only when it is above `0`.
 *
 * Parts, by `type`:
 *
 * - `{ type: "text", text, html }` -- `text` (string) is markdown source,
 *   exactly as the model wrote it; `html` (string) is the sanitized HTML the
 *   browser renders for that markdown, the very string `renderMarkdown` in
 *   `$client/render/markdown.ts` returns, for the buffer to draw through
 *   `shr` (D22, OW-refibu). Empty when `text` is empty.
 *   A `compactionSummary` node carries its summary as one of these when the
 *   backend supplied any; a role the projection does not know carries the
 *   whole message as JSON text so nothing is silently dropped.
 * - `{ type: "thinking", text, redacted }` -- `text` (string) is the thinking
 *   as streamed, empty when `redacted` (boolean) is true and the provider
 *   withheld it. `text` may also be empty with `redacted` false: Pi emits
 *   thinking blocks carrying only a signature, and the browser draws nothing
 *   for such a part unless the turn is still streaming.
 * - `{ type: "tool", name, summary, args, result, state, timestamp?,
 *   images?, diff? }` -- one tool call with its answer folded in. `name`
 *   (string) is the backend's own tool name, casing preserved. `summary`
 *   (string) is the one-line description the browser's tool card shows in
 *   its header: the command for a shell, the basename and line counts for a
 *   file tool, the arguments otherwise; may be empty. `args` (string) is the
 *   call's arguments pretty-printed as JSON, empty when there were none.
 *   `result` (string) is the text of the result, empty when none has
 *   arrived. `timestamp` (number) is the result's own, epoch milliseconds
 *   like a node's, present only once a result carrying a usable one has
 *   arrived; the browser shows it in the card's body. `images` (array) is
 *   the result's image parts in order, each an `image` part as below,
 *   present only when the result has any: Pi's `read` answers an image path
 *   with one. `state` (string) is `"running"` while the session is streaming, the
 *   call's node is the last one, and no result has arrived -- the browser's
 *   own rule; `"error"` when the result reported failure; `"ok"` otherwise,
 *   including a call whose result never arrived in a finished turn. `diff`
 *   (array) is present only for a call named `edit` or `write`
 *   (case-insensitive), as `{ type, text }` lines where `type` is `"add"`,
 *   `"del"`, `"ctx"` (unchanged, kept as context), or `"gap"` (a marker
 *   standing in for a run of unchanged lines; its `text` says how many). For
 *   `edit` it is the unified diff the browser draws. For `write` it is the
 *   whole written content as `"add"` lines: the browser shows a write as
 *   plain content, never a diff, and the lines are here so one drawer serves
 *   both. An orphan `tool-result` node carries one of these parts too, with
 *   `args` empty and no `diff`.
 * - `{ type: "image", mimeType, data }` -- an image the user attached, or
 *   one in a tool result's `images`.
 *   `mimeType` (string) such as `"image/png"`; `data` (string) is base64.
 *
 * Meta -- the object under an assistant node's `meta`:
 *
 * - `model` (string, always; may be empty when the backend reported none).
 * - `effort` (string, only when the backend reported a reasoning effort;
 *   Codex does, others do not).
 * - `usage` (object, always): `totalTokens` (integer) and `cost` (number, in
 *   dollars); both are `0` when the backend reports no accounting.
 * - `stopReason` (string, only when the turn ended badly): `"error"` or
 *   `"aborted"`. Absent for a turn that finished normally or is still
 *   streaming; a streaming turn is recognised by the projection still
 *   re-sending the node, not by anything in it.
 * - `errorMessage` (string, only when the backend supplied one alongside
 *   `stopReason: "error"`).
 *
 * ---------------------------------------------------------------------------
 *
 * The JSON-RPC 2.0 link the helper speaks (OW-refibu), `Content-Length`
 * framed over stdio as `jsonrpc-process-connection` expects. Emacs sends
 * requests; the helper answers each and pushes notifications on its own.
 * `session` in every payload is a ref, `{ backend, id }`, exactly as the HTTP
 * API's `SessionRef`; `compaction` is `"requesting"`, `"running"` or `null`;
 * `model` is a string or `null`.
 *
 * Requests, by `method`, with `params` and `result`:
 *
 * - `sessions/list` -- `{ cwd? }` -> array of `SessionSummary` (the HTTP
 *   listing, unchanged: `ref`, `cwd`, `preview`, `createdAt`, `updatedAt`,
 *   `status`, `isStreaming`).
 * - `sessions/preview` -- `{ session }` -> array of nodes, read from the
 *   stored transcript; spawns nothing and opens no stream.
 * - `sessions/create` -- `{ cwd, backend, model? }` -> the new ref.
 * - `models/list` -- `{ backend }` -> array of `{ id, label }`.
 * - `sessions/attach` -- `{ session }` -> the `SessionSummary` the attach
 *   route answers, whose `ref` is authoritative and may differ from the one
 *   asked for; when it does, a `session/renamed` from the one asked for has
 *   gone out before the reply, from the stream or else from the helper,
 *   unless a `sessions/detach` for it landed while the attach was in flight.
 *   Opens the event stream if it is not open yet, and from here on the
 *   notifications below flow for this session.
 * - `sessions/prompt` -- `{ session, text, images? }` -> `null`.
 * - `sessions/abort`, `sessions/compact`, `sessions/close` -- `{ session }`
 *   -> `null`. `close` kills the subprocess and stops this session's
 *   notifications.
 * - `sessions/detach` -- `{ session }` -> `null`. Stops this session's
 *   notifications and does nothing else: no HTTP call, and the session goes
 *   on running on the server. Sent when Emacs stops showing a session.
 * - `sessions/setModel` -- `{ session, model }` -> `null`.
 * - `sessions/forkPoints` -- `{ session }` -> array of `{ id, text, index }`.
 * - `sessions/fork` -- `{ session, entryId }` -> the fork's ref.
 * - `requests/reply` -- `{ requestId, response }` -> `null`.
 *
 * Errors: a request the server refused answers with the HTTP status as
 * `code`, the server's text as `message`, and `{ status, error, detail }` as
 * `data`, `error` and `detail` being the HTTP body's own fields, so a
 * mid-turn prompt rejection reads in Emacs as it does in the browser. Any
 * other failure is `-32603` with its message; an unknown method is `-32601`.
 *
 * Notifications, by `method`, with `params`; each names the session it is
 * about, and none arrives for a session Emacs has not attached, except
 * `sessions/changed`:
 *
 * - `session/snapshot` -- `{ session, nodes, isStreaming, compaction, model }`.
 *   Replaces everything the buffer holds; also how a session first appears
 *   after `sessions/attach`, and how a missed event is healed.
 * - `session/node` -- `{ session, node }`. One node to replace by `index`.
 * - `session/status` -- `{ session, isStreaming, compaction, model }`.
 * - `session/error` -- `{ session, message }`. A turn error, or an agent
 *   request nothing in Emacs answers yet, as text saying what kind arrived.
 *   Not carried by a snapshot, so a re-snapshot does not replay it.
 * - `session/renamed` -- `{ from, to }`. Re-key the buffer; a
 *   `session/snapshot` for `to` follows.
 * - `sessions/changed` -- no `params`. Refetch the listing. Also sent each
 *   time the helper reopens a dropped event stream, since a listing change
 *   while it was down is gone.
 */

import type {
	AgentRequestReply,
	BackendId,
	CreateSessionRequest,
	ForkPoint,
	ForkRequest,
	ModelInfo,
	PromptRequest,
	SessionRef,
	SessionSummary,
} from "$shared/protocol.ts";

export interface HelperRequests {
	"sessions/list": { params: { cwd?: string }; result: SessionSummary[] };
	"sessions/preview": { params: { session: SessionRef }; result: TranscriptNode[] };
	"sessions/create": { params: CreateSessionRequest; result: SessionRef };
	"models/list": { params: { backend: BackendId }; result: ModelInfo[] };
	"sessions/attach": { params: { session: SessionRef }; result: SessionSummary };
	"sessions/prompt": { params: { session: SessionRef } & PromptRequest; result: null };
	"sessions/abort": { params: { session: SessionRef }; result: null };
	"sessions/compact": { params: { session: SessionRef }; result: null };
	"sessions/close": { params: { session: SessionRef }; result: null };
	"sessions/detach": { params: { session: SessionRef }; result: null };
	"sessions/setModel": { params: { session: SessionRef; model: string }; result: null };
	"sessions/forkPoints": { params: { session: SessionRef }; result: ForkPoint[] };
	"sessions/fork": { params: { session: SessionRef } & ForkRequest; result: SessionRef };
	"requests/reply": { params: AgentRequestReply; result: null };
}

export interface SessionStatusParams {
	session: SessionRef;
	isStreaming: boolean;
	compaction: "requesting" | "running" | null;
	model: string | null;
}

export type HelperNotification =
	| { method: "session/snapshot"; params: SessionStatusParams & { nodes: TranscriptNode[] } }
	| { method: "session/node"; params: { session: SessionRef; node: TranscriptNode } }
	| { method: "session/status"; params: SessionStatusParams }
	| { method: "session/error"; params: { session: SessionRef; message: string } }
	| { method: "session/renamed"; params: { from: SessionRef; to: SessionRef } }
	| { method: "sessions/changed"; params?: undefined };

export interface TranscriptNode {
	index: number;
	role: string;
	parts: NodePart[];
	meta?: TurnMeta;
	timestamp?: number;
	tokensBefore?: number;
}

export type NodePart = TextPart | ThinkingPart | ToolPart | ImagePart;

export interface TextPart {
	type: "text";
	text: string;
	html: string;
}

export interface ThinkingPart {
	type: "thinking";
	text: string;
	redacted: boolean;
}

export interface ToolPart {
	type: "tool";
	name: string;
	summary: string;
	args: string;
	result: string;
	state: "running" | "ok" | "error";
	timestamp?: number;
	images?: ImagePart[];
	diff?: NodeDiffLine[];
}

export interface NodeDiffLine {
	type: "add" | "del" | "ctx" | "gap";
	text: string;
}

export interface ImagePart {
	type: "image";
	mimeType: string;
	data: string;
}

export interface TurnMeta {
	model: string;
	effort?: string;
	usage: { totalTokens: number; cost: number };
	stopReason?: "error" | "aborted";
	errorMessage?: string;
}
