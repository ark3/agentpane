/**
 * The process table: a handle the manager mints -> the container holding a
 * running adapter, with every backend id the conversation has had as a name
 * that resolves to it (D24, OW-suyinu).
 *
 * Two rules from DESIGN carry most of the weight here:
 *
 *  - **Spawn on attach, not on list** (D9). Listing 973 sessions costs a
 *    filesystem walk; a subprocess is only created when a session is actually
 *    opened or prompted.
 *  - **The subprocess outlives the connection.** Its lifetime is tied to the
 *    server, not to an `EventSource`. A browser refresh drops the stream and the
 *    agent keeps working; reconnect is a repaint. Only an explicit close (or
 *    server shutdown) disposes an adapter.
 */

import type {
	AgentNotice,
	AgentRequest,
	BackendId,
	ListSessionsQuery,
	SessionRef,
	SessionStatus,
	SessionSummary,
} from "../../shared/protocol.ts";
import { sessionKey } from "../../shared/protocol.ts";
import type {
	AdapterState,
	BackendAdapter,
	ImageInput,
	StartOptions,
	Unsubscribe,
} from "../adapters/types.ts";
import type { Broadcaster } from "./broadcaster.ts";
import type { AppDeps, SessionIndex } from "./deps.ts";

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
	 * (`#container`) and never changed, opaque, and unique for the server's
	 * lifetime (D24, OW-suyinu). It rides `SessionSummary` and every
	 * per-session event beside `ref`, and a rename leaves it where it is, so
	 * anything keyed by it -- here, in the broadcaster, or in a client -- has
	 * nothing to re-key. A fork is another conversation and another container,
	 * with a handle of its own (`#forkOnto`).
	 */
	readonly handle: string;
	/** The backend's id for this conversation now, which a rename moves (D9). */
	ref: SessionRef;
	/**
	 * Every `sessionKey` that has named this conversation: its minted
	 * `virtual:` id, each id a rename brought, and each spelling `#start`
	 * canonicalised onto it (OW-fumegi). While the container is in the table
	 * `#names` resolves each to `handle`, which is D9's promise that an old id
	 * keeps working on REST routes. A fork takes none of them.
	 */
	readonly names: Set<string>;
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
	 * The startup in flight for this container, from the moment the container
	 * exists until `#start` publishes the adapter or gives up. On the container
	 * rather than keyed by a name, so an attach or a `close()` under any name it
	 * has -- one a rename inside `start()` added a moment ago included -- finds
	 * the one startup.
	 */
	starting?: PendingStart;
	/** Last state we broadcast, so we can tell a status flip from a message change. */
	lastStreaming: boolean;
	lastCompaction: "requesting" | "running" | null;
	lastModel: string | null;
	lastEffort: string | null;
	lastUnrestoredModel: string | null;
	/**
	 * What the adapter's `onError`, `onRequest` and `onNotice` have said, held
	 * for every snapshot to carry (OW-bipume): a client that was not holding a
	 * view when the event went out -- one that connects or reconnects later, or
	 * one the startup window or a fork left without one -- has no other
	 * way to learn of it. Each follows the lifecycle the client applies to its
	 * own copy, or a snapshot would resurrect what the client had cleared:
	 * `error` is cleared where `clearSessionError` is (`submit`, `clearError`),
	 * a request leaves when it stops being pending (`clearRequest`, which
	 * retracts it on the wire), and notices only accumulate -- save that one
	 * identical to a notice already held is neither held nor fanned out again
	 * (OW-piloni). They live on the container, so a rename leaves them where they
	 * are and a close drops them; a fork's container takes all but `error`
	 * (`#forkOnto`).
	 */
	error: string | null;
	requests: AgentRequest[];
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
	promise: Promise<ManagedSession>;
	/** Assigned the instant the adapter exists, with no `await` in between. */
	adapter?: BackendAdapter;
	/** Set by `close()`/`disposeAll()`. A startup that outlives it must not register. */
	torndown: boolean;
	/** The single termination both teardown and the startup's failure path await. */
	disposal?: Promise<void>;
}

/**
 * A fork that exists but is not attached yet. `start` is the `StartOptions`
 * that open it; `adapter` is the fork's own adapter when only the parent could
 * build one -- see `#pendingForks`.
 */
interface PendingFork {
	start: StartOptions;
	adapter?: BackendAdapter;
}

interface PendingDisposal {
	promise: Promise<void>;
	/** Canonical identity all refs covered by this disposal must resume under. */
	ref: SessionRef;
}

export class SessionManager {
	/** Handle -> the container it names (D24). No map holding a container is keyed by a name. */
	readonly #sessions = new Map<string, ManagedSession>();
	/**
	 * Name -> handle, for every name of every container in the table
	 * (`ManagedSession.names`). A session takes its backend's own id once the
	 * backend names it (`#rename`), but the browser that created it is still
	 * holding the old one and may already have a prompt in flight against it.
	 * Honouring the old id costs one map entry and is the difference between "the
	 * second message in a new conversation works" and a 404. A container leaves
	 * this map with every one of its names, on a close and on a fork alike.
	 */
	readonly #names = new Map<string, string>();
	/**
	 * requestId -> the handle of the container whose agent is blocked on it
	 * (D2a). A fork retargets the parent's entries onto the fork's container,
	 * since the process that is blocked moved with the adapter (`#forkOnto`).
	 */
	readonly #pendingRequests = new Map<string, string>();
	/**
	 * Fork ref -> what it takes to open that fork, for a fork the session index
	 * cannot answer for or cannot be opened from. Two backends need it, for
	 * different reasons:
	 *
	 *  - Claude Code's fork writes no store file until its first turn ends
	 *    (OW-japuzo), so `#start`'s index lookup would throw
	 *    `UnknownSessionError` at the attach that follows every fork. Its entry
	 *    is `start` alone: three strings, replayable.
	 *  - Codex's fork IS on disk, but only the app-server that minted it may
	 *    open it (`codex-cli` 0.154.0, OW-lajehi). Its entry also carries
	 *    `adapter` -- the fork's own, built by the parent's adapter and already
	 *    holding a share of the parent's child. A Codex fork that keeps no turn
	 *    is minted by nothing until its attach, and its entry is `start` alone,
	 *    as Claude Code's is (OW-hojefo).
	 *
	 * That second shape changes what an abandoned entry costs, and D17's answer
	 * with it. An abandoned recipe is three strings; an abandoned live handle is
	 * a share of a running app-server, taken at fork time so that a `close()` on
	 * the parent cannot kill the child out from under the attach. So `close()`
	 * and `disposeAll()` do not merely drop these entries, they dispose the
	 * adapter in them, which is what releases the share. What is left is a fork
	 * that is never attached AND never closed while the server keeps running: it
	 * pins one app-server until shutdown. That is deliberate, and it is the price
	 * of the attach being reliable; D17 declines to spend anything on the
	 * abandoned fork (OW-puduro) and this is the smallest thing that can be spent.
	 *
	 * An entry ends four ways: the attach that opens the fork consumes it,
	 * `close()` on that ref discards it, `disposeAll()` drops the lot, and a
	 * failed attach on a *handle* discards it. That last one is the difference
	 * between the two shapes: a failed attach on a recipe KEEPS it deliberately,
	 * because `#start`'s failure path unregisters the container too and the
	 * recipe is the whole of what a retry has left to work from -- but a handle
	 * is single-use, its adapter has been disposed by the reaping, and leaving it
	 * parked would hand a retry a dead adapter and a released share.
	 *
	 * Keyed by the fork's backend key, and holding no container: a parked fork
	 * gets its container, and with it the handle the manager mints (D24), at
	 * the attach that opens it. Nothing is emitted for it before then.
	 */
	readonly #pendingForks = new Map<string, PendingFork>();
	readonly #index: SessionIndex;
	readonly #adapters: Partial<Record<BackendId, { create(ref: SessionRef): BackendAdapter }>>;
	readonly #newId: () => string;
	readonly #now: () => string;
	/** The last handle minted; see `#container`. */
	#minted = 0;
	/**
	 * Every startup in flight, under the key its attach asked for, from that
	 * attach until it settles: what `disposeAll()` walks to reach an adapter
	 * that is still starting, and what collapses two attaches on one spelling
	 * -- or finds the startup for a `close()` on it -- while no container
	 * exists yet, which for a stored session is the index lookup. Once a
	 * container exists the startup is on it as well (`ManagedSession.starting`),
	 * and that is how an attach or close under any of its names finds it.
	 */
	readonly #attaching = new Map<string, PendingStart>();
	/**
	 * Guards against replacing an adapter before its predecessor has finished
	 * disposing. Keyed by every name the closed container had, so a stale client
	 * id cannot bypass the guard; by name and not by handle, since what it holds
	 * back is an attach, which arrives with a name after the container and its
	 * handle are gone.
	 */
	readonly #disposing = new Map<string, PendingDisposal>();
	/**
	 * Set by `disposeAll()`. The HTTP server is still serving for the whole of
	 * shutdown -- `src/server/index.ts` stops the socket *after* closing the app,
	 * and killing one Codex child can take the full SIGTERM+SIGKILL grace -- so
	 * without this an attach arriving mid-shutdown spawns an agent into a server
	 * that has already walked its tables and is about to exit.
	 */
	#shuttingDown = false;

	constructor(
		deps: Pick<AppDeps, "index" | "adapters" | "newId" | "now">,
		private readonly broadcaster: Broadcaster,
	) {
		this.#index = deps.index;
		this.#adapters = deps.adapters;
		this.#newId = deps.newId ?? (() => crypto.randomUUID());
		this.#now = deps.now ?? (() => new Date().toISOString());
		broadcaster.setSnapshotSource((handle) => {
			const session = this.#sessions.get(handle);
			if (!session?.adapter) return null;
			// Every write below replaces these arrays rather than mutating them, so
			// they are handed over as they are.
			return {
				ref: session.ref,
				...session.adapter.getState(),
				error: session.error,
				requests: session.requests,
				notices: session.notices,
			};
		});
	}

	/** Resolve a ref by any name its container has had. */
	#lookup(ref: SessionRef): ManagedSession | undefined {
		const handle = this.#names.get(sessionKey(ref));
		return handle === undefined ? undefined : this.#sessions.get(handle);
	}

	/**
	 * A new container, with a freshly minted handle and `ref` as its one name.
	 * The handle comes from a counter of the manager's own: `deps.newId` mints
	 * `virtual:` ids, and a test may pin it to one constant.
	 */
	#container(
		ref: SessionRef,
		init: Pick<ManagedSession, "cwd" | "virtual" | "fromStore" | "onDisk" | "createdAt"> &
			Partial<Pick<ManagedSession, "model" | "stored">>,
	): ManagedSession {
		return {
			handle: `h${++this.#minted}`,
			ref,
			names: new Set([sessionKey(ref)]),
			...init,
			subscriptions: [],
			lastStreaming: false,
			lastCompaction: null,
			lastModel: null,
			lastEffort: null,
			lastUnrestoredModel: null,
			error: null,
			requests: [],
			notices: [],
			queue: Promise.resolve(),
		};
	}

	/** Put a container in the table under its handle, reachable by every name it has. */
	#add(session: ManagedSession): void {
		this.#sessions.set(session.handle, session);
		for (const name of session.names) this.#names.set(name, session.handle);
	}

	/**
	 * Take a container out of the table with every name that still resolves to
	 * it, and answer those names. The container keeps its own `names`.
	 */
	#remove(session: ManagedSession): string[] {
		if (this.#sessions.get(session.handle) === session) this.#sessions.delete(session.handle);
		const removed: string[] = [];
		for (const name of session.names) {
			if (this.#names.get(name) !== session.handle) continue;
			this.#names.delete(name);
			removed.push(name);
		}
		return removed;
	}

	/** One more name for a container, resolving to it while it is in the table. */
	#addName(session: ManagedSession, name: string): void {
		session.names.add(name);
		if (this.#sessions.get(session.handle) === session) this.#names.set(name, session.handle);
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

	adapterFor(ref: SessionRef): BackendAdapter | undefined {
		return this.#lookup(ref)?.adapter;
	}

	isAttached(ref: SessionRef): boolean {
		return this.adapterFor(ref) !== undefined;
	}

	/**
	 * D9: a `virtual` session is a workspace choice and nothing more. Nothing
	 * touches the backend's store until its first turn, whatever id attach
	 * gives it, so browsing never litters it with empty sessions.
	 */
	createVirtual(cwd: string, backend: BackendId, model?: string): SessionRef {
		if (!this.#adapters[backend]) throw new UnknownBackendError(backend);
		const ref: SessionRef = { backend, id: `virtual:${this.#newId()}` };
		this.#add(this.#container(ref, { cwd, model, virtual: true, fromStore: false, onDisk: false, createdAt: this.#now() }));
		this.broadcaster.sessionsChanged();
		return ref;
	}

	/**
	 * Ensure a subprocess is running for this session, then broadcast a snapshot.
	 * Idempotent: attaching an already-attached session re-snapshots (which is
	 * exactly what a session switch wants) without touching the subprocess.
	 */
	async attach(ref: SessionRef): Promise<BackendAdapter> {
		if (this.#shuttingDown) throw new ServerShuttingDownError();
		const disposing = this.#disposing.get(sessionKey(ref));
		let effectiveRef = ref;
		if (disposing) {
			await disposing.promise;
			if (this.#shuttingDown) throw new ServerShuttingDownError();
			effectiveRef = disposing.ref;
		}
		const existing = this.#lookup(effectiveRef);
		if (existing?.adapter) {
			this.broadcaster.broadcastSnapshot(existing.handle);
			return existing.adapter;
		}

		// Two concurrent attaches collapse into one startup: the container's,
		// whichever of its names each caller said, and while a stored session has
		// no container yet, the one under the spelling asked for.
		const key = sessionKey(effectiveRef);
		const inFlight = existing ? existing.starting : this.#attaching.get(key);
		if (inFlight) return (await inFlight.promise).adapter as BackendAdapter;

		const pending: PendingStart = {
			torndown: false,
			// Deferred by one microtask so this record is registered below -- and
			// so reachable by close()/disposeAll() -- before `#start` can spawn
			// anything. A startup teardown cannot see is a startup it cannot stop.
			promise: Promise.resolve().then(() => this.#start(effectiveRef, existing, pending)),
		};
		this.#attaching.set(key, pending);
		if (existing) existing.starting = pending;
		try {
			const session = await pending.promise;
			this.broadcaster.sessionsChanged();
			this.broadcaster.broadcastSnapshot(session.handle);
			return session.adapter as BackendAdapter;
		} finally {
			if (this.#attaching.get(key) === pending) this.#attaching.delete(key);
		}
	}

	/**
	 * Run one of a session's mutating verbs once every verb queued on it before
	 * has settled (D24, OW-sewewe). Six verbs join: `submit`, `fork`,
	 * `setModel`, `setEffort`, `compact` and `reply`. Every route is a concurrent
	 * `Bun.serve` handler and any number of clients can drive one session, so
	 * without this two of them overlap on one adapter -- two `setModel`s sharing
	 * Pi's one `settingModel` flag (OW-woyifu), or an effort checked against the
	 * model a set-model in flight is replacing (OW-zayefe).
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
	 * `reply` joins safely only while no queued verb waits on a request being
	 * answered, which holds because every adapter disposes of a request as it
	 * arrives (OW-yosuzo for Pi); a reply a human gives (OW-bijera) would sit
	 * behind the very verb waiting for it.
	 *
	 * Left out, each for its own reason:
	 *
	 *  - `abort`. It exists to reach a running turn, which is never an item here,
	 *    so all it could wait behind is a settings call, a compaction or a fork,
	 *    and a stop must not wait out a Pi compaction. Left out, it also stays
	 *    what it was for the second abort `forkAndSubmit` sends ahead of a Pi
	 *    fork (OW-relehi): harmless, since the fork abandons the turn (D15).
	 *  - `listForkPoints`. A read: it changes nothing a verb here depends on,
	 *    and its answer can be stale by the time a client acts on it whether or
	 *    not it waits.
	 *  - `attach`. It creates the adapter this queues on, and `#attaching`
	 *    already collapses concurrent attaches; each route attaches, then queues.
	 *  - `close` and `disposeAll`. Teardown is ordered by `#disposing`,
	 *    `PendingStart.torndown` and `#terminate`, and waits behind nothing. A
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
	 */
	async #serially<T>(ref: SessionRef, verb: (session: ManagedSession, adapter: BackendAdapter) => Promise<T>): Promise<T> {
		const session = this.#lookup(ref);
		if (!session?.adapter) throw new UnknownSessionError(ref);
		const run = session.queue.then(() => {
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
	 * clears the session's error and its `virtual` flag. An id the backend
	 * names for it arrives through `onRefChanged`, like every other (`#rename`).
	 */
	submit(ref: SessionRef, text: string, images?: ImageInput[], priorError = this.errorOf(ref)): Promise<void> {
		return this.#serially(ref, async (session, adapter) => {
			this.markPrompted(session.ref);
			// The client clears a session's error once the next prompt is admitted,
			// unless a newer one landed meanwhile (OW-31, `submit` in
			// `controller.ts`); this is the same rule, so the next snapshot agrees.
			// `priorError` is what stood when the prompt was sent, so a caller that
			// attaches first reads it before that attach: an error the start raised
			// is newer than the prompt, and nobody had seen it to clear.
			await adapter.submit(text, images);
			if (session.error === priorError) session.error = null;
		});
	}

	/**
	 * Fork a session from a past entry. Like `submit`, this goes through the
	 * manager rather than straight at the adapter because it queues
	 * (`#serially`), and because two of the backends hand back something the
	 * attach that follows needs (`#pendingForks`). The backends are asymmetric:
	 *
	 *  - Pi's `fork` is copy-on-write: the process's active `sessionFile` MOVES to
	 *    a new file, so the adapter announces a `"fork"` through `onRefChanged`
	 *    and `#forkOnto` moves the adapter onto a container of its own, before
	 *    the adapter re-sends the model and level and hydrates the fork's
	 *    transcript -- so what it emits from there goes out under the fork's
	 *    ref and handle, never the parent's (OW-zovaye, OW-nuzepi). It emits no
	 *    `renamed` -- see `#forkOnto`. The value the adapter returns IS its new
	 *    ref.
	 *  - Codex's `thread/fork` mints a new thread the current adapter is NOT
	 *    driving; its own `ref` is unchanged and it announces nothing. The returned
	 *    ref points at the freshly-flushed forked thread, which differs from
	 *    `adapter.ref` -- so we hand back what `adapter.fork` gave us, not
	 *    `session.ref`. Only the app-server that minted that thread may open it
	 *    (OW-lajehi), so `fork()` also hands over the fork's own adapter, already
	 *    sharing the parent's connection; `#pendingForks` holds it, with the
	 *    resume that starts it, until the attach. A fork at the first user
	 *    message is the exception: no `thread/fork` keeps nothing, so it takes
	 *    Claude Code's path below, and the attach renames its placeholder ref
	 *    to the thread its `thread/start` names, as a virtual session's is
	 *    (OW-hojefo).
	 *  - Claude Code's `fork` takes Codex's path -- its own ref is unchanged and
	 *    the parent keeps its child and its turn (OW-razoki) -- but nothing has
	 *    recorded the fork yet, so it also hands back the `StartOptions` its own
	 *    adapter must be started with. `#pendingForks` holds those until the
	 *    attach that follows.
	 *
	 * Where the ref DOES change, which is Pi alone, the live adapter is driving
	 * the FORK from there on and the parent is left detached -- still on disk,
	 * still listed, still attachable, but reachable by none of the names it
	 * had. That is why the adapter says `"fork"`: unlike a rename, the parent's
	 * id must not become a name for the fork (`#forkOnto`, OW-kekoji).
	 */
	fork(ref: SessionRef, entryId: string): Promise<SessionRef> {
		return this.#serially(ref, async (_session, adapter) => {
			const forked = await adapter.fork(entryId);
			if (forked.start) {
				this.#pendingForks.set(sessionKey(forked.ref), {
					start: forked.start,
					...(forked.adapter ? { adapter: forked.adapter } : {}),
				});
			}
			return forked.ref;
		});
	}

	setModel(ref: SessionRef, model: string): Promise<void> {
		return this.#serially(ref, (_session, adapter) => adapter.setModel(model));
	}

	/**
	 * Checked here, not trusted to the backend: as of `claude 2.1.280` and
	 * `pi 0.87.1` each answered success for a level the model lacks, and Codex
	 * stores any string for the next turn (OW-tewofe). The model is matched by
	 * id, as both clients match it to offer efforts, so a model that is null or
	 * not listed offers none. Inside the queue, so the model checked against is
	 * the one a set-model queued ahead of this left (OW-zayefe).
	 */
	setEffort(ref: SessionRef, effort: string): Promise<void> {
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
		});
	}

	compact(ref: SessionRef): Promise<void> {
		return this.#serially(ref, (_session, adapter) => adapter.compact());
	}

	/** Answer a request the session's agent raised (D2a), then stop holding it. */
	reply(ref: SessionRef, requestId: string, response: unknown): Promise<void> {
		return this.#serially(ref, async (_session, adapter) => {
			await adapter.reply(requestId, response);
			this.clearRequest(requestId);
		});
	}

	/**
	 * A rename: one conversation took a new id, announced by its adapter through
	 * `onRefChanged` as it moves and before it emits anything under the new id
	 * (D24). Every backend replaces a `virtual` session's minted id at attach,
	 * Pi can move it again on the first prompt, because Pi's session id IS its
	 * JSONL path (D9), and Claude Code whenever a turn's `init` names another.
	 * The new id is one more name on the container and the old ones stay, so a
	 * client still holding one reaches the same conversation; nothing is
	 * re-keyed, since the handle the table is keyed by does not move
	 * (OW-suyinu).
	 *
	 * `announce` is false for a rename inside `start()`: the name is written at
	 * once, so a `close()` or an attach under it finds the one startup, but the
	 * `renamed` goes out when `#start` publishes the adapter, so that a start
	 * that fails after renaming leaves none on the wire. That hold is on the
	 * wire alone, and leaves with `renamed` (OW-mofuho).
	 */
	#rename(session: ManagedSession, next: SessionRef, announce: boolean): void {
		if (sessionKey(next) === sessionKey(session.ref)) return;
		const from = session.ref;
		session.ref = next;
		this.#addName(session, sessionKey(next));
		if (!announce) return;
		this.broadcaster.sessionsChanged();
		this.broadcaster.renamed(from, session);
	}

	/**
	 * A fork that moved the live adapter: on Pi the one process is driving a
	 * SECOND conversation now (D15), and the first is still on disk, still
	 * listable and still resumable. So the fork gets a container of its own, with
	 * a new handle and the fork's id as its only name, and answers as the
	 * container the adapter's handlers reach from here on (`#start`'s `owner`).
	 *
	 * It takes what belongs to the process: the adapter, the subscriptions that
	 * reach it, the pending requests it is blocked on (`#pendingRequests`
	 * agrees), the notices it raised, and the `last*` mirrors the next update is
	 * measured against, and the queue, which orders the adapter and on which the
	 * fork verb that fired this is still running. It takes nothing that was
	 * about the parent's conversation, and starts with no `error` and the
	 * `stored`, `onDisk` and `createdAt` below.
	 *
	 * The parent's container leaves the table with every one of its names, as
	 * any detached session's does, and keeps no adapter: a route on any of its
	 * names misses from here on, a verb queued on it behind this fork fails
	 * rather than running on the fork (`#serially`), and the next attach
	 * resumes the parent from the index into a container of its own (D9, D12).
	 * None of its names becomes the fork's, or every client holding the
	 * parent's ref would hold one that prompts -- or, through `close()`, kills
	 * -- the agent the user is talking to on the fork (OW-kekoji).
	 *
	 * No `renamed`: that event means "this conversation took a new id", and
	 * every browser that hears it discards what it holds under the old one and
	 * follows its selection across. On a fork that is false for every browser,
	 * and actively wrong for the ones that did not fork -- it would throw away a
	 * parent transcript the server still lists and drag a reader onto a
	 * conversation nobody there opened (OW-suhoto). `sessionsChanged` alone; the
	 * browser that forked has the fork's ref from the response and attaches it,
	 * which is what snapshots it.
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
		fork.requests = parent.requests;
		fork.notices = parent.notices;
		fork.lastStreaming = parent.lastStreaming;
		fork.lastCompaction = parent.lastCompaction;
		fork.lastModel = parent.lastModel;
		fork.lastEffort = parent.lastEffort;
		fork.lastUnrestoredModel = parent.lastUnrestoredModel;
		this.#remove(parent);
		parent.adapter = undefined;
		this.#add(fork);
		for (const [requestId, owner] of this.#pendingRequests) {
			if (owner === parent.handle) this.#pendingRequests.set(requestId, fork.handle);
		}
		this.broadcaster.forget(parent.handle);
		this.broadcaster.sessionsChanged();
		return fork;
	}

	async #start(
		ref: SessionRef,
		existing: ManagedSession | undefined,
		pending: PendingStart,
	): Promise<ManagedSession> {
		if (!this.#adapters[ref.backend]) throw new UnknownBackendError(ref.backend);
		let session = existing;
		const forkStart = this.#pendingForks.get(sessionKey(ref));
		if (!session && forkStart) {
			// A fork this manager minted a moment ago. Its workspace and the
			// arguments that open it came back from `fork()`, because the index
			// either cannot answer for it or cannot be acted on -- see
			// `#pendingForks`. Its container, and its handle, begin here.
			session = this.#container(ref, {
				cwd: forkStart.start.cwd,
				virtual: false,
				fromStore: false,
				onDisk: false,
				createdAt: this.#now(),
			});
		}
		if (!session) {
			// Not one of ours yet -- it must exist in the backend's store, and we
			// need its workspace before we can spawn anything (D7).
			let lookupRef = ref;
			let summary: SessionSummary;
			for (;;) {
				const found = await this.#index.get(lookupRef);
				if (!found) throw new UnknownSessionError(lookupRef);
				summary = found;
				if (this.#shuttingDown) throw new ServerShuttingDownError();
				if (pending.torndown) throw new UnknownSessionError(ref);

				// A lookup can canonicalize an unseen spelling onto a session already
				// closing. Wait for that owner, then look up its authoritative ref and
				// repeat: the lookup itself is asynchronous, so another disposal may
				// have begun (or it may return a different canonical identity) before
				// it completes. Only a disposal-free result may reach arbitration.
				const canonicalDisposal = this.#disposing.get(sessionKey(summary.ref));
				if (!canonicalDisposal) break;
				await canonicalDisposal.promise;
				if (this.#shuttingDown) throw new ServerShuttingDownError();
				if (pending.torndown) throw new UnknownSessionError(ref);
				lookupRef = canonicalDisposal.ref;
			}
			if (!summary.cwd) {
				throw new Error(
					`session ${sessionKey(ref)} has no recorded workspace; cannot spawn a sandboxed agent for it`,
				);
			}
			// The lookup above can reveal that a spelling the manager has never seen
			// names a container another request already holds or is starting.
			// Arbitrate on that container before building one: a second would put
			// two adapters on one file. Whichever attach wins, the spelling asked
			// for becomes one more name on it (OW-fumegi).
			const requestedKey = sessionKey(ref);
			const canonicalSession = this.#lookup(summary.ref);
			if (canonicalSession?.adapter) {
				this.#addName(canonicalSession, requestedKey);
				return canonicalSession;
			}
			if (canonicalSession?.starting && canonicalSession.starting !== pending) {
				const winner = await canonicalSession.starting.promise;
				if (pending.torndown) throw new UnknownSessionError(ref);
				this.#addName(winner, requestedKey);
				return winner;
			}
			session = this.#container(summary.ref, {
				cwd: summary.cwd,
				virtual: false,
				fromStore: true,
				onDisk: true,
				createdAt: summary.createdAt ?? this.#now(),
				stored: summary,
			});
			session.names.add(requestedKey);
		}
		const factory = this.#adapters[session.ref.backend];
		if (!factory) throw new UnknownBackendError(session.ref.backend);

		// Asking the index where this session lives is the one await before an
		// adapter exists, so a teardown can land with nothing yet to dispose.
		// Everything from here to `pending.adapter` below is synchronous: either
		// teardown sees the adapter, or this sees the flag and never spawns.
		if (pending.torndown) throw new UnknownSessionError(ref);
		if (!existing) {
			// No await separates the arbitration above from this claim, so no
			// competing startup can have claimed any of these names since.
			session.starting = pending;
			this.#add(session);
		}

		const bound = session;
		// What a failed start restores: a container that outlives it -- a
		// `virtual` one -- must not keep an id its adapter announced and never
		// stored, or a retry would resume it.
		const refBeforeStart = bound.ref;
		const namesBeforeStart = new Set(bound.names);
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
			adapter = forkStart?.adapter ?? factory.create(bound.ref);
			pending.adapter = adapter;
			// Subscribe *before* start(): a backend can emit its first state during
			// startup and we would otherwise miss it.
			bound.subscriptions.push(
				adapter.onUpdate((state, changedIndex) => this.#onUpdate(owner, state, changedIndex)),
				adapter.onRefChanged((next, cause) => {
					if (cause === "fork") owner = this.#forkOnto(owner, next);
					else this.#rename(owner, next, owner.adapter === adapter);
				}),
				// Held on the container as well as fanned out, and from before
				// `start()` resolves: an event raised in that window goes out before
				// any client holds a view of the session, and the attach's snapshot
				// that follows is what delivers it (OW-bipume).
				adapter.onRequest((request) => {
					this.#pendingRequests.set(request.requestId, owner.handle);
					owner.requests = [...owner.requests, request];
					this.broadcaster.request(owner, request);
				}),
				adapter.onError((message) => {
					owner.error = message;
					this.broadcaster.error(owner, message);
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
			const offResolved = adapter.onRequestResolved?.((requestId) => this.clearRequest(requestId));
			if (offResolved) bound.subscriptions.push(offResolved);
			await adapter.start(
				forkStart?.start ?? {
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
			// Teardown ran while we were starting. Publishing the adapter now
			// would hand a live agent to a container shutdown or `close()` has
			// already taken out of the table. Fall through to the same reaping the
			// failure path uses.
			if (pending.torndown) throw new UnknownSessionError(ref);
		} catch (err) {
			for (const off of bound.subscriptions.splice(0)) off();
			if (existing) {
				for (const name of [...bound.names]) {
					if (namesBeforeStart.has(name)) continue;
					bound.names.delete(name);
					if (this.#names.get(name) === bound.handle) this.#names.delete(name);
				}
				bound.ref = refBeforeStart;
			} else {
				this.#remove(bound);
			}
			if (bound.starting === pending) bound.starting = undefined;
			// A handle is single-use: `#terminate` below disposes its adapter, which
			// releases the share it was holding, so the parked entry is no longer
			// anything a retry could start. A recipe stays parked -- see
			// `#pendingForks`.
			if (forkStart?.adapter) this.#pendingForks.delete(sessionKey(ref));
			// The adapter spawns before it decides it has started -- PiAdapter
			// spawns, then round-trips a readiness probe -- so a rejection can
			// leave a live sandboxed agent behind. Nothing else will ever reap it.
			await this.#terminate(pending);
			throw err;
		}

		// Publish the adapter and retire the startup in one synchronous run: from
		// here a `close()` under any of the container's names finds the adapter
		// on it and disposes it, where until now it found the startup.
		bound.adapter = adapter;
		bound.starting = undefined;
		// Consumed: the fork has its own child and its own container, so nothing
		// reaches it through the recipe again -- and must not, or a `close()`
		// followed by an attach on a spelling a rename left behind would fork
		// the PARENT a second time. Deliberately after `start()` resolved: the
		// failure path above leaves the entry parked for a retry.
		this.#pendingForks.delete(sessionKey(ref));
		const initialState = adapter.getState();
		bound.lastStreaming = initialState.isStreaming;
		bound.lastCompaction = initialState.compaction;
		bound.lastModel = initialState.model;
		bound.lastEffort = initialState.effort;
		bound.lastUnrestoredModel = initialState.unrestoredModel ?? null;
		// The `renamed` a rename inside `start()` -- a `virtual` id becoming the
		// backend's own (D9) -- held back until the start could no longer fail;
		// see `#rename`.
		if (sessionKey(bound.ref) !== sessionKey(refBeforeStart)) {
			this.broadcaster.sessionsChanged();
			this.broadcaster.renamed(refBeforeStart, bound);
		}
		return bound;
	}

	/**
	 * D3's tail upsert. `changedIndex` is what makes it O(1) per token; without
	 * it we cannot know what moved and fall back to a full snapshot, which is
	 * correct but quadratic over a long turn.
	 */
	#onUpdate(session: ManagedSession, state: AdapterState, changedIndex?: number): void {
		const streamingChanged = state.isStreaming !== session.lastStreaming;
		const compactionChanged = state.compaction !== session.lastCompaction;
		// The effort rides with the model: a model change can move it (OW-kokalo).
		// So does a recorded model the resume could not restore (OW-jitoni).
		const unrestoredModel = state.unrestoredModel ?? null;
		const settingsChanged =
			state.model !== session.lastModel || state.effort !== session.lastEffort || unrestoredModel !== session.lastUnrestoredModel;
		session.lastStreaming = state.isStreaming;
		session.lastCompaction = state.compaction;
		session.lastModel = state.model;
		session.lastEffort = state.effort;
		session.lastUnrestoredModel = unrestoredModel;

		const hasChangedMessage = changedIndex !== undefined && changedIndex >= 0 && changedIndex < state.messages.length;
		if (settingsChanged && !streamingChanged && !compactionChanged && changedIndex === undefined) {
			this.broadcaster.status(session, state.isStreaming, state.compaction, state.model, state.effort, unrestoredModel);
		} else if (hasChangedMessage && compactionChanged) {
			// Compaction completion changes the transcript marker and operation state
			// together. Keep that reducer-level atomicity on the wire rather than let
			// an upsert expose the marker while the client still holds `running`.
			this.broadcaster.broadcastSnapshot(session.handle);
		} else if (hasChangedMessage) {
			const message = state.messages[changedIndex];
			if (message) this.broadcaster.upsert(session, changedIndex, message);
			if (streamingChanged || settingsChanged) this.broadcaster.status(session, state.isStreaming, state.compaction, state.model, state.effort, unrestoredModel);
		} else {
			// A snapshot carries isStreaming and compaction, so no separate status event.
			this.broadcaster.broadcastSnapshot(session.handle);
		}

		// The session list sorts on `updatedAt`, which only a re-list carries, so
		// without this the order never moves until someone presses Refresh
		// (OW-furinu). Turn boundaries are the affordable place to say so: two
		// events per turn, not one per token, which is what keeps the client's
		// sort off the streaming path (OW-jineli). The backend writes its own
		// file, so the start-side re-list may still read a timestamp from before
		// the turn; the end-side one always sees the turn's last write.
		if (streamingChanged) this.broadcaster.sessionsChanged();
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

	sessionOfRequest(requestId: string): SessionRef | undefined {
		const handle = this.#pendingRequests.get(requestId);
		if (!handle) return undefined;
		return this.#sessions.get(handle)?.ref;
	}

	/** The session's held turn error, or null -- including for a session not in the table. */
	errorOf(ref: SessionRef): string | null {
		return this.#lookup(ref)?.error ?? null;
	}

	/**
	 * The request stopped being pending: answered through the reply route, or
	 * reported resolved by the adapter. Dropped from what snapshots carry and
	 * retracted on the wire (OW-gusifo).
	 */
	clearRequest(requestId: string): void {
		const owner = this.#pendingRequests.get(requestId);
		this.#pendingRequests.delete(requestId);
		const session = owner === undefined ? undefined : this.#sessions.get(owner);
		if (!session) return;
		session.requests = session.requests.filter((request) => request.requestId !== requestId);
		this.broadcaster.requestResolved(session, requestId);
	}

	/**
	 * A client dismissed the session's error, `message` being the one it showed.
	 * A different one is newer -- another client's turn failed while the
	 * dismissal was on its way -- and stays. Only the next snapshot says so: the
	 * other clients showing it keep it until then (OW-bipume).
	 */
	clearError(ref: SessionRef, message: string): void {
		const session = this.#lookup(ref);
		if (session?.error === message) session.error = null;
	}

	/**
	 * Kill an adapter that is still inside `start()`. Teardown and the startup's
	 * own failure path can both be holding it, and signalling a child twice risks
	 * a pid the OS has already recycled, so the first caller owns the disposal and
	 * the second awaits that same one. Rejections are swallowed for the reason
	 * `close()` gives below: the caller's session is gone either way.
	 */
	#terminate(pending: PendingStart): Promise<void> {
		const adapter = pending.adapter;
		if (!adapter) return Promise.resolve();
		pending.disposal ??= Promise.resolve(adapter.dispose()).catch(() => {});
		return pending.disposal;
	}

	/**
	 * Explicit close: this and shutdown are the two things that let go of an
	 * agent. Letting go is not always killing -- a Codex fork shares the parent's
	 * app-server (OW-lajehi), so closing either of them releases a share and only
	 * the last one out kills the child.
	 *
	 * D12's reaper (OW-33) inherits this path, including the disposal guard that
	 * prevents a transparent re-attach from sharing a session file with the
	 * adapter being evicted.
	 */
	async close(ref: SessionRef): Promise<void> {
		const session = this.#lookup(ref);
		// Before the `!session` return below, which is exactly a fork that is
		// parked and was never attached: leaving it would let a later attach spawn
		// a child for a session this call deleted. The same line `#names` and
		// `#pendingRequests` get further down, for the same reason. Disposing its
		// adapter is what releases the share a live handle holds -- without it,
		// closing both the parent and an abandoned fork still leaves the
		// app-server running with nobody to speak for it.
		const parkedFork = this.#pendingForks.get(sessionKey(ref));
		this.#pendingForks.delete(sessionKey(ref));
		if (parkedFork?.adapter) {
			await Promise.resolve(parkedFork.adapter.dispose()).catch(() => {});
		}
		// Flag the startup before anything else: an adapter that does not exist
		// yet cannot be disposed, and this is what stops it being born at all.
		// The container's, reached by any name it has; with none, the one a
		// stored session's attach is holding under this spelling.
		const pending = session ? session.starting : this.#attaching.get(sessionKey(ref));
		if (pending) pending.torndown = true;
		if (!session) {
			// Nothing in the table, but a startup for this ref may be on its way to
			// spawning one -- the stored-session path is mid-index-lookup here.
			if (pending) await this.#terminate(pending);
			return;
		}
		const disposalKeys = this.#remove(session);
		for (const [requestId, owner] of [...this.#pendingRequests]) {
			if (owner === session.handle) this.#pendingRequests.delete(requestId);
		}
		// Before the first await below, and in the same run that took the
		// container out of the table, so an adapter still moving -- a `submit()`
		// or `fork()` in flight -- cannot name it, or fork a container out of it,
		// behind us (`ManagedSession.subscriptions`).
		for (const off of session.subscriptions.splice(0)) off();
		this.broadcaster.forget(session.handle);
		// Swallowed deliberately. By this point the session is out of the table
		// and unsubscribed, so it *is* closed as far as the caller is concerned;
		// failing the DELETE would tell the browser to retry a close that has
		// already happened. What a throw here can still mean is a subprocess that
		// outlived its kill -- DESIGN's third open question, which needs a live
		// spawn to settle and has no honest answer from in here.
		const disposal: PendingDisposal = {
			ref: session.ref,
			promise: Promise.resolve().then(async () => {
				if (pending) await this.#terminate(pending);
				else await Promise.resolve(session.adapter?.dispose()).catch(() => {});
			}),
		};
		for (const disposalKey of disposalKeys) this.#disposing.set(disposalKey, disposal);
		try {
			await disposal.promise;
		} finally {
			for (const disposalKey of disposalKeys) {
				if (this.#disposing.get(disposalKey) === disposal) this.#disposing.delete(disposalKey);
			}
		}
		this.broadcaster.sessionsChanged();
	}

	async disposeAll(): Promise<void> {
		// First, and before any await: the tables below are walked exactly once,
		// so anything that starts after this point is in neither of them.
		this.#shuttingDown = true;
		const sessions = [...this.#sessions.values()];
		const starting = [...this.#attaching.values()];
		// Forks nobody attached. Dropping a recipe on the floor costs nothing;
		// dropping a live handle leaks the app-server share it holds (OW-lajehi),
		// so they are disposed alongside everything else below.
		const parkedForks = [...this.#pendingForks.values()].flatMap((fork) =>
			fork.adapter ? [fork.adapter] : [],
		);
		this.#sessions.clear();
		this.#names.clear();
		this.#pendingRequests.clear();
		this.#pendingForks.clear();
		// Before the first await, so a startup still short of creating its adapter
		// finds this rather than spawning into a server that is already leaving.
		for (const pending of starting) pending.torndown = true;
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
				this.broadcaster.forget(session.handle);
				await session.adapter?.dispose();
			}),
			// Adapters mid-`start()` are not in the table above: they own a child
			// and their `ManagedSession.adapter` is still undefined. Resolving
			// without reaping them is exactly how shutdown orphans an agent.
			...starting.map((pending) => this.#terminate(pending)),
			...parkedForks.map((adapter) => adapter.dispose()),
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
			// A name a held container has outgrown -- an id it was RENAMED away
			// from, or a spelling `#start` canonicalised onto it -- is not a
			// session of its own. Listing it alongside the session that outgrew it
			// shows one conversation twice, and offers the browser a ref that opens
			// a second agent on it. A fork's container takes none of the parent's
			// names, so a fork's parent -- a genuine second conversation -- is not
			// caught here (`#forkOnto`).
			const live = this.#lookup(summary.ref);
			if (live && sessionKey(live.ref) !== key) continue;
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
	summaryOf(ref: SessionRef): SessionSummary | null {
		const session = this.#lookup(ref);
		if (!session) return null;
		const stored = session.stored;
		return stored
			? { ...stored, ref: session.ref, ...this.#liveOverlay(session), handle: session.handle }
			: this.#ownSummary(session);
	}

	/** A session the index does not know about: everything we have is what we minted. */
	#ownSummary(session: ManagedSession): SessionSummary {
		return {
			ref: session.ref,
			cwd: session.cwd,
			preview: null,
			createdAt: session.createdAt,
			updatedAt: session.createdAt,
			...this.#liveOverlay(session),
			onDisk: session.onDisk,
			handle: session.handle,
		};
	}

	#liveOverlay(session: ManagedSession | undefined): { status: SessionStatus; isStreaming: boolean } {
		if (session?.adapter) {
			return { status: "attached", isStreaming: session.adapter.getState().isStreaming };
		}
		return { status: session?.virtual ? "virtual" : "detached", isStreaming: false };
	}
}
