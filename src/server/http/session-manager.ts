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
	createdAt: string;
	/** What the index told us about this session, kept so attach need not re-walk. */
	stored?: SessionSummary;
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
		const existing = this.#lookup(ref);
		if (existing?.adapter) {
			this.broadcaster.broadcastSnapshot(existing.ref);
			return existing.adapter;
		}

		// Key the in-flight guard by whatever the caller said, so two concurrent
		// attaches on the same (possibly superseded) id still collapse into one.
		const key = sessionKey(existing?.ref ?? ref);
		const inFlight = this.#attaching.get(key);
		if (inFlight) return (await inFlight.promise).adapter as BackendAdapter;

		const pending: PendingStart = {
			torndown: false,
			// Deferred by one microtask so this record is registered below -- and
			// so reachable by close()/disposeAll() -- before `#start` can spawn
			// anything. A startup teardown cannot see is a startup it cannot stop.
			promise: Promise.resolve().then(() => this.#start(ref, existing, pending)),
		};
		this.#attaching.set(key, pending);
		try {
			const session = await pending.promise;
			this.broadcaster.sessionsChanged();
			this.broadcaster.broadcastSnapshot(session.ref);
			return session.adapter as BackendAdapter;
		} finally {
			this.#attaching.delete(key);
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
			this.#adoptRef(session);
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
	 *    a new file, so `adapter.ref` changes and `#adoptRef` re-keys the table
	 *    and emits `renamed`. The value the adapter returns IS its new ref.
	 *  - Codex's `thread/fork` mints a new thread the current adapter is NOT
	 *    driving; its own `ref` is unchanged, so `#adoptRef` no-ops. The returned
	 *    ref points at the freshly-flushed forked thread, which differs from
	 *    `adapter.ref` -- so we hand back what `adapter.fork` gave us, not
	 *    `session.ref`.
	 *  - Claude Code's `fork` respawns its own child onto the forked session, so
	 *    it takes Pi's path here: `adapter.ref` changes and `#adoptRef` re-keys.
	 */
	async fork(ref: SessionRef, entryId: string): Promise<SessionRef> {
		const session = this.#lookup(ref);
		if (!session?.adapter) throw new UnknownSessionError(ref);
		try {
			return await session.adapter.fork(entryId);
		} finally {
			this.#adoptRef(session);
		}
	}

	/**
	 * Honour the adapter contract that `ref` is not stable: `PiAdapter` documents
	 * that its id changes when `start()` resolves and when the first `submit()`
	 * resolves, because Pi's session id IS its JSONL path (D9) and a `virtual`
	 * session has no path until its first prompt writes one. Re-key everything
	 * that is keyed by the old id, keep the old id as an alias for clients still
	 * holding it, and tell the browsers so they can follow (`renamed`).
	 */
	#adoptRef(session: ManagedSession): void {
		const next = session.adapter?.ref;
		if (!next) return;
		const oldKey = sessionKey(session.ref);
		const newKey = sessionKey(next);
		if (oldKey === newKey) return;

		const from = session.ref;
		this.#sessions.delete(oldKey);
		session.ref = next;
		this.#sessions.set(newKey, session);

		this.#aliases.set(oldKey, newKey);
		for (const [alias, target] of this.#aliases) {
			if (target === oldKey) this.#aliases.set(alias, newKey);
		}
		for (const [requestId, owner] of this.#pendingRequests) {
			if (owner === oldKey) this.#pendingRequests.set(requestId, newKey);
		}

		this.broadcaster.sessionsChanged();
		this.broadcaster.renamed(from, next);
	}

	async #start(
		ref: SessionRef,
		existing: ManagedSession | undefined,
		pending: PendingStart,
	): Promise<ManagedSession> {
		const factory = this.#adapters[ref.backend];
		if (!factory) throw new UnknownBackendError(ref.backend);

		let session = existing;
		if (!session) {
			// Not one of ours yet -- it must exist in the backend's store, and we
			// need its workspace before we can spawn anything (D7).
			const summary = await this.#index.get(ref);
			if (!summary) throw new UnknownSessionError(ref);
			if (!summary.cwd) {
				throw new Error(
					`session ${sessionKey(ref)} has no recorded workspace; cannot spawn a sandboxed agent for it`,
				);
			}
			session = {
				ref,
				cwd: summary.cwd,
				virtual: false,
				fromStore: true,
				subscriptions: [],
				lastStreaming: false,
				createdAt: summary.createdAt ?? this.#now(),
				stored: summary,
			};
		}

		// Asking the index where this session lives is the one await before an
		// adapter exists, so a teardown can land with nothing yet to dispose.
		// Everything from here to `pending.adapter` below is synchronous: either
		// teardown sees the adapter, or this sees the flag and never spawns.
		if (pending.torndown) throw new UnknownSessionError(ref);
		if (!existing) this.#sessions.set(sessionKey(ref), session);

		const adapter = factory.create(ref);
		pending.adapter = adapter;
		// Subscribe *before* start(): a backend can emit its first state during
		// startup and we would otherwise miss it.
		const bound = session;
		bound.subscriptions.push(
			adapter.onUpdate((state, changedIndex) => this.#onUpdate(bound, state, changedIndex)),
			adapter.onRequest((request) => {
				this.#pendingRequests.set(request.requestId, sessionKey(bound.ref));
				this.broadcaster.request(bound.ref, request);
			}),
			adapter.onError((message) => this.broadcaster.error(bound.ref, message)),
		);

		try {
			await adapter.start({
				cwd: bound.cwd,
				// Only a session the backend itself stored can be resumed; a
				// `virtual:` id means nothing to Pi or Codex.
				...(bound.fromStore ? { resumeId: ref.id } : {}),
				...(bound.model ? { model: bound.model } : {}),
			});
			// Teardown ran while we were starting. Publishing the adapter now
			// would hand the table a live agent that shutdown has already walked
			// past, and `#adoptRef` below would re-key a closed session back into
			// it. Fall through to the same reaping the failure path uses.
			if (pending.torndown) throw new UnknownSessionError(ref);
		} catch (err) {
			for (const off of bound.subscriptions.splice(0)) off();
			if (!existing) this.#sessions.delete(sessionKey(ref));
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
		bound.lastStreaming = adapter.getState().isStreaming;
		// The first of the two points at which the id can change (D9).
		this.#adoptRef(bound);
		return bound;
	}

	/**
	 * D3's tail upsert. `changedIndex` is what makes it O(1) per token; without
	 * it we cannot know what moved and fall back to a full snapshot, which is
	 * correct but quadratic over a long turn.
	 */
	#onUpdate(session: ManagedSession, state: AdapterState, changedIndex?: number): void {
		const streamingChanged = state.isStreaming !== session.lastStreaming;
		session.lastStreaming = state.isStreaming;

		if (changedIndex !== undefined && changedIndex >= 0 && changedIndex < state.messages.length) {
			const message = state.messages[changedIndex];
			if (message) this.broadcaster.upsert(session.ref, changedIndex, message);
			if (streamingChanged) this.broadcaster.status(session.ref, state.isStreaming);
		} else {
			// A snapshot carries isStreaming, so no separate status event.
			this.broadcaster.broadcastSnapshot(session.ref);
		}
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

	/** Explicit close: this is the only thing besides shutdown that kills an agent. */
	async close(ref: SessionRef): Promise<void> {
		const session = this.#lookup(ref);
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
		const key = sessionKey(session.ref);
		this.#sessions.delete(key);
		for (const [alias, target] of [...this.#aliases]) {
			if (target === key || alias === key) this.#aliases.delete(alias);
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
		if (pending) await this.#terminate(pending);
		else await Promise.resolve(session.adapter?.dispose()).catch(() => {});
		this.broadcaster.sessionsChanged();
	}

	async disposeAll(): Promise<void> {
		// First, and before any await: the tables below are walked exactly once,
		// so anything that starts after this point is in neither of them.
		this.#shuttingDown = true;
		const sessions = [...this.#sessions.values()];
		const starting = [...this.#attaching.values()];
		this.#sessions.clear();
		this.#aliases.clear();
		this.#pendingRequests.clear();
		// Before the first await, so a startup still short of creating its adapter
		// finds this rather than spawning into a server that is already leaving.
		for (const pending of starting) pending.torndown = true;
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
			// An id we have superseded is not a session of its own. Listing it
			// alongside the session that outgrew it shows one conversation twice,
			// and offers the browser a handle that opens a second agent on it.
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
