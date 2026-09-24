/**
 * The backend adapter contract.
 *
 * FROZEN INTERFACE (DESIGN "The backend adapter contract"). The Pi, Codex,
 * and Claude Code adapters all implement it; changing it changes all three --
 * raise it before editing.
 *
 * An adapter owns one sandboxed subprocess's stdio and is responsible for one
 * thing above all: producing and maintaining an `AgentMessage[]` plus a
 * streaming signal. The server broadcasts that state (D3); it never forwards
 * raw backend protocol events, which is what keeps the stateful item->message
 * assembly server-side, testable against fixtures, and out of the browser.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentNotice, AgentRequest, ForkPoint, ModelInfo, SessionRef } from "../../shared/protocol.ts";

export interface AdapterState {
	messages: AgentMessage[];
	isStreaming: boolean;
	compaction: "requesting" | "running" | null;
	/** The backend-accepted model id currently governing this conversation. */
	model: string | null;
	/**
	 * The reasoning effort the next turn runs at: the one `setEffort` chose, or
	 * else the one the backend reported; null for a backend that reports none.
	 */
	effort: string | null;
	/**
	 * The model the conversation's store last recorded, when the backend did
	 * not restore it and `model` is another in its place (D23, OW-jitoni);
	 * null or absent otherwise. Only Pi reports one, and only by inference:
	 * as of `pi 0.87.1` it fell back without a word over RPC
	 * (docs/MANUAL_TESTING.md, OW-zujofa). What causes it, and when it is set
	 * and cleared, is `PiAdapter`'s docblock on the field.
	 */
	unrestoredModel?: string | null;
}

export type Unsubscribe = () => void;

export interface ImageInput {
	mimeType: string;
	base64: string;
}

export interface StartOptions {
	/**
	 * The session's workspace. The subprocess MUST be spawned with this as cwd
	 * or sbox jails the wrong tree and direnv loads the wrong environment (D7).
	 */
	cwd: string;
	/** Resume an existing session; omit to start a fresh one. */
	resumeId?: string;
	model?: string;
	/**
	 * Start as the fork `fork()` minted but did not run, keeping the parent's
	 * history through `entryId`. The adapter's own `ref` already carries the
	 * fork's id, so this names what it is a fork OF, and `effort` the parent's
	 * effort in force when it was cut, for a cut that keeps no turn to read one
	 * from (D23). Here rather than beside `model` because only a fork carries
	 * it: no other start is handed an effort. Claude Code and Codex read it;
	 * Codex, whose fork before the first message is a fresh thread, reads
	 * nothing else here (OW-hojefo).
	 */
	forkOf?: { parentId: string; entryId: string; effort?: string };
}

/**
 * What `fork()` hands back, in three shapes because the backends fork three
 * ways. `ref` is always the new conversation.
 *
 * `start` is the `StartOptions` the fork's own adapter must be started with,
 * present whenever the fork is not reachable by the ordinary attach path. Pi
 * omits it: its fork IS the live process, which the adapter keeps driving.
 *
 * `adapter` is the fork's adapter, already constructed and holding whatever it
 * shares with the parent, for a fork that cannot be driven by an adapter the
 * factory would build. Codex is the one case: `thread/fork` flushes the rollout
 * to disk immediately, but the minting app-server keeps its writer lock and a
 * second one is refused (`codex-cli` 0.154.0, OW-lajehi), so the fork's adapter
 * borrows the parent's connection and only `CodexAdapter.fork` can hand it
 * over -- `AdapterFactory.create` takes a ref and could not. A Codex fork at
 * the first user message mints no thread and so hands back `start` alone, as
 * Claude Code's forks do (OW-hojefo).
 *
 * A union rather than two optional fields, because an `adapter` without a
 * `start` is a shape nothing can act on: `SessionManager.fork` parks an entry
 * only when there is something to start it with, so such an adapter would be
 * silently dropped -- never started, never disposed, holding its share of the
 * parent's child for the life of the server. The type refuses to express it.
 */
export type ForkResult =
	/** Reachable the ordinary way: the backend has recorded it, or Pi's live process IS it. */
	| { ref: SessionRef; start?: undefined; adapter?: undefined }
	/** Opened by its own adapter, from arguments the backend has not recorded. */
	| { ref: SessionRef; start: StartOptions; adapter?: undefined }
	/** Opened by the adapter handed over here, which shares something live with the parent. */
	| { ref: SessionRef; start: StartOptions; adapter: BackendAdapter };

export interface BackendAdapter {
	readonly ref: SessionRef;

	// -- lifecycle ----------------------------------------------------------
	/** Spawn via `direnv exec <cwd> sbox -- <agent>` (D7). */
	start(opts: StartOptions): Promise<void>;
	/**
	 * Kill the subprocess. MUST be idempotent, and the disposal of the adapters
	 * sharing a child MUST resolve only once that child is actually gone -- the
	 * server's shutdown resolving is its licence to exit. That is an invariant
	 * over the SET, not over each adapter: a Codex fork shares the parent's
	 * app-server (OW-lajehi), so every holder but the last resolves with the
	 * child alive and the last one awaits the kill. Shutdown settles all of them,
	 * so the licence still means what it says.
	 *
	 * Teardown reaches one adapter from more than one direction: an
	 * explicit close and a failing `start()` can hold the same adapter, and
	 * shutdown walks both the process table and the startups still in flight.
	 * Repeat callers must await the first teardown rather than run a second,
	 * which would re-signal a pid the OS may have already reused.
	 *
	 * Safe to call *during* `start()`, which is where a teardown most often
	 * lands: both implementations own their child before `start()` resolves.
	 */
	dispose(): Promise<void>;

	// -- driving a turn -----------------------------------------------------
	/**
	 * Resolves once the backend admits the turn, not when the turn completes.
	 *
	 * Submitted *during* a running turn, the promise is **steer** (D16): the
	 * text joins the turn already in flight, delivered at the backend's next
	 * safe point rather than after the turn ends. An adapter whose backend
	 * cannot steer rejects instead, so the route can 500 and the client can
	 * say so with the draft intact -- never silently downgrades to a follow-up,
	 * which would land the prompt somewhere the user did not ask for.
	 */
	submit(text: string, images?: ImageInput[]): Promise<void>;
	abort(): Promise<void>;
	/**
	 * Compact the session's context, summarising the history so far to reduce
	 * the token count the next turn carries. Required (OW-72): every backend
	 * has the capability -- Codex's `thread/compact/start`, Pi's `compact`
	 * command, Claude Code's `/compact` message -- so nothing is forced to
	 * fake it. What the transcript shows
	 * afterwards is the adapter's own reducer's business, not this method's.
	 */
	compact(): Promise<void>;

	// -- fork-from-past -----------------------------------------------------
	listForkPoints(): Promise<ForkPoint[]>;
	/**
	 * Branch a second conversation off this one at `entryId`. This adapter keeps
	 * driving the session it already has -- except on Pi, whose fork moves the
	 * live process's own file, so its `ref` changes and the manager re-keys.
	 */
	fork(entryId: string): Promise<ForkResult>;

	// -- state (what the server broadcasts) ---------------------------------
	getState(): AdapterState;
	/**
	 * Fires on every state change. The server translates these into snapshot /
	 * upsert events; adapters do not know about `seq` or the wire at all.
	 *
	 * `changedIndex` is the index of the single message that changed, when the
	 * adapter knows it -- that is what makes the tail-upsert path O(1). Omit it
	 * and the server falls back to a full snapshot, which is correct but
	 * quadratic over a long turn.
	 */
	onUpdate(cb: (state: AdapterState, changedIndex?: number) => void): Unsubscribe;

	/**
	 * Fires when the agent asks the human something and blocks (D2a). The
	 * adapter is responsible for correlating the eventual reply back to the
	 * backend's own request id.
	 */
	onRequest(cb: (request: AgentRequest) => void): Unsubscribe;
	/** Answer a pending request. `response` is backend-shaped; null declines. */
	reply(requestId: string, response: unknown): Promise<void>;
	/**
	 * Fires when a request `onRequest` published stops being pending other
	 * than through `reply` -- the backend resolved it, or the adapter answered
	 * it itself (OW-gusifo). `requestId` is the id it was published under.
	 * Optional because only the Codex adapter detects one; the others leave
	 * it out.
	 */
	onRequestResolved?(cb: (requestId: string) => void): Unsubscribe;

	/** Fires when a turn fails in a way the transcript does not convey. */
	onError(cb: (message: string) => void): Unsubscribe;
	/**
	 * Fires when the backend says something non-fatal the human should see
	 * (OW-tujiya). Never an error: nothing here says a turn failed, so it
	 * must not ride `onError`. Optional because only the Codex adapter
	 * implements it; the others leave it out.
	 */
	onNotice?(cb: (notice: AgentNotice) => void): Unsubscribe;

	// -- session controls ---------------------------------------------------
	setModel(model: string): Promise<void>;
	/**
	 * Choose the reasoning effort from the next turn on, one of the current
	 * model's `ModelInfo.efforts`. The effort route checks that against
	 * `getState().model` and `listModels` before calling this, and refuses
	 * any other, so an adapter takes what it is given (OW-tewofe). Like
	 * `setModel`, nothing here refuses it after the first prompt;
	 * before-the-first-prompt-only is the clients' rule.
	 */
	setEffort(effort: string): Promise<void>;
	listModels(): Promise<ModelInfo[]>;
}

/**
 * Adapters are constructed, then started. Keeping construction synchronous and
 * side-effect-free is what lets tests drive an adapter over a recorded fixture
 * without spawning anything.
 */
export interface AdapterFactory {
	create(ref: SessionRef): BackendAdapter;
}

/**
 * The backend refused the value it was asked to take -- a model it does not
 * know, say -- or the adapter did, for a value the backend's protocol cannot
 * even carry. The server answers 400 with this message, because the
 * request is what was wrong; a backend that died or never answered is not
 * this, and stays a 500. Thrown by `setModel` only (OW-pizaki).
 */
export class BackendRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BackendRefusedError";
	}
}
