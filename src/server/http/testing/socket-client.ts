/**
 * One socket's client end (D31), as the browser and the helper hold it, for
 * tests: a `send` that pushes each frame into an array, and the frames a
 * client would write handed to `receive`. Every frame is written
 * synchronously into `frames`, so only a reply needs waiting for.
 *
 * It also implements the client half of D3 that the server's contract only
 * implies: track `seq` per session, and record a gap as "I missed
 * something". What a client does about one is its own (D25 point 5); a
 * server test asserts that a fresh socket's opening snapshot fills the hole.
 *
 * Like the browser's reducer, it keys what it holds by the session's handle
 * and takes the ref from each event under it, so a rename moves the ref and
 * nothing else (D24); a ref asked about is the one a handle last carried.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { vi } from "vitest";
import {
	type CommandName,
	type Commands,
	type ReplyFailed,
	type ReplyOk,
	type ServerEvent,
	type ServerFrame,
	type SessionRef,
	sessionKey,
} from "../../../shared/protocol.ts";
import type { App } from "../app.ts";
import { TEST_API_TOKEN } from "./app.ts";

export class TestSocket {
	readonly frames: ServerFrame[] = [];
	/** Sessions where a `seq` gap was observed. */
	readonly gaps: string[] = [];
	ended: { code: number; reason: string } | null = null;
	readonly connection;
	#next = 0;
	#received = 0;

	/** By handle, as are the three below: the `sessionKey` of the ref it last carried, most recent event last. */
	readonly #refs = new Map<string, string>();
	readonly #transcripts = new Map<string, AgentMessage[]>();
	readonly #seq = new Map<string, number>();
	readonly #streaming = new Map<string, boolean>();

	/**
	 * `drop` discards an event after it has left the server -- the only honest
	 * way to simulate the loss `seq` exists to detect, since nothing in-process
	 * loses anything otherwise.
	 */
	constructor(
		app: App,
		private readonly options: { drop?: (event: ServerEvent, ordinal: number) => boolean } = {},
	) {
		this.connection = app.connect(
			(text) => this.#accept(JSON.parse(text) as ServerFrame),
			(code, reason) => {
				this.ended = { code, reason };
			},
		);
	}

	/** Send a command frame and return its id, without waiting for the reply. */
	send<K extends CommandName>(cmd: K, params: Commands[K]["params"] | Record<string, unknown>): string {
		const id = `r${++this.#next}`;
		this.connection.receive(JSON.stringify({ id, cmd, ...params }));
		return id;
	}

	async request<K extends CommandName>(cmd: K, params: Commands[K]["params"] | Record<string, unknown>): Promise<ReplyOk<K> | ReplyFailed> {
		return this.reply(this.send(cmd, params)) as Promise<ReplyOk<K> | ReplyFailed>;
	}

	/** The reply to `id`, once it has been written. */
	async reply(id: string): Promise<ReplyOk | ReplyFailed> {
		return vi.waitFor(() => {
			const found = this.frames.find((frame) => frame.type === "reply" && frame.id === id);
			if (!found || found.type !== "reply") throw new Error(`no reply to ${id} yet`);
			return found;
		}, { interval: 1 });
	}

	async ok<K extends CommandName>(cmd: K, params: Commands[K]["params"] | Record<string, unknown>): Promise<Commands[K]["result"]> {
		const reply = await this.request(cmd, params);
		if (!reply.ok) throw new Error(`${cmd} refused: ${reply.code} ${reply.detail}`);
		return reply.result as Commands[K]["result"];
	}

	async refused<K extends CommandName>(cmd: K, params: Commands[K]["params"] | Record<string, unknown>): Promise<ReplyFailed> {
		const reply = await this.request(cmd, params);
		if (reply.ok) throw new Error(`${cmd} was admitted`);
		return reply;
	}

	async hello(): Promise<this> {
		await this.ok("hello", { token: TEST_API_TOKEN });
		return this;
	}

	get events(): ServerEvent[] {
		return this.frames.flatMap((frame) => (frame.type === "event" ? [frame.event] : []));
	}

	typed<T extends ServerEvent["type"]>(type: T): Extract<ServerEvent, { type: T }>[] {
		return this.events.filter((e) => e.type === type) as Extract<ServerEvent, { type: T }>[];
	}

	/** Each frame by what it is: an event's type, or `reply:<id>`. */
	get shape(): string[] {
		return this.frames.map((frame) => (frame.type === "event" ? frame.event.type : `reply:${frame.id}`));
	}

	/** Forget the frames so far; what the client holds from them stays. */
	clear(): void {
		this.frames.length = 0;
	}

	/** The transcript this client would be rendering right now. */
	transcript(ref: SessionRef): AgentMessage[] {
		return this.#transcripts.get(this.#handleOf(ref)) ?? [];
	}

	isStreaming(ref: SessionRef): boolean {
		return this.#streaming.get(this.#handleOf(ref)) ?? false;
	}

	seq(ref: SessionRef): number {
		return this.#seq.get(this.#handleOf(ref)) ?? 0;
	}

	/** Drop the connection the way a closed tab does. */
	close(): void {
		this.connection.close();
	}

	#accept(frame: ServerFrame): void {
		if (frame.type !== "event") {
			this.frames.push(frame);
			return;
		}
		const { event } = frame;
		if (this.options.drop?.(event, this.#received++)) return;
		this.frames.push(frame);
		// `ended` carries no seq to count (D26), and nothing comes under its
		// handle after it, so like `sessions-changed` it touches nothing here.
		if (event.type === "sessions-changed" || event.type === "ended") return;
		const key = event.handle;
		this.#refs.delete(key);
		this.#refs.set(key, sessionKey(event.session));
		if (event.type === "snapshot") {
			this.#transcripts.set(key, [...event.messages]);
			this.#streaming.set(key, event.isStreaming);
		} else {
			const expected = (this.#seq.get(key) ?? 0) + 1;
			if (event.seq !== expected) this.gaps.push(sessionKey(event.session));
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

	/** The handle whose events named `ref` most recently, if any handle's last one did. */
	#handleOf(ref: SessionRef): string {
		const key = sessionKey(ref);
		return [...this.#refs].findLast(([, held]) => held === key)?.[0] ?? "";
	}
}
