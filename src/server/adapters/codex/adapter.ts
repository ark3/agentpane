/**
 * `BackendAdapter` for Codex.
 *
 * This is the shell: spawn, JSON-RPC, and the lifecycle/command surface. All
 * of the item->message translation lives in `reducer.ts` / `mapping.ts`, which
 * this class drives and never second-guesses. The split is what lets the hard
 * half be tested against recorded fixtures with no subprocess at all.
 */

import { randomUUID } from "node:crypto";
import type { AgentNotice, ForkPoint, ModelInfo, PromptDisposition, SessionRef } from "../../../shared/protocol.ts";
import { readCodexLastTurnSettings, type CodexTurnSettings } from "../../sessions/codex.ts";
import { codexSessionsRoot } from "../../sessions/index.ts";
import {
	type AdapterState,
	type AdapterFactory,
	type BackendAdapter,
	BackendRefusedError,
	type ForkResult,
	type ImageInput,
	type StartOptions,
	type StateChange,
	TurnRunningError,
	type Unsubscribe,
} from "../types.ts";
import { CodexConnection, CodexConnectionRegistry, type CodexConnectionHolder } from "./connection.ts";
import type { CodexClientView } from "./jsonrpc.ts";
import { spawnCodex, type CodexProcess, type CodexSpawner } from "./process.ts";
import { CodexReducer, type CodexEffect } from "./reducer.ts";
import {
	DECLINE_RESPONSES,
	type AskForApproval,
	type ClientInfo,
	type CodexServerMessage,
	type ModelListResponse,
	type SandboxMode,
	type ThreadForkResponse,
	type ThreadResumeResponse,
	type ThreadSetNameParams,
	type ThreadSetNameResponse,
	type ThreadStartResponse,
	type ThreadTurnsListParams,
	type ThreadTurnsListResponse,
	type Turn,
	type UserInput,
} from "./protocol.ts";

export interface CodexAdapterOptions {
	/** Injected in tests; the default spawns `direnv exec <cwd> sbox -- codex app-server`. */
	spawn?: CodexSpawner;
	clientInfo?: ClientInfo;
	/**
	 * Start threads with `ephemeral: true`, which keeps them out of the on-disk
	 * rollout store under `$CODEX_HOME/sessions`, default `~/.codex/sessions`
	 * (HANDOFF finding 25). Tests set this so nothing they do reaches the real
	 * store.
	 *
	 * NOTE: the frozen `StartOptions` has no field for this, so it is an
	 * adapter-construction option rather than a per-start one.
	 */
	ephemeral?: boolean;
	/**
	 * Start threads with this sandbox policy. Defaults to `danger-full-access`:
	 * agentpane already runs Codex inside sbox's bwrap jail, so the OS layer is
	 * the confinement boundary and anything narrower would re-implement sbox's
	 * mount list in a second place that will drift.
	 */
	sandbox?: SandboxMode;
	/**
	 * Start threads with this approval policy. Defaults to `never` (D7a):
	 * agentpane's UI has no approval dialog, so an approval `ServerRequest` is
	 * refused at arrival -- declined where it has a decline shape, errored out
	 * otherwise -- and named in a session error (D2a). Codex's own default is
	 * `on-request`, so this has to be sent explicitly; it belongs here rather
	 * than in sbox's flags or a global `~/.codex/config.toml` for the reasons
	 * D7a gives.
	 */
	approvalPolicy?: AskForApproval;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	/**
	 * The live app-servers this adapter may borrow, shared with every other
	 * adapter its factory built (OW-voyezi). `CodexAdapterFactory` supplies one;
	 * an adapter constructed without it simply never borrows, which is what the
	 * tests that drive a single adapter want.
	 */
	connections?: CodexConnectionRegistry;
	/**
	 * The rollout store a resumed thread's last turn is read from (D23; see
	 * `effort`). Defaults to the root the session index walks; tests point it
	 * at a directory of their own so nothing they do reads the real store.
	 */
	codexRoot?: string;
	/**
	 * A one-shot timer, answering its cancel, as `AppDeps.setTimer` is for the
	 * session manager: `eventTimeoutMs` runs on it, so a test fires it without
	 * waiting. `setTimeout` by default.
	 */
	setTimer?: (run: () => void, ms: number) => () => void;
}

/**
 * The deadline on a request that answers only once an event has come --
 * `setName`'s `thread/name/updated`, and the `turn/started` `submit` and
 * `compact` wait on -- counted from the request (ark3/agentpane#91). A miss
 * refuses the request and raises one session error naming the event
 * (`withinDeadline`). A first cut beside D35's `startTimeoutMs`:
 * `thread/name/updated` came 6ms after its reply on `codex-cli 0.160.0`
 * (docs/BACKENDS.md); the gap before `turn/started` was not timed.
 */
export const eventTimeoutMs = 60 * 1000;

const DEFAULT_CLIENT_INFO: ClientInfo = { name: "agentpane", title: "agentpane", version: "0.0.0" };
const DEFAULT_SANDBOX: SandboxMode = "danger-full-access";
const DEFAULT_APPROVAL_POLICY: AskForApproval = "never";
const START_ABORTED_ERROR = "codex adapter start aborted: disposed during startup";
const TURN_START_ABORTED_ERROR = "codex adapter submit aborted: disposed during turn startup";
const TURN_START_PENDING_ERROR = "codex adapter cannot submit while turn/start is pending";
const TURN_ACTIVE_ERROR = "codex adapter cannot submit while a turn is active";
const TURN_INTERRUPTED_ERROR = "codex adapter cannot submit while an interrupted turn is ending";
const TURN_STEER_REJECTED_ERROR = "codex adapter turn/steer rejected";

/** JSON-RPC "method not found"; used when a blocking request's kind has no handler. */
const UNSUPPORTED_REQUEST_CODE = -32601;

interface ClientOwnership {
	proc: CodexProcess;
	client: CodexClientView | null;
	ready: boolean;
}

export class CodexAdapter implements BackendAdapter {
	private currentRef: SessionRef;
	private options: CodexAdapterOptions;
	private reducer: CodexReducer;
	private readonly sandbox: SandboxMode;
	private readonly approvalPolicy: AskForApproval;
	private readonly setTimer: NonNullable<CodexAdapterOptions["setTimer"]>;

	private proc: CodexProcess | null = null;
	private client: CodexClientView | null = null;
	private ownership: ClientOwnership | null = null;
	/** The app-server this adapter talks over, owned or borrowed (OW-lajehi). */
	private connection: CodexConnection | null = null;
	private holder: CodexConnectionHolder | null = null;
	/**
	 * True for a fork this adapter did not spawn a child for: it is driving a
	 * thread minted inside the parent's app-server, which is the only process
	 * that may open it. Set by `adoptConnection`.
	 */
	private borrowed = false;
	/**
	 * `start()` has been entered. Separate from `client`, which a borrower holds
	 * from construction (`adoptConnection`) and therefore cannot stand in for.
	 */
	private startCalled = false;
	private threadId: string | null = null;
	/**
	 * The running turn, which `abort()` interrupts and `submit()` steers: set
	 * by `turn/started` alone and cleared by its `turn/completed`, so it names
	 * a turn app-server said is live (D34 point 5).
	 */
	private turnId: string | null = null;
	/**
	 * The turn `abort()` asked app-server to interrupt, held until that turn's
	 * `turn/completed` arrives and clears `turnId` with it (OW-pefawi).
	 */
	private interruptedTurnId: string | null = null;
	/**
	 * The gate from a `turn/start` or `thread/compact/start` until its
	 * `turn/started`, which `submit` and `compact` wait on and refuse a second
	 * request behind (`TURN_START_PENDING_ERROR`). Armed before the request, so
	 * either order of reply and event releases it; what it relies on is that a
	 * `turn/started` follows every successful reply, as it did for all 20
	 * `turn/start` replies in the 14 wire captures that carry one, `codex-cli
	 * 0.147.0` to `0.170.0` (docs/BACKENDS.md, "The running turn"). A
	 * same-thread `turn/completed`, or a status that is not `active`, arriving
	 * while it holds is that order broken, and is raised as a session error
	 * before it releases (`unstarted`, D18). Total silence is refused at
	 * `eventTimeoutMs` (`withinDeadline`).
	 */
	private starting: { method: string; resolve: () => void; reject: (error: Error) => void } | null = null;
	private model: string | null = null;
	/**
	 * The effort sent on every `turn/start` like `model` --
	 * `TurnStartParams.effort` is the only way to set one, overriding it "for
	 * this turn and subsequent turns". `setEffort` sets it, and so do a resume
	 * and a fork, from the effort the store's last turn ran at (D23): the
	 * rollout's last `turn_context`, for a fork the last one it kept of its
	 * parent's. The model that turn ran goes into `model` the same way. A fork
	 * that keeps no turn has none to read and is started with the parent's pair
	 * instead (`fork`, OW-hojefo). Null when neither has named one, and then
	 * nothing is sent and the thread runs at what `thread/start` or
	 * `thread/resume` reported, which is what `getState` names instead.
	 *
	 * Re-asserted from the store rather than left to Codex, because what Codex
	 * keeps depends on the path. Measured on the home server, 2026-09-23,
	 * `codex-cli 0.156.0`, every turn on `gpt-5.6-luna`, in a `CODEX_HOME` whose
	 * `config.toml` named `gpt-5.6-terra` at `high` (`docs/MANUAL_TESTING.md`,
	 * OW-sayaju): after a turn at `low`, a `thread/resume` naming no model
	 * answered `gpt-5.6-luna` at `low`, on the app-server that ran the turn and
	 * in a fresh one alike. But a fresh resume that named the model, as
	 * OW-kokalo's did, answered the config's `high`, wrote it to the rollout as
	 * `thread_settings_applied`, and a later resume naming none restored that
	 * `high` though no turn had run at it. And `thread/fork` carried neither:
	 * the fork, and its borrower's resume, answered the config's
	 * `gpt-5.6-terra` at `high`, and a turn sent on it naming only the model ran
	 * at `high`. Which is also why the store's model is applied after the
	 * resume and rides `turn/start`, never `thread/resume`.
	 */
	private effort: string | null = null;
	/**
	 * The thread's name: the one `thread/start` or `thread/resume` answered
	 * with, then the one a `thread/name/updated` for this thread last
	 * reported, a rename `setName` sent included (D34 point 5). As of
	 * `codex-cli 0.154.0` Codex kept it beside the rollout, never in it, so
	 * the D9 walk cannot see it
	 * (docs/MANUAL_TESTING.md, "All three backends rename an attached session
	 * over the wire").
	 */
	private name: string | null = null;
	/** The rename `setName` waits on until its `thread/name/updated` arrives. */
	private renaming: { resolve: () => void; reject: (error: Error) => void } | null = null;
	private cwd: string | null = null;
	private disposed = false;
	private disposal: Promise<void> | null = null;

	/** Turn ids in transcript order; `fork` needs the *previous* turn (see `fork`). */
	private turnOrder: string[] = [];

	private updateListeners = new Set<(state: AdapterState, change: StateChange) => void>();
	private errorListeners = new Set<(message: string) => void>();
	private noticeListeners = new Set<(notice: AgentNotice) => void>();
	private refListeners = new Set<(ref: SessionRef, cause: "rename" | "fork") => void>();

	constructor(ref: SessionRef, options: CodexAdapterOptions = {}) {
		this.currentRef = ref;
		this.options = options;
		this.reducer = new CodexReducer({ now: options.now });
		this.sandbox = options.sandbox ?? DEFAULT_SANDBOX;
		this.approvalPolicy = options.approvalPolicy ?? DEFAULT_APPROVAL_POLICY;
		this.setTimer =
			options.setTimer ??
			((run, ms) => {
				const timer = setTimeout(run, ms);
				return () => clearTimeout(timer);
			});
	}

	/**
	 * The live session ref. A `virtual` session (D9) has no Codex thread id
	 * until `thread/start` returns, so this changes once during `start()`, and
	 * `onRefChanged` says so. Every other assignment sets the id already held:
	 * a resume's, and the borrower's in `adoptConnection` and `startBorrowed`.
	 * A fork moves nothing here (OW-22).
	 */
	get ref(): SessionRef {
		return this.currentRef;
	}

	// -- lifecycle ----------------------------------------------------------

	async start(opts: StartOptions): Promise<void> {
		if (this.disposed) throw new Error("codex adapter disposed");
		if (this.startCalled) throw new Error("codex adapter already started");
		this.startCalled = true;
		this.cwd = opts.cwd;
		if (opts.model) this.model = opts.model;
		// Only a fork that keeps no turn carries one: the parent's, since its
		// `thread/start` answers the config's (see `fork`).
		if (opts.forkOf?.effort) this.effort = opts.forkOf.effort;
		if (this.borrowed) return this.startBorrowed(opts.model);

		// Re-attaching a thread a live app-server still holds. That happens when
		// one side of a fork pair is closed while the other keeps the child alive:
		// the writer lock survives the adapter, and `thread/unsubscribe` does not
		// release it (`connection.ts`, OW-voyezi), so a freshly spawned child
		// asking to resume would be refused with `-32600 already has an active
		// writer`. Resuming it a SECOND time on the process that holds it is
		// allowed, and the thread is drivable afterwards -- measured on the home
		// server, 2026-09-15, `codex-cli 0.154.0`. One whose turn is running is
		// refused (see `startBorrowed`).
		const shared = opts.resumeId ? this.options.connections?.find(opts.resumeId) : undefined;
		if (shared && opts.resumeId) {
			this.adoptConnection(shared, opts.resumeId, opts.cwd);
			return this.startBorrowed(opts.model, true);
		}

		const spawner = this.options.spawn ?? spawnCodex;
		const proc = spawner({ cwd: opts.cwd, env: this.options.env });
		this.proc = proc;
		const connection = new CodexConnection(proc, this.options.connections);
		this.connection = connection;
		const ownership: ClientOwnership = { proc, client: null, ready: false };
		this.ownership = ownership;
		const holder = this.joinConnection(connection, ownership);
		const client = holder;
		this.holder = holder;
		ownership.client = client;
		this.client = client;
		ownership.ready = true;
		// This adapter is attached before it is started -- `SessionManager.#start`
		// subscribes ahead of `start()` -- so it can field a blocking request for
		// the whole of startup, as it always could.
		holder.answerable = true;
		const assertOwned = (): void => {
			if (!this.owns(ownership)) throw new Error(START_ABORTED_ERROR);
		};

		try {
			await client.request("initialize", {
				clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
				capabilities: null,
			});
			assertOwned();

			const started = opts.resumeId
				? await client.request<ThreadResumeResponse>("thread/resume", {
						threadId: opts.resumeId,
						cwd: opts.cwd,
						sandbox: this.sandbox,
						approvalPolicy: this.approvalPolicy,
						...(this.model ? { model: this.model } : {}),
						// The turns are paged in below instead (see `readTurns`).
						excludeTurns: true,
					})
				: await client.request<ThreadStartResponse>("thread/start", {
						cwd: opts.cwd,
						sandbox: this.sandbox,
						approvalPolicy: this.approvalPolicy,
						...(this.model ? { model: this.model } : {}),
						...(this.options.ephemeral ? { ephemeral: true } : {}),
					});
			assertOwned();
			const stored = opts.resumeId ? await this.readStoredTurn(started.thread.id) : null;
			assertOwned();

			// The store's last turn, not the resume's answer, names what runs next
			// (D23; see `effort`), save a model chosen at start.
			if (stored?.effort) this.effort = stored.effort;
			const model = (opts.model ? undefined : stored?.model) ?? started.model;
			this.model = model ?? this.model;
			this.name = started.thread.name ?? null;
			this.reducer.setIdentity({
				threadId: started.thread.id,
				model,
				modelProvider: started.modelProvider,
				reasoningEffort: started.reasoningEffort,
			});

			// A reattach repaints from the thread's turns, paged in after the
			// resume (D3's cold-start path; see `readTurns`).
			if (opts.resumeId) {
				const turns = await readTurns(client, started.thread.id);
				assertOwned();
				if (turns.length) {
					this.applyEffects(this.reducer.hydrate({ id: started.thread.id, turns }));
					assertOwned();
					this.rememberTurns(turns);
				}
			}

			assertOwned();
			this.threadId = started.thread.id;
			this.moveTo(started.thread.id);
			holder.claim(started.thread.id);
		} catch (error) {
			if (this.ownership === ownership) {
				ownership.ready = false;
				this.ownership = null;
			}
			if (this.client === client) this.client = null;
			if (this.holder === holder) this.holder = null;
			if (this.connection === connection) this.connection = null;
			if (this.proc === proc) this.proc = null;
			this.startCalled = false;
			// This holder is the only one -- nothing can have forked off a
			// connection whose `start()` has not returned -- so the release kills
			// the child, exactly as the explicit kill here used to.
			await holder.release("codex adapter start failed");
			throw error;
		}
	}

	/**
	 * Start as a fork driven over the parent's app-server.
	 *
	 * No `initialize`: that handshake is per connection and the parent already
	 * made it. A second one on the same connection has never been measured, and
	 * sending an unprobed request blind is not how this adapter learns things.
	 * What remains is real work -- resume the thread, hydrate the transcript the
	 * fork inherited, and read from the store the model and effort its kept
	 * prefix last ran, which `thread/fork` does not carry (see `effort`).
	 *
	 * A `reattach`, of a thread the app-server held before this adapter, is
	 * refused `TurnRunningError` when the resume reads the thread `active`,
	 * before anything is read or hydrated: its turn may be running, and this
	 * adapter heard none of it (D34 point 1). As of `codex-cli 0.170.0`, as on
	 * `0.156.0`, that resume read `{"type": "active"}` mid-turn, named no turn
	 * and replayed no `turn/started` (docs/MANUAL_TESTING.md, ark3/agentpane#78).
	 * A fork's first attach is not refused: its thread can be running no turn,
	 * and what its resume reads was never measured.
	 *
	 * Identity is NOT seeded here. `adoptConnection` did that synchronously at
	 * fork time, because the shared line stream reaches this adapter from that
	 * moment and the reducer's cross-thread guard is only armed once `threadId`
	 * is set; see `adoptConnection`.
	 *
	 * A rejection leaves the share held. The caller disposes -- `SessionManager`
	 * `#start` reaps a failed start through `#terminate` -- and that is what
	 * releases it.
	 */
	private async startBorrowed(chosenModel: string | undefined, reattach = false): Promise<void> {
		const holder = this.holder;
		const ownership = this.ownership;
		const threadId = this.threadId;
		if (!holder || !ownership || !threadId) throw new Error("codex adapter not started");
		const assertOwned = (): void => {
			if (!this.owns(ownership)) throw new Error(START_ABORTED_ERROR);
		};
		// Not at `adoptConnection`: the share is taken at fork time, but nothing
		// has subscribed to this adapter until the attach that reaches here, and a
		// holder with no listeners must not be handed a blocking request.
		holder.answerable = true;

		const resumed = await holder.request<ThreadResumeResponse>("thread/resume", {
			threadId,
			cwd: this.cwd,
			sandbox: this.sandbox,
			approvalPolicy: this.approvalPolicy,
			...(this.model ? { model: this.model } : {}),
			excludeTurns: true,
		});
		assertOwned();
		if (reattach && resumed.thread.status.type === "active") throw new TurnRunningError();
		// Idle, so a delta for an item started before now is one that status missed.
		if (reattach) this.reducer.reportUnknownDeltas = true;
		const stored = await this.readStoredTurn(resumed.thread.id);
		assertOwned();

		// As in `start`: a fork's resume answers with the config's defaults, not
		// the parent's (see `effort`), so here the store is what carries them.
		if (stored?.effort) this.effort = stored.effort;
		const model = (chosenModel ? undefined : stored?.model) ?? resumed.model;
		this.model = model ?? this.model;
		this.name = resumed.thread.name ?? null;
		this.reducer.setIdentity({
			threadId: resumed.thread.id,
			model,
			modelProvider: resumed.modelProvider,
			reasoningEffort: resumed.reasoningEffort,
		});
		const turns = await readTurns(holder, resumed.thread.id);
		assertOwned();
		this.applyEffects(this.reducer.hydrate({ id: resumed.thread.id, turns }));
		assertOwned();
		this.rememberTurns(turns);
		assertOwned();
		// `thread/resume` answers with the id it was asked for, so this is the id
		// `adoptConnection` already installed and announces nothing -- no
		// rename for a fork, which is what D20/OW-suhoto requires.
		this.threadId = resumed.thread.id;
		this.moveTo(resumed.thread.id);
		holder.claim(resumed.thread.id);
	}

	/**
	 * Take a share of `connection` and start listening on it, for a fork the
	 * parent has just minted. Synchronous and complete: the share is taken at
	 * fork time, not at attach, so a `close()` on the parent landing between the
	 * two cannot kill the child out from under the attach.
	 *
	 * The seeding order is load-bearing. `CodexReducer.handleNotification`'s
	 * cross-thread guard short-circuits while its `threadId` is null and its
	 * `thread/started` arm binds to whatever thread it sees first, so a borrower
	 * that joined the stream unseeded would accept the PARENT's notifications
	 * until its own `thread/resume` came back -- taking the parent's turn state,
	 * its streaming flag among them, which `CodexReducer.hydrate` leaves alone
	 * when it replaces the transcript; that is exactly the D15/OW-gojado case of
	 * forking a streaming parent.
	 */
	private adoptConnection(connection: CodexConnection, threadId: string, cwd: string): void {
		this.connection = connection;
		this.borrowed = true;
		this.cwd = cwd;
		this.threadId = threadId;
		this.moveTo(threadId);
		this.reducer.setIdentity({ threadId });
		const ownership: ClientOwnership = { proc: connection.proc, client: null, ready: false };
		this.ownership = ownership;
		const holder = this.joinConnection(connection, ownership);
		holder.claim(threadId);
		this.holder = holder;
		this.client = holder;
		this.proc = connection.proc;
		ownership.client = holder;
		ownership.ready = true;
	}

	private joinConnection(connection: CodexConnection, ownership: ClientOwnership): CodexConnectionHolder {
		return connection.join({
			onMessage: (msg) => {
				if (!this.owns(ownership)) return;
				this.onServerMessage(msg);
			},
			onExit: (code, signal, error) => {
				if (!this.owns(ownership)) return;
				const message =
					error?.message ?? `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
				this.renaming?.reject(new Error(message));
				this.starting?.reject(new Error(message));
				this.emitError(message);
			},
		});
	}

	dispose(): Promise<void> {
		if (this.disposal) return this.disposal;
		this.disposed = true;
		this.disposal = this.finishDisposal();
		return this.disposal;
	}

	private async finishDisposal(): Promise<void> {
		const holder = this.holder;
		if (this.ownership) this.ownership.ready = false;
		this.ownership = null;
		this.client = null;
		this.proc = null;
		this.holder = null;
		this.connection = null;
		this.updateListeners.clear();
		this.errorListeners.clear();
		this.noticeListeners.clear();
		this.turnId = null;
		this.interruptedTurnId = null;
		this.renaming?.reject(new Error("codex adapter disposed"));
		this.renaming = null;
		this.starting?.reject(new Error(TURN_START_ABORTED_ERROR));
		this.starting = null;
		// The child dies with the LAST holder, not with this one. A fork drives a
		// thread only the parent's app-server may open, so killing on the first
		// release would take the fork's session down with the parent's
		// (OW-lajehi). `BackendAdapter.dispose`'s "resolves once the child is
		// gone" therefore holds across the set: the last releaser awaits the kill
		// and shutdown, which settles every adapter, waits for it.
		await holder?.release();
	}

	// -- driving a turn -----------------------------------------------------

	async submit(text: string, images?: ImageInput[]): Promise<PromptDisposition> {
		const client = this.requireClient();
		const threadId = this.requireThread();
		const ownership = this.ownership;
		if (!ownership || ownership.client !== client || !this.owns(ownership)) {
			throw new Error("codex adapter not started");
		}
		if (this.starting) throw new Error(TURN_START_PENDING_ERROR);
		const input: UserInput[] = [];
		if (text) input.push({ type: "text", text, text_elements: [] });
		for (const image of images ?? []) {
			input.push({ type: "image", url: `data:${image.mimeType};base64,${image.base64}` });
		}
		// D16: a prompt submitted mid-turn steers that turn. Verified live on
		// 2026-09-12 against codex-cli 0.154.0 (OW-tifuha, `docs/MANUAL_TESTING.md`):
		// `turn/steer` fired 29 deltas into a streaming turn returned that same
		// turn id, and the steered `userMessage` and the answering
		// `agentMessage` both arrived under it -- one `turn/completed`, no
		// second turn.
		//
		// `expectedTurnId` is a precondition app-server enforces, so this needs
		// a turn id it knows is live: `turnId` is exactly that, set only from
		// `turn/started` (see `turnId`). Between a `turn/start` and its
		// `turn/started` there is no id to steer with, and the gate above
		// refuses; `SessionManager.#serially` holds the next prompt until
		// `submit` answers, which is not before then.
		//
		// A compaction is the one live turn that must not be steered: `compact` is
		// one of the two `NonSteerableTurnKind`s, and a compaction runs as its own
		// turn (`resources/fixtures/codex/compact.jsonl` -- a `turn/started`
		// brackets the `contextCompaction` item), so `turnId` names a turn
		// app-server will refuse. The client disables Send while compaction is
		// showing, but a threshold compaction nobody asked for, a second client,
		// and a prompt written straight to the socket all reach here; without this the well-defined "busy"
		// becomes an opaque wire error, which is what `compact`'s own guard below
		// exists to prevent.
		// A turn this adapter has already interrupted is the other live turn that
		// must not be steered (OW-pefawi). `abort()` sends `turn/interrupt` and
		// only `turn/completed` clears `turnId`, so between the two this still
		// holds an id -- and `expectedTurnId` is a precondition app-server checks
		// against the *currently active* turn (`resources/codex-protocol/v2/
		// TurnSteerParams.ts`), which a turn being torn down is not. Stop-then-send
		// is an ordinary gesture, so the window is reachable by hand; refusing here
		// keeps the well-defined "busy" the caller got before `submit()` gained a
		// steer path instead of spending a round trip to translate app-server's
		// error text back into one.
		if (this.turnId && this.interruptedTurnId === this.turnId) {
			throw new Error(TURN_INTERRUPTED_ERROR);
		}
		if (this.turnId && !this.reducer.getState().compaction) {
			const expectedTurnId = this.turnId;
			try {
				await client.request("turn/steer", { threadId, input, expectedTurnId });
			} catch (error) {
				// `expectedTurnId` is only one of several preconditions app-server
				// enforces on a steer, and `resources/codex-protocol/v2/
				// TurnSteerParams.ts` documents them in prose with no structured
				// code beside them, so the rejection arrives as wire text naming
				// neither which precondition tripped nor the id this adapter sent.
				// The guards above close every window known to reach here, so this
				// is a backstop for the next one: it classifies nothing and retries
				// nothing, only wrapping app-server's own message in a greppable
				// frame that carries the attempted turn id (OW-gemawu). The cast
				// holds because `CodexClient.request` rejects only with an `Error`:
				// `Pending.reject` is typed to one, and every path in `jsonrpc.ts`
				// that reaches it normalizes first.
				const { message } = error as Error;
				throw new Error(`${TURN_STEER_REJECTED_ERROR} (expectedTurnId ${expectedTurnId}): ${message}`);
			}
			return "started";
		}
		if (this.turnId) throw new Error(TURN_ACTIVE_ERROR);
		// The turn's messages carry the reducer's identity, which otherwise knows
		// only the model and effort `thread/start` or `thread/resume` reported.
		// Set here rather than in `setModel`, since a turn already running keeps
		// its model; and before the request, since the turn's first deltas can
		// arrive with its response.
		this.reducer.setIdentity({ model: this.model, reasoningEffort: this.effort });
		await this.untilStarted("turn/start", () =>
			client.request("turn/start", {
				threadId,
				input,
				// TurnStartParams.model overrides "for this turn and subsequent
				// turns" -- Codex has no standalone set-model request, so this is
				// where `setModel` takes effect.
				...(this.model ? { model: this.model } : {}),
				...(this.effort ? { effort: this.effort } : {}),
			}),
		);
		if (ownership.client !== client || !this.owns(ownership)) {
			throw new Error(TURN_START_ABORTED_ERROR);
		}
		return "started";
	}

	/**
	 * Send `request` behind the gate (`starting`), and resolve once both its
	 * reply and its `turn/started` have come, as `setName` waits on its
	 * `thread/name/updated` (D34 point 5), and within the same deadline. The
	 * reply is awaited first, so a request that fails answers with its own
	 * error, and the gate goes with it.
	 */
	private async untilStarted(method: string, request: () => Promise<unknown>): Promise<void> {
		let gate!: NonNullable<typeof this.starting>;
		const started = new Promise<void>((resolve, reject) => {
			gate = { method, resolve, reject };
		});
		// Rejected by an exit or a disposal while the request is still out,
		// which rejects that too and is what the caller hears.
		started.catch(() => {});
		this.starting = gate;
		try {
			await this.withinDeadline("turn/started", method, request().then(() => started));
		} finally {
			if (this.starting === gate) this.starting = null;
		}
	}

	/**
	 * Settle as `waiting` does, a request that answers only once `event` has
	 * come, or refuse it `eventTimeoutMs` from now with one session error
	 * naming the event (ark3/agentpane#91), as `SessionManager.#start` bounds a
	 * start (D35 point 2). The caller's `finally` releases the wait's state
	 * either way, so the verbs `SessionManager.#serially` queued behind it run;
	 * an event that comes after the miss lands as one nothing waits on.
	 */
	private async withinDeadline(event: string, method: string, waiting: Promise<unknown>): Promise<void> {
		let cancel = (): void => {};
		const missed = new Promise<never>((_, reject) => {
			cancel = this.setTimer(() => {
				const message = `codex sent no ${event} for agentpane's ${method} within ${eventTimeoutMs / 1000}s`;
				this.emitError(message);
				reject(new Error(message));
			}, eventTimeoutMs);
		});
		try {
			await Promise.race([waiting, missed]);
		} finally {
			cancel();
		}
	}

	/**
	 * `what` arrived while the gate held, where only a `turn/started` was
	 * expected: the order `starting` relies on broke. Named once, and the gate
	 * released, so the request answers and the session runs on (D18).
	 */
	private unstarted(what: string): void {
		const gate = this.starting;
		if (!gate) return;
		this.starting = null;
		this.emitError(`codex sent ${what} with no turn/started for agentpane's ${gate.method}`);
		gate.resolve();
	}

	/**
	 * Resolves empty: a steer goes straight to app-server as `turn/steer`, and
	 * this adapter holds no queue of its own to hand back (D16, OW-wisifo).
	 */
	async abort(): Promise<string[]> {
		const client = this.requireClient();
		const turnId = this.turnId;
		if (!turnId) return [];
		// Set before the request, not after: the turn is no longer steerable from
		// the moment app-server sees the interrupt, and a failed interrupt leaves a
		// turn that still runs and still completes, which clears this.
		this.interruptedTurnId = turnId;
		await client.request("turn/interrupt", { threadId: this.requireThread(), turnId });
		return [];
	}

	/**
	 * Compact the thread's context via `thread/compact/start` (params
	 * `{ threadId }`, response an empty object -- OW-72, verified against
	 * codex-cli 0.147.0's generated schema).
	 *
	 * Refused while a turn is active, and it stays refused now that `submit()`
	 * steers instead (OW-tifuha): `compact` is one of the two
	 * `NonSteerableTurnKind`s, so there is no steering a compaction into a
	 * running turn, and app-server will not start a second turn while one runs.
	 * Admitting the request here only to have app-server reject it would turn a
	 * well-defined "busy" into an opaque wire error. So it is refused while the
	 * gate holds or `turnId` names a turn, as a `turn/start` would be.
	 *
	 * The compaction runs as a turn of its own, and this answers once its
	 * `turn/started` has come, behind the same gate as `submit`'s, so a prompt
	 * in the window between the reply and that event is refused rather than
	 * taking the compaction's `turn/started` for its own.
	 *
	 * A compaction refused, or whose `turn/started` missed the deadline, takes
	 * its `"requesting"` with it, since that is the request's and no event's,
	 * and would otherwise keep the session compacting with nothing running.
	 */
	async compact(): Promise<void> {
		const client = this.requireClient();
		const threadId = this.requireThread();
		if (this.starting) throw new Error(TURN_START_PENDING_ERROR);
		if (this.turnId) throw new Error(TURN_ACTIVE_ERROR);
		try {
			await this.untilStarted("thread/compact/start", async () => {
				this.applyEffects(this.reducer.requestCompaction());
				await client.request("thread/compact/start", { threadId });
			});
		} catch (error) {
			if (this.reducer.getState().compaction === "requesting") this.applyEffects(this.reducer.cancelCompaction());
			throw error;
		}
	}

	// -- fork-from-past -----------------------------------------------------

	/** A mid-stream `thread/fork` leaves the parent's turn running (`codex-cli` 0.154.0, OW-gojado); D15 stops nothing here. */
	readonly forkStopsTurn = false;

	/**
	 * One fork point per turn, labelled with that turn's *first* user message
	 * and carrying that message's index in the flat transcript.
	 *
	 * Codex forks at *turn* granularity (`ThreadForkParams.lastTurnId`), not at
	 * item granularity, so a fork point is a turn id even though the UI shows
	 * the user message inside it. `thread/rollback` -- DESIGN's other
	 * suggestion -- was marked DEPRECATED in the bindings vendored on
	 * 2026-08-10, is gone from the `codex-cli 0.156.0` ones, and is not used
	 * here.
	 *
	 * A turn can hold more than one user message: steering a running turn
	 * (D16) appends a second `userMessage` item to it, and `mapping.ts` gives
	 * that its own `role: "user"` transcript message. One point per turn is
	 * still right -- the backend cannot cut between them -- so the steered
	 * message simply gets no point, and the UI offers no Edit on it
	 * (OW-roveze). Folding it into the turn's first message instead would hide
	 * a steer that really shipped.
	 *
	 * The index comes from the reducer's own slot map, never from a position
	 * within `turn.items`; see `CodexReducer.indexOfItem`. The turns read
	 * here are a fresh fetch while the reducer holds the live stream, so the two
	 * can disagree about a just-started turn: a slot miss drops the point, which
	 * costs an Edit affordance and never mis-places one.
	 */
	async listForkPoints(): Promise<ForkPoint[]> {
		const client = this.requireClient();
		const turns = await readTurns(client, this.requireThread());
		this.rememberTurns(turns);
		const points: ForkPoint[] = [];
		for (const turn of turns) {
			const first = firstUserItem(turn.items ?? []);
			if (!first) continue;
			const index = this.reducer.indexOfItem(first.id);
			if (index === null) continue;
			points.push({ id: turn.id, text: first.text, index });
		}
		return points;
	}

	async fork(entryId: string): Promise<ForkResult> {
		const client = this.requireClient();
		const cwd = this.cwd;
		if (!this.turnOrder.length) await this.listForkPoints();
		const index = this.turnOrder.indexOf(entryId);
		if (index < 0) throw new BackendRefusedError(`unknown fork point: ${entryId}`);
		// No `thread/fork` keeps nothing. As of `codex-cli` 0.156.0 one with no
		// `lastTurnId` kept the parent's whole history, and one naming `""` or
		// an unknown turn was refused with `-32600 turn not found`
		// (`docs/MANUAL_TESTING.md`, OW-hojefo). So a fork at the first user
		// message is a fresh thread in the parent's workspace, as Claude Code's
		// session-start fork is: nothing is minted here, its own adapter spawns
		// its own app-server and `thread/start`s it, and the id is a placeholder
		// until that names the thread, as a D9 virtual session's is. No borrower,
		// since there is no thread whose writer lock this process holds. It runs
		// at the parent's model and effort in force, which nothing stored could
		// give back (D23).
		if (index === 0) {
			if (!cwd) throw new Error("codex adapter not started");
			const { model, effort } = this.getState();
			return {
				ref: { backend: "codex", id: `virtual:${randomUUID()}` },
				start: {
					cwd,
					...(model ? { model } : {}),
					forkOf: { parentId: this.requireThread(), entryId, ...(effort ? { effort } : {}) },
				},
			};
		}
		// `lastTurnId` is inclusive, so forking *at* a user message means
		// keeping everything through the turn before it.
		const lastTurnId = this.turnOrder[index - 1];
		// Both policies are spelled out because a fork inherits `approvalPolicy`
		// from its parent but NOT `sandbox`, which falls back to app-server's
		// `workspaceWrite` -- a silent downgrade from the thread being forked
		// (OW-18, D7a). Passing `approvalPolicy` too keeps the three
		// thread-creation paths reading alike rather than relying on that
		// asymmetry holding.
		const forked = await client.request<ThreadForkResponse>("thread/fork", {
			threadId: this.requireThread(),
			...(lastTurnId ? { lastTurnId } : {}),
			...(cwd ? { cwd } : {}),
			sandbox: this.sandbox,
			approvalPolicy: this.approvalPolicy,
			...(this.options.ephemeral ? { ephemeral: true } : {}),
			// Nothing here reads the fork's turns; its own adapter pages them in.
			excludeTurns: true,
		});
		// Codex flushes the forked rollout to disk here, before any turn (as of
		// `codex-cli` 0.154.0, D9), so the index finds it -- but finding it is
		// not enough to open it. As of `codex-cli` 0.154.0 the fork's writer lock
		// is held by THIS process, and a second app-server asking to resume it is
		// refused with `-32600 already has an active writer`, while this process
		// resumes it, drives it, and keeps driving the parent (OW-lajehi,
		// `docs/MANUAL_TESTING.md`). So the fork's adapter is built here, sharing
		// this connection, and `start` is the plain resume it must be started
		// with; `SessionManager` starts the adapter it is handed rather than
		// asking the factory for one that would spawn.
		const connection = this.connection;
		if (!connection || !cwd) throw new Error("codex adapter not started");
		const forkRef: SessionRef = { backend: "codex", id: forked.thread.id };
		const borrower = new CodexAdapter(forkRef, this.options);
		borrower.adoptConnection(connection, forked.thread.id, cwd);
		return { ref: forkRef, start: { cwd, resumeId: forked.thread.id }, adapter: borrower };
	}

	// -- state --------------------------------------------------------------

	getState(): AdapterState {
		return { ...this.reducer.getState(), model: this.model, effort: this.effort ?? this.reducer.effort, name: this.name };
	}

	onUpdate(cb: (state: AdapterState, change: StateChange) => void): Unsubscribe {
		this.updateListeners.add(cb);
		return () => this.updateListeners.delete(cb);
	}

	onError(cb: (message: string) => void): Unsubscribe {
		this.errorListeners.add(cb);
		return () => this.errorListeners.delete(cb);
	}

	/**
	 * Codex's four warning notifications (OW-tujiya). Which sessions hear one
	 * follows from the connection they share: every adapter on an app-server
	 * gets every line it writes (a fork's borrower, OW-lajehi), and the
	 * reducer's cross-thread guard keeps one naming a thread to that thread's
	 * adapter. One naming no thread -- a `configWarning`, a
	 * `deprecationNotice`, a `warning` with a null `threadId` -- is about the
	 * app-server itself, so it reaches every session that app-server serves,
	 * each of which is running on the thing it warns about. So does a `warning`
	 * or `guardianWarning` naming a thread no session drives -- usually a D19
	 * subagent's -- which the connection hands out as though it named none
	 * rather than let every reducer drop it (`CodexConnection.#deliver`,
	 * OW-weyefe). Not D13's session-less `notice` arm: that is for conditions
	 * belonging to no session, and this one belongs to exactly these.
	 */
	onNotice(cb: (notice: AgentNotice) => void): Unsubscribe {
		this.noticeListeners.add(cb);
		return () => this.noticeListeners.delete(cb);
	}

	onRefChanged(cb: (ref: SessionRef, cause: "rename" | "fork") => void): Unsubscribe {
		this.refListeners.add(cb);
		return () => this.refListeners.delete(cb);
	}

	/**
	 * Take `threadId` as the id, announcing it when it is a different one. Always
	 * a rename: a Codex fork is another thread with an adapter of its own.
	 */
	private moveTo(threadId: string): void {
		if (threadId === this.currentRef.id) return;
		this.currentRef = { backend: "codex", id: threadId };
		for (const listener of [...this.refListeners]) listener(this.currentRef, "rename");
	}

	// -- session controls ---------------------------------------------------

	/**
	 * Takes effect on the next `turn/start`; Codex has no standalone set-model
	 * call. A chosen effort the new model does not list falls back to that
	 * model's default rather than going out on a turn it would not suit.
	 *
	 * Unlike Pi and Claude Code, an unknown model is not refused here: as of
	 * `codex-cli 0.156.0` Codex did not refuse a made-up id itself but ran it
	 * on fallback metadata, and the upstream API refused it for a
	 * ChatGPT-account login, as a failed turn after `turn/start` had answered.
	 * Whether that upstream refuses every real id `model/list` omits could
	 * not be measured, so checking against `listModels` could reject a model
	 * Codex would run (`docs/MANUAL_TESTING.md`, OW-wawuzu).
	 */
	async setModel(model: string): Promise<void> {
		if (this.effort) {
			const info = (await this.listModels()).find((candidate) => candidate.id === model);
			if (info && !info.efforts.some((option) => option.id === this.effort)) this.effort = info.defaultEffort;
		}
		this.model = model;
		this.emitUpdate("status");
	}

	/**
	 * `thread/name/set`, the method's spelling as of `codex-cli 0.154.0`: the
	 * `thread/setName` its params type suggests was refused with `-32600`.
	 *
	 * The name is taken from the `thread/name/updated` it also sends, not from
	 * its `{}` reply (D34 point 5), and this resolves once both have arrived,
	 * so the session's update goes out before the command's reply as D31
	 * orders them. On `codex-cli 0.154.0`, and mid-turn on `0.160.0`, the
	 * event came after the reply (docs/MANUAL_TESTING.md, "All three backends
	 * rename an attached session over the wire" and OW-kametu); the wait is
	 * armed before the request, so either order resolves it. App-server
	 * exiting, or the adapter being disposed, rejects the wait, and so does
	 * `eventTimeoutMs` passing with the reply or the event still to come
	 * (`withinDeadline`).
	 *
	 * Refused while the transcript is empty, which stands in for a thread not
	 * yet prompted: as of `codex-cli 0.160.0` a rename on one wrote a
	 * `session_index.jsonl` line and a sqlite `threads` row for a thread with
	 * no rollout, both outliving the process, which is the empty session D9
	 * promises opening one never leaves behind (docs/MANUAL_TESTING.md,
	 * OW-kametu). A first turn whose user message has not reached the reducer
	 * is empty too, and is refused with it; both clients withhold Rename then
	 * anyway, as mid-turn, and on an empty transcript as here.
	 */
	async setName(name: string): Promise<void> {
		if (this.reducer.getState().messages.length === 0) {
			throw new BackendRefusedError("a Codex thread cannot be named before its first prompt");
		}
		const client = this.requireClient();
		const params: ThreadSetNameParams = { threadId: this.requireThread(), name };
		let renaming!: NonNullable<typeof this.renaming>;
		const renamed = new Promise<void>((resolve, reject) => {
			renaming = { resolve, reject };
		});
		this.renaming = renaming;
		try {
			await this.withinDeadline(
				"thread/name/updated",
				"thread/name/set",
				Promise.all([client.request<ThreadSetNameResponse>("thread/name/set", params), renamed]),
			);
		} finally {
			if (this.renaming === renaming) this.renaming = null;
		}
	}

	/** Takes effect on the next `turn/start`, like `setModel`. */
	async setEffort(effort: string): Promise<void> {
		this.effort = effort;
		this.emitUpdate("status");
	}

	async listModels(): Promise<ModelInfo[]> {
		const client = this.requireClient();
		const models: ModelInfo[] = [];
		let cursor: string | null = null;
		// `model/list` paginates; the cap is a guard against a server that
		// keeps handing back a cursor.
		for (let page = 0; page < 20; page++) {
			const response: ModelListResponse = await client.request<ModelListResponse>("model/list", {
				...(cursor ? { cursor } : {}),
			});
			for (const model of response.data ?? []) {
				models.push({
					id: model.id,
					label: model.displayName || model.id,
					efforts: model.supportedReasoningEfforts.map((option) => ({
						id: option.reasoningEffort,
						description: option.description,
					})),
					defaultEffort: model.defaultReasoningEffort,
				});
			}
			cursor = response.nextCursor ?? null;
			if (!cursor) break;
		}
		return models;
	}

	// -- internals ----------------------------------------------------------

	private onServerMessage(msg: CodexServerMessage): void {
		if ("method" in msg) {
			switch (msg.method) {
				case "turn/started": {
					if (msg.params.threadId !== this.threadId) return;
					this.turnId = msg.params.turn.id;
					this.starting?.resolve();
					this.starting = null;
					break;
				}
				case "thread/status/changed": {
					const { threadId, status } = msg.params;
					if (threadId === this.threadId && status.type !== "active") {
						this.unstarted(`thread/status/changed to ${status.type}`);
					}
					break;
				}
				case "thread/name/updated": {
					// Every adapter on a shared app-server hears every thread's (OW-lajehi).
					if (msg.params.threadId !== this.threadId) return;
					this.name = msg.params.threadName ?? null;
					this.emitUpdate("status");
					this.renaming?.resolve();
					break;
				}
				case "turn/completed": {
					if (msg.params.threadId !== this.threadId) return;
					const completedTurnId = msg.params.turn.id;
					this.unstarted(`turn/completed for turn ${completedTurnId}`);
					if (this.turnId === completedTurnId) this.turnId = null;
					if (this.interruptedTurnId === completedTurnId) this.interruptedTurnId = null;
					break;
				}
			}
		}
		this.applyEffects(this.reducer.handle(msg));
	}

	private applyEffects(effects: CodexEffect[]): void {
		for (const effect of effects) {
			switch (effect.type) {
				case "message":
					this.emitUpdate(effect.index);
					break;
				case "reset":
					this.emitUpdate("transcript");
					break;
				case "streaming":
				case "compaction":
					this.emitUpdate("status");
					break;
				case "request": {
					// agentpane never holds an agent request (D2a): it is refused
					// here, in the tick it arrives, and named in a session error.
					// A kind with no entry in `DECLINE_RESPONSES` is one nothing here
					// can answer, and under D7a (`approvalPolicy: "never"`, with no
					// approval `ServerRequest` observed as of `codex-cli 0.154.0`)
					// nothing should be arriving at all -- so reaching this line means
					// a premise broke, most likely a newer app-server asking for
					// something new. This is not rudeness to a legitimate request: the
					// alternative is D2a's silent stall, a turn that blocks until the
					// session is killed, with no test and no log naming the cause.
					// Erroring out costs one turn and names the kind that did it.
					//
					// Either reply is dropped once the child is gone, so a request
					// line still draining after it died cannot throw out of the line
					// handler (`ChildProcessShell.reply`, OW-yofoli). The kind is
					// still named: it is what arrived.
					const client = this.requireClient();
					if (!Object.hasOwn(DECLINE_RESPONSES, effect.kind)) {
						client.respondError(
							effect.requestId,
							UNSUPPORTED_REQUEST_CODE,
							`agentpane cannot answer ${effect.kind}`,
						);
						this.emitError(
							`codex sent an unsupported request (${effect.kind}); agentpane declined it`,
						);
						break;
					}
					// A kind with a decline shape is answered with it -- an approval
					// answered with a JSON-RPC error would read as a client failure
					// rather than a "no" (OW-zisumi).
					client.respond(effect.requestId, DECLINE_RESPONSES[effect.kind]);
					this.emitError(
						`codex sent a request agentpane cannot answer (${effect.kind}); agentpane declined it`,
					);
					break;
				}
				case "error":
					this.emitError(effect.message);
					break;
				case "notice":
					for (const listener of [...this.noticeListeners]) listener(effect.notice);
					break;
			}
		}
	}

	private emitUpdate(change: StateChange): void {
		const state = this.getState();
		for (const listener of [...this.updateListeners]) listener(state, change);
	}

	private emitError(message: string): void {
		for (const listener of [...this.errorListeners]) listener(message);
	}

	private owns(ownership: ClientOwnership): boolean {
		return (
			!this.disposed &&
			ownership.ready &&
			this.ownership === ownership &&
			this.proc === ownership.proc &&
			this.client === ownership.client
		);
	}

	private readStoredTurn(threadId: string): Promise<CodexTurnSettings | null> {
		return readCodexLastTurnSettings(this.options.codexRoot ?? codexSessionsRoot(), threadId);
	}

	private rememberTurns(turns: Turn[]): void {
		this.turnOrder = turns.map((turn) => turn.id);
	}

	/**
	 * The client, and the assertion that this adapter has been started.
	 *
	 * Both halves are needed. A borrower holds a live client from the moment
	 * `adoptConnection` builds it, and its `threadId` is seeded there too, so
	 * `client`-and-`threadId` alone would let `submit`, `compact`, `abort`,
	 * `fork` and `listForkPoints` write real JSON-RPC for a thread no
	 * `thread/resume` has opened -- past a guard whose message says the opposite.
	 */
	private requireClient(): CodexClientView {
		if (!this.client || !this.startCalled) throw new Error("codex adapter not started");
		return this.client;
	}

	private requireThread(): string {
		if (!this.threadId) throw new Error("codex adapter has no thread");
		return this.threadId;
	}
}

/**
 * Every turn of the thread, oldest first, each with all of its items.
 *
 * Paged through `thread/turns/list` rather than loaded whole by `thread/resume`,
 * `thread/fork` or `thread/read {includeTurns:true}`. As of `codex-cli` 0.156.0
 * each of those three drew a `deprecationNotice` -- "Full-history hydration is
 * deprecated for paginated threads" -- on every call for a `paginated` thread,
 * which is what `thread/start` created, while `thread/turns/list` at
 * `itemsView: "full"` answered the same turn ids with the same items for
 * `paginated` and `legacy` threads alike and drew nothing
 * (docs/MANUAL_TESTING.md, OW-kelene). So one path serves both modes.
 * `itemsView` is spelled out because its default, `summary`, kept only some of
 * a turn's items, and the reducer's replay needs every one.
 *
 * Every page is fetched: transcripts are small, and loading only the recent
 * end would be a change of its own.
 */
async function readTurns(client: CodexClientView, threadId: string): Promise<Turn[]> {
	const turns: Turn[] = [];
	let cursor: string | null = null;
	do {
		const page: ThreadTurnsListResponse = await client.request<ThreadTurnsListResponse>("thread/turns/list", {
			threadId,
			sortDirection: "asc",
			itemsView: "full",
			...(cursor ? { cursor } : {}),
		} satisfies ThreadTurnsListParams);
		turns.push(...page.data);
		cursor = page.nextCursor;
	} while (cursor);
	return turns;
}

/**
 * The turn's first `userMessage` item -- its id, which is the reducer's key
 * into the flat transcript, and its text, which is the fork point's label.
 */
function firstUserItem(items: { type: string }[]): { id: string; text: string } | null {
	for (const item of items) {
		if (item.type !== "userMessage") continue;
		const id = (item as { id?: unknown }).id;
		if (typeof id !== "string") return null;
		const content = (item as { content?: UserInput[] }).content ?? [];
		const text = content
			.filter((part): part is Extract<UserInput, { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		return { id, text };
	}
	return null;
}

export class CodexAdapterFactory implements AdapterFactory {
	private readonly options: CodexAdapterOptions;

	constructor(options: CodexAdapterOptions = {}) {
		// One registry across every adapter this factory builds, and across the
		// borrowers they mint in `fork()` -- which inherit these same options. It
		// lives here rather than at module scope so two factories cannot see each
		// other's app-servers (OW-voyezi).
		this.options = { connections: new CodexConnectionRegistry(), ...options };
	}

	create(ref: SessionRef): BackendAdapter {
		if (ref.backend !== "codex") {
			throw new Error(`CodexAdapterFactory cannot create a "${ref.backend}" adapter`);
		}
		return new CodexAdapter(ref, this.options);
	}
}
