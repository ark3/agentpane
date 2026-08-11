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
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AgentRequest,
	type ServerEvent,
	type SessionRef,
	sessionKey,
} from "../../shared/protocol.ts";

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

/** State the broadcaster needs to build a snapshot, supplied by the session manager. */
export interface SnapshotSource {
	(ref: SessionRef): { messages: AgentMessage[]; isStreaming: boolean } | null;
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
	sendOpeningSnapshots(client: SseClient, refs: SessionRef[]): void {
		for (const ref of refs) this.sendSnapshot(client, ref);
	}

	/** Targeted snapshot. Does not touch the counter -- see the class comment. */
	sendSnapshot(client: SseClient, ref: SessionRef): void {
		const state = this.#snapshotSource(ref);
		if (!state) return;
		client.send({
			type: "snapshot",
			session: ref,
			seq: this.#seq.get(sessionKey(ref)) ?? 0,
			messages: state.messages,
			isStreaming: state.isStreaming,
		});
	}

	/** Snapshot to everyone. Resets the session's counter, which is safe precisely
	 * because no client is left behind. */
	broadcastSnapshot(ref: SessionRef): void {
		const state = this.#snapshotSource(ref);
		if (!state) return;
		this.#seq.set(sessionKey(ref), 0);
		this.#fanout({
			type: "snapshot",
			session: ref,
			seq: 0,
			messages: state.messages,
			isStreaming: state.isStreaming,
		});
	}

	upsert(ref: SessionRef, index: number, message: AgentMessage): void {
		this.#fanout({ type: "upsert", session: ref, seq: this.#bump(ref), index, message });
	}

	status(ref: SessionRef, isStreaming: boolean): void {
		this.#fanout({ type: "status", session: ref, seq: this.#bump(ref), isStreaming });
	}

	request(ref: SessionRef, request: AgentRequest): void {
		this.#fanout({ type: "request", session: ref, seq: this.#bump(ref), request });
	}

	error(ref: SessionRef, message: string): void {
		this.#fanout({ type: "error", session: ref, seq: this.#bump(ref), message });
	}

	sessionsChanged(): void {
		this.#fanout({ type: "sessions-changed" });
	}

	/**
	 * A session adopted its real backend id (D9). Told to everyone, then followed
	 * by a snapshot under the new ref -- so the counter for the new key is reset
	 * by that snapshot and the old key's is dropped here.
	 */
	renamed(from: SessionRef, to: SessionRef): void {
		// Carry the counter across with the id. A client that has been counting
		// this session's events is the same client that is about to re-key them,
		// so restarting at 0 here would read to it as a dropped update. The
		// snapshot below then resets both ends together, as it always does.
		const fromKey = sessionKey(from);
		this.#seq.set(sessionKey(to), this.#seq.get(fromKey) ?? 0);
		this.#seq.delete(fromKey);
		this.#fanout({ type: "renamed", session: to, seq: this.#bump(to), from });
		this.broadcastSnapshot(to);
	}

	/** Drop a closed session's counter, so the map does not grow with the uptime. */
	forget(ref: SessionRef): void {
		this.#seq.delete(sessionKey(ref));
	}

	/** Current sequence number for a session. Exposed for tests and diagnostics. */
	seqOf(ref: SessionRef): number {
		return this.#seq.get(sessionKey(ref)) ?? 0;
	}

	closeAll(): void {
		for (const client of [...this.#clients]) client.close();
		this.#stopHeartbeat();
	}

	#bump(ref: SessionRef): number {
		const key = sessionKey(ref);
		const next = (this.#seq.get(key) ?? 0) + 1;
		this.#seq.set(key, next);
		return next;
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
