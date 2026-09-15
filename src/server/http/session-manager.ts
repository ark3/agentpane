/**
 * The process table: `SessionRef` -> running adapter.
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

interface ManagedSession {
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
	adapter?: BackendAdapter;
	subscriptions: Unsubscribe[];
	/** Last state we broadcast, so we can tell a status flip from a message change. */
	lastStreaming: boolean;
	lastCompaction: "requesting" | "running" | null;
	lastModel: string | null;
	createdAt: string;
	/** What the index told us about this session, kept so attach need not re-walk. */
	stored?: SessionSummary;
	/**
	 * Set by `close()` before its first await. `submit()` and `fork()` both
	 * re-key this container from a `finally` that can run long after teardown
	 * emptied the table -- see `#adoptRef`. Mirrors `PendingStart.torndown`,
	 * which does the same job one stage earlier.
	 */
	torndown?: boolean;
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
	readonly #sessions = new Map<string, ManagedSession>();
	/**
	 * Superseded id -> current id. A session adopts its backend's own id once the
	 * backend names it (see `#adoptRef`), but the browser that created it is still
	 * holding the old one and may already have a prompt in flight against it.
	 * Honouring the old id costs one map entry and is the difference between "the
	 * second message in a new conversation works" and a 404.
	 */
	readonly #aliases = new Map<string, string>();
	/** requestId -> the session whose agent is blocked on it (D2a). */
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
	 *    holding a share of the parent's child.
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
	 */
	readonly #pendingForks = new Map<string, PendingFork>();
	readonly #index: SessionIndex;
	readonly #adapters: Partial<Record<BackendId, { create(ref: SessionRef): BackendAdapter }>>;
	readonly #newId: () => string;
	readonly #now: () => string;
	/**
	 * Guards against two concurrent attaches racing to spawn the same session,
	 * and is the only handle teardown has on an adapter that is still starting.
	 */
	readonly #attaching = new Map<string, PendingStart>();
	/**
	 * Guards against replacing an adapter before its predecessor has finished
	 * disposing. Like `#attaching`, this is keyed by every ref that could reach
	 * the session so a stale client id cannot bypass the guard.
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
		broadcaster.setSnapshotSource((ref) => {
			const adapter = this.#lookup(ref)?.adapter;
			return adapter ? adapter.getState() : null;
		});
	}

	/** Resolve a ref the caller may be holding under a superseded id. */
	#lookup(ref: SessionRef): ManagedSession | undefined {
		const key = sessionKey(ref);
		const direct = this.#sessions.get(key);
		if (direct) return direct;
		const canonical = this.#aliases.get(key);
		return canonical === undefined ? undefined : this.#sessions.get(canonical);
	}

	/**
	 * The id this session actually has now, which is what every event carries.
	 * Returns `ref` unchanged when we know nothing about it.
	 */
	canonicalRef(ref: SessionRef): SessionRef {
		return this.#lookup(ref)?.ref ?? ref;
	}

	/** Refs with live state, i.e. what a freshly connected client needs snapshots of. */
	liveRefs(): SessionRef[] {
		return [...this.#sessions.values()].filter((s) => s.adapter).map((s) => s.ref);
	}

	adapterFor(ref: SessionRef): BackendAdapter | undefined {
		return this.#lookup(ref)?.adapter;
	}

	isAttached(ref: SessionRef): boolean {
		return this.adapterFor(ref) !== undefined;
	}

	/**
	 * D9: a `virtual` session is a workspace choice and nothing more. Nothing
	 * touches the backend's store until the first prompt, so browsing never
	 * litters it with empty sessions.
	 */
	createVirtual(cwd: string, backend: BackendId, model?: string): SessionRef {
		if (!this.#adapters[backend]) throw new UnknownBackendError(backend);
		const ref: SessionRef = { backend, id: `virtual:${this.#newId()}` };
		this.#sessions.set(sessionKey(ref), {
			ref,
			cwd,
			model,
			virtual: true,
			fromStore: false,
			subscriptions: [],
			lastStreaming: false,
			lastCompaction: null,
			lastModel: null,
			createdAt: this.#now(),
		});
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
			this.broadcaster.broadcastSnapshot(existing.ref);
			return existing.adapter;
		}

		// Key the in-flight guard by whatever the caller said, so two concurrent
		// attaches on the same (possibly superseded) id still collapse into one.
		const key = sessionKey(existing?.ref ?? effectiveRef);
		const inFlight = this.#attaching.get(key);
		if (inFlight) return (await inFlight.promise).adapter as BackendAdapter;

		const pending: PendingStart = {
			torndown: false,
			// Deferred by one microtask so this record is registered below -- and
			// so reachable by close()/disposeAll() -- before `#start` can spawn
			// anything. A startup teardown cannot see is a startup it cannot stop.
			promise: Promise.resolve().then(() => this.#start(effectiveRef, existing, pending)),
		};
		this.#attaching.set(key, pending);
		try {
			const session = await pending.promise;
			this.broadcaster.sessionsChanged();
			this.broadcaster.broadcastSnapshot(session.ref);
			return session.adapter as BackendAdapter;
		} finally {
			for (const [pendingKey, attached] of this.#attaching) {
				if (attached === pending) this.#attaching.delete(pendingKey);
			}
		}
	}

	/**
	 * Drive a turn. This goes through the manager rather than straight at the
	 * adapter because `submit()` is one of the two points at which a session's id
	 * can change under us -- see `#adoptRef`.
	 */
	async submit(ref: SessionRef, text: string, images?: ImageInput[]): Promise<void> {
		const session = this.#lookup(ref);
		if (!session?.adapter) throw new UnknownSessionError(ref);
		this.markPrompted(session.ref);
		try {
			await session.adapter.submit(text, images);
		} finally {
			this.#adoptRef(session, "rename");
		}
	}

	/**
	 * Fork a session from a past entry. Like `submit`, this goes through the
	 * manager rather than straight at the adapter because fork is the THIRD point
	 * at which a session's id can change under us (after `start()` and the first
	 * `submit()` -- see `#adoptRef`). The backends are asymmetric and
	 * `#adoptRef` absorbs all of them:
	 *
	 *  - Pi's `fork` is copy-on-write: the process's active `sessionFile` MOVES to
	 *    a new file, so `adapter.ref` changes and `#adoptRef` re-keys the table.
	 *    It emits no `renamed` -- see `#adoptRef`. The value the adapter returns
	 *    IS its new ref.
	 *  - Codex's `thread/fork` mints a new thread the current adapter is NOT
	 *    driving; its own `ref` is unchanged, so `#adoptRef` no-ops. The returned
	 *    ref points at the freshly-flushed forked thread, which differs from
	 *    `adapter.ref` -- so we hand back what `adapter.fork` gave us, not
	 *    `session.ref`. Only the app-server that minted that thread may open it
	 *    (OW-lajehi), so `fork()` also hands over the fork's own adapter, already
	 *    sharing the parent's connection; `#pendingForks` holds it, with the
	 *    resume that starts it, until the attach.
	 *  - Claude Code's `fork` takes Codex's path -- its own ref is unchanged and
	 *    the parent keeps its child and its turn (OW-razoki) -- but nothing has
	 *    recorded the fork yet, so it also hands back the `StartOptions` its own
	 *    adapter must be started with. `#pendingForks` holds those until the
	 *    attach that follows.
	 *
	 * Where the ref DOES change, which is Pi alone, the live adapter is driving
	 * the FORK from here on and the parent is left detached -- still on disk,
	 * still listed, still attachable, but no longer reachable through the
	 * container that moved. That is why this passes `"fork"`: unlike a rename,
	 * the parent's id must not become an alias for the fork (`#adoptRef`,
	 * OW-kekoji).
	 */
	async fork(ref: SessionRef, entryId: string): Promise<SessionRef> {
		const session = this.#lookup(ref);
		if (!session?.adapter) throw new UnknownSessionError(ref);
		try {
			const forked = await session.adapter.fork(entryId);
			if (forked.start) {
				this.#pendingForks.set(sessionKey(forked.ref), {
					start: forked.start,
					...(forked.adapter ? { adapter: forked.adapter } : {}),
				});
			}
			return forked.ref;
		} finally {
			this.#adoptRef(session, "fork");
		}
	}

	/**
	 * Honour the adapter contract that `ref` is not stable. Two different things
	 * can move it and the caller is the only one that knows which, so it says:
	 *
	 *  - `"rename"` -- one conversation took a new id. `PiAdapter` documents that
	 *    its id changes when `start()` resolves and when the first `submit()`
	 *    resolves, because Pi's session id IS its JSONL path (D9) and a `virtual`
	 *    session has no path until its first prompt writes one. The old id is an
	 *    older name for this same conversation, so it stays alive as an alias for
	 *    clients still holding it.
	 *  - `"fork"` -- a SECOND conversation now exists. The container still moves,
	 *    because on Pi the one live adapter is driving the fork now, but the
	 *    parent is not an older name for it: it is a session of its own that is
	 *    still on disk, still listable and still resumable. Aliasing
	 *    it would say the opposite, and would hand every client holding the
	 *    parent's ref a handle that prompts -- or, through `close()`, kills --
	 *    the agent the user is talking to on the fork (OW-kekoji). The parent is
	 *    left detached instead, in the sense D9 and D12 already define.
	 *
	 * Either way, re-key everything that is keyed by the old id. Only a rename
	 * broadcasts `renamed`: that event means "this conversation took a new id",
	 * and every browser that hears it discards what it holds under the old one
	 * and follows its selection across. On a fork that is false for every
	 * browser, and actively wrong for the ones that did not fork -- it would
	 * throw away a parent transcript the server still lists and drag a reader
	 * onto a conversation nobody there opened (OW-suhoto). The fork path emits
	 * `sessionsChanged` alone; the browser that forked already has the fork's ref
	 * from the response and attaches it, which is what snapshots it.
	 */
	#adoptRef(session: ManagedSession, cause: "rename" | "fork"): void {
		// `close()` ran while the `submit()`/`fork()` that called this was still
		// in flight. It deleted this container before its first await, and
		// re-keying now would put a session whose adapter is already disposed back
		// into `#sessions` under the new id -- where `liveRefs()` hands it to
		// every reconnecting client and `attach` returns the dead adapter instead
		// of spawning a replacement, permanently. `#disposing` cannot catch it:
		// close computed its keys before the re-key, so the new one is not among
		// them. `disposeAll()` sets the same flag, for the same window. `#start`'s
		// call site is guarded by `pending.torndown`; these two are guarded here.
		if (session.torndown) return;
		const next = session.adapter?.ref;
		if (!next) return;
		const oldKey = sessionKey(session.ref);
		const newKey = sessionKey(next);
		if (oldKey === newKey) return;

		const from = session.ref;
		this.#sessions.delete(oldKey);
		session.ref = next;
		this.#sessions.set(newKey, session);

		if (cause === "fork") {
			// `session.stored` is the index's answer about the PARENT, and this
			// container is the fork's from here on. A rename keeps it because it is
			// still the same conversation under a new name; a fork must not, or
			// `summaryOf` dresses the parent's `preview` and `updatedAt` in the
			// fork's ref and the attach response draws the fork's row as a copy of
			// the parent's -- identical character for character, now that both rows
			// are listed (OW-kekoji, OW-sehaja). Dropping it makes `#ownSummary`
			// answer instead, whose `preview: null` says "not read from the index
			// yet", not "has said nothing": Pi is the only backend that gets here
			// and its fork inherits the parent's transcript prefix, so the fork's
			// true preview is normally the parent's first user message and the next
			// `list()` will show it. Re-reading the index here would be truer, but
			// it is async in a sync path and on Claude Code the fork is not on disk
			// at all until its first turn ends (OW-japuzo), so it would often have
			// nothing to return.
			session.stored = undefined;
			// `#start` seeded `createdAt` from the parent's stored summary, and
			// `#ownSummary` reports it as `updatedAt` too. The fork's container came
			// into being now, and a stamp days older would sort a brand-new fork
			// below the conversations it was forked out of.
			session.createdAt = this.#now();
		}

		if (cause === "rename") {
			this.#aliases.set(oldKey, newKey);
			// Pre-existing aliases are older names for whatever `oldKey` named, so
			// on a rename they follow it. On a fork they must NOT: they are older
			// names for the PARENT, and retargeting them recreates the same bug one
			// level up. Their lookups miss from here on, which is the right answer
			// -- the parent is detached, not aliased.
			for (const [alias, target] of this.#aliases) {
				if (target === oldKey) this.#aliases.set(alias, newKey);
			}
		}
		for (const [requestId, owner] of this.#pendingRequests) {
			if (owner === oldKey) this.#pendingRequests.set(requestId, newKey);
		}

		this.broadcaster.sessionsChanged();
		if (cause === "rename") this.broadcaster.renamed(from, next);
	}

	async #start(
		ref: SessionRef,
		existing: ManagedSession | undefined,
		pending: PendingStart,
	): Promise<ManagedSession> {
		if (!this.#adapters[ref.backend]) throw new UnknownBackendError(ref.backend);
		let session = existing;
		let addedAlias: [string, string] | undefined;
		const forkStart = this.#pendingForks.get(sessionKey(ref));
		if (!session && forkStart) {
			// A fork this manager minted a moment ago. Its workspace and the
			// arguments that open it came back from `fork()`, because the index
			// either cannot answer for it or cannot be acted on -- see
			// `#pendingForks`.
			session = {
				ref,
				cwd: forkStart.start.cwd,
				virtual: false,
				fromStore: false,
				subscriptions: [],
				lastStreaming: false,
				lastCompaction: null,
				lastModel: null,
				createdAt: this.#now(),
			};
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
			// is really a canonical session another request already owns. Arbitrate
			// on that identity before inserting anything: overwriting either table
			// would orphan the winner's adapter or let two startups share one file.
			const requestedKey = sessionKey(ref);
			const canonicalKey = sessionKey(summary.ref);
			const canonicalSession = this.#lookup(summary.ref);
			if (canonicalSession?.adapter) {
				if (requestedKey !== sessionKey(canonicalSession.ref)) {
					this.#aliases.set(requestedKey, sessionKey(canonicalSession.ref));
				}
				return canonicalSession;
			}
			const canonicalPending = this.#attaching.get(canonicalKey);
			if (canonicalPending && canonicalPending !== pending) {
				const winner = await canonicalPending.promise;
				if (pending.torndown) throw new UnknownSessionError(ref);
				if (requestedKey !== sessionKey(winner.ref)) {
					this.#aliases.set(requestedKey, sessionKey(winner.ref));
				}
				return winner;
			}
			session = {
				ref: summary.ref,
				cwd: summary.cwd,
				virtual: false,
				fromStore: true,
				subscriptions: [],
				lastStreaming: false,
				lastCompaction: null,
				lastModel: null,
				createdAt: summary.createdAt ?? this.#now(),
				stored: summary,
			};
		}
		const factory = this.#adapters[session.ref.backend];
		if (!factory) throw new UnknownBackendError(session.ref.backend);

		// Asking the index where this session lives is the one await before an
		// adapter exists, so a teardown can land with nothing yet to dispose.
		// Everything from here to `pending.adapter` below is synchronous: either
		// teardown sees the adapter, or this sees the flag and never spawns.
		if (pending.torndown) throw new UnknownSessionError(ref);
		if (!existing) {
			const requestedKey = sessionKey(ref);
			const canonicalKey = sessionKey(session.ref);
			if (requestedKey !== canonicalKey) {
				this.#aliases.set(requestedKey, canonicalKey);
				addedAlias = [requestedKey, canonicalKey];
			}
			// No await separates the arbitration above from this claim, so set()
			// cannot replace a competing owner of the canonical identity.
			this.#attaching.set(canonicalKey, pending);
			this.#sessions.set(canonicalKey, session);
		}

		const bound = session;
		let adapter: BackendAdapter;
		try {
			// A fork whose adapter came from its parent is started as-is: only that
			// parent's process can drive it, and the factory builds adapters that
			// spawn their own (OW-lajehi).
			adapter = forkStart?.adapter ?? factory.create(session.ref);
			pending.adapter = adapter;
			// Subscribe *before* start(): a backend can emit its first state during
			// startup and we would otherwise miss it.
			bound.subscriptions.push(
				adapter.onUpdate((state, changedIndex) => this.#onUpdate(bound, state, changedIndex)),
				adapter.onRequest((request) => {
					this.#pendingRequests.set(request.requestId, sessionKey(bound.ref));
					this.broadcaster.request(bound.ref, request);
				}),
				adapter.onError((message) => this.broadcaster.error(bound.ref, message)),
			);
			await adapter.start(
				forkStart?.start ?? {
					cwd: bound.cwd,
					// Only a session the backend itself stored can be resumed; a
					// `virtual:` id means nothing to Pi or Codex.
					...(bound.fromStore ? { resumeId: bound.ref.id } : {}),
					...(bound.model ? { model: bound.model } : {}),
				},
			);
			// Teardown ran while we were starting. Publishing the adapter now
			// would hand the table a live agent that shutdown has already walked
			// past, and `#adoptRef` below would re-key a closed session back into
			// it. Fall through to the same reaping the failure path uses.
			if (pending.torndown) throw new UnknownSessionError(ref);
		} catch (err) {
			for (const off of bound.subscriptions.splice(0)) off();
			if (!existing && this.#sessions.get(sessionKey(bound.ref)) === bound) {
				this.#sessions.delete(sessionKey(bound.ref));
			}
			if (addedAlias && this.#aliases.get(addedAlias[0]) === addedAlias[1]) {
				this.#aliases.delete(addedAlias[0]);
			}
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

		// Publish the adapter *before* the rename below, and keep it that way.
		// `#adoptRef` re-keys the session, so between it and attach's `finally`
		// there is a window where a `close()` can miss the `#attaching` entry; it
		// only stays safe because by then the adapter is reachable as
		// `session.adapter` and close's other branch disposes it. Moving this line
		// after `#adoptRef` turns that key miss into a leaked subprocess.
		bound.adapter = adapter;
		// Consumed: the fork has its own child and its own container, so nothing
		// reaches it through the recipe again -- and must not, or a `close()`
		// followed by an attach on a spelling the rename left behind would fork
		// the PARENT a second time. Deliberately after `start()` resolved: the
		// failure path above leaves the entry parked for a retry.
		this.#pendingForks.delete(sessionKey(ref));
		const initialState = adapter.getState();
		bound.lastStreaming = initialState.isStreaming;
		bound.lastCompaction = initialState.compaction;
		bound.lastModel = initialState.model;
		// The first of the two points at which the id can change (D9).
		this.#adoptRef(bound, "rename");
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
		const modelChanged = state.model !== session.lastModel;
		session.lastStreaming = state.isStreaming;
		session.lastCompaction = state.compaction;
		session.lastModel = state.model;

		const hasChangedMessage = changedIndex !== undefined && changedIndex >= 0 && changedIndex < state.messages.length;
		if (modelChanged && !streamingChanged && !compactionChanged && changedIndex === undefined) {
			this.broadcaster.status(session.ref, state.isStreaming, state.compaction, state.model);
		} else if (hasChangedMessage && compactionChanged) {
			// Compaction completion changes the transcript marker and operation state
			// together. Keep that reducer-level atomicity on the wire rather than let
			// an upsert expose the marker while the client still holds `running`.
			this.broadcaster.broadcastSnapshot(session.ref);
		} else if (hasChangedMessage) {
			const message = state.messages[changedIndex];
			if (message) this.broadcaster.upsert(session.ref, changedIndex, message);
			if (streamingChanged || modelChanged) this.broadcaster.status(session.ref, state.isStreaming, state.compaction, state.model);
		} else {
			// A snapshot carries isStreaming and compaction, so no separate status event.
			this.broadcaster.broadcastSnapshot(session.ref);
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

	/** Mark a virtual session as materialised. Called on the first prompt (D9). */
	markPrompted(ref: SessionRef): void {
		const session = this.#lookup(ref);
		if (session?.virtual) {
			session.virtual = false;
			this.broadcaster.sessionsChanged();
		}
	}

	sessionOfRequest(requestId: string): SessionRef | undefined {
		const key = this.#pendingRequests.get(requestId);
		if (!key) return undefined;
		return this.#sessions.get(key)?.ref;
	}

	clearRequest(requestId: string): void {
		this.#pendingRequests.delete(requestId);
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
		// a child for a session this call deleted. The same line `#aliases` and
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
		const pending = this.#attaching.get(sessionKey(session?.ref ?? ref));
		if (pending) pending.torndown = true;
		if (!session) {
			// Nothing in the table, but a startup for this ref may be on its way to
			// spawning one -- the stored-session path is mid-index-lookup here.
			if (pending) await this.#terminate(pending);
			return;
		}
		// Before the first await below, so a `submit()`/`fork()` already in flight
		// cannot re-key this container back into the table behind us (`#adoptRef`).
		session.torndown = true;
		const key = sessionKey(session.ref);
		const disposalKeys = [key];
		this.#sessions.delete(key);
		for (const [alias, target] of [...this.#aliases]) {
			if (target === key || alias === key) {
				disposalKeys.push(alias);
				this.#aliases.delete(alias);
			}
		}
		for (const [requestId, owner] of [...this.#pendingRequests]) {
			if (owner === key) this.#pendingRequests.delete(requestId);
		}
		for (const off of session.subscriptions.splice(0)) off();
		this.broadcaster.forget(session.ref);
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
		this.#aliases.clear();
		this.#pendingRequests.clear();
		this.#pendingForks.clear();
		// Before the first await, so a startup still short of creating its adapter
		// finds this rather than spawning into a server that is already leaving,
		// and a `submit()`/`fork()` already in flight cannot re-key its container
		// back into the table just cleared (`#adoptRef`).
		for (const pending of starting) pending.torndown = true;
		for (const session of sessions) session.torndown = true;
		// In parallel and settled, not sequential and awaited: every session left
		// undisposed is a sandboxed agent still holding its workspace, so one
		// adapter that cannot die must not spare the rest.
		await Promise.allSettled([
			...sessions.map(async (session) => {
				for (const off of session.subscriptions.splice(0)) off();
				this.broadcaster.forget(session.ref);
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
			// An id we have RENAMED away from, or a spelling we canonicalised away
			// from in `#start`, is not a session of its own. Listing it alongside
			// the session that outgrew it shows one conversation twice, and offers
			// the browser a handle that opens a second agent on it. A fork writes
			// no alias, so a fork's parent -- a genuine second conversation -- is
			// not caught here (`#adoptRef`).
			if (this.#aliases.has(key)) continue;
			byKey.set(key, { ...summary, ...this.#liveOverlay(summary.ref) });
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
			? { ...stored, ref: session.ref, ...this.#liveOverlay(session.ref) }
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
			...this.#liveOverlay(session.ref),
		};
	}

	#liveOverlay(ref: SessionRef): { status: SessionStatus; isStreaming: boolean } {
		const session = this.#lookup(ref);
		if (session?.adapter) {
			return { status: "attached", isStreaming: session.adapter.getState().isStreaming };
		}
		return { status: session?.virtual ? "virtual" : "detached", isStreaming: false };
	}
}
