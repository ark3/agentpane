/**
 * The SSE hub: one multiplexed stream per browser, every session on it.
 *
 * D2 -- browsers cap ~6 connections per origin and an open `EventSource` holds
 * one permanently, so a stream per session walls at six. Every event therefore
 * carries its `SessionRef` and clients filter.
 *
 * D3 -- `seq` is monotonic *per session*. A gap tells the client it missed an
 * update; recovery is a fresh snapshot, which is free on loopback. Two kinds of
 * snapshot exist here and the distinction is the whole trick to keeping one
 * counter honest across several clients:
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
import type { AgentNotice, AgentRequest, ServerEvent, SessionRef } from "../../shared/protocol.ts";

/** A connected browser. One per `EventSource`. */
export interface SseClient {
	readonly id: number;
	send(event: ServerEvent): void;
	close(): void;
	readonly closed: boolean;
}

export type SseWriter = (chunk: string) => void;

/** Serialise one event into an SSE frame. JSON never contains a raw newline. */
export function formatSseFrame(event: ServerEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
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
 * adapter's state, and the error, requests and notices the manager holds for
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
		requests: AgentRequest[];
		notices: AgentNotice[];
	} | null;
}

export class Broadcaster {
	readonly #clients = new Set<InternalClient>();
	readonly #seq = new Map<string, number>();
	#nextClientId = 1;
	#snapshotSource: SnapshotSource = () => null;
	#heartbeat: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly heartbeatMs = 0) {}

	/** Wired by the session manager once; avoids a construction-order cycle. */
	setSnapshotSource(source: SnapshotSource): void {
		this.#snapshotSource = source;
	}

	get clientCount(): number {
		return this.#clients.size;
	}

	addClient(write: SseWriter, onClose?: () => void): SseClient {
		const client = new InternalClient(this.#nextClientId++, write, () => {
			this.#clients.delete(client);
			onClose?.();
			if (this.#clients.size === 0) this.#stopHeartbeat();
		});
		this.#clients.add(client);
		// Reconnect fast: this is loopback and recovery is just a re-snapshot.
		client.raw("retry: 500\n\n");
		this.#startHeartbeat();
		return client;
	}

	/** Every session with live state, snapshotted to one client. Attach/reconnect (D3). */
	sendOpeningSnapshots(client: SseClient, handles: string[]): void {
		for (const handle of handles) this.sendSnapshot(client, handle);
	}

	/** Targeted snapshot. Does not touch the counter -- see the class comment. */
	sendSnapshot(client: SseClient, handle: string): void {
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
			requests: state.requests,
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
			requests: state.requests,
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

	request(session: Addressed, request: AgentRequest): void {
		this.#fanout({ type: "request", ...this.#address(session), request });
	}

	requestResolved(session: Addressed, requestId: string): void {
		this.#fanout({ type: "request-resolved", ...this.#address(session), requestId });
	}

	error(session: Addressed, message: string): void {
		this.#fanout({ type: "error", ...this.#address(session), message });
	}

	notice(session: Addressed, notice: AgentNotice): void {
		this.#fanout({ type: "notice", ...this.#address(session), notice });
	}

	sessionsChanged(): void {
		this.#fanout({ type: "sessions-changed" });
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
		this.#stopHeartbeat();
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

	#startHeartbeat(): void {
		if (this.heartbeatMs <= 0 || this.#heartbeat) return;
		this.#heartbeat = setInterval(() => {
			for (const client of [...this.#clients]) client.raw(": ping\n\n");
		}, this.heartbeatMs);
		// Never hold the process open for a keepalive.
		(this.#heartbeat as { unref?: () => void }).unref?.();
	}

	#stopHeartbeat(): void {
		if (!this.#heartbeat) return;
		clearInterval(this.#heartbeat);
		this.#heartbeat = null;
	}
}

class InternalClient implements SseClient {
	#closed = false;

	constructor(
		readonly id: number,
		private readonly write: SseWriter,
		private readonly onClose: () => void,
	) {}

	get closed(): boolean {
		return this.#closed;
	}

	send(event: ServerEvent): void {
		this.raw(formatSseFrame(event));
	}

	/** Write a pre-framed chunk (comments, retry directives). */
	raw(chunk: string): void {
		if (this.#closed) return;
		try {
			this.write(chunk);
		} catch {
			// The socket went away between our last write and this one. A dead
			// client is a normal event -- it must never propagate into the
			// adapter that produced the message (a browser refresh is not a
			// lifecycle event; see DESIGN "Why the subprocess outlives the
			// connection").
			this.close();
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.onClose();
	}
}
