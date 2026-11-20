/**
 * The socket (D31), through the connection entry point `createApp` exposes:
 * a `send` that pushes each frame into an array, and the frames a client
 * would write handed to `receive` (`testing/socket-client.ts`). The upgrade
 * and Bun's framing are not reached from here; the upgrade's admission is
 * `app.test.ts`'s.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CommandName,
	type Commands,
	SOCKET_CLOSE,
	type SessionPreviewTurn,
	type SessionRef,
	sessionKey,
} from "../../shared/protocol.ts";
import { BackendRefusedError } from "../adapters/types.ts";
import { type App, createApp } from "./app.ts";
import type { AppDeps } from "./deps.ts";
import {
	assistantMessage,
	deferred,
	FakeAdapterFactory,
	type FakeAdapterOptions,
	FakeSessionIndex,
	storedSession,
	userMessage,
} from "./testing/fakes.ts";
import { TEST_API_TOKEN } from "./testing/app.ts";
import { TestSocket } from "./testing/socket-client.ts";

const PI_SESSION: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/one.jsonl" };
const CODEX_SESSION: SessionRef = { backend: "codex", id: "019feee5-cc20-7290-95fa-599abc243e55" };
const CLAUDE_SESSION: SessionRef = { backend: "claude", id: "3af1e5da-9f22-4f34-9c2b-6b7e2f1c9d44" };
const WORKSPACE = process.cwd();

let index: FakeSessionIndex;
let pi: FakeAdapterFactory;
let codex: FakeAdapterFactory;
let app: App;
let logged: string[];

function build(piOptions: FakeAdapterOptions = {}, codexOptions: FakeAdapterOptions = {}): void {
	// Seeded already recency-sorted, claude interleaved between the other two:
	// the fake index returns them as-is (the sort itself is the real index's
	// job, asserted in sessions/index.test.ts), and the listing must pass all
	// three backends through in that order.
	index = new FakeSessionIndex([
		storedSession(PI_SESSION, WORKSPACE, "2026-08-10T10:00:00.000Z"),
		storedSession(CLAUDE_SESSION, "/home/u/src/other", "2026-08-09T12:00:00.000Z"),
		storedSession(CODEX_SESSION, "/home/u/src/other", "2026-08-09T10:00:00.000Z"),
	]);
	pi = new FakeAdapterFactory({ models: [{ id: "pi-1", label: "Pi One", efforts: [], defaultEffort: null }], ...piOptions });
	codex = new FakeAdapterFactory({
		models: [{ id: "cx-1", label: "Codex One", efforts: [{ id: "low", description: "Fast" }], defaultEffort: "low" }],
		...codexOptions,
	});
	rebuild({ pi, codex });
}

/** The app again, over the same index, with these adapters in place of the defaults. */
function rebuild(adapters: AppDeps["adapters"], extra: Partial<AppDeps> = {}): void {
	logged = [];
	let n = 0;
	app = createApp({
		index,
		adapters,
		apiToken: TEST_API_TOKEN,
		newId: () => `id-${++n}`,
		now: () => "2026-08-11T00:00:00.000Z",
		logError: (message) => logged.push(message),
		...extra,
	});
}

beforeEach(() => build());

function previewUser(text: string): SessionPreviewTurn {
	const { timestamp: _timestamp, ...message } = userMessage(text);
	return message;
}

function previewAssistant(text: string): SessionPreviewTurn {
	const { timestamp: _timestamp, ...message } = assistantMessage(text);
	return message;
}

/** A socket on `target`, which has not said hello. */
function open(target: App = app, options?: ConstructorParameters<typeof TestSocket>[1]): TestSocket {
	return new TestSocket(target, options);
}

async function connected(target: App = app): Promise<TestSocket> {
	return open(target).hello();
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
		const quiet = open();
		const { socket } = await attached();
		pi.forRef(PI_SESSION)?.streamToken("hi");
		await socket.ok("sessions/list", {});

		expect(socket.events.length).toBeGreaterThan(0);
		expect(quiet.frames).toEqual([]);
		expect(quiet.ended).toBeNull();
	});

	it("closes a socket whose first frame is a command, and runs nothing it carried", async () => {
		const socket = open();
		socket.send("sessions/attach", { ref: PI_SESSION, token: TEST_API_TOKEN });
		socket.send("sessions/create", { cwd: WORKSPACE, backend: "pi" });
		await Promise.resolve();

		expect(socket.ended?.code).toBe(SOCKET_CLOSE.unauthorized);
		expect(socket.frames).toEqual([]);
		expect(pi.created).toEqual([]);
		expect(app.broadcaster.clientCount).toBe(0);
	});

	it("runs no command of any kind before the hello, a live session's included", async () => {
		// Attached on another socket first, so a command refused here is refused
		// for the missing hello and not because there is nothing to act on.
		const { handle } = await attached();
		const live = pi.forRef(PI_SESSION)!;
		// Unset, so that a command the hello fails to guard is refused here rather
		// than opening whatever editor the environment names.
		const priorEditor = process.env.EDITOR;
		delete process.env.EDITOR;
		try {
			const commands: [CommandName, Record<string, unknown>][] = [
				["sessions/list", {}],
				["sessions/create", { cwd: WORKSPACE, backend: "pi" }],
				["sessions/preview", { ref: PI_SESSION }],
				["sessions/attach", { ref: CODEX_SESSION }],
				["sessions/close", { ref: PI_SESSION }],
				["sessions/prompt", { handle, text: "hello" }],
				["sessions/prompt", { ref: CODEX_SESSION, text: "hello" }],
				["sessions/abort", { handle }],
				["sessions/compact", { handle }],
				["sessions/dismissError", { handle, errorId: "e1" }],
				["sessions/setModel", { handle, model: "pi-1" }],
				["sessions/setEffort", { handle, effort: "high" }],
				["sessions/setName", { handle, name: "renamed" }],
				["sessions/forkPoints", { handle }],
				["sessions/fork", { handle, entryId: "e1" }],
				["sessions/forkAndPrompt", { handle, index: 0, text: "again" }],
				["models/list", {}],
				["draft/edit", { text: "draft" }],
			];
			for (const [cmd, params] of commands) {
				const socket = open();
				socket.send(cmd, params);
				await Promise.resolve();
				expect([cmd, socket.ended?.code, socket.frames]).toEqual([cmd, SOCKET_CLOSE.unauthorized, []]);
			}
		} finally {
			if (priorEditor !== undefined) process.env.EDITOR = priorEditor;
		}

		expect([live.prompts, live.forks, live.aborts, live.compactions, live.disposed]).toEqual([[], [], 0, 0, false]);
		expect(pi.created).toHaveLength(1);
		expect(codex.created).toHaveLength(0);
		expect(index.previewed).toHaveLength(0);
		expect((await app.sessions.list()).some((s) => s.status === "virtual")).toBe(false);
	});

	it("closes a socket whose hello carries the wrong token, or none", async () => {
		const wrong = TEST_API_TOKEN.replace(/.$/, (c) => (c === "x" ? "y" : "x"));
		const tokens = [wrong, `${TEST_API_TOKEN}x`, TEST_API_TOKEN.slice(0, -1), `Bearer ${TEST_API_TOKEN}`, ""];
		for (const params of [...tokens.map((token) => ({ token })), { token: 1 }, {}]) {
			const socket = open();
			socket.send("hello", params);
			socket.send("sessions/list", {});
			await Promise.resolve();
			expect(socket.ended?.code).toBe(SOCKET_CLOSE.unauthorized);
			expect(socket.frames).toEqual([]);
		}
		expect(app.broadcaster.clientCount).toBe(0);
	});

	it("closes a socket whose first frame is not JSON", () => {
		const socket = open();
		socket.connection.receive("not json");
		expect(socket.ended?.code).toBe(SOCKET_CLOSE.unauthorized);
	});

	it("answers the hello after a snapshot of every live session", async () => {
		await attached(PI_SESSION);
		await attached(CODEX_SESSION);
		const socket = open();
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
	it("lists what the index found, without spawning anything (D9), filtered by cwd", async () => {
		const socket = await connected();
		const all = await socket.ok("sessions/list", {});
		expect(all.sessions.map((s) => sessionKey(s.ref))).toEqual([sessionKey(PI_SESSION), sessionKey(CLAUDE_SESSION), sessionKey(CODEX_SESSION)]);
		expect(all.sessions.every((s) => s.status === "detached")).toBe(true);
		expect([pi.created, codex.created]).toEqual([[], []]);
		const here = await socket.ok("sessions/list", { cwd: WORKSPACE });
		expect(here.sessions.map((s) => sessionKey(s.ref))).toEqual([sessionKey(PI_SESSION)]);
	});

	it("lists models, all of them or one backend's", async () => {
		const socket = await connected();
		expect((await socket.ok("models/list", {})).models.map((m) => m.id)).toEqual(["pi-1", "cx-1"]);
		expect((await socket.ok("models/list", { backend: "codex" })).models.map((m) => m.id)).toEqual(["cx-1"]);
		expect((await socket.refused("models/list", { backend: "gemini" })).code).toBe("bad_backend");
	});

	it("lists each model's effort options and its default (OW-kokalo)", async () => {
		const efforts = [
			{ id: "low", description: "Fast" },
			{ id: "medium", description: "Balanced" },
		];
		build({}, { models: [{ id: "cx-1", label: "Codex One", efforts, defaultEffort: "medium" }] });
		const socket = await connected();
		expect((await socket.ok("models/list", { backend: "codex" })).models).toEqual([
			{ id: "cx-1", label: "Codex One", efforts, defaultEffort: "medium" },
		]);
	});

	it("prefers a running agent's answer over an unstarted adapter's", async () => {
		// Verified against the real PiAdapter: `listModels()` before `start()`
		// rejects with "Pi process is not running". So the offline answer is
		// nothing, and the listing lives or dies on using the live session.
		build({ modelsNeedStart: true });
		const socket = await connected();

		const before = await socket.refused("models/list", { backend: "pi" });
		expect([before.code, before.detail]).toEqual(["internal_error", "Pi process is not running"]);
		expect(pi.created[0]?.disposed).toBe(true);

		await socket.ok("sessions/attach", { ref: PI_SESSION });
		expect((await socket.ok("models/list", { backend: "pi" })).models).toEqual([
			{ id: "pi-1", label: "Pi One", efforts: [], defaultEffort: null },
		]);
	});

	it("lists the other backend's models when one cannot answer, or its factory refuses to construct", async () => {
		build({ modelsNeedStart: true });
		let socket = await connected();
		expect((await socket.ok("models/list", {})).models.map((m) => m.id)).toEqual(["cx-1"]);

		const hostile = {
			created: [],
			createdFor: [],
			create() {
				throw new Error("cannot create an adapter without a real thread id");
			},
			forRef: () => undefined,
		} as unknown as FakeAdapterFactory;
		rebuild({ pi: hostile, codex });
		socket = await connected();
		expect((await socket.ok("models/list", {})).models.map((m) => m.id)).toEqual(["cx-1"]);
		const filtered = await socket.refused("models/list", { backend: "pi" });
		expect([filtered.code, filtered.detail]).toEqual(["internal_error", "cannot create an adapter without a real thread id"]);
	});

	it("previews a stored session without attaching it, and says gone for one with no file", async () => {
		const gone: SessionRef = { backend: "pi", id: "/nowhere.jsonl" };
		index.previews.set(sessionKey(gone), null);
		const socket = await connected();
		const preview = await socket.ok("sessions/preview", { ref: PI_SESSION });
		expect(preview).toEqual({ ref: PI_SESSION, turns: [] });
		expect(pi.created).toEqual([]);
		const refused = await socket.refused("sessions/preview", { ref: gone });
		expect(refused.code).toBe("gone");
		expect(pi.created).toEqual([]);
	});

	it("previews each backend's stored transcript through the read seam, never the manager's attach (OW-38)", async () => {
		const piTurns = [previewUser("a pi question"), previewAssistant("a pi answer")];
		const codexTurns = [previewUser("a codex question"), previewAssistant("a codex answer")];
		index.previews.set(sessionKey(PI_SESSION), piTurns);
		index.previews.set(sessionKey(CODEX_SESSION), codexTurns);
		const attach = vi.spyOn(app.sessions, "attach");
		const socket = await connected();

		expect(await socket.ok("sessions/preview", { ref: PI_SESSION })).toEqual({ ref: PI_SESSION, turns: piTurns });
		expect(await socket.ok("sessions/preview", { ref: CODEX_SESSION })).toEqual({ ref: CODEX_SESSION, turns: codexTurns });

		expect(attach).not.toHaveBeenCalled();
		expect([pi.created, codex.created]).toEqual([[], []]);
		expect(index.previewed).toEqual([PI_SESSION, CODEX_SESSION]);
		expect([app.sessions.isAttached(PI_SESSION), app.sessions.isAttached(CODEX_SESSION)]).toEqual([false, false]);
		// And an attach after them spawns as it would have.
		attach.mockRestore();
		expect((await socket.ok("sessions/attach", { ref: PI_SESSION })).session.status).toBe("attached");
		expect(pi.forRef(PI_SESSION)?.started).toBe(true);
	});

	describe("a session the manager holds with no file yet previews empty, not gone", () => {
		it("a created session before its first prompt", async () => {
			const socket = await connected();
			const { session } = await socket.ok("sessions/create", { cwd: WORKSPACE, backend: "pi" });
			index.previews.set(sessionKey(session.ref), null);
			expect(app.sessions.isAttached(session.ref)).toBe(true);
			expect((await socket.ok("sessions/preview", { ref: session.ref })).turns).toEqual([]);
		});

		it("a parked fork before its attach, which the table does not hold", async () => {
			rebuild({ claude: new FakeAdapterFactory({ forkMode: "claude" }) });
			const { socket, handle } = await attached(CLAUDE_SESSION);
			const { ref } = await socket.ok("sessions/fork", { handle, entryId: "e1" });
			index.previews.set(sessionKey(ref), null);
			expect(app.sessions.summaryOf(ref)).toBeNull();
			expect((await socket.ok("sessions/preview", { ref })).turns).toEqual([]);
		});
	});

	it("answers fork points and whether a fork stops the turn, which only the adapter's fork says (D30)", async () => {
		build({ forkPoints: [{ id: "e1", text: "first", index: 0 }] }, { forkMode: "codex" });
		const { socket, handle } = await attached();
		expect(await socket.ok("sessions/forkPoints", { handle })).toEqual({
			points: [{ id: "e1", text: "first", index: 0 }],
			forkStopsTurn: true,
		});
		const { session } = await socket.ok("sessions/attach", { ref: CODEX_SESSION });
		expect((await socket.ok("sessions/forkPoints", { handle: session.handle })).forkStopsTurn).toBe(false);
	});

	it("round-trips a draft through EDITOR", async () => {
		const priorEditor = process.env.EDITOR;
		process.env.EDITOR = `sh ${new URL("./testing/editor-fixture.sh", import.meta.url).pathname} --replace`;
		try {
			const socket = await connected();
			expect(await socket.ok("draft/edit", { text: "original" })).toEqual({ text: "edited by fixture" });
			// The fixture exits 1 without its flag, and what it wrote is not read.
			process.env.EDITOR = `sh ${new URL("./testing/editor-fixture.sh", import.meta.url).pathname}`;
			expect(await socket.refused("draft/edit", { text: "original" })).toMatchObject({
				code: "editor_failed",
				detail: "external editor exited with status 1",
			});
			delete process.env.EDITOR;
			expect((await socket.refused("draft/edit", { text: "original" })).code).toBe("editor_failed");
		} finally {
			if (priorEditor === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = priorEditor;
		}
	});
});

describe("commands that name a ref", () => {
	it("attaches, spawning in the session's own workspace (D7) and writing its snapshot before the reply", async () => {
		const socket = await connected();
		const id = socket.send("sessions/attach", { ref: PI_SESSION });
		const reply = await socket.reply(id);

		expect(socket.shape.slice(-2)).toEqual(["snapshot", `reply:${id}`]);
		expect(reply.ok && (reply.result as Commands["sessions/attach"]["result"]).session.status).toBe("attached");
		expect(pi.forRef(PI_SESSION)?.startOptions).toEqual({ cwd: WORKSPACE, resumeId: PI_SESSION.id });
		// Attaching a Pi session must not spawn Codex.
		expect(codex.created).toHaveLength(0);
	});

	it("reuses the subprocess when attached twice", async () => {
		const socket = await connected();
		await socket.ok("sessions/attach", { ref: PI_SESSION });
		await socket.ok("sessions/attach", { ref: PI_SESSION });
		expect(pi.created).toHaveLength(1);
	});

	it("refuses not_found for a session no store knows, no_backend for a backend with no adapter, and server_shutting_down at shutdown", async () => {
		rebuild({ pi });
		let socket = await connected();
		expect((await socket.refused("sessions/attach", { ref: { backend: "pi", id: "/nope.jsonl" } })).code).toBe("not_found");
		expect((await socket.refused("sessions/attach", { ref: CODEX_SESSION })).code).toBe("no_backend");

		await app.close();
		socket = await connected();
		const reply = await socket.refused("sessions/attach", { ref: PI_SESSION });
		expect([reply.code, reply.detail]).toEqual(["server_shutting_down", "server is shutting down; not spawning a new agent"]);
		expect(pi.created).toHaveLength(0);
	});

	it("logs an attach failure with its session ref", async () => {
		rebuild({ pi: new FakeAdapterFactory({ failStart: "sbox: no git root" }) });
		const socket = await connected();
		expect((await socket.refused("sessions/attach", { ref: PI_SESSION })).code).toBe("internal_error");
		expect(logged).toEqual([`sessions/attach session ${sessionKey(PI_SESSION)}: sbox: no git root`]);
	});

	it("refuses a ref with an unknown backend, or none", async () => {
		const socket = await connected();
		expect((await socket.refused("sessions/attach", { ref: { backend: "gemini", id: "x" } })).code).toBe("bad_backend");
		expect((await socket.refused("sessions/attach", {})).code).toBe("bad_request");
		expect((await socket.refused("sessions/attach", { ref: { backend: "pi" } })).code).toBe("bad_request");
	});

	it("creates a session started and live, with its model and no resumeId, and lists it attached (D30)", async () => {
		const socket = await connected();
		socket.clear();
		const id = socket.send("sessions/create", { cwd: WORKSPACE, backend: "pi", model: "pi-1" });
		const reply = await socket.reply(id);
		if (!reply.ok) throw new Error(reply.code);
		const { session } = reply.result as Commands["sessions/create"]["result"];

		expect(session).toEqual(expect.objectContaining({ status: "attached", cwd: WORKSPACE, onDisk: false, handle: expect.any(String) }));
		expect(session.ref.id).toMatch(/^virtual:/);
		expect(socket.order).toEqual([
			["sessions-changed", null],
			["snapshot", session.handle],
			["reply", id],
		]);
		expect(pi.forRef(session.ref)?.startOptions).toEqual({ cwd: WORKSPACE, model: "pi-1" });
		const { sessions } = await socket.ok("sessions/list", {});
		expect(sessions.find((s) => sessionKey(s.ref) === sessionKey(session.ref))?.status).toBe("attached");
	});

	it("refuses to create in a workspace that is relative or not there, or for an unknown backend", async () => {
		const socket = await connected();
		for (const cwd of ["relative/workspace", `${WORKSPACE}/no-such-agentpane-workspace`]) {
			expect([cwd, (await socket.refused("sessions/create", { cwd, backend: "pi" })).code]).toEqual([cwd, "bad_request"]);
		}
		expect((await socket.refused("sessions/create", { cwd: WORKSPACE, backend: "gemini" })).code).toBe("bad_backend");
		expect(pi.created).toHaveLength(0);
	});

	it("refuses a listing's cwd or a create's model that is not a string, starting nothing", async () => {
		const socket = await connected();
		expect((await socket.refused("sessions/list", { cwd: 1 })).code).toBe("bad_request");
		expect((await socket.refused("sessions/create", { cwd: WORKSPACE, backend: "pi", model: 1 })).code).toBe("bad_request");
		expect(pi.created).toHaveLength(0);
	});

	it("leaves no session behind when a create's start fails (D30)", async () => {
		rebuild({ pi: new FakeAdapterFactory({ failStart: "sbox: no git root" }) });
		const socket = await connected();

		const reply = await socket.refused("sessions/create", { cwd: WORKSPACE, backend: "pi" });

		expect([reply.code, reply.detail]).toEqual(["internal_error", "sbox: no git root"]);
		const { sessions } = await socket.ok("sessions/list", {});
		expect(sessions.map((s) => sessionKey(s.ref))).toEqual([sessionKey(PI_SESSION), sessionKey(CLAUDE_SESSION), sessionKey(CODEX_SESSION)]);
	});

	it("closes a session by its ref, writing its end before the reply", async () => {
		const { socket, handle } = await attached();
		const id = socket.send("sessions/close", { ref: PI_SESSION });
		await socket.reply(id);

		expect(socket.shape).toEqual(["ended", "sessions-changed", `reply:${id}`]);
		expect(socket.events[0]).toMatchObject({ type: "ended", handle });
		expect(pi.forRef(PI_SESSION)?.disposed).toBe(true);
		expect(app.sessions.isAttached(PI_SESSION)).toBe(false);
	});

	it("prompts by ref, attaching the session, and names it in the reply after its snapshot (D30)", async () => {
		const socket = await connected();
		socket.clear();
		const id = socket.send("sessions/prompt", { ref: PI_SESSION, text: "hello" });
		const reply = await socket.reply(id);
		if (!reply.ok) throw new Error(reply.code);

		expect(reply.result).toEqual({ disposition: "started", session: app.sessions.summaryOf(PI_SESSION) });
		expect(reply.result).toMatchObject({ session: { ref: PI_SESSION, status: "attached" } });
		expect(socket.order).toEqual([
			["sessions-changed", null],
			["snapshot", app.sessions.summaryOf(PI_SESSION)?.handle],
			["reply", id],
		]);
		expect(pi.forRef(PI_SESSION)?.prompts).toEqual([{ text: "hello", images: undefined }]);
	});

	it("answers a prompt by ref the backend handled, naming the session", async () => {
		build({ onSubmit: () => "handled" });
		const socket = await connected();
		expect(await socket.ok("sessions/prompt", { ref: PI_SESSION, text: "/mcp" })).toEqual({
			disposition: "handled",
			session: app.sessions.summaryOf(PI_SESSION),
		});
	});

	it("answers a prompt by ref whose start failed as that failure, naming nothing and leaving nothing attached", async () => {
		build({ failStart: "would not start" });
		const socket = await connected();
		const reply = await socket.refused("sessions/prompt", { ref: PI_SESSION, text: "hello" });

		expect(reply).toEqual({ type: "reply", id: reply.id, ok: false, code: "internal_error", detail: "would not start" });
		expect(app.sessions.isAttached(PI_SESSION)).toBe(false);
	});

	it("keeps an error the start of a prompt by ref raised, which its sender cannot have held (OW-jokoto)", async () => {
		build({ onStart: (adapter) => adapter.emitError("resumed with a warning") });
		const socket = await connected();
		await socket.ok("sessions/prompt", { ref: PI_SESSION, text: "hello" });
		expect(app.sessions.errorIdOf(PI_SESSION)).not.toBeNull();
	});

	it("names the session it attached in a prompt's refusal after the attach (D30)", async () => {
		build({
			onSubmit() {
				throw new BackendRefusedError("not now");
			},
		});
		const socket = await connected();
		socket.clear();
		const reply = await socket.refused("sessions/prompt", { ref: PI_SESSION, text: "hello" });

		expect([reply.code, reply.detail]).toEqual(["backend_refused", "not now"]);
		expect(reply.attached).toEqual({ ref: PI_SESSION, handle: app.sessions.summaryOf(PI_SESSION)?.handle });
		expect(socket.order).toEqual([
			["sessions-changed", null],
			["snapshot", reply.attached?.handle],
			["reply", reply.id],
		]);
		expect(app.sessions.isAttached(PI_SESSION)).toBe(true);
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
		expect((await socket.refused("sessions/prompt", { handle: 1, text: "x" })).code).toBe("bad_request");
		expect(pi.forRef(PI_SESSION)?.prompts).toEqual([]);
	});

	it("sends no snapshot for a prompt to a session already attached (OW-yirosu)", async () => {
		const { socket, handle } = await attached();
		await socket.ok("sessions/prompt", { handle, text: "hello" });
		expect(socket.typed("snapshot")).toEqual([]);
	});

	it("does not answer a prompt before the adapter's admission succeeds", async () => {
		build({
			onSubmit() {
				throw new Error("agent is wedged");
			},
		});
		const { socket, handle } = await attached();
		const reply = await socket.refused("sessions/prompt", { handle, text: "go" });
		expect([reply.code, reply.detail]).toEqual(["internal_error", "agent is wedged"]);
		expect(socket.typed("error")).toEqual([]);
	});

	it("aborts, answering the prompts the stop took out to that requester alone (OW-wisifo)", async () => {
		const { socket, handle } = await attached();
		const watching = await connected();
		const adapter = pi.forRef(PI_SESSION)!;
		adapter.setStreaming(true);
		adapter.queued = ["first steer", "second steer"];
		expect(await socket.ok("sessions/abort", { handle })).toEqual({ queued: ["first steer", "second steer"] });
		expect(await socket.ok("sessions/abort", { handle })).toEqual({ queued: [] });
		expect(adapter.aborts).toBe(2);
		// The stop's own status goes to everyone, and the texts do not.
		expect(watching.typed("status").at(-1)?.isStreaming).toBe(false);
		expect(JSON.stringify(watching.frames)).not.toContain("first steer");
		expect(JSON.stringify(socket.events)).not.toContain("first steer");
	});

	it("compacts, its status written before the reply", async () => {
		const { socket, handle } = await attached();
		const id = socket.send("sessions/compact", { handle });
		await socket.reply(id);
		expect(socket.shape).toEqual(["status", `reply:${id}`]);
		expect(socket.typed("status")[0]).toMatchObject({ isStreaming: false, compaction: "requesting" });
		expect(pi.forRef(PI_SESSION)?.compactions).toBe(1);
		// A client that connects now is told, in its opening snapshot (OW-72).
		const late = await connected();
		expect(late.typed("snapshot")).toEqual([expect.objectContaining({ session: PI_SESSION, compaction: "requesting" })]);
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

	it("names a session through its adapter, then says sessions-changed and lists the name (D27, OW-jamaha)", async () => {
		const { socket, handle } = await attached();
		const id = socket.send("sessions/setName", { handle, name: "  probe\r\nname " });
		expect((await socket.reply(id)).ok).toBe(true);
		// Line breaks collapsed and trimmed, as Pi stores it (`pi 1.0.0`), so every backend holds the same string.
		expect(pi.forRef(PI_SESSION)?.name).toBe("probe name");
		expect(socket.order).toEqual([
			["sessions-changed", null],
			["reply", id],
		]);
		const { sessions } = await socket.ok("sessions/list", {});
		expect(sessions.find((summary) => sessionKey(summary.ref) === sessionKey(PI_SESSION))?.name).toBe("probe name");
		for (const params of [{ name: "   " }, {}]) {
			expect((await socket.refused("sessions/setName", { handle, ...params })).code).toBe("bad_request");
		}
		expect(pi.forRef(PI_SESSION)?.name).toBe("probe name");
	});

	it("hands two overlapping model requests to the adapter one at a time (OW-sewewe)", async () => {
		const log: [string, string][] = [];
		const entered = [deferred(), deferred()];
		const gates = [deferred(), deferred()];
		let calls = 0;
		build({
			async onSetModel(model) {
				const n = calls++;
				log.push(["begin", model]);
				entered[n]?.resolve();
				await gates[n]?.promise;
				log.push(["end", model]);
			},
		});
		const { socket, handle } = await attached();

		const one = socket.send("sessions/setModel", { handle, model: "pi-2" });
		const two = socket.send("sessions/setModel", { handle, model: "pi-3" });
		await entered[0]?.promise;
		// Time for the other command to reach the adapter, which is all it needs
		// when nothing orders the two.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(log).toHaveLength(1);

		gates[0]?.resolve();
		gates[1]?.resolve();
		expect((await socket.reply(one)).ok).toBe(true);
		expect((await socket.reply(two)).ok).toBe(true);
		expect(log).toEqual([
			["begin", "pi-2"],
			["end", "pi-2"],
			["begin", "pi-3"],
			["end", "pi-3"],
		]);
	});

	it("checks an effort against the model a set-model sent just before it chose (OW-sewewe, OW-zayefe)", async () => {
		const entered = deferred();
		const gate = deferred();
		build({}, {
			models: [
				{ id: "cx-plain", label: "Codex Plain", efforts: [], defaultEffort: null },
				{ id: "cx-1", label: "Codex One", efforts: [{ id: "low", description: "Fast" }], defaultEffort: "low" },
			],
			async onSetModel(model) {
				if (model !== "cx-1") return;
				entered.resolve();
				await gate.promise;
			},
		});
		const { socket, handle } = await attached(CODEX_SESSION);
		await socket.ok("sessions/setModel", { handle, model: "cx-plain" });

		// The effort is sent while the model that lists it is still being set.
		const model = socket.send("sessions/setModel", { handle, model: "cx-1" });
		await entered.promise;
		const effort = socket.send("sessions/setEffort", { handle, effort: "low" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		gate.resolve();

		expect((await socket.reply(model)).ok).toBe(true);
		expect((await socket.reply(effort)).ok).toBe(true);
		expect(codex.forRef(CODEX_SESSION)?.effort).toBe("low");
	});

	it("refuses backend_refused with the backend's reason when it refuses the model, and internal_error when it fails (OW-pizaki)", async () => {
		build({
			onSetModel(model) {
				if (model === "dead") throw new Error("Pi process is not running");
				throw new BackendRefusedError(`Model not found: ${model}`);
			},
		});
		const { socket, handle } = await attached();

		const refused = await socket.refused("sessions/setModel", { handle, model: "nobody/nothing" });
		expect([refused.code, refused.detail]).toEqual(["backend_refused", "Model not found: nobody/nothing"]);
		expect(pi.forRef(PI_SESSION)?.model).not.toBe("nobody/nothing");
		expect((await socket.refused("sessions/setModel", { handle, model: "dead" })).code).toBe("internal_error");
	});

	/**
	 * Every backend took any string: Claude Code and Pi answered success and
	 * applied something else or nothing, and Codex stored it for the next
	 * turn, so the command was admitted for a choice no client offers.
	 */
	it("refuses an effort the session's model does not list, before the adapter sees it (OW-tewofe)", async () => {
		build({}, {
			models: [
				{ id: "cx-1", label: "Codex One", efforts: [{ id: "low", description: "Fast" }], defaultEffort: "low" },
				{ id: "cx-plain", label: "Codex Plain", efforts: [], defaultEffort: null },
			],
		});
		const { socket, handle } = await attached(CODEX_SESSION);

		// No model known yet: the clients offer no effort then, and neither does this.
		expect((await socket.refused("sessions/setEffort", { handle, effort: "low" })).code).toBe("bad_request");
		await socket.ok("sessions/setModel", { handle, model: "cx-1" });
		expect((await socket.refused("sessions/setEffort", { handle, effort: "extreme" })).code).toBe("bad_request");
		await socket.ok("sessions/setModel", { handle, model: "cx-plain" });
		expect((await socket.refused("sessions/setEffort", { handle, effort: "low" })).code).toBe("bad_request");
		expect(codex.forRef(CODEX_SESSION)?.effort).toBeUndefined();
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

	it("refuses backend_refused with the backend's reason when it refuses the fork (OW-rasiwa)", async () => {
		build({
			onFork() {
				throw new BackendRefusedError("Invalid entry ID for forking");
			},
		});
		const { socket, handle } = await attached();
		const reply = await socket.refused("sessions/fork", { handle, entryId: "no-such-entry" });
		expect(reply).toEqual({ type: "reply", id: reply.id, ok: false, code: "backend_refused", detail: "Invalid entry ID for forking" });
		expect(pi.forRef(PI_SESSION)?.forks).toEqual([]);
	});

	it("forks and prompts, answering the fork live", async () => {
		build({ forkPoints: [{ id: "e1", text: "first", index: 0 }] });
		const { socket, handle } = await attached();
		const id = socket.send("sessions/forkAndPrompt", { handle, index: 0, text: "again" });
		const answer = await socket.reply(id);
		if (!answer.ok) throw new Error(answer.code);
		const reply = answer.result as Commands["sessions/forkAndPrompt"]["result"];

		expect(reply.disposition).toBe("started");
		expect(reply.session.handle).not.toBe(handle);
		expect(pi.forRef(reply.session.ref)?.prompts.map((p) => p.text)).toEqual(["again"]);
		// A Pi fork moves the parent's process onto the fork (`#forkOnto`).
		expect(socket.order).toEqual([
			["ended", handle],
			["sessions-changed", null],
			["snapshot", reply.session.handle],
			["reply", id],
		]);
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
		for (const [params, detail] of [
			[{ text: "x" }, "index must be an integer"],
			[{ index: 0.5, text: "x" }, "index must be an integer"],
			[{ index: 0 }, "text is required and must be a string"],
		] as const) {
			const reply = await socket.refused("sessions/forkAndPrompt", { handle, ...params });
			expect([reply.code, reply.detail]).toEqual(["bad_request", detail]);
		}
		// Nothing above forked (D20).
		expect(pi.forRef(PI_SESSION)?.forks).toEqual([]);

		socket.clear();
		const reply = await socket.refused("sessions/forkAndPrompt", { handle, index: 0, text: "again" });
		expect(reply.code).toBe("backend_refused");
		expect(reply.fork?.ref).toEqual({ backend: "pi", id: `${PI_SESSION.id}#fork-e1` });
		expect(reply.fork?.handle).toEqual(expect.any(String));
		expect(socket.order).toEqual([
			["ended", handle],
			["sessions-changed", null],
			["snapshot", reply.fork?.handle],
			["reply", reply.id],
		]);
	});

	describe("a fork whose own start or prompt failed is named, and stays (D17, D30)", () => {
		const POINTS = [{ id: "e1", text: "first ask", index: 0 }];
		const FORK = { backend: "claude", id: `${CLAUDE_SESSION.id}#fork-e1` } as SessionRef;

		it("answers a prompt the fork refused as that refusal, naming the fork live", async () => {
			const options: FakeAdapterOptions = { forkPoints: POINTS, forkMode: "claude" };
			rebuild({ claude: new FakeAdapterFactory(options) });
			const { socket, handle } = await attached(CLAUDE_SESSION);
			options.onSubmit = () => {
				throw new BackendRefusedError("not now");
			};

			const reply = await socket.refused("sessions/forkAndPrompt", { handle, index: 0, text: "again" });

			expect([reply.code, reply.detail, reply.fork]).toEqual(["backend_refused", "not now", { ref: FORK, handle: expect.any(String) }]);
			expect(socket.order).toEqual([
				["sessions-changed", null],
				["snapshot", reply.fork?.handle],
				["reply", reply.id],
			]);
			const { session } = await socket.ok("sessions/attach", { ref: FORK });
			expect(session.handle).toBe(reply.fork?.handle);
		});

		it("answers a fork whose start failed with that failure, naming the fork by its ref and no handle", async () => {
			const options: FakeAdapterOptions = { forkPoints: POINTS, forkMode: "claude" };
			rebuild({ claude: new FakeAdapterFactory(options) });
			const { socket, handle } = await attached(CLAUDE_SESSION);
			options.failStart = "fork would not start";

			const reply = await socket.refused("sessions/forkAndPrompt", { handle, index: 0, text: "again" });

			expect([reply.code, reply.detail, reply.fork]).toEqual(["internal_error", "fork would not start", { ref: FORK, handle: null }]);
		});

		it("answers a Pi fork that failed after it moved with that failure, naming the fork live", async () => {
			build({ forkPoints: POINTS });
			const { socket, handle } = await attached();
			const adapter = pi.forRef(PI_SESSION)!;
			const fork = adapter.fork.bind(adapter);
			// As `PiAdapter.fork` can at `set_thinking_level` or `hydrateMessages`,
			// after it has announced the move.
			adapter.fork = async (entryId) => {
				await fork(entryId);
				throw new Error("set_thinking_level failed");
			};

			const reply = await socket.refused("sessions/forkAndPrompt", { handle, index: 0, text: "again" });

			const piFork: SessionRef = { backend: "pi", id: `${PI_SESSION.id}#fork-e1` };
			expect([reply.code, reply.detail, reply.fork]).toEqual(["internal_error", "set_thinking_level failed", { ref: piFork, handle: expect.any(String) }]);
			expect(reply.fork?.handle).not.toBe(handle);
			// The parent's handle ends, and the refusal follows a view of the fork,
			// so a client moving to the fork finds it live (D30).
			expect(socket.order).toEqual([
				["ended", handle],
				["sessions-changed", null],
				["snapshot", reply.fork?.handle],
				["reply", reply.id],
			]);
			const { session } = await socket.ok("sessions/attach", { ref: piFork });
			expect(session.handle).toBe(reply.fork?.handle);
			expect(adapter.prompts).toEqual([]);
		});
	});

	it("refuses every one of them for a handle never live, and starts no agent (D25, OW-sirofi)", async () => {
		const socket = await connected();
		const commands: [CommandName, Record<string, unknown>][] = [
			["sessions/prompt", { text: "x" }],
			["sessions/abort", {}],
			["sessions/compact", {}],
			["sessions/dismissError", { errorId: "e" }],
			["sessions/setModel", { model: "pi-1" }],
			["sessions/setEffort", { effort: "low" }],
			["sessions/setName", { name: "probe name" }],
			["sessions/forkPoints", {}],
			["sessions/fork", { entryId: "e1" }],
			["sessions/forkAndPrompt", { index: 0, text: "x" }],
		];
		for (const [cmd, params] of commands) {
			expect([cmd, (await socket.refused(cmd, { handle: "never-minted", ...params })).code]).toEqual([cmd, "not_attached"]);
		}
		expect([pi.created, codex.created]).toEqual([[], []]);
	});

	it("respawns nothing for a prompt or a model that arrives while a close is out", async () => {
		const { socket, handle } = await attached();
		const adapter = pi.forRef(PI_SESSION)!;
		const held = deferred();
		const dispose = adapter.dispose.bind(adapter);
		adapter.dispose = async () => {
			await held.promise;
			await dispose();
		};

		const closing = socket.send("sessions/close", { ref: PI_SESSION });
		await vi.waitFor(() => expect(app.sessions.isAttached(PI_SESSION)).toBe(false));
		// Answered while the disposal is still held, so both arrive inside the close's window.
		const prompt = await socket.refused("sessions/prompt", { handle, text: "hello" });
		const model = await socket.refused("sessions/setModel", { handle, model: "pi-2" });
		expect([prompt.code, model.code]).toEqual(["not_attached", "not_attached"]);
		expect(pi.created).toHaveLength(1);

		held.resolve();
		expect((await socket.reply(closing)).ok).toBe(true);
		expect(pi.created).toHaveLength(1);
		expect(app.sessions.isAttached(PI_SESSION)).toBe(false);
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

describe("events", () => {
	it("carries the session on every event, one socket for all of them", async () => {
		const socket = await connected();
		await socket.ok("sessions/attach", { ref: PI_SESSION });
		await socket.ok("sessions/attach", { ref: CODEX_SESSION });
		pi.forRef(PI_SESSION)?.append(userMessage("pi"));
		codex.forRef(CODEX_SESSION)?.append(userMessage("codex"));

		expect(socket.transcript(PI_SESSION)).toHaveLength(1);
		expect(socket.transcript(CODEX_SESSION)).toHaveLength(1);
		expect(app.broadcaster.clientCount).toBe(1);
	});

	it("streams a turn as tail upserts with a monotonic seq (D3)", async () => {
		const { socket } = await attached();
		const adapter = pi.forRef(PI_SESSION);

		adapter?.append(userMessage("hi"));
		adapter?.setStreaming(true);
		adapter?.streamToken("Hel");
		adapter?.streamToken("lo");
		adapter?.setStreaming(false);

		// Only ever the tail moves, and it moves by index -- never by resending
		// the transcript. That keeps a token's cost free of the transcript's length.
		expect(socket.typed("upsert").map((u) => u.index)).toEqual([0, 1, 1]);
		expect(socket.typed("status").map((s) => s.isStreaming)).toEqual([true, false]);
		expect(socket.typed("snapshot")).toHaveLength(0);
		// Contiguous seq from the attach's snapshot onwards: nothing was missed.
		expect(socket.gaps).toEqual([]);
		expect(socket.seq(PI_SESSION)).toBe(app.broadcaster.seqOf(app.sessions.summaryOf(PI_SESSION)?.handle ?? ""));
		const tail = socket.transcript(PI_SESSION)[1];
		expect(tail?.role === "assistant" && tail.content[0]).toEqual({ type: "text", text: "Hello" });
	});

	it("falls back to a snapshot when the adapter cannot localise the change", async () => {
		const { socket } = await attached();
		const adapter = pi.forRef(PI_SESSION);

		adapter?.append(userMessage("one"));
		adapter?.messages.push(assistantMessage("compacted"));
		adapter?.emitTranscriptReplaced();

		expect(socket.transcript(PI_SESSION)).toHaveLength(2);
		// A broadcast snapshot resets the sequence for everyone at once.
		expect(socket.typed("snapshot").at(-1)?.seq).toBe(0);
		expect(socket.gaps).toEqual([]);
	});

	it("shows a dropped update as a seq gap, which a fresh socket's opening snapshot repairs", async () => {
		await connected().then((socket) => socket.ok("sessions/attach", { ref: PI_SESSION }));
		const adapter = pi.forRef(PI_SESSION);

		// This client loses the upsert for message 1, and nothing later touches
		// that index again -- upserts are idempotent full-message replacements,
		// so the only losses that last are the ones nothing overwrites. In
		// process nothing is really lost, which is why the loss has to be
		// injected to show `seq` earns its place.
		const lossy = await open(app, { drop: (event) => event.type === "upsert" && event.index === 1 }).hello();

		adapter?.append(userMessage("hi"));
		adapter?.streamToken("answer");
		adapter?.append(userMessage("and another thing"));

		// The client can tell it is behind -- and it is, with a hole where the
		// assistant's reply should be.
		expect(lossy.gaps).toEqual([sessionKey(PI_SESSION)]);
		expect(lossy.transcript(PI_SESSION)[1]).toBeUndefined();
		expect(lossy.transcript(PI_SESSION)[2]).toBeDefined();
		lossy.close();

		// A fresh socket takes a fresh snapshot (D3); what a client does about
		// the gap it saw is D25's, which detaches the session.
		const repaired = await connected();
		const filled = repaired.transcript(PI_SESSION)[1];
		expect(filled?.role === "assistant" && filled.content[0]).toEqual({ type: "text", text: "answer" });
		// And it is back in step, so the next update is not another gap.
		adapter?.streamToken("!");
		expect(repaired.typed("upsert")).toHaveLength(1);
		expect(repaired.gaps).toEqual([]);
	});

	it("keeps several tabs in step, including one that joins mid-turn", async () => {
		const { socket: first } = await attached();
		const adapter = pi.forRef(PI_SESSION);

		adapter?.append(userMessage("hi"));
		adapter?.setStreaming(true);
		adapter?.streamToken("half");

		// A second tab opens while the turn is running. Its opening snapshot
		// carries the counter's current value, so it lands in step rather than
		// resetting a sequence the first tab is still counting from.
		const second = await connected();
		expect(second.seq(PI_SESSION)).toBe(app.broadcaster.seqOf(app.sessions.summaryOf(PI_SESSION)?.handle ?? ""));

		adapter?.streamToken(" the rest");
		adapter?.setStreaming(false);

		expect([first.isStreaming(PI_SESSION), second.isStreaming(PI_SESSION)]).toEqual([false, false]);
		expect([first.gaps, second.gaps]).toEqual([[], []]);
		expect(second.transcript(PI_SESSION)).toEqual(first.transcript(PI_SESSION));
	});

	it("resets the sequence for every tab at once on a re-attach", async () => {
		const { socket: first } = await attached();
		const second = await connected();
		const adapter = pi.forRef(PI_SESSION);

		adapter?.append(userMessage("hi"));
		expect(first.seq(PI_SESSION)).toBe(1);

		// A session switch re-attaches, which snapshots everyone.
		await first.ok("sessions/attach", { ref: PI_SESSION });
		expect([first.typed("snapshot").length, second.typed("snapshot").length]).toEqual([1, 2]);

		adapter?.streamToken("after");
		expect([first.gaps, second.gaps]).toEqual([[], []]);
		expect([first.seq(PI_SESSION), second.seq(PI_SESSION)]).toEqual([1, 1]);
	});

	it("goes on to the others when a client goes away mid-fanout", async () => {
		const { socket: survivor } = await attached();
		const adapter = pi.forRef(PI_SESSION);

		// A send that starts throwing is what a socket closing under us looks
		// like from in here.
		let thrown = 0;
		app.broadcaster.addClient(() => {
			thrown++;
			throw new Error("EPIPE");
		});
		expect(app.broadcaster.clientCount).toBe(2);

		adapter?.append(userMessage("hi"));

		expect(survivor.transcript(PI_SESSION)).toHaveLength(1);
		expect(thrown).toBe(1);
		expect(app.broadcaster.clientCount).toBe(1);
		expect(adapter?.disposed).toBe(false);
	});

	it("leaves the agent alone when the socket drops, and a reconnect is a repaint", async () => {
		const { socket } = await attached();
		const adapter = pi.forRef(PI_SESSION);

		socket.close();

		expect(app.broadcaster.clientCount).toBe(0);
		expect(adapter?.disposed).toBe(false);
		expect(app.sessions.isAttached(PI_SESSION)).toBe(true);

		// The agent keeps working with nobody watching...
		adapter?.append(userMessage("while you were out"));
		adapter?.streamToken("done");

		// ...and a reconnect is a repaint, not a lifecycle event.
		const reconnected = await connected();
		expect(pi.created).toHaveLength(1);
		expect(reconnected.transcript(PI_SESSION)).toHaveLength(2);
	});

	it("follows a session that adopts its backend id on the first prompt by its handle (D9)", async () => {
		// A virtual Pi session whose backend named nothing by the end of attach --
		// the case D9 keeps the first-prompt rename for -- in one test: create it,
		// prompt it, and watch it become a real JSONL path under the client. The
		// client has to be able to follow that without losing the transcript,
		// because the id it created the session with is not the id it keeps.
		const REAL: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/materialised.jsonl" };
		const renaming = new FakeAdapterFactory({
			materialiseOnSubmit: REAL.id,
			onSubmit(adapter, text) {
				adapter.append(userMessage(text));
			},
		});
		rebuild({ pi: renaming }, { newId: () => "n1" });
		const socket = await connected();

		const { session } = await socket.ok("sessions/create", { cwd: WORKSPACE, backend: "pi" });
		expect(session.ref.id).toContain("virtual:");
		await socket.ok("sessions/prompt", { handle: session.handle, text: "first" });

		const naming = (at: SessionRef) => socket.typed("snapshot").filter((event) => sessionKey(event.session) === sessionKey(at));
		// Said by a snapshot under the handle the session had all along, and by
		// nothing beside it (OW-mofuho).
		expect(naming(REAL).map((event) => event.handle)).toEqual([session.handle]);
		expect(socket.events.map((event) => event.type)).not.toContain("renamed");

		// A client that follows the rename keeps the conversation, under the new id
		// and only the new id.
		expect(socket.transcript(REAL)).toHaveLength(1);
		expect(socket.transcript(session.ref)).toEqual([]);
		expect(socket.gaps).toEqual([]);

		// The list shows the conversation once, under the id it now has.
		const { sessions } = await socket.ok("sessions/list", {});
		expect(sessions.filter((s) => s.status === "attached").map((s) => s.ref.id)).toEqual([REAL.id]);

		// The handle still reaches it, and so does the ref it was created under.
		await socket.ok("sessions/prompt", { handle: session.handle, text: "second" });
		await socket.ok("sessions/prompt", { ref: session.ref, text: "third" });
		expect(socket.transcript(REAL)).toHaveLength(3);
		expect(renaming.created).toHaveLength(1);

		// And the new id is a first-class ref: attaching it re-attaches rather
		// than spawning a second agent on the same session file.
		const reopened = await socket.ok("sessions/attach", { ref: REAL });
		expect(reopened.session).toMatchObject({ ref: REAL, handle: session.handle });
		expect(renaming.created).toHaveLength(1);
	});
});

describe("backend notices (OW-tujiya)", () => {
	it("carries a notice out for its own session, and not as an error", async () => {
		const { socket } = await attached(CODEX_SESSION);
		const notice = { kind: "configWarning", message: "unknown key", details: "see the docs", path: "/c.toml:3:5" };

		codex.forRef(CODEX_SESSION)?.emitNotice(notice);

		const [event] = socket.typed("notice");
		expect(event).toMatchObject({ type: "notice", session: CODEX_SESSION, notice });
		expect(typeof event?.seq).toBe("number");
		expect(socket.typed("error")).toEqual([]);
	});
});

describe("what a client that connects late is told (OW-bipume)", () => {
	it("opens on a snapshot carrying the turn error and the notices", async () => {
		await attached(CODEX_SESSION);
		const adapter = codex.forRef(CODEX_SESSION);
		adapter?.emitError("turn failed");
		const notice = { kind: "configWarning", message: "unknown key", details: null, path: null };
		adapter?.emitNotice(notice);

		const late = await connected();

		expect(late.typed("snapshot")).toEqual([expect.objectContaining({ session: CODEX_SESSION, error: "turn failed", notices: [notice] })]);
	});

	/** Raise a turn error on the attached Pi session, and the id its `error` event named it by. */
	function raise(socket: TestSocket, message: string): string {
		pi.forRef(PI_SESSION)?.emitError(message);
		const raised = socket.typed("error").at(-1);
		if (raised?.message !== message) throw new Error("no error event");
		return raised.errorId;
	}

	/** The opening snapshot a socket that connects now is sent for the Pi session. */
	async function lateSnapshot() {
		return (await connected()).typed("snapshot").find((event) => sessionKey(event.session) === sessionKey(PI_SESSION));
	}

	it("forgets a dismissed error, so no later snapshot shows it again", async () => {
		const { socket, handle } = await attached();
		const shown = raise(socket, "turn failed");

		await socket.ok("sessions/dismissError", { handle, errorId: shown });

		expect((await lateSnapshot())?.error).toBeNull();
	});

	it("keeps a newer error than the one a client dismissed", async () => {
		const { socket, handle } = await attached();
		const shown = raise(socket, "first turn failed");
		// Another client's turn fails while this one's Dismiss is on its way.
		raise(socket, "second turn failed");

		await socket.ok("sessions/dismissError", { handle, errorId: shown });

		expect((await lateSnapshot())?.error).toBe("second turn failed");
	});

	it("tells every other client a dismissed error went, with no snapshot (OW-jopifu)", async () => {
		const { socket, handle } = await attached();
		const shown = raise(socket, "turn failed");
		const watching = await connected();

		await socket.ok("sessions/dismissError", { handle, errorId: shown });

		expect(watching.events).toEqual([
			expect.objectContaining({ type: "snapshot", error: "turn failed" }),
			expect.objectContaining({ type: "error-cleared", session: PI_SESSION }),
		]);
		expect(watching.gaps).toEqual([]);
	});

	it("clears at admission the error the prompt names as the one its sender held (OW-jokoto)", async () => {
		const { socket, handle } = await attached();
		const held = raise(socket, "turn failed");

		await socket.ok("sessions/prompt", { handle, text: "again", priorErrorId: held });

		expect(await lateSnapshot()).toMatchObject({ error: null, errorId: null });
	});

	it("keeps the error a prompt names when the backend handled it without a turn (OW-fakazi)", async () => {
		// `/mcp` after an attach whose extension failed, the way Pi answers it (OW-dulipe).
		build({ onSubmit: () => "handled" });
		const { socket, handle } = await attached();
		const held = raise(socket, "extension failed to load");

		expect(await socket.ok("sessions/prompt", { handle, text: "/mcp", priorErrorId: held })).toEqual({ disposition: "handled" });

		expect(socket.typed("error-cleared")).toEqual([]);
		expect(await lateSnapshot()).toMatchObject({ error: "extension failed to load", errorId: held });
	});

	it("keeps an error raised after the send of a prompt whose sender held none (OW-jokoto)", async () => {
		const { socket, handle } = await attached();
		// Raised while the prompt was on its way, so its sender never showed it.
		raise(socket, "turn failed");

		await socket.ok("sessions/prompt", { handle, text: "again", priorErrorId: null });

		expect((await lateSnapshot())?.error).toBe("turn failed");
	});

	it("keeps an error the start of an attach raised before a first prompt whose sender held none (OW-bomolu)", async () => {
		// A first prompt from a view whose attach was out when the user sent,
		// which waits for it, as agentpane-mode's `agentpane--send-prompt`
		// does: `sessions/prompt` follows the attach, naming the handle, with
		// the `priorErrorId` read before that attach.
		build({ onStart: (adapter) => adapter.emitError("extension failed to load") });
		const socket = await connected();

		const { session } = await socket.ok("sessions/attach", { ref: PI_SESSION });
		const raised = socket.typed("snapshot")[0]?.errorId;
		expect(raised).toEqual(expect.any(String));

		await socket.ok("sessions/prompt", { handle: session.handle, text: "hello", priorErrorId: null });

		expect(socket.typed("error-cleared")).toEqual([]);
		expect(await lateSnapshot()).toMatchObject({ error: "extension failed to load", errorId: raised });
	});

	it("keeps an error raised after the send of a prompt naming an older one, even with the same text (OW-jokoto)", async () => {
		const { socket, handle } = await attached();
		const shown = raise(socket, "turn failed");
		const newer = raise(socket, "turn failed");

		await socket.ok("sessions/prompt", { handle, text: "again", priorErrorId: shown });

		expect(await lateSnapshot()).toMatchObject({ error: "turn failed", errorId: newer });
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
