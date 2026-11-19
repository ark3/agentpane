/**
 * The socket (D31), through the connection entry point `createApp` exposes:
 * a `send` that pushes each frame into an array, and the frames a client
 * would write handed to `receive`. The upgrade and Bun's framing are not
 * reached from here; `admitUpgrade` is, as a plain `Request`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CommandName,
	type Commands,
	type ReplyFailed,
	type ReplyOk,
	ROUTES,
	type ServerEvent,
	type ServerFrame,
	SOCKET_CLOSE,
	type SessionRef,
	sessionKey,
} from "../../shared/protocol.ts";
import { BackendRefusedError } from "../adapters/types.ts";
import { type App, createApp } from "./app.ts";
import { deferred, FakeAdapterFactory, type FakeAdapterOptions, FakeSessionIndex, storedSession, userMessage } from "./testing/fakes.ts";
import { TEST_API_TOKEN } from "./testing/app.ts";

const PI_SESSION: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/one.jsonl" };
const CODEX_SESSION: SessionRef = { backend: "codex", id: "019feee5-cc20-7290-95fa-599abc243e55" };
const WORKSPACE = process.cwd();

let index: FakeSessionIndex;
let pi: FakeAdapterFactory;
let codex: FakeAdapterFactory;
let app: App;
let logged: string[];

function build(piOptions: FakeAdapterOptions = {}, codexOptions: FakeAdapterOptions = {}): void {
	index = new FakeSessionIndex([
		storedSession(PI_SESSION, WORKSPACE, "2026-08-10T10:00:00.000Z"),
		storedSession(CODEX_SESSION, "/home/u/src/other", "2026-08-09T10:00:00.000Z"),
	]);
	pi = new FakeAdapterFactory({ models: [{ id: "pi-1", label: "Pi One", efforts: [], defaultEffort: null }], ...piOptions });
	codex = new FakeAdapterFactory({
		models: [{ id: "cx-1", label: "Codex One", efforts: [{ id: "low", description: "Fast" }], defaultEffort: "low" }],
		...codexOptions,
	});
	logged = [];
	let n = 0;
	app = createApp({
		index,
		adapters: { pi, codex },
		apiToken: TEST_API_TOKEN,
		newId: () => `id-${++n}`,
		now: () => "2026-08-11T00:00:00.000Z",
		logError: (message) => logged.push(message),
	});
}

beforeEach(() => build());

/** One socket's client end, as the browser and the helper will hold it. */
class TestSocket {
	readonly frames: ServerFrame[] = [];
	ended: { code: number; reason: string } | null = null;
	readonly connection;
	#next = 0;

	constructor(target: App = app) {
		this.connection = target.connect(
			(frame) => this.frames.push(JSON.parse(frame) as ServerFrame),
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

	/** Each frame by what it is: an event's type, or `reply:<id>`. */
	get shape(): string[] {
		return this.frames.map((frame) => (frame.type === "event" ? frame.event.type : `reply:${frame.id}`));
	}

	clear(): void {
		this.frames.length = 0;
	}
}

async function connected(): Promise<TestSocket> {
	return new TestSocket().hello();
}

/** A socket with `ref` attached on it, and the handle it is live under. */
async function attached(ref: SessionRef = PI_SESSION): Promise<{ socket: TestSocket; handle: string; ref: SessionRef }> {
	const socket = await connected();
	const { session } = await socket.ok("sessions/attach", { ref });
	socket.clear();
	return { socket, handle: session.handle, ref: session.ref };
}

describe("the token is the first frame (D31 point 5)", () => {
	it("sends nothing to a socket that has not said hello, while events go to one that has", async () => {
		const quiet = new TestSocket();
		const { socket } = await attached();
		pi.forRef(PI_SESSION)?.streamToken("hi");
		await socket.ok("sessions/list", {});

		expect(socket.events.length).toBeGreaterThan(0);
		expect(quiet.frames).toEqual([]);
		expect(quiet.ended).toBeNull();
	});

	it("closes a socket whose first frame is a command, and runs nothing it carried", async () => {
		const socket = new TestSocket();
		socket.send("sessions/attach", { ref: PI_SESSION, token: TEST_API_TOKEN });
		socket.send("sessions/create", { cwd: WORKSPACE, backend: "pi" });
		await Promise.resolve();

		expect(socket.ended?.code).toBe(SOCKET_CLOSE.unauthorized);
		expect(socket.frames).toEqual([]);
		expect(pi.created).toEqual([]);
		expect(app.broadcaster.clientCount).toBe(0);
	});

	it("closes a socket whose hello carries the wrong token, or none", async () => {
		for (const params of [{ token: `${TEST_API_TOKEN}x` }, { token: "" }, {}]) {
			const socket = new TestSocket();
			socket.send("hello", params);
			socket.send("sessions/list", {});
			await Promise.resolve();
			expect(socket.ended?.code).toBe(SOCKET_CLOSE.unauthorized);
			expect(socket.frames).toEqual([]);
		}
		expect(app.broadcaster.clientCount).toBe(0);
	});

	it("closes a socket whose first frame is not JSON", () => {
		const socket = new TestSocket();
		socket.connection.receive("not json");
		expect(socket.ended?.code).toBe(SOCKET_CLOSE.unauthorized);
	});

	it("answers the hello after a snapshot of every live session", async () => {
		await attached(PI_SESSION);
		await attached(CODEX_SESSION);
		const socket = new TestSocket();
		const id = socket.send("hello", { token: TEST_API_TOKEN });
		await socket.reply(id);

		expect(socket.shape).toEqual(["snapshot", "snapshot", `reply:${id}`]);
		expect(socket.events.map((event) => (event.type === "snapshot" ? event.session.backend : null)).sort()).toEqual(["codex", "pi"]);
	});

	it("refuses a second hello", async () => {
		const socket = await connected();
		expect((await socket.refused("hello", { token: TEST_API_TOKEN })).code).toBe("bad_request");
	});
});

describe("frames", () => {
	it("closes the socket on a frame that is not a JSON object with a string id", async () => {
		for (const text of ["{", "[]", "null", JSON.stringify({ cmd: "sessions/list" }), JSON.stringify({ id: 7, cmd: "sessions/list" })]) {
			const socket = await connected();
			socket.clear();
			socket.connection.receive(text);
			expect(socket.ended?.code).toBe(SOCKET_CLOSE.badFrame);
			socket.connection.receive(JSON.stringify({ id: "after", cmd: "sessions/list" }));
			await Promise.resolve();
			expect(socket.frames).toEqual([]);
		}
	});

	it("refuses an unknown command, one named after an object's own property included", async () => {
		const socket = await connected();
		for (const cmd of ["sessions/explode", "toString", "__proto__"]) {
			const reply = await socket.refused(cmd as CommandName, {});
			expect(reply.code).toBe("bad_request");
		}
		expect(socket.ended).toBeNull();
	});
});

describe("what a reply means (D31 point 3)", () => {
	it("writes everything a prompt caused while it was admitted before its reply", async () => {
		build({
			onSubmit(adapter, text) {
				adapter.append(userMessage(text));
				adapter.setStreaming(true);
				adapter.streamToken("ok");
				adapter.setStreaming(false);
			},
		});
		const { socket, handle } = await attached();
		const id = socket.send("sessions/prompt", { handle, text: "go" });
		await socket.reply(id);

		// Each streaming change also changes the listing, hence `sessions-changed`.
		expect(socket.shape).toEqual(["upsert", "status", "sessions-changed", "upsert", "status", "sessions-changed", `reply:${id}`]);
	});

	it("keeps events flowing while a slow command runs, and answers it last", async () => {
		const held = deferred();
		build({ onSetModel: () => held.promise });
		const { socket, handle } = await attached();
		const id = socket.send("sessions/setModel", { handle, model: "pi-1" });
		const adapter = pi.forRef(PI_SESSION);
		adapter?.streamToken("one");
		adapter?.streamToken("two");
		await Promise.resolve();
		expect(socket.shape).toEqual(["upsert", "upsert"]);

		held.resolve();
		await socket.reply(id);
		expect(socket.shape).toEqual(["upsert", "upsert", "status", `reply:${id}`]);
	});

	it("answers commands on different sessions in the order they finish", async () => {
		const held = deferred();
		build({ onSetModel: () => held.promise });
		const socket = await connected();
		const { session: piSession } = await socket.ok("sessions/attach", { ref: PI_SESSION });
		const { session: codexSession } = await socket.ok("sessions/attach", { ref: CODEX_SESSION });
		const slow = socket.send("sessions/setModel", { handle: piSession.handle, model: "pi-1" });
		const quick = socket.send("sessions/setModel", { handle: codexSession.handle, model: "cx-1" });
		await socket.reply(quick);
		held.resolve();
		await socket.reply(slow);

		const replies = socket.frames.flatMap((frame) => (frame.type === "reply" ? [frame.id] : []));
		expect(replies.slice(-2)).toEqual([quick, slow]);
	});
});

describe("queries", () => {
	it("lists sessions, filtered by cwd", async () => {
		const socket = await connected();
		const all = await socket.ok("sessions/list", {});
		expect(all.sessions.map((s) => sessionKey(s.ref))).toEqual([sessionKey(PI_SESSION), sessionKey(CODEX_SESSION)]);
		const here = await socket.ok("sessions/list", { cwd: WORKSPACE });
		expect(here.sessions.map((s) => sessionKey(s.ref))).toEqual([sessionKey(PI_SESSION)]);
	});

	it("lists models, all of them or one backend's", async () => {
		const socket = await connected();
		expect((await socket.ok("models/list", {})).models.map((m) => m.id)).toEqual(["pi-1", "cx-1"]);
		expect((await socket.ok("models/list", { backend: "codex" })).models.map((m) => m.id)).toEqual(["cx-1"]);
		expect((await socket.refused("models/list", { backend: "gemini" })).code).toBe("bad_backend");
	});

	it("previews a stored session without attaching it, and says gone for one with no file", async () => {
		const gone: SessionRef = { backend: "pi", id: "/nowhere.jsonl" };
		index.previews.set(sessionKey(gone), null);
		const socket = await connected();
		const preview = await socket.ok("sessions/preview", { ref: PI_SESSION });
		expect(preview).toEqual({ ref: PI_SESSION, turns: [] });
		expect(pi.created).toEqual([]);
		expect((await socket.refused("sessions/preview", { ref: gone })).code).toBe("gone");
	});

	it("answers fork points and whether a fork stops the turn", async () => {
		build({ forkPoints: [{ id: "e1", text: "first", index: 0 }] });
		const { socket, handle } = await attached();
		expect(await socket.ok("sessions/forkPoints", { handle })).toEqual({
			points: [{ id: "e1", text: "first", index: 0 }],
			forkStopsTurn: true,
		});
	});

	it("round-trips a draft through EDITOR", async () => {
		const priorEditor = process.env.EDITOR;
		process.env.EDITOR = `sh ${new URL("./testing/editor-fixture.sh", import.meta.url).pathname} --replace`;
		try {
			const socket = await connected();
			expect(await socket.ok("draft/edit", { text: "original" })).toEqual({ text: "edited by fixture" });
			delete process.env.EDITOR;
			expect((await socket.refused("draft/edit", { text: "original" })).code).toBe("editor_failed");
		} finally {
			if (priorEditor === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = priorEditor;
		}
	});
});

describe("commands that name a ref", () => {
	it("attaches, writing the session's snapshot before the reply", async () => {
		const socket = await connected();
		const id = socket.send("sessions/attach", { ref: PI_SESSION });
		const reply = await socket.reply(id);

		expect(socket.shape.slice(-2)).toEqual(["snapshot", `reply:${id}`]);
		expect(reply.ok && (reply.result as Commands["sessions/attach"]["result"]).session.status).toBe("attached");
	});

	it("refuses a ref with an unknown backend, or none", async () => {
		const socket = await connected();
		expect((await socket.refused("sessions/attach", { ref: { backend: "gemini", id: "x" } })).code).toBe("bad_backend");
		expect((await socket.refused("sessions/attach", {})).code).toBe("bad_request");
		expect((await socket.refused("sessions/attach", { ref: { backend: "pi" } })).code).toBe("bad_request");
	});

	it("creates a session started and live, and refuses a cwd that is not a directory", async () => {
		const socket = await connected();
		const id = socket.send("sessions/create", { cwd: WORKSPACE, backend: "pi", model: "pi-1" });
		const reply = await socket.reply(id);
		if (!reply.ok) throw new Error(reply.code);
		const { session } = reply.result as Commands["sessions/create"]["result"];

		expect(session.status).toBe("attached");
		expect(socket.events.some((event) => event.type === "snapshot" && event.handle === session.handle)).toBe(true);
		expect(pi.forRef(session.ref)?.startOptions).toEqual({ cwd: WORKSPACE, model: "pi-1" });
		expect((await socket.refused("sessions/create", { cwd: "relative", backend: "pi" })).code).toBe("bad_request");
		expect((await socket.refused("sessions/create", { cwd: WORKSPACE, backend: "gemini" })).code).toBe("bad_backend");
	});

	it("closes a session by its ref, writing its end before the reply", async () => {
		const { socket, handle } = await attached();
		const id = socket.send("sessions/close", { ref: PI_SESSION });
		await socket.reply(id);

		expect(socket.shape).toEqual(["ended", "sessions-changed", `reply:${id}`]);
		expect(socket.events[0]).toMatchObject({ type: "ended", handle });
	});

	it("prompts by ref, attaching the session, and names it in the reply", async () => {
		const socket = await connected();
		const reply = await socket.ok("sessions/prompt", { ref: PI_SESSION, text: "hello" });

		expect(reply.disposition).toBe("started");
		expect(reply.session?.status).toBe("attached");
		expect(pi.forRef(PI_SESSION)?.prompts.map((p) => p.text)).toEqual(["hello"]);
	});

	it("names the session it attached in a prompt's refusal after the attach (D30)", async () => {
		build({
			onSubmit() {
				throw new BackendRefusedError("not now");
			},
		});
		const socket = await connected();
		const reply = await socket.refused("sessions/prompt", { ref: PI_SESSION, text: "hello" });

		expect(reply.code).toBe("backend_refused");
		expect(reply.attached?.handle).toEqual(expect.any(String));
		expect(reply.attached?.ref).toEqual(PI_SESSION);
	});
});

describe("commands that name a handle (D31 point 9)", () => {
	it("prompts the live session under the handle", async () => {
		const { socket, handle } = await attached();
		expect(await socket.ok("sessions/prompt", { handle, text: "hi", priorErrorId: null })).toEqual({ disposition: "started" });
		expect(pi.forRef(PI_SESSION)?.prompts.map((p) => p.text)).toEqual(["hi"]);
	});

	it("answers a handled prompt's disposition", async () => {
		build({ onSubmit: () => "handled" });
		const { socket, handle } = await attached();
		expect(await socket.ok("sessions/prompt", { handle, text: "/refs" })).toEqual({ disposition: "handled" });
	});

	it("refuses a prompt that names both a handle and a ref, or neither, or a bad priorErrorId", async () => {
		const { socket, handle } = await attached();
		expect((await socket.refused("sessions/prompt", { handle, ref: PI_SESSION, text: "x" })).code).toBe("bad_request");
		expect((await socket.refused("sessions/prompt", { text: "x" })).code).toBe("bad_request");
		expect((await socket.refused("sessions/prompt", { handle })).code).toBe("bad_request");
		expect((await socket.refused("sessions/prompt", { handle, text: "x", priorErrorId: 3 })).code).toBe("bad_request");
		expect(pi.forRef(PI_SESSION)?.prompts).toEqual([]);
	});

	it("aborts, answering the prompts the stop took out", async () => {
		const { socket, handle } = await attached();
		const adapter = pi.forRef(PI_SESSION);
		if (adapter) adapter.queued = ["later"];
		expect(await socket.ok("sessions/abort", { handle })).toEqual({ queued: ["later"] });
		expect(await socket.ok("sessions/abort", { handle })).toEqual({ queued: [] });
		expect(adapter?.aborts).toBe(2);
	});

	it("compacts, its status written before the reply", async () => {
		const { socket, handle } = await attached();
		const id = socket.send("sessions/compact", { handle });
		await socket.reply(id);
		expect(socket.shape).toEqual(["status", `reply:${id}`]);
		expect(pi.forRef(PI_SESSION)?.compactions).toBe(1);
	});

	it("dismisses the error it names, and leaves a newer one", async () => {
		const { socket, handle } = await attached();
		pi.forRef(PI_SESSION)?.emitError("boom");
		const raised = socket.events.find((event) => event.type === "error");
		if (raised?.type !== "error") throw new Error("no error event");

		await socket.ok("sessions/dismissError", { handle, errorId: "some other" });
		expect(app.sessions.errorIdOf(PI_SESSION)).toBe(raised.errorId);
		const id = socket.send("sessions/dismissError", { handle, errorId: raised.errorId });
		await socket.reply(id);
		expect(socket.shape.slice(-2)).toEqual(["error-cleared", `reply:${id}`]);
		expect((await socket.refused("sessions/dismissError", { handle })).code).toBe("bad_request");
	});

	it("sets the model, the effort and the name", async () => {
		const { socket, handle } = await attached(CODEX_SESSION);
		await socket.ok("sessions/setModel", { handle, model: "cx-1" });
		await socket.ok("sessions/setEffort", { handle, effort: "low" });
		await socket.ok("sessions/setName", { handle, name: " two\nlines " });
		const adapter = codex.forRef(CODEX_SESSION);
		expect([adapter?.model, adapter?.effort, adapter?.name]).toEqual(["cx-1", "low", "two lines"]);

		expect((await socket.refused("sessions/setEffort", { handle, effort: "xhigh" })).code).toBe("bad_request");
		expect((await socket.refused("sessions/setName", { handle, name: " \n " })).code).toBe("bad_request");
		expect((await socket.refused("sessions/setModel", { handle })).code).toBe("bad_request");
	});

	it("forks, answering the fork's ref", async () => {
		build({}, { forkMode: "codex" });
		const { socket, handle } = await attached(CODEX_SESSION);
		const { ref } = await socket.ok("sessions/fork", { handle, entryId: "e1" });
		expect(ref).toEqual({ backend: "codex", id: `${CODEX_SESSION.id}#fork-e1` });
	});

	it("forks and prompts, answering the fork live", async () => {
		build({ forkPoints: [{ id: "e1", text: "first", index: 0 }] });
		const { socket, handle } = await attached();
		const reply = await socket.ok("sessions/forkAndPrompt", { handle, index: 0, text: "again" });

		expect(reply.disposition).toBe("started");
		expect(reply.session.handle).not.toBe(handle);
		expect(pi.forRef(reply.session.ref)?.prompts.map((p) => p.text)).toEqual(["again"]);
		expect(socket.events.some((event) => event.type === "snapshot" && event.handle === reply.session.handle)).toBe(true);
	});

	it("refuses an index no fork point names, and names the fork in a refusal after it exists", async () => {
		build({
			forkPoints: [{ id: "e1", text: "first", index: 0 }],
			onSubmit() {
				throw new BackendRefusedError("not now");
			},
		});
		const { socket, handle } = await attached();
		expect((await socket.refused("sessions/forkAndPrompt", { handle, index: 3, text: "x" })).code).toBe("not_a_fork_point");
		expect((await socket.refused("sessions/forkAndPrompt", { handle, index: 0.5, text: "x" })).code).toBe("bad_request");

		const reply = await socket.refused("sessions/forkAndPrompt", { handle, index: 0, text: "again" });
		expect(reply.code).toBe("backend_refused");
		expect(reply.fork?.ref).toEqual({ backend: "pi", id: `${PI_SESSION.id}#fork-e1` });
		expect(reply.fork?.handle).toEqual(expect.any(String));
	});

	it("refuses every one of them for a handle a close ended, across a re-attach, and runs nothing", async () => {
		build({ forkPoints: [{ id: "e1", text: "first", index: 0 }] });
		const { socket, handle } = await attached();
		await socket.ok("sessions/close", { ref: PI_SESSION });
		const { session } = await socket.ok("sessions/attach", { ref: PI_SESSION });
		expect(session.handle).not.toBe(handle);
		const fresh = pi.forRef(PI_SESSION);

		const commands: [CommandName, Record<string, unknown>][] = [
			["sessions/prompt", { text: "x" }],
			["sessions/abort", {}],
			["sessions/compact", {}],
			["sessions/dismissError", { errorId: "e" }],
			["sessions/setModel", { model: "pi-1" }],
			["sessions/setEffort", { effort: "low" }],
			["sessions/setName", { name: "n" }],
			["sessions/forkPoints", {}],
			["sessions/fork", { entryId: "e1" }],
			["sessions/forkAndPrompt", { index: 0, text: "x" }],
		];
		for (const [cmd, params] of commands) {
			const reply = await socket.refused(cmd, { handle, ...params });
			expect([cmd, reply.code]).toEqual([cmd, "not_attached"]);
		}
		for (const [cmd, params] of commands) {
			expect([cmd, (await socket.refused(cmd, { handle: "never-minted", ...params })).code]).toEqual([cmd, "not_attached"]);
		}
		expect([fresh?.prompts, fresh?.aborts, fresh?.compactions, fresh?.model, fresh?.name, fresh?.forks]).toEqual([[], 0, 0, undefined, null, []]);
	});

	it("refuses a command queued behind a close of its handle", async () => {
		const held = deferred();
		build({ onSetModel: () => held.promise });
		const { socket, handle } = await attached();
		const first = socket.send("sessions/setModel", { handle, model: "pi-1" });
		const second = socket.send("sessions/setName", { handle, name: "late" });
		const closing = socket.send("sessions/close", { ref: PI_SESSION });
		await socket.reply(closing);
		held.resolve();
		await socket.reply(first);

		const reply = await socket.reply(second);
		expect(reply.ok === false && reply.code).toBe("not_attached");
	});
});

describe("failures the mapper does not know", () => {
	it("answer internal_error and are logged with the command and its target", async () => {
		build({
			onSetModel() {
				throw new Error("the adapter fell over");
			},
		});
		const { socket, handle } = await attached();
		const reply = await socket.refused("sessions/setModel", { handle, model: "pi-1" });

		expect([reply.code, reply.detail]).toEqual(["internal_error", "the adapter fell over"]);
		expect(logged).toEqual([`sessions/setModel handle ${handle}: the adapter fell over`]);
	});
});

describe("closing", () => {
	it("a socket that closed leaves the broadcaster, and hears nothing more", async () => {
		const held = deferred();
		build({ onSetModel: () => held.promise });
		const { socket, handle } = await attached();
		expect(app.broadcaster.clientCount).toBe(1);
		socket.send("sessions/setModel", { handle, model: "pi-1" });
		socket.connection.close();
		expect(app.broadcaster.clientCount).toBe(0);

		pi.forRef(PI_SESSION)?.streamToken("unheard");
		held.resolve();
		await vi.waitFor(() => expect(pi.forRef(PI_SESSION)?.model).toBe("pi-1"), { interval: 1 });
		// The command it sent still ran: the server finishes what it admitted (D17).
		socket.connection.receive(JSON.stringify({ id: "late", cmd: "sessions/list" }));
		await Promise.resolve();
		expect(socket.frames).toEqual([]);
		expect(socket.ended).toBeNull();
	});

	it("shutdown ends every socket that said hello", async () => {
		const one = await connected();
		const two = await connected();
		await app.close();
		expect(one.ended?.code).toBe(SOCKET_CLOSE.goingAway);
		expect(two.ended?.code).toBe(SOCKET_CLOSE.goingAway);
		expect(app.broadcaster.clientCount).toBe(0);
	});

	it("a send that throws closes the connection", async () => {
		let fail = false;
		const sent: string[] = [];
		const connection = app.connect(
			(frame) => {
				if (fail) throw new Error("gone");
				sent.push(frame);
			},
			() => {},
		);
		connection.receive(JSON.stringify({ id: "h", cmd: "hello", token: TEST_API_TOKEN }));
		expect(app.broadcaster.clientCount).toBe(1);
		fail = true;
		app.broadcaster.sessionsChanged();
		expect(app.broadcaster.clientCount).toBe(0);
		expect(sent).toHaveLength(1);
	});
});

describe("the upgrade", () => {
	const upgrade = (headers: Record<string, string>, method = "GET") =>
		new Request(`http://127.0.0.1:4173${ROUTES.socket}`, { method, headers: { host: "127.0.0.1:4173", ...headers } });

	it("is the socket's path and nothing else", () => {
		expect(app.isSocketRequest(upgrade({}))).toBe(true);
		expect(app.isSocketRequest(new Request("http://127.0.0.1:4173/api/events"))).toBe(false);
		expect(app.isSocketRequest(new Request(`http://127.0.0.1:4173${ROUTES.socket}/x`))).toBe(false);
	});

	it("is admitted from a local page with no token, which the first frame carries", () => {
		expect(app.admitUpgrade(upgrade({ origin: "http://localhost:5173", "sec-fetch-site": "same-origin" }))).toBeNull();
		expect(app.admitUpgrade(upgrade({}))).toBeNull();
	});

	it("is refused for a page elsewhere, a host that is not loopback, and a method that is not GET", async () => {
		const cases: [Request, number, string][] = [
			[upgrade({ origin: "https://evil.example" }), 403, "forbidden_origin"],
			[upgrade({ "sec-fetch-site": "cross-site" }), 403, "forbidden_origin"],
			[upgrade({ origin: "null" }), 403, "forbidden_origin"],
			[upgrade({ host: "evil.example" }), 403, "forbidden_host"],
			[upgrade({}, "POST"), 405, "method_not_allowed"],
		];
		for (const [request, status, code] of cases) {
			const refusal = app.admitUpgrade(request);
			expect([refusal?.status, ((await refusal?.json()) as { error: string }).error]).toEqual([status, code]);
		}
	});
});
