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
import type { AdapterState, BackendAdapter, Unsubscribe } from "../adapters/types.ts";
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
}

export class SessionManager {
	readonly #sessions = new Map<string, ManagedSession>();
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
			const adapter = this.#sessions.get(sessionKey(ref))?.adapter;
			return adapter ? adapter.getState() : null;
		});
	}

	/** Refs with live state, i.e. what a freshly connected client needs snapshots of. */
	liveRefs(): SessionRef[] {
		return [...this.#sessions.values()].filter((s) => s.adapter).map((s) => s.ref);
	}

	adapterFor(ref: SessionRef): BackendAdapter | undefined {
		return this.#sessions.get(sessionKey(ref))?.adapter;
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
		const key = sessionKey(ref);
		const existing = this.#sessions.get(key);
		if (existing?.adapter) {
			this.broadcaster.broadcastSnapshot(ref);
			return existing.adapter;
		}

		const inFlight = this.#attaching.get(key);
		if (inFlight) return (await inFlight).adapter as BackendAdapter;

		const started = this.#start(ref, existing);
		this.#attaching.set(key, started);
		try {
			const session = await started;
			this.broadcaster.sessionsChanged();
			this.broadcaster.broadcastSnapshot(ref);
			return session.adapter as BackendAdapter;
		} finally {
			this.#attaching.delete(key);
		}
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
			throw err;
		}

		bound.adapter = adapter;
		bound.lastStreaming = adapter.getState().isStreaming;
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
		const session = this.#sessions.get(sessionKey(ref));
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
		const key = sessionKey(ref);
		const session = this.#sessions.get(key);
		if (!session) return;
		this.#sessions.delete(key);
		for (const [requestId, owner] of [...this.#pendingRequests]) {
			if (owner === key) this.#pendingRequests.delete(requestId);
		}
		for (const off of session.subscriptions.splice(0)) off();
		await session.adapter?.dispose();
		this.broadcaster.sessionsChanged();
	}

	async disposeAll(): Promise<void> {
		const sessions = [...this.#sessions.values()];
		this.#sessions.clear();
		this.#pendingRequests.clear();
		for (const session of sessions) {
			for (const off of session.subscriptions.splice(0)) off();
			await session.adapter?.dispose();
		}
	}

	/**
	 * The merged list: what is on disk (D9), plus virtual sessions that exist
	 * only here, with live status overlaid from the process table.
	 */
	async list(query?: ListSessionsQuery): Promise<SessionSummary[]> {
		const stored = await this.#index.list(query);
		const byKey = new Map<string, SessionSummary>();
		for (const summary of stored) {
			byKey.set(sessionKey(summary.ref), { ...summary, ...this.#liveOverlay(summary.ref) });
		}
		for (const session of this.#sessions.values()) {
			const key = sessionKey(session.ref);
			if (byKey.has(key)) continue;
			if (query?.cwd && session.cwd !== query.cwd) continue;
			byKey.set(key, {
				ref: session.ref,
				cwd: session.cwd,
				preview: null,
				createdAt: session.createdAt,
				updatedAt: session.createdAt,
				...this.#liveOverlay(session.ref),
			});
		}
		return [...byKey.values()].sort(
			(a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? "") || 0,
		);
	}

	#liveOverlay(ref: SessionRef): { status: SessionStatus; isStreaming: boolean } {
		const session = this.#sessions.get(sessionKey(ref));
		if (session?.adapter) {
			return { status: "attached", isStreaming: session.adapter.getState().isStreaming };
		}
		return { status: session?.virtual ? "virtual" : "detached", isStreaming: false };
	}
}
