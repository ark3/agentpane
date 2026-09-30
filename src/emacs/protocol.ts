/**
 * The node contract between agentpane and the native Emacs mode (OW-mutufa).
 *
 * FROZEN INTERFACE, in the sense of DESIGN D11: both ends are ours, the elisp
 * reads this as JSON with no type checker behind it, and this docblock is what
 * the elisp author reads. It names every field, its JSON type, and when it is
 * present; the TypeScript below says the same thing to the compiler. Change
 * the two together, and raise it before changing either. D24 raised it twice:
 * the `handle` every per-session notification carries, and every request
 * accepts, below (OW-suyinu); and the retirement of `session/renamed`, whose
 * one use no other notification covered -- joining the ref an attach asked
 * for to the handle it was answered under -- `session/snapshot`'s
 * `askedFor` took over (OW-mofuho). OW-gusaru raised it a third time, for
 * `session/snapshot`'s `movedFrom`, and OW-yibijo a fourth, retiring
 * `movedFrom` for `session/detached`. OW-jokoto raised it a fifth, for the
 * `errorId` that names a turn error on `session/error` and
 * `session/snapshot`, and that `sessions/dismissError` and `sessions/prompt`
 * send back. OW-nufafi raised it a sixth, opening the event stream at the
 * first `sessions/list` as well as at the first `sessions/attach`, so
 * `sessions/changed` flows to a picker before anything is attached.
 * OW-mareju raised it a seventh, for `stream/changed`, which says the event
 * stream dropped and came back, where the helper had reopened it silently.
 * OW-filuge raised it an eighth, sending `session/detached` for a session
 * whose `seq` gapped, where the helper had attached it again. OW-mepufi
 * raised it a ninth, retiring `stream/changed`: the helper exits when its
 * event stream drops or its first open fails (D25 point 4), and reopens
 * nothing. OW-rebawa raised it a tenth: the reply to `sessions/attach` no
 * longer says a buffer is attached, only the `session/snapshot` that
 * answers the attach does; the reply goes out after that snapshot, or once
 * none will; and `askedFor` rides every snapshot that answers an attach,
 * one for each, whatever ref it names. OW-letevu raised it an eleventh,
 * retiring the request that answered an agent request, the two
 * notifications that published and retracted one, and `session/snapshot`'s
 * `requests`: agentpane never holds an agent request (D2a), so there is
 * nothing pending to carry or answer, and the refusal reaches Emacs as a
 * `session/error` naming the request's kind. OW-likopo raised it a twelfth,
 * under D26: `session/detached` for a handle the server let go of follows
 * the server's own `ended` under it, where it followed a listing the helper
 * asked at each `sessions/changed`; and `sessions/list` and
 * `sessions/attach` wait for the event stream's open before their own call.
 * OW-kutome raised it a thirteenth, for `session/detached`'s `cause`, which
 * tells the server letting go of the handle from a `seq` gap, since only
 * the first says a turn running under it is over. OW-wukako raised it a
 * fourteenth, correlating an attach by a token rather than by the ref it
 * asked for: `sessions/attach` carries a `token` agentpane-mode mints, the
 * snapshot that answers it carries that `token` where it carried
 * `askedFor`, and `sessions/detach` and `sessions/close` carry one too,
 * giving up that attach alone where they gave up every attach of the ref;
 * no snapshot answers an attach before its reply names the handle; and an
 * attach given up on while the stream's open is pending is never sent.
 * OW-linowe raised it a fifteenth: a `sessions/detach` or `sessions/close`
 * with no `handle` stops the attachment the snapshot answering its
 * `token`'s attach created, if that snapshot created one, where it stopped
 * whatever the helper had last named to Emacs by `session`, which another
 * buffer attached to that ref since could hold. OW-nowihu raised it a
 * sixteenth: `sessions/detach` and `sessions/close` carry `tokens`, every
 * attach their buffer sent and every one a buffer it absorbed sent, where
 * they carried one `token`, and stop the attachment under a handle once
 * every token answered under it is released, where the handle stopped it,
 * or without one the token whose answer created it.
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
 * included (OW-nowihu); `compaction` is `"requesting"`, `"running"` or `null`;
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
 *   holds, virtual or attached). Opens the event stream if it is not open
 *   yet, and waits for it to have opened before the listing is asked, and
 *   from here on `sessions/changed` flows, whether or not anything is
 *   attached.
 * - `sessions/preview` -- `{ session }` -> array of nodes, read from the
 *   stored transcript; spawns nothing and opens no stream. A session the
 *   server does not hold and no file backs answers an error whose `data`
 *   carries `error: "gone"` (D26 point 5); one it holds with nothing on
 *   disk yet answers no nodes.
 * - `sessions/create` -- `{ cwd, backend, model? }` -> the new ref.
 * - `models/list` -- `{ backend }` -> array of `{ id, label, efforts,
 *   defaultEffort }`, the HTTP listing unchanged. `efforts` is an array of
 *   `{ id, description }`, the reasoning efforts that model accepts, empty
 *   when the model or its backend offers none -- and then there is no effort
 *   to choose; `defaultEffort` (string or `null`) is what the backend runs it
 *   at when none is chosen.
 * - `sessions/attach` -- `{ session, token }` -> the `SessionSummary` the
 *   attach route answers, carrying the session's `handle`. `token`
 *   (integer, always) names this attach: agentpane-mode mints it, no two
 *   attaches it sends carry the same one, and the helper sends it nowhere
 *   but back, on the snapshot that answers this attach, and holds it to
 *   match a `sessions/detach` or `sessions/close` carrying it among its
 *   `tokens` (OW-wukako, OW-nowihu).
 *   The reply's `ref` is authoritative and may differ from the one asked
 *   for. The reply ends the request and says nothing about attachment:
 *   the session is attached from the `session/snapshot` that answers the
 *   attach, carrying its `token`, and only then (OW-rebawa). That is a
 *   snapshot under the handle the reply names, sent no earlier than the
 *   reply arrives, from the view the helper holds under that handle or,
 *   where it holds none yet, from the next snapshot to come under it; one
 *   that came under another handle, the same ref or not, answers nothing.
 *   The reply goes out after that snapshot, waiting for it where it is
 *   still on its way, so a reply that arrives with no snapshot having
 *   answered its attach means the helper expects none: a `seq` gap took
 *   the session's view after a snapshot under its handle came, and
 *   neither that snapshot nor a `session/detached` went out, a
 *   `sessions/detach` or `sessions/close` carrying this attach's token
 *   landed while it was in flight, the server ended the session's handle
 *   before its snapshot came, or the helper is exiting. The first can
 *   misjudge, whatever ref the attach asked for: a snapshot from
 *   elsewhere under the handle, ahead of the server handling this attach,
 *   then a gap, then the reply, leaves this attach's own snapshot to
 *   arrive after the reply and answer nothing. That takes a lost or
 *   malformed frame, and the session ends not attached, as after any gap
 *   (D25).
 *   Opens the event stream if it is not open yet, and waits for it to have
 *   opened before the attach is sent, as `sessions/list` does, so the
 *   snapshot that answers it reaches the helper; from here on the
 *   per-session notifications below flow for this session. One given up
 *   on while that open is pending is not sent at all, and answers a
 *   `-32603` error with no `data`: the server never saw it.
 * - `sessions/prompt` -- `{ session, text, images?, priorErrorId? }` ->
 *   `null`. `priorErrorId` (string or `null`) is the `errorId` of the turn
 *   error the buffer held when the user sent, `null` when it held none, read
 *   before any `sessions/attach` the send itself makes: admitting the prompt
 *   clears the session's error only while it is still that one, so an error
 *   raised after the send, that attach's start among them, stays
 *   (OW-jokoto). Absent, the server takes whatever error it holds when the
 *   prompt arrives.
 * - `sessions/abort`, `sessions/compact` -- `{ session }` -> `null`.
 * - `sessions/close` -- `{ session, handle?, tokens? }` -> `null`. Kills the
 *   subprocess, then gives up and releases the attaches `tokens` names, as
 *   `sessions/detach` below says; the server's `ended` for the handle
 *   stops this session's notifications whatever claims still stand.
 * - `sessions/dismissError` -- `{ session, errorId }` -> `null`. Clears the
 *   session's turn error, so later `session/snapshot`s carry `error: null`,
 *   but only while `errorId` (string) still names the error the server
 *   holds: a newer one survives the dismissal of the one Emacs was showing
 *   (OW-desufa), even one with the same text (OW-jokoto).
 * - `sessions/detach` -- `{ session, handle?, tokens? }` -> `null`. Stops
 *   showing a session, and does nothing else: no HTTP call, and the
 *   session goes on running on the server. Sent when Emacs stops showing a
 *   session. `tokens` (array of integers, absent meaning none) names every
 *   `sessions/attach` the buffer sent since it last closed a session and
 *   every one a buffer it absorbed sent. Each that no snapshot has
 *   answered and whose reply has not gone out yet is given up: its reply
 *   goes out, and nothing answers it. No other attach is, another of the
 *   same ref included. Each answered under a handle releases its claim
 *   there, and the notifications under a handle stop once every attach
 *   answered under it is released, whichever buffer releases last
 *   (OW-nowihu). A claim goes with the handle's notifications, so a token
 *   answered under a handle whose notifications stopped since -- a
 *   detach, a close or a `session/detached` -- releases nothing. `handle`
 *   and `session` pick out no notifications. Until OW-nowihu `token` named
 *   one attach, and `handle` stopped the notifications under it, or
 *   without one the handle of the snapshot answering that attach, if
 *   nothing was attached under it before (OW-linowe). What stays is named
 *   at `forget` in helper.ts.
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
 *
 * Errors: a request the server refused answers with the HTTP status as
 * `code`, the server's text as `message`, and `{ status, error, detail }` as
 * `data`, `error` and `detail` being the HTTP body's own fields, so a
 * mid-turn prompt rejection reads in Emacs as it does in the browser. Any
 * other failure is `-32603` with its message and no `data`, and says nothing
 * of whether the server acted on the request; an unknown method is
 * `-32601`. A request the helper's own teardown aborts, at the end of its
 * input or a drop of the event stream, gets no reply at all (`runHelper` in
 * helper.ts): Emacs answers it as the helper's death (OW-hiliti).
 *
 * Notifications, by `method`, with `params`; each names the session it is
 * about, and none arrives for a session Emacs has not attached, except
 * `sessions/changed`; the first under a handle is the `session/snapshot`
 * that attaches it:
 *
 * - `session/snapshot` -- `{ session, handle, nodes, isStreaming, compaction,
 *   model, effort, unrestoredModel, error, errorId, notices }`.
 *   Replaces everything the buffer holds; also how a session first appears
 *   after `sessions/attach`, and how a missed event is healed. `error` and
 *   `notices` are what the server holds for the session, and what
 *   `session/error` and `session/notice` below have said, whether or not
 *   Emacs was attached to hear them (OW-bipume): `error` (string or `null`)
 *   the last turn error, `null` again once the server clears it, which
 *   `session/errorCleared` says, with `errorId` (string, or `null` exactly
 *   when `error` is) naming it as `session/error` does; and `notices`
 *   (array, always, possibly empty) every notice, oldest first, each the
 *   `notice` a `session/notice` carried.
 *   The buffer draws both after `nodes`, since a snapshot replaces
 *   everything the buffer holds and would otherwise wipe them.
 *   `token` (integer, only on a snapshot that answers a
 *   `sessions/attach`, one such snapshot for each attach it answers) is
 *   the `token` that attach carried, whatever ref it asked for and the
 *   snapshot names (OW-wukako). It is request correlation, not identity:
 *   it says which waiting attach this snapshot answers, so the receiver can
 *   bind the handle to what sent that attach -- which may hold another
 *   ref, the ref of a session another buffer holds under that handle, or
 *   a handle of its own already -- and is the only thing that does, the
 *   reply binding nothing (OW-rebawa). Until OW-wukako it was `askedFor`,
 *   the ref asked for, which two attaches of one ref shared. Nor could the
 *   receiver rely on handling
 *   the reply first -- as of jsonrpc.el 1.0.29 on Emacs 31.1, the reply to
 *   an asynchronous request that arrives while a synchronous one is
 *   outstanding runs only once that one returns, while notifications are
 *   handled at once (docs/MANUAL_TESTING.md, "jsonrpc.el runs an async reply
 *   after later notifications").
 * - `session/node` -- `{ session, handle, node }`. One node to replace by
 *   `index`.
 * - `session/status` -- `{ session, handle, isStreaming, compaction, model,
 *   effort, unrestoredModel }`.
 * - `session/error` -- `{ session, handle, message, errorId }`. A turn error.
 *   `errorId` (string, opaque) names this raise: two with the same
 *   `message` are two errors, and `sessions/dismissError` and
 *   `sessions/prompt` name the one the buffer showed by it (OW-jokoto). No
 *   server mints one twice, a restarted one included, so one a buffer kept
 *   across a restart names nothing the new process raised. Every later
 *   `session/snapshot` carries it again, in `error` and `errorId`, until it
 *   is cleared, which `session/errorCleared` says.
 * - `session/errorCleared` -- `{ session, handle }`. The server no longer
 *   holds the session's turn error: a prompt was admitted over it, it being
 *   still the one its sender held, or a client dismissed it by its
 *   `errorId` (OW-jopifu, OW-jokoto). Drop its line. It follows every
 *   snapshot sent before the clear on the one ordered stream, so a line such
 *   a snapshot drew again goes with it; one Emacs never drew is nothing to
 *   drop.
 * - `session/notice` -- `{ session, handle, notice }`. Something non-fatal the
 *   backend said (OW-tujiya), never a turn error: `notice` is the HTTP API's
 *   `AgentNotice` unchanged -- `kind` (string, the backend's own name for
 *   it), `message` (string, the line to show), `details` (string or `null`,
 *   further guidance) and `path` (string or `null`, the file it is about,
 *   with `:LINE:COLUMN` where the backend named a place in it). Only the
 *   Codex adapter produces any. Every later `session/snapshot` carries it
 *   again, in `notices`.
 * - `session/detached` -- `{ session, handle, cause }`. Nothing more comes
 *   under `handle`, and the helper has dropped the attachment: either the
 *   server let go of the handle and said so with an `ended` under it -- a
 *   close, by another client or this one, or on Pi a fork moving the
 *   process onto a conversation of its own (D26) -- and `cause` is
 *   `"ended"`, or the session's `seq` gapped, and the helper detaches that
 *   one session rather than attach it again (D25 point 5, OW-filuge), and
 *   `cause` is `"gapped"`: the handle stays live on the server, and a turn
 *   running under it may go on unheard. `session` is the ref it last named
 *   the session by. The buffer holding `handle` lets go of it and counts
 *   itself detached and not streaming, keeping its ref and what it drew;
 *   its next `sessions/attach`, by that ref, is answered under whatever
 *   handle and ref the session has now, if any, as a first attach is.
 * - `sessions/changed` -- no `params`. Refetch the listing. A listing
 *   detaches nothing: where the server lets go of a handle Emacs attached,
 *   the `session/detached` for it goes out ahead of the `sessions/changed`
 *   the same close or fork sends.
 *
 * No notification says the event stream dropped. When it does, or its first
 * open fails, the helper exits (D25 point 4, OW-mepufi), and Emacs sees its
 * process end. A failed first open first answers each `sessions/list` and
 * `sessions/attach` waiting on it with an error saying the server could not
 * be reached, carrying no `data` (OW-pezelo).
 */

import type {
	AgentNotice,
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
	"sessions/attach": { params: SessionParams & { token: number }; result: SessionSummary };
	"sessions/prompt": { params: SessionParams & PromptRequest; result: null };
	"sessions/abort": { params: SessionParams; result: null };
	"sessions/compact": { params: SessionParams; result: null };
	"sessions/close": { params: SessionParams & { tokens?: number[] }; result: null };
	"sessions/dismissError": { params: SessionParams & DismissErrorRequest; result: null };
	"sessions/detach": { params: SessionParams & { tokens?: number[] }; result: null };
	"sessions/setModel": { params: SessionParams & { model: string }; result: null };
	"sessions/setEffort": { params: SessionParams & { effort: string }; result: null };
	"sessions/forkPoints": { params: SessionParams; result: ForkPoint[] };
	"sessions/fork": { params: SessionParams & ForkRequest; result: SessionRef };
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
			params: SessionStatusParams & {
				nodes: TranscriptNode[];
				error: string | null;
				errorId: string | null;
				notices: AgentNotice[];
				token?: number;
			};
	  }
	| { method: "session/node"; params: { session: SessionRef; handle?: string; node: TranscriptNode } }
	| { method: "session/status"; params: SessionStatusParams }
	| { method: "session/error"; params: { session: SessionRef; handle?: string; message: string; errorId: string } }
	| { method: "session/errorCleared"; params: { session: SessionRef; handle?: string } }
	| { method: "session/notice"; params: { session: SessionRef; handle?: string; notice: AgentNotice } }
	| { method: "session/detached"; params: { session: SessionRef; handle: string; cause: "ended" | "gapped" } }
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
