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

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
	vi.useRealTimers();
	await stop?.();
	stop = null;
});

function start(script: Script = {}, renderMarkdown: Render = render) {
	const io = stdio();
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

/** The commands the server was sent, each as its name and params. */
const sent = (server: SocketServer) => server.calls.map(({ cmd, params }) => [cmd, params]);

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
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, token: 2 } });
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

	it("forwards each verb as its command, a live session's by its handle alone, and answers null where the command returns nothing (D31 point 9)", async () => {
		const model = { id: "m", label: "M", efforts: [{ id: "low", description: "Fast" }], defaultEffort: "low" };
		const { io, server } = start({
			"models/list": () => ({ models: [model] }),
			"sessions/prompt": () => ({ disposition: "started" }),
			"sessions/abort": () => ({ queued: ["first steer", "second steer"] }),
			"sessions/compact": () => null,
			"sessions/close": () => null,
			"sessions/setModel": () => null,
			"sessions/setEffort": () => null,
			"sessions/setName": () => null,
			"sessions/forkPoints": () => ({ points: [{ id: "e1", text: "hi", index: 0 }], forkStopsTurn: true }),
			"sessions/fork": () => ({ ref: codex }),
			"sessions/dismissError": () => null,
		});
		const handle = h(pi);
		const requests = [
			["models/list", { backend: "pi" }, [model], ["models/list", { backend: "pi" }]],
			// The error the buffer held at the send goes with the prompt, so admitting
			// it clears only that one (OW-jokoto).
			["sessions/prompt", { session: pi, handle, text: "hello", priorErrorId: "e4" }, null, ["sessions/prompt", { handle, text: "hello", priorErrorId: "e4" }]],
			// The prompts the stop took out of Pi's queue come back to the caller (OW-wisifo).
			["sessions/abort", { session: pi, handle }, { queued: ["first steer", "second steer"] }, ["sessions/abort", { handle }]],
			["sessions/compact", { session: pi, handle }, null, ["sessions/compact", { handle }]],
			// A close names the ref (ark3/agentpane#27).
			["sessions/close", { session: pi, handle }, null, ["sessions/close", { ref: pi }]],
			["sessions/setModel", { session: pi, handle, model: "m" }, null, ["sessions/setModel", { handle, model: "m" }]],
			["sessions/setEffort", { session: pi, handle, effort: "low" }, null, ["sessions/setEffort", { handle, effort: "low" }]],
			["sessions/setName", { session: pi, handle, name: "probe name" }, null, ["sessions/setName", { handle, name: "probe name" }]],
			// The whole answer, so agentpane-mode can label a fork from it (D30).
			["sessions/forkPoints", { session: pi, handle }, { points: [{ id: "e1", text: "hi", index: 0 }], forkStopsTurn: true }, ["sessions/forkPoints", { handle }]],
			["sessions/fork", { session: pi, handle, entryId: "e1" }, codex, ["sessions/fork", { handle, entryId: "e1" }]],
			// Named by id, so the server clears it only while it is still the one held (OW-desufa, OW-jokoto).
			["sessions/dismissError", { session: pi, handle, errorId: "e4" }, null, ["sessions/dismissError", { handle, errorId: "e4" }]],
		] as const;
		for (const [index, [method, params]] of requests.entries()) io.send({ jsonrpc: "2.0", id: index + 10, method, params });
		await io.until(requests.length);
		for (const [index, [, , result, command]] of requests.entries()) {
			expect(io.response(index + 10)).toEqual({ jsonrpc: "2.0", id: index + 10, result });
			expect(sent(server)).toContainEqual(command);
		}
	});

	it("answers sessions/prompt with the disposition for a prompt handled without a turn, and null for a started one (OW-dulipe)", async () => {
		const { io } = start({ "sessions/prompt": (params) => ({ disposition: params.text === "/mcp" ? "handled" : "started" }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/prompt", params: { session: pi, handle: h(pi), text: "/mcp" } });
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/prompt", params: { session: pi, handle: h(pi), text: "hello" } });
		await io.until(2);
		expect(io.response(1)).toEqual({ jsonrpc: "2.0", id: 1, result: { disposition: "handled" } });
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: null });
	});

	/**
	 * A prompt naming no handle attaches its session for the buffer that sent
	 * the token (D30): the snapshot carrying it binds that buffer as an
	 * attach's does (D25), and goes out before the reply, the disposition alone.
	 */
	it("names the ref of a prompt naming no handle, and sends the snapshot that attaches its session, carrying its token, before the reply (D30)", async () => {
		const { io, server } = start({
			"sessions/prompt": (_params, server) => {
				server.emit(snapshot(pi, "h9"));
				return { disposition: "started", session: summary(pi, "h9") };
			},
		});
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/prompt", params: { session: pi, text: "hello", priorErrorId: null, token: 7 } });
		await io.until(2);
		expect(io.out[0]).toMatchObject({ method: "session/snapshot", params: { session: pi, handle: "h9", token: 7 } });
		expect(io.out[1]).toEqual({ jsonrpc: "2.0", id: 4, result: null });
		expect(sent(server)).toEqual([["sessions/prompt", { ref: pi, text: "hello", priorErrorId: null }]]);
	});

	it("answers a handled prompt naming no handle with the disposition alone (D30)", async () => {
		const { io } = start({
			"sessions/prompt": (_params, server) => {
				server.emit(snapshot(pi, "h9"));
				return { disposition: "handled", session: summary(pi, "h9") };
			},
		});
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/prompt", params: { session: pi, text: "/mcp", token: 7 } });
		await io.until(2);
		expect(io.out[1]).toEqual({ jsonrpc: "2.0", id: 4, result: { disposition: "handled" } });
	});

	it("carries the session a refused prompt naming no handle attached in the error's data, after its snapshot (D30)", async () => {
		const attached = { ref: pi, handle: "h9" };
		const { io } = start({
			"sessions/prompt": (_params, server) => {
				server.emit(snapshot(pi, "h9"));
				throw new ApiClientError("backend_refused", "not now", undefined, attached);
			},
		});
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/prompt", params: { session: pi, text: "hello", token: 7 } });
		await io.until(2);
		expect(io.out[0]).toMatchObject({ method: "session/snapshot", params: { handle: "h9", token: 7 } });
		expect(io.out[1]).toEqual({
			jsonrpc: "2.0",
			id: 4,
			error: { code: -32000, message: "not now", data: { error: "backend_refused", detail: "not now", attached } },
		});
	});

	it("carries a server refusal through as a JSON-RPC error with the server's code and text", async () => {
		const { io } = start({
			"sessions/prompt": () => {
				throw new ApiClientError("turn_active", "a turn is already running");
			},
		});
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/prompt", params: { session: pi, handle: h(pi), text: "again" } });
		await io.until(1);
		expect(io.response(3)).toEqual({
			jsonrpc: "2.0",
			id: 3,
			error: { code: -32000, message: "a turn is already running", data: { error: "turn_active", detail: "a turn is already running" } },
		});
	});

	/**
	 * A create starts the session and attaches it (D30): its snapshot, carrying
	 * the token, binds the new buffer as an attach's does (D25), and goes out
	 * before the reply. The token goes nowhere but back.
	 */
	it("sends the snapshot that attaches a created session, carrying its token, before the reply (D30)", async () => {
		const created = summary(pi, "h9");
		const { io, server } = start({
			"sessions/create": (_params, server) => {
				server.emit(snapshot(pi, "h9"));
				return { session: created };
			},
		});
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/create", params: { cwd: "/work", backend: "pi", token: 7 } });
		await io.until(2);
		expect(io.out[0]).toMatchObject({ method: "session/snapshot", params: { session: pi, handle: "h9", token: 7 } });
		expect(io.out[1]).toEqual({ jsonrpc: "2.0", id: 4, result: created });
		expect(sent(server)).toEqual([["sessions/create", { cwd: "/work", backend: "pi" }]]);
	});

	it("binds nothing for a refused create (D30)", async () => {
		const { io } = start({
			"sessions/create": () => {
				throw new ApiClientError("internal_error", "sbox: no git root");
			},
		});
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/create", params: { cwd: "/work", backend: "pi", token: 7 } });
		await io.until(1);
		expect(io.notifications()).toEqual([]);
		expect(io.response(4)!["error"]).toMatchObject({ data: { error: "internal_error", detail: "sbox: no git root" } });
	});

	it("sends the snapshot that attaches a fork, carrying its token, before the fork-and-prompt's reply, and feeds the fork after (D30)", async () => {
		const reply = { session: summary(codex, "h9"), disposition: "started" as const };
		const { io, server } = start({
			"sessions/forkAndPrompt": (_params, server) => {
				server.emit(snapshot(codex, "h9", { isStreaming: true }));
				return reply;
			},
		});
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/forkAndPrompt", params: { session: pi, handle: h(pi), index: 2, text: "again", token: 7 } });
		await io.until(2);
		expect(io.out[0]).toMatchObject({ method: "session/snapshot", params: { session: codex, handle: "h9", token: 7, isStreaming: true } });
		expect(io.out[1]).toEqual({ jsonrpc: "2.0", id: 4, result: reply });
		expect(sent(server)).toEqual([["sessions/forkAndPrompt", { handle: h(pi), index: 2, text: "again" }]]);
		server.emit(status(codex, "h9", 2, false));
		await io.until(3);
		expect(io.out[2]).toMatchObject({ method: "session/status", params: { handle: "h9", isStreaming: false } });
	});

	/** A fork attached and then not prompted is bound before its refusal goes out, so Emacs can move to it (D30). */
	it("carries the fork a refused fork-and-prompt names in the error's data, after the snapshot that attaches it (D30)", async () => {
		const fork = { ref: codex, handle: "h9" };
		const { io } = start({
			"sessions/forkAndPrompt": (_params, server) => {
				server.emit(snapshot(codex, "h9"));
				throw new ApiClientError("backend_refused", "not now", fork);
			},
		});
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/forkAndPrompt", params: { session: pi, handle: h(pi), index: 0, text: "again", token: 7 } });
		await io.until(2);
		expect(io.out[0]).toMatchObject({ method: "session/snapshot", params: { handle: "h9", token: 7 } });
		expect(io.out[1]).toEqual({
			jsonrpc: "2.0",
			id: 4,
			error: { code: -32000, message: "not now", data: { error: "backend_refused", detail: "not now", fork } },
		});
	});

	it("binds nothing for a refusal naming a fork whose own start failed, or none (D30)", async () => {
		const refusals = [
			new ApiClientError("internal_error", "spawn failed", { ref: codex, handle: null }),
			new ApiClientError("not_a_fork_point", "no point"),
		];
		const { io } = start({
			"sessions/forkAndPrompt": () => {
				throw refusals.shift()!;
			},
		});
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/forkAndPrompt", params: { session: pi, handle: h(pi), index: 0, text: "again", token: 7 } });
		io.send({ jsonrpc: "2.0", id: 5, method: "sessions/forkAndPrompt", params: { session: pi, handle: h(pi), index: 3, text: "again", token: 8 } });
		await io.until(2);
		expect(io.notifications()).toEqual([]);
		expect(io.response(4)!["error"]).toMatchObject({ data: { error: "internal_error", fork: { ref: codex, handle: null } } });
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
	it("sends the attach's snapshot, tagged with its token, before its reply, and when the interval ends one node carrying the last upsert", async () => {
		const messages = fixtureMessages();
		const tail = messages.length - 1;
		const final = messages[tail] as AssistantMessage;
		const { io, server } = start({
			"sessions/attach": (_params, server) => {
				server.emit(snapshot(codex, h(codex), { messages: messages.slice(0, tail), isStreaming: true, model: "m" }));
				return { session: summary(codex) };
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: codex, token: 1 } });
		await io.until(2);
		expect(io.out[0]).toMatchObject({ method: "session/snapshot", params: { session: codex, token: 1, isStreaming: true, compaction: null, model: "m" } });
		expect((io.out[0]!["params"] as { nodes: TranscriptNode[] }).nodes.map((node) => node.index)).toEqual(messages.slice(0, tail).map((_, index) => index));
		expect(io.out[1]).toEqual({ jsonrpc: "2.0", id: 1, result: summary(codex) });

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const partial = { ...final, content: [{ type: "text", text: "par" }], stopReason: "pending" } as PaneMessage;
		server.emit({ type: "upsert", session: codex, handle: h(codex), seq: 2, index: tail, message: partial });
		server.emit({ type: "upsert", session: codex, handle: h(codex), seq: 3, index: tail, message: final });
		expect(io.notifications()).toHaveLength(1);
		vi.advanceTimersByTime(250);
		const [, node] = io.notifications();
		expect(node).toMatchObject({ method: "session/node", params: { session: codex, node: { index: tail, role: "assistant" } } });
		const texts = (node!["params"] as { node: TranscriptNode }).node.parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
		expect(texts).toEqual(final.content.flatMap((block) => (block.type === "text" ? [block.text] : [])));
		expect(io.notifications()).toHaveLength(2);
	});

	// A session already live: the opening snapshot formed its view, and the
	// attach broadcasts one more before it answers.
	it("answers an attach of a session already live from the view the reducer holds, tagged with its token", async () => {
		const { io, server } = start(attachScript(pi));
		server.opening = [snapshot(pi, h(pi), { isStreaming: true })];
		await tick();
		expect(io.out).toEqual([]);
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 1]);
		expect(io.out[0]).toMatchObject({ params: { handle: h(pi), token: 1 } });
	});

	it("detaches a session whose seq gaps, attaching nothing, and says nothing more under it until Emacs attaches it again (OW-filuge)", async () => {
		const { io, server } = start(attachScript(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);

		server.emit(status(pi, h(pi), 3));
		await io.until(3);
		expect(io.notifications()[1]).toEqual({ jsonrpc: "2.0", method: "session/detached", params: { session: pi, handle: h(pi), cause: "gapped" } });
		// A later event under the handle finds no view to gap against again.
		server.emit(status(pi, h(pi), 4, false));
		// A gap in a view Emacs never attached is told nothing.
		server.emit(snapshot(codex));
		server.emit(status(codex, h(codex), 5));
		await tick();
		expect(sent(server)).toHaveLength(1);
		expect(io.notifications()).toHaveLength(2);

		// `a` or a send: the attach broadcasts a snapshot, which forms the view again.
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, token: 2 } });
		await io.until(5);
		expect(io.notifications()[2]).toMatchObject({ method: "session/snapshot", params: { session: pi, handle: h(pi), token: 2 } });
		expect(sent(server).map(([cmd]) => cmd)).toEqual(["sessions/attach", "sessions/attach"]);
	});

	it("sends nothing from the gapped view when the attach after it is answered under the rename the gap swallowed (OW-filuge)", async () => {
		const renamed: SessionRef = { backend: "pi", id: "/tmp/renamed.jsonl" };
		const { io, server } = start({
			"sessions/attach": attaching({ summary: summary(pi, h(pi)) }, { summary: summary(renamed, h(pi)) }),
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);
		server.emit(status(renamed, h(pi), 3));
		await io.until(3);

		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, token: 2 } });
		await io.until(5);
		await tick();
		expect(io.out.slice(2).map((message) => message["method"] ?? message["id"])).toEqual(["session/detached", "session/snapshot", 2]);
		expect(io.out[3]).toMatchObject({ params: { session: renamed, handle: h(pi), token: 2 } });
	});

	// The reply is handled after the events ahead of it, and under Bun 1.4.0
	// after the next message's handler too (D31 point 4): one that ended the
	// handle, or gapped it, leaves no view for the reply to bind.
	it.each([
		["ended", (server: SocketServer) => server.emit({ type: "ended", session: pi, handle: h(pi) })],
		["gapped", (server: SocketServer) => server.emit(status(pi, h(pi), 5))],
	])("records no attachment for an attach whose handle %s between its snapshot and its reply", async (_, between) => {
		const { io, server } = start({
			"sessions/attach": (_params, server) => {
				server.emit(snapshot(pi));
				between(server);
				return { session: summary(pi) };
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(1);
		server.emit(snapshot(pi, h(pi), { seq: 6 }));
		server.emit(status(pi, h(pi), 7));
		await tick();
		expect(io.out).toEqual([{ jsonrpc: "2.0", id: 1, result: summary(pi) }]);
	});

	it("tags the snapshot that answers each attach on one handle with that attach's token (OW-rebawa, OW-wukako)", async () => {
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io } = start({ "sessions/attach": attaching({ summary: summary(pi) }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: alias, token: 2 } });
		await io.until(5);
		// The second attach's snapshot goes to the attachment under the handle
		// as it arrives, untagged; the reply then answers the attach, tagged.
		expect(io.out.map((message) => [message["method"] ?? message["id"], (message["params"] as { token?: number } | undefined)?.token])).toEqual([
			["session/snapshot", 1],
			[1, undefined],
			["session/snapshot", undefined],
			["session/snapshot", 2],
			[2, undefined],
		]);
	});

	it("says nothing for a session Emacs never attached, and nothing more after sessions/close", async () => {
		const { io, server } = start({
			"sessions/attach": (_params, server) => {
				server.emit(snapshot(codex));
				server.emit(status(codex, h(codex), 2));
				server.emit(snapshot(pi));
				return { session: summary(pi) };
			},
			"sessions/close": () => null,
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);
		expect(io.notifications()).toEqual([
			{ jsonrpc: "2.0", method: "session/snapshot", params: { session: pi, handle: h(pi), token: 1, nodes: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: null, errorId: null, notices: [] } },
		]);

		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/close", params: { session: pi, handle: h(pi), tokens: [1] } });
		await io.until(3);
		server.emit(status(pi, h(pi), 2));
		await tick();
		expect(io.notifications()).toHaveLength(1);
	});

	it("says nothing more after sessions/detach, which sends nothing, nor for an attach in flight across it", async () => {
		const attach = held();
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi), hold: attach.hold }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/detach", params: { session: pi, tokens: [1] } });
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

	it("forwards the snapshot under the handle that names a rename, and nothing beside it", async () => {
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, server } = start(attachScript(virtual));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual, token: 1 } });
		await io.until(2);
		server.emit(snapshot(pi, h(virtual), { seq: 0, isStreaming: true }));
		await io.until(3);
		await tick();
		expect(io.notifications().map((message) => message["method"])).toEqual(["session/snapshot", "session/snapshot"]);
		expect(io.notifications()[1]).toMatchObject({ params: { session: pi, handle: h(virtual), isStreaming: true } });
		expect(io.notifications()[1]!["params"]).not.toHaveProperty("token");
	});

	it("stops on a sessions/detach carrying the token of the attach a snapshot answered, whatever ref it names (OW-linowe)", async () => {
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, server } = start(attachScript(virtual));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual, token: 1 } });
		await io.until(2);
		server.emit(snapshot(pi, h(virtual), { seq: 0 }));
		await io.until(3);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/detach", params: { session: virtual, tokens: [1] } });
		await io.until(4);
		server.emit(status(pi, h(virtual), 1));
		await tick();
		expect(io.notifications().map((message) => message["method"])).toEqual(["session/snapshot", "session/snapshot"]);
	});

	// OW-wedeli: resolved by the ref alone, a detach naming the ref from
	// before a rename matched nothing and the session went on being forwarded;
	// from then until OW-nowihu the handle stopped it, silencing a buffer whose
	// attach was answered under it after the detaching buffer's.
	it("stops nothing on a sessions/detach carrying the handle and no token (OW-nowihu)", async () => {
		const { io, server } = start(attachScript(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/detach", params: { session: pi, handle: h(pi) } });
		await io.until(3);
		server.emit(status(pi, h(pi), 2, false));
		await io.until(4);
		expect(io.notifications().map((message) => message["method"])).toEqual(["session/snapshot", "session/status"]);
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
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, token: 2 } });
		await io.until(3);
		expect(io.response(2)!["error"]).toBeDefined();
		server.emit(status(pi, h(pi), 2));
		await io.until(4);
		expect(io.notifications().map((message) => message["method"])).toEqual(["session/snapshot", "session/status"]);
	});

	it("answers an attach through an alias under the ref its reply names, tagged with the attach's token, and tags nothing after it", async () => {
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi) }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: alias, token: 1 } });
		await io.until(2);
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 1]);
		expect(io.out[0]).toMatchObject({ params: { session: pi, handle: h(pi), token: 1 } });
		expect(io.out[1]).toMatchObject({ id: 1, result: { ref: pi, handle: h(pi) } });

		server.emit(status(pi, h(pi), 2, false));
		server.emit(snapshot(pi, h(pi), { seq: 0 }));
		await io.until(4);
		expect(io.out[2]).toMatchObject({ method: "session/status", params: { session: pi, handle: h(pi), isStreaming: false } });
		expect(io.out.slice(2).filter((message) => "token" in (message["params"] as object))).toEqual([]);
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
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual, token: 1 } });
		await io.until(2);
		await tick();
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 1]);
		expect(io.out[0]).toMatchObject({ params: { session: pi, handle: h(virtual), token: 1 } });
	});

	it("passes status and error through", async () => {
		const { io, server } = start(attachScript(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);
		server.emit({ type: "status", session: pi, handle: h(pi), seq: 2, isStreaming: true, compaction: "running", model: "m", effort: "low", unrestoredModel: null });
		server.emit({ type: "error", session: pi, handle: h(pi), seq: 3, message: "boom", errorId: "e1" });
		await io.until(4);
		const [, statusOut, error] = io.notifications();
		expect(statusOut).toEqual({ jsonrpc: "2.0", method: "session/status", params: { session: pi, handle: h(pi), isStreaming: true, compaction: "running", model: "m", effort: "low", unrestoredModel: null } });
		// With the id Emacs names it by when it dismisses it or prompts over it (OW-jokoto).
		expect(error).toEqual({ jsonrpc: "2.0", method: "session/error", params: { session: pi, handle: h(pi), message: "boom", errorId: "e1" } });
	});

	it("passes the server's clear of the turn error through as session/errorCleared (OW-jopifu)", async () => {
		const { io, server } = start(attachScript(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);
		server.emit({ type: "error", session: pi, handle: h(pi), seq: 2, message: "boom", errorId: "e1" });
		server.emit({ type: "error-cleared", session: pi, handle: h(pi), seq: 3 });
		await io.until(4);
		const [, , cleared] = io.notifications();
		expect(cleared).toEqual({ jsonrpc: "2.0", method: "session/errorCleared", params: { session: pi, handle: h(pi) } });
	});

	it("passes a notice through as session/notice, not session/error (OW-tujiya)", async () => {
		const { io, server } = start(attachScript(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);
		const notice = { kind: "configWarning", message: "unknown key", details: "see the docs", path: "/c.toml:3:5" };
		server.emit({ type: "notice", session: pi, handle: h(pi), seq: 2, notice });
		await io.until(3);
		const [, noticed] = io.notifications();
		expect(noticed).toEqual({ jsonrpc: "2.0", method: "session/notice", params: { session: pi, handle: h(pi), notice } });
	});

	it("carries the notices the server's snapshot holds on every later session/snapshot (OW-tujiya, OW-bipume)", async () => {
		const { io, server } = start(attachScript(pi));
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
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
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);
		expect(io.notifications()[0]).toEqual({
			jsonrpc: "2.0",
			method: "session/snapshot",
			params: { session: pi, handle: h(pi), token: 1, nodes: [], isStreaming: false, compaction: null, model: null, effort: null, unrestoredModel: null, error: "turn failed", errorId: "e1", notices: [notice] },
		});
	});

	it("carries the recorded model a resume could not restore on session/snapshot, and its clearing on session/status (OW-jitoni)", async () => {
		const { io, server } = start({
			"sessions/attach": (_params, server) => {
				server.emit(snapshot(pi, h(pi), { model: "p/fallback", unrestoredModel: "p/recorded" }));
				return { session: summary(pi) };
			},
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);
		server.emit({ type: "status", session: pi, handle: h(pi), seq: 2, isStreaming: false, compaction: null, model: "p/fallback", effort: null, unrestoredModel: null });
		await io.until(3);
		const [snapshotOut, statusOut] = io.notifications();
		expect(snapshotOut).toEqual({
			jsonrpc: "2.0",
			method: "session/snapshot",
			params: { session: pi, handle: h(pi), token: 1, nodes: [], isStreaming: false, compaction: null, model: "p/fallback", effort: null, unrestoredModel: "p/recorded", error: null, errorId: null, notices: [] },
		});
		expect(statusOut).toEqual({
			jsonrpc: "2.0",
			method: "session/status",
			params: { session: pi, handle: h(pi), isStreaming: false, compaction: null, model: "p/fallback", effort: null, unrestoredModel: null },
		});
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
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
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
		expect(io.notifications()[1]).toEqual({ jsonrpc: "2.0", method: "session/detached", params: { session: pi, handle: "h1", cause: "ended" } });
		expect(sent(server).map(([cmd]) => cmd)).toEqual(["sessions/attach"]);
	});

	it("sends no session/detached for an attachment whose handle a listing lacks, with no ended, and goes on forwarding it", async () => {
		const renamed: SessionRef = { backend: "pi", id: "/tmp/renamed.jsonl" };
		const { io, server } = start({ ...attachScript(pi, "h1"), "sessions/list": () => ({ sessions: [summary(renamed, "h2")] }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
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

// Emacs mints a token for each attach, and the helper tags the snapshot that
// answers it, and gives it up at a detach or close, by that token alone: by
// the ref asked for, another buffer's attach of the same ref, or a snapshot
// under a handle the server had let go of, was taken for it.
describe("the attach token (OW-wukako)", () => {
	/** Each notification's method, handle and token, in order. */
	const told = (io: ReturnType<typeof stdio>) =>
		io.notifications().map((message) => {
			const params = message["params"] as { handle?: string; token?: number };
			return [message["method"], params.handle, params.token];
		});

	// X holds h1; Y's attach of the same ref is in flight when X is killed.
	it("keeps the attach another buffer has in flight when a buffer holding the handle detaches carrying its token (OW-jofodu)", async () => {
		const second = held();
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi, "h1") }, { summary: summary(pi, "h1"), hold: second.hold }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, token: 2 } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/detach", params: { session: pi, handle: "h1", tokens: [1] } });
		await io.until(3);

		second.release();
		await io.until(5);
		expect(io.out.slice(3).map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 2]);
		server.emit(status(pi, "h1", 2));
		await io.until(6);
		expect(told(io)).toEqual([
			["session/snapshot", "h1", 1],
			["session/snapshot", "h1", 2],
			["session/status", "h1", undefined],
		]);
	});

	it("keeps the attachment another buffer holds when a buffer whose attach is in flight detaches carrying that attach's token and no handle", async () => {
		const second = held();
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi, "h1") }, { summary: summary(pi, "h1"), hold: second.hold }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, token: 2 } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/detach", params: { session: pi, tokens: [2] } });
		await io.until(3);
		server.emit(status(pi, "h1", 2));
		await io.until(4);

		second.release();
		await io.until(6);
		await tick();
		// The given-up attach's snapshot reaches the buffer holding the handle,
		// as any snapshot under it does, and the reply binds nothing.
		expect(told(io)).toEqual([
			["session/snapshot", "h1", 1],
			["session/status", "h1", undefined],
			["session/snapshot", "h1", undefined],
		]);
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: summary(pi, "h1") });
	});

	// X attached h1 and was let go of it, keeping its last token; Y attaches
	// the same ref, under h1 again after a gap, which leaves the handle live on
	// the server, or under h2 after an `ended`; then X is killed. Until
	// OW-linowe a detach whose token gave up nothing dropped by the ref, and
	// Y heard nothing more.
	it.each([
		["gapped", "h1"],
		["ended", "h2"],
	])("keeps the attachment another buffer holds when a buffer %s off its handle detaches carrying its last token and no handle (OW-linowe)", async (cause, next) => {
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi, "h1") }, { summary: summary(pi, next) }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);
		if (cause === "gapped") server.emit(status(pi, "h1", 3));
		else server.emit({ type: "ended", session: pi, handle: "h1" });
		await io.until(3);

		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, token: 2 } });
		await io.until(5);
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/detach", params: { session: pi, tokens: [1] } });
		await io.until(6);
		server.emit(status(pi, next, 2));
		await io.until(7);
		expect(told(io)).toEqual([
			["session/snapshot", "h1", 1],
			["session/detached", "h1", undefined],
			["session/snapshot", next, 2],
			["session/status", next, undefined],
		]);
	});

	// Y holds h1; X, previewing an alias of that session, attaches it and is
	// answered under h1 too, then is killed before handling that snapshot.
	// X's token releases X's claim on h1 alone, and Y's still stands, so Y
	// goes on hearing h1 (OW-nowihu).
	it("keeps the attachment another buffer holds when a buffer whose attach was answered under that handle detaches carrying its token and no handle (OW-linowe)", async () => {
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi, "h1") }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: alias, token: 2 } });
		await io.until(5);
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/detach", params: { session: alias, tokens: [2] } });
		await io.until(6);
		server.emit(status(pi, "h1", 2));
		await io.until(7);
		expect(told(io)).toEqual([
			["session/snapshot", "h1", 1],
			["session/snapshot", "h1", undefined],
			["session/snapshot", "h1", 2],
			["session/status", "h1", undefined],
		]);
	});

	// The converse: Y, holding h1 all along, then detaches, and the attachment
	// goes with it, though the last answer under h1 was X's.
	it("drops the attachment when the buffer holding it detaches after one answered under it detached unhandled (OW-nowihu)", async () => {
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi, "h1") }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: alias, token: 2 } });
		await io.until(5);
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/detach", params: { session: alias, tokens: [2] } });
		await io.until(6);
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/detach", params: { session: pi, handle: "h1", tokens: [1] } });
		await io.until(7);
		server.emit(status(pi, "h1", 2));
		await tick();
		expect(told(io)).toEqual([
			["session/snapshot", "h1", 1],
			["session/snapshot", "h1", undefined],
			["session/snapshot", "h1", 2],
		]);
	});

	// X's attach is answered under h1, creating the attachment, and Y's after
	// it, both snapshots out. X then detaches: killed before handling its own,
	// by its token alone, or holding h1, by the handle too, reaching the helper
	// after Y's snapshot went out, which Y then binds. Until OW-nowihu either
	// dropped h1, and Y, holding it, heard nothing.
	it.each([
		["killed before handling its snapshot", undefined],
		["holding the handle", "h1"],
	])("keeps the attachment when the buffer whose answer created it detaches %s after another's answer under it went out (OW-nowihu)", async (_, handle) => {
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi, "h1") }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 2 } });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: alias, token: 3 } });
		await io.until(5);
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/detach", params: { session: pi, handle, tokens: [2] } });
		await io.until(6);
		server.emit(status(pi, "h1", 2));
		await io.until(7);
		expect(told(io)).toEqual([
			["session/snapshot", "h1", 2],
			["session/snapshot", "h1", undefined],
			["session/snapshot", "h1", 3],
			["session/status", "h1", undefined],
		]);
	});

	// X's attach (token 1) timed out in Emacs and X sent another (token 2);
	// the helper answers the first under h1, which no buffer binds, and X is
	// killed while the second still waits. Until OW-nowihu nothing X could
	// send named the first, and h1 stayed attached with no buffer.
	it("drops the attachment a superseded attach's answer created when the buffer that sent both detaches (OW-nowihu)", async () => {
		const first = held();
		const second = held();
		const { io, server } = start({
			"sessions/attach": attaching({ summary: summary(pi, "h1"), hold: first.hold }, { summary: summary(pi, "h1"), hold: second.hold }),
		});
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: pi, token: 2 } });
		await tick();
		first.release();
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/detach", params: { session: pi, tokens: [2, 1] } });
		await io.until(3);
		second.release();
		await io.until(4);
		server.emit(status(pi, "h1", 2));
		await tick();
		expect(told(io)).toEqual([["session/snapshot", "h1", 1]]);
		expect(io.response(2)).toEqual({ jsonrpc: "2.0", id: 2, result: summary(pi, "h1") });
	});

	// A merge and a `g`: B's attach of an alias is answered under the h1 A
	// holds, and B absorbs A, which never detaches; B's refetch is answered
	// under h1 again. B's detach carries every token either sent.
	it("drops the attachment when the buffer holding it detaches after a merge and a refetch (OW-nowihu)", async () => {
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi, "h1") }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: alias, token: 2 } });
		await io.until(5);
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/attach", params: { session: alias, token: 3 } });
		await io.until(8);
		io.send({ jsonrpc: "2.0", id: 4, method: "sessions/detach", params: { session: pi, handle: "h1", tokens: [3, 2, 1] } });
		await io.until(9);
		server.emit(status(pi, "h1", 2));
		await tick();
		expect(told(io)).toEqual([
			["session/snapshot", "h1", 1],
			["session/snapshot", "h1", undefined],
			["session/snapshot", "h1", 2],
			["session/snapshot", "h1", undefined],
			["session/snapshot", "h1", 3],
		]);
	});

	// The server's attach waits out the close's disposal and spawns afresh.
	it("keeps an attach sent while a close of its ref is out, answered under the handle the server minted after it (OW-jofodu)", async () => {
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
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		await io.until(2);
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/close", params: { session: pi, handle: "h1", tokens: [1] } });
		await tick();
		io.send({ jsonrpc: "2.0", id: 3, method: "sessions/attach", params: { session: pi, token: 3 } });
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
			["session/detached", "h1", undefined],
			["session/snapshot", "h2", 3],
			["session/status", "h2", undefined],
		]);
	});

	// Another client's attach, or an opening snapshot, under h1; then another
	// client closes h1 and this attach spawns h2 (OW-savafi).
	it("answers an attach under the handle its reply names, not a handle a snapshot of its ref came under first (OW-savafi)", async () => {
		const attach = held();
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(pi, "h2"), hold: attach.hold }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
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
			["session/status", "h2", undefined],
		]);
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
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
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
		const { io, upsert, since } = await streaming({ "sessions/prompt": () => ({ disposition: "started" }) });
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
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/detach", params: { session: pi, handle: h(pi), tokens: [1] } });
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
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: pi, token: 1 } });
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/attach", params: { session: codex, token: 2 } });
		await io.until(4);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		server.emit({ type: "upsert", session: pi, handle: h(pi), seq: 2, index: 1, message: said("a") });
		server.emit(status(codex, h(codex), 2));
		expect(io.out.slice(4).map((message) => [message["method"], (message["params"] as { handle: string }).handle])).toEqual([
			["session/node", h(pi)],
			["session/status", h(codex)],
		]);
	});

	it("never sends a node held for a session closed by its attach's token, only the reply", async () => {
		const { io, upsert, since } = await streaming({ "sessions/close": () => null });
		upsert(1, said("a"));
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/close", params: { session: pi, tokens: [1] } });
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
		const { io, upsert, since } = await streaming({ "sessions/prompt": () => ({ disposition: "started" }) });
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

	it("rides every per-session notification, taken from the event it answers", async () => {
		const virtual: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io, server } = start({ "sessions/attach": attaching({ summary: summary(virtual, handle) }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: virtual, token: 1 } });
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
		for (const message of perSession) expect(message["params"]).toMatchObject({ handle });
	});

	it("rides the summary sessions/attach answers, and the snapshot it sends before the reply", async () => {
		const alias: SessionRef = { backend: "pi", id: "virtual-1" };
		const { io } = start({ "sessions/attach": attaching({ summary: summary(pi, handle) }) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/attach", params: { session: alias, token: 1 } });
		await io.until(2);
		expect(io.out.map((message) => message["method"] ?? message["id"])).toEqual(["session/snapshot", 1]);
		expect(io.out[0]).toMatchObject({ params: { session: pi, handle, token: 1 } });
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
	// backend, so agentpane-mode answers it as the helper's death (OW-hiliti).
	it.each([
		["the input ends", (_server: SocketServer, io: ReturnType<typeof stdio>) => io.end()],
		["the socket closes", (server: SocketServer) => server.drop(1006)],
	])("writes no reply for a request still out when %s (OW-hiliti, D31 point 6)", async (_, ending) => {
		const { io, server, done } = start({ "sessions/list": () => new Promise<never>(() => {}) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list" });
		await vi.waitFor(() => expect(server.calls).toHaveLength(1));
		ending(server, io);
		expect(await settled(done)).toBe("resolved");
		stop = null;
		await tick();
		expect(io.response(1)).toBeUndefined();
	});

	// A chunk the input delivered before the teardown cancelled it is still
	// read. It is sent nowhere, and answered as the refusal it is (OW-nuzoto).
	it("sends nowhere a request read after the socket closed, and answers it unreachable", async () => {
		const { io, server, done } = start({ "sessions/list": () => new Promise<never>(() => {}) });
		io.send({ jsonrpc: "2.0", id: 1, method: "sessions/list" });
		await vi.waitFor(() => expect(server.calls).toHaveLength(1));

		// In one synchronous run: the chunk is delivered, then the socket closes.
		io.send({ jsonrpc: "2.0", id: 2, method: "sessions/prompt", params: { session: pi, handle: h(pi), text: "hello" } });
		server.drop(1006);
		expect(await settled(done)).toBe("resolved");
		stop = null;
		await tick();
		expect(server.calls.map((call) => call.cmd)).toEqual(["sessions/list"]);
		expect(io.response(2)).toMatchObject({ error: { data: { error: "unreachable" } } });
	});
});
