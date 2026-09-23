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
import type { TranscriptNode } from "./protocol.ts";

const render = (markdown: string): string => `stub:${markdown}`;

const pi: SessionRef = { backend: "pi", id: "/tmp/a.jsonl" };
const codex: SessionRef = { backend: "codex", id: "thread-1" };

function summary(ref: SessionRef): SessionSummary {
	return { ref, cwd: "/work", preview: null, createdAt: null, updatedAt: null, status: "attached", isStreaming: false };
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
	await stop?.();
	stop = null;
});

function start(routes: Record<string, Route>, reconnectDelayMs = 0) {
	const io = stdio();
	const source = eventSource();
	const { fetch, calls } = fetchFor(routes);
	const done = runHelper({ input: io.input, write: io.write, fetch, openEvents: source.openEvents, render, reconnectDelayMs });
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
	});

	it("carries a server rejection through as a JSON-RPC error with the server's text", async () => {
		const { io } = start({
			[`POST ${ROUTES.prompt(pi)}`]: () => json({ error: "turn_active", detail: "a turn is already running" }, 409),
		});
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/prompt", params: { session: pi, text: "again" } });
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
	it("opens the stream before the attach call, then yields one snapshot and one node per upsert, in order", async () => {
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

		source.emit({ type: "snapshot", session: codex, seq: 1, messages: messages.slice(0, tail), isStreaming: true, compaction: null, model: "m", effort: null });
		const partial = { ...final, content: [{ type: "text", text: "par" }], stopReason: "pending" } as PaneMessage;
		source.emit({ type: "upsert", session: codex, seq: 2, index: tail, message: partial });
		source.emit({ type: "upsert", session: codex, seq: 3, index: tail, message: final });
		await io.until(4);
		const [snapshot, first, second] = io.notifications();
		expect(snapshot).toMatchObject({ method: "session/snapshot", params: { session: codex, isStreaming: true, compaction: null, model: "m" } });
		expect((snapshot!["params"] as { nodes: TranscriptNode[] }).nodes.map((node) => node.index)).toEqual(
			messages.slice(0, tail).map((_, index) => index),
		);
		expect(first).toMatchObject({ method: "session/node", params: { session: codex, node: { index: tail, role: "assistant" } } });
		expect(second).toMatchObject({ method: "session/node", params: { session: codex, node: { index: tail, role: "assistant" } } });
		const firstText = (first!["params"] as { node: TranscriptNode }).node.parts[0];
		expect(firstText).toEqual({ type: "text", text: "par", html: "stub:par" });
		expect(io.notifications()).toHaveLength(3);
	});

	it("heals a seq gap by attaching again, and the snapshot that follows is a fresh session/snapshot", async () => {
		const { io, source, calls } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await io.until(1);
		source.emit({ type: "snapshot", session: pi, seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null });
		await io.until(2);
		expect(calls).toHaveLength(1);

		source.emit({ type: "status", session: pi, seq: 5, isStreaming: true, compaction: null, model: null, effort: null });
		await vi.waitFor(() => expect(calls).toHaveLength(2));
		expect(calls[1]).toMatchObject({ url: ROUTES.session(pi), method: "GET" });
		expect(io.notifications()).toHaveLength(1);

		source.emit({ type: "snapshot", session: pi, seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null });
		await io.until(3);
		expect(io.notifications()[1]).toMatchObject({ method: "session/snapshot", params: { session: pi, isStreaming: true } });
	});

	it("says nothing for a session Emacs never attached, and nothing more after sessions/close", async () => {
		const { io, source } = start({ ...attachRoutes(pi), [`DELETE ${ROUTES.session(pi)}`]: noContent });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await io.until(1);
		source.emit({ type: "snapshot", session: codex, seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null });
		source.emit({ type: "status", session: codex, seq: 2, isStreaming: true, compaction: null, model: null, effort: null });
		source.emit({ type: "snapshot", session: pi, seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null });
		await io.until(2);
		expect(io.notifications()).toEqual([
			{ jsonrpc: "2.0", method: "session/snapshot", params: { session: pi, nodes: [], isStreaming: false, compaction: null, model: null, effort: null } },
		]);

		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/close", params: { session: pi } });
		await io.until(3);
		source.emit({ type: "status", session: pi, seq: 2, isStreaming: true, compaction: null, model: null, effort: null });
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
		source.emit({ type: "snapshot", session: codex, seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null });

		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/attach", params: { session: alias } });
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/detach", params: { session: alias } });
		await io.until(3);
		release();
		await io.until(4);
		source.emit({ type: "snapshot", session: pi, seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null });
		source.emit({ type: "snapshot", session: alias, seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.notifications()).toEqual([]);
		expect(calls.map((call) => call.url)).toEqual([ROUTES.session(codex), ROUTES.session(alias)]);
	});

	it("re-keys on renamed and says so before the snapshot that follows", async () => {
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start(attachRoutes(virtual));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual } });
		await io.until(1);
		source.emit({ type: "snapshot", session: virtual, seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null });
		source.emit({ type: "renamed", session: pi, seq: 2, from: virtual });
		source.emit({ type: "snapshot", session: pi, seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null });
		await io.until(4);
		expect(io.notifications().map((message) => message["method"])).toEqual(["session/snapshot", "session/renamed", "session/snapshot"]);
		expect(io.notifications()[1]).toEqual({ jsonrpc: "2.0", method: "session/renamed", params: { from: virtual, to: pi } });
		expect(io.notifications()[2]).toMatchObject({ params: { session: pi, isStreaming: true } });
	});

	it("says the rename an attach reply reveals with no renamed event, with the snapshot it dropped, before the reply", async () => {
		// An attach through an alias: the route answers the new ref and
		// broadcasts only its snapshot, which lands before the reply.
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start({
			[`GET ${ROUTES.session(alias)}`]: () => {
				source.emit({ type: "snapshot", session: pi, seq: 1, messages: [], isStreaming: true, compaction: null, model: null, effort: null });
				return json({ session: summary(pi) });
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: alias } });
		await io.until(3);
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/renamed", "session/snapshot", 1]);
		expect(io.out[0]).toEqual({ jsonrpc: "2.0", method: "session/renamed", params: { from: alias, to: pi } });
		expect(io.out[1]).toMatchObject({ params: { session: pi, isStreaming: true } });

		source.emit({ type: "status", session: pi, seq: 2, isStreaming: false, compaction: null, model: null, effort: null });
		await io.until(4);
		expect(io.out[3]).toMatchObject({ method: "session/status", params: { session: pi, isStreaming: false } });
	});

	it("says a rename the stream already carried once, when the attach reply repeats it", async () => {
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, source } = start({
			[`GET ${ROUTES.session(virtual)}`]: () => {
				source.emit({ type: "snapshot", session: virtual, seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null });
				source.emit({ type: "renamed", session: pi, seq: 2, from: virtual });
				return json({ session: summary(pi) });
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual } });
		await io.until(3);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", "session/renamed", 1]);
	});

	it("passes status and error through, and turns an agent request into an error naming its kind", async () => {
		const { io, source } = start(attachRoutes(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi } });
		await io.until(1);
		source.emit({ type: "snapshot", session: pi, seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null });
		source.emit({ type: "status", session: pi, seq: 2, isStreaming: true, compaction: "running", model: "m", effort: "low" });
		source.emit({ type: "error", session: pi, seq: 3, message: "boom" });
		source.emit({ type: "request", session: pi, seq: 4, request: { requestId: "r1", session: pi, kind: "item/fileChange/requestApproval", payload: {} } });
		await io.until(5);
		const [, status, error, request] = io.notifications();
		expect(status).toEqual({ jsonrpc: "2.0", method: "session/status", params: { session: pi, isStreaming: true, compaction: "running", model: "m", effort: "low" } });
		expect(error).toEqual({ jsonrpc: "2.0", method: "session/error", params: { session: pi, message: "boom" } });
		expect(request).toMatchObject({ method: "session/error", params: { session: pi, message: expect.stringContaining("item/fileChange/requestApproval") } });
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
