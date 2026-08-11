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
	/** Guards against two concurrent attaches racing to spawn the same session. */
	readonly #attaching = new Map<string, Promise<ManagedSession>>();

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
		const existing = this.#lookup(ref);
		if (existing?.adapter) {
			this.broadcaster.broadcastSnapshot(existing.ref);
			return existing.adapter;
		}

		// Key the in-flight guard by whatever the caller said, so two concurrent
		// attaches on the same (possibly superseded) id still collapse into one.
		const key = sessionKey(existing?.ref ?? ref);
		const inFlight = this.#attaching.get(key);
		if (inFlight) return (await inFlight).adapter as BackendAdapter;

		const started = this.#start(ref, existing);
		this.#attaching.set(key, started);
		try {
			const session = await started;
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

	async #start(ref: SessionRef, existing: ManagedSession | undefined): Promise<ManagedSession> {
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
			this.#sessions.set(sessionKey(ref), session);
		}

		const adapter = factory.create(ref);
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
		} catch (err) {
			for (const off of bound.subscriptions.splice(0)) off();
			if (!existing) this.#sessions.delete(sessionKey(ref));
			// The adapter spawns before it decides it has started -- PiAdapter
			// spawns, then round-trips a readiness probe -- so a rejection can
			// leave a live sandboxed agent behind. Nothing else will ever reap it.
			await adapter.dispose().catch(() => {});
			throw err;
		}

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

	/** Explicit close: this is the only thing besides shutdown that kills an agent. */
	async close(ref: SessionRef): Promise<void> {
		const session = this.#lookup(ref);
		if (!session) return;
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
		await Promise.resolve(session.adapter?.dispose()).catch(() => {});
		this.broadcaster.sessionsChanged();
	}

	async disposeAll(): Promise<void> {
		const sessions = [...this.#sessions.values()];
		this.#sessions.clear();
		this.#aliases.clear();
		this.#pendingRequests.clear();
		// In parallel and settled, not sequential and awaited: every session left
		// undisposed is a sandboxed agent still holding its workspace, so one
		// adapter that cannot die must not spare the rest.
		await Promise.allSettled(
			sessions.map(async (session) => {
				for (const off of session.subscriptions.splice(0)) off();
				this.broadcaster.forget(session.ref);
				await session.adapter?.dispose();
			}),
		);
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
