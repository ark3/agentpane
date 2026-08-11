/**
 * A minimal `EventSource` stand-in for tests.
 *
 * The browser's `EventSource` is not available in the node test environment and
 * would not be worth the ceremony anyway: the server sends one unnamed event
 * type whose body is a `ServerEvent`, so parsing is "split on a blank line, drop
 * the `data: ` prefix".
 *
 * It also implements the client half of D3 that the server's contract only
 * implies: track `seq` per session, and treat a gap as "I missed something,
 * re-snapshot". Encoding that here is what lets a server test assert the
 * recovery actually recovers.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ServerEvent, type SessionRef, sessionKey } from "../../../shared/protocol.ts";

export class SseTestClient {
	readonly events: ServerEvent[] = [];
	/** Sessions where a `seq` gap was observed. Per D3 the cure is a fresh snapshot. */
	readonly gaps: string[] = [];

	readonly #transcripts = new Map<string, AgentMessage[]>();
	readonly #seq = new Map<string, number>();
	readonly #streaming = new Map<string, boolean>();
	readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
	readonly #decoder = new TextDecoder();
	#buffer = "";
	#pump: Promise<void>;
	#received = 0;
	#waiters: { predicate: () => boolean; resolve: () => void }[] = [];

	/**
	 * `drop` discards a frame after it has left the server -- the only honest way
	 * to simulate the loss `seq` exists to detect, since a loopback stream does
	 * not otherwise lose anything.
	 */
	constructor(
		response: Response,
		private readonly options: { drop?: (event: ServerEvent, ordinal: number) => boolean } = {},
	) {
		const body = response.body;
		if (!body) throw new Error("SSE response has no body");
		this.#reader = body.getReader();
		this.#pump = this.#read();
	}

	async #read(): Promise<void> {
		for (;;) {
			const { done, value } = await this.#reader.read();
			if (done) return;
			this.#buffer += this.#decoder.decode(value, { stream: true });
			let split: number;
			while ((split = this.#buffer.indexOf("\n\n")) !== -1) {
				const frame = this.#buffer.slice(0, split);
				this.#buffer = this.#buffer.slice(split + 2);
				const line = frame.split("\n").find((l) => l.startsWith("data: "));
				if (!line) continue; // a comment (`: ping`) or a `retry:` directive
				this.#accept(JSON.parse(line.slice("data: ".length)) as ServerEvent);
			}
		}
	}

	#accept(event: ServerEvent): void {
		if (this.options.drop?.(event, this.#received++)) return;
		this.events.push(event);
		if (event.type !== "sessions-changed") {
			const key = sessionKey(event.session);
			if (event.type === "snapshot") {
				this.#transcripts.set(key, [...event.messages]);
				this.#streaming.set(key, event.isStreaming);
			} else {
				const expected = (this.#seq.get(key) ?? 0) + 1;
				if (event.seq !== expected) this.gaps.push(key);
				if (event.type === "upsert") {
					const messages = this.#transcripts.get(key) ?? [];
					messages[event.index] = event.message;
					this.#transcripts.set(key, messages);
				} else if (event.type === "status") {
					this.#streaming.set(key, event.isStreaming);
				}
			}
			this.#seq.set(key, event.seq);
		}
		for (const waiter of [...this.#waiters]) {
			if (!waiter.predicate()) continue;
			this.#waiters = this.#waiters.filter((w) => w !== waiter);
			waiter.resolve();
		}
	}

	/** The transcript this client would be rendering right now. */
	transcript(ref: SessionRef): AgentMessage[] {
		return this.#transcripts.get(sessionKey(ref)) ?? [];
	}

	isStreaming(ref: SessionRef): boolean {
		return this.#streaming.get(sessionKey(ref)) ?? false;
	}

	seq(ref: SessionRef): number {
		return this.#seq.get(sessionKey(ref)) ?? 0;
	}

	typed<T extends ServerEvent["type"]>(type: T): Extract<ServerEvent, { type: T }>[] {
		return this.events.filter((e) => e.type === type) as Extract<ServerEvent, { type: T }>[];
	}

	/** Resolve once `predicate` holds. Events cross a stream, so tests must wait. */
	async until(predicate: () => boolean, label = "condition"): Promise<void> {
		if (predicate()) return;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 2000);
			this.#waiters.push({
				predicate,
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
			});
		});
	}

	async waitForCount(n: number): Promise<void> {
		await this.until(() => this.events.length >= n, `${n} events`);
	}

	/** Drop the connection the way a closed tab does. */
	async close(): Promise<void> {
		await this.#reader.cancel().catch(() => {});
		await this.#pump.catch(() => {});
	}
}
