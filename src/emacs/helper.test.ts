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
		end() {
			controller.close();
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

/** The server's event stream, scripted: every open captures the handlers so the test can push events. */
function eventSource() {
	const opens: EventHandlers[] = [];
	const closed: number[] = [];
	return {
		opens,
		closed,
		openEvents: (_url: string, handlers: EventHandlers) => {
			const index = opens.push(handlers) - 1;
			queueMicrotask(() => handlers.onOpen());
			return { close: () => void closed.push(index) };
		},
		emit(event: ServerEvent) {
			opens.at(-1)!.onEvent(event);
		},
	};
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

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noContent = () => new Response(null, { status: 204 });

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
	vi.useRealTimers();
	await stop?.();
	stop = null;
});

function start(routes: Record<string, Route>, reconnectDelayMs = 0, renderMarkdown: Render = render) {
	const io = stdio();
	const source = eventSource();
	const { fetch, calls } = fetchFor(routes);
	const done = runHelper({ input: io.input, write: io.write, fetch, openEvents: source.openEvents, render: renderMarkdown, reconnectDelayMs });
	stop = async () => {
		io.end();
		await done;
	};
	return { io, source, calls, done };
}

describe("requests", () => {
	it("lists sessions through the listing route and answers the summaries", async () => {
		const { io, source, calls } = start({ [`GET ${ROUTES.sessions}?cwd=%2Fwork`]: () => json({ sessions: [summary(pi)] }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list", params: { cwd: "/work" } });
		await io.until(1);
		expect(io.response(1)).toEqual({ jsonrpc: "2.0", id: 1, result: [summary(pi)] });
		expect(calls).toHaveLength(1);
		expect(source.opens).toHaveLength(0);
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
			[`POST ${ROUTES.reply("req-1")}`]: noContent,
			[`DELETE ${ROUTES.error(pi)}`]: noContent,
		});
		const requests = [
			["sessions/create", { cwd: "/work", backend: "pi" }, pi],
			["models/list", { backend: "pi" }, [model]],
			["sessions/prompt", { session: pi, text: "hello" }, null],
			["sessions/abort", { session: pi }, null],
			["sessions/compact", { session: pi }, null],
			["sessions/close", { session: pi }, null],
			["sessions/setModel", { session: pi, model: "m" }, null],
			["sessions/setEffort", { session: pi, effort: "low" }, null],
			["sessions/forkPoints", { session: pi }, [{ id: "e1", text: "hi", index: 0 }]],
			["sessions/fork", { session: pi, entryId: "e1" }, codex],
			["requests/reply", { requestId: "req-1", response: { decision: "accept" } }, null],
			["sessions/dismissError", { session: pi, message: "boom" }, null],
		] as const;
		requests.forEach(([method, params], index) => io.send({ jsonrpc: "2.0", id: index + 10, method, params }));
		await io.until(requests.length);
		requests.forEach(([, , result], index) => {
			expect(io.response(index + 10)).toEqual({ jsonrpc: "2.0", id: index + 10, result });
		});
		expect(calls.find((call) => call.url === ROUTES.prompt(pi))?.body).toEqual({ text: "hello" });
		expect(calls.find((call) => call.url === ROUTES.model(pi))?.body).toEqual({ model: "m" });
		expect(calls.find((call) => call.url === ROUTES.effort(pi))?.body).toEqual({ effort: "low" });
		expect(calls.find((call) => call.url === ROUTES.fork(pi))?.body).toEqual({ entryId: "e1" });
		expect(calls.find((call) => call.url === ROUTES.reply("req-1"))?.body).toEqual({
			requestId: "req-1",
			response: { decision: "accept" },
		});
		// Named, so the server clears it only while it is still the one held (OW-desufa).
		expect(calls.find((call) => call.url === ROUTES.error(pi))?.body).toEqual({ message: "boom" });
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
		await io.until(1);
		expect(io.response(1)).toEqual({ jsonrpc: "2.0", id: 1, result: summary(codex) });
		expect(streamsOpenAtAttach).toBe(1);
		expect(calls).toHaveLength(1);

		source.emit({ type: "snapshot", session: codex, handle: h(codex), seq: 1, messages: messages.slice(0, tail), isStreaming: true, compaction: null, model: "m", effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		await io.until(2);
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

	it("heals a seq gap by attaching again, and the snapshot that follows is a fresh session/snapshot", async () => {
		const { io, source, calls } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await io.until(1);
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		await io.until(2);
		expect(calls).toHaveLength(1);

		source.emit({ type: "status", session: pi, handle: h(pi), seq: 5, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await vi.waitFor(() => expect(calls).toHaveLength(2));
		expect(calls[1]).toMatchObject({ url: ROUTES.session(pi), method: "GET" });
		expect(io.notifications()).toHaveLength(1);

		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		await io.until(3);
		expect(io.notifications()[1]).toMatchObject({ method: "session/snapshot", params: { session: pi, handle: h(pi), isStreaming: true } });
	});

	it("says nothing for a session Emacs never attached, and nothing more after sessions/close", async () => {
		const { io, source } = start({ ...attachRoutes(pi), [`DELETE ${ROUTES.session(pi)}`]: noContent });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await io.until(1);
		source.emit({ type: "snapshot", session: codex, handle: h(codex), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		source.emit({ type: "status", session: codex, handle: h(codex), seq: 2, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		await io.until(2);
		expect(io.notifications()).toEqual([
			{ jsonrpc: "2.0", method: "session/snapshot", params: { session: pi, handle: h(pi), nodes: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] } },
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
		await io.until(1);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/detach", params: { session: codex } });
		await io.until(2);
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: null });
		source.emit({ type: "snapshot", session: codex, handle: h(codex), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });

		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/attach", params: { session: alias } });
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/detach", params: { session: alias } });
		await io.until(3);
		release();
		await io.until(4);
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		source.emit({ type: "snapshot", session: alias, handle: h(alias), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.notifications()).toEqual([]);
		expect(calls.map((call) => call.url)).toEqual([ROUTES.session(codex), ROUTES.session(alias)]);
	});

	it("forwards the snapshot under the handle that names a rename, and nothing beside it", async () => {
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start(attachRoutes(virtual));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual } });
		await io.until(1);
		source.emit({ type: "snapshot", session: virtual, handle: h(virtual), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		source.emit({ type: "snapshot", session: pi, handle: h(virtual), seq: 0, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		await io.until(3);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.notifications().map((message) => message["method"])).toEqual(["session/snapshot", "session/snapshot"]);
		expect(io.notifications()[1]).toMatchObject({ params: { session: pi, handle: h(virtual), isStreaming: true } });
	});

	it("stops on a sessions/detach by the ref a snapshot under the handle told Emacs", async () => {
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start(attachRoutes(virtual));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual } });
		await io.until(1);
		source.emit({ type: "snapshot", session: virtual, handle: h(virtual), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		source.emit({ type: "snapshot", session: pi, handle: h(virtual), seq: 0, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
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
		await io.until(1);
		source.emit({ type: "snapshot", session: virtual, handle: h(virtual), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		source.emit({ type: "snapshot", session: pi, handle: h(virtual), seq: 0, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
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
		await io.until(1);
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi } });
		await io.until(3);
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
				source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
				return json({ session: summary(pi) });
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: alias } });
		await io.until(2);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 1]);
		expect(io.out[0]).toMatchObject({ params: { session: pi, handle: h(pi), isStreaming: true, askedFor: alias } });
		expect(io.out[1]).toMatchObject({ id: 1, result: { ref: pi, handle: h(pi) } });

		source.emit({ type: "status", session: pi, handle: h(pi), seq: 2, isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null });
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 0, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		await io.until(4);
		expect(io.out[2]).toMatchObject({ method: "session/status", params: { session: pi, handle: h(pi), isStreaming: false } });
		// The tag rides that one snapshot and nothing after it.
		expect(io.out.slice(2).filter((message) => "askedFor" in (message["params"] as object))).toEqual([]);
	});

	it("tags the late snapshot of an attach answered under another ref when none had arrived by the reply, and nothing after it", async () => {
		// Until a snapshot introduces the view the reducer holds nothing under
		// the handle, and forwards nothing: every other event for a view it does
		// not hold leaves the state as it was. So the first thing sent under the
		// handle is that snapshot.
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start({ [`GET ${ROUTES.session(alias)}`]: () => json({ session: summary(pi) }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: alias } });
		await io.until(1);
		expect(io.out[0]).toMatchObject({ id: 1, result: { ref: pi, handle: h(pi) } });

		source.emit({ type: "status", session: pi, handle: h(pi), seq: 1, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 0, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		source.emit({ type: "status", session: pi, handle: h(pi), seq: 1, isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null });
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 0, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		await io.until(4);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.out.map((message) => [message["method"] ?? message["id"], (message["params"] as { askedFor?: SessionRef } | undefined)?.askedFor])).toEqual([
			[1, undefined],
			["session/snapshot", alias],
			["session/status", undefined],
			["session/snapshot", undefined],
		]);
	});

	it("tags nothing for an attach of an alias whose handle another attach already holds, so its detach by that alias leaves the other fed", async () => {
		// B attaches the canonical ref and A an alias of the same session; both
		// replies land before the session's snapshot, and A is killed before it.
		// The buffer holding the canonical ref takes what follows, and A's reply,
		// had it been handled, would have merged A into it.
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start({
			[`GET ${ROUTES.session(alias)}`]: () => json({ session: summary(pi) }),
			[`GET ${ROUTES.session(pi)}`]: () => json({ session: summary(pi) }),
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await io.until(1);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: alias } });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/detach", params: { session: alias } });
		await io.until(3);
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 0, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		source.emit({ type: "status", session: pi, handle: h(pi), seq: 1, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await io.until(5);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual([1, 2, 3, "session/snapshot", "session/status"]);
		expect(io.notifications().filter((message) => "askedFor" in (message["params"] as object))).toEqual([]);
	});

	it("stops on a sessions/detach by the ref asked for, from a buffer killed before the snapshot that would have named the handle", async () => {
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start({ [`GET ${ROUTES.session(alias)}`]: () => json({ session: summary(pi) }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: alias } });
		await io.until(1);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/detach", params: { session: alias } });
		await io.until(2);
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 0, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.notifications()).toEqual([]);
	});

	it("sends no second snapshot for an attach the stream already moved onto its handle, when the reply names another ref", async () => {
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start({
			[`GET ${ROUTES.session(virtual)}`]: () => {
				source.emit({ type: "snapshot", session: virtual, handle: h(virtual), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
				source.emit({ type: "snapshot", session: pi, handle: h(virtual), seq: 0, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
				return json({ session: summary(pi, h(virtual)) });
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual } });
		await io.until(3);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", "session/snapshot", 1]);
		expect(io.notifications().filter((message) => "askedFor" in (message["params"] as object))).toEqual([]);
	});

	// On main the attached set was keyed by ref, so a session Emacs had attached
	// kept being forwarded whatever the server did under that ref. Under the
	// handle, a snapshot introducing that ref under a new handle -- a restarted
	// server's, or one another client's re-attach minted -- carries it over.
	it("keeps forwarding a session Emacs attached when a snapshot brings its ref under a new handle", async () => {
		const { io, source } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await io.until(1);
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		source.emit({ type: "snapshot", session: pi, handle: "h-restarted", seq: 0, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		source.emit({ type: "status", session: pi, handle: "h-restarted", seq: 1, isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null });
		await io.until(4);
		expect(io.notifications().map((message) => [message["method"], (message["params"] as { handle?: string }).handle])).toEqual([
			["session/snapshot", h(pi)],
			["session/snapshot", "h-restarted"],
			["session/status", "h-restarted"],
		]);

		// And a detach by that ref still stops it.
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/detach", params: { session: pi } });
		await io.until(5);
		source.emit({ type: "status", session: pi, handle: "h-restarted", seq: 2, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.notifications()).toHaveLength(3);
	});

	it("passes status, error and an agent request through", async () => {
		const { io, source } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await io.until(1);
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		source.emit({ type: "status", session: pi, handle: h(pi), seq: 2, isStreaming: true, compaction: "running", model: "m", effort: "low", unrestoredModel: null });
		source.emit({ type: "error", session: pi, handle: h(pi), seq: 3, message: "boom" });
		source.emit({ type: "request", session: pi, handle: h(pi), seq: 4, request: { requestId: "r1", session: pi, kind: "item/fileChange/requestApproval", payload: {} } });
		await io.until(5);
		const [, status, error, request] = io.notifications();
		expect(status).toEqual({ jsonrpc: "2.0", method: "session/status", params: { session: pi, handle: h(pi), isStreaming: true, compaction: "running", model: "m", effort: "low", unrestoredModel: null } });
		expect(error).toEqual({ jsonrpc: "2.0", method: "session/error", params: { session: pi, handle: h(pi), message: "boom" } });
		expect(request).toEqual({
			jsonrpc: "2.0",
			method: "session/request",
			params: { session: pi, handle: h(pi), request: { requestId: "r1", session: pi, kind: "item/fileChange/requestApproval", payload: {} } },
		});
	});

	it("passes a request's retraction through as session/requestResolved (OW-gusifo)", async () => {
		const { io, source } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await io.until(1);
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		source.emit({ type: "request", session: pi, handle: h(pi), seq: 2, request: { requestId: "r1", session: pi, kind: "item/fileChange/requestApproval", payload: {} } });
		source.emit({ type: "request-resolved", session: pi, handle: h(pi), seq: 3, requestId: "r1" });
		await io.until(4);
		const [, , resolved] = io.notifications();
		expect(resolved).toEqual({ jsonrpc: "2.0", method: "session/requestResolved", params: { session: pi, handle: h(pi), requestId: "r1" } });
	});

	it("passes a notice through as session/notice, not session/error (OW-tujiya)", async () => {
		const { io, source } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await io.until(1);
		const notice = { kind: "configWarning", message: "unknown key", details: "see the docs", path: "/c.toml:3:5" };
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		source.emit({ type: "notice", session: pi, handle: h(pi), seq: 2, notice });
		await io.until(3);
		const [, noticed] = io.notifications();
		expect(noticed).toEqual({ jsonrpc: "2.0", method: "session/notice", params: { session: pi, handle: h(pi), notice } });
	});

	it("carries the notices the server's snapshot holds on every later session/snapshot (OW-tujiya, OW-bipume)", async () => {
		const { io, source } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await io.until(1);
		const notice = { kind: "warning", message: "fallback metadata", details: null, path: null };
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
		source.emit({ type: "notice", session: pi, handle: h(pi), seq: 2, notice });
		// A Codex turn's start or end re-snapshots the session (`#onUpdate` with no index).
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 0, messages: [], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [notice] });
		await io.until(4);
		const [first, , second] = io.notifications();
		expect(first).toMatchObject({ method: "session/snapshot", params: { notices: [] } });
		expect(second).toMatchObject({ method: "session/snapshot", params: { session: pi, handle: h(pi), isStreaming: true, notices: [notice] } });
	});

	it("carries the error, pending requests and notices the server's snapshot holds onto session/snapshot (OW-bipume)", async () => {
		const { io, source } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await io.until(1);
		const request = { requestId: "r1", session: pi, kind: "item/fileChange/requestApproval", payload: {} };
		const notice = { kind: "configWarning", message: "unknown key", details: null, path: null };
		// Raised before Emacs attached: no `error`, `request` or `notice` event reached it.
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 3, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: "turn failed", requests: [request], notices: [notice] });
		await io.until(2);

		expect(io.notifications()[0]).toEqual({
			jsonrpc: "2.0",
			method: "session/snapshot",
			params: { session: pi, handle: h(pi), nodes: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: "turn failed", requests: [request], notices: [notice] },
		});
	});

	it("carries the recorded model a resume could not restore on session/snapshot, and its clearing on session/status (OW-jitoni)", async () => {
		const { io, source } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await io.until(1);
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [], isStreaming: false, compaction: null, model: "p/fallback", effort: null, unrestoredModel: "p/recorded", error: null, requests: [], notices: [] });
		source.emit({ type: "status", session: pi, handle: h(pi), seq: 2, isStreaming: false, compaction: null, model: "p/fallback", effort: null, unrestoredModel: null });
		await io.until(3);
		const [snapshot, status] = io.notifications();
		expect(snapshot).toEqual({
			jsonrpc: "2.0",
			method: "session/snapshot",
			params: { session: pi, handle: h(pi), nodes: [], isStreaming: false, compaction: null, model: "p/fallback", effort: null, unrestoredModel: "p/recorded", error: null, requests: [], notices: [] },
		});
		expect(status).toEqual({
			jsonrpc: "2.0",
			method: "session/status",
			params: { session: pi, handle: h(pi), isStreaming: false, compaction: null, model: "p/fallback", effort: null, unrestoredModel: null },
		});
	});

	it("relays sessions-changed, and reopens a dropped stream with a sessions/changed after every reopen", async () => {
		const { io, source } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await io.until(1);
		source.emit({ type: "sessions-changed" });
		await io.until(2);
		expect(io.notifications()).toEqual([{ jsonrpc: "2.0", method: "sessions/changed" }]);

		source.opens[0]!.onDisconnect(true);
		await vi.waitFor(() => expect(source.opens).toHaveLength(2));
		await io.until(3);
		expect(io.notifications()[1]).toEqual({ jsonrpc: "2.0", method: "sessions/changed" });
		expect(source.closed).toEqual([0]);
	});
});

describe("the node throttle (OW-jeruye)", () => {
	const turn = fixtureMessages().at(-1) as AssistantMessage;
	const user: PaneMessage = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 };
	const said = (text: string) => ({ ...turn, content: [{ type: "text", text }], stopReason: "pending" }) as PaneMessage;
	const statusOf = (isStreaming: boolean) => ({ isStreaming, compaction: null, model: null, effort: null, unrestoredModel: null });
	const nodeOf = (message: Record<string, unknown>) => (message["params"] as { node: TranscriptNode }).node;
	const textOf = (message: Record<string, unknown>) => nodeOf(message).parts.flatMap((part) => (part.type === "text" ? [part.text] : []));

	/** Attached to `pi`, streaming, a user turn drawn; the interval runs on fake timers from here on, and only what renders after this counts. */
	async function streaming(routes: Record<string, Route> = {}) {
		const rendered: string[] = [];
		const started = start({ ...attachRoutes(pi), ...routes }, 0, (markdown) => {
			rendered.push(markdown);
			return `stub:${markdown}`;
		});
		const { io, source } = started;
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await io.until(1);
		source.emit({ type: "snapshot", session: pi, handle: h(pi), seq: 1, messages: [user], isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, requests: [], notices: [] });
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
		requests: [],
		notices: [],
	});

	it("rides every per-session notification, taken from the event it answers", async () => {
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start({ [`GET ${ROUTES.session(virtual)}`]: () => json({ session: { ...summary(virtual), handle } }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual } });
		await io.until(1);
		const request = { requestId: "r1", session: pi, kind: "item/fileChange/requestApproval", payload: {} };
		source.emit(snapshotOf(virtual, 1));
		source.emit(snapshotOf(pi, 0));
		source.emit({ type: "upsert", session: pi, handle, seq: 1, index: 0, message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 } });
		source.emit({ type: "status", session: pi, handle, seq: 2, isStreaming: true, compaction: null, model: null, effort: null, unrestoredModel: null });
		source.emit({ type: "error", session: pi, handle, seq: 3, message: "boom" });
		source.emit({ type: "notice", session: pi, handle, seq: 4, notice: { kind: "warning", message: "careful", details: null, path: null } });
		source.emit({ type: "request", session: pi, handle, seq: 5, request });
		source.emit({ type: "request-resolved", session: pi, handle, seq: 6, requestId: "r1" });
		source.emit({ type: "sessions-changed" });
		await io.until(10);

		const perSession = io.notifications().filter((message) => message["method"] !== "sessions/changed");
		expect(perSession.map((message) => message["method"])).toEqual([
			"session/snapshot",
			"session/snapshot",
			"session/node",
			"session/status",
			"session/error",
			"session/notice",
			"session/request",
			"session/requestResolved",
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
		await io.until(2);
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
		await io.until(1);
		io.end();
		await done;
		expect(source.closed).toEqual([0]);
		stop = null;
	});

	it("aborts a request still waiting on the server when the input ends, and answers it with the abort", async () => {
		// A server that never answers: the call settles only if its signal fires.
		const signals: (AbortSignal | null | undefined)[] = [];
		const { io, calls, done } = start({
			[`GET ${ROUTES.sessions}`]: (_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					signals.push(init?.signal);
					init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
				}),
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list" });
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		io.end();
		await done;
		stop = null;
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(true);
		await io.until(1);
		expect(io.response(1)!["error"]).toMatchObject({ code: -32603 });
	});
});
