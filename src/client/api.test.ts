import { describe, expect, it, vi } from "vitest";
import { MAX_SOCKET_FRAME_BYTES, SOCKET_CLOSE, SOCKET_PATH } from "$shared/protocol.ts";
import type { ServerEvent, SessionRef, SessionSummary } from "$shared/protocol.ts";
import { ApiClientError, ConnectionLostError, createAgentpaneApi, type EventHandlers } from "./api.ts";
import { FakeSocket } from "./test-support.ts";

const ref: SessionRef = { backend: "pi", id: "/tmp/a session.jsonl" };
const summary: SessionSummary = {
	ref,
	cwd: "/work",
	preview: "hello",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:01.000Z",
	status: "detached",
	isStreaming: false,
	name: null,
	onDisk: true,
};
const live = { ...summary, status: "attached" as const, handle: "h1" };

function handlers(): EventHandlers & { log: string[] } {
	const log: string[] = [];
	return {
		log,
		onEvent: vi.fn((event: ServerEvent) => void log.push(`event:${event.type}`)),
		onOpen: vi.fn(() => void log.push("open")),
		onDisconnect: vi.fn(() => void log.push("disconnect")),
		onMalformed: vi.fn(() => void log.push("malformed")),
	};
}

function setup(options: { token?: () => string | null; onUnauthorized?: () => void } = {}) {
	const sockets: FakeSocket[] = [];
	const api = createAgentpaneApi({
		...options,
		openSocket: (path) => {
			const socket = new FakeSocket(path);
			sockets.push(socket);
			return socket;
		},
	});
	const events = handlers();
	const connection = api.connect(events);
	const socket = sockets.at(-1)!;
	return { api, sockets, socket, events, connection };
}

/** Answer the latest command frame on `socket`. */
function reply(socket: FakeSocket, result: unknown): void {
	socket.deliver({ type: "reply", id: socket.sent.at(-1)!["id"] as string, ok: true, result: result as null });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("agentpane API over the socket", () => {
	it("opens the socket at its path and sends the token as the first frame", () => {
		const { socket } = setup({ token: () => "secret" });
		expect(socket.path).toBe(SOCKET_PATH);
		expect(socket.sent).toEqual([]);
		socket.open();
		expect(socket.sent).toEqual([{ id: expect.any(String), cmd: "hello", token: "secret" }]);
	});

	it("sends an empty token while none is stored, for the server to refuse", () => {
		const { socket } = setup();
		socket.open();
		expect(socket.sent[0]).toMatchObject({ cmd: "hello", token: "" });
	});

	it("holds a request made while the socket opens, and sends it behind the hello", async () => {
		const { api, socket } = setup({ token: () => "t" });
		const listing = api.listSessions("/work");
		expect(socket.sent).toEqual([]);
		socket.open();
		expect(socket.sent.map((frame) => frame["cmd"])).toEqual(["hello", "sessions/list"]);
		expect(socket.sent[1]).toEqual({ id: expect.any(String), cmd: "sessions/list", cwd: "/work" });
		reply(socket, { sessions: [summary] });
		expect(await listing).toEqual([summary]);
	});

	it("reports the open at the hello's reply, after the opening snapshots", () => {
		const { socket, events } = setup();
		socket.open();
		socket.emit({ type: "sessions-changed" });
		socket.deliver({ type: "reply", id: socket.sent[0]!["id"] as string, ok: true, result: null });
		expect(events.log).toEqual(["event:sessions-changed", "open"]);
	});

	it("sends each method as its command, naming a handle or a ref as D31 point 9 has it, and unwraps the result", async () => {
		const { api, socket } = setup();
		socket.open();
		const cases: [() => Promise<unknown>, Record<string, unknown>, unknown, unknown][] = [
			[() => api.listSessions(), { cmd: "sessions/list" }, { sessions: [summary] }, [summary]],
			[() => api.createSession({ cwd: "/work", backend: "pi" }), { cmd: "sessions/create", cwd: "/work", backend: "pi" }, { session: live }, live],
			[() => api.attach(ref), { cmd: "sessions/attach", ref }, { session: live }, live],
			[() => api.preview(ref), { cmd: "sessions/preview", ref }, { ref, turns: [] }, { ref, turns: [] }],
			[() => api.editDraft({ text: "draft" }), { cmd: "draft/edit", text: "draft" }, { text: "edited" }, { text: "edited" }],
			[() => api.abort("h1"), { cmd: "sessions/abort", handle: "h1" }, { queued: ["steer"] }, { queued: ["steer"] }],
			[() => api.compact("h1"), { cmd: "sessions/compact", handle: "h1" }, null, undefined],
			[() => api.close(ref), { cmd: "sessions/close", ref }, null, undefined],
			[() => api.listModels("pi"), { cmd: "models/list", backend: "pi" }, { models: [] }, []],
			[() => api.setModel("h1", "m"), { cmd: "sessions/setModel", handle: "h1", model: "m" }, null, undefined],
			[() => api.setEffort("h1", "low"), { cmd: "sessions/setEffort", handle: "h1", effort: "low" }, null, undefined],
			[() => api.setName("h1", "Bug hunt"), { cmd: "sessions/setName", handle: "h1", name: "Bug hunt" }, null, undefined],
			[
				() => api.forkPoints("h1"),
				{ cmd: "sessions/forkPoints", handle: "h1" },
				{ points: [], forkStopsTurn: true },
				{ points: [], forkStopsTurn: true },
			],
			[
				() => api.forkAndPrompt("h1", { index: 2, text: "again" }),
				{ cmd: "sessions/forkAndPrompt", handle: "h1", index: 2, text: "again" },
				{ session: live, disposition: "started" },
				{ session: live, disposition: "started" },
			],
			[() => api.dismissError("h1", "e3"), { cmd: "sessions/dismissError", handle: "h1", errorId: "e3" }, null, undefined],
		];
		for (const [call, frame, result, expected] of cases) {
			const answered = call();
			expect(socket.sent.at(-1)).toEqual({ id: expect.any(String), ...frame });
			reply(socket, result);
			expect(await answered).toEqual(expected);
		}
	});

	it("covers every method of the api but connect", () => {
		const methods = Object.keys(createAgentpaneApi({ openSocket: (path) => new FakeSocket(path) })).sort();
		expect(methods).toEqual(
			[
				"abort", "attach", "close", "compact", "connect", "createSession", "dismissError", "editDraft",
				"forkAndPrompt", "forkPoints", "listModels", "listSessions", "preview", "prompt", "setEffort", "setModel", "setName",
			].sort(),
		);
	});

	it("prompts by the handle where the body names one, and by the ref only where it does not (D30)", async () => {
		const { api, socket } = setup();
		socket.open();
		const byHandle = api.prompt(ref, { text: "hi", priorErrorId: null, handle: "h1" });
		expect(socket.sent.at(-1)).toEqual({ id: expect.any(String), cmd: "sessions/prompt", text: "hi", priorErrorId: null, handle: "h1" });
		reply(socket, { disposition: "started" });
		expect(await byHandle).toEqual({ disposition: "started" });

		const byRef = api.prompt(ref, { text: "hi" });
		expect(socket.sent.at(-1)).toEqual({ id: expect.any(String), cmd: "sessions/prompt", text: "hi", ref });
		reply(socket, { disposition: "started", session: live });
		expect(await byRef).toEqual({ disposition: "started", session: live });
	});

	it("rejects a refusal with its code, detail, fork and attached", async () => {
		const { api, socket } = setup();
		socket.open();
		const fork = { ref: { backend: "pi" as const, id: "/tmp/fork.jsonl" }, handle: "h2" };
		const refused = api.forkAndPrompt("h1", { index: 0, text: "x" });
		socket.deliver({ type: "reply", id: socket.sent.at(-1)!["id"] as string, ok: false, code: "backend_refused", detail: "no", fork });
		const error = await refused.catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(ApiClientError);
		expect(error).toMatchObject({ code: "backend_refused", detail: "no", message: "no", fork, attached: undefined });
	});

	it("settles replies by id, whatever order they come in", async () => {
		const { api, socket } = setup();
		socket.open();
		const first = api.listModels("pi");
		const firstId = socket.sent.at(-1)!["id"] as string;
		const second = api.listModels("codex");
		const secondId = socket.sent.at(-1)!["id"] as string;
		socket.deliver({ type: "reply", id: secondId, ok: true, result: { models: [{ id: "b", label: "B", efforts: [], defaultEffort: null }] } });
		socket.deliver({ type: "reply", id: firstId, ok: true, result: { models: [] } });
		expect(await first).toEqual([]);
		expect((await second).map((model) => model.id)).toEqual(["b"]);
	});

	it("hands each event to onEvent as it arrives, ahead of a reply's continuation", async () => {
		const { api, socket, events } = setup();
		socket.open();
		const attaching = api.attach(ref).then(() => events.log.push("attached"));
		socket.emit({ type: "sessions-changed" });
		reply(socket, { session: live });
		await attaching;
		expect(events.log).toEqual(["event:sessions-changed", "attached"]);
	});

	it("reports a frame that is not one the server writes as malformed, and goes on", async () => {
		const { api, socket, events } = setup();
		socket.open();
		socket.deliver("not json");
		socket.deliver(JSON.stringify({ type: "something" }));
		const listing = api.listSessions();
		reply(socket, { sessions: [] });
		expect(await listing).toEqual([]);
		expect(events.onMalformed).toHaveBeenCalledTimes(2);
	});

	it("settles a request written before a close as the connection lost, then reports the disconnect (D31 point 6)", async () => {
		const { api, socket, events } = setup();
		socket.open();
		const prompt = api.prompt(ref, { text: "hi", handle: "h1" });
		const outcome = prompt.catch((thrown: unknown) => {
			events.log.push("rejected");
			return thrown;
		});
		socket.drop(1006);
		expect(await outcome).toBeInstanceOf(ConnectionLostError);
		expect(events.log).toEqual(["disconnect", "rejected"]);
		expect(events.onDisconnect).toHaveBeenCalledOnce();
	});

	it("refuses a request held for a socket that never opened as unreachable, since it was never written", async () => {
		const { api, socket, events } = setup();
		const listing = api.listSessions();
		socket.drop(1006);
		const error = await listing.catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(ApiClientError);
		expect(error).toMatchObject({ code: "unreachable" });
		expect(events.onDisconnect).toHaveBeenCalledOnce();
		expect(events.onOpen).not.toHaveBeenCalled();
	});

	it("refuses a request made with no socket up as unreachable, and sends nothing", async () => {
		const sockets: FakeSocket[] = [];
		const api = createAgentpaneApi({ openSocket: (path) => sockets[sockets.push(new FakeSocket(path)) - 1]! });
		await expect(api.listSessions()).rejects.toMatchObject({ code: "unreachable" });

		api.connect(handlers());
		sockets[0]!.open();
		sockets[0]!.drop(1006);
		await expect(api.listSessions()).rejects.toMatchObject({ code: "unreachable" });
		expect(sockets[0]!.commands()).toEqual([]);
	});

	it("sends on the socket a reconnect opened, once the last has closed", async () => {
		const { api, sockets, socket, events } = setup();
		socket.open();
		socket.drop(1006);
		api.connect(events);
		const next = sockets.at(-1)!;
		expect(next).not.toBe(socket);
		next.open();
		const listing = api.listSessions();
		expect(next.commands().map((frame) => frame["cmd"])).toEqual(["sessions/list"]);
		reply(next, { sessions: [] });
		expect(await listing).toEqual([]);
	});

	it("at a close for a refused token, tells onUnauthorized and refuses what it held as unauthorized", async () => {
		const onUnauthorized = vi.fn();
		const { api, socket, events } = setup({ onUnauthorized });
		socket.open();
		const listing = api.listSessions();
		socket.drop(SOCKET_CLOSE.unauthorized, "the first frame must be a hello carrying the token");
		await expect(listing).rejects.toMatchObject({ code: "unauthorized" });
		expect(onUnauthorized).toHaveBeenCalledOnce();
		expect(events.onDisconnect).toHaveBeenCalledOnce();
	});

	it("refuses a frame over the server's limit before sending it (D31 point 8)", async () => {
		const { api, socket } = setup();
		socket.open();
		const text = "x".repeat(MAX_SOCKET_FRAME_BYTES);
		await expect(api.prompt(ref, { text, handle: "h1" })).rejects.toMatchObject({ code: "frame_too_large" });
		expect(socket.commands()).toEqual([]);
		// Three bytes a unit, under the limit in units and over it in bytes.
		const wide = "€".repeat(Math.ceil(MAX_SOCKET_FRAME_BYTES / 3) + 1);
		await expect(api.prompt(ref, { text: wide, handle: "h1" })).rejects.toMatchObject({ code: "frame_too_large" });
		expect(socket.commands()).toEqual([]);
	});

	it("abandons a preview its signal aborts, and ignores the reply that follows", async () => {
		const { api, socket } = setup();
		socket.open();
		const abort = new AbortController();
		const preview = api.preview(ref, abort.signal);
		const id = socket.sent.at(-1)!["id"] as string;
		abort.abort(new Error("superseded"));
		await expect(preview).rejects.toThrow("superseded");
		socket.deliver({ type: "reply", id, ok: true, result: { ref, turns: [] } });
		await flush();
	});

	it("rejects a refusal that names the session its prompt attached (D30)", async () => {
		const { api, socket } = setup();
		socket.open();
		const attached = { ref, handle: "h1" };
		const refused = api.prompt(ref, { text: "x" });
		socket.deliver({ type: "reply", id: socket.sent.at(-1)!["id"] as string, ok: false, code: "backend_refused", detail: "no", attached });
		expect(await refused.catch((thrown: unknown) => thrown)).toMatchObject({ code: "backend_refused", attached, fork: undefined });
	});

	it("writes a frame between a third of the limit and the limit, which only encoding it can tell (D31 point 8)", async () => {
		const { api, socket } = setup();
		socket.open();
		const text = "x".repeat(MAX_SOCKET_FRAME_BYTES / 2);
		const prompt = api.prompt(ref, { text, handle: "h1" });
		expect(socket.commands().map((frame) => frame["cmd"])).toEqual(["sessions/prompt"]);
		reply(socket, null);
		await prompt;
	});

	it("reports an event with no event, and a reply with no id or no ok, as malformed, settling nothing", async () => {
		const { api, socket, events } = setup();
		socket.open();
		const listing = api.listSessions();
		const id = socket.sent.at(-1)!["id"] as string;
		socket.deliver(JSON.stringify({ type: "event" }));
		socket.deliver(JSON.stringify({ type: "event", event: null }));
		socket.deliver(JSON.stringify({ type: "reply", ok: true, result: { sessions: [summary] } }));
		socket.deliver(JSON.stringify({ type: "reply", id }));
		expect(events.onMalformed).toHaveBeenCalledTimes(4);
		expect(events.onEvent).not.toHaveBeenCalled();
		socket.deliver({ type: "reply", id, ok: true, result: { sessions: [] } });
		expect(await listing).toEqual([]);
	});

	it("rejects a request whose signal had already aborted, and writes nothing", async () => {
		const { api, socket } = setup();
		socket.open();
		const abort = new AbortController();
		abort.abort(new Error("superseded"));
		await expect(api.preview(ref, abort.signal)).rejects.toThrow("superseded");
		expect(socket.commands()).toEqual([]);
	});

	it("refuses a request held unsent when the client closes as unreachable, since it was never written", async () => {
		const { api, socket, connection } = setup();
		const listing = api.listSessions();
		connection.close();
		await expect(listing).rejects.toMatchObject({ code: "unreachable" });
		expect(socket.sent).toEqual([]);
	});

	it("hears nothing from a socket once it has closed, from either end", async () => {
		for (const close of ["client", "server"] as const) {
			const { socket, events, connection } = setup();
			socket.open();
			if (close === "client") connection.close();
			else socket.drop(1006);
			socket.emit({ type: "sessions-changed" });
			expect(events.onEvent).not.toHaveBeenCalled();
		}
	});

	it("closes from the client's end without reporting a disconnect, the requests out lost", async () => {
		const { api, socket, events, connection } = setup();
		socket.open();
		const listing = api.listSessions();
		connection.close();
		await expect(listing).rejects.toBeInstanceOf(ConnectionLostError);
		expect(socket.closedWith).toEqual({ code: 1000, reason: "the client is leaving" });
		socket.drop(1000);
		expect(events.onDisconnect).not.toHaveBeenCalled();
	});
});
