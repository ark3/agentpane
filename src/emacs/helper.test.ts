/**
 * The stdio loop, driven in node against a scripted socket server
 * (OW-refibu, D31). Structure only: which commands reach the server, which
 * notifications come out and in what order -- never model wording.
 *
 * The script answers each command as the server does, writing what the
 * command caused before its reply (D31 point 3): an attach's script emits the
 * session's snapshot, then returns.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ApiClientError } from "$client/api.ts";
import { FakeSocket, socketServer, type Script, type SocketServer } from "$client/test-support.ts";
import { CodexReducer } from "$server/adapters/codex/reducer.ts";
import { readFixture } from "$server/adapters/codex/test-support.ts";
import { SOCKET_CLOSE, SOCKET_PATH, type PaneMessage, type ServerEvent, type SessionRef, type LiveSessionSummary } from "$shared/protocol.ts";
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

function summary(ref: SessionRef, handle = h(ref)): LiveSessionSummary {
	return { ref, cwd: "/work", preview: null, createdAt: null, updatedAt: null, status: "attached", isStreaming: false, onDisk: true, name: null, handle };
}

function snapshot(session: SessionRef, handle = h(session), overrides: Partial<Extract<ServerEvent, { type: "snapshot" }>> = {}): ServerEvent {
	return { type: "snapshot", session, handle, seq: 1, messages: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [], ...overrides };
}

function status(session: SessionRef, handle: string, seq: number, isStreaming = true): ServerEvent {
	return { type: "status", session, handle, seq, isStreaming, compaction: null, model: null, effort: null, unrestoredModel: null };
}

function fixtureMessages(): PaneMessage[] {
	const reducer = new CodexReducer({ now: () => 1_000 });
	for (const line of readFixture("text")) reducer.handle(line);
	return reducer.getState().messages;
}

/**
 * Emacs's end of the pipe: frames pushed in, frames decoded out. A bound
 * view's `session/forkPoints` is left out unless `forkPoints` asks for it:
 * the helper sends one after every snapshot and at every streaming edge (D33
 * point 4), and only the tests of that are about it.
 */
function stdio(forkPoints = false) {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const input = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
	const out: Record<string, unknown>[] = [];
	const decoder = new FrameDecoder();
	return {
		input,
		write: (frame: Uint8Array) => {
			for (const message of decoder.push(frame) as Record<string, unknown>[]) {
				if (forkPoints || message["method"] !== "session/forkPoints") out.push(message);
			}
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

/** Let the helper take what was just sent, and the server answer what it can. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Whether `promise` settles within 50ms, so a helper that never exits fails its test rather than timing it out. */
function settled(promise: Promise<unknown>): Promise<"resolved" | "pending"> {
	return Promise.race([promise.then(() => "resolved" as const), new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50))]);
}

function held() {
	let release!: () => void;
	const hold = new Promise<void>((resolve) => (release = resolve));
	return { hold, release };
}

/** An attach's script: each call in turn emits its summary's snapshot, after its hold if it has one, and answers the summary. */
function attaching(...replies: { summary: LiveSessionSummary; hold?: Promise<void> }[]): NonNullable<Script["sessions/attach"]> {
	return async (_params, server) => {
		const { summary: reply, hold } = replies.length > 1 ? replies.shift()! : replies[0]!;
		await hold;
		server.emit(snapshot(reply.ref, reply.handle));
		return { session: reply };
	};
}

const attachScript = (ref: SessionRef, handle = h(ref)): Script => ({ "sessions/attach": attaching({ summary: summary(ref, handle) }) });

/** Attach `ref` as `view` (D32 point 1), and wait for the snapshot that binds it and the reply. */
async function bindView(io: ReturnType<typeof stdio>, ref: SessionRef, view: number, id = 100 + view): Promise<void> {
	const before = io.out.length;
	io.send({ jsonrpc: "2.0", id, method: "sessions/attach", params: { session: ref, view } });
	await io.until(before + 2);
}

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
	vi.useRealTimers();
	await stop?.();
	stop = null;
});

function start(script: Script = {}, renderMarkdown: Render = render, forkPoints = false) {
	const io = stdio(forkPoints);
	const server = socketServer(script);
	const done = runHelper({
		input: io.input,
		write: io.write,
		openSocket: (path) => server.openSocket(path),
		token: () => ({ value: "the-token", refusal: "the server refused the API token in /home/x/.ssh/agentpane-token" }),
		render: renderMarkdown,
	});
	stop = async () => {
		io.end();
		await done;
	};
	return { io, server, done };
}

/** The commands the server was sent, each as its name and params, but the helper's own `sessions/forkPoints` (see `stdio`). */
const sent = (server: SocketServer) => server.calls.filter(({ cmd }) => cmd !== "sessions/forkPoints").map(({ cmd, params }) => [cmd, params]);

describe("the socket", () => {
	it("opens at the first request, its first frame the hello carrying the token and the request behind it (D31 point 5)", async () => {
		const { io, server } = start({ "models/list": () => ({ models: [] }) });
		await tick();
		expect(server.sockets).toHaveLength(0);
		io.send({ jsonrpc: "2.0", id: 1, method: "models/list", params: { backend: "pi" } });
		io.send({ jsonrpc: "2.0", id: 2, method: "models/list", params: { backend: "codex" } });
		await io.until(2);
		expect(server.sockets).toHaveLength(1);
		expect(server.sockets[0]!.sent.map((frame) => frame["cmd"])).toEqual(["hello", "models/list", "models/list"]);
		expect(server.sockets[0]!.sent[0]).toEqual({ id: expect.any(String), cmd: "hello", token: "the-token" });
	});

	it("hears sessions/changed from its first request on, with nothing attached, so a picker is told (OW-nufafi)", async () => {
		const { io, server } = start({ "sessions/list": () => ({ sessions: [] }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list" });
		await io.until(1);
		server.emit({ type: "sessions-changed" });
		await io.until(2);
		expect(io.notifications()).toEqual([{ jsonrpc: "2.0", method: "sessions/changed" }]);
	});

	it("exits when the socket closes, and opens it no more (D25 point 4, D31 point 6)", async () => {
		const { io, server, done } = start({ "sessions/list": () => ({ sessions: [] }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list" });
		await io.until(1);
		server.drop(1006);
		expect(await settled(done)).toBe("resolved");
		await tick();
		expect(server.sockets).toHaveLength(1);
	});

	it("answers an unknown method without opening the socket, so with no server it goes on reading", async () => {
		const io = stdio();
		const server = socketServer();
		server.failing = 1;
		const done = runHelper({ input: io.input, write: io.write, openSocket: (path) => server.openSocket(path), token: () => ({ value: null, refusal: "" }), render });
		io.send({ jsonrpc: "2.0", id: 1, method: "agentpane-test/unknown" });
		await io.until(1);
		expect(io.response(1)!["error"]).toMatchObject({ code: -32601 });
		expect(server.sockets).toHaveLength(0);
		expect(await settled(done)).toBe("pending");
		io.end();
		expect(await settled(done)).toBe("resolved");
	});

	it("exits when the socket fails to open, and opens it no more", async () => {
		const io = stdio();
		const server = socketServer();
		server.failing = 1;
		const done = runHelper({ input: io.input, write: io.write, openSocket: (path) => server.openSocket(path), token: () => ({ value: null, refusal: "" }), render });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list" });
		expect(await settled(done)).toBe("resolved");
		expect(server.sockets).toHaveLength(1);
		io.end();
	});

	// Never written, so they reached no backend: the code says so, which
	// agentpane-mode reads as a refusal (OW-pezelo).
	it("answers each request read before a first open that fails as unreachable, before it exits", async () => {
		const io = stdio();
		const socket = new FakeSocket(SOCKET_PATH);
		const done = runHelper({ input: io.input, write: io.write, openSocket: () => socket, token: () => ({ value: null, refusal: "" }), render });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list" });
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, view: 2 } });
		await tick();
		socket.drop(1006);
		expect(await settled(done)).toBe("resolved");
		expect(socket.sent).toEqual([]);
		await tick();
		for (const id of [1, 2]) {
			const error = io.response(id)!["error"] as { code: number; message: string; data: { error: string } };
			expect(error.code).toBe(-32000);
			expect(error.message).toMatch(/reach.*server/);
			expect(error.data.error).toBe("unreachable");
		}
	});

	it("answers each request out at a close for a refused token with the refusal naming the token file, and exits", async () => {
		const { io, server, done } = start({ "sessions/list": () => new Promise<never>(() => {}) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list" });
		await tick();
		server.drop(SOCKET_CLOSE.unauthorized);
		expect(await settled(done)).toBe("resolved");
		await tick();
		expect(io.response(1)!["error"]).toEqual({
			code: -32000,
			message: "the server refused the API token in /home/x/.ssh/agentpane-token",
			data: { error: "unauthorized", detail: "the server refused the API token in /home/x/.ssh/agentpane-token" },
		});
	});
});

describe("requests", () => {
	it("lists sessions and answers the summaries", async () => {
		const { io, server } = start({ "sessions/list": () => ({ sessions: [summary(pi)] }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list", params: { cwd: "/work" } });
		await io.until(1);
		expect(io.response(1)).toEqual({ jsonrpc: "2.0", id: 1, result: [summary(pi)] });
		expect(sent(server)).toEqual([["sessions/list", { cwd: "/work" }]]);
	});

	it("previews a stored session as nodes, each text part carrying html", async () => {
		const turns = fixtureMessages();
		const { io, server } = start({ "sessions/preview": ({ ref }) => ({ ref, turns: turns as never }) });
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/preview", params: { session: codex } });
		await io.until(1);
		const nodes = io.response(2)!["result"] as TranscriptNode[];
		expect(nodes.map((node) => node.index)).toEqual(turns.map((_, index) => index));
		const texts = nodes.flatMap((node) => node.parts.filter((part) => part.type === "text"));
		expect(texts.length).toBeGreaterThan(0);
		for (const part of texts) expect(part.html).toBe(`stub:${part.text}`);
		expect(sent(server)).toEqual([["sessions/preview", { ref: codex }]]);
	});

	it("forwards each verb as its command, a live session's by the handle its view is bound to, and answers null where the command returns nothing (D31 point 9, D32 point 1)", async () => {
		const model = { id: "m", label: "M", efforts: [{ id: "low", description: "Fast" }], defaultEffort: "low" };
		const { io, server } = start({
			...attachScript(pi),
			"models/list": () => ({ models: [model] }),
			"sessions/prompt": () => ({ disposition: "started" }),
			"sessions/abort": () => ({ queued: ["first steer", "second steer"] }),
			"sessions/compact": () => null,
			"sessions/close": () => null,
			"sessions/setModel": () => null,
			"sessions/setEffort": () => null,
			"sessions/setName": () => null,
			"sessions/dismissError": () => null,
		});
		await bindView(io, pi, 1);
		const handle = h(pi);
		const view = 1;
		const requests = [
			["models/list", { backend: "pi" }, [model], ["models/list", { backend: "pi" }]],
			// The error the buffer held at the send goes with the prompt, so admitting
			// it clears only that one (OW-jokoto).
			["sessions/prompt", { session: pi, view, live: true, text: "hello", priorErrorId: "e4" }, null, ["sessions/prompt", { handle, text: "hello", priorErrorId: "e4" }]],
			// The prompts the stop took out of Pi's queue come back to the caller (OW-wisifo).
			["sessions/abort", { session: pi, view }, { queued: ["first steer", "second steer"] }, ["sessions/abort", { handle }]],
			["sessions/compact", { session: pi, view }, null, ["sessions/compact", { handle }]],
			["sessions/close", { session: pi, view }, null, ["sessions/close", { handle }]],
			["sessions/setModel", { session: pi, view, model: "m" }, null, ["sessions/setModel", { handle, model: "m" }]],
			["sessions/setEffort", { session: pi, view, effort: "low" }, null, ["sessions/setEffort", { handle, effort: "low" }]],
			["sessions/setName", { session: pi, view, name: "probe name" }, null, ["sessions/setName", { handle, name: "probe name" }]],
			// Named by id, so the server clears it only while it is still the one held (OW-desufa, OW-jokoto).
			["sessions/dismissError", { session: pi, view, errorId: "e4" }, null, ["sessions/dismissError", { handle, errorId: "e4" }]],
		] as const;
		for (const [index, [method, params]] of requests.entries()) io.send({ jsonrpc: "2.0", id: index + 10, method, params });
		await io.until(2 + requests.length);
		for (const [index, [, , result, command]] of requests.entries()) {
			expect(io.response(index + 10)).toEqual({ jsonrpc: "2.0", id: index + 10, result });
			expect(sent(server)).toContainEqual(command);
		}
	});

	it("refuses each request on a live session from a view bound to nothing not_attached, sending the server nothing (D32 point 1)", async () => {
		const { io, server } = start({ "sessions/list": () => ({ sessions: [] }) });
		const view = 3;
		const requests = [
			["sessions/abort", { session: pi, view }],
			["sessions/compact", { session: pi, view }],
			["sessions/close", { session: pi, view }],
			["sessions/setModel", { session: pi, view, model: "m" }],
			["sessions/setEffort", { session: pi, view, effort: "low" }],
			["sessions/setName", { session: pi, view, name: "n" }],
			["sessions/dismissError", { session: pi, view, errorId: "e4" }],
			["sessions/forkAndPrompt", { session: pi, view, forkView: 4, index: 0, text: "again" }],
		] as const;
		for (const [index, [method, params]] of requests.entries()) io.send({ jsonrpc: "2.0", id: index + 10, method, params });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list" });
		await io.until(requests.length + 1);
		for (const index of requests.keys()) expect(io.response(index + 10)!["error"]).toMatchObject({ code: -32000, data: { error: "not_attached" } });
		expect(sent(server)).toEqual([["sessions/list", {}]]);
	});

	it("answers sessions/prompt with the disposition for a prompt handled without a turn, and null for a started one (OW-dulipe)", async () => {
		const { io } = start({ "sessions/prompt": (params) => ({ disposition: params.text === "/mcp" ? "handled" : "started" }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/prompt", params: { session: pi, view: 1, text: "/mcp" } });
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/prompt", params: { session: pi, view: 2, text: "hello" } });
		await io.until(2);
		expect(io.response(1)).toEqual({ jsonrpc: "2.0", id: 1, result: { disposition: "handled" } });
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: null });
	});

	/**
	 * A prompt from an unbound view attaches its session for that view (D30):
	 * the snapshot under it binds the view as an attach's does (D25), and goes
	 * out before the reply, the disposition alone.
	 */
	it("names the ref of a prompt from an unbound view, and sends the snapshot that binds the view before the reply (D30)", async () => {
		const { io, server } = start({
			"sessions/prompt": (_params, server) => {
				server.emit(snapshot(pi, "h9"));
				return { disposition: "started", session: summary(pi, "h9") };
			},
		});
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/prompt", params: { session: pi, view: 7, text: "hello", priorErrorId: null } });
		await io.until(2);
		expect(io.out[0]).toMatchObject({ method: "session/snapshot", params: { session: pi, view: 7, handle: "h9" } });
		expect(io.out[1]).toEqual({ jsonrpc: "2.0", id: 4, result: null });
		expect(sent(server)).toEqual([["sessions/prompt", { ref: pi, text: "hello", priorErrorId: null }]]);
	});

	it("answers a handled prompt from an unbound view with the disposition alone (D30)", async () => {
		const { io } = start({
			"sessions/prompt": (_params, server) => {
				server.emit(snapshot(pi, "h9"));
				return { disposition: "handled", session: summary(pi, "h9") };
			},
		});
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/prompt", params: { session: pi, view: 7, text: "/mcp" } });
		await io.until(2);
		expect(io.out[1]).toEqual({ jsonrpc: "2.0", id: 4, result: { disposition: "handled" } });
	});

	it("carries the session a refused prompt from an unbound view attached in the error's data, after its snapshot (D30)", async () => {
		const attached = { ref: pi, handle: "h9" };
		const { io } = start({
			"sessions/prompt": (_params, server) => {
				server.emit(snapshot(pi, "h9"));
				throw new ApiClientError("backend_refused", "not now", undefined, attached);
			},
		});
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/prompt", params: { session: pi, view: 7, text: "hello" } });
		await io.until(2);
		expect(io.out[0]).toMatchObject({ method: "session/snapshot", params: { view: 7, handle: "h9" } });
		expect(io.out[1]).toEqual({
			jsonrpc: "2.0",
			id: 4,
			error: { code: -32000, message: "not now", data: { error: "backend_refused", detail: "not now", attached } },
		});
	});

	it("carries a server refusal through as a JSON-RPC error with the server's code and text", async () => {
		const { io } = start({
			"sessions/prompt": () => {
				throw new ApiClientError("backend_refused", "the backend refused the prompt");
			},
		});
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/prompt", params: { session: pi, view: 1, text: "again" } });
		await io.until(1);
		expect(io.response(3)).toEqual({
			jsonrpc: "2.0",
			id: 3,
			error: { code: -32000, message: "the backend refused the prompt", data: { error: "backend_refused", detail: "the backend refused the prompt" } },
		});
	});

	/**
	 * A create starts the session and attaches it (D30): its snapshot, under
	 * the view agentpane-mode made for it, binds that view as an attach's does
	 * (D25), and goes out before the reply. The view goes nowhere but back.
	 */
	it("sends the snapshot that binds a created session's view before the reply (D30, D32 point 3)", async () => {
		const created = summary(pi, "h9");
		const { io, server } = start({
			"sessions/create": (_params, server) => {
				server.emit(snapshot(pi, "h9"));
				return { session: created };
			},
		});
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/create", params: { cwd: "/work", backend: "pi", view: 7 } });
		await io.until(2);
		expect(io.out[0]).toMatchObject({ method: "session/snapshot", params: { session: pi, view: 7, handle: "h9" } });
		expect(io.out[1]).toEqual({ jsonrpc: "2.0", id: 4, result: created });
		expect(sent(server)).toEqual([["sessions/create", { cwd: "/work", backend: "pi" }]]);
	});

	it("binds nothing for a refused create (D30)", async () => {
		const { io } = start({
			"sessions/create": () => {
				throw new ApiClientError("internal_error", "sbox: no git root");
			},
		});
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/create", params: { cwd: "/work", backend: "pi", view: 7 } });
		await io.until(1);
		expect(io.notifications()).toEqual([]);
		expect(io.response(4)!["error"]).toMatchObject({ data: { error: "internal_error", detail: "sbox: no git root" } });
	});

	it("sends the snapshot that binds the fork's view before the fork-and-prompt's reply, and feeds the fork after (D30, D32 point 3)", async () => {
		const reply = { session: summary(codex, "h9"), disposition: "started" as const };
		const { io, server } = start({
			...attachScript(pi),
			"sessions/forkAndPrompt": (_params, server) => {
				server.emit(snapshot(codex, "h9", { isStreaming: true }));
				return reply;
			},
		});
		await bindView(io, pi, 1);
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/forkAndPrompt", params: { session: pi, view: 1, forkView: 7, index: 2, text: "again" } });
		await io.until(4);
		expect(io.out[2]).toMatchObject({ method: "session/snapshot", params: { session: codex, view: 7, handle: "h9", isStreaming: true } });
		expect(io.out[3]).toEqual({ jsonrpc: "2.0", id: 4, result: reply });
		expect(sent(server)).toContainEqual(["sessions/forkAndPrompt", { handle: h(pi), index: 2, text: "again" }]);
		server.emit(status(codex, "h9", 2, false));
		await io.until(5);
		expect(io.out[4]).toMatchObject({ method: "session/status", params: { view: 7, handle: "h9", isStreaming: false } });
	});

	/** A fork attached and then not prompted is bound before its refusal goes out, so Emacs can move to it (D30). */
	it("carries the fork a refused fork-and-prompt names in the error's data, after the snapshot that binds its view (D30)", async () => {
		const fork = { ref: codex, handle: "h9" };
		const { io } = start({
			...attachScript(pi),
			"sessions/forkAndPrompt": (_params, server) => {
				server.emit(snapshot(codex, "h9"));
				throw new ApiClientError("backend_refused", "not now", fork);
			},
		});
		await bindView(io, pi, 1);
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/forkAndPrompt", params: { session: pi, view: 1, forkView: 7, index: 0, text: "again" } });
		await io.until(4);
		expect(io.out[2]).toMatchObject({ method: "session/snapshot", params: { view: 7, handle: "h9" } });
		expect(io.out[3]).toEqual({
			jsonrpc: "2.0",
			id: 4,
			error: { code: -32000, message: "not now", data: { error: "backend_refused", detail: "not now", fork } },
		});
	});

	it("binds nothing for a refusal naming a fork closed before its prompt was refused, or none (D30)", async () => {
		const refusals = [
			new ApiClientError("not_attached", "session codex:thread-1 is not attached under handle h-fork", { ref: codex, handle: null }),
			new ApiClientError("not_a_fork_point", "no point"),
		];
		const { io } = start({
			...attachScript(pi),
			"sessions/forkAndPrompt": () => {
				throw refusals.shift()!;
			},
		});
		await bindView(io, pi, 1);
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/forkAndPrompt", params: { session: pi, view: 1, forkView: 7, index: 0, text: "again" } });
		io.send({ jsonrpc: "2.0", id: 5, method: "sessions/forkAndPrompt", params: { session: pi, view: 1, forkView: 8, index: 3, text: "again" } });
		await io.until(4);
		expect(io.notifications()).toHaveLength(1);
		expect(io.response(4)!["error"]).toMatchObject({ data: { error: "not_attached", fork: { ref: codex, handle: null } } });
		expect(io.response(5)!["error"]).toMatchObject({ data: { error: "not_a_fork_point" } });
	});

	it("answers a preview of a gone session with an error whose data carries gone (D26)", async () => {
		const { io } = start({
			"sessions/preview": () => {
				throw new ApiClientError("gone", "no such session");
			},
		});
		io.send({ jsonrpc: "2.0", id: 6, method: "sessions/preview", params: { session: codex } });
		await io.until(1);
		expect(io.response(6)!["error"]).toMatchObject({ data: { error: "gone" } });
	});

	it("answers an unknown method with -32601 and a failure of its own with -32603", async () => {
		const { io } = start();
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/dance", params: {} });
		io.send({ jsonrpc: "2.0", id: 5, method: "sessions/abort" });
		await io.until(2);
		expect(io.response(4)!["error"]).toMatchObject({ code: -32601 });
		expect(io.response(5)!["error"]).toMatchObject({ code: -32603 });
		expect((io.response(5)!["error"] as { data?: unknown }).data).toBeUndefined();
	});
});

describe("notifications", () => {
	it("sends the attach's snapshot, under its view, before its reply, and when the interval ends one node carrying the last upsert", async () => {
		const messages = fixtureMessages();
		const tail = messages.length - 1;
		const final = messages[tail] as AssistantMessage;
		const { io, server } = start({
			"sessions/attach": (_params, server) => {
				server.emit(snapshot(codex, h(codex), { messages: messages.slice(0, tail), isStreaming: true, model: "m" }));
				return { session: summary(codex) };
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: codex, view: 1 } });
		await io.until(2);
		expect(io.out[0]).toMatchObject({ method: "session/snapshot", params: { session: codex, view: 1, isStreaming: true, compaction: null, model: "m" } });
		expect((io.out[0]!["params"] as { nodes: TranscriptNode[] }).nodes.map((node) => node.index)).toEqual(messages.slice(0, tail).map((_, index) => index));
		expect(io.out[1]).toEqual({ jsonrpc: "2.0", id: 1, result: summary(codex) });

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const partial = { ...final, content: [{ type: "text", text: "par" }], stopReason: "pending" } as PaneMessage;
		server.emit({ type: "upsert", session: codex, handle: h(codex), seq: 2, index: tail, message: partial });
		server.emit({ type: "upsert", session: codex, handle: h(codex), seq: 3, index: tail, message: final });
		expect(io.notifications()).toHaveLength(1);
		vi.advanceTimersByTime(250);
		const [, node] = io.notifications();
		expect(node).toMatchObject({ method: "session/node", params: { session: codex, view: 1, node: { index: tail, role: "assistant" } } });
		const texts = (node!["params"] as { node: TranscriptNode }).node.parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
		expect(texts).toEqual(final.content.flatMap((block) => (block.type === "text" ? [block.text] : [])));
		expect(io.notifications()).toHaveLength(2);
	});

	// A session already live: the opening snapshot formed its view, and the
	// attach broadcasts one more before it answers.
	it("answers an attach of a session already live from the view the reducer holds, under the attaching view", async () => {
		const { io, server } = start(attachScript(pi));
		server.opening = [snapshot(pi, h(pi), { isStreaming: true })];
		await tick();
		expect(io.out).toEqual([]);
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(3);
		// The attach's snapshot reads idle the turn the opening one read
		// streaming: a turn's end, told before any view is bound (D32 point 6).
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/turnEnded", "session/snapshot", 1]);
		expect(io.out[0]).toMatchObject({ params: { handle: h(pi), watched: false } });
		expect(io.out[0]!["params"]).not.toHaveProperty("view");
		expect(io.out[1]).toMatchObject({ params: { view: 1, handle: h(pi) } });
	});

	it("detaches a session whose seq gaps, attaching nothing, and says nothing more under it until Emacs attaches it again (OW-filuge)", async () => {
		const { io, server } = start(attachScript(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);

		server.emit(status(pi, h(pi), 3));
		await io.until(3);
		expect(io.notifications()[1]).toEqual({ jsonrpc: "2.0", method: "session/detached", params: { session: pi, view: 1, handle: h(pi) } });
		// A later event under the handle finds no view to gap against again.
		server.emit(status(pi, h(pi), 4, false));
		// A gap in a view Emacs never attached is told nothing.
		server.emit(snapshot(codex));
		server.emit(status(codex, h(codex), 5));
		await tick();
		expect(sent(server)).toHaveLength(1);
		expect(io.notifications()).toHaveLength(2);

		// `a` or a send: the attach broadcasts a snapshot, which forms the view again.
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(5);
		expect(io.notifications()[2]).toMatchObject({ method: "session/snapshot", params: { session: pi, view: 1, handle: h(pi) } });
		expect(sent(server).map(([cmd]) => cmd)).toEqual(["sessions/attach", "sessions/attach"]);
	});

	it("sends nothing from the gapped view when the attach after it is answered under the rename the gap swallowed (OW-filuge)", async () => {
		const renamed: SessionRef = { backend: "pi", id: "/tmp/renamed.jsonl" };
		const { io, server } = start({
			"sessions/attach": attaching({ summary: summary(pi, h(pi)) }, { summary: summary(renamed, h(pi)) }),
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);
		server.emit(status(renamed, h(pi), 3));
		await io.until(3);

		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(5);
		await tick();
		expect(io.out.slice(2).map((message) => message["method"] ?? message["id"])).toEqual(["session/detached", "session/snapshot", 2]);
		expect(io.out[3]).toMatchObject({ params: { session: renamed, view: 1, handle: h(pi) } });
	});

	// The reply is handled after the events ahead of it, and under Bun 1.4.0
	// after the next message's handler too (D31 point 4): one that ended the
	// handle, or gapped it, leaves no view for the reply to bind.
	it.each([
		["ended", (server: SocketServer) => server.emit({ type: "ended", session: pi, handle: h(pi) })],
		["gapped", (server: SocketServer) => server.emit(status(pi, h(pi), 5))],
	])("binds no view for an attach whose handle %s between its snapshot and its reply", async (_, between) => {
		const { io, server } = start({
			"sessions/attach": (_params, server) => {
				server.emit(snapshot(pi));
				between(server);
				return { session: summary(pi) };
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(1);
		server.emit(snapshot(pi, h(pi), { seq: 6 }));
		server.emit(status(pi, h(pi), 7));
		await tick();
		expect(io.out).toEqual([{ jsonrpc: "2.0", id: 1, result: summary(pi) }]);
	});

	// A `g` on an attached buffer: the second attach's snapshot reaches the
	// view as it arrives, and the reply sends it again (D32 point 2).
	it("sends the snapshot again to a view that attaches the handle it already holds", async () => {
		const { io } = start({ "sessions/attach": attaching({ summary: summary(pi) }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(5);
		expect(io.out.map((message) => [message["method"] ?? message["id"], (message["params"] as { view?: number } | undefined)?.view])).toEqual([
			["session/snapshot", 1],
			[1, undefined],
			["session/snapshot", 1],
			["session/snapshot", 1],
			[2, undefined],
		]);
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: summary(pi) });
	});

	it("says nothing for a session Emacs never attached, and nothing more after the ended a sessions/close brings", async () => {
		const { io, server } = start({
			"sessions/attach": (_params, server) => {
				server.emit(snapshot(codex));
				server.emit(status(codex, h(codex), 2));
				server.emit(snapshot(pi));
				return { session: summary(pi) };
			},
			"sessions/close": (_params, server) => {
				server.emit({ type: "ended", session: pi, handle: h(pi) });
				return null;
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);
		expect(io.notifications()).toEqual([
			{ jsonrpc: "2.0", method: "session/snapshot", params: { session: pi, view: 1, handle: h(pi), nodes: [], isStreaming: false, compaction: null, model: null, effort: null, defaultEffort: null, unrestoredModel: null, error: null, errorId: null, notices: [] } },
		]);

		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/close", params: { session: pi, view: 1 } });
		await io.until(4);
		server.emit(status(pi, h(pi), 2));
		await tick();
		expect(io.notifications().map((message) => message["method"])).toEqual(["session/snapshot", "session/detached"]);
	});

	it("says nothing more after sessions/detach, which sends nothing, nor for an attach in flight across it", async () => {
		const attach = held();
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi), hold: attach.hold }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/detach", params: { session: pi, view: 1 } });
		await io.until(1);
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: null });

		attach.release();
		await io.until(2);
		server.emit(status(pi, h(pi), 2));
		await tick();
		expect(io.notifications()).toEqual([]);
		expect(io.response(1)).toEqual({ jsonrpc: "2.0", id: 1, result: summary(pi) });
		expect(sent(server).map(([cmd]) => cmd)).toEqual(["sessions/attach"]);
	});

	// Each attaches for the view it names, as an attach does (D30), so the
	// view's detach gives it up the same way. A fork-and-prompt names the
	// parent's view, bound first, and attaches for the fork's.
	it.each([
		{
			method: "sessions/create",
			params: { cwd: "/work", backend: "pi", view: 1 },
			script: (hold: Promise<void>): Script => ({
				"sessions/create": async (_params, server) => {
					await hold;
					server.emit(snapshot(pi, "h9"));
					return { session: summary(pi, "h9") };
				},
			}),
		},
		{
			method: "sessions/prompt",
			params: { session: pi, view: 1, text: "hello", priorErrorId: null },
			script: (hold: Promise<void>): Script => ({
				"sessions/prompt": async (_params, server) => {
					await hold;
					server.emit(snapshot(pi, "h9"));
					return { disposition: "started", session: summary(pi, "h9") };
				},
			}),
		},
		{
			method: "sessions/forkAndPrompt",
			params: { session: codex, view: 5, forkView: 1, index: 2, text: "again" },
			script: (hold: Promise<void>): Script => ({
				...attachScript(codex),
				"sessions/forkAndPrompt": async (_params, server) => {
					await hold;
					server.emit(snapshot(pi, "h9"));
					return { session: summary(pi, "h9"), disposition: "started" };
				},
			}),
		},
	])("binds nothing for a $method in flight across its view's sessions/detach, nor feeds what it started", async ({ method, params, script }) => {
		const request = held();
		const { io, server } = start(script(request.hold));
		if (method === "sessions/forkAndPrompt") await bindView(io, codex, 5);
		const before = io.out.length;
		io.send({ jsonrpc: "2.0", id: 1, method, params });
		await vi.waitFor(() => expect(server.calls.map((call) => call.cmd)).toContain(method));
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/detach", params: { session: pi, view: 1 } });
		await io.until(before + 1);
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: null });

		request.release();
		await io.until(before + 2);
		server.emit(status(pi, "h9", 2));
		await tick();
		expect(io.notifications().filter((message) => (message["params"] as { view?: number }).view === 1)).toEqual([]);
		expect(io.response(1)).toHaveProperty("result");
	});

	it("forwards the snapshot under the handle that names a rename, and nothing beside it", async () => {
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, server } = start(attachScript(virtual));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual, view: 1 } });
		await io.until(2);
		server.emit(snapshot(pi, h(virtual), { seq: 0, isStreaming: true }));
		await io.until(3);
		await tick();
		expect(io.notifications().map((message) => message["method"])).toEqual(["session/snapshot", "session/snapshot"]);
		expect(io.notifications()[1]).toMatchObject({ params: { session: pi, view: 1, handle: h(virtual), isStreaming: true } });
	});

	it("stops at its view's sessions/detach, whatever ref the snapshot that bound it names (OW-linowe)", async () => {
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, server } = start(attachScript(virtual));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual, view: 1 } });
		await io.until(2);
		server.emit(snapshot(pi, h(virtual), { seq: 0 }));
		await io.until(3);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/detach", params: { session: virtual, view: 1 } });
		await io.until(4);
		server.emit(status(pi, h(virtual), 1));
		await tick();
		expect(io.notifications().map((message) => message["method"])).toEqual(["session/snapshot", "session/snapshot"]);
	});

	it("keeps forwarding a session Emacs attached when a second attach of its ref fails", async () => {
		let attaches = 0;
		const { io, server } = start({
			"sessions/attach": (_params, server) => {
				if (++attaches > 1) throw new ApiClientError("internal_error", "boom");
				server.emit(snapshot(pi));
				return { session: summary(pi) };
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(3);
		expect(io.response(2)!["error"]).toBeDefined();
		server.emit(status(pi, h(pi), 2));
		await io.until(4);
		expect(io.notifications().map((message) => message["method"])).toEqual(["session/snapshot", "session/status"]);
	});

	it("answers an attach through an alias under the ref its reply names, and goes on sending under the view", async () => {
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi) }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: alias, view: 1 } });
		await io.until(2);
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 1]);
		expect(io.out[0]).toMatchObject({ params: { session: pi, view: 1, handle: h(pi) } });
		expect(io.out[1]).toEqual({ jsonrpc: "2.0", id: 1, result: summary(pi) });

		server.emit(status(pi, h(pi), 2, false));
		server.emit(snapshot(pi, h(pi), { seq: 0 }));
		await io.until(4);
		expect(io.out[2]).toMatchObject({ method: "session/status", params: { session: pi, view: 1, handle: h(pi), isStreaming: false } });
		expect(io.out[3]).toMatchObject({ method: "session/snapshot", params: { view: 1 } });
	});

	it("sends one snapshot, of the view as the reply finds it, for an attach whose handle a rename moved before the reply (OW-wukako)", async () => {
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io } = start({
			"sessions/attach": (_params, server) => {
				server.emit(snapshot(virtual));
				server.emit(snapshot(pi, h(virtual), { seq: 0 }));
				return { session: summary(pi, h(virtual)) };
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual, view: 1 } });
		await io.until(2);
		await tick();
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 1]);
		expect(io.out[0]).toMatchObject({ params: { session: pi, view: 1, handle: h(virtual) } });
	});

	it("passes status and error through", async () => {
		const { io, server } = start(attachScript(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);
		server.emit({ type: "status", session: pi, handle: h(pi), seq: 2, isStreaming: true, compaction: "running", model: "m", effort: "low", unrestoredModel: null });
		server.emit({ type: "error", session: pi, handle: h(pi), seq: 3, message: "boom", errorId: "e1" });
		await io.until(4);
		const [, statusOut, error] = io.notifications();
		expect(statusOut).toEqual({ jsonrpc: "2.0", method: "session/status", params: { session: pi, view: 1, handle: h(pi), isStreaming: true, compaction: "running", model: "m", effort: "low", defaultEffort: null, unrestoredModel: null } });
		// With the id Emacs names it by when it dismisses it or prompts over it (OW-jokoto).
		expect(error).toEqual({ jsonrpc: "2.0", method: "session/error", params: { session: pi, view: 1, handle: h(pi), message: "boom", errorId: "e1" } });
	});

	it("passes the server's clear of the turn error through as session/errorCleared (OW-jopifu)", async () => {
		const { io, server } = start(attachScript(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);
		server.emit({ type: "error", session: pi, handle: h(pi), seq: 2, message: "boom", errorId: "e1" });
		server.emit({ type: "error-cleared", session: pi, handle: h(pi), seq: 3 });
		await io.until(4);
		const [, , cleared] = io.notifications();
		expect(cleared).toEqual({ jsonrpc: "2.0", method: "session/errorCleared", params: { session: pi, view: 1, handle: h(pi) } });
	});

	it("passes a notice through as session/notice, not session/error (OW-tujiya)", async () => {
		const { io, server } = start(attachScript(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);
		const notice = { kind: "configWarning", message: "unknown key", details: "see the docs", path: "/c.toml:3:5" };
		server.emit({ type: "notice", session: pi, handle: h(pi), seq: 2, notice });
		await io.until(3);
		const [, noticed] = io.notifications();
		expect(noticed).toEqual({ jsonrpc: "2.0", method: "session/notice", params: { session: pi, view: 1, handle: h(pi), notice } });
	});

	it("carries the notices the server's snapshot holds on every later session/snapshot (OW-tujiya, OW-bipume)", async () => {
		const { io, server } = start(attachScript(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);
		const notice = { kind: "warning", message: "fallback metadata", details: null, path: null };
		server.emit({ type: "notice", session: pi, handle: h(pi), seq: 2, notice });
		// A later snapshot of the session, such as another attach broadcasts.
		server.emit(snapshot(pi, h(pi), { seq: 0, isStreaming: true, notices: [notice] }));
		await io.until(4);
		const [first, , second] = io.notifications();
		expect(first).toMatchObject({ method: "session/snapshot", params: { notices: [] } });
		expect(second).toMatchObject({ method: "session/snapshot", params: { session: pi, handle: h(pi), isStreaming: true, notices: [notice] } });
	});

	it("carries the error and notices the server's snapshot holds onto session/snapshot (OW-bipume)", async () => {
		const notice = { kind: "configWarning", message: "unknown key", details: null, path: null };
		const { io } = start({
			"sessions/attach": (_params, server) => {
				// Raised before Emacs attached: no `error` or `notice` event reached it.
				server.emit(snapshot(pi, h(pi), { seq: 3, error: "turn failed", errorId: "e1", notices: [notice] }));
				return { session: summary(pi) };
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);
		expect(io.notifications()[0]).toEqual({
			jsonrpc: "2.0",
			method: "session/snapshot",
			params: { session: pi, view: 1, handle: h(pi), nodes: [], isStreaming: false, compaction: null, model: null, effort: null, defaultEffort: null, unrestoredModel: null, error: "turn failed", errorId: "e1", notices: [notice] },
		});
	});

	it("carries the recorded model a resume could not restore on session/snapshot, and its clearing on session/status (OW-jitoni)", async () => {
		const { io, server } = start({
			"sessions/attach": (_params, server) => {
				server.emit(snapshot(pi, h(pi), { model: "p/fallback", unrestoredModel: "p/recorded" }));
				return { session: summary(pi) };
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);
		server.emit({ type: "status", session: pi, handle: h(pi), seq: 2, isStreaming: false, compaction: null, model: "p/fallback", effort: null, unrestoredModel: null });
		await io.until(3);
		const [snapshotOut, statusOut] = io.notifications();
		expect(snapshotOut).toEqual({
			jsonrpc: "2.0",
			method: "session/snapshot",
			params: { session: pi, view: 1, handle: h(pi), nodes: [], isStreaming: false, compaction: null, model: "p/fallback", effort: null, defaultEffort: null, unrestoredModel: "p/recorded", error: null, errorId: null, notices: [] },
		});
		expect(statusOut).toEqual({
			jsonrpc: "2.0",
			method: "session/status",
			params: { session: pi, view: 1, handle: h(pi), isStreaming: false, compaction: null, model: "p/fallback", effort: null, defaultEffort: null, unrestoredModel: null },
		});
	});

	it("carries only the status on session/snapshot and session/status, whatever else an event holds (#108)", async () => {
		const leak = { turnDiff: "diff" };
		const { io, server } = start({
			"sessions/attach": (_params, server) => {
				server.emit({ ...snapshot(pi, h(pi)), ...leak });
				return { session: summary(pi) };
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);
		server.emit({ ...status(pi, h(pi), 2), ...leak });
		await io.until(3);
		const [snapshotOut, statusOut] = io.notifications();
		expect(snapshotOut).toMatchObject({ method: "session/snapshot" });
		expect(snapshotOut!["params"]).not.toHaveProperty("turnDiff");
		expect(statusOut).toMatchObject({ method: "session/status", params: { isStreaming: true } });
		expect(statusOut!["params"]).not.toHaveProperty("turnDiff");
	});

	it("carries its model's default effort on session/status, from one models/list per backend that it holds (D32 point 8)", async () => {
		const models = [
			{ id: "m", label: "M", efforts: [{ id: "low", description: "" }], defaultEffort: "low" },
			{ id: "n", label: "N", efforts: [{ id: "high", description: "" }], defaultEffort: "high" },
		];
		const { io, server } = start({
			"sessions/attach": (_params, server) => {
				server.emit(snapshot(codex, h(codex), { model: "m" }));
				return { session: summary(codex) };
			},
			"models/list": () => ({ models }),
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: codex, view: 1 } });
		// The snapshot goes out before the listing answers, and a status follows it once it has.
		await io.until(3);
		const [snapshotOut, listed] = io.notifications();
		expect(snapshotOut).toMatchObject({ method: "session/snapshot", params: { model: "m", effort: null, defaultEffort: null } });
		expect(listed).toMatchObject({ method: "session/status", params: { view: 1, handle: h(codex), model: "m", effort: null, defaultEffort: "low" } });
		server.emit({ type: "status", session: codex, handle: h(codex), seq: 2, isStreaming: false, compaction: null, model: "n", effort: null, unrestoredModel: null });
		await io.until(4);
		expect(io.notifications()[2]).toMatchObject({ method: "session/status", params: { model: "n", effort: null, defaultEffort: "high" } });
		expect(sent(server).filter(([cmd]) => cmd === "models/list")).toEqual([["models/list", { backend: "codex" }]]);
	});
});

// The server says a handle has ended, under it, where it lets go of it
// (D26); the listing says only which sessions there are, and drops nothing.
describe("a handle's end (D26, OW-likopo)", () => {
	const methods = (io: ReturnType<typeof stdio>) =>
		io.notifications().map((message) => [message["method"], (message["params"] as { handle?: string } | undefined)?.handle]);

	// A close by another client: the buffer still counts itself attached, so
	// a prompt from it names the ended handle, and the server refuses it.
	it("tells Emacs an attachment whose handle ended is detached, and says nothing more under it", async () => {
		const { io, server } = start(attachScript(pi, "h1"));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);

		server.emit({ type: "ended", session: pi, handle: "h1" });
		server.emit({ type: "sessions-changed" });
		await io.until(4);
		server.emit(status(pi, "h1", 2));
		await tick();
		expect(methods(io)).toEqual([
			["session/snapshot", "h1"],
			["session/detached", "h1"],
			["sessions/changed", undefined],
		]);
		expect(io.notifications()[1]).toEqual({ jsonrpc: "2.0", method: "session/detached", params: { session: pi, view: 1, handle: "h1" } });
		expect(sent(server).map(([cmd]) => cmd)).toEqual(["sessions/attach"]);
	});

	it("carries the death report on session/detached where the ended does, and none where it does not (#97)", async () => {
		const report = "Pi process exited (code=1, signal=null)";
		const { io, server } = start({
			"sessions/attach": attaching({ summary: summary(pi, h(pi)) }, { summary: summary(codex, h(codex)) }),
		});
		await bindView(io, pi, 1);
		await bindView(io, codex, 2);
		const before = io.notifications().length;
		const frames = io.out.length;

		server.emit({ type: "ended", session: pi, handle: h(pi), exit: report });
		server.emit({ type: "ended", session: codex, handle: h(codex) });
		await io.until(frames + 2);

		const detached = io.notifications().slice(before).map((message) => message["params"]);
		expect(detached).toEqual([
			{ session: pi, view: 1, handle: h(pi), exit: report },
			{ session: codex, view: 2, handle: h(codex) },
		]);
		expect(detached[1]).not.toHaveProperty("exit");
	});

	it("sends no session/detached for an attachment whose handle a listing lacks, with no ended, and goes on forwarding it", async () => {
		const renamed: SessionRef = { backend: "pi", id: "/tmp/renamed.jsonl" };
		const { io, server } = start({ ...attachScript(pi, "h1"), "sessions/list": () => ({ sessions: [summary(renamed, "h2")] }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);

		server.emit({ type: "sessions-changed" });
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/list" });
		await io.until(4);
		server.emit(status(pi, "h1", 2));
		await io.until(5);
		expect(methods(io)).toEqual([
			["session/snapshot", "h1"],
			["sessions/changed", undefined],
			["session/status", "h1"],
		]);
	});
});

// Each buffer is a view, and the helper holds each view's binding, one view
// to a handle (D32 points 1 and 2): a snapshot goes to the view that sent
// the attach, a detach gives up that view's attaches alone, and an attach
// landing on a handle another view holds binds nothing. Until D32 a token
// per attach did this, and a claim per token on each handle (OW-wukako,
// OW-nowihu).
describe("views (D32)", () => {
	/** Each notification's method, handle and view, in order. */
	const told = (io: ReturnType<typeof stdio>) =>
		io.notifications().map((message) => {
			const params = message["params"] as { handle?: string; view?: number };
			return [message["method"], params.handle, params.view];
		});

	// A holds h1; B, previewing an alias of that session, attaches it and is
	// answered under h1 too. B gets no snapshot, and the reply names A, for
	// agentpane-mode to show A in B's window; B's detach then stops nothing
	// of A's (D32 point 2).
	it("binds nothing for an attach from one view landing on the handle another holds, names the holder, and leaves it bound when the first detaches", async () => {
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi, "h1") }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: alias, view: 2 } });
		await io.until(4);
		await tick();
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: { ...summary(pi, "h1"), view: 1 } });
		// The second attach's own broadcast reaches A as any snapshot under h1 does.
		expect(told(io)).toEqual([
			["session/snapshot", "h1", 1],
			["session/snapshot", "h1", 1],
		]);
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/detach", params: { session: alias, view: 2 } });
		await io.until(5);
		server.emit(status(pi, "h1", 2));
		await io.until(6);
		expect(told(io).slice(2)).toEqual([["session/status", "h1", 1]]);
	});

	// The same for a prompt from an unbound view, and its refusal (D30).
	it("names the view holding the handle a prompt from an unbound view attached, in its reply and its refusal, and binds nothing", async () => {
		const attached = { ref: pi, handle: "h1" };
		let prompts = 0;
		const { io } = start({
			...attachScript(pi, "h1"),
			"sessions/prompt": (_params, server) => {
				server.emit(snapshot(pi, "h1"));
				if (++prompts > 1) throw new ApiClientError("backend_refused", "not now", undefined, attached);
				return { disposition: "started", session: summary(pi, "h1") };
			},
		});
		await bindView(io, pi, 1);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/prompt", params: { session: pi, view: 2, text: "hello" } });
		await io.until(4);
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/prompt", params: { session: pi, view: 2, text: "again" } });
		await io.until(6);
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: { view: 1 } });
		expect(io.response(3)!["error"]).toMatchObject({ data: { error: "backend_refused", attached: { ...attached, view: 1 } } });
		expect(told(io).every(([, , view]) => view === 1)).toBe(true);
	});

	// A prompt sent while the buffer held h1, crossing the `ended` another
	// client's close brought: by ref it would resume what was closed (D30).
	it("refuses a live prompt from a view the helper unbound at an ended not_attached, and sends the server nothing", async () => {
		const { io, server } = start({ ...attachScript(pi, "h1"), "sessions/prompt": () => ({ disposition: "started" }) });
		await bindView(io, pi, 1);
		server.emit({ type: "ended", session: pi, handle: "h1" });
		await io.until(3);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/prompt", params: { session: pi, view: 1, live: true, text: "hello" } });
		await io.until(4);
		expect(io.response(2)!["error"]).toMatchObject({ code: -32000, data: { error: "not_attached" } });
		expect(sent(server).map(([cmd]) => cmd)).toEqual(["sessions/attach"]);
	});

	// X holds h1; Y's attach of the same ref is in flight when X is killed.
	it("binds the attach another view has in flight when the view holding the handle detaches (OW-jofodu)", async () => {
		const second = held();
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi, "h1") }, { summary: summary(pi, "h1"), hold: second.hold }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, view: 2 } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/detach", params: { session: pi, view: 1 } });
		await io.until(3);

		second.release();
		await io.until(5);
		expect(io.out.slice(3).map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 2]);
		server.emit(status(pi, "h1", 2));
		await io.until(6);
		expect(told(io)).toEqual([
			["session/snapshot", "h1", 1],
			["session/snapshot", "h1", 2],
			["session/status", "h1", 2],
		]);
	});

	it("keeps the view holding a handle bound when a view whose attach is in flight detaches", async () => {
		const second = held();
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi, "h1") }, { summary: summary(pi, "h1"), hold: second.hold }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, view: 2 } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/detach", params: { session: pi, view: 2 } });
		await io.until(3);
		server.emit(status(pi, "h1", 2));
		await io.until(4);

		second.release();
		await io.until(6);
		await tick();
		// The given-up attach's snapshot reaches the view holding the handle,
		// as any snapshot under it does, and the reply binds nothing.
		expect(told(io)).toEqual([
			["session/snapshot", "h1", 1],
			["session/status", "h1", 1],
			["session/snapshot", "h1", 1],
			["session/turnEnded", "h1", 1],
		]);
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: summary(pi, "h1") });
	});

	// X attached h1 and was let go of it; Y attaches the same ref, under h1
	// again after a gap, which leaves the handle live on the server, or under
	// h2 after an `ended`; then X is killed. Until OW-linowe a detach whose
	// token gave up nothing dropped by the ref, and Y heard nothing more.
	it.each([
		["gapped", "h1"],
		["ended", "h2"],
	])("keeps the view another buffer holds bound when a view %s off its handle detaches (OW-linowe)", async (cause, next) => {
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi, "h1") }, { summary: summary(pi, next) }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);
		if (cause === "gapped") server.emit(status(pi, "h1", 3));
		else server.emit({ type: "ended", session: pi, handle: "h1" });
		await io.until(3);

		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, view: 2 } });
		await io.until(5);
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/detach", params: { session: pi, view: 1 } });
		await io.until(6);
		server.emit(status(pi, next, 2));
		await io.until(7);
		expect(told(io)).toEqual([
			["session/snapshot", "h1", 1],
			["session/detached", "h1", 1],
			["session/snapshot", next, 2],
			["session/status", next, 2],
		]);
	});

	// X's attach timed out in Emacs, X sent another, which joins the first
	// still out (D32 point 4), and X is killed before either answers. Until
	// OW-nowihu nothing X could send named the first, and h1 stayed attached
	// with no buffer.
	it("unbinds a view and gives up its attach still out at its detach, the one joining it with it (OW-nowihu)", async () => {
		const first = held();
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi, "h1"), hold: first.hold }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, view: 1 } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/detach", params: { session: pi, view: 1 } });
		await io.until(1);
		first.release();
		await io.until(3);
		server.emit(status(pi, "h1", 2));
		await tick();
		expect(told(io)).toEqual([]);
		expect(io.response(1)).toEqual({ jsonrpc: "2.0", id: 1, result: summary(pi, "h1") });
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: summary(pi, "h1") });
		expect(sent(server).map(([cmd]) => cmd)).toEqual(["sessions/attach"]);
	});

	// The server's attach waits out the close's disposal and spawns afresh.
	it("binds an attach sent while a close of its ref is out, answered under the handle the server minted after it (OW-jofodu)", async () => {
		const close = held();
		const attach = held();
		const { io, server } = start({
			"sessions/attach": attaching({ summary: summary(pi, "h1") }, { summary: summary(pi, "h2"), hold: attach.hold }),
			"sessions/close": async (_params, server) => {
				await close.hold;
				server.emit({ type: "ended", session: pi, handle: "h1" });
				return null;
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/close", params: { session: pi, view: 1 } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/attach", params: { session: pi, view: 1 } });
		await tick();
		close.release();
		await io.until(4);
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: null });

		attach.release();
		await io.until(6);
		expect(io.out.slice(4).map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 3]);
		server.emit(status(pi, "h2", 2));
		await io.until(7);
		expect(told(io)).toEqual([
			["session/snapshot", "h1", 1],
			["session/detached", "h1", 1],
			["session/snapshot", "h2", 1],
			["session/status", "h2", 1],
		]);
	});

	// Another client's attach, or an opening snapshot, under h1; then another
	// client closes h1 and this attach spawns h2 (OW-savafi).
	it("answers an attach under the handle its reply names, not a handle a snapshot of its ref came under first (OW-savafi)", async () => {
		const attach = held();
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi, "h2"), hold: attach.hold }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await tick();
		server.emit(snapshot(pi, "h1"));
		attach.release();
		await io.until(2);
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 1]);
		server.emit(status(pi, "h1", 2));
		server.emit(status(pi, "h2", 2));
		await io.until(3);
		await tick();
		expect(told(io)).toEqual([
			["session/snapshot", "h2", 1],
			["session/status", "h2", 1],
		]);
	});
});

describe("requests still out (D32 point 4)", () => {
	// A second Send while the first prompt is out, as the browser's `submit`
	// refuses one (OW-nasofa): the stub server sees one prompt.
	it("refuses a second prompt from a view while its first is out busy, and sends the server one", async () => {
		const first = held();
		const { io, server } = start({
			...attachScript(pi),
			"sessions/prompt": async () => {
				await first.hold;
				return { disposition: "started" };
			},
		});
		await bindView(io, pi, 1);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/prompt", params: { session: pi, view: 1, live: true, text: "hello" } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/prompt", params: { session: pi, view: 1, live: true, text: "hello" } });
		await io.until(3);
		expect(io.response(3)!["error"]).toMatchObject({ code: -32000, data: { error: "busy" } });
		first.release();
		await io.until(4);
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: null });
		expect(sent(server).filter(([cmd]) => cmd === "sessions/prompt")).toHaveLength(1);
		// Settled, the view sends again.
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/prompt", params: { session: pi, view: 1, live: true, text: "again" } });
		await io.until(5);
		expect(io.response(4)).toEqual({ jsonrpc: "2.0", id: 4, result: null });
	});

	it("counts a fork and prompt from a view as its send still out, refusing a prompt beside it busy", async () => {
		const fork = held();
		const { io, server } = start({
			...attachScript(pi),
			"sessions/forkAndPrompt": async (_params, server) => {
				await fork.hold;
				server.emit(snapshot(codex, "h9"));
				return { session: summary(codex, "h9"), disposition: "started" };
			},
			"sessions/prompt": () => ({ disposition: "started" }),
		});
		await bindView(io, pi, 1);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/forkAndPrompt", params: { session: pi, view: 1, forkView: 7, index: 0, text: "again" } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/prompt", params: { session: pi, view: 1, live: true, text: "hello" } });
		await io.until(3);
		expect(io.response(3)!["error"]).toMatchObject({ data: { error: "busy" } });
		fork.release();
		await io.until(5);
		expect(sent(server).map(([cmd]) => cmd)).toEqual(["sessions/attach", "sessions/forkAndPrompt"]);
	});

	// Send pressed between Compact's click and its reply, before the server's
	// status says a compaction runs: held as the browser's `compacting` holds it.
	it("refuses a prompt, a fork and prompt or a second compact from a view while its compact is out busy, and sends the server none", async () => {
		const compact = held();
		const { io, server } = start({
			...attachScript(pi),
			"sessions/compact": async () => {
				await compact.hold;
				return null;
			},
			"sessions/prompt": () => ({ disposition: "started" }),
		});
		await bindView(io, pi, 1);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/compact", params: { session: pi, view: 1 } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/prompt", params: { session: pi, view: 1, live: true, text: "hello" } });
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/forkAndPrompt", params: { session: pi, view: 1, forkView: 7, index: 0, text: "again" } });
		io.send({ jsonrpc: "2.0", id: 5, method: "sessions/compact", params: { session: pi, view: 1 } });
		await io.until(5);
		for (const id of [3, 4, 5]) expect(io.response(id)!["error"]).toMatchObject({ code: -32000, data: { error: "busy" } });
		expect(sent(server).map(([cmd]) => cmd)).toEqual(["sessions/attach", "sessions/compact"]);
		compact.release();
		await io.until(6);
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: null });
		io.send({ jsonrpc: "2.0", id: 6, method: "sessions/prompt", params: { session: pi, view: 1, live: true, text: "hello" } });
		await io.until(7);
		expect(io.response(6)).toEqual({ jsonrpc: "2.0", id: 6, result: null });
	});

	// `g` twice on a preview, or a send's attach and `a`: one attach, and both
	// get its reply, the holder's view included.
	it("joins a second attach from a view to its first still out, sending the server one and answering both alike", async () => {
		const first = held();
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi, "h1"), hold: first.hold }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, view: 1 } });
		await tick();
		first.release();
		await io.until(3);
		expect(io.response(1)).toEqual({ jsonrpc: "2.0", id: 1, result: summary(pi, "h1") });
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: summary(pi, "h1") });
		expect(io.notifications().map((message) => message["method"])).toEqual(["session/snapshot"]);
		expect(sent(server).map(([cmd]) => cmd)).toEqual(["sessions/attach"]);
		// Settled, a third goes to the server, and gets the snapshot again.
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(5);
		expect(sent(server).map(([cmd]) => cmd)).toEqual(["sessions/attach", "sessions/attach"]);
	});

	it("joins an attach to the view's refused attach still out, answering it the refusal", async () => {
		const first = held();
		const { io, server } = start({
			"sessions/attach": async () => {
				await first.hold;
				throw new ApiClientError("at_capacity", "no room");
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, view: 1 } });
		await tick();
		first.release();
		await io.until(2);
		expect(io.response(2)!["error"]).toEqual(io.response(1)!["error"]);
		expect(io.response(2)!["error"]).toMatchObject({ data: { error: "at_capacity" } });
		expect(sent(server)).toHaveLength(1);
	});

	// A send from a preview while its `g` is out: the prompt waits for the
	// attach and goes under the handle it bound, never by ref.
	it("sends a prompt from a view whose attach is out under the handle that attach bound", async () => {
		const attach = held();
		const { io, server } = start({
			"sessions/attach": attaching({ summary: summary(pi, "h2"), hold: attach.hold }),
			"sessions/prompt": () => ({ disposition: "started" }),
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/prompt", params: { session: pi, view: 1, text: "hello", priorErrorId: null } });
		await tick();
		expect(sent(server).map(([cmd]) => cmd)).toEqual(["sessions/attach"]);
		attach.release();
		await io.until(3);
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 1, 2]);
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: null });
		expect(sent(server)).toEqual([
			["sessions/attach", { ref: pi }],
			["sessions/prompt", { handle: "h2", text: "hello", priorErrorId: null }],
		]);
	});

	it("refuses a prompt whose attach is refused with that refusal, sending the server no prompt", async () => {
		const attach = held();
		const { io, server } = start({
			"sessions/attach": async () => {
				await attach.hold;
				throw new ApiClientError("at_capacity", "no room");
			},
			"sessions/prompt": () => ({ disposition: "started" }),
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/prompt", params: { session: pi, view: 1, text: "hello" } });
		await tick();
		attach.release();
		await io.until(2);
		expect(io.response(2)!["error"]).toMatchObject({ code: -32000, data: { error: "at_capacity" } });
		expect(sent(server).map(([cmd]) => cmd)).toEqual(["sessions/attach"]);
	});

	// The attach's session ended before its reply, or it landed on the handle
	// another view holds (D32 point 2): the prompt goes nowhere, never by ref.
	it("refuses a prompt whose attach bound nothing not_attached, naming the view holding the handle where another does", async () => {
		const attach = held();
		const { io, server } = start({
			"sessions/attach": attaching({ summary: summary(pi, "h1") }, { summary: summary(pi, "h1"), hold: attach.hold }),
			"sessions/prompt": () => ({ disposition: "started" }),
		});
		await bindView(io, pi, 1);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, view: 2 } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/prompt", params: { session: pi, view: 2, text: "hello" } });
		await tick();
		attach.release();
		await io.until(5);
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: { ...summary(pi, "h1"), view: 1 } });
		expect(io.response(3)!["error"]).toMatchObject({ data: { error: "not_attached", attached: { ref: pi, handle: "h1", view: 1 } } });
		expect(sent(server).map(([cmd]) => cmd)).toEqual(["sessions/attach", "sessions/attach"]);
	});

	it("drops a prompt waiting on an attach its view's detach gave up", async () => {
		const attach = held();
		const { io, server } = start({
			"sessions/attach": attaching({ summary: summary(pi, "h1"), hold: attach.hold }),
			"sessions/prompt": () => ({ disposition: "started" }),
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/prompt", params: { session: pi, view: 1, text: "hello" } });
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/detach", params: { session: pi, view: 1 } });
		await tick();
		attach.release();
		await io.until(3);
		expect(io.response(2)!["error"]).toMatchObject({ data: { error: "not_attached" } });
		expect(io.notifications()).toEqual([]);
		expect(sent(server).map(([cmd]) => cmd)).toEqual(["sessions/attach"]);
	});

	// A sibling buffer previewing the edit's parent, or the parent itself, a
	// Pi parent the server has already let go of: an attach would resume its
	// old branch (D30, OW-tukuvo).
	it("refuses an attach, and a prompt by ref, of the session a fork and prompt still out forks, from any view, and none after", async () => {
		const fork = held();
		const { io, server } = start({
			...attachScript(pi),
			"sessions/forkAndPrompt": async (_params, server) => {
				await fork.hold;
				server.emit(snapshot(codex, "h9"));
				return { session: summary(codex, "h9"), disposition: "started" };
			},
			"sessions/prompt": () => ({ disposition: "started" }),
		});
		await bindView(io, pi, 1);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/forkAndPrompt", params: { session: pi, view: 1, forkView: 7, index: 0, text: "again" } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/attach", params: { session: pi, view: 2 } });
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/prompt", params: { session: pi, view: 3, text: "hello" } });
		await io.until(4);
		expect(io.response(3)!["error"]).toMatchObject({ code: -32000, data: { error: "forking" } });
		expect(io.response(4)!["error"]).toMatchObject({ code: -32000, data: { error: "forking" } });
		expect(sent(server).map(([cmd]) => cmd)).toEqual(["sessions/attach", "sessions/forkAndPrompt"]);
		fork.release();
		await io.until(6);
		io.send({ jsonrpc: "2.0", id: 5, method: "sessions/attach", params: { session: pi, view: 2 } });
		await io.until(8);
		expect(io.response(5)).toMatchObject({ result: { view: 1 } });
	});
});

describe("turn ends (D32 point 6)", () => {
	/** Each `session/turnEnded` sent so far, as its handle, `watched` and view. */
	const ended = (io: ReturnType<typeof stdio>) =>
		io
			.notifications()
			.filter((message) => message["method"] === "session/turnEnded")
			.map((message) => {
				const params = message["params"] as { handle: string; watched: boolean; view?: number };
				return [params.handle, params.watched, params.view];
			});

	const prompt = (io: ReturnType<typeof stdio>, id: number, view = 1) =>
		io.send({ jsonrpc: "2.0", id, method: "sessions/prompt", params: { session: pi, view, live: true, text: "hello" } });

	it("sends turnEnded watched for a prompt's turn seen streaming and then idle, and nothing for the idle before it streams", async () => {
		const { io, server } = start({ ...attachScript(pi), "sessions/prompt": () => ({ disposition: "started" }) });
		await bindView(io, pi, 1);
		prompt(io, 2);
		await io.until(3);
		// Still idle for a beat after the prompt (`watchSessions`): no turn's end.
		server.emit(status(pi, h(pi), 2, false));
		await io.until(4);
		server.emit(status(pi, h(pi), 3, true));
		server.emit(status(pi, h(pi), 4, false));
		await io.until(7);
		expect(io.out.at(-1)).toEqual({ jsonrpc: "2.0", method: "session/turnEnded", params: { session: pi, handle: h(pi), watched: true, view: 1 } });
		expect(ended(io)).toHaveLength(1);
		// The watch ended with that turn: the next, from elsewhere, is not watched.
		server.emit(status(pi, h(pi), 5, true));
		server.emit(status(pi, h(pi), 6, false));
		await io.until(10);
		expect(ended(io)).toEqual([
			[h(pi), true, 1],
			[h(pi), false, 1],
		]);
	});

	it("sends turnEnded unwatched, naming no view, for a session no view of Emacs's holds", async () => {
		const { io, server } = start({ "sessions/list": () => ({ sessions: [] }) });
		server.opening = [snapshot(codex)];
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list" });
		await io.until(1);
		server.emit(status(codex, h(codex), 2, true));
		server.emit(status(codex, h(codex), 3, false));
		await io.until(2);
		expect(io.out.at(-1)).toEqual({ jsonrpc: "2.0", method: "session/turnEnded", params: { session: codex, handle: h(codex), watched: false } });
	});

	it("arms from the level a prompt finds, so a steer into a running turn, or one an attach by ref finds, raises at its end", async () => {
		const { io, server } = start({
			...attachScript(pi),
			"sessions/prompt": (params, server) => {
				if (params.handle !== undefined) return { disposition: "started" };
				server.emit(snapshot(codex, h(codex), { isStreaming: true }));
				return { disposition: "started", session: summary(codex) };
			},
		});
		await bindView(io, pi, 1);
		server.emit(status(pi, h(pi), 2, true));
		await io.until(3);
		// Each turn's end is the first event after its prompt, so no fold
		// between reads the level into the watch for it.
		prompt(io, 2);
		await io.until(4);
		server.emit(status(pi, h(pi), 3, false));
		await io.until(6);
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/prompt", params: { session: codex, view: 2, text: "hello" } });
		await io.until(8);
		server.emit(status(codex, h(codex), 2, false));
		await io.until(10);
		expect(ended(io)).toEqual([
			[h(pi), true, 1],
			[h(codex), true, 2],
		]);
	});

	it("leaves no watch for the next turn after a refused prompt, and takes down only the watch a prompt armed (OW-mifuki, OW-zikiga)", async () => {
		const refusing = { now: true };
		const { io, server } = start({
			...attachScript(pi),
			"sessions/prompt": (params) => {
				if (refusing.now) throw new ApiClientError("backend_refused", "not now");
				return { disposition: params.text === "/mcp" ? "handled" : "started" };
			},
		});
		await bindView(io, pi, 1);
		prompt(io, 2);
		await io.until(3);
		server.emit(status(pi, h(pi), 2, true));
		server.emit(status(pi, h(pi), 3, false));
		await io.until(6);
		expect(ended(io)).toEqual([[h(pi), false, 1]]);

		// A prompt's turn running, a second refused and a third handled
		// beside it, each of which found the first's watch standing.
		refusing.now = false;
		prompt(io, 3);
		await io.until(7);
		server.emit(status(pi, h(pi), 4, true));
		await io.until(8);
		refusing.now = true;
		prompt(io, 4);
		await io.until(9);
		refusing.now = false;
		io.send({ jsonrpc: "2.0", id: 5, method: "sessions/prompt", params: { session: pi, view: 1, live: true, text: "/mcp" } });
		await io.until(10);
		server.emit(status(pi, h(pi), 5, false));
		await io.until(12);
		expect(ended(io)).toEqual([
			[h(pi), false, 1],
			[h(pi), true, 1],
		]);
	});

	it("drops a handled prompt's watch, and its turn's end, streamed or not, raises nothing (OW-yobayi)", async () => {
		const { io, server } = start({ ...attachScript(pi), "sessions/prompt": () => ({ disposition: "handled" }) });
		await bindView(io, pi, 1);
		prompt(io, 2);
		await io.until(3);
		server.emit(status(pi, h(pi), 2, true));
		server.emit(status(pi, h(pi), 3, false));
		await io.until(6);
		expect(ended(io)).toEqual([[h(pi), false, 1]]);
	});

	it("arms a fork and prompt's fork at the reply, and with stops abandons the parent's watch as it goes out", async () => {
		const { io, server } = start({
			...attachScript(pi),
			"sessions/prompt": () => ({ disposition: "started" }),
			"sessions/forkAndPrompt": (params, server) => {
				const fork = params.index === 0 ? "h8" : "h9";
				server.emit(snapshot(codex, fork, { isStreaming: true }));
				return { session: summary(codex, fork), disposition: "started" };
			},
		});
		await bindView(io, pi, 1);
		prompt(io, 2);
		await io.until(3);
		server.emit(status(pi, h(pi), 2, true));
		await io.until(4);
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/forkAndPrompt", params: { session: pi, view: 1, forkView: 7, index: 0, text: "again" } });
		await io.until(6);
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/forkAndPrompt", params: { session: pi, view: 1, forkView: 8, index: 1, text: "again", stops: true } });
		await io.until(8);
		expect(sent(server)).toContainEqual(["sessions/forkAndPrompt", { handle: h(pi), index: 1, text: "again" }]);
		server.emit(status(codex, "h8", 2, false));
		server.emit(status(codex, "h9", 2, false));
		server.emit(status(pi, h(pi), 3, false));
		await io.until(14);
		expect(ended(io)).toEqual([
			["h8", true, 7],
			["h9", true, 8],
			[h(pi), false, 1],
		]);
	});

	it("drops a view's watch at its detach and at a gap, each raising nothing, where one left standing raises", async () => {
		const { io, server } = start({
			"sessions/attach": attaching({ summary: summary(pi) }, { summary: summary(codex) }, { summary: summary(pi, "h3") }),
			"sessions/prompt": () => ({ disposition: "started" }),
		});
		await bindView(io, pi, 1);
		await bindView(io, codex, 2);
		await bindView(io, pi, 3);
		for (const [id, view] of [[2, 1], [3, 2], [4, 3]] as const) prompt(io, id, view);
		await io.until(9);
		server.emit(status(pi, h(pi), 2, true));
		server.emit(status(codex, h(codex), 2, true));
		server.emit(status(pi, "h3", 2, true));
		await io.until(12);
		io.send({ jsonrpc: "2.0", id: 5, method: "sessions/detach", params: { session: pi, view: 1 } });
		await io.until(13);
		// The gap: seq 4 where 3 was due.
		server.emit(status(pi, "h3", 4, false));
		server.emit(status(pi, h(pi), 3, false));
		server.emit(status(codex, h(codex), 3, false));
		await io.until(17);
		expect(io.notifications().filter((message) => message["method"] === "session/detached")).toMatchObject([{ params: { view: 3, handle: "h3" } }]);
		// Attached again under the same handle, which a gap leaves live, a
		// turn seen streaming and then idle is not the one watched (D25 point 5).
		await bindView(io, pi, 3);
		server.emit(status(pi, "h3", 2, true));
		server.emit(status(pi, "h3", 3, false));
		await io.until(22);
		expect(ended(io)).toEqual([
			[h(pi), false, undefined],
			[h(codex), true, 2],
			["h3", false, 3],
		]);
	});

	it("raises a watch seen streaming at the server's ended, ahead of the detached", async () => {
		const { io, server } = start({ ...attachScript(pi), "sessions/prompt": () => ({ disposition: "started" }) });
		await bindView(io, pi, 1);
		prompt(io, 2);
		await io.until(3);
		server.emit(status(pi, h(pi), 2, true));
		server.emit({ type: "ended", session: pi, handle: h(pi) });
		await io.until(6);
		expect(io.notifications().slice(-2).map((message) => message["method"])).toEqual(["session/turnEnded", "session/detached"]);
		expect(ended(io)).toEqual([[h(pi), true, 1]]);
	});

	it("raises each watch that has seen streaming at a socket close, a prompt still out included, before it exits (D31 point 6)", async () => {
		const { io, server, done } = start({
			"sessions/attach": attaching({ summary: summary(pi) }, { summary: summary(codex) }),
			"sessions/prompt": (params) => (params.handle === h(pi) ? new Promise<never>(() => {}) : { disposition: "started" }),
		});
		await bindView(io, pi, 1);
		await bindView(io, codex, 2);
		prompt(io, 2, 1);
		prompt(io, 3, 2);
		await io.until(5);
		server.emit(status(pi, h(pi), 2, true));
		await io.until(6);
		server.drop(1006);
		expect(await settled(done)).toBe("resolved");
		stop = null;
		// The codex watch never saw its turn stream, and raises nothing.
		expect(ended(io)).toEqual([[h(pi), true, 1]]);
		// The prompt still out is answered after the raise, its outcome unknown (D32 point 7).
		const raised = io.out.findIndex((message) => message["method"] === "session/turnEnded");
		const answered = io.out.findIndex((message) => message["id"] === 2);
		expect(io.response(2)).toMatchObject({ error: { code: -32001 } });
		expect(raised).toBeLessThan(answered);
	});

	it("sends nothing when its input ends, a watch that has seen streaming standing (D25 point 4)", async () => {
		const { io, server, done } = start({ ...attachScript(pi), "sessions/prompt": () => ({ disposition: "started" }) });
		await bindView(io, pi, 1);
		prompt(io, 2);
		await io.until(3);
		server.emit(status(pi, h(pi), 2, true));
		await io.until(4);
		io.end();
		expect(await settled(done)).toBe("resolved");
		stop = null;
		await tick();
		expect(ended(io)).toEqual([]);
	});
});

describe("fork points (D33 point 4)", () => {
	/** The `sessions/forkPoints` the helper has sent the server, each as its params. */
	const fetches = (server: SocketServer) => server.calls.filter(({ cmd }) => cmd === "sessions/forkPoints").map(({ params }) => params);
	/** Each `session/forkPoints` sent so far, as its params. */
	const sets = (io: ReturnType<typeof stdio>) =>
		io
			.notifications()
			.filter((message) => message["method"] === "session/forkPoints")
			.map((message) => message["params"]);
	/** A `sessions/forkPoints` script whose calls each wait on the next of `holds`, answering `index` and `index + 2`. */
	const holding = (...holds: Promise<void>[]): Script => {
		let index = 0;
		return {
			"sessions/forkPoints": async () => {
				const at = index++;
				await holds[at];
				return { points: [{ id: `e${at}`, text: "hi", index: at }, { id: `f${at}`, text: "hi", index: at + 2 }], forkStopsTurn: at > 0 };
			},
		};
	};

	it("fetches a bound view's points at its snapshot and at each streaming edge, one out per handle, and sends each set under the view", async () => {
		const first = held();
		const second = held();
		const third = held();
		const { io, server } = start({ ...attachScript(pi), ...holding(first.hold, second.hold, third.hold) }, render, true);
		await bindView(io, pi, 1);
		await vi.waitFor(() => expect(fetches(server)).toEqual([{ handle: h(pi) }]));
		first.release();
		await vi.waitFor(() => expect(sets(io)).toHaveLength(1));
		expect(sets(io)[0]).toEqual({ session: pi, view: 1, handle: h(pi), indices: [0, 2], forkStopsTurn: false });

		// A turn starts: a fetch. It ends while that one is out: none.
		server.emit(status(pi, h(pi), 2, true));
		await vi.waitFor(() => expect(fetches(server)).toHaveLength(2));
		server.emit(status(pi, h(pi), 3, false));
		await tick();
		expect(fetches(server)).toHaveLength(2);
		second.release();
		await vi.waitFor(() => expect(sets(io)).toHaveLength(2));
		expect(sets(io)[1]).toEqual({ session: pi, view: 1, handle: h(pi), indices: [1, 3], forkStopsTurn: true });

		// Nothing out now, so the next edge fetches again; a status that moves no level does not.
		server.emit(status(pi, h(pi), 4, false));
		await tick();
		expect(fetches(server)).toHaveLength(2);
		server.emit(status(pi, h(pi), 5, true));
		await vi.waitFor(() => expect(fetches(server)).toHaveLength(3));
		third.release();
	});

	it("fetches nothing for a preview, nor for a session no view of Emacs's is bound to", async () => {
		const { io, server } = start({ "sessions/list": () => ({ sessions: [] }), ...holding() }, render, true);
		server.opening = [snapshot(codex)];
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list" });
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/preview", params: { session: pi } });
		await io.until(2);
		server.emit(status(codex, h(codex), 2, true));
		server.emit(status(codex, h(codex), 3, false));
		await io.until(3);
		await tick();
		expect(fetches(server)).toEqual([]);
		expect(sets(io)).toEqual([]);
	});

	it("says nothing of a fetch that fails, and the next edge fetches again", async () => {
		let calls = 0;
		const { io, server } = start(
			{
				...attachScript(pi),
				"sessions/forkPoints": () => {
					calls += 1;
					throw new ApiClientError("backend_refused", "no points today");
				},
			},
			render,
			true,
		);
		await bindView(io, pi, 1);
		await vi.waitFor(() => expect(calls).toBe(1));
		await tick();
		server.emit(status(pi, h(pi), 2, true));
		await vi.waitFor(() => expect(calls).toBe(2));
		await tick();
		expect(sets(io)).toEqual([]);
		expect(io.out.filter((message) => "error" in message)).toEqual([]);
	});
});

describe("the node throttle (OW-jeruye)", () => {
	const turn = fixtureMessages().at(-1) as AssistantMessage;
	const user: PaneMessage = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 };
	const said = (text: string) => ({ ...turn, content: [{ type: "text", text }], stopReason: "pending" }) as PaneMessage;
	const nodeOf = (message: Record<string, unknown>) => (message["params"] as { node: TranscriptNode }).node;
	const textOf = (message: Record<string, unknown>) => nodeOf(message).parts.flatMap((part) => (part.type === "text" ? [part.text] : []));

	/** Text whose rendering throws. */
	const unrenderable = "unrenderable";

	/** Attached to `pi`, streaming, a user turn drawn; the interval runs on fake timers from here on, and only what renders after this counts. */
	async function streaming(script: Script = {}) {
		const rendered: string[] = [];
		const started = start(
			{
				"sessions/attach": (_params, server) => {
					server.emit(snapshot(pi, h(pi), { messages: [user], isStreaming: true }));
					return { session: summary(pi) };
				},
				...script,
			},
			(markdown) => {
				if (markdown === unrenderable) throw new Error("render failed");
				rendered.push(markdown);
				return `stub:${markdown}`;
			},
		);
		const { io, server } = started;
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		await io.until(2);
		rendered.length = 0;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let seq = 1;
		const upsert = (index: number, message: PaneMessage) => server.emit({ type: "upsert", session: pi, handle: h(pi), seq: ++seq, index, message });
		const statusTo = (isStreaming: boolean) => server.emit(status(pi, h(pi), ++seq, isStreaming));
		/** What went out after the snapshot and the attach reply. */
		const since = () => io.out.slice(2).map((message) => message["method"] ?? message["id"]);
		return { ...started, rendered, upsert, statusTo, since };
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

	it("sends a held node before it exits at a close of the socket (D25)", async () => {
		const { io, server, done, upsert, since } = await streaming();
		upsert(1, said("a"));
		upsert(1, said("ab"));
		server.drop(1006);
		await done;
		expect(since()).toEqual(["session/node"]);
		expect(textOf(io.out.at(-1)!)).toEqual(["ab"]);
	});

	it("sends a held node before the status written after it", async () => {
		const { io, upsert, statusTo, since } = await streaming();
		upsert(1, said("a"));
		upsert(1, said("ab"));
		statusTo(false);
		expect(since()).toEqual(["session/node", "session/status", "session/turnEnded"]);
		expect(textOf(io.out[2]!)).toEqual(["ab"]);
		vi.advanceTimersByTime(250);
		expect(since()).toHaveLength(3);
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
		const { io, upsert, since } = await streaming({ "sessions/prompt": () => ({ disposition: "started" }) });
		upsert(1, said("a"));
		upsert(1, said("ab"));
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/prompt", params: { session: pi, view: 1, live: true, text: "more" } });
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
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/detach", params: { session: pi, view: 1 } });
		await settle();
		vi.advanceTimersByTime(250);
		expect(since()).toEqual([2]);
	});

	it("sends a held node before a notification for another attached session", async () => {
		const { io, server } = start({
			"sessions/attach": ({ ref }, server) => {
				server.emit(snapshot(ref, h(ref), ref.backend === "pi" ? { messages: [user], isStreaming: true } : {}));
				return { session: summary(ref) };
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, view: 1 } });
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: codex, view: 2 } });
		await io.until(4);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		server.emit({ type: "upsert", session: pi, handle: h(pi), seq: 2, index: 1, message: said("a") });
		server.emit(status(codex, h(codex), 2));
		expect(io.out.slice(4).map((message) => [message["method"], (message["params"] as { handle: string }).handle])).toEqual([
			["session/node", h(pi)],
			["session/status", h(codex)],
		]);
	});

	it("never sends a node held for a session whose handle its close ended, only the detached and the reply", async () => {
		const { io, upsert, since } = await streaming({
			"sessions/close": (_params, server) => {
				server.emit({ type: "ended", session: pi, handle: h(pi) });
				return null;
			},
		});
		upsert(1, said("a"));
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/close", params: { session: pi, view: 1 } });
		await settle();
		vi.advanceTimersByTime(250);
		expect(since()).toEqual(["session/detached", 2]);
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
		const { io, upsert, since } = await streaming({ "sessions/prompt": () => ({ disposition: "started" }) });
		upsert(1, said(unrenderable));
		upsert(2, { role: "user", content: [{ type: "text", text: "next" }], timestamp: 2 });
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/prompt", params: { session: pi, view: 1, live: true, text: "more" } });
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

	it("rides every per-session notification, taken from the event it answers, beside the view (D32 point 1)", async () => {
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(virtual, handle) }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual, view: 1 } });
		await io.until(2);
		server.emit(snapshot(pi, handle, { seq: 0 }));
		server.emit({ type: "upsert", session: pi, handle, seq: 1, index: 0, message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 } });
		server.emit(status(pi, handle, 2));
		server.emit({ type: "error", session: pi, handle, seq: 3, message: "boom", errorId: "e1" });
		server.emit({ type: "notice", session: pi, handle, seq: 4, notice: { kind: "warning", message: "careful", details: null, path: null } });
		server.emit({ type: "error-cleared", session: pi, handle, seq: 5 });
		server.emit({ type: "sessions-changed" });
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
		for (const message of perSession) expect(message["params"]).toMatchObject({ view: 1, handle });
	});

	it("rides the summary sessions/attach answers, and the snapshot it sends before the reply", async () => {
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io } = start({ "sessions/attach": attaching({ summary: summary(pi, handle) }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: alias, view: 1 } });
		await io.until(2);
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 1]);
		expect(io.out[0]).toMatchObject({ params: { session: pi, view: 1, handle } });
		expect(io.response(1)).toEqual({ jsonrpc: "2.0", id: 1, result: summary(pi, handle) });
	});
});

describe("shutdown", () => {
	it("closes the socket and resolves when the input ends", async () => {
		const { io, server, done } = start({ "sessions/list": () => ({ sessions: [] }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list" });
		await io.until(1);
		io.end();
		await done;
		stop = null;
		expect(server.sockets[0]!.closedWith).toMatchObject({ code: 1000 });
	});

	// The connection lost says nothing of whether the request reached a
	// backend, so the answer carries the helper's own code and no `data`,
	// never a refusal, and goes out before the helper resolves (D32 point 7).
	it.each([
		["the input ends", (_server: SocketServer, io: ReturnType<typeof stdio>) => io.end()],
		["the socket closes", (server: SocketServer) => server.drop(1006)],
	])("answers each request still out when %s with the helper's code, before it resolves (D32 point 7)", async (_, ending) => {
		const { io, server, done } = start({
			"sessions/list": () => new Promise<never>(() => {}),
			"models/list": () => new Promise<never>(() => {}),
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list" });
		io.send({ jsonrpc: "2.0", id: 2, method: "models/list", params: { backend: "pi" } });
		await vi.waitFor(() => expect(server.calls).toHaveLength(2));
		// Read as the helper resolves, before anything queued behind it runs.
		const answers = done.then(() => [1, 2].map((id) => io.response(id)));
		ending(server, io);
		expect(await settled(done)).toBe("resolved");
		stop = null;
		for (const answer of await answers) {
			const { error } = answer as { error: Record<string, unknown> };
			expect(error["code"]).toBe(-32001);
			expect(error).not.toHaveProperty("data");
		}
	});

	// A chunk the input delivered before the teardown cancelled it is still
	// read. It is sent nowhere, and answered as the refusal it is (OW-nuzoto).
	it("sends nowhere a request read after the socket closed, and answers it unreachable", async () => {
		const { io, server, done } = start({ "sessions/list": () => new Promise<never>(() => {}) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list" });
		await vi.waitFor(() => expect(server.calls).toHaveLength(1));

		// In one synchronous run: the chunk is delivered, then the socket closes.
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/prompt", params: { session: pi, view: 1, text: "hello" } });
		server.drop(1006);
		expect(await settled(done)).toBe("resolved");
		stop = null;
		await tick();
		expect(server.calls.map((call) => call.cmd)).toEqual(["sessions/list"]);
		expect(io.response(2)).toMatchObject({ error: { data: { error: "unreachable" } } });
	});
});
