/**
 * The wire contract between the server and its clients, the browser and the
 * Emacs helper.
 *
 * FROZEN INTERFACE (DESIGN D11). Both ends of the transport are ours and are
 * written by different people at different times, so this is the one place
 * DESIGN asks for concreteness rather than judgement. Changing anything here
 * breaks work in flight -- raise it before editing. D24 raised it twice: the
 * `handle` on `SessionSummary` and beside `session` on every per-session
 * event (OW-suyinu), and the retirement of the event that had said a rename,
 * once both clients keyed by that handle (OW-mofuho). D27 raised it for
 * `SessionSummary.name` and the command that sets it (OW-jamaha). D31 raised it
 * for the socket's frames (ark3/agentpane#52), and again to retire the event
 * stream and the REST routes once no client used them (ark3/agentpane#55).
 *
 * Shape follows D31 (one WebSocket carries commands in, and replies and
 * events out) and D3 (the server is authoritative; it sends assembled state,
 * never raw backend protocol events).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * An assistant turn, plus the level it ran at, as the footer names it.
 *
 * Codex answers `thread/start` and `thread/resume` with `reasoningEffort`, and
 * a reader wants it next to the model name. When this was written
 * `AssistantMessage` carried api/provider/model/responseModel/usage/stopReason/
 * timestamp and nothing about effort, and D10 makes the pi packages types-only
 * -- so the field cannot be added there, and augmenting their interfaces from
 * here would put an agentpane-only property on every consumer of pi-ai. One
 * optional property on a type we own is the smallest shape that does the job,
 * and it survives the JSON round trip on the existing `AgentMessage` payloads
 * untouched.
 *
 * As of `pi-ai 1.2.0` `AssistantMessage` declares `thinkingLevel?`, the Pi
 * level the agent loop requested, and `providerThinkingLevel?`, the provider's
 * own effort string, both absent on replies that predate them (OW-zarine).
 * `effort` stays: Codex's turns carry neither, and a Pi reply without the stamp
 * is named from its session's entries, so the footer reads one field whoever
 * filled it.
 *
 * Named `effort`, not `reasoningEffort`: Codex uses both names for the same
 * concept (`reasoningEffort` on the start/resume responses, `effort` on
 * `ThreadSettings`) and the shorter one is what the meta line shows.
 */
export interface AssistantTurn extends AssistantMessage {
	effort?: string;
}

/**
 * `AgentMessage` with that widened assistant arm -- what the transport actually
 * carries. `Exclude` rather than a hand-written union so the openness of
 * `AgentMessage` (`Message | CustomAgentMessages[keyof CustomAgentMessages]`)
 * survives: a backend can still declaration-merge new message kinds in.
 *
 * Mutually assignable with `AgentMessage`, since `effort` is optional. That is
 * deliberate: every producer and consumer in between can keep saying
 * `AgentMessage`, and only the two ends that care need to name this.
 */
export type PaneMessage = Exclude<AgentMessage, AssistantMessage> | AssistantTurn;

// ---------------------------------------------------------------------------
// Sessions (D9)
// ---------------------------------------------------------------------------

export type BackendId = "pi" | "codex" | "claude";

/**
 * A session is identified by backend *and* id, because each backend has its
 * own store: Pi's id is a JSONL path, Codex's is a UUIDv7 thread id, and
 * Claude Code's is the session uuid its store file is named after
 * (enumeration via OW-votasi, adapter via OW-beripo).
 */
export interface SessionRef {
	backend: BackendId;
	id: string;
}

/**
 * - `virtual`  workspace chosen, nothing on disk yet; stays so until its first prompt (D9)
 * - `detached` exists in the backend's store, no subprocess running
 * - `attached` live subprocess
 */
export type SessionStatus = "virtual" | "detached" | "attached";

export interface SessionSummary {
	ref: SessionRef;
	/** Absolute workspace path. Null for sessions whose header predates the cwd field. */
	cwd: string | null;
	/** First user message, trimmed for display. Null if not yet determined. */
	preview: string | null;
	/** ISO-8601. Null when the backend's header does not carry one. */
	createdAt: string | null;
	updatedAt: string | null;
	status: SessionStatus;
	/** True while this session's agent is mid-turn. */
	isStreaming: boolean;
	/**
	 * Whether the backend's store has this session, which is what a read-only
	 * preview and a re-attach both read. Not the id and not `status`: a session
	 * created here is renamed at attach and is not on disk until a turn writes
	 * it, and whether a fork has a file yet depends on the backend and the fork
	 * point (D9). True once the session index has listed it; a fork starts false.
	 */
	onDisk: boolean;
	/**
	 * The session's name as the backend holds it (D27), null for none. For an
	 * attached session, the one its backend last reported to the adapter, at
	 * attach or by its rename event (`AdapterState.name`), which a change
	 * sends `sessions-changed` for; agentpane keeps no copy of its own
	 * (D13, "Names are not marks"), so a detached session's is what the store
	 * walk reads, and as of OW-jamaha the walk reads none.
	 */
	name: string | null;
	/**
	 * The name the server gave the live session holding this conversation (D24,
	 * OW-suyinu): opaque, never minted twice, even by a restarted server, and
	 * never changed by a rename, which is what `ref` does. Present for a session the server
	 * holds, virtual or attached; absent for one only the backend's store knows.
	 * Every per-session `ServerEvent` carries the same string. A Pi fork is
	 * another conversation and gets another handle; the parent's is gone.
	 */
	handle?: string;
}

/** The summary of a session the server holds, which always carries its handle: what an attach answers. */
export type LiveSessionSummary = SessionSummary & { handle: string };

/**
 * Something the backend wants the human to know that is not a failure and not
 * transcript state (OW-tujiya): Codex's `warning`, `guardianWarning`,
 * `deprecationNotice` and `configWarning` notifications, and every `notify` a
 * Pi extension sends (D11, OW-fusoba). On 2026-09-24, with `codex-cli 0.156.0`
 * installed, none of the home server's 119 rollouts held a warning or error
 * event type, so a rollout is not known to reveal one after the fact.
 *
 * `kind` is the backend's own method name, not normalised. `message` is the
 * text to show, and may span lines -- a Pi command's `notify` can list one item
 * a line -- which each client draws as lines; `details` is the backend's
 * further guidance, and `path` the file the notice is about, with
 * `:LINE:COLUMN` appended where the backend named a place in it -- each null
 * when the backend sent none.
 */
export interface AgentNotice {
	kind: string;
	message: string;
	details: string | null;
	path: string | null;
}

// ---------------------------------------------------------------------------
// Events: server -> client
// ---------------------------------------------------------------------------

/**
 * Every session's events on one socket, each naming its session (D31).
 *
 * `seq` is monotonic *per session*. A gap means the client missed an update;
 * since D25 the client, the browser or the Emacs helper, detaches the
 * session. Snapshots reset the sequence. `ended` alone carries none (D26).
 *
 * Every arm but `sessions-changed` carries `handle` beside `session`: the
 * session's `SessionSummary.handle`, which a rename leaves alone while `session`
 * moves (D24, OW-suyinu). The counter `seq` counts is the handle's. The
 * browser's reducer keys every live view by it (OW-kimaya), so an event under
 * a handle it holds updates that view's ref as an ordinary attribute.
 *
 * That is all a rename is on the wire, and it is not an edge case but the
 * normal life of a new session: every backend replaces a `virtual` session's
 * minted id at attach, and the first prompt may move it again (D9), so the id
 * a client created a session with is not the id it keeps. Each time, a
 * `snapshot` under the handle carrying the new ref goes out, and every event
 * after it carries that ref. The old id reaches nothing from then on (D35
 * point 1): a command naming it is refused `not_found`, or `gone` for a
 * preview, so a client takes the new ref from the first event that carries it.
 */
export type ServerEvent =
	| {
			type: "snapshot";
			session: SessionRef;
			handle: string;
			seq: number;
			messages: PaneMessage[];
			isStreaming: boolean;
			compaction: "requesting" | "running" | null;
			model: string | null;
			/** The reasoning effort governing the conversation's next turn, or null when there is none to report. */
			effort: string | null;
			/**
			 * The model the conversation's store last recorded, when the backend
			 * did not restore it on a resume or fork and `model` is another in its
			 * place (D23, OW-jitoni); null otherwise. Only Pi reports one. It
			 * outlives the first turn on `model`, which records `model` as though
			 * chosen, and clears once a model is set.
			 */
			unrestoredModel: string | null;
			/**
			 * What the `error` and `notice` events below have told the
			 * session's clients so far, as the server still holds it (OW-bipume):
			 * the last turn error, null once the server clears it, which
			 * `error-cleared` says; and every notice, oldest first. Here because
			 * a snapshot is the only thing that introduces a session to a client,
			 * so one that connects, reconnects or first attaches after the event
			 * went out learns of it nowhere else. A client takes both from
			 * here, replacing what it held.
			 */
			error: string | null;
			/**
			 * Which raise `error` is, as the `error` event that announced it
			 * named it; null exactly when `error` is. What a client names the
			 * error by when it dismisses it or prompts over it (OW-jokoto).
			 */
			errorId: string | null;
			notices: AgentNotice[];
	  }
	| {
			/**
			 * Streaming only ever touches the tail, and completed messages are
			 * immutable -- so a token costs the same whatever the transcript's
			 * length, though it re-sends the whole message so far (D3).
			 * `index` may equal messages.length to append.
			 */
			type: "upsert";
			session: SessionRef;
			handle: string;
			seq: number;
			index: number;
			message: PaneMessage;
	  }
	| { type: "status"; session: SessionRef; handle: string; seq: number; isStreaming: boolean; compaction: "requesting" | "running" | null; model: string | null; effort: string | null; unrestoredModel: string | null }
	| {
			/**
			 * A turn ended in an error the transcript alone would not convey.
			 * `errorId` names this raise: two errors with the same `message` are
			 * still two errors, and a client names the one it showed by this when
			 * it dismisses it (`DismissErrorRequest`) or prompts over it
			 * (`PromptRequest.priorErrorId`) (OW-lameke, OW-jokoto). Opaque, and
			 * never minted twice, not even by a restarted server: a client holds
			 * it across a restart, as it does a handle (OW-kimaya).
			 */
			type: "error";
			session: SessionRef;
			handle: string;
			seq: number;
			message: string;
			errorId: string;
	  }
	| {
			/**
			 * The server no longer holds the session's turn error: a prompt that
			 * started or joined a turn was admitted over it, or a client dismissed
			 * it (`sessions/dismissError`) (OW-jopifu). Drop it. What lets a client learn an
			 * error went without a snapshot, which no longer arrives at every prompt
			 * (OW-yirosu). Carries no message:
			 * the socket is ordered, so the error a client holds from it when
			 * this arrives is the one the server cleared, and a newer one comes
			 * after it.
			 */
			type: "error-cleared";
			session: SessionRef;
			handle: string;
			seq: number;
	  }
	| {
			/**
			 * A non-fatal notice from the backend (OW-tujiya). Not an `error`: it
			 * says nothing about whether a turn failed, and a client neither
			 * clears nor sets its error from it. Like `error`, every later snapshot
			 * carries it again, in `notices`.
			 *
			 * Per session, not D13's session-less `notice` arm: a Codex notice
			 * comes from the app-server that session runs on, and one shown beside
			 * a Pi session would be about a process that session does not have.
			 */
			type: "notice";
			session: SessionRef;
			handle: string;
			seq: number;
			notice: AgentNotice;
	  }
	| {
			/**
			 * The server let go of the live session under `handle` -- a close, or
			 * on Pi a fork moving the process onto a conversation of its own --
			 * and nothing goes out under it again (D26, OW-sodohi). Drop the view.
			 * One a fork sends names no fork: the parent's ref is all it carries
			 * (OW-suhoto).
			 *
			 * No `seq`: one would have to come from the counter the server has
			 * just dropped for the handle, recreating it (`submit` in
			 * `session-manager.ts`), so a client applies this whatever the
			 * handle's sequence stands at. Nor does it say whether anything is
			 * left on disk, which is the preview's to answer.
			 */
			type: "ended";
			session: SessionRef;
			handle: string;
	  }
	/** The session list changed (created, deleted, or newly attached). Refetch it. */
	| { type: "sessions-changed" };

// ---------------------------------------------------------------------------
// What each command takes and answers (`Commands`, below)
// ---------------------------------------------------------------------------

/** `sessions/list` -- omit cwd for every session everywhere. */
export interface ListSessionsQuery {
	cwd?: string;
}
export interface ListSessionsResponse {
	sessions: SessionSummary[];
}

/**
 * `sessions/create` -- creates a `virtual` session and starts its agent, as
 * one operation (D30): it answers once the session is attached, with its live
 * summary, as an attach does, and nothing hits disk until its
 * first turn (D9). A start that fails is refused as an attach's would be and
 * leaves nothing behind -- no session, no name, no row -- so a retry is a new
 * create.
 */
export interface CreateSessionRequest {
	cwd: string;
	backend: BackendId;
	model?: string;
}
export interface CreateSessionResponse {
	session: LiveSessionSummary;
}

/**
 * `sessions/attach` -- "open this session": spawns if needed and snapshots
 * to every client. It, the create above and a prompt naming a ref are the
 * only commands that spawn (D25, D30): every other command on a session names
 * the handle of one already attached, or is refused. The transcript is
 * deliberately not in this reply (D3); what is here is the summary, whose
 * `ref` is *authoritative*. It can differ from the ref asked for, because a
 * session adopts its backend id on attach -- see `ServerEvent`, whose
 * snapshot under the summary's `handle`, written before this reply, carries
 * it too.
 */
export interface AttachSessionResponse {
	session: LiveSessionSummary;
}

/**
 * `sessions/preview` -- a read-only, non-attaching transcript preview
 * (OW-38). Unlike an attach, this spawns nothing: it reads exactly one
 * stored session file by ref and maps that backend's store records to the
 * same transcript structure an attached session's events carry.
 *
 * The wire keeps store timestamps as ISO strings, matching `SessionSummary`;
 * the client edge performs the one conversion to the epoch-ms timestamps the
 * renderer consumes. Selecting a session to look at must stay as cheap as
 * listing one (D9), so this reads a single file and never the whole corpus.
 */
type PreviewTimestamp<T> = T extends { timestamp: number }
	? Omit<T, "timestamp"> & { timestamp?: string }
	: T;

/** A transcript message with its store-native ISO timestamp on the wire. */
export type SessionPreviewTurn = PreviewTimestamp<PaneMessage>;
export interface SessionPreviewResponse {
	/** The ref the preview was read for, echoed back so the client can key it. */
	ref: SessionRef;
	turns: SessionPreviewTurn[];
}

/** `sessions/prompt`, beside the handle or the ref it names (`PromptParams`). */
export interface PromptRequest {
	text: string;
	images?: { mimeType: string; base64: string }[];
	/**
	 * The `errorId` of the turn error the sender showed when the user sent,
	 * or null when it showed none. Admitting a prompt that starts or joins
	 * a turn clears the session's error only if it is still that one (a
	 * handled one clears nothing, `PromptDisposition`): an error raised after
	 * the send, or before the sender drew it, stays (OW-31, OW-jokoto). Read at the
	 * send gesture, before any attach the send itself makes, so an error that
	 * attach's start raised is not one the sender held. Absent, the server
	 * takes whatever error it holds when the request arrives.
	 */
	priorErrorId?: string | null;
	/**
	 * The handle of the live session the sender's view holds (D30). Named, the
	 * prompt goes only to the live session under it and starts nothing: one
	 * that has ended is refused `not_attached`, and the sender keeps the text.
	 * Absent, the sender's view knows the session is not running, and the
	 * prompt names the session's ref instead, which the server attaches if it
	 * must, then prompts; the answer then names the live session
	 * (`PromptResponse.session`). On the socket it is one of the two
	 * `PromptParams` name.
	 */
	handle?: string;
}

/**
 * What a prompt the backend admitted led to. `"started"`: a turn runs, or the
 * prompt joined the one running (D16), and its events follow the reply.
 * `"handled"`: the backend consumed the prompt itself and started no turn for
 * it (OW-dulipe). Only Pi answers that, for a prompt an extension command or
 * input handler takes, and the extension may still start work of its own,
 * whose events arrive as usual: `docs/rpc-commands.md` "prompt"
 * in `pi 1.2.0` says the disposition "describes the submitted prompt, not
 * independent work started by an extension" (read at the installed package,
 * not measured). After `/refs`, `/llama` and `/mcp` on `pi 1.2.0`, on
 * 2026-10-14, no event followed (docs/MANUAL_TESTING.md, OW-kokotu).
 * A handled prompt leaves the session's held turn error standing (D3, OW-fakazi).
 */
export type PromptDisposition = "started" | "handled";

/**
 * A prompt's reply: its disposition, and for a prompt that named a ref, the
 * live session it attached as well (`PromptParams`, D30), whose snapshot was
 * written before this.
 */
export interface PromptResponse {
	disposition: PromptDisposition;
	session?: LiveSessionSummary;
}

/**
 * `sessions/abort`'s reply: the text of each steered prompt the backend had not
 * yet delivered, the steering queue's in order and then the follow-up queue's
 * (D16, OW-wisifo). Only Pi queues
 * any, and only their text comes back -- a steered prompt's images do not,
 * and a skill or prompt template comes back as Pi expanded it.
 *
 * It answers the request that pressed Stop and goes nowhere else, because the
 * composer to put them back in is that client's. Empty when the stop took
 * nothing out.
 */
export interface AbortResponse {
	queued: string[];
}

/** `draft/edit` */
export interface EditDraftRequest {
	text: string;
}
export interface EditDraftResponse {
	text: string;
}

/**
 * `sessions/forkAndPrompt` -- an edit of an earlier
 * message, as one server operation (D30): fork the session at the user
 * message whose transcript index is `index`, attach the fork, and prompt it
 * with `text` and `images`. Only an attached session forks (D25), and an
 * index no fork point names is refused `not_a_fork_point` with nothing
 * forked (D20). Admitting the prompt clears no turn error: nobody has seen
 * one on the fork (`PromptRequest.priorErrorId`).
 *
 * Answered once the fork's prompt is admitted. A failure once the fork's
 * attach has published, or a Pi fork's after it moved, is refused as that
 * failure would be on its own, naming the fork (`ApiError.fork`); the server
 * removes nothing (D17). A fork whose own start fails leaves nothing, and its
 * refusal names none (D35 point 6).
 */
export interface ForkAndPromptRequest {
	index: number;
	text: string;
	images?: { mimeType: string; base64: string }[];
}
export interface ForkAndPromptResponse {
	/** The fork's, under its own handle, whose snapshot was written before this reply. */
	session: LiveSessionSummary;
	disposition: PromptDisposition;
}

/** `sessions/forkPoints` */
export interface ForkPoint {
	id: string;
	text: string;
	/**
	 * Where this point sits in the session's flat transcript -- an index into
	 * the very array `snapshot.messages` and `upsert.index` address (OW-roveze).
	 *
	 * A fork point names its own position; the client never counts. The count it
	 * used to do assumed one point per user message on every backend, and Codex
	 * falsified that: steering puts two `userMessage` items in one turn, Codex
	 * forks at turn granularity, so three user messages can answer with two
	 * points and every ordinal past the steer addressed the wrong turn -- with no
	 * error once a later turn made the index resolve.
	 *
	 * The consequence is deliberate: a user message no point names is not
	 * forkable, and the UI offers no Edit on it rather than forking somewhere
	 * else.
	 */
	index: number;
}
export interface ForkPointsResponse {
	points: ForkPoint[];
	/**
	 * Whether a fork of this session stops a turn running when it lands, which
	 * is what "Stop and fork" and its equivalents read (D30). True on Pi alone,
	 * whose backend abandons the turn at a fork whatever agentpane does (D15);
	 * whether a turn is running is the session's status, not this.
	 */
	forkStopsTurn: boolean;
}

/** `sessions/setModel` */
export interface SetModelRequest {
	model: string;
}

/**
 * `sessions/setName` -- written through to the backend, which holds it;
 * agentpane keeps none (D13, "Names are not marks"). Only an attached session
 * can be named, since a detached one has no process to write through, which
 * is why the command names a handle. Line breaks become one space and leading
 * and trailing whitespace is trimmed, as Pi stores a name, and a name empty
 * after that is refused `bad_request`.
 */
export interface SetNameRequest {
	name: string;
}

/**
 * `sessions/setEffort` -- one of the model's `efforts` ids, taking effect
 * from the next turn. Any other is refused `bad_request`, as
 * does any effort while the session's model lists none or is not in the
 * listing, and never reaches the backend (OW-tewofe).
 */
export interface SetEffortRequest {
	effort: string;
}

/**
 * `sessions/dismissError` -- dismiss the session's turn error, so no later
 * snapshot carries it (OW-bipume). `errorId` is the error being dismissed,
 * the one the client showed, as its `error` event or snapshot named it. It is
 * named because another client's turn can fail while the dismissal is on its
 * way, and that newer error must survive it, so only it is cleared, and the
 * reply is the same whether or not anything was -- by id, not text, since the
 * newer one can repeat it word for word (OW-jokoto). A command without one is
 * refused `bad_request`.
 */
export interface DismissErrorRequest {
	errorId: string;
}

/** `models/list`, for one backend or every one */
export interface ModelInfo {
	id: string;
	label: string;
	/**
	 * The reasoning efforts this model accepts, in the backend's order. Per
	 * model, not per backend, so a client can follow a model change without
	 * guessing: setting a model whose list lacks the effort in force falls back
	 * to that model's `defaultEffort`, or where that is null to whatever the
	 * backend then picks, which the status that follows reports. Empty when
	 * the model or its backend offers no effort control, and then a client
	 * shows none.
	 */
	efforts: EffortInfo[];
	/**
	 * The effort the backend picks for this model when none is chosen; null when
	 * it names none. Pi's is always null: it picks from its own settings file,
	 * which its model catalogue does not carry (OW-ruzuhu).
	 */
	defaultEffort: string | null;
}
export interface EffortInfo {
	/** What `SetEffortRequest.effort` takes, and what a turn's `effort` names. */
	id: string;
	/** Empty where the backend describes none, as Pi does not. */
	description: string;
}
export interface ModelsResponse {
	models: ModelInfo[];
}

/**
 * A refusal: `error` is the code a `ReplyFailed` carries as `code`. Also the
 * body of each HTTP refusal, of an upgrade or a path that is not served.
 */
export interface ApiError {
	error: string;
	detail?: string;
	/**
	 * Only from `sessions/forkAndPrompt`, for a failure after the fork was created: the
	 * fork, by its ref, and by its handle where it is still live, null where it
	 * was not by the time its prompt was refused (D30). A fork whose own start
	 * failed is not named: it left nothing (D35 point 6). A client moves to it,
	 * so that sending again prompts that fork rather than forking the parent a
	 * second time.
	 */
	fork?: { ref: SessionRef; handle: string | null };
	/**
	 * Only from a prompt that named a ref, for a refusal after the server
	 * attached its session: that session, by its ref and the handle it is live
	 * under, so a client binds the view that sent it (D30).
	 */
	attached?: { ref: SessionRef; handle: string };
}

// ---------------------------------------------------------------------------
// Socket (D31): commands in, replies and events out, on one WebSocket
// ---------------------------------------------------------------------------

/** What a command on a live session names: the handle the client holds for it (D31 point 9). */
export interface HandleParams {
	handle: string;
}

/** What a command with no handle to name names: attach, preview, and a prompt from a detached view. */
export interface RefParams {
	ref: SessionRef;
}

/**
 * A prompt names exactly one of the two (D30): the handle of the live session
 * the sender's view holds, refused `not_attached` once it has ended; or the
 * ref of a session the view knows is not running, which the server attaches
 * if it must, its answer then naming the live session.
 */
export type PromptParams = Omit<PromptRequest, "handle"> & (
	| { handle: string; ref?: never }
	| { ref: SessionRef; handle?: never }
);

/**
 * Every command and query the socket carries, by its `cmd`, with what it
 * takes beside `id` and what a reply that admits it carries. The names are
 * the Emacs helper's methods where it has one (`src/emacs/protocol.ts`), and
 * `null` is a result that carries nothing.
 *
 * `hello` is the socket's first frame and carries the token (D31 point 5).
 * The server sends nothing and runs nothing until one has; a first frame that
 * is anything else, or a wrong token, closes the socket with
 * `SOCKET_CLOSE.unauthorized`. Its reply follows the opening snapshots, so a
 * client knows it is connected even when nothing is live.
 *
 * Close names a handle like every other command on a live session, and is
 * refused `not_attached` where that handle has ended (D35 point 3): it never
 * reaches a start, which ends by publishing, failing, timing out or the
 * server's shutdown.
 *
 * A command that would start an agent -- `sessions/attach`,
 * `sessions/create`, a `sessions/prompt` naming a ref, and the fork
 * `sessions/forkAndPrompt` made -- may first close the least recently
 * attached live session, and is refused `at_capacity` when D12's cap is
 * reached and none may be closed for it (`maxSessions` in
 * `src/server/http/session-manager.ts`), and is refused `start_timeout`
 * when the agent's start outruns `startTimeoutMs` there, the agent stopped
 * and nothing left (D35). `sessions/attach` and a
 * `sessions/prompt` naming a ref are refused `turn_running` when the session's
 * turn is still running on a backend that holds it elsewhere, a Codex thread
 * re-attached over a live app-server (D34); nothing is started.
 */
export interface Commands {
	hello: { params: { token: string }; result: null };
	"sessions/list": { params: ListSessionsQuery; result: ListSessionsResponse };
	"sessions/create": { params: CreateSessionRequest; result: CreateSessionResponse };
	"sessions/preview": { params: RefParams; result: SessionPreviewResponse };
	"sessions/attach": { params: RefParams; result: AttachSessionResponse };
	"sessions/close": { params: HandleParams; result: null };
	"sessions/prompt": { params: PromptParams; result: PromptResponse };
	"sessions/abort": { params: HandleParams; result: AbortResponse };
	"sessions/compact": { params: HandleParams; result: null };
	"sessions/dismissError": { params: HandleParams & DismissErrorRequest; result: null };
	"sessions/setModel": { params: HandleParams & SetModelRequest; result: null };
	"sessions/setEffort": { params: HandleParams & SetEffortRequest; result: null };
	"sessions/setName": { params: HandleParams & SetNameRequest; result: null };
	"sessions/forkPoints": { params: HandleParams; result: ForkPointsResponse };
	"sessions/forkAndPrompt": { params: HandleParams & ForkAndPromptRequest; result: ForkAndPromptResponse };
	"models/list": { params: { backend?: BackendId }; result: ModelsResponse };
	"draft/edit": { params: EditDraftRequest; result: EditDraftResponse };
}

export type CommandName = keyof Commands;

/** Client to server: one command, its `id` minted by the client and echoed on the reply. */
export type CommandFrame = { [K in CommandName]: { id: string; cmd: K } & Commands[K]["params"] }[CommandName];

/**
 * The command was admitted, and everything it caused while it ran was written
 * before this; what a turn emits after its prompt is admitted comes after
 * (D31 point 3).
 */
export interface ReplyOk<K extends CommandName = CommandName> {
	type: "reply";
	id: string;
	ok: true;
	result: Commands[K]["result"];
}

/**
 * The command was refused. `code` is what `ApiError.error` names, from one
 * mapper (`classifyFailure`), and `fork` and `attached` are as there (D30). An `id` no command frame carried is never answered: a frame that is
 * not a JSON object with a string `id` closes the socket with
 * `SOCKET_CLOSE.badFrame`.
 */
export interface ReplyFailed extends Pick<ApiError, "fork" | "attached"> {
	type: "reply";
	id: string;
	ok: false;
	code: string;
	detail: string;
}

/** Server to client, in the order the server wrote them. */
export type ServerFrame = { type: "event"; event: ServerEvent } | ReplyOk | ReplyFailed;

/** The close codes the server sends of its own; a socket the runtime closed carries the runtime's. */
export const SOCKET_CLOSE = {
	/** The first frame was not a `hello` carrying the token. */
	unauthorized: 4401,
	/** A frame that was not a JSON object with a string `id`. */
	badFrame: 4400,
	/** The server is shutting down. */
	goingAway: 1001,
} as const;

/**
 * The largest frame the server takes, set rather than inherited (D31 point 8):
 * an inbound frame past it costs the whole socket, not one request, so a
 * client refuses a prompt over it before sending. 32 MB holds several
 * screenshots, and a prompt's images come back in its upsert, which stays
 * under the 40 MB measured to pass outbound (`docs/MANUAL_TESTING.md`, "What a
 * WebSocket does under Bun and in Chromium (D31)").
 */
export const MAX_SOCKET_FRAME_BYTES = 32 * 1024 * 1024;

/**
 * The path of the upgrade to the socket, which with the static bundle is all
 * the server answers over HTTP (D31). Loopback only (D8); its token arrives in
 * the first frame, not a header (D31 point 5).
 */
export const SOCKET_PATH = "/api/socket";

export const DEFAULT_PORT = 4173;

/** Equality helper -- SessionRef is used as a map key all over both ends. */
export function sessionKey(ref: SessionRef): string {
	return `${ref.backend}:${ref.id}`;
}
