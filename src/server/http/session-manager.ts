/**
 * The process table: a handle the manager mints -> the container holding a
 * running adapter, with the backend's current id for the conversation as its
 * one name, which a rename moves (D24, OW-suyinu, D35 point 1).
 *
 * Two rules from DESIGN carry most of the weight here:
 *
 *  - **Spawn on attach, not on list** (D9). Listing 973 sessions costs a
 *    filesystem walk; a subprocess is only created when a session is actually
 *    opened or prompted.
 *  - **The subprocess outlives the connection.** Its lifetime is tied to the
 *    server, not to a client's socket. A browser refresh drops the socket and
 *    the agent keeps working; reconnect is a repaint. A close disposes an
 *    adapter, whether a client asked for it or D12's idle reaper or cap made
 *    it, and so does server shutdown.
 */

import type {
	AgentNotice,
	BackendId,
	ListSessionsQuery,
	PromptDisposition,
	SessionRef,
	SessionStatus,
	LiveSessionSummary,
	SessionSummary,
} from "../../shared/protocol.ts";
import { sessionKey } from "../../shared/protocol.ts";
import type {
	AdapterState,
	BackendAdapter,
	ForkResult,
	ImageInput,
	StartOptions,
	StateChange,
	Unsubscribe,
} from "../adapters/types.ts";
import type { Broadcaster } from "./broadcaster.ts";
import type { AppDeps, SessionIndex } from "./deps.ts";

/**
 * D12's cap: the most agents the manager runs at once, counting those still
 * starting. A startup that would pass it closes the least recently attached
 * session the exemption predicate allows, or is refused (`#makeRoom`).
 */
export const maxSessions = 16;
/** D12's idle timeout: a session with no attach, prompt, turn end or compaction end for this long is closed (`#active`). */
export const idleTimeoutMs = 15 * 60 * 1000;
/**
 * D35's deadline on a start: an adapter whose `start()` has not settled this
 * long after it was called is reaped and its start refused with
 * `StartTimeoutError` (`#start`). A first cut: no start times were measured.
 */
export const startTimeoutMs = 60 * 1000;

export class UnknownBackendError extends Error {
	constructor(readonly backend: string) {
		super(`no adapter registered for backend "${backend}"`);
		this.name = "UnknownBackendError";
	}
}

export class ServerShuttingDownError extends Error {
	constructor() {
		super("server is shutting down; not spawning a new agent");
		this.name = "ServerShuttingDownError";
	}
}

export class UnknownSessionError extends Error {
	constructor(readonly ref: SessionRef) {
		super(`no such session: ${sessionKey(ref)}`);
		this.name = "UnknownSessionError";
	}
}

/** `forkAndPrompt` named a transcript index no fork point of the session names (D20). */
export class NotAForkPointError extends Error {
	constructor(readonly index: number) {
		super(`the message at index ${index} is not a fork point of this session`);
		this.name = "NotAForkPointError";
	}
}

/**
 * `forkAndPrompt` created the fork and then failed: its prompt was refused
 * once its attach had published, or a Pi fork failed after it had moved the
 * adapter onto the fork. `cause` is that refusal, which the caller answers as
 * it would on its own, naming `fork` beside it; the fork stays (D17, D30). A
 * fork whose own start fails is not one: it leaves nothing, and is refused
 * with that failure alone (D35 point 6).
 */
export class ForkNotPromptedError extends Error {
	constructor(
		override readonly cause: unknown,
		readonly fork: { ref: SessionRef; handle: string | null },
	) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = "ForkNotPromptedError";
	}
}

/**
 * A prompt named a handle the session it was sent to is no longer live
 * under: closed, or closed and attached again under another (D30). Refused as
 * a session not attached, and nothing is started for it. A close names a
 * handle too, and is refused with this where no live session is under it,
 * which may name no session at all (`ref` null, D35 point 3).
 */
export class HandleEndedError extends Error {
	constructor(
		readonly ref: SessionRef | null,
		readonly handle: string,
	) {
		super(ref ? `session ${sessionKey(ref)} is not attached under handle ${handle}` : `no live session under handle ${handle}`);
		this.name = "HandleEndedError";
	}
}

/**
 * `attachAndSubmit` attached the session and then its prompt was refused.
 * `cause` is that refusal, which the caller answers as it would on its own,
 * naming `attached` beside it, so a client binds the view that sent it to the
 * live session (D30).
 */
export class AttachedNotPromptedError extends Error {
	constructor(
		override readonly cause: unknown,
		readonly attached: { ref: SessionRef; handle: string },
	) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = "AttachedNotPromptedError";
	}
}

/**
 * A startup found `maxSessions` agents live or starting and none it may
 * close: each streaming, compacting, still starting, or created and not yet
 * prompted (D12). Refused at once rather than waiting for one to free.
 */
export class AtCapacityError extends Error {
	constructor() {
		super(
			`at capacity: all ${maxSessions} live sessions are busy (streaming, compacting, starting, or not yet prompted); detach one and try again`,
		);
		this.name = "AtCapacityError";
	}
}

/** An adapter's `start()` outran `startTimeoutMs`, and the adapter was reaped (D35 point 2). */
export class StartTimeoutError extends Error {
	constructor(readonly ref: SessionRef) {
		super(`the agent for ${sessionKey(ref)} did not start within ${startTimeoutMs / 1000}s, and was stopped`);
		this.name = "StartTimeoutError";
	}
}

/** `setEffort` named a level the session's model does not list (OW-tewofe). */
export class EffortNotOfferedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EffortNotOfferedError";
	}
}

interface ManagedSession {
	/**
	 * What the table is keyed by: minted when the container comes into being
	 * (`#container`) and never changed, opaque, and unique across server
	 * processes, not only within one (D24, OW-suyinu, OW-kimaya). It rides `SessionSummary` and every
	 * per-session event beside `ref`, and a rename leaves it where it is, so
	 * anything keyed by it -- here, in the broadcaster, or in a client -- has
	 * nothing to re-key. A fork is another conversation and another container,
	 * with a handle of its own (`#forkOnto`).
	 */
	readonly handle: string;
	/**
	 * The backend's id for this conversation now, which a rename moves (D9),
	 * and its one name: while the container is in the table `#names` resolves
	 * it to `handle`, and nothing else does. An id it has outgrown reaches
	 * nothing, and a spelling `#start` canonicalised was never a name (D35
	 * point 1).
	 */
	ref: SessionRef;
	/** The workspace the subprocess is (or will be) jailed to. */
	cwd: string;
	model?: string;
	/** True until the session has been prompted for the first time (D9 `virtual`). */
	virtual: boolean;
	/**
	 * Whether the backend's own store has this session, i.e. whether `ref.id` is
	 * a real backend id that can be resumed. False for anything we minted here:
	 * a `virtual:` id means nothing to Pi or Codex.
	 */
	fromStore: boolean;
	/**
	 * Whether the session index has listed this session, reported as
	 * `SessionSummary.onDisk`. `fromStore` cannot stand in: it is fixed at
	 * creation, and a session created here reaches the store at its first turn
	 * (D9). `list()` sets it once the index has the file, so `summaryOf` -- which
	 * does not walk the index -- can say so too; a fork's container starts with
	 * it false (`#forkOnto`).
	 */
	onDisk: boolean;
	/**
	 * Published by `#start` once `start()` resolves. A Pi fork takes it onto the
	 * fork's container and leaves this one without (`#forkOnto`); `close()`
	 * leaves it in place on the container it took out of the table.
	 */
	adapter?: BackendAdapter;
	/**
	 * The startup building this container, from its claim until it publishes
	 * (`#start`), for an attach that finds the container to join (D35 point 5).
	 * Teardown never reads it: shutdown reaches a startup through `#startups`,
	 * and a close reaches none (D35 point 3).
	 */
	starting?: PendingStart;
	/** Last state we broadcast, so we can tell a status flip from a message change. */
	lastStreaming: boolean;
	lastCompaction: "requesting" | "running" | null;
	lastModel: string | null;
	lastEffort: string | null;
	lastUnrestoredModel: string | null;
	/** The adapter's `name` as last seen; a change is announced as `sessions-changed`, never a `status`. */
	lastName: string | null;
	/**
	 * What the adapter's `onError` and `onNotice` have said, held
	 * for every snapshot to carry (OW-bipume): a client that was not holding a
	 * view when the event went out -- one that connects or reconnects later, or
	 * one the startup window or a fork left without one -- has no other
	 * way to learn of it. Each follows the lifecycle the client applies to its
	 * own copy, or a snapshot would resurrect what the client had cleared:
	 * `error` is cleared at `submit` and `clearError`, each retracting it on
	 * the wire, which is what drops a client's copy (OW-jopifu, OW-lohubo),
	 * and notices only accumulate -- save that one identical to a notice
	 * already held is neither held nor fanned out again (OW-piloni). They live
	 * on the container, so a rename leaves them where they are and a close
	 * drops them; a fork's container takes all but `error` (`#forkOnto`).
	 */
	error: string | null;
	/**
	 * Which raise `error` holds: minted by `#errorsRaised` as each is set, so
	 * two errors with the same text are still two errors (OW-lameke). Clients
	 * hold it and send it back, and outlive a restart, so it carries
	 * `#handlePrefix` as a handle does: a restarted server's first error must
	 * not answer to the id of the old process's first (OW-jokoto). Left as it
	 * was when `error` is cleared, so it names nothing unless `error` is set.
	 */
	errorId: string;
	notices: AgentNotice[];
	createdAt: string;
	/** What the index told us about this session, kept so attach need not re-walk. */
	stored?: SessionSummary;
	/**
	 * What teardown does to stop an adapter writing a name onto this container,
	 * or forking a container out of it, after it left the table: `close()` and
	 * `disposeAll()` drop these in the same synchronous run that takes the
	 * container out, so no `onRefChanged` reaches `#rename` or `#forkOnto` for
	 * it afterwards (OW-yavewa, OW-jimasu). No flag says so; unsubscription is
	 * the invariant. A fork moves them onto the fork's container and leaves
	 * these empty, so nothing that reaches the parent's can deafen the adapter
	 * the fork is driving.
	 */
	subscriptions: Unsubscribe[];
	/**
	 * The tail of this session's mutations, which `#serially` runs one at a time
	 * (D24). It orders the adapter, so it goes where the adapter goes: a rename
	 * leaves it on the container, and a Pi fork's container shares it, so a
	 * verb on the fork's ref waits out the fork verb still running on it, whose
	 * tail re-sends the model and hydrates. What the parent's container had
	 * queued stays ahead on that chain and fails when it runs, for want of an
	 * adapter (`#serially`). Always settles fulfilled: a verb's rejection is its
	 * caller's, not the next verb's.
	 */
	queue: Promise<void>;
	/**
	 * D12's LRU recency: what `#attaches` stood at when this container was last
	 * attached, the cap closing the lowest. A prompt or a turn's end leaves it,
	 * as they leave which session was last selected. On the container, never
	 * in a map keyed by a backend id, so a rename leaves it where it is, and a
	 * Pi fork's container takes it (`#forkOnto`).
	 */
	attachedAt: number;
	/**
	 * Cancels D12's idle timer, which `#active` arms at each attach, prompt,
	 * turn end and compaction end; cancelled as the container leaves the
	 * table (`#remove`).
	 */
	idle?: () => void;
}

/**
 * A startup in flight. This exists because `ManagedSession.adapter` is only
 * assigned once `start()` resolves, while the adapter owns a sandboxed child
 * for the whole of `start()` -- `CodexAdapter` holds its process across an
 * `initialize` round trip, `PiAdapter` across a `get_state` probe. Teardown
 * walks `#sessions`, so for that entire window there is a live agent it cannot
 * see, and an agent nothing can see is one nothing will ever reap.
 */
interface PendingStart {
	/** Its container once published; what an attach that joins it awaits. */
	promise: Promise<ManagedSession>;
	/** Assigned the instant the adapter exists, with no `await` in between. */
	adapter?: BackendAdapter;
	/** The single termination both teardown and the startup's failure path await. */
	disposal?: Promise<void>;
}

/**
 * What a fork's own start is handed, from what `adapter.fork` returned, for a
 * fork the session index cannot answer for or cannot be opened from (D35
 * point 6): `start`, the `StartOptions` that open it, and `adapter`, the
 * fork's own adapter where only its parent could build one. Two backends
 * need it, for different reasons:
 *
 *  - Claude Code's fork spawns nothing, so no store file can exist when it
 *    returns (OW-razoki), and `#start`'s index lookup would throw
 *    `UnknownSessionError`. It hands over `start` alone.
 *  - Codex's fork IS on disk, but only the app-server that minted it may
 *    open it (`codex-cli` 0.154.0, OW-lajehi), so it hands over `adapter`
 *    too, already holding a share of the parent's child. A Codex fork that
 *    keeps no turn is minted by nothing until its start, and hands over
 *    `start` alone, as Claude Code's does (OW-hojefo).
 *
 * Nothing holds it beyond the one start it is handed to: a fork whose start
 * fails leaves nothing, as a create does (D30), and nothing reaches it
 * afterwards. The startup takes `adapter` at its claim (`#start`), from
 * which `#terminate` is its one disposal; one no startup claimed, its start
 * refused before the claim, `#attachFork` disposes.
 */
interface ForkStart {
	readonly start: StartOptions;
	adapter?: BackendAdapter;
}

export class SessionManager {
	/** Handle -> the container it names (D24). No map holding a container is keyed by a name. */
	readonly #sessions = new Map<string, ManagedSession>();
	/**
	 * Current ref -> handle, one entry for each container in the table and
	 * nothing else (D35 point 1). `#rename` moves the entry; a container leaves
	 * the map with it, on a close and on a fork alike. Nothing the manager does
	 * after an attach looks its session up here again: `#attach` answers the
	 * container it landed on, so a rename inside its start, which no client has
	 * heard of until it publishes, loses the caller nothing.
	 */
	readonly #names = new Map<string, string>();
	readonly #index: SessionIndex;
	readonly #adapters: Partial<Record<BackendId, { create(ref: SessionRef): BackendAdapter }>>;
	readonly #newId: () => string;
	readonly #now: () => string;
	readonly #setTimer: NonNullable<AppDeps["setTimer"]>;
	/** How many attaches have landed; see `ManagedSession.attachedAt`. */
	#attaches = 0;
	/** The last handle minted; see `#container`. */
	#minted = 0;
	/** How many error ids have been minted; see `ManagedSession.errorId`. */
	#errorsRaised = 0;
	/** What makes this manager's handles and error ids its own; see `#container`. */
	readonly #handlePrefix = crypto.randomUUID();
	/**
	 * Every startup in flight, from its attach until it publishes, joins
	 * another at `#start`'s arbitration, or has reaped what it spawned (D35
	 * point 5). What `disposeAll()` walks to reach an adapter that is still
	 * starting, and what `#makeRoom` counts, a child being reaped included. An
	 * attach finds a startup to join through its container
	 * (`ManagedSession.starting`), never here.
	 */
	readonly #startups = new Set<PendingStart>();
	/**
	 * Guards against replacing an adapter before its predecessor has finished
	 * disposing, so no two adapters share a file (D32 point 5). One entry per
	 * disposal, under the ref of the conversation being disposed (D35 point 4):
	 * a close's under the closed container's ref, and a failed or timed-out
	 * start's reaping under the ref its container had at the claim. By ref and
	 * not by handle, since what it holds back is an attach, which arrives with a
	 * ref after the container and its handle are gone. Registered in the run
	 * that takes the container out of the table (`#dispose`), so
	 * `disposeAll()` waits on these too.
	 */
	readonly #disposing = new Map<string, Promise<void>>();
	/**
	 * Set by `disposeAll()`. The HTTP server is still serving for the whole of
	 * shutdown -- `src/server/index.ts` stops the socket *after* closing the app,
	 * and killing one Codex child can take the full SIGTERM+SIGKILL grace -- so
	 * without this an attach arriving mid-shutdown spawns an agent into a server
	 * that has already walked its tables and is about to exit.
	 */
	#shuttingDown = false;

	constructor(
		deps: Pick<AppDeps, "index" | "adapters" | "newId" | "now" | "setTimer">,
		private readonly broadcaster: Broadcaster,
	) {
		this.#index = deps.index;
		this.#adapters = deps.adapters;
		this.#newId = deps.newId ?? (() => crypto.randomUUID());
		this.#now = deps.now ?? (() => new Date().toISOString());
		this.#setTimer =
			deps.setTimer ??
			((run, ms) => {
				const timer = setTimeout(run, ms);
				return () => clearTimeout(timer);
			});
		broadcaster.setSnapshotSource((handle) => {
			const session = this.#sessions.get(handle);
			if (!session?.adapter) return null;
			// Every write below replaces these arrays rather than mutating them, so
			// they are handed over as they are.
			return {
				ref: session.ref,
				...session.adapter.getState(),
				error: session.error,
				errorId: session.error === null ? null : session.errorId,
				notices: session.notices,
			};
		});
	}

	/** The container in the table whose current ref is `ref`. */
	#lookup(ref: SessionRef): ManagedSession | undefined {
		const handle = this.#names.get(sessionKey(ref));
		return handle === undefined ? undefined : this.#sessions.get(handle);
	}

	/**
	 * A new container, with a freshly minted handle and `ref` as its name.
	 * The handle comes from a counter of the manager's own: `deps.newId` mints
	 * `virtual:` ids, and a test may pin it to one constant.
	 *
	 * The counter alone is unique only within this process, and the handle is
	 * held past it: a browser tab and the Emacs helper outlive a restart, keep
	 * their live views keyed by the handle, and take a snapshot under one they
	 * already hold as that session's (OW-kimaya). A restarted server's `h1`
	 * would land on the old process's `h1`. So every handle carries a prefix
	 * drawn at random for this manager.
	 */
	#container(
		ref: SessionRef,
		init: Pick<ManagedSession, "cwd" | "virtual" | "fromStore" | "onDisk" | "createdAt"> &
			Partial<Pick<ManagedSession, "model" | "stored">>,
	): ManagedSession {
		return {
			handle: `${this.#handlePrefix}:${++this.#minted}`,
			ref,
			...init,
			subscriptions: [],
			lastStreaming: false,
			lastCompaction: null,
			lastModel: null,
			lastEffort: null,
			lastUnrestoredModel: null,
			lastName: null,
			error: null,
			errorId: "",
			notices: [],
			queue: Promise.resolve(),
			attachedAt: 0,
		};
	}

	/** Put a container in the table under its handle, reachable by its ref. */
	#add(session: ManagedSession): void {
		this.#sessions.set(session.handle, session);
		this.#names.set(sessionKey(session.ref), session.handle);
	}

	/** Take a container out of the table, and its ref with it while that still names it. */
	#remove(session: ManagedSession): void {
		if (this.#sessions.get(session.handle) === session) this.#sessions.delete(session.handle);
		session.idle?.();
		session.idle = undefined;
		const key = sessionKey(session.ref);
		if (this.#names.get(key) === session.handle) this.#names.delete(key);
	}

	/**
	 * The id this session actually has now, which is what every event carries.
	 * Returns `ref` unchanged when we know nothing about it.
	 */
	canonicalRef(ref: SessionRef): SessionRef {
		return this.#lookup(ref)?.ref ?? ref;
	}

	/** Refs with live state. */
	liveRefs(): SessionRef[] {
		return [...this.#sessions.values()].filter((s) => s.adapter).map((s) => s.ref);
	}

	/** Handles with live state, i.e. what a freshly connected client needs snapshots of. */
	liveHandles(): string[] {
		return [...this.#sessions.values()].filter((s) => s.adapter).map((s) => s.handle);
	}

	/**
	 * The live session under `handle`, by its ref as of now and its adapter, or
	 * undefined where that handle has ended or was never minted. What the
	 * socket resolves a command's handle through (D31 point 9); a queued verb
	 * is passed the handle as well, and checks it again when it runs.
	 */
	live(handle: string): { ref: SessionRef; adapter: BackendAdapter } | undefined {
		const session = this.#sessions.get(handle);
		return session?.adapter ? { ref: session.ref, adapter: session.adapter } : undefined;
	}

	adapterFor(ref: SessionRef): BackendAdapter | undefined {
		return this.#lookup(ref)?.adapter;
	}

	isAttached(ref: SessionRef): boolean {
		return this.adapterFor(ref) !== undefined;
	}

	/**
	 * Whether a container is in the table under `ref`, which a create's is
	 * from before its start (D35 point 1). What `sessions/preview` asks before
	 * it reads a missing file as the session gone (D26 point 5, D24). Not
	 * `#disposing`: a session a close is still disposing, with nothing on
	 * disk, is going; nor an id the container has outgrown.
	 */
	holds(ref: SessionRef): boolean {
		return this.#names.has(sessionKey(ref));
	}

	/**
	 * Create a session and start its agent, as one operation (D30). It is
	 * `virtual` (D9): nothing touches the backend's store until its first
	 * turn, whatever id the start gives it, so browsing never litters it with
	 * empty sessions. A start that fails leaves nothing behind: the container
	 * goes at the failure itself (`#start`), as every container does whose
	 * start fails, and a retry is a new create. Answers the container's live
	 * summary, under whatever ref the start renamed the minted `virtual:` one
	 * to, which no longer reaches it (D35 point 1).
	 */
	async create(cwd: string, backend: BackendId, model?: string): Promise<LiveSessionSummary> {
		if (this.#shuttingDown) throw new ServerShuttingDownError();
		if (!this.#adapters[backend]) throw new UnknownBackendError(backend);
		const ref: SessionRef = { backend, id: `virtual:${this.#newId()}` };
		this.#add(this.#container(ref, { cwd, model, virtual: true, fromStore: false, onDisk: false, createdAt: this.#now() }));
		try {
			return this.#summary(await this.#attach(ref));
		} catch (err) {
			// A listing taken during the start may have shown it.
			this.broadcaster.sessionsChanged();
			throw err;
		}
	}

	/**
	 * Ensure a subprocess is running for this session, then broadcast a snapshot,
	 * and answer the live summary of the container the attach landed on, whose
	 * `ref` may differ from the one asked for: a lookup canonicalises it, and
	 * the start may rename it (D9, D35 point 1).
	 * Idempotent: attaching an already-attached session re-snapshots (which is
	 * exactly what a session switch wants) without touching the subprocess.
	 */
	async attach(ref: SessionRef): Promise<LiveSessionSummary> {
		return this.#summary(await this.#attach(ref));
	}

	/**
	 * `attach`, with what a fork's own start is handed where there is one
	 * (`#attachFork`): the startup that begins here starts the fork from it.
	 * Answers the container it landed on, from every branch -- a live adapter,
	 * a startup joined, a startup begun -- so its caller reads the session from
	 * that and never looks a ref up again (D35 point 1).
	 */
	async #attach(ref: SessionRef, fork?: ForkStart): Promise<ManagedSession> {
		if (this.#shuttingDown) throw new ServerShuttingDownError();
		// A disposal of this conversation, a close's or a failed start's reaping:
		// waited out before anything is looked for, since no container is in the
		// table under a ref being disposed, and then this starts afresh (D35
		// point 4). A fork's start, should it wait, carries its `ForkStart` on.
		await this.#waitOutDisposal(sessionKey(ref));
		if (this.#shuttingDown) throw new ServerShuttingDownError();
		const existing = this.#lookup(ref);
		if (existing?.adapter) {
			this.#attached(existing);
			this.broadcaster.broadcastSnapshot(existing.handle);
			return existing;
		}
		// The startup building the container, joined. Two attaches of a stored
		// session with no container yet collapse later, at `#start`'s arbitration.
		if (existing?.starting) {
			const joined = await existing.starting.promise;
			this.#attached(joined);
			return joined;
		}

		// In `#startups` before `#start` can spawn anything, so disposeAll()
		// reaches it: a startup teardown cannot see is a startup it cannot stop.
		const pending = {} as PendingStart;
		this.#startups.add(pending);
		pending.promise = this.#start(ref, existing, pending, fork).catch((err: unknown) => {
			this.#startups.delete(pending);
			throw err;
		});
		const session = await pending.promise;
		this.#attached(session);
		this.broadcaster.sessionsChanged();
		this.broadcaster.broadcastSnapshot(session.handle);
		return session;
	}

	/**
	 * Wait out every disposal registered under `key`, one after another, since
	 * another may begin while this waits (D35 point 4). Asks only the tables,
	 * never the index, and its caller checks `#shuttingDown` once it returns.
	 */
	async #waitOutDisposal(key: string): Promise<void> {
		for (let disposal = this.#disposing.get(key); disposal; disposal = this.#disposing.get(key)) await disposal;
	}

	/** An attach landed on `session`: both of D12's clocks, its LRU recency and its idleness. */
	#attached(session: ManagedSession): void {
		session.attachedAt = ++this.#attaches;
		this.#active(session);
	}

	/**
	 * Restart D12's idle clock, at activity of any kind: an attach, a prompt,
	 * a turn's end, a compaction's end. When it runs out the session is
	 * closed, as Detach closes it (D25), unless the exemption predicate spares
	 * it then (`#evictable`); a spared session's clock starts again at what
	 * ends its exemption, its turn's end, its compaction's end or its first
	 * prompt. A compaction's start does not restart it: the session is exempt
	 * until the end, which does. Only for a container in the table, which the
	 * timer checks again when it fires.
	 */
	#active(session: ManagedSession): void {
		if (this.#sessions.get(session.handle) !== session) return;
		session.idle?.();
		session.idle = this.#setTimer(() => {
			session.idle = undefined;
			if (this.#sessions.get(session.handle) === session && this.#evictable(session)) void this.#close(session);
		}, idleTimeoutMs);
	}

	/**
	 * Whether D12's reaper or cap may close `session`: it is live, and neither
	 * streaming nor compacting, whose turn or compaction a close would kill,
	 * nor `virtual`, which has nothing on disk to resume from.
	 */
	#evictable(session: ManagedSession): boolean {
		if (session.adapter === undefined || session.virtual) return false;
		const state = session.adapter.getState();
		return !state.isStreaming && state.compaction === null;
	}

	/**
	 * D12's cap, checked by a startup about to spawn, whatever asked for it:
	 * an attach, a create, a prompt naming a ref, or the attach of a fork
	 * `forkAndPrompt` made. With `maxSessions` agents live or starting, it
	 * closes the least recently attached session `#evictable` allows, as
	 * Detach closes one (D25), or refuses with `AtCapacityError` when there is
	 * none. Synchronous, as the run in `#start` that calls it is: the close
	 * takes its session out of the table at once, and the spawn does not wait
	 * for its disposal, as an attach after a Detach never did.
	 */
	#makeRoom(): void {
		for (;;) {
			const live = [...this.#sessions.values()].filter((session) => session.adapter);
			const starting = [...this.#startups].filter((pending) => pending.adapter);
			if (live.length + starting.length < maxSessions) return;
			const [coldest] = live.filter((session) => this.#evictable(session)).sort((a, b) => a.attachedAt - b.attachedAt);
			if (!coldest) throw new AtCapacityError();
			void this.#close(coldest);
		}
	}

	/**
	 * Run one of a session's mutating verbs once every verb queued on it before
	 * has settled (D24, OW-sewewe). Five verbs join: `submit`, `setModel`,
	 * `setEffort`, `setName` and `compact`, and `forkAndPrompt` joins as a
	 * `fork`, its first half, and then as a `submit` on the fork. Every command runs
	 * as its frame arrives, beside any still running, and any number of
	 * clients can drive one session, so without this two of them overlap on
	 * one adapter -- two
	 * `setModel`s sharing Pi's one `settingModel` flag (OW-woyifu), or an
	 * effort checked against the model a set-model in flight is replacing
	 * (OW-zayefe).
	 *
	 * It orders admission and nothing more. `submit` settles when the backend
	 * admits the turn, not when the turn ends, so nothing here waits behind a
	 * running turn and D16 stands as the adapters implement it. It dedupes
	 * nothing: the same prompt sent twice is admitted twice. The adapters' own
	 * guards stay theirs, each closing a window that ends on a backend event
	 * this cannot see. Admission is not quick everywhere, though: Pi answers
	 * `compact` only once the compaction is done -- `pi 0.84.2`'s response comes
	 * after `compaction_end` in `resources/fixtures/pi/compact.jsonl` -- so on
	 * Pi whatever is queued behind a compaction waits for it (OW-jileku).
	 *
	 * Left out, each for its own reason:
	 *
	 *  - `abort`. It exists to reach a running turn, which is never an item here,
	 *    so all it could wait behind is a settings call, a compaction or a fork,
	 *    and a stop must not wait out a Pi compaction. Left out, it also stays
	 *    what it was for the second abort a client sent ahead of a Pi fork
	 *    until ark3/agentpane#51, which agentpane-mode's `f` sent until
	 *    ark3/agentpane#75 (OW-relehi), and for the stop a "Stop and edit"
	 *    sends at the press, ahead of the fork its send makes: harmless, since
	 *    the fork abandons the turn (D15).
	 *  - `listForkPoints`. A read: it changes nothing a verb here depends on,
	 *    and its answer can be stale by the time a client acts on it whether or
	 *    not it waits.
	 *  - `attach`. It creates the adapter this queues on, and concurrent
	 *    attaches already collapse onto one startup (`#attach`, `#start`).
	 *    Only `sessions/attach`, `create`, a prompt that names a ref, and
	 *    `forkAndPrompt` for the fork it made call it (D25, D30); every other
	 *    command queues on an adapter already there, or is refused.
	 *  - `close` and `disposeAll`. Teardown is ordered by `#disposing`,
	 *    `#shuttingDown` and `#terminate`, and waits behind nothing. A
	 *    verb still queued when it runs reaches the disposed adapter, as an
	 *    overlapping one always did; most verbs fail there, but a Codex
	 *    set-model with no effort chosen only records the model and answers
	 *    success.
	 *
	 * The container is taken at the call, and its adapter when the verb runs.
	 * That split is what keeps a verb sent on a Pi parent's ref and queued
	 * behind a fork of it off the fork, which the fork's split from a rename
	 * (`#forkOnto`, OW-kekoji) says the parent's ref must never reach: the fork
	 * takes the adapter onto a container of its own, the parent's container
	 * keeps none, and the verb fails as a call on any detached session does
	 * (OW-suyinu). The queue itself follows the adapter onto the fork's
	 * container, so a verb sent on the fork's ref while the fork verb is still
	 * running waits for it, and the parent's queued verbs, ahead of it on the
	 * same chain, fail first. A verb sent on the parent's ref after the fork
	 * misses `#lookup`.
	 *
	 * A verb sent for a `handle` runs only on the container under it, and only
	 * while that container is still in the table, at the call and again when
	 * the verb runs; otherwise it is refused with `HandleEndedError` (D30). Every
	 * command on a live session names one (D31 point 9), and a prompt naming a
	 * ref is sent for the handle its attach landed on (`attachAndSubmit`). So a
	 * close that lands while it waits in the queue refuses it, where without a
	 * handle it reaches the disposed adapter, as above.
	 */
	async #serially<T>(
		ref: SessionRef,
		verb: (session: ManagedSession, adapter: BackendAdapter) => Promise<T>,
		handle?: string,
	): Promise<T> {
		const session = this.#lookup(ref);
		const ended = (): boolean =>
			handle !== undefined && (session?.handle !== handle || this.#sessions.get(handle) !== session || !session.adapter);
		if (ended()) throw new HandleEndedError(ref, handle as string);
		if (!session?.adapter) throw new UnknownSessionError(ref);
		const run = session.queue.then(() => {
			if (ended()) throw new HandleEndedError(ref, handle as string);
			const adapter = session.adapter;
			if (!adapter) throw new UnknownSessionError(ref);
			return verb(session, adapter);
		});
		session.queue = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	/**
	 * Drive a turn. This goes through the manager rather than straight at the
	 * adapter because it queues (`#serially`) and because a prompt is what
	 * clears the session's `virtual` flag, and one that starts or joins a
	 * turn its error. An id the backend names for it arrives through
	 * `onRefChanged`, like every other (`#rename`).
	 * Resolves with the adapter's disposition, so the reply can tell its
	 * sender when no turn was started for the prompt (OW-dulipe).
	 * A prompt sent for a `handle` goes only to the live session under it,
	 * and is refused with `HandleEndedError` once that has ended (D30).
	 */
	submit(
		ref: SessionRef,
		text: string,
		images?: ImageInput[],
		priorError = this.errorIdOf(ref),
		handle?: string,
	): Promise<PromptDisposition> {
		return this.#serially(ref, async (session, adapter) => {
			this.#active(session);
			this.markPrompted(session.ref);
			// The session's error goes once the next prompt is admitted and has
			// started or joined a turn, unless a newer one landed meanwhile
			// (OW-31). A prompt the backend handled without a turn keeps it, since
			// nothing replaced what it explained (D3, OW-fakazi). No client clears
			// the error at its prompt's reply, each drops it at the `error-cleared`
			// below (OW-lohubo).
			// `priorError` is the id of the error the sender held when the user
			// sent, null for none (`PromptRequest.priorErrorId`, OW-jokoto): an
			// error raised after that, by the start of an attach the send made or
			// while the request was on its way, is newer than the prompt, and
			// nobody had seen it to clear. A caller that names none gets what the
			// server holds now. It is compared by id, not text, because a newer
			// error can repeat the held one word for word, and one can land before
			// `adapter.submit` resolves (OW-lameke): Pi's and Codex's adapters both
			// handle backend events while awaiting a reply -- the `prompt`
			// command's, and for a Pi id not yet resolved a `get_state` after it
			// (`PiAdapter.submit`); `turn/start`'s or, steering a live turn (D16),
			// `turn/steer`'s (`CodexAdapter.submit`) -- so a steered turn that
			// fails the way the last one did is raised inside it. Claude Code's
			// admission is a synchronous stdin write, so its adapter cannot.
			const disposition = await adapter.submit(text, images);
			// A container `close` took out of the table while the prompt was being
			// admitted is past announcing: its handle is forgotten, and an event
			// under it would re-create the counter and read as a gap to a client
			// still holding it (OW-jopifu). Its error goes nowhere either, since
			// no snapshot is built from a container out of the table.
			if (this.#sessions.get(session.handle) !== session) return disposition;
			if (disposition === "started" && priorError !== null && session.error !== null && session.errorId === priorError) {
				session.error = null;
				// This tells every client, the prompt's own included (OW-lohubo),
				// which no turn-boundary snapshot does any longer (OW-yirosu), and
				// without the snapshot this once took (OW-jopifu).
				this.broadcaster.errorCleared(session);
			}
			return disposition;
		}, handle);
	}

	/**
	 * A prompt that names no handle, sent from a view that knows its session is
	 * not running (D30): attach the session if it must, which starts its agent
	 * where nobody holds it, then prompt the live session that attach landed
	 * on, and answer its live summary with the prompt's disposition.
	 *
	 * The prompt goes to the container that attach answered, under its ref as
	 * of the call and for its handle, so a close and a re-attach landing
	 * between the two refuse it rather than prompting a session the sender
	 * never asked to start, and a rename inside the start costs it nothing.
	 * `priorError` is the caller's to read before the attach, which an error
	 * the attach's start raised is newer than (OW-jokoto). A refusal after the attach is `AttachedNotPromptedError`,
	 * naming the session; a start that fails is answered as its own failure,
	 * and leaves nothing (`create`).
	 */
	async attachAndSubmit(
		ref: SessionRef,
		text: string,
		images: ImageInput[] | undefined,
		priorError: string | null,
	): Promise<{ session: LiveSessionSummary; disposition: PromptDisposition }> {
		const session = await this.#attach(ref);
		try {
			const disposition = await this.submit(session.ref, text, images, priorError, session.handle);
			return { session: this.#summary(session), disposition };
		} catch (cause) {
			throw new AttachedNotPromptedError(cause, { ref: session.ref, handle: session.handle });
		}
	}

	/**
	 * Fork a session from a past entry, as `forkAndPrompt` does, without the
	 * fork point's lookup or the prompt. Since ark3/agentpane#75 took the plain
	 * fork off the wire (D33) no command reaches this one, and it stays as the
	 * seam the tests of forking drive. Like `submit`, this goes through the
	 * manager rather than straight at the adapter because it queues
	 * (`#serially`), and because two of the backends hand back something the
	 * fork's own start needs (`ForkStart`), which this starts at once, as
	 * `forkAndPrompt` does (`#attachFork`). The backends are asymmetric:
	 *
	 *  - Pi's `fork` is copy-on-write: the process's active `sessionFile` MOVES to
	 *    a new file, so the adapter announces a `"fork"` through `onRefChanged`
	 *    and `#forkOnto` moves the adapter onto a container of its own, before
	 *    the adapter re-sends the model and level and hydrates the fork's
	 *    transcript -- so what it emits from there goes out under the fork's
	 *    ref and handle, never the parent's (OW-zovaye, OW-nuzepi). Nothing
	 *    under the parent's handle names the fork -- see `#forkOnto`. The value
	 *    the adapter returns IS its new ref.
	 *  - Codex's `thread/fork` mints a new thread the current adapter is NOT
	 *    driving; its own `ref` is unchanged and it announces nothing. The returned
	 *    ref points at the freshly-flushed forked thread, which differs from
	 *    `adapter.ref` -- so we hand back what `adapter.fork` gave us, not
	 *    `session.ref`. Only the app-server that minted that thread may open it
	 *    (OW-lajehi), so `fork()` also hands over the fork's own adapter, already
	 *    sharing the parent's connection, with the resume that starts it. A
	 *    fork at the first user message is the exception: no `thread/fork`
	 *    keeps nothing, so it takes Claude Code's path below, and its start
	 *    renames its placeholder ref to the thread its `thread/start` names, as
	 *    a virtual session's is (OW-hojefo).
	 *  - Claude Code's `fork` takes Codex's path -- its own ref is unchanged and
	 *    the parent keeps its child and its turn (OW-razoki) -- but nothing has
	 *    recorded the fork yet, so it also hands back the `StartOptions` its own
	 *    adapter must be started with.
	 *
	 * Where the ref DOES change, which is Pi alone, the live adapter is driving
	 * the FORK from there on and the parent is left detached -- still on disk,
	 * still listed, still attachable, but its live container is gone. That is
	 * why the adapter says `"fork"`: unlike a rename, the parent's id must not
	 * become the fork's name (`#forkOnto`, OW-kekoji). The ref this answers is
	 * read from the fork's container where its own start ran, so a rename
	 * inside that start is the ref answered (`#attachFork`).
	 */
	async fork(ref: SessionRef, entryId: string, handle?: string): Promise<SessionRef> {
		const forked = await this.#serially(ref, (_session, adapter) => adapter.fork(entryId), handle);
		return forked.start ? (await this.#attachFork(forked)).ref : forked.ref;
	}

	/**
	 * Attach the fork `adapter.fork` returned, handing what came back with it
	 * to the fork's own start (`ForkStart`), so that a start that fails leaves
	 * nothing, as a create's does (D35 point 6). A Pi fork hands nothing over:
	 * it is already live, and its attach re-snapshots it. Answers the fork's
	 * container, whose ref a Codex fork that keeps no turn has already moved
	 * off the placeholder `forked.ref` names (OW-hojefo).
	 */
	async #attachFork(forked: ForkResult): Promise<ManagedSession> {
		if (!forked.start) return this.#attach(forked.ref);
		const fork: ForkStart = { start: forked.start, ...(forked.adapter ? { adapter: forked.adapter } : {}) };
		try {
			return await this.#attach(forked.ref, fork);
		} finally {
			// An adapter no startup claimed: the start was refused before the
			// claim, by the cap or by shutdown. Nothing else holds it, and its
			// share of the parent's app-server goes with it (OW-lajehi).
			// Swallowed as `#terminate` swallows it: the fork is gone either way.
			await Promise.resolve(fork.adapter?.dispose()).catch(() => {});
		}
	}

	/**
	 * An edit of an earlier message, as one operation (D30): fork at the user
	 * message whose transcript index is `index`, attach the fork, and prompt it.
	 *
	 * The index is resolved against the adapter's fork points and the fork is
	 * made in one item on the parent's queue (`#serially`), so nothing queued
	 * on the session lands between the two, nor between the stop a Pi fork
	 * makes and the fork itself (`BackendAdapter.forkStopsTurn`). An index no
	 * point names is refused with nothing forked (D20).
	 *
	 * The attach and the prompt come after that item has settled, not inside
	 * it: a Pi fork's container shares the parent's queue (`#forkOnto`), so a
	 * prompt queued inside the item would wait on the item itself. The prompt
	 * goes to the container the attach answered, for its handle, never by the
	 * ref `adapter.fork` returned: a Codex fork that keeps no turn is renamed
	 * off that placeholder inside its start, after which it reaches nothing
	 * (OW-hojefo, D35 point 1).
	 *
	 * Admitting the prompt clears no turn error, since nobody has seen one on
	 * the fork: one its start raised stays up (OW-jokoto). A failure once the
	 * fork's attach has published is `ForkNotPromptedError`, naming it, and so
	 * is a Pi fork's after it moved; nothing is removed (D17). A fork whose
	 * own start fails leaves nothing, as a create does, and is refused with
	 * that failure alone, naming no fork, so each client stays on the parent
	 * with the edit open (D30, D35 point 6). A Codex fork's file, written
	 * before that start, stays on disk, an orphan D17 accepts.
	 */
	async forkAndPrompt(
		ref: SessionRef,
		index: number,
		text: string,
		images?: ImageInput[],
		handle?: string,
	): Promise<{ session: LiveSessionSummary; disposition: PromptDisposition }> {
		const forked = await this.#serially(ref, async (session, adapter) => {
			const point = (await adapter.listForkPoints()).find((candidate) => candidate.index === index);
			if (!point) throw new NotAForkPointError(index);
			try {
				return await adapter.fork(point.id);
			} catch (cause) {
				// A Pi fork that announced the move and then failed, re-sending the
				// level or hydrating: the adapter drives the fork from a container
				// of its own (`#forkOnto`), live under the fork's handle. Snapshotted
				// as the attach below would, so the refusal naming that handle
				// follows a view of it, as every refusal naming a live fork does.
				const fork = [...this.#sessions.values()].find((held) => held !== session && held.adapter === adapter);
				if (!fork) throw cause;
				this.broadcaster.broadcastSnapshot(fork.handle);
				throw new ForkNotPromptedError(cause, { ref: fork.ref, handle: fork.handle });
			}
		}, handle);
		const fork = await this.#attachFork(forked);
		try {
			const disposition = await this.submit(fork.ref, text, images, null, fork.handle);
			return { session: this.#summary(fork), disposition };
		} catch (cause) {
			const live = this.#sessions.get(fork.handle) === fork && fork.adapter !== undefined;
			throw new ForkNotPromptedError(cause, { ref: fork.ref, handle: live ? fork.handle : null });
		}
	}

	setModel(ref: SessionRef, model: string, handle?: string): Promise<void> {
		return this.#serially(ref, (_session, adapter) => adapter.setModel(model), handle);
	}

	/** Written through to the backend; the name comes back in the adapter's state, and nowhere here (D27). */
	setName(ref: SessionRef, name: string, handle?: string): Promise<void> {
		return this.#serially(ref, (_session, adapter) => adapter.setName(name), handle);
	}

	/**
	 * Checked here, not trusted to the backend: as of `claude 2.1.280` and
	 * `pi 0.87.1` each answered success for a level the model lacks, and Codex
	 * stores any string for the next turn (OW-tewofe). The model is matched by
	 * id, as both clients match it to offer efforts, so a model that is null or
	 * not listed offers none. Inside the queue, so the model checked against is
	 * the one a set-model queued ahead of this left (OW-zayefe).
	 */
	setEffort(ref: SessionRef, effort: string, handle?: string): Promise<void> {
		return this.#serially(ref, async (_session, adapter) => {
			const { model } = adapter.getState();
			const listed = (await adapter.listModels()).find((info) => info.id === model);
			const efforts = listed?.efforts.map((option) => option.id) ?? [];
			if (!efforts.includes(effort)) {
				const offered = efforts.length > 0 ? `one of ${efforts.join(", ")}` : "none";
				throw new EffortNotOfferedError(
					`effort "${effort}" is not one the session's model (${model ?? "not yet known"}) lists; it offers ${offered}`,
				);
			}
			await adapter.setEffort(effort);
		}, handle);
	}

	compact(ref: SessionRef, handle?: string): Promise<void> {
		return this.#serially(ref, (_session, adapter) => adapter.compact(), handle);
	}

	/**
	 * A rename: one conversation took a new id, announced by its adapter through
	 * `onRefChanged` as it moves and before it emits anything under the new id
	 * (D24). Every backend replaces a `virtual` session's minted id at attach,
	 * a Pi that named no file at start names one at the first prompt, because
	 * Pi's session id IS its JSONL path (D9), and Claude Code would whenever a
	 * turn's `init` named another. The new id replaces the old as the
	 * container's one name, and the old reaches nothing from here (D35 point
	 * 1); nothing is re-keyed, since the handle the table is keyed by does not
	 * move (OW-suyinu). Only a container in the table is in `#names`, and the
	 * old entry goes only while it still names this one; a new one that
	 * another container holds is taken over.
	 *
	 * On the wire a rename is the list invalidation and a snapshot under the
	 * handle, carrying the new ref; every client keys a live session by the
	 * handle and takes the ref from any event under it, so nothing else is
	 * said (OW-mofuho).
	 *
	 * `announce` is false for a rename inside `start()`: the name is moved at
	 * once, so an attach under it finds the one startup, but
	 * nothing goes on the wire until the start can no longer fail, and then
	 * `attach` says it, in the `sessionsChanged` and snapshot it sends for every
	 * start. The hold outlived the event that once said a rename, for which it
	 * was written. The snapshot alone would not need it -- the snapshot source
	 * answers nothing for a container with no adapter published, so it would
	 * not go out -- but the `sessionsChanged` would send every client to a
	 * listing naming the new ref, which a start that then fails takes back
	 * with nothing on the wire to say so.
	 */
	#rename(session: ManagedSession, next: SessionRef, announce: boolean): void {
		const previous = sessionKey(session.ref);
		const key = sessionKey(next);
		if (key === previous) return;
		session.ref = next;
		if (this.#sessions.get(session.handle) === session) {
			if (this.#names.get(previous) === session.handle) this.#names.delete(previous);
			this.#names.set(key, session.handle);
		}
		if (!announce) return;
		this.broadcaster.sessionsChanged();
		this.broadcaster.broadcastSnapshot(session.handle);
	}

	/**
	 * A fork that moved the live adapter: on Pi the one process is driving a
	 * SECOND conversation now (D15), and the first is still on disk, still
	 * listable and still resumable. So the fork gets a container of its own, with
	 * a new handle and the fork's id as its name, and answers as the
	 * container the adapter's handlers reach from here on (`#start`'s `owner`).
	 *
	 * It takes what belongs to the process: the adapter, the subscriptions that
	 * reach it, the notices it raised, and the `last*` mirrors the next update is
	 * measured against, and the queue, which orders the adapter and on which the
	 * fork verb that fired this is still running. It takes nothing that was
	 * about the parent's conversation, and starts with no `error` and the
	 * `stored`, `onDisk` and `createdAt` below.
	 *
	 * The parent's container leaves the table with its name, as any detached
	 * session's does, and keeps no adapter: a command on its ref misses from
	 * here on, a verb queued on it behind this fork fails rather than running
	 * on the fork (`#serially`), and the next attach resumes the parent from
	 * the index into a container of its own (D9, D12). The parent's ref does
	 * not become the fork's, or every client holding it would hold one that
	 * prompts the agent the user is talking to on the fork (OW-kekoji).
	 *
	 * Nothing under the parent's handle names the fork: an event there
	 * carrying a new ref means "this conversation took a new id", and every
	 * client that holds the handle follows its view and selection across. On a
	 * fork that is false for every client, and actively wrong for the ones
	 * that did not fork -- it would throw away a parent transcript the server
	 * still lists and drag a reader onto a conversation nobody there opened
	 * (OW-suhoto). What goes there is `ended`, under the parent's own ref, and
	 * then `sessionsChanged` (D26): a client that did not fork and held the
	 * parent live loses that view and falls to the parent's preview, its
	 * selection standing. The client that forked has the fork's ref from the
	 * response and attaches it, which is what snapshots it under the fork's own
	 * handle.
	 */
	#forkOnto(parent: ManagedSession, next: SessionRef): ManagedSession {
		const fork = this.#container(next, {
			cwd: parent.cwd,
			model: parent.model,
			virtual: parent.virtual,
			fromStore: parent.fromStore,
			// The index's word that a file exists was about the parent. The fork's
			// own may or may not be there yet; the next `list()` says which.
			onDisk: false,
			// `#start` seeded the parent's `createdAt` from its stored summary, and
			// `#ownSummary` reports it as `updatedAt` too. The fork came into being
			// now, and a stamp days older would sort a brand-new fork below the
			// conversations it was forked out of.
			createdAt: this.#now(),
			// No `stored`: that is the index's answer about the PARENT, and
			// carried over, `summaryOf` would dress the parent's `preview` and
			// `updatedAt` in the fork's ref, drawing the fork's row as a copy of the
			// parent's, character for character, now that both rows are listed
			// (OW-kekoji, OW-sehaja). Without it `#ownSummary` answers, whose
			// `preview: null` says "not read from the index yet": Pi is the only
			// backend that gets here and its fork inherits the parent's transcript
			// prefix, so the next `list()` will show the fork's true preview.
		});
		fork.adapter = parent.adapter;
		fork.queue = parent.queue;
		fork.subscriptions = parent.subscriptions.splice(0);
		fork.notices = parent.notices;
		fork.lastStreaming = parent.lastStreaming;
		fork.lastCompaction = parent.lastCompaction;
		fork.lastModel = parent.lastModel;
		fork.lastEffort = parent.lastEffort;
		fork.lastUnrestoredModel = parent.lastUnrestoredModel;
		fork.lastName = parent.lastName;
		fork.attachedAt = parent.attachedAt;
		this.#remove(parent);
		parent.adapter = undefined;
		this.#add(fork);
		this.#active(fork);
		this.broadcaster.forget(parent.handle);
		this.broadcaster.ended(parent);
		this.broadcaster.sessionsChanged();
		return fork;
	}

	async #start(
		ref: SessionRef,
		existing: ManagedSession | undefined,
		pending: PendingStart,
		fork?: ForkStart,
	): Promise<ManagedSession> {
		if (!this.#adapters[ref.backend]) throw new UnknownBackendError(ref.backend);
		let session = existing;
		if (!session && fork) {
			// A fork this manager minted a moment ago. Its workspace and the
			// arguments that open it came back from `fork()`, because the index
			// either cannot answer for it or cannot be acted on -- see
			// `ForkStart`. Its container, and its handle, begin here.
			session = this.#container(ref, {
				cwd: fork.start.cwd,
				virtual: false,
				fromStore: false,
				onDisk: false,
				createdAt: this.#now(),
			});
		}
		if (!session) {
			// Not one of ours yet -- it must exist in the backend's store, and we
			// need its workspace before we can spawn anything (D7).
			const summary = await this.#index.get(ref);
			if (!summary) throw new UnknownSessionError(ref);
			if (this.#shuttingDown) throw new ServerShuttingDownError();
			// The lookup can canonicalise a spelling onto a file whose disposal is
			// still running, a close's or a failed start's reaping, which the wait
			// in `#attach` did not see under the spelling (D35 point 4).
			await this.#waitOutDisposal(sessionKey(summary.ref));
			if (this.#shuttingDown) throw new ServerShuttingDownError();
			if (!summary.cwd) {
				throw new Error(
					`session ${sessionKey(ref)} has no recorded workspace; cannot spawn a sandboxed agent for it`,
				);
			}
			// The arbitration: another attach of this file may have claimed it
			// meanwhile, its own lookup having answered first. Join that container
			// rather than build a second, which would put two adapters on one file
			// (D35 point 5). The spelling this attach asked for becomes no name.
			const held = this.#lookup(summary.ref);
			if (held?.adapter || held?.starting) {
				this.#startups.delete(pending);
				return held.adapter ? held : (held.starting as PendingStart).promise;
			}
			session = this.#container(summary.ref, {
				cwd: summary.cwd,
				virtual: false,
				fromStore: true,
				onDisk: true,
				createdAt: summary.createdAt ?? this.#now(),
				stored: summary,
			});
		}
		const factory = this.#adapters[session.ref.backend];
		if (!factory) throw new UnknownBackendError(session.ref.backend);

		// Asking the index where this session lives, and waiting out a disposal,
		// are the only awaits before an adapter exists, and each is followed by
		// a check of `#shuttingDown`. Everything from there to `pending.adapter`
		// below is synchronous: either teardown sees the adapter, or this sees
		// the flag and never spawns.
		//
		// The claim. No await separates it from the arbitration above, so no
		// competing startup can have claimed this file since.
		session.starting = pending;
		if (!existing) this.#add(session);
		// What a failure's reaping is registered under: the ref the container
		// has now, before a rename inside `start()` can move it (D35 point 4).
		const claimed = sessionKey(session.ref);

		const bound = session;
		// The container this adapter drives, which every handler below reaches
		// through: `bound`, until a Pi fork moves the adapter onto a container of
		// its own (`#forkOnto`), after which its events, and a later rename or
		// fork, belong to that one.
		let owner = bound;
		let adapter: BackendAdapter;
		try {
			// A fork whose adapter came from its parent is started as-is: only that
			// parent's process can drive it, and the factory's adapter would have
			// to find its way back to that process (OW-lajehi). It can, since
			// OW-voyezi -- a Codex adapter resuming a thread a live app-server
			// still holds borrows that connection rather than spawning -- but the
			// handle is still the direct route and the only one that works for a
			// fork whose rollout the index cannot answer for.
			// The cap first, inside the `try`, so a refusal takes the container
			// out as any failed start does. A fork's adapter it refuses is still
			// the fork's to dispose (`#attachFork`).
			this.#makeRoom();
			adapter = fork?.adapter ?? factory.create(bound.ref);
			pending.adapter = adapter;
			// The claim: from here a fork's adapter is this startup's, which
			// teardown and the failure path below each dispose through
			// `#terminate`, once.
			if (fork) fork.adapter = undefined;
			// Subscribe *before* start(): a backend can emit its first state during
			// startup and we would otherwise miss it.
			bound.subscriptions.push(
				adapter.onUpdate((state, change) => this.#onUpdate(owner, state, change)),
				adapter.onRefChanged((next, cause) => {
					if (cause === "fork") owner = this.#forkOnto(owner, next);
					else this.#rename(owner, next, owner.adapter === adapter);
				}),
				// Held on the container as well as fanned out, and from before
				// `start()` resolves: an event raised in that window goes out before
				// any client holds a view of the session, and the attach's snapshot
				// that follows is what delivers it (OW-bipume).
				adapter.onError((message) => {
					owner.error = message;
					owner.errorId = `${this.#handlePrefix}:${++this.#errorsRaised}`;
					this.broadcaster.error(owner, message, owner.errorId);
				}),
			);
			const offNotice = adapter.onNotice?.((notice) => {
				// One condition the backend repeats -- a thread-less warning that recurs
				// on every fork and fork-point listing -- is one notice (OW-piloni).
				const repeated = owner.notices.some(
					(held) =>
						held.kind === notice.kind &&
						held.message === notice.message &&
						held.details === notice.details &&
						held.path === notice.path,
				);
				if (repeated) return;
				owner.notices = [...owner.notices, notice];
				this.broadcaster.notice(owner, notice);
			});
			if (offNotice) bound.subscriptions.push(offNotice);
			// D35's deadline. A start that misses it falls into the failure path
			// below and is reaped there; should its `start()` resolve later,
			// nothing awaits it any more, so it is never published.
			let cancelDeadline = (): void => {};
			const deadline = new Promise<never>((_, reject) => {
				cancelDeadline = this.#setTimer(() => reject(new StartTimeoutError(ref)), startTimeoutMs);
			});
			const started = adapter.start(
				fork?.start ?? {
					cwd: bound.cwd,
					// Only a session the backend itself stored can be resumed; a
					// `virtual:` id means nothing to Pi or Codex.
					...(bound.fromStore ? { resumeId: bound.ref.id } : {}),
					// A resume carries no model, by D23 and not by omission: the
					// store's last turn names it, and the backend or its adapter
					// restores it. Pi does so itself -- as of `pi 0.87.1`, a
					// `--session` spawn with no `--model` ran the model and level
					// the file last recorded over settings defaults naming others,
					// while a `--model <m>:<level>` would override that level
					// (docs/MANUAL_TESTING.md, OW-ruzuhu and OW-pubulu). So no
					// copy of the chosen model is kept here across a close. Where
					// the recorded model had left the catalogue or lost its auth,
					// the same Pi fell back to another and said nothing of it over
					// RPC (OW-zujofa).
					...(bound.model ? { model: bound.model } : {}),
				},
			);
			try {
				await Promise.race([started, deadline]);
			} finally {
				cancelDeadline();
			}
			// Shutdown ran while we were starting. Publishing the adapter now
			// would hand a live agent to a container shutdown has already taken
			// out of the table. Fall through to the same reaping the failure path
			// uses.
			if (this.#shuttingDown) throw new ServerShuttingDownError();
		} catch (err) {
			for (const off of bound.subscriptions.splice(0)) off();
			// The container goes, and in the same run the reaping below is
			// registered under the ref it was claimed under, so an attach of that
			// ref, or one whose lookup names it, waits the reaping out and then
			// starts afresh: nothing joins a failed start, and nothing spawns
			// beside the adapter still being reaped (D35 point 4). Only a container
			// `create` made is in the table without an adapter, and it does not
			// outlive a failed start (D30): a container that has started never
			// starts again, since a close and a Pi fork each take it out.
			this.#remove(bound);
			// The adapter spawns before it decides it has started -- PiAdapter
			// spawns, then round-trips a readiness probe -- so a rejection can
			// leave a live sandboxed agent behind. Nothing else will ever reap it.
			// The startup stays in `#startups` until it is reaped, so the cap
			// counts the child and shutdown waits for it.
			await this.#dispose(claimed, this.#terminate(pending));
			throw err;
		}

		// Publish the adapter and retire the startup in one synchronous run: from
		// here a close of the container's handle finds the adapter on it and
		// disposes it, and `disposeAll()` finds it in the table, where until now
		// it found the startup.
		bound.adapter = adapter;
		bound.starting = undefined;
		this.#startups.delete(pending);
		const initialState = adapter.getState();
		bound.lastStreaming = initialState.isStreaming;
		bound.lastCompaction = initialState.compaction;
		bound.lastModel = initialState.model;
		bound.lastEffort = initialState.effort;
		bound.lastUnrestoredModel = initialState.unrestoredModel ?? null;
		bound.lastName = initialState.name;
		// A rename inside `start()` -- a `virtual` id becoming the backend's own
		// (D9) -- was held off the wire until the start could no longer fail;
		// `attach` says it once this returns (`#rename`).
		return bound;
	}

	/**
	 * D3's tail upsert. The adapter's `change` says what moved, and each kind
	 * goes out as the smallest event that reports it: a changed message as an
	 * upsert carrying the whole message so far, never the transcript; a
	 * status-only change, a turn's start and end among them, as a `status`,
	 * and as nothing when nothing moved; and only a
	 * replaced transcript as a snapshot. A snapshot sends every message to
	 * every client, and the Emacs helper re-projects and redraws all of them,
	 * which on a 348-message session held each prompt 1-2s before its draft
	 * cleared, when both turn boundaries still snapshotted (OW-yirosu).
	 */
	#onUpdate(session: ManagedSession, state: AdapterState, change: StateChange): void {
		const streamingChanged = state.isStreaming !== session.lastStreaming;
		const compactionChanged = state.compaction !== session.lastCompaction;
		// The effort rides with the model: a model change can move it (OW-kokalo).
		// So does a recorded model the resume could not restore (OW-jitoni).
		const unrestoredModel = state.unrestoredModel ?? null;
		const settingsChanged =
			state.model !== session.lastModel || state.effort !== session.lastEffort || unrestoredModel !== session.lastUnrestoredModel;
		session.lastStreaming = state.isStreaming;
		if (streamingChanged && !state.isStreaming) this.#active(session);
		if (compactionChanged && state.compaction === null) this.#active(session);
		session.lastCompaction = state.compaction;
		session.lastModel = state.model;
		session.lastEffort = state.effort;
		session.lastUnrestoredModel = unrestoredModel;

		const statusChanged = streamingChanged || compactionChanged || settingsChanged;
		const message = typeof change === "number" ? state.messages[change] : undefined;
		if (change === "status") {
			if (statusChanged) this.broadcaster.status(session, state.isStreaming, state.compaction, state.model, state.effort, unrestoredModel);
		} else if (typeof change === "number" && message && !compactionChanged) {
			this.broadcaster.upsert(session, change, message);
			if (statusChanged) this.broadcaster.status(session, state.isStreaming, state.compaction, state.model, state.effort, unrestoredModel);
		} else {
			// A replaced transcript, and an index naming no message, which no upsert
			// can express. And a changed message whose compaction moved with it:
			// compaction completion changes the transcript marker and operation
			// state together. Keep that reducer-level atomicity on the wire rather
			// than let an upsert expose the marker while the client still holds
			// `running`. A snapshot carries every status field, so no status event.
			this.broadcaster.broadcastSnapshot(session.handle);
		}

		// The session list sorts on `updatedAt`, which only a re-list carries, so
		// without this the order never moves until someone presses Refresh
		// (OW-furinu). Turn boundaries are the affordable place to say so: two
		// events per turn, not one per token, which is what keeps the client's
		// sort off the streaming path (OW-jineli). The backend writes its own
		// file, so the start-side re-list may still read a timestamp from before
		// the turn; the end-side one always sees the turn's last write.
		// A name rides the listing, not the status: it labels the session's row
		// (D27), and a re-list is what both clients draw rows from. One event
		// covers both, at a turn boundary that also renamed.
		const nameChanged = state.name !== session.lastName;
		session.lastName = state.name;
		if (streamingChanged || nameChanged) this.broadcaster.sessionsChanged();
	}

	/**
	 * Mark a virtual session as prompted, which is when D9 counts it as leaving
	 * `virtual`. Called on the first prompt. Its id may have changed long before,
	 * at attach, so this flag and not the id says whether it can be on disk.
	 */
	markPrompted(ref: SessionRef): void {
		const session = this.#lookup(ref);
		if (session?.virtual) {
			session.virtual = false;
			this.broadcaster.sessionsChanged();
		}
	}

	/**
	 * Which turn error the session holds, as its `errorId`, or null when it
	 * holds none -- including for a session not in the table.
	 */
	errorIdOf(ref: SessionRef): string | null {
		const session = this.#lookup(ref);
		return session?.error == null ? null : session.errorId;
	}

	/**
	 * A client dismissed the session's error, `errorId` naming the one it
	 * showed. A different one is newer -- another client's turn failed while
	 * the dismissal was on its way -- and stays (OW-bipume), and nothing
	 * changed, so nothing is said. Compared by id, not text, because the
	 * newer one can repeat the shown one word for word (OW-jokoto). A clear
	 * is announced, so the other clients showing the error drop it now, not at
	 * a snapshot that may be any number of turns away (OW-jopifu).
	 */
	clearError(ref: SessionRef, errorId: string): void {
		const session = this.#lookup(ref);
		if (session?.error == null || session.errorId !== errorId) return;
		session.error = null;
		this.broadcaster.errorCleared(session);
	}

	/**
	 * Kill an adapter that is still inside `start()`. Teardown and the startup's
	 * own failure path can both be holding it, and signalling a child twice risks
	 * a pid the OS has already recycled, so the first caller owns the disposal and
	 * the second awaits that same one. Rejections are swallowed for the reason
	 * `#close` gives below: the caller's session is gone either way.
	 */
	#terminate(pending: PendingStart): Promise<void> {
		const adapter = pending.adapter;
		if (!adapter) return Promise.resolve();
		pending.disposal ??= Promise.resolve(adapter.dispose()).catch(() => {});
		return pending.disposal;
	}

	/**
	 * Close: this and shutdown are the two things that let go of an agent.
	 * Letting go is not always killing -- a Codex fork shares the parent's
	 * app-server (OW-lajehi), so closing either of them releases a share and only
	 * the last one out kills the child.
	 *
	 * A client's close names a handle (D35 point 3), and closes only the live
	 * container under it. It never reaches a startup, which ends by publishing,
	 * failing, timing out or the server's shutdown, so a handle with no adapter
	 * published under it -- a create mid-start -- is refused as one that has
	 * ended is, and so is a second close of one handle (OW-loromi).
	 */
	async close(handle: string): Promise<void> {
		const session = this.#sessions.get(handle);
		if (!session?.adapter) throw new HandleEndedError(session?.ref ?? null, handle);
		await this.#close(session);
	}

	/**
	 * Let go of a live container: a client's close, and D12's idle reaper
	 * (`#active`) and cap (`#makeRoom`), each a visible close as Detach is (D25),
	 * with the disposal guard that keeps a re-attach from sharing a session file
	 * with the adapter being disposed.
	 */
	async #close(session: ManagedSession): Promise<void> {
		// Everything up to the first await below is one synchronous run, so an
		// attach cannot land between its steps and find the session half-closed.
		// The container leaves the table, and the disposal is registered under
		// its ref.
		this.#remove(session);
		// In the same run that took the container out of the table, so an adapter
		// still moving -- a `submit()` or `fork()` in flight -- cannot name it, or
		// fork a container out of it, behind us (`ManagedSession.subscriptions`).
		for (const off of session.subscriptions.splice(0)) off();
		this.broadcaster.forget(session.handle);
		// Said here, where the handle is let go of, and not after the disposal
		// below, which can run to the kill's grace: until then another client
		// held a live-looking view whose Send was refused `not_attached` (D26).
		this.broadcaster.ended(session);
		this.broadcaster.sessionsChanged();
		// Swallowed deliberately. By this point the session is out of the table
		// and unsubscribed, so it *is* closed as far as the caller is concerned;
		// refusing the close would tell the client to retry a close that has
		// already happened. What a throw here can still mean is a subprocess that
		// outlived its kill -- DESIGN's third open question, which needs a live
		// spawn to settle and has no honest answer from in here.
		const adapter = session.adapter;
		await this.#dispose(
			sessionKey(session.ref),
			Promise.resolve()
				.then(() => adapter?.dispose())
				.catch(() => {}),
		);
	}

	/**
	 * Hold attaches of `key` back until `disposal` settles (`#disposing`):
	 * registered before this function's first await, so a caller that takes
	 * the container out of the table in the same run leaves no gap.
	 */
	async #dispose(key: string, disposal: Promise<void>): Promise<void> {
		this.#disposing.set(key, disposal);
		try {
			await disposal;
		} finally {
			if (this.#disposing.get(key) === disposal) this.#disposing.delete(key);
		}
	}

	async disposeAll(): Promise<void> {
		// First, and before any await: the tables below are walked exactly once,
		// so anything that starts after this point is in neither of them.
		this.#shuttingDown = true;
		// A startup still short of creating its adapter finds `#shuttingDown`
		// rather than spawning into a server that is already leaving.
		const sessions = [...this.#sessions.values()];
		const starting = [...this.#startups];
		// What a close or a failed start's reaping is still letting go of, a
		// container it took out of the table, which the table here no longer
		// reaches.
		const closing = [...this.#disposing.values()];
		this.#sessions.clear();
		this.#names.clear();
		// In parallel and settled, not sequential and awaited: every session left
		// undisposed is a sandboxed agent still holding its workspace, so one
		// adapter that cannot die must not spare the rest.
		await Promise.allSettled([
			...sessions.map(async (session) => {
				// Before this function's first await, so every container is
				// unsubscribed in the run that cleared the table, and an adapter
				// still moving cannot name one or fork out of one
				// (`ManagedSession.subscriptions`).
				for (const off of session.subscriptions.splice(0)) off();
				session.idle?.();
				// No `ended`, unlike `close()`: `app.close()` closes every socket
				// before this runs, and a client reads the drop as every session
				// detached (D25 point 3, D26).
				this.broadcaster.forget(session.handle);
				await session.adapter?.dispose();
			}),
			// Adapters mid-`start()` are not in the table above: they own a child
			// and their `ManagedSession.adapter` is still undefined. Resolving
			// without reaping them is exactly how shutdown orphans an agent. Each
			// adapter is reached by one route alone: a startup leaves `#startups`
			// in the run that publishes its adapter to the table.
			...starting.map((pending) => this.#terminate(pending)),
			...closing,
		]);
	}

	/**
	 * The merged list: what is on disk (D9), plus virtual sessions that exist
	 * only here, with live status overlaid from the process table.
	 */
	async list(query?: ListSessionsQuery): Promise<SessionSummary[]> {
		const stored = await this.#index.list(query);
		const byKey = new Map<string, SessionSummary>();
		for (const summary of stored) {
			const key = sessionKey(summary.ref);
			// Only a container's current ref finds it (D35 point 1), so a row the
			// index lists is never one a held container has outgrown.
			const live = this.#lookup(summary.ref);
			if (live) live.onDisk = true;
			byKey.set(key, { ...summary, ...this.#liveOverlay(live), ...(live ? { handle: live.handle } : {}) });
		}
		for (const session of this.#sessions.values()) {
			const key = sessionKey(session.ref);
			if (byKey.has(key)) continue;
			if (query?.cwd && session.cwd !== query.cwd) continue;
			byKey.set(key, this.#ownSummary(session));
		}
		return [...byKey.values()].sort(
			(a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? "") || 0,
		);
	}

	/**
	 * One session's summary. Deliberately not `list().find()`: that walks both
	 * backends' whole session stores (973 files on this machine, D9) to answer a
	 * question about a session we are already holding open, on the path a session
	 * switch takes.
	 */
	summaryOf(ref: SessionRef): LiveSessionSummary | null {
		const session = this.#lookup(ref);
		return session ? this.#summary(session) : null;
	}

	/** What `summaryOf` answers for a container, read from the container itself. */
	#summary(session: ManagedSession): LiveSessionSummary {
		const stored = session.stored;
		return stored
			? { ...stored, ref: session.ref, ...this.#liveOverlay(session), handle: session.handle }
			: this.#ownSummary(session);
	}

	/** A session the index does not know about: everything we have is what we minted. */
	#ownSummary(session: ManagedSession): LiveSessionSummary {
		return {
			ref: session.ref,
			cwd: session.cwd,
			preview: null,
			createdAt: session.createdAt,
			updatedAt: session.createdAt,
			name: null,
			...this.#liveOverlay(session),
			onDisk: session.onDisk,
			handle: session.handle,
		};
	}

	/** What a held session says over the index's summary; an attached one's `name` is its adapter's (D27). */
	#liveOverlay(session: ManagedSession | undefined): { status: SessionStatus; isStreaming: boolean; name?: string | null } {
		if (session?.adapter) {
			const { isStreaming, name } = session.adapter.getState();
			return { status: "attached", isStreaming, name };
		}
		return { status: session?.virtual ? "virtual" : "detached", isStreaming: false };
	}
}
