/**
 * The stdio loop, driven in node against an injected fetch and event source
 * (OW-refibu). Structure only: which requests reach which routes, which
 * notifications come out and in what order -- never model wording.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EventHandlers } from "$client/api.ts";
import { CodexReducer } from "$server/adapters/codex/reducer.ts";
import { readFixture } from "$server/adapters/codex/test-support.ts";
import { ROUTES, type PaneMessage, type ServerEvent, type SessionRef, type SessionSummary } from "$shared/protocol.ts";
import { FrameDecoder, encodeFrame } from "./framing.ts";
import { runHelper } from "./helper.ts";
import type { Render } from "./nodes.ts";
import type { TranscriptNode } from "./protocol.ts";

const render = (markdown: string): string => `stub:${markdown}`;

const pi: SessionRef = { backend: "pi", id: "/tmp/a.jsonl" };
const codex: SessionRef = { backend: "codex", id: "thread-1" };

/** The handle the server minted for the session a ref names, opaque here (D24). */
function h(ref: SessionRef): string {
	return `handle-${ref.backend}-${ref.id}`;
}

function summary(ref: SessionRef, handle = h(ref)): SessionSummary {
	return { ref, cwd: "/work", preview: null, createdAt: null, updatedAt: null, status: "attached", isStreaming: false, onDisk: true, handle };
}

function fixtureMessages(): PaneMessage[] {
	const reducer = new CodexReducer({ now: () => 1_000 });
	for (const line of readFixture("text")) reducer.handle(line);
	return reducer.getState().messages;
}

/** Emacs's end of the pipe: frames pushed in, frames decoded out. */
function stdio() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const input = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
	const out: Record<string, unknown>[] = [];
	const decoder = new FrameDecoder();
	return {
		input,
		write: (frame: Uint8Array) => {
			for (const message of decoder.push(frame)) out.push(message as Record<string, unknown>);
		},
		out,
		send(message: unknown) {
			controller.enqueue(encodeFrame(message));
		},
		/** Close the input, unless the helper already cancelled it on leaving. */
		end() {
			try {
				controller.close();
			} catch {
				// Already closed by the helper's own exit (D25 point 4).
			}
		},
		/** Wait until the output holds `count` frames. */
		async until(count: number): Promise<void> {
			for (let i = 0; i < 200 && out.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 1));
			if (out.length < count) throw new Error(`only ${out.length} of ${count} frames arrived: ${JSON.stringify(out)}`);
		},
		notifications(): Record<string, unknown>[] {
			return out.filter((message) => "method" in message);
		},
		response(id: number): Record<string, unknown> | undefined {
			return out.find((message) => message["id"] === id);
		},
	};
}

/**
 * The server's event stream, scripted: every open captures the handlers so the test can push events.
 * While `failing` is above zero an open fails instead, as `sse.ts` reports one, and counts it down.
 * While `holding` is set an open reports nothing until `openHeld()`, as one whose response headers are slow.
 */
function eventSource() {
	const opens: EventHandlers[] = [];
	const closed: number[] = [];
	const held: (() => void)[] = [];
	const source = {
		opens,
		closed,
		failing: 0,
		holding: false,
		openEvents: (_url: string, handlers: EventHandlers) => {
			const index = opens.push(handlers) - 1;
			const fails = source.failing > 0;
			if (fails) source.failing -= 1;
			const report = () => (fails ? handlers.onDisconnect(true) : handlers.onOpen());
			if (source.holding) held.push(report);
			else queueMicrotask(report);
			return { close: () => void closed.push(index) };
		},
		/** Report every open `holding` held. */
		openHeld() {
			for (const report of held.splice(0)) report();
		},
		emit(event: ServerEvent) {
			opens.at(-1)!.onEvent(event);
		},
	};
	return source;
}

type Route = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function fetchFor(routes: Record<string, Route>) {
	const calls: { url: string; method: string; body: unknown }[] = [];
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
		const key = `${init?.method ?? "GET"} ${url}`;
		const route = routes[key];
		if (!route) throw new Error(`unrouted ${key}`);
		return route(url, init);
	});
	return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

/**
 * Let the helper take what was just sent and answer what it can: an attach
 * whose reply the fake fetch gives at once is then waiting for its snapshot,
 * which the server broadcasts before it answers (OW-rebawa), and which a
 * test emits next.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Whether `promise` settles within 50ms, so a helper that never exits fails its test rather than timing it out. */
function settled(promise: Promise<unknown>): Promise<"resolved" | "pending"> {
	return Promise.race([promise.then(() => "resolved" as const), new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50))]);
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noContent = () => new Response(null, { status: 204 });

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
	vi.useRealTimers();
	await stop?.();
	stop = null;
});

function start(routes: Record<string, Route>, renderMarkdown: Render = render) {
	const io = stdio();
	const source = eventSource();
	const { fetch, calls } = fetchFor(routes);
	const done = runHelper({ input: io.input, write: io.write, fetch, openEvents: source.openEvents, render: renderMarkdown });
	stop = async () => {
		io.end();
		await done;
	};
	return { io, source, calls, done };
}

describe("requests", () => {
	it("lists sessions through the listing route and answers the summaries", async () => {
		const { io, calls } = start({ [`GET ${ROUTES.sessions}?cwd=%2Fwork`]: () => json({ sessions: [summary(pi)] }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list", params: { cwd: "/work" } });
		await io.until(1);
		expect(io.response(1)).toEqual({ jsonrpc: "2.0", id: 1, result: [summary(pi)] });
		expect(calls).toHaveLength(1);
	});

	it("previews a stored session as nodes, each text part carrying html, and opens no stream", async () => {
		const turns = fixtureMessages();
		const { io, source } = start({ [`GET ${ROUTES.preview(codex)}`]: () => json({ ref: codex, turns }) });
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/preview", params: { session: codex } });
		await io.until(1);
		const nodes = io.response(2)!["result"] as TranscriptNode[];
		expect(nodes.map((node) => node.index)).toEqual(turns.map((_, index) => index));
		const texts = nodes.flatMap((node) => node.parts.filter((part) => part.type === "text"));
		expect(texts.length).toBeGreaterThan(0);
		for (const part of texts) {
			expect(part.html.length).toBeGreaterThan(0);
			expect(part.html).toBe(`stub:${part.text}`);
		}
		expect(source.opens).toHaveLength(0);
	});

	it("forwards each verb to its route and answers null where the route has no body", async () => {
		const model = { id: "m", label: "M", efforts: [{ id: "low", description: "Fast" }], defaultEffort: "low" };
		const { io, calls } = start({
			[`POST ${ROUTES.sessions}`]: () => json({ ref: pi }),
			[`GET ${ROUTES.models}?backend=pi`]: () => json({ models: [model] }),
			[`POST ${ROUTES.prompt(pi)}`]: noContent,
			[`POST ${ROUTES.abort(pi)}`]: noContent,
			[`POST ${ROUTES.compact(pi)}`]: noContent,
			[`DELETE ${ROUTES.session(pi)}`]: noContent,
			[`POST ${ROUTES.model(pi)}`]: noContent,
			[`POST ${ROUTES.effort(pi)}`]: noContent,
			[`GET ${ROUTES.forkPoints(pi)}`]: () => json({ points: [{ id: "e1", text: "hi", index: 0 }] }),
			[`POST ${ROUTES.fork(pi)}`]: () => json({ ref: codex }),
			[`DELETE ${ROUTES.error(pi)}`]: noContent,
		});
		const requests = [
			["sessions/create", { cwd: "/work", backend: "pi" }, pi],
			["models/list", { backend: "pi" }, [model]],
			["sessions/prompt", { session: pi, text: "hello", priorErrorId: "e4" }, null],
			["sessions/abort", { session: pi }, null],
			["sessions/compact", { session: pi }, null],
			["sessions/close", { session: pi }, null],
			["sessions/setModel", { session: pi, model: "m" }, null],
			["sessions/setEffort", { session: pi, effort: "low" }, null],
			["sessions/forkPoints", { session: pi }, [{ id: "e1", text: "hi", index: 0 }]],
			["sessions/fork", { session: pi, entryId: "e1" }, codex],
			["sessions/dismissError", { session: pi, errorId: "e4" }, null],
		] as const;
		requests.forEach(([method, params], index) => io.send({ jsonrpc: "2.0", id: index + 10, method, params }));
		await io.until(requests.length);
		requests.forEach(([, , result], index) => {
			expect(io.response(index + 10)).toEqual({ jsonrpc: "2.0", id: index + 10, result });
		});
		// The error the buffer held at the send goes with the prompt, so admitting
		// it clears only that one (OW-jokoto).
		expect(calls.find((call) => call.url === ROUTES.prompt(pi))?.body).toEqual({ text: "hello", priorErrorId: "e4" });
		expect(calls.find((call) => call.url === ROUTES.model(pi))?.body).toEqual({ model: "m" });
		expect(calls.find((call) => call.url === ROUTES.effort(pi))?.body).toEqual({ effort: "low" });
		expect(calls.find((call) => call.url === ROUTES.fork(pi))?.body).toEqual({ entryId: "e1" });
		// Named by id, so the server clears it only while it is still the one held,
		// even against a newer one with the same text (OW-desufa, OW-jokoto).
		expect(calls.find((call) => call.url === ROUTES.error(pi))?.body).toEqual({ errorId: "e4" });
	});

	it("carries a server rejection through as a JSON-RPC error with the server's text", async () => {
		const { io } = start({
			[`POST ${ROUTES.prompt(pi)}`]: () => json({ error: "turn_active", detail: "a turn is already running" }, 409),
		});
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/prompt", params: { session: pi, handle: h(pi), text: "again" } });
		await io.until(1);
		expect(io.response(3)).toEqual({
			jsonrpc: "2.0",
			id: 3,
			error: {
				code: 409,
				message: "a turn is already running",
				data: { status: 409, error: "turn_active", detail: "a turn is already running" },
			},
		});
	});

	it("answers a preview of a gone session with an error whose data carries gone (D26)", async () => {
		const { io } = start({
			[`GET ${ROUTES.preview(codex)}`]: () => json({ error: "gone", detail: "no such session" }, 404),
		});
		io.send({ jsonrpc: "2.0", id: 6, method: "sessions/preview", params: { session: codex } });
		await io.until(1);
		expect(io.response(6)!["error"]).toMatchObject({ code: 404, data: { status: 404, error: "gone" } });
	});

	it("answers an unknown method with -32601 and any other failure with -32603", async () => {
		const { io } = start({});
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/dance", params: {} });
		io.send({ jsonrpc: "2.0", id: 5, method: "sessions/abort", params: { session: pi } });
		await io.until(2);
		expect(io.response(4)!["error"]).toMatchObject({ code: -32601 });
		expect(io.response(5)!["error"]).toMatchObject({ code: -32603, message: expect.stringContaining("unrouted") });
	});
});

const attachRoutes = (ref: SessionRef) => ({ [`GET ${ROUTES.session(ref)}`]: () => json({ session: summary(ref) }) });

describe("notifications", () => {
	it("opens the stream before the attach call, then yields one snapshot and, when the interval ends, one node carrying the last upsert", async () => {
		const messages = fixtureMessages();
		const tail = messages.length - 1;
		const final = messages[tail] as AssistantMessage;
		let streamsOpenAtAttach = -1;
		const { io, source, calls } = start({
			[`GET ${ROUTES.session(codex)}`]: () => {
				streamsOpenAtAttach = source.opens.length;
				return json({ session: summary(codex) });
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: codex } });
		await tick();
		expect(streamsOpenAtAttach).toBe(1);
		expect(calls).toHaveLength(1);

		source.emit({ type: "snapshot", session: codex, handle: h(codex), seq: 1, messages: messages.slice(0, tail), isStreaming: true, compaction: null, model: "m", effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await io.until(2);
		expect(io.out[1]).toEqual({ jsonrpc: "2.0", id: 1, result: summary(codex) });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const partial = { ...final, content: [{ type: "text", text: "par" }], stopReason: "pending" } as PaneMessage;
		source.emit({ type: "upsert", session: codex, handle: h(codex), seq: 2, index: tail, message: partial });
		source.emit({ type: "upsert", session: codex, handle: h(codex), seq: 3, index: tail, message: final });
		expect(io.notifications()).toHaveLength(1);
		vi.advanceTimersByTime(250);
		const [snapshot, node] = io.notifications();
		expect(snapshot).toMatchObject({ method: "session/snapshot", params: { session: codex, isStreaming: true, compaction: null, model: "m" } });
		expect((snapshot!["params"] as { nodes: TranscriptNode[] }).nodes.map((node) => node.index)).toEqual(
			messages.slice(0, tail).map((_, index) => index),
		);
		expect(node).toMatchObject({ method: "session/node", params: { session: codex, node: { index: tail, role: "assistant" } } });
		const texts = (node!["params"] as { node: TranscriptNode }).node.parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
		expect(texts).toEqual(final.content.flatMap((block) => (block.type === "text" ? [block.text] : [])));
		expect(io.notifications()).toHaveLength(2);
	});

	it("detaches a session whose seq gaps, attaching nothing, and says nothing more under it until Emacs attaches it again (OW-filuge)", async () => {
		const { io, source, calls } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await io.until(2);

		source.emit({ type: "status", session: pi, handle: h(pi), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await io.until(3);
		expect(io.notifications()[1]).toEqual({ jsonrpc: "2.0", method: "session/detached", params: { session: pi, handle: h(pi) } });
		// A later event under the handle finds no view to gap against again.
		source.emit({ type: "status", session: pi, handle: h(pi), seq: 4, isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null });
		// A gap in a view Emacs never attached is told nothing.
		source.emit({ type: "snapshot", session: codex, handle: h(codex), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		source.emit({ type: "status", session: codex, handle: h(codex), seq: 5, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(calls).toHaveLength(1);
		expect(io.notifications()).toHaveLength(2);

		// `a` or a send: the attach broadcasts a snapshot, which forms the view again.
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi } });
		await tick();
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 0, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await io.until(5);
		expect(io.notifications()[2]).toMatchObject({ method: "session/snapshot", params: { session: pi, handle: h(pi), isStreaming: true } });
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${ROUTES.session(pi)}`, `GET ${ROUTES.session(pi)}`]);
	});

	it("sends nothing from the gapped view when the attach after it is answered under the rename the gap swallowed (OW-filuge)", async () => {
		const renamed: SessionRef = { backend: "pi", id: "/tmp/renamed.jsonl" };
		let attaches = 0;
		const { io, source } = start({ [`GET ${ROUTES.session(pi)}`]: () => json({ session: summary(attaches++ === 0 ? pi : renamed, h(pi)) }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		source.emit({ type: "status", session: renamed, handle: h(pi), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await io.until(3);

		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi } });
		await tick();
		source.emit({ type: "snapshot", session: renamed, handle: h(pi), seq: 0, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await io.until(5);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.out.slice(1).map((message) => message["method"] ?? message["id"])).toEqual(["session/detached", 1, "session/snapshot", 2]);
		expect(io.out[3]).toMatchObject({ params: { session: renamed, handle: h(pi), isStreaming: true, askedFor: pi } });
	});

	// The server broadcasts an attach's snapshot before it answers, but the
	// stream and the REST response are unordered (D2): on the fake adapters
	// the reply reached a client first in about half the attaches, or more. Emacs takes the reply to mean the attach is over, attached or
	// not, so the reply waits for the snapshot still on its way (OW-rebawa).
	it("holds the reply of an attach that lands ahead of its snapshot until the snapshot, and writes it after (OW-rebawa)", async () => {
		const { io, source } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		expect(io.out).toEqual([]);
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 0, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await io.until(2);
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 1]);
		expect(io.out[0]).toMatchObject({ params: { session: pi, handle: h(pi), askedFor: pi } });
	});

	it("holds the reply of an attach answered under another ref ahead of its snapshot until the snapshot, and writes it after (OW-rebawa)", async () => {
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start({ [`GET ${ROUTES.session(alias)}`]: () => json({ session: summary(pi) }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: alias } });
		await tick();
		expect(io.out).toEqual([]);
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 0, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await io.until(2);
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 1]);
		expect(io.out[0]).toMatchObject({ params: { session: pi, handle: h(pi), askedFor: alias } });
	});

	it("tags the snapshot that answers an attach with the ref it asked for, the same ref as the session's included, so it reaches the buffer that asked and not one already holding the handle (OW-rebawa)", async () => {
		// X attached a `virtual` id, and its session was renamed onto pi; P,
		// previewing pi, attaches it. Untagged, the snapshot answering P went by
		// its handle to X, and P never attached.
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start({
			...attachRoutes(virtual),
			[`GET ${ROUTES.session(pi)}`]: () => json({ session: summary(pi, h(virtual)) }),
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual } });
		await tick();
		source.emit({ type: "snapshot", session: virtual, handle: h(virtual), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		source.emit({ type: "snapshot", session: pi, handle: h(virtual), seq: 0, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await io.until(3);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi } });
		await io.until(5);
		expect(io.out.slice(3).map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 2]);
		expect(io.out[3]).toMatchObject({ params: { session: pi, handle: h(virtual), askedFor: pi } });
	});

	it("answers each attach waiting on one handle with a snapshot of its own, tagged with the ref it asked for, before their replies (OW-rebawa)", async () => {
		// A attaches an alias and B the session's own ref; both replies reach
		// the helper before the snapshot. Each buffer is sent the snapshot that
		// attaches it, and agentpane-mode merges them.
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start({
			[`GET ${ROUTES.session(alias)}`]: () => json({ session: summary(pi) }),
			[`GET ${ROUTES.session(pi)}`]: () => json({ session: summary(pi) }),
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: alias } });
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi } });
		await tick();
		expect(io.out).toEqual([]);
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 0, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await io.until(4);
		await tick();
		expect(io.out.slice(0, 2).map((message) => (message["params"] as { askedFor?: SessionRef }).askedFor)).toEqual([alias, pi]);
		expect(new Set(io.out.slice(2).map((message) => message["id"]))).toEqual(new Set([1, 2]));
		expect(io.out).toHaveLength(4);
	});

	it("releases a reply waiting for a snapshot under a handle that ended, attaching nothing (OW-rebawa, D26)", async () => {
		const { io, source } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		expect(io.out).toEqual([]);
		source.emit({ type: "ended", session: pi, handle: h(pi) });
		await io.until(1);
		await tick();
		expect(io.out).toEqual([{ jsonrpc: "2.0", id: 1, result: summary(pi) }]);
	});

	it("releases a reply waiting for a snapshot when the stream drops (OW-rebawa)", async () => {
		const { io, source, done } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		expect(io.out).toEqual([]);
		source.opens[0]!.onDisconnect(true);
		expect(await settled(done)).toBe("resolved");
		await tick();
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual([1]);
	});

	it("records no attachment for an attach answered under another ref whose snapshot a gap took before the reply (OW-tifiva)", async () => {
		// The snapshot under the new ref matches no pending attach, which waits
		// under the ref it asked for, and the gap takes the view it formed; the
		// reply then has no snapshot to forward. An attachment recorded there
		// would be one Emacs was never told of: the `ended` under the handle
		// would then say `session/detached` for it.
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start({
			[`GET ${ROUTES.session(alias)}`]: () => {
				source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
				source.emit({ type: "status", session: pi, handle: h(pi), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
				return json({ session: summary(pi) });
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: alias } });
		await tick();
		source.emit({ type: "status", session: pi, handle: h(pi), seq: 4, isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null });
		source.emit({ type: "ended", session: pi, handle: h(pi) });
		await io.until(1);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual([1]);
	});

	it("sends an attach's reply after the session/detached of the gap that took its snapshot, and records nothing at the reply (OW-tifiva)", async () => {
		const { io, source } = start({
			[`GET ${ROUTES.session(pi)}`]: () => {
				source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
				source.emit({ type: "status", session: pi, handle: h(pi), seq: 3, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
				return json({ session: summary(pi) });
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		source.emit({ type: "ended", session: pi, handle: h(pi) });
		await io.until(3);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", "session/detached", 1]);
	});

	it("sends the view it holds as the snapshot of an attach whose reply lands ahead of it, before the reply (OW-rebawa)", async () => {
		// A buffer killed and opened again: the detach drops the attachment
		// and leaves the reducer's view, and the attach's own snapshot is still
		// on its way when the reply lands. The reply attaches nothing in Emacs,
		// so the snapshot that does goes before it, tagged with the ref asked
		// for, rather than the reply waiting on one that the view already is.
		const { io, source } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/detach", params: { session: pi, handle: h(pi) } });
		await io.until(3);
		source.emit({ type: "status", session: pi, handle: h(pi), seq: 2, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/attach", params: { session: pi } });
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.out.slice(3).map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 3]);
		expect(io.out[3]).toMatchObject({ params: { session: pi, handle: h(pi), isStreaming: true, askedFor: pi } });
	});

	it("says nothing for a session Emacs never attached, and nothing more after sessions/close", async () => {
		const { io, source } = start({ ...attachRoutes(pi), [`DELETE ${ROUTES.session(pi)}`]: noContent });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		source.emit({ type: "snapshot", session: codex, handle: h(codex), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		source.emit({ type: "status", session: codex, handle: h(codex), seq: 2, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await io.until(2);
		expect(io.notifications()).toEqual([
			{ jsonrpc: "2.0", method: "session/snapshot", params: { session: pi, handle: h(pi), askedFor: pi, nodes: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] } },
		]);

		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/close", params: { session: pi } });
		await io.until(3);
		source.emit({ type: "status", session: pi, handle: h(pi), seq: 2, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.notifications()).toHaveLength(1);
	});

	it("says nothing more after sessions/detach, which calls no route, nor after an attach in flight across it", async () => {
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		const { io, source, calls } = start({
			...attachRoutes(codex),
			[`GET ${ROUTES.session(alias)}`]: async () => {
				await held;
				return json({ session: summary(pi) });
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: codex } });
		await tick();
		// The reply waits for the attach's snapshot, and the detach ends that wait.
		expect(io.out).toEqual([]);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/detach", params: { session: codex } });
		await io.until(2);
		expect(io.response(1)).toEqual({ jsonrpc: "2.0", id: 1, result: summary(codex) });
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: null });
		source.emit({ type: "snapshot", session: codex, handle: h(codex), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });

		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/attach", params: { session: alias } });
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/detach", params: { session: alias } });
		await io.until(3);
		release();
		await io.until(4);
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		source.emit({ type: "snapshot", session: alias, handle: h(alias), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.notifications()).toEqual([]);
		expect(calls.map((call) => call.url)).toEqual([ROUTES.session(codex), ROUTES.session(alias)]);
	});

	it("forwards the snapshot under the handle that names a rename, and nothing beside it", async () => {
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start(attachRoutes(virtual));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual } });
		await tick();
		source.emit({ type: "snapshot", session: virtual, handle: h(virtual), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		source.emit({ type: "snapshot", session: pi, handle: h(virtual), seq: 0, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await io.until(3);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.notifications().map((message) => message["method"])).toEqual(["session/snapshot", "session/snapshot"]);
		expect(io.notifications()[1]).toMatchObject({ params: { session: pi, handle: h(virtual), isStreaming: true } });
	});

	it("stops on a sessions/detach by the ref a snapshot under the handle told Emacs", async () => {
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start(attachRoutes(virtual));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual } });
		await tick();
		source.emit({ type: "snapshot", session: virtual, handle: h(virtual), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		source.emit({ type: "snapshot", session: pi, handle: h(virtual), seq: 0, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await io.until(3);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/detach", params: { session: pi } });
		await io.until(4);
		source.emit({ type: "status", session: pi, handle: h(virtual), seq: 1, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.notifications().map((message) => message["method"])).toEqual(["session/snapshot", "session/snapshot"]);
	});

	// OW-wedeli: resolved by the ref alone, a detach naming the ref from
	// before a rename matched nothing and the session went on being forwarded.
	it("stops on a sessions/detach by the handle, whatever ref it names", async () => {
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start(attachRoutes(virtual));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual } });
		await tick();
		source.emit({ type: "snapshot", session: virtual, handle: h(virtual), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		source.emit({ type: "snapshot", session: pi, handle: h(virtual), seq: 0, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await io.until(3);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/detach", params: { session: virtual, handle: h(virtual) } });
		await io.until(4);
		source.emit({ type: "status", session: pi, handle: h(virtual), seq: 1, isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.notifications().map((message) => message["method"])).toEqual(["session/snapshot", "session/snapshot"]);
	});

	it("keeps forwarding a session Emacs attached when a second attach of its ref fails", async () => {
		let attaches = 0;
		const { io, source } = start({
			[`GET ${ROUTES.session(pi)}`]: () => (++attaches === 1 ? json({ session: summary(pi) }) : json({ error: "boom" }, 500)),
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi } });
		await tick();
		expect(io.response(2)!["error"]).toBeDefined();
		source.emit({ type: "status", session: pi, handle: h(pi), seq: 2, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await io.until(4);
		expect(io.notifications().map((message) => message["method"])).toEqual(["session/snapshot", "session/status"]);
	});

	it("sends the snapshot it dropped for an attach answered under another ref before the reply, tagged with the ref asked for", async () => {
		// An attach through an alias: the route answers the new ref, and its
		// snapshot, under that ref, lands before the reply. Filtered by the
		// asked-for ref it went nowhere; sent now, it names that ref in
		// `askedFor`, which is how agentpane-mode finds the buffer that asked
		// whether or not it has handled the reply.
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start({
			[`GET ${ROUTES.session(alias)}`]: () => {
				source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
				return json({ session: summary(pi) });
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: alias } });
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 1]);
		expect(io.out[0]).toMatchObject({ params: { session: pi, handle: h(pi), isStreaming: true, askedFor: alias } });
		expect(io.out[1]).toMatchObject({ id: 1, result: { ref: pi, handle: h(pi) } });

		source.emit({ type: "status", session: pi, handle: h(pi), seq: 2, isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null });
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 0, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await io.until(4);
		expect(io.out[2]).toMatchObject({ method: "session/status", params: { session: pi, handle: h(pi), isStreaming: false } });
		// The tag rides that one snapshot and nothing after it.
		expect(io.out.slice(2).filter((message) => "askedFor" in (message["params"] as object))).toEqual([]);
	});

	it("holds the reply of an attach answered under another ref until the snapshot none had sent by then, which it tags, and tags nothing after it", async () => {
		// Until a snapshot introduces the view the reducer holds nothing under
		// the handle, and forwards nothing: every other event for a view it does
		// not hold leaves the state as it was. So the first thing sent under the
		// handle is that snapshot, and the reply follows it.
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start({ [`GET ${ROUTES.session(alias)}`]: () => json({ session: summary(pi) }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: alias } });
		await tick();
		expect(io.out).toEqual([]);

		source.emit({ type: "status", session: pi, handle: h(pi), seq: 1, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 0, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await tick();
		source.emit({ type: "status", session: pi, handle: h(pi), seq: 1, isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null });
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 0, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await io.until(4);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.out.map((message) => [message["method"] ?? message["id"], (message["params"] as { askedFor?: SessionRef } | undefined)?.askedFor])).toEqual([
			["session/snapshot", alias],
			[1, undefined],
			["session/status", undefined],
			["session/snapshot", undefined],
		]);
	});

	it("drops only the alias's own wait on a detach by that alias, so an attach of the canonical ref to the same handle is still fed", async () => {
		// B attaches the canonical ref and A an alias of the same session; both
		// replies land before the session's snapshot, and A is killed before it.
		// A's wait goes with it, its reply released, and the snapshot answers
		// B's alone, tagged with B's ref.
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start({
			[`GET ${ROUTES.session(alias)}`]: () => json({ session: summary(pi) }),
			[`GET ${ROUTES.session(pi)}`]: () => json({ session: summary(pi) }),
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: alias } });
		await tick();
		expect(io.out).toEqual([]);
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/detach", params: { session: alias } });
		await io.until(2);
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 0, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await tick();
		source.emit({ type: "status", session: pi, handle: h(pi), seq: 1, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await io.until(5);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(new Set(io.out.slice(0, 2).map((message) => message["id"]))).toEqual(new Set([2, 3]));
		expect(io.out.slice(2).map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 1, "session/status"]);
		expect(io.notifications().map((message) => (message["params"] as { askedFor?: SessionRef }).askedFor)).toEqual([pi, undefined]);
	});

	it("stops on a sessions/detach by the ref asked for, from a buffer killed before the snapshot that would have named the handle", async () => {
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start({ [`GET ${ROUTES.session(alias)}`]: () => json({ session: summary(pi) }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: alias } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/detach", params: { session: alias } });
		await io.until(2);
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 0, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.notifications()).toEqual([]);
	});

	it("sends no second snapshot for an attach the stream already moved onto its handle, when the reply names another ref", async () => {
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start({
			[`GET ${ROUTES.session(virtual)}`]: () => {
				source.emit({ type: "snapshot", session: virtual, handle: h(virtual), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
				source.emit({ type: "snapshot", session: pi, handle: h(virtual), seq: 0, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
				return json({ session: summary(pi, h(virtual)) });
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual } });
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", "session/snapshot", 1]);
		// The first answered the attach, by the ref it asked for, and carries it.
		expect(io.notifications().map((message) => (message["params"] as { askedFor?: SessionRef }).askedFor)).toEqual([virtual, undefined]);
	});

	it("passes status and error through", async () => {
		const { io, source } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		source.emit({ type: "status", session: pi, handle: h(pi), seq: 2, isStreaming: true, compaction: "running", model: "m", effort: "low", unrestoredModel: null });
		source.emit({ type: "error", session: pi, handle: h(pi), seq: 3, message: "boom", errorId: "e1" });
		await io.until(4);
		const [, status, error] = io.notifications();
		expect(status).toEqual({ jsonrpc: "2.0", method: "session/status", params: { session: pi, handle: h(pi), isStreaming: true, compaction: "running", model: "m", effort: "low", unrestoredModel: null } });
		// With the id Emacs names it by when it dismisses it or prompts over it (OW-jokoto).
		expect(error).toEqual({ jsonrpc: "2.0", method: "session/error", params: { session: pi, handle: h(pi), message: "boom", errorId: "e1" } });
	});

	it("passes the server's clear of the turn error through as session/errorCleared (OW-jopifu)", async () => {
		const { io, source } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		source.emit({ type: "error", session: pi, handle: h(pi), seq: 2, message: "boom", errorId: "e1" });
		source.emit({ type: "error-cleared", session: pi, handle: h(pi), seq: 3 });
		await io.until(4);
		const [, , cleared] = io.notifications();
		expect(cleared).toEqual({ jsonrpc: "2.0", method: "session/errorCleared", params: { session: pi, handle: h(pi) } });
	});

	it("passes a notice through as session/notice, not session/error (OW-tujiya)", async () => {
		const { io, source } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		const notice = { kind: "configWarning", message: "unknown key", details: "see the docs", path: "/c.toml:3:5" };
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		source.emit({ type: "notice", session: pi, handle: h(pi), seq: 2, notice });
		await io.until(3);
		const [, noticed] = io.notifications();
		expect(noticed).toEqual({ jsonrpc: "2.0", method: "session/notice", params: { session: pi, handle: h(pi), notice } });
	});

	it("carries the notices the server's snapshot holds on every later session/snapshot (OW-tujiya, OW-bipume)", async () => {
		const { io, source } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		const notice = { kind: "warning", message: "fallback metadata", details: null, path: null };
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		source.emit({ type: "notice", session: pi, handle: h(pi), seq: 2, notice });
		// A later snapshot of the session, such as a GET attach re-sends.
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 0, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [notice] });
		await io.until(4);
		const [first, , second] = io.notifications();
		expect(first).toMatchObject({ method: "session/snapshot", params: { notices: [] } });
		expect(second).toMatchObject({ method: "session/snapshot", params: { session: pi, handle: h(pi), isStreaming: true, notices: [notice] } });
	});

	it("carries the error and notices the server's snapshot holds onto session/snapshot (OW-bipume)", async () => {
		const { io, source } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		const notice = { kind: "configWarning", message: "unknown key", details: null, path: null };
		// Raised before Emacs attached: no `error` or `notice` event reached it.
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 3, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: "turn failed", errorId: "e1", notices: [notice] });
		await io.until(2);

		expect(io.notifications()[0]).toEqual({
			jsonrpc: "2.0",
			method: "session/snapshot",
			params: { session: pi, handle: h(pi), askedFor: pi, nodes: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: "turn failed", errorId: "e1", notices: [notice] },
		});
	});

	it("carries the recorded model a resume could not restore on session/snapshot, and its clearing on session/status (OW-jitoni)", async () => {
		const { io, source } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: "p/fallback", effort: null, unrestoredModel: "p/recorded", error: null, errorId: null, notices: [] });
		source.emit({ type: "status", session: pi, handle: h(pi), seq: 2, isStreaming: false, compaction: null, model: "p/fallback", effort: null, unrestoredModel: null });
		await io.until(3);
		const [snapshot, status] = io.notifications();
		expect(snapshot).toEqual({
			jsonrpc: "2.0",
			method: "session/snapshot",
			params: { session: pi, handle: h(pi), askedFor: pi, nodes: [], isStreaming: false, compaction: null, model: "p/fallback", effort: null, unrestoredModel: "p/recorded", error: null, errorId: null, notices: [] },
		});
		expect(status).toEqual({
			jsonrpc: "2.0",
			method: "session/status",
			params: { session: pi, handle: h(pi), isStreaming: false, compaction: null, model: "p/fallback", effort: null, unrestoredModel: null },
		});
	});

	it("opens the stream before the listing call, so a picker hears sessions/changed with nothing attached (OW-nufafi)", async () => {
		let streamsOpenAtList = -1;
		const { io, source } = start({
			[`GET ${ROUTES.sessions}?cwd=%2Fwork`]: () => {
				streamsOpenAtList = source.opens.length;
				return json({ sessions: [summary(pi)] });
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list", params: { cwd: "/work" } });
		await io.until(1);
		expect(streamsOpenAtList).toBe(1);
		source.emit({ type: "sessions-changed" });
		await io.until(2);
		expect(io.notifications()).toEqual([{ jsonrpc: "2.0", method: "sessions/changed" }]);
	});

	// The events GET and the attach GET are separate connections: an attach
	// sent before the server registered the stream could have its snapshot,
	// and a close's `ended`, broadcast to every client but this one (D26).
	it("sends the first attach's request only once its stream has opened, and a listing asked while that open is pending too (D26)", async () => {
		const { io, source, calls } = start({ ...attachRoutes(pi), [`GET ${ROUTES.sessions}`]: () => json({ sessions: [summary(pi)] }) });
		source.holding = true;
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/list" });
		await tick();
		expect(source.opens).toHaveLength(1);
		expect(calls).toEqual([]);

		source.openHeld();
		await io.until(1);
		expect(new Set(calls.map((call) => `${call.method} ${call.url}`))).toEqual(new Set([`GET ${ROUTES.session(pi)}`, `GET ${ROUTES.sessions}`]));
		expect(source.opens).toHaveLength(1);
	});

	it("exits when the stream it opened for sessions/list drops, and opens it no more (D25)", async () => {
		const { io, source, done } = start({ [`GET ${ROUTES.sessions}`]: () => json({ sessions: [] }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list" });
		await io.until(1);
		expect(source.opens).toHaveLength(1);

		source.opens[0]!.onDisconnect(true);
		expect(await settled(done)).toBe("resolved");
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(source.opens).toHaveLength(1);
	});

	it("exits when the first open of its stream fails, and opens it no more (D25)", async () => {
		const { io, source, done } = start({ [`GET ${ROUTES.sessions}`]: () => json({ sessions: [] }) });
		source.failing = 1;
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list" });

		expect(await settled(done)).toBe("resolved");
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(source.opens).toHaveLength(1);
	});
});

// The server says a handle has ended, under it, where it lets go of it
// (D26); the listing says only which sessions there are, and drops nothing.
describe("a handle's end (D26, OW-likopo)", () => {
	const snapshot = (session: SessionRef, handle: string, seq = 1): ServerEvent => ({
		type: "snapshot",
		session,
		handle,
		seq,
		messages: [],
		isStreaming: false,
		compaction: null,
		model: null,
		effort: null,
		unrestoredModel: null,
		error: null,
		errorId: null,
		notices: [],
	});
	const status = (session: SessionRef, handle: string, seq: number): ServerEvent => ({
		type: "status",
		session,
		handle,
		seq,
		isStreaming: true,
		compaction: null,
		model: null,
		effort: null,
		unrestoredModel: null,
	});
	const methods = (io: ReturnType<typeof stdio>) =>
		io.notifications().map((message) => [message["method"], (message["params"] as { handle?: string } | undefined)?.handle]);

	// A close by another client: the buffer still counts itself attached, so
	// a prompt from it sends no attach, and the prompt route refuses it.
	it("tells Emacs an attachment whose handle ended is detached, though a listing would fail, and says nothing more under it", async () => {
		const { io, source, calls } = start({
			[`GET ${ROUTES.session(pi)}`]: () => json({ session: summary(pi, "h1") }),
			[`GET ${ROUTES.sessions}`]: () => json({ error: "boom" }, 500),
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		source.emit(snapshot(pi, "h1"));
		await io.until(2);

		source.emit({ type: "ended", session: pi, handle: "h1" });
		source.emit({ type: "sessions-changed" });
		await io.until(4);
		source.emit(status(pi, "h1", 2));
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(methods(io)).toEqual([
			["session/snapshot", "h1"],
			["session/detached", "h1"],
			["sessions/changed", undefined],
		]);
		expect(io.notifications()[1]).toEqual({ jsonrpc: "2.0", method: "session/detached", params: { session: pi, handle: "h1" } });
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${ROUTES.session(pi)}`]);
	});

	it("sends no session/detached for an attachment whose handle a listing lacks, with no ended, and goes on forwarding it", async () => {
		const renamed: SessionRef = { backend: "pi", id: "/tmp/renamed.jsonl" };
		const { io, source } = start({
			[`GET ${ROUTES.session(pi)}`]: () => json({ session: summary(pi, "h1") }),
			[`GET ${ROUTES.sessions}`]: () => json({ sessions: [summary(renamed, "h2")] }),
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		source.emit(snapshot(pi, "h1"));
		await io.until(2);

		source.emit({ type: "sessions-changed" });
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/list" });
		await io.until(4);
		await new Promise((resolve) => setTimeout(resolve, 5));
		source.emit(status(pi, "h1", 2));
		await io.until(5);
		expect(methods(io)).toEqual([
			["session/snapshot", "h1"],
			["sessions/changed", undefined],
			["session/status", "h1"],
		]);
	});
});

describe("the node throttle (OW-jeruye)", () => {
	const turn = fixtureMessages().at(-1) as AssistantMessage;
	const user: PaneMessage = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 };
	const said = (text: string) => ({ ...turn, content: [{ type: "text", text }], stopReason: "pending" }) as PaneMessage;
	const statusOf = (isStreaming: boolean) => ({ isStreaming, compaction: null, model: null, effort: null, unrestoredModel: null });
	const nodeOf = (message: Record<string, unknown>) => (message["params"] as { node: TranscriptNode }).node;
	const textOf = (message: Record<string, unknown>) => nodeOf(message).parts.flatMap((part) => (part.type === "text" ? [part.text] : []));

	/** Text whose rendering throws. */
	const unrenderable = "unrenderable";

	/** Attached to `pi`, streaming, a user turn drawn; the interval runs on fake timers from here on, and only what renders after this counts. */
	async function streaming(routes: Record<string, Route> = {}) {
		const rendered: string[] = [];
		const started = start({ ...attachRoutes(pi), ...routes }, (markdown) => {
			if (markdown === unrenderable) throw new Error("render failed");
			rendered.push(markdown);
			return `stub:${markdown}`;
		});
		const { io, source } = started;
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [user], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await io.until(2);
		rendered.length = 0;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let seq = 1;
		const upsert = (index: number, message: PaneMessage) => source.emit({ type: "upsert", session: pi, handle: h(pi), seq: ++seq, index, message });
		const status = (isStreaming: boolean) => source.emit({ type: "status", session: pi, handle: h(pi), seq: ++seq, ...statusOf(isStreaming) });
		/** What went out after the attach reply and the snapshot. */
		const since = () => io.out.slice(2).map((message) => message["method"] ?? message["id"]);
		return { ...started, rendered, upsert, status, since };
	}

	/** Lets a request's handler settle without moving the faked clock. */
	async function settle(): Promise<void> {
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
	}

	it("sends one node for many upserts to it inside an interval, carrying the last, and renders only that one", async () => {
		const { io, rendered, upsert, since } = await streaming();
		upsert(1, said("a"));
		upsert(1, said("ab"));
		upsert(1, said("abc"));
		vi.advanceTimersByTime(250);
		expect(since()).toEqual(["session/node"]);
		expect(textOf(io.out.at(-1)!)).toEqual(["abc"]);
		expect(rendered).toEqual(["abc"]);
	});

	it("holds a tool result's upsert under the call's node it folds into, not its own index", async () => {
		const { io, upsert, since } = await streaming();
		const call = { ...turn, content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], stopReason: "pending" } as PaneMessage;
		const result: PaneMessage = { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "out" }], isError: false, timestamp: 1 };
		upsert(1, call);
		upsert(2, result);
		vi.advanceTimersByTime(250);
		expect(since()).toEqual(["session/node"]);
		const node = nodeOf(io.out.at(-1)!);
		expect(node.index).toBe(1);
		expect(node.parts).toMatchObject([{ type: "tool", name: "bash", result: "out" }]);
	});

	it("sends a held node before it exits at a drop of the stream (D25)", async () => {
		const { io, source, done, upsert, since } = await streaming();
		upsert(1, said("a"));
		upsert(1, said("ab"));
		source.opens[0]!.onDisconnect(true);
		await done;
		expect(since()).toEqual(["session/node"]);
		expect(textOf(io.out.at(-1)!)).toEqual(["ab"]);
	});

	it("sends a held node before the status written after it", async () => {
		const { io, upsert, status, since } = await streaming();
		upsert(1, said("a"));
		upsert(1, said("ab"));
		status(false);
		expect(since()).toEqual(["session/node", "session/status"]);
		expect(textOf(io.out[2]!)).toEqual(["ab"]);
		vi.advanceTimersByTime(250);
		expect(since()).toHaveLength(2);
	});

	it("sends a held node before another node's, each where it was first held, so none is drawn ahead of one before it", async () => {
		const { io, upsert, since } = await streaming();
		upsert(1, said("a"));
		upsert(2, { role: "user", content: [{ type: "text", text: "next" }], timestamp: 2 });
		upsert(1, said("ab"));
		upsert(3, said("c"));
		vi.advanceTimersByTime(250);
		expect(since()).toEqual(["session/node", "session/node", "session/node"]);
		expect(io.out.slice(2).map((message) => nodeOf(message).index)).toEqual([1, 2, 3]);
		expect(textOf(io.out[2]!)).toEqual(["ab"]);
	});

	it("sends a held node before a reply written after it", async () => {
		const { io, upsert, since } = await streaming({ [`POST ${ROUTES.prompt(pi)}`]: noContent });
		upsert(1, said("a"));
		upsert(1, said("ab"));
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/prompt", params: { session: pi, handle: h(pi), text: "more" } });
		await settle();
		expect(since()).toEqual(["session/node", 2]);
		expect(textOf(io.out[2]!)).toEqual(["ab"]);
	});

	it("sends a held node with nothing after it when the interval ends, and not before", async () => {
		const { io, upsert, since } = await streaming();
		upsert(1, said("a"));
		vi.advanceTimersByTime(249);
		expect(since()).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(since()).toEqual(["session/node"]);
		expect(textOf(io.out[2]!)).toEqual(["a"]);
	});

	it("never sends a node held for a session detached before the interval ends", async () => {
		const { io, upsert, since } = await streaming();
		upsert(1, said("a"));
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/detach", params: { session: pi, handle: h(pi) } });
		await settle();
		vi.advanceTimersByTime(250);
		expect(since()).toEqual([2]);
	});

	it("sends a held node before a notification for another attached session", async () => {
		const { io, source } = start({ ...attachRoutes(pi), ...attachRoutes(codex) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: codex } });
		await tick();
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [user], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		source.emit({ type: "snapshot", session: codex, handle: h(codex), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] });
		await io.until(4);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		source.emit({ type: "upsert", session: pi, handle: h(pi), seq: 2, index: 1, message: said("a") });
		source.emit({ type: "status", session: codex, handle: h(codex), seq: 2, ...statusOf(true) });
		expect(io.out.slice(4).map((message) => [message["method"], (message["params"] as { handle: string }).handle])).toEqual([
			["session/node", h(pi)],
			["session/status", h(codex)],
		]);
	});

	it("never sends a node held for a session closed by its ref alone, only the reply", async () => {
		const { io, upsert, since } = await streaming({ [`DELETE ${ROUTES.session(pi)}`]: noContent });
		upsert(1, said("a"));
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/close", params: { session: pi } });
		await settle();
		vi.advanceTimersByTime(250);
		expect(since()).toEqual([2]);
	});

	it("skips a held node whose rendering throws when the interval ends, and sends the nodes held around it (OW-vejeka)", async () => {
		const { io, upsert, since } = await streaming();
		upsert(1, said("a"));
		upsert(2, { role: "user", content: [{ type: "text", text: unrenderable }], timestamp: 2 });
		upsert(3, said("c"));
		vi.advanceTimersByTime(250);
		expect(since()).toEqual(["session/node", "session/node"]);
		expect(io.out.slice(2).map((message) => nodeOf(message).index)).toEqual([1, 3]);
	});

	it("skips a held node whose rendering throws before a reply, which still answers its result (OW-vejeka)", async () => {
		const { io, upsert, since } = await streaming({ [`POST ${ROUTES.prompt(pi)}`]: noContent });
		upsert(1, said(unrenderable));
		upsert(2, { role: "user", content: [{ type: "text", text: "next" }], timestamp: 2 });
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/prompt", params: { session: pi, handle: h(pi), text: "more" } });
		await settle();
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: null });
		expect(since()).toEqual(["session/node", 2]);
		expect(nodeOf(io.out[2]!).index).toBe(2);
	});

	it("drops a held node when the input ends, and resolves without waiting out the interval", async () => {
		const { io, done, upsert, since } = await streaming();
		upsert(1, said("a"));
		io.end();
		await done;
		stop = null;
		vi.advanceTimersByTime(250);
		expect(since()).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("the handle (D24, OW-suyinu)", () => {
	const handle = "h1";
	const snapshotOf = (session: SessionRef, seq: number): ServerEvent => ({
		type: "snapshot",
		session,
		handle,
		seq,
		messages: [],
		isStreaming: false,
		compaction: null,
		model: null,
		effort: null,
		unrestoredModel: null,
		error: null,
		errorId: null,
		notices: [],
	});

	it("rides every per-session notification, taken from the event it answers", async () => {
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start({ [`GET ${ROUTES.session(virtual)}`]: () => json({ session: { ...summary(virtual), handle } }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual } });
		await tick();
		source.emit(snapshotOf(virtual, 1));
		source.emit(snapshotOf(pi, 0));
		source.emit({ type: "upsert", session: pi, handle, seq: 1, index: 0, message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 } });
		source.emit({ type: "status", session: pi, handle, seq: 2, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		source.emit({ type: "error", session: pi, handle, seq: 3, message: "boom", errorId: "e1" });
		source.emit({ type: "notice", session: pi, handle, seq: 4, notice: { kind: "warning", message: "careful", details: null, path: null } });
		source.emit({ type: "error-cleared", session: pi, handle, seq: 5 });
		source.emit({ type: "sessions-changed" });
		await io.until(9);

		const perSession = io.notifications().filter((message) => message["method"] !== "sessions/changed");
		expect(perSession.map((message) => message["method"])).toEqual([
			"session/snapshot",
			"session/snapshot",
			"session/node",
			"session/status",
			"session/error",
			"session/notice",
			"session/errorCleared",
		]);
		for (const message of perSession) expect(message["params"]).toMatchObject({ handle });
	});

	it("rides the summary sessions/attach answers, and the snapshot it sends before the reply for a ref the stream never named", async () => {
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start({
			[`GET ${ROUTES.session(alias)}`]: () => {
				source.emit(snapshotOf(pi, 1));
				return json({ session: { ...summary(pi), handle } });
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: alias } });
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 1]);
		expect(io.out[0]).toMatchObject({ params: { session: pi, handle, askedFor: alias } });
		expect(io.response(1)).toEqual({ jsonrpc: "2.0", id: 1, result: { ...summary(pi), handle } });
	});

	it("accepts the handle beside the session on a request, and forwards it into no HTTP body", async () => {
		const { io, calls } = start({
			[`POST ${ROUTES.prompt(pi)}`]: noContent,
			[`POST ${ROUTES.fork(pi)}`]: () => json({ ref: codex }),
			[`POST ${ROUTES.model(pi)}`]: noContent,
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/prompt", params: { session: pi, handle, text: "hello" } });
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/fork", params: { session: pi, handle, entryId: "e1" } });
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/setModel", params: { session: pi, handle, model: "m" } });
		await io.until(3);

		expect(calls.find((call) => call.url === ROUTES.prompt(pi))?.body).toEqual({ text: "hello" });
		expect(calls.find((call) => call.url === ROUTES.fork(pi))?.body).toEqual({ entryId: "e1" });
		expect(calls.find((call) => call.url === ROUTES.model(pi))?.body).toEqual({ model: "m" });
	});
});

describe("shutdown", () => {
	it("closes the stream and resolves when the input ends", async () => {
		const { io, source, done } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await tick();
		io.end();
		await done;
		expect(source.closed).toEqual([0]);
		stop = null;
	});

	/** Routes whose listing never answers: the call settles only if its signal fires, and each signal is kept. */
	const unanswered = (signals: (AbortSignal | null | undefined)[]): Record<string, Route> => ({
		[`GET ${ROUTES.sessions}`]: (_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				signals.push(init?.signal);
				init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
			}),
	});

	it("aborts a request still waiting on the server when the input ends, and writes no reply for it (OW-hiliti)", async () => {
		const signals: (AbortSignal | null | undefined)[] = [];
		const { io, calls, done } = start(unanswered(signals));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list" });
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		io.end();
		await done;
		stop = null;
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(true);
		await tick();
		expect(io.response(1)).toBeUndefined();
	});

	it("aborts a request still waiting on the server when the stream drops, and writes no reply for it (OW-hiliti)", async () => {
		const signals: (AbortSignal | null | undefined)[] = [];
		const { io, source, calls, done } = start(unanswered(signals));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list" });
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		source.opens[0]!.onDisconnect(true);
		expect(await settled(done)).toBe("resolved");
		stop = null;
		expect(signals[0]?.aborted).toBe(true);
		await tick();
		expect(io.response(1)).toBeUndefined();
	});
});
