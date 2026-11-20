/**
 * The event hub: every session's events, fanned out to every socket that has
 * said hello (D31). One socket carries every session, so every event carries
 * its `SessionRef` and clients filter.
 *
 * D3 -- `seq` is monotonic *per session*. A gap tells the client it missed an
 * update, and since D25 the client detaches the session rather than taking a
 * fresh snapshot. Two kinds of snapshot exist here and the distinction is the
 * whole trick to keeping one counter honest across several clients:
 *
 *   - `broadcastSnapshot` goes to *every* client, so it may reset the counter
 *     to 0 -- nobody is left holding a stale expectation.
 *   - `sendSnapshot` goes to one client (a fresh connection catching up), so it
 *     carries the counter's *current* value and does not disturb it. That client
 *     resumes in step with everyone else.
 *
 * D24 -- "per session" means per handle: each counter is keyed by the handle
 * the session manager minted for the session, and every per-session event
 * carries that handle beside the session's current ref. A rename changes the
 * ref and leaves the handle, so nothing here moves with it (OW-suyinu).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentNotice, ServerEvent, SessionRef } from "../../shared/protocol.ts";

/** A connected client: one per socket that has said hello. */
export interface EventClient {
	readonly id: number;
	send(event: ServerEvent): void;
	close(): void;
	readonly closed: boolean;
}

/**
 * A live session as the broadcaster addresses it: the handle its counter is
 * keyed by, and the ref its events carry beside it, read as each one is sent
 * (D24). The session manager's container is one.
 */
export interface Addressed {
	readonly handle: string;
	readonly ref: SessionRef;
}

/**
 * State the broadcaster needs to build a snapshot of the session a handle
 * names, supplied by the session manager: the session's current ref, the
 * adapter's state, and the error and notices the manager holds for
 * it (OW-bipume). Null for a handle the manager holds no live session under.
 */
export interface SnapshotSource {
	(handle: string): {
		ref: SessionRef;
		messages: AgentMessage[];
		isStreaming: boolean;
		compaction: "requesting" | "running" | null;
		model: string | null;
		effort: string | null;
		unrestoredModel?: string | null;
		error: string | null;
		errorId: string | null;
		notices: AgentNotice[];
	} | null;
}

export class Broadcaster {
	readonly #clients = new Set<InternalClient>();
	readonly #seq = new Map<string, number>();
	#nextClientId = 1;
	#snapshotSource: SnapshotSource = () => null;

	/** Wired by the session manager once; avoids a construction-order cycle. */
	setSnapshotSource(source: SnapshotSource): void {
		this.#snapshotSource = source;
	}

	get clientCount(): number {
		return this.#clients.size;
	}

	/**
	 * Each event is handed to `send` as the object, synchronously as it is
	 * fanned out. A `send` must not throw, since a throw would reach the
	 * adapter that produced the event: the socket's catches the write that
	 * fails as its socket goes, and closes this client (`openConnection` in
	 * `socket.ts`). No heartbeat: the runtime's own pings keep a socket open
	 * (D31 point 8).
	 */
	addClient(send: (event: ServerEvent) => void, onClose?: () => void): EventClient {
		const client = new InternalClient(this.#nextClientId++, send, () => {
			this.#clients.delete(client);
			onClose?.();
		});
		this.#clients.add(client);
		return client;
	}

	/** Every session with live state, snapshotted to one client. Attach/reconnect (D3). */
	sendOpeningSnapshots(client: EventClient, handles: string[]): void {
		for (const handle of handles) this.sendSnapshot(client, handle);
	}

	/** Targeted snapshot. Does not touch the counter -- see the class comment. */
	sendSnapshot(client: EventClient, handle: string): void {
		const state = this.#snapshotSource(handle);
		if (!state) return;
		client.send({
			type: "snapshot",
			session: state.ref,
			handle,
			seq: this.#seq.get(handle) ?? 0,
			messages: state.messages,
			isStreaming: state.isStreaming,
			compaction: state.compaction,
			model: state.model,
			effort: state.effort,
			unrestoredModel: state.unrestoredModel ?? null,
			error: state.error,
			errorId: state.errorId,
			notices: state.notices,
		});
	}

	/** Snapshot to everyone. Resets the session's counter, which is safe precisely
	 * because no client is left behind. */
	broadcastSnapshot(handle: string): void {
		const state = this.#snapshotSource(handle);
		if (!state) return;
		this.#seq.set(handle, 0);
		this.#fanout({
			type: "snapshot",
			session: state.ref,
			handle,
			seq: 0,
			messages: state.messages,
			isStreaming: state.isStreaming,
			compaction: state.compaction,
			model: state.model,
			effort: state.effort,
			unrestoredModel: state.unrestoredModel ?? null,
			error: state.error,
			errorId: state.errorId,
			notices: state.notices,
		});
	}

	upsert(session: Addressed, index: number, message: AgentMessage): void {
		this.#fanout({ type: "upsert", ...this.#address(session), index, message });
	}

	status(
		session: Addressed,
		isStreaming: boolean,
		compaction: "requesting" | "running" | null,
		model: string | null,
		effort: string | null,
		unrestoredModel: string | null,
	): void {
		this.#fanout({ type: "status", ...this.#address(session), isStreaming, compaction, model, effort, unrestoredModel });
	}

	error(session: Addressed, message: string, errorId: string): void {
		this.#fanout({ type: "error", ...this.#address(session), message, errorId });
	}

	errorCleared(session: Addressed): void {
		this.#fanout({ type: "error-cleared", ...this.#address(session) });
	}

	notice(session: Addressed, notice: AgentNotice): void {
		this.#fanout({ type: "notice", ...this.#address(session), notice });
	}

	sessionsChanged(): void {
		this.#fanout({ type: "sessions-changed" });
	}

	/**
	 * The last event under a handle the session manager has let go of (D26).
	 * Unnumbered, and it leaves the counter alone: `forget` drops that beside it,
	 * and numbering this would put it back.
	 */
	ended(session: Addressed): void {
		this.#fanout({ type: "ended", session: session.ref, handle: session.handle });
	}

	/** Drop a closed session's counter, so the map does not grow with the uptime. */
	forget(handle: string): void {
		this.#seq.delete(handle);
	}

	/** Current sequence number for a session. Exposed for tests and diagnostics. */
	seqOf(handle: string): number {
		return this.#seq.get(handle) ?? 0;
	}

	closeAll(): void {
		for (const client of [...this.#clients]) client.close();
	}

	/** What names the session on an event: its ref as of now, its handle, and the handle's next seq. */
	#address(session: Addressed): { session: SessionRef; handle: string; seq: number } {
		const seq = (this.#seq.get(session.handle) ?? 0) + 1;
		this.#seq.set(session.handle, seq);
		return { session: session.ref, handle: session.handle, seq };
	}

	#fanout(event: ServerEvent): void {
		for (const client of [...this.#clients]) client.send(event);
	}
}

class InternalClient implements EventClient {
	#closed = false;

	constructor(
		readonly id: number,
		private readonly deliver: (event: ServerEvent) => void,
		private readonly onClose: () => void,
	) {}

	get closed(): boolean {
		return this.#closed;
	}

	send(event: ServerEvent): void {
		if (!this.#closed) this.deliver(event);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.onClose();
	}
}
