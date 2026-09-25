/**
 * The node contract between agentpane and the native Emacs mode (OW-mutufa).
 *
 * FROZEN INTERFACE, in the sense of DESIGN D11: both ends are ours, the elisp
 * reads this as JSON with no type checker behind it, and this docblock is what
 * the elisp author reads. It names every field, its JSON type, and when it is
 * present; the TypeScript below says the same thing to the compiler. Change
 * the two together, and raise it before changing either. D24 raised it twice:
 * the `handle` every per-session notification carries, and every request
 * accepts, below (OW-suyinu); and the retirement of `session/renamed`, with
 * the snapshot `sessions/attach` sends for a ref it did not ask for moved
 * after its reply (OW-mofuho).
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
 *   including a call whose result never arrived in a finished turn. The
 *   state is as of the node's sending: no node is re-sent when streaming
 *   ends or a later node is appended, so the drawer applies the rule again
 *   and draws a held `"running"` as `"ok"` once either has happened. `diff`
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
 *   Codex does, Claude Code does on a model with effort, and Pi does on a
 *   model that reasons, for turns streamed live and for turns loaded from its
 *   store on a resume or after a fork alike: a loaded turn names the level
 *   its store recorded when it ran, and none where the store cannot say, as
 *   for a turn at `off` on a model other than the current one).
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
 * API's `SessionRef`; `handle` (string) is the session's
 * `SessionSummary.handle`, the name the server gave the live session: opaque,
 * never moved by a rename, and a different one for a fork (D24, OW-suyinu).
 * A rename is said by nothing else: the `session` of any notification under
 * a handle is the session's ref from then on.
 * Every per-session notification below carries it, absent only where the
 * server sent none, and every request that takes a `session` accepts one
 * beside it and sends it nowhere, `sessions/detach` and `sessions/close`
 * resolving the session by it; `compaction` is `"requesting"`, `"running"` or `null`;
 * `model` is a string or `null`; so is `effort`, the reasoning effort the
 * session's next turn runs at, `null` when the backend reports none; and so
 * is `unrestoredModel`, the model the session's store last recorded when the
 * backend did not restore it on a resume or a fork and `model` is another in
 * its place (D23, OW-jitoni), `null` otherwise. Only Pi reports one. It
 * outlives the first turn on `model`, which records `model` as though chosen,
 * and clears once a `sessions/setModel` succeeds.
 *
 * Requests, by `method`, with `params` and `result`:
 *
 * - `sessions/list` -- `{ cwd? }` -> array of `SessionSummary` (the HTTP
 *   listing, unchanged: `ref`, `cwd`, `preview`, `createdAt`, `updatedAt`,
 *   `status`, `isStreaming`, `onDisk`, and `handle` for a session the server
 *   holds, virtual or attached).
 * - `sessions/preview` -- `{ session }` -> array of nodes, read from the
 *   stored transcript; spawns nothing and opens no stream.
 * - `sessions/create` -- `{ cwd, backend, model? }` -> the new ref.
 * - `models/list` -- `{ backend }` -> array of `{ id, label, efforts,
 *   defaultEffort }`, the HTTP listing unchanged. `efforts` is an array of
 *   `{ id, description }`, the reasoning efforts that model accepts, empty
 *   when the model or its backend offers none -- and then there is no effort
 *   to choose; `defaultEffort` (string or `null`) is what the backend runs it
 *   at when none is chosen.
 * - `sessions/attach` -- `{ session }` -> the `SessionSummary` the attach
 *   route answers, carrying the session's `handle`. Its `ref` is
 *   authoritative and may differ from the one asked for; when it does, the
 *   `session/snapshot` under the new ref and the summary's `handle` follows
 *   the reply, unless the stream already carried the asked-for ref under that
 *   handle, or a `sessions/detach` for it landed while the attach was in
 *   flight. Notifications under the new ref that went out before the reply
 *   named a handle no buffer yet held; that snapshot supersedes them.
 *   Opens the event stream if it is not open yet, and from here on the
 *   notifications below flow for this session.
 * - `sessions/prompt` -- `{ session, text, images? }` -> `null`.
 * - `sessions/abort`, `sessions/compact`, `sessions/close` -- `{ session }`
 *   -> `null`. `close` kills the subprocess and stops this session's
 *   notifications, as `sessions/detach` below says which.
 * - `sessions/dismissError` -- `{ session, message }` -> `null`. Clears the
 *   session's turn error, so later `session/snapshot`s carry `error: null`,
 *   but only while `message` is still the error the server holds: a newer
 *   one survives the dismissal of the one Emacs was showing (OW-desufa).
 * - `sessions/detach` -- `{ session, handle? }` -> `null`. Stops this
 *   session's notifications and does nothing else: no HTTP call, and the
 *   session goes on running on the server. Sent when Emacs stops showing a
 *   session. With `handle`, the notifications under that handle stop,
 *   whatever ref `session` is; without, those for the session last named
 *   `session` to Emacs; and either way an attach of `session` still in
 *   flight.
 * - `sessions/setModel` -- `{ session, model }` -> `null`. A chosen effort the
 *   new model does not list falls back to that model's `defaultEffort`, or
 *   where that is `null` to whatever the backend then picks, which the
 *   `session/status` that follows reports.
 * - `sessions/setEffort` -- `{ session, effort }` -> `null`. `effort` is one of
 *   the session's model's `efforts` ids, taking effect from the next turn;
 *   the server refuses any other with a 400, and any at all while that
 *   model lists none or is not yet known.
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
 * - `session/snapshot` -- `{ session, handle, nodes, isStreaming, compaction,
 *   model, effort, unrestoredModel, error, requests, notices }`.
 *   Replaces everything the buffer holds; also how a session first appears
 *   after `sessions/attach`, and how a missed event is healed. The last three
 *   are what the server holds for the session, and what `session/error`,
 *   `session/request` and `session/notice` below have said, whether or not
 *   Emacs was attached to hear them (OW-bipume): `error` (string or `null`)
 *   the last turn error, `null` again once a later prompt is admitted or a
 *   client dismisses it; `requests` (array, always, possibly empty) every
 *   request still pending, oldest first, each the `request` a
 *   `session/request` carried; and `notices` (array, always, possibly empty)
 *   every notice, oldest first, each the `notice` a `session/notice` carried.
 *   The buffer draws all three after `nodes`, since a snapshot arrives at
 *   every Codex turn's start and end and would otherwise wipe them.
 * - `session/node` -- `{ session, handle, node }`. One node to replace by
 *   `index`.
 * - `session/status` -- `{ session, handle, isStreaming, compaction, model,
 *   effort, unrestoredModel }`.
 * - `session/error` -- `{ session, handle, message }`. A turn error. Every later
 *   `session/snapshot` carries it again, in `error`, until it is cleared.
 * - `session/request` -- `{ session, handle, request }`. The agent is blocked on a
 *   request nothing in Emacs answers yet: `request` is the HTTP API's
 *   `AgentRequest` unchanged -- `requestId`, `session`, `kind` (string, the
 *   backend's own method name) and `payload` -- and `issuerThreadId` where a
 *   Codex subagent issued it. Every later `session/snapshot` carries it
 *   again, in `requests`, until it stops being pending, which
 *   `session/requestResolved` says.
 * - `session/requestResolved` -- `{ session, handle, requestId }`. The request a
 *   `session/request` carried under `requestId` is no longer pending --
 *   answered, or resolved or declined without an answer (OW-gusifo). Drop
 *   its line; one Emacs never drew is nothing to drop.
 * - `session/notice` -- `{ session, handle, notice }`. Something non-fatal the
 *   backend said (OW-tujiya), never a turn error: `notice` is the HTTP API's
 *   `AgentNotice` unchanged -- `kind` (string, the backend's own name for
 *   it), `message` (string, the line to show), `details` (string or `null`,
 *   further guidance) and `path` (string or `null`, the file it is about,
 *   with `:LINE:COLUMN` where the backend named a place in it). Only the
 *   Codex adapter produces any. Every later `session/snapshot` carries it
 *   again, in `notices`.
 * - `sessions/changed` -- no `params`. Refetch the listing. Also sent each
 *   time the helper reopens a dropped event stream, since a listing change
 *   while it was down is gone.
 */

import type {
	AgentNotice,
	AgentRequest,
	AgentRequestReply,
	BackendId,
	CreateSessionRequest,
	DismissErrorRequest,
	ForkPoint,
	ForkRequest,
	ModelInfo,
	PromptRequest,
	SessionRef,
	SessionSummary,
} from "$shared/protocol.ts";

/** What a request names its session by: the ref, and the handle it may carry beside it. */
export interface SessionParams {
	session: SessionRef;
	handle?: string;
}

export interface HelperRequests {
	"sessions/list": { params: { cwd?: string }; result: SessionSummary[] };
	"sessions/preview": { params: SessionParams; result: TranscriptNode[] };
	"sessions/create": { params: CreateSessionRequest; result: SessionRef };
	"models/list": { params: { backend: BackendId }; result: ModelInfo[] };
	"sessions/attach": { params: SessionParams; result: SessionSummary };
	"sessions/prompt": { params: SessionParams & PromptRequest; result: null };
	"sessions/abort": { params: SessionParams; result: null };
	"sessions/compact": { params: SessionParams; result: null };
	"sessions/close": { params: SessionParams; result: null };
	"sessions/dismissError": { params: SessionParams & DismissErrorRequest; result: null };
	"sessions/detach": { params: SessionParams; result: null };
	"sessions/setModel": { params: SessionParams & { model: string }; result: null };
	"sessions/setEffort": { params: SessionParams & { effort: string }; result: null };
	"sessions/forkPoints": { params: SessionParams; result: ForkPoint[] };
	"sessions/fork": { params: SessionParams & ForkRequest; result: SessionRef };
	"requests/reply": { params: AgentRequestReply; result: null };
}

export interface SessionStatusParams {
	session: SessionRef;
	handle?: string;
	isStreaming: boolean;
	compaction: "requesting" | "running" | null;
	model: string | null;
	effort: string | null;
	unrestoredModel: string | null;
}

export type HelperNotification =
	| {
			method: "session/snapshot";
			params: SessionStatusParams & { nodes: TranscriptNode[]; error: string | null; requests: AgentRequest[]; notices: AgentNotice[] };
	  }
	| { method: "session/node"; params: { session: SessionRef; handle?: string; node: TranscriptNode } }
	| { method: "session/status"; params: SessionStatusParams }
	| { method: "session/error"; params: { session: SessionRef; handle?: string; message: string } }
	| { method: "session/request"; params: { session: SessionRef; handle?: string; request: AgentRequest } }
	| { method: "session/requestResolved"; params: { session: SessionRef; handle?: string; requestId: string } }
	| { method: "session/notice"; params: { session: SessionRef; handle?: string; notice: AgentNotice } }
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
