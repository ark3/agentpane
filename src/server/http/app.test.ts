/**
 * The wire contract, exercised end to end against a fake adapter.
 *
 * Every test here goes through `app.fetch(new Request(...))` -- the same path a
 * browser takes, minus the socket -- so what is asserted is the contract in
 * `src/shared/protocol.ts` and not an internal call sequence.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentRequestReply,
	type ApiError,
	type AttachSessionResponse,
	type CreateSessionResponse,
	type EditDraftResponse,
	type ForkPointsResponse,
	type ForkResponse,
	type ListSessionsResponse,
	type ModelsResponse,
	ROUTES,
	type SessionPreviewResponse,
	type SessionPreviewTurn,
	type SessionRef,
	sessionKey,
} from "../../shared/protocol.ts";
import { type App, createApp } from "./app.ts";
import {
	assistantMessage,
	FakeAdapterFactory,
	FakeSessionIndex,
	storedSession,
	userMessage,
} from "./testing/fakes.ts";
import { SseTestClient } from "./testing/sse-client.ts";

const PI_SESSION: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/one two.jsonl" };
const CODEX_SESSION: SessionRef = { backend: "codex", id: "019feee5-cc20-7290-95fa-599abc243e55" };
const CLAUDE_SESSION: SessionRef = { backend: "claude", id: "3af1e5da-9f22-4f34-9c2b-6b7e2f1c9d44" };
const WORKSPACE = "/home/u/src/agentpane";

let index: FakeSessionIndex;
let pi: FakeAdapterFactory;
let codex: FakeAdapterFactory;
let app: App;

beforeEach(() => {
	// Seeded already recency-sorted, claude interleaved between the other two:
	// the fake index returns them as-is (the sort itself is the real index's
	// job, asserted in sessions/index.test.ts), and the route must pass all
	// three backends through in that order.
	index = new FakeSessionIndex([
		storedSession(PI_SESSION, WORKSPACE, "2026-08-10T10:00:00.000Z"),
		storedSession(CLAUDE_SESSION, "/home/u/src/other", "2026-08-09T12:00:00.000Z"),
		storedSession(CODEX_SESSION, "/home/u/src/other", "2026-08-09T10:00:00.000Z"),
	]);
	pi = new FakeAdapterFactory({ models: [{ id: "pi-1", label: "Pi One" }] });
	codex = new FakeAdapterFactory({ models: [{ id: "cx-1", label: "Codex One" }] });
	let n = 0;
	app = createApp({
		index,
		adapters: { pi, codex },
		newId: () => `id-${++n}`,
		now: () => "2026-08-11T00:00:00.000Z",
	});
});

function previewUser(text: string): SessionPreviewTurn {
	const { timestamp: _timestamp, ...message } = userMessage(text);
	return message;
}

function previewAssistant(text: string): SessionPreviewTurn {
	const { timestamp: _timestamp, ...message } = assistantMessage(text);
	return message;
}

function get(path: string): Promise<Response> {
	return app.fetch(new Request(`http://127.0.0.1${path}`));
}

function post(path: string, body?: unknown): Promise<Response> {
	return app.fetch(
		new Request(`http://127.0.0.1${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
		}),
	);
}

describe("external draft editor", () => {
	it("round-trips the draft through EDITOR, including editor flags", async () => {
		const priorEditor = process.env.EDITOR;
		process.env.EDITOR = `sh ${new URL("./testing/editor-fixture.sh", import.meta.url).pathname} --replace`;
		try {
			const response = await post(ROUTES.editDraft, { text: "original draft" });
			expect(response.status).toBe(200);
			expect((await response.json()) as EditDraftResponse).toEqual({ text: "edited by fixture" });
		} finally {
			if (priorEditor === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = priorEditor;
		}
	});

	it("returns the established error shape when EDITOR is missing", async () => {
		const priorEditor = process.env.EDITOR;
		delete process.env.EDITOR;
		try {
			const response = await post(ROUTES.editDraft, { text: "unchanged" });
			expect(response.status).toBe(500);
			expect((await response.json()) as ApiError).toMatchObject({ error: "editor_failed" });
		} finally {
			if (priorEditor !== undefined) process.env.EDITOR = priorEditor;
		}
	});
});

async function openStream(): Promise<SseTestClient> {
	const response = await get(ROUTES.events);
	expect(response.headers.get("content-type")).toBe("text/event-stream");
	return new SseTestClient(response);
}

describe("sessions", () => {
	it("lists what the index found, without spawning anything (D9)", async () => {
		const response = await get(ROUTES.sessions);
		const body = (await response.json()) as ListSessionsResponse;

		expect(body.sessions.map((s) => sessionKey(s.ref))).toEqual([
			sessionKey(PI_SESSION),
			sessionKey(CLAUDE_SESSION),
			sessionKey(CODEX_SESSION),
		]);
		expect(body.sessions.every((s) => s.status === "detached")).toBe(true);
		expect(pi.created).toHaveLength(0);
		expect(codex.created).toHaveLength(0);
	});

	it("filters by workspace", async () => {
		const body = (await (await get(`${ROUTES.sessions}?cwd=${encodeURIComponent(WORKSPACE)}`))
			.json()) as ListSessionsResponse;
		expect(body.sessions).toHaveLength(1);
		expect(body.sessions[0]?.cwd).toBe(WORKSPACE);
	});

	it("creates a virtual session that touches no backend store", async () => {
		const response = await post(ROUTES.sessions, { cwd: WORKSPACE, backend: "pi" });
		expect(response.status).toBe(201);
		const { ref } = (await response.json()) as CreateSessionResponse;

		expect(ref.backend).toBe("pi");
		expect(pi.created).toHaveLength(0);

		const body = (await (await get(ROUTES.sessions)).json()) as ListSessionsResponse;
		const created = body.sessions.find((s) => sessionKey(s.ref) === sessionKey(ref));
		expect(created?.status).toBe("virtual");
		expect(created?.cwd).toBe(WORKSPACE);
	});

	it("spawns on attach, in the session's own workspace (D7)", async () => {
		const response = await get(ROUTES.session(PI_SESSION));
		const body = (await response.json()) as AttachSessionResponse;

		expect(body.session.status).toBe("attached");
		const adapter = pi.forRef(PI_SESSION);
		expect(adapter?.started).toBe(true);
		expect(adapter?.startOptions).toEqual({ cwd: WORKSPACE, resumeId: PI_SESSION.id });
		// Attaching a Pi session must not spawn Codex.
		expect(codex.created).toHaveLength(0);
	});

	it("attaching twice reuses the subprocess", async () => {
		await get(ROUTES.session(PI_SESSION));
		await get(ROUTES.session(PI_SESSION));
		expect(pi.created).toHaveLength(1);
	});

	it("404s a session no store knows about", async () => {
		const response = await get(ROUTES.session({ backend: "pi", id: "/nope.jsonl" }));
		expect(response.status).toBe(404);
		expect(((await response.json()) as ApiError).error).toBe("not_found");
	});

	it("closes a session explicitly, disposing the adapter", async () => {
		await get(ROUTES.session(PI_SESSION));
		const adapter = pi.forRef(PI_SESSION);

		const response = await app.fetch(
			new Request(`http://127.0.0.1${ROUTES.session(PI_SESSION)}`, { method: "DELETE" }),
		);

		expect(response.status).toBe(204);
		expect(adapter?.disposed).toBe(true);
		expect(app.sessions.isAttached(PI_SESSION)).toBe(false);
	});
});

describe("preview (OW-38, read-only, non-attaching)", () => {
	it("returns transcript messages for a stored Pi session without spawning", async () => {
		const turns = [previewUser("a pi question"), previewAssistant("a pi answer")];
		index.previews.set(sessionKey(PI_SESSION), turns);

		const response = await get(ROUTES.preview(PI_SESSION));
		expect(response.status).toBe(200);
		const body = (await response.json()) as SessionPreviewResponse;

		expect(body.ref).toEqual(PI_SESSION);
		expect(body.turns).toEqual(turns);
		// The whole point of the route: no subprocess, no attach.
		expect(pi.created).toHaveLength(0);
		expect(app.sessions.isAttached(PI_SESSION)).toBe(false);
	});

	it("returns transcript messages for a stored Codex session without spawning", async () => {
		const turns = [previewUser("a codex question"), previewAssistant("a codex answer")];
		index.previews.set(sessionKey(CODEX_SESSION), turns);

		const response = await get(ROUTES.preview(CODEX_SESSION));
		expect(response.status).toBe(200);
		const body = (await response.json()) as SessionPreviewResponse;

		expect(body.ref).toEqual(CODEX_SESSION);
		expect(body.turns).toEqual(turns);
		expect(codex.created).toHaveLength(0);
		expect(app.sessions.isAttached(CODEX_SESSION)).toBe(false);
	});

	it("never touches the session manager: preview does not attach", async () => {
		// A spy on the manager's attach proves the read path stays off it entirely.
		const attachSpy = vi.spyOn(app.sessions, "attach");

		await get(ROUTES.preview(PI_SESSION));
		await get(ROUTES.preview(CODEX_SESSION));

		expect(attachSpy).not.toHaveBeenCalled();
		expect(pi.created).toHaveLength(0);
		expect(codex.created).toHaveLength(0);
		// It went through the read seam instead, once per request.
		expect(index.previewed).toEqual([PI_SESSION, CODEX_SESSION]);
	});

	it("is a distinct route: opening the transcript preview does not disturb attach-on-GET", async () => {
		// Preview first...
		await get(ROUTES.preview(PI_SESSION));
		expect(pi.created).toHaveLength(0);

		// ...then the existing attach route still spawns exactly as before.
		const attached = (await (await get(ROUTES.session(PI_SESSION))).json()) as AttachSessionResponse;
		expect(attached.session.status).toBe("attached");
		expect(pi.forRef(PI_SESSION)?.started).toBe(true);
	});

	it("empty turns for a session the store cannot find, without spawning", async () => {
		const unknown: SessionRef = { backend: "pi", id: "/nope.jsonl" };
		const response = await get(ROUTES.preview(unknown));
		expect(response.status).toBe(200);
		expect(((await response.json()) as SessionPreviewResponse).turns).toEqual([]);
		expect(pi.created).toHaveLength(0);
	});

	it("405s a non-GET method", async () => {
		const response = await post(ROUTES.preview(PI_SESSION));
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("GET");
	});
});

describe("SSE stream", () => {
	it("snapshots every live session to a newly connected client (D3)", async () => {
		await get(ROUTES.session(PI_SESSION));
		pi.forRef(PI_SESSION)?.append(userMessage("hello"));

		const client = await openStream();
		await client.waitForCount(1);

		const [snapshot] = client.typed("snapshot");
		expect(snapshot?.session).toEqual(PI_SESSION);
		expect(snapshot?.messages).toHaveLength(1);
		await client.close();
	});

	it("carries the session on every event, one stream for all of them (D2)", async () => {
		const client = await openStream();
		await get(ROUTES.session(PI_SESSION));
		await get(ROUTES.session(CODEX_SESSION));
		pi.forRef(PI_SESSION)?.append(userMessage("pi"));
		codex.forRef(CODEX_SESSION)?.append(userMessage("codex"));

		await client.until(() => client.transcript(PI_SESSION).length === 1 && client.transcript(CODEX_SESSION).length === 1);

		expect(client.transcript(PI_SESSION)).toHaveLength(1);
		expect(client.transcript(CODEX_SESSION)).toHaveLength(1);
		// One connection, both sessions.
		expect(app.broadcaster.clientCount).toBe(1);
		await client.close();
	});

	it("streams a turn as tail upserts with a monotonic seq (D3)", async () => {
		await get(ROUTES.session(PI_SESSION));
		const adapter = pi.forRef(PI_SESSION);
		const client = await openStream();
		await client.waitForCount(1);

		adapter?.append(userMessage("hi"));
		adapter?.setStreaming(true);
		adapter?.streamToken("Hel");
		adapter?.streamToken("lo");
		adapter?.setStreaming(false);

		await client.until(
			() => !client.isStreaming(PI_SESSION) && client.transcript(PI_SESSION).length === 2,
		);

		// Only ever the tail moves, and it moves by index -- never by resending
		// the transcript. That is what makes a turn O(1) per token.
		expect(client.typed("upsert").map((u) => u.index)).toEqual([0, 0, 1, 1, 1]);
		expect(client.typed("status").map((s) => s.isStreaming)).toEqual([true, false]);
		expect(client.typed("snapshot")).toHaveLength(1);
		// Contiguous seq from the snapshot onwards: nothing was missed.
		expect(client.gaps).toEqual([]);
		expect(client.seq(PI_SESSION)).toBe(app.broadcaster.seqOf(PI_SESSION));

		const tail = client.transcript(PI_SESSION)[1];
		expect(tail?.role === "assistant" && tail.content[0]).toEqual({ type: "text", text: "Hello" });
		await client.close();
	});

	it("falls back to a snapshot when the adapter cannot localise the change", async () => {
		await get(ROUTES.session(PI_SESSION));
		const adapter = pi.forRef(PI_SESSION);
		const client = await openStream();
		await client.waitForCount(1);

		adapter?.append(userMessage("one"));
		adapter?.messages.push(assistantMessage("compacted"));
		adapter?.emitUnlocalisedChange();

		await client.until(() => client.typed("snapshot").length === 2);
		expect(client.transcript(PI_SESSION)).toHaveLength(2);
		// A broadcast snapshot resets the sequence for everyone at once.
		expect(client.typed("snapshot")[1]?.seq).toBe(0);
		expect(client.gaps).toEqual([]);
		await client.close();
	});

	it("a dropped update shows up as a seq gap, and re-subscribing repairs it", async () => {
		await get(ROUTES.session(PI_SESSION));
		const adapter = pi.forRef(PI_SESSION);

		// This client loses the upsert for message 1, and nothing later touches
		// that index again -- upserts are idempotent full-message replacements,
		// so the only losses that last are the ones nothing overwrites. On
		// loopback nothing is really lost, which is why the loss has to be
		// injected to show `seq` earns its place.
		const response = await get(ROUTES.events);
		const lossy = new SseTestClient(response, {
			drop: (event) => event.type === "upsert" && event.index === 1,
		});
		await lossy.waitForCount(1);

		adapter?.append(userMessage("hi"));
		adapter?.streamToken("answer");
		adapter?.append(userMessage("and another thing"));

		await lossy.until(() => lossy.gaps.length > 0, "a detected gap");

		// The client can tell it is behind -- and it is, with a hole where the
		// assistant's reply should be.
		expect(lossy.gaps).toEqual([sessionKey(PI_SESSION)]);
		expect(lossy.transcript(PI_SESSION)[1]).toBeUndefined();
		expect(lossy.transcript(PI_SESSION)[2]).toBeDefined();
		await lossy.close();

		// D3's entire recovery story: re-subscribe, take a fresh snapshot.
		const repaired = await openStream();
		await repaired.waitForCount(1);
		const filled = repaired.transcript(PI_SESSION)[1];
		expect(filled?.role === "assistant" && filled.content[0]).toEqual({
			type: "text",
			text: "answer",
		});
		// And it is back in step, so the next update is not another gap.
		adapter?.streamToken("!");
		await repaired.until(() => repaired.typed("upsert").length === 1);
		expect(repaired.gaps).toEqual([]);
		await repaired.close();
	});

	it("keeps several tabs in step, including one that joins mid-turn", async () => {
		await get(ROUTES.session(PI_SESSION));
		const adapter = pi.forRef(PI_SESSION);
		const first = await openStream();
		await first.waitForCount(1);

		adapter?.append(userMessage("hi"));
		adapter?.setStreaming(true);
		adapter?.streamToken("half");
		await first.until(() => first.transcript(PI_SESSION).length === 2);

		// A second tab opens while the turn is running. Its opening snapshot
		// carries the counter's current value, so it lands in step rather than
		// resetting a sequence the first tab is still counting from.
		const second = await openStream();
		await second.waitForCount(1);
		expect(second.seq(PI_SESSION)).toBe(app.broadcaster.seqOf(PI_SESSION));

		adapter?.streamToken(" the rest");
		adapter?.setStreaming(false);

		await first.until(() => !first.isStreaming(PI_SESSION));
		await second.until(() => !second.isStreaming(PI_SESSION));

		expect(first.gaps).toEqual([]);
		expect(second.gaps).toEqual([]);
		expect(second.transcript(PI_SESSION)).toEqual(first.transcript(PI_SESSION));
		await first.close();
		await second.close();
	});

	it("re-attaching resets the sequence for every tab at once", async () => {
		await get(ROUTES.session(PI_SESSION));
		const adapter = pi.forRef(PI_SESSION);
		const first = await openStream();
		const second = await openStream();
		await first.waitForCount(1);
		await second.waitForCount(1);

		adapter?.append(userMessage("hi"));
		await first.until(() => first.seq(PI_SESSION) === 1);

		// A session switch re-attaches, which snapshots everyone.
		await get(ROUTES.session(PI_SESSION));
		await first.until(() => first.typed("snapshot").length === 2);
		await second.until(() => second.typed("snapshot").length === 2);

		adapter?.streamToken("after");
		await first.until(() => first.typed("upsert").length === 2);
		await second.until(() => second.typed("upsert").length === 2);

		expect(first.gaps).toEqual([]);
		expect(second.gaps).toEqual([]);
		expect(first.seq(PI_SESSION)).toBe(1);
		await first.close();
		await second.close();
	});

	it("a client that goes away mid-fanout does not stop the others", async () => {
		await get(ROUTES.session(PI_SESSION));
		const adapter = pi.forRef(PI_SESSION);
		const survivor = await openStream();
		await survivor.waitForCount(1);

		// A writer that starts throwing is what a socket closing under us looks
		// like from in here: it accepts the retry directive, then dies.
		let writes = 0;
		let thrown = 0;
		app.broadcaster.addClient(() => {
			if (++writes === 1) return;
			thrown++;
			throw new Error("EPIPE");
		});
		expect(app.broadcaster.clientCount).toBe(2);

		adapter?.append(userMessage("hi"));
		await survivor.until(() => survivor.transcript(PI_SESSION).length === 1);

		expect(thrown).toBeGreaterThan(0);
		expect(app.broadcaster.clientCount).toBe(1);
		expect(adapter?.disposed).toBe(false);
		await survivor.close();
	});

	it("dropping the browser connection does not touch the agent", async () => {
		await get(ROUTES.session(PI_SESSION));
		const adapter = pi.forRef(PI_SESSION);
		const client = await openStream();
		await client.waitForCount(1);

		await client.close();
		await new Promise((r) => setTimeout(r, 10));

		expect(app.broadcaster.clientCount).toBe(0);
		expect(adapter?.disposed).toBe(false);
		expect(app.sessions.isAttached(PI_SESSION)).toBe(true);

		// The agent keeps working with nobody watching...
		adapter?.append(userMessage("while you were out"));
		adapter?.streamToken("done");

		// ...and a reconnect is a repaint, not a lifecycle event.
		const reconnected = await openStream();
		await reconnected.waitForCount(1);
		expect(pi.created).toHaveLength(1);
		expect(reconnected.transcript(PI_SESSION)).toHaveLength(2);
		await reconnected.close();
	});
});

describe("prompting", () => {
	it("accepts a prompt without waiting for the turn, attaching if needed", async () => {
		const client = await openStream();
		const response = await post(ROUTES.prompt(PI_SESSION), { text: "hello" });

		expect(response.status).toBe(202);
		const adapter = pi.forRef(PI_SESSION);
		expect(adapter?.prompts).toEqual([{ text: "hello", images: undefined }]);
		await client.close();
	});

	it("tolerates SSE events that beat the POST response (D2)", async () => {
		// An adapter that emits its whole turn synchronously inside submit() is
		// the worst case for cross-channel ordering: every event is on the wire
		// before the POST resolves.
		const eager = new FakeAdapterFactory({
			onSubmit(adapter, text) {
				adapter.append(userMessage(text));
				adapter.setStreaming(true);
				adapter.streamToken("ok");
				adapter.setStreaming(false);
			},
		});
		app = createApp({ index, adapters: { pi: eager } });
		const client = await openStream();

		const response = await post(ROUTES.prompt(PI_SESSION), { text: "go" });
		expect(response.status).toBe(202);

		await client.until(
			() => client.transcript(PI_SESSION).length === 2 && !client.isStreaming(PI_SESSION),
			"the turn to arrive",
		);
		expect(client.gaps).toEqual([]);
		await client.close();
	});

	it("materialises a virtual session on the first prompt and spawns with no resumeId", async () => {
		const { ref } = (await (
			await post(ROUTES.sessions, { cwd: WORKSPACE, backend: "pi", model: "pi-1" })
		).json()) as CreateSessionResponse;

		await post(ROUTES.prompt(ref), { text: "first" });

		const adapter = pi.forRef(ref);
		expect(adapter?.startOptions).toEqual({ cwd: WORKSPACE, model: "pi-1" });
		expect(adapter?.startOptions?.resumeId).toBeUndefined();

		const body = (await (await get(ROUTES.sessions)).json()) as ListSessionsResponse;
		expect(body.sessions.find((s) => sessionKey(s.ref) === sessionKey(ref))?.status).toBe("attached");
	});

	it("follows a session that adopts its backend id on the first prompt (D9)", async () => {
		// The whole life of a new Pi session in one test: create it virtual, prompt
		// it, and watch it become a real JSONL path under the browser. The browser
		// has to be able to follow that without losing the transcript, because the
		// id it created the session with is not the id the session keeps.
		const REAL = "/home/u/.pi/agent/sessions/materialised.jsonl";
		const renaming = new FakeAdapterFactory({
			materialiseOnSubmit: REAL,
			onSubmit(adapter, text) {
				adapter.append(userMessage(text));
			},
		});
		app = createApp({ index, adapters: { pi: renaming }, newId: () => "n1" });
		const client = await openStream();

		const { ref } = (await (
			await post(ROUTES.sessions, { cwd: WORKSPACE, backend: "pi" })
		).json()) as CreateSessionResponse;
		expect(ref.id).toContain("virtual:");

		expect((await post(ROUTES.prompt(ref), { text: "first" })).status).toBe(202);

		const real: SessionRef = { backend: "pi", id: REAL };
		await client.until(() => client.typed("renamed").length === 1, "the rename");
		expect(client.typed("renamed")[0]?.from).toEqual(ref);
		expect(client.typed("renamed")[0]?.session).toEqual(real);

		// A client that follows the rename keeps the conversation, under the new id
		// and only the new id.
		await client.until(() => client.transcript(real).length === 1);
		expect(client.transcript(ref)).toEqual([]);
		expect(client.gaps).toEqual([]);

		// The list shows the conversation once, under the id it now has.
		const listed = ((await (await get(ROUTES.sessions)).json()) as ListSessionsResponse).sessions;
		expect(listed.filter((s) => s.status === "attached").map((s) => s.ref.id)).toEqual([REAL]);

		// A browser still holding the id it created the session with keeps working
		// -- it may well have had this POST in flight when the rename happened.
		expect((await post(ROUTES.prompt(ref), { text: "second" })).status).toBe(202);
		await client.until(() => client.transcript(real).length === 2);
		expect(renaming.created).toHaveLength(1);

		// And the new id is a first-class handle: opening it re-attaches rather
		// than spawning a second agent on the same session file.
		const reopened = (await (await get(ROUTES.session(real))).json()) as AttachSessionResponse;
		expect(reopened.session.ref).toEqual(real);
		expect(renaming.created).toHaveLength(1);
		await client.close();
	});

	it("does not acknowledge a prompt before adapter admission succeeds", async () => {
		const failing = new FakeAdapterFactory({
			onSubmit() {
				throw new Error("agent is wedged");
			},
		});
		app = createApp({ index, adapters: { pi: failing } });
		const client = await openStream();

		const response = await post(ROUTES.prompt(PI_SESSION), { text: "go" });
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "internal_error", detail: "agent is wedged" });
		expect(client.typed("error")).toEqual([]);
		await client.close();
	});

	it("rejects a prompt with no text", async () => {
		const response = await post(ROUTES.prompt(PI_SESSION), { images: [] });
		expect(response.status).toBe(400);
	});

	it("aborts only an attached session", async () => {
		expect((await post(ROUTES.abort(PI_SESSION))).status).toBe(404);
		await get(ROUTES.session(PI_SESSION));
		expect((await post(ROUTES.abort(PI_SESSION))).status).toBe(204);
		expect(pi.forRef(PI_SESSION)?.aborts).toBe(1);
	});

	it("compacts only an attached session (OW-72)", async () => {
		expect((await post(ROUTES.compact(PI_SESSION))).status).toBe(404);
		await get(ROUTES.session(PI_SESSION));
		const client = await openStream();
		expect((await post(ROUTES.compact(PI_SESSION))).status).toBe(204);
		expect(pi.forRef(PI_SESSION)?.compactions).toBe(1);
		await client.until(() => client.typed("snapshot").some((event) => event.compaction === "requesting"));
		expect(client.typed("snapshot").at(-1)).toMatchObject({ isStreaming: false, compaction: "requesting" });
		const reconnect = await openStream();
		await reconnect.until(() => reconnect.typed("snapshot").length > 0);
		expect(reconnect.typed("snapshot").at(-1)).toMatchObject({ session: PI_SESSION, compaction: "requesting" });
		await reconnect.close();
		await client.close();
	});

	it("rejects a non-POST compact with 405 (OW-72)", async () => {
		await get(ROUTES.session(PI_SESSION));
		expect((await get(ROUTES.compact(PI_SESSION))).status).toBe(405);
		expect(pi.forRef(PI_SESSION)?.compactions).toBe(0);
	});
});

describe("server-initiated requests (D2a)", () => {
	it("routes a request out over SSE and the reply back to the right adapter", async () => {
		await get(ROUTES.session(PI_SESSION));
		await get(ROUTES.session(CODEX_SESSION));
		const piAdapter = pi.forRef(PI_SESSION);
		const codexAdapter = codex.forRef(CODEX_SESSION);
		const client = await openStream();

		const request = codexAdapter?.emitRequest("item/fileChange/requestApproval", {
			path: "/tmp/x",
		});
		await client.until(() => client.typed("request").length === 1);

		const event = client.typed("request")[0];
		expect(event?.session).toEqual(CODEX_SESSION);
		expect(event?.request.kind).toBe("item/fileChange/requestApproval");
		expect(event?.request.requestId).toBe(request?.requestId);

		const reply: AgentRequestReply = {
			requestId: request?.requestId ?? "",
			response: { decision: "approved" },
		};
		const response = await post(ROUTES.reply(reply.requestId), reply);

		expect(response.status).toBe(204);
		expect(codexAdapter?.replies).toEqual([
			{ requestId: request?.requestId, response: { decision: "approved" } },
		]);
		// Correlation is by requestId, not by "the session that happens to be open".
		expect(piAdapter?.replies).toEqual([]);
		await client.close();
	});

	it("carries null through as a decline", async () => {
		await get(ROUTES.session(PI_SESSION));
		const adapter = pi.forRef(PI_SESSION);
		const request = adapter?.emitRequest("elicitation");

		await post(ROUTES.reply(request?.requestId ?? ""), { response: null });

		expect(adapter?.replies).toEqual([{ requestId: request?.requestId, response: null }]);
	});

	it("404s an unknown or already-answered request instead of hanging the client", async () => {
		await get(ROUTES.session(PI_SESSION));
		const request = pi.forRef(PI_SESSION)?.emitRequest("elicitation");
		const id = request?.requestId ?? "";

		expect((await post(ROUTES.reply(id), { response: 1 })).status).toBe(204);
		const second = await post(ROUTES.reply(id), { response: 1 });
		expect(second.status).toBe(404);
		expect(((await second.json()) as ApiError).error).toBe("unknown_request");
	});

	it("rejects a body whose requestId contradicts the route", async () => {
		await get(ROUTES.session(PI_SESSION));
		const request = pi.forRef(PI_SESSION)?.emitRequest("elicitation");
		const response = await post(ROUTES.reply(request?.requestId ?? ""), {
			requestId: "someone-elses",
			response: {},
		});
		expect(response.status).toBe(400);
	});
});

describe("fork, model, and enumeration routes", () => {
	it("lists fork points from the attached agent", async () => {
		const withPoints = new FakeAdapterFactory({
			forkPoints: [{ id: "e1", text: "first ask" }],
		});
		app = createApp({ index, adapters: { pi: withPoints } });

		const body = (await (await get(ROUTES.forkPoints(PI_SESSION))).json()) as ForkPointsResponse;
		expect(body.points).toEqual([{ id: "e1", text: "first ask" }]);
	});

	it("forks and hands back the new ref", async () => {
		const response = await post(ROUTES.fork(PI_SESSION), { entryId: "e1" });
		expect(response.status).toBe(201);
		const body = (await response.json()) as ForkResponse;
		expect(body.ref.backend).toBe("pi");
		expect(pi.forRef(PI_SESSION)?.forks).toEqual(["e1"]);
	});

	it("sets the model", async () => {
		expect((await post(ROUTES.model(PI_SESSION), { model: "pi-2" })).status).toBe(204);
		expect(pi.forRef(PI_SESSION)?.model).toBe("pi-2");
	});

	it("lists models per backend, and merged when unfiltered", async () => {
		const one = (await (await get(`${ROUTES.models}?backend=codex`)).json()) as ModelsResponse;
		expect(one.models).toEqual([{ id: "cx-1", label: "Codex One" }]);

		const all = (await (await get(ROUTES.models)).json()) as ModelsResponse;
		expect(all.models.map((m) => m.id).sort()).toEqual(["cx-1", "pi-1"]);
	});

	it("prefers a running agent's answer over an unstarted adapter's", async () => {
		// Verified against the real PiAdapter: `listModels()` before `start()`
		// rejects with "Pi process is not running". So the offline answer is
		// nothing, and this route lives or dies on using the live session.
		const offline = new FakeAdapterFactory({
			models: [{ id: "pi-1", label: "Pi One" }],
			modelsNeedStart: true,
		});
		app = createApp({ index, adapters: { pi: offline } });

		const before = (await (await get(`${ROUTES.models}?backend=pi`)).json()) as ModelsResponse;
		expect(before.models).toEqual([]);

		await get(ROUTES.session(PI_SESSION));

		const after = (await (await get(`${ROUTES.models}?backend=pi`)).json()) as ModelsResponse;
		expect(after.models).toEqual([{ id: "pi-1", label: "Pi One" }]);
	});

	it("a backend that cannot answer does not take out the other's list", async () => {
		const mute = new FakeAdapterFactory({ modelsNeedStart: true });
		app = createApp({ index, adapters: { pi: mute, codex } });

		const response = await get(ROUTES.models);
		expect(response.status).toBe(200);
		expect(((await response.json()) as ModelsResponse).models).toEqual([
			{ id: "cx-1", label: "Codex One" },
		]);
	});

	it("a factory that refuses to construct does not take out the other's list", async () => {
		const hostile: typeof pi = {
			created: [],
			createdFor: [],
			create() {
				throw new Error("cannot create an adapter without a real thread id");
			},
			forRef: () => undefined,
		} as unknown as typeof pi;
		app = createApp({ index, adapters: { pi: hostile, codex } });

		const response = await get(ROUTES.models);
		expect(response.status).toBe(200);
		expect(((await response.json()) as ModelsResponse).models).toHaveLength(1);
	});
});

describe("routing and errors", () => {
	it("round-trips a Pi id that is a filesystem path", async () => {
		const response = await get(ROUTES.session(PI_SESSION));
		expect(response.status).toBe(200);
		expect(pi.forRef(PI_SESSION)?.ref.id).toBe(PI_SESSION.id);
	});

	it("501s a backend with no adapter registered", async () => {
		app = createApp({ index, adapters: { pi } });
		const response = await get(ROUTES.session(CODEX_SESSION));
		expect(response.status).toBe(501);
	});

	it("400s an unknown backend name", async () => {
		const response = await get("/api/sessions/gemini/xyz");
		expect(response.status).toBe(400);
	});

	it("405s the wrong method with an Allow header", async () => {
		const response = await post(ROUTES.events);
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("GET");
	});

	it("400s a malformed body", async () => {
		const response = await app.fetch(
			new Request(`http://127.0.0.1${ROUTES.sessions}`, { method: "POST", body: "{oops" }),
		);
		expect(response.status).toBe(400);
	});

	it("404s an unknown route", async () => {
		expect((await get("/api/nope")).status).toBe(404);
		expect((await get("/api/sessions/pi/x/teleport")).status).toBe(404);
	});

	it("falls through to the static handler outside /api", async () => {
		app = createApp({
			index,
			adapters: { pi },
			staticHandler: () => new Response("<!doctype html>", { status: 200 }),
		});
		expect((await get("/")).status).toBe(200);
	});

	it("404s outside /api with no static handler", async () => {
		expect((await get("/index.html")).status).toBe(404);
	});
});

describe("origin", () => {
	// D8 binds loopback, which closes the network but not the browser: any page
	// in any tab can POST to 127.0.0.1 without a preflight. It cannot read the
	// reply, but every route here spawns an agent with write access to a
	// repository, so a blind write is enough.
	function withOrigin(path: string, origin: string, method = "GET"): Promise<Response> {
		return app.fetch(
			new Request(`http://127.0.0.1${path}`, {
				method,
				headers: { origin, "content-type": "application/json" },
				...(method === "POST" ? { body: "{}" } : {}),
			}),
		);
	}

	it("refuses a request a page on the web made on the user's behalf", async () => {
		for (const origin of ["https://evil.example", "http://127.0.0.1.evil.example", "null"]) {
			const response = await withOrigin(ROUTES.prompt(PI_SESSION), origin, "POST");
			expect(response.status, origin).toBe(403);
			expect(((await response.json()) as ApiError).error).toBe("forbidden_origin");
		}
		// And nothing was spawned on the way to saying no.
		expect(pi.created).toHaveLength(0);
	});

	it("refuses a cross-origin read too, because opening a session spawns one", async () => {
		expect((await withOrigin(ROUTES.session(PI_SESSION), "https://evil.example")).status).toBe(403);
		expect((await withOrigin(ROUTES.events, "https://evil.example")).status).toBe(403);
		expect(pi.created).toHaveLength(0);
	});

	it("allows the dev server's origin, which is loopback on another port", async () => {
		// vite.config.ts serves the client from 127.0.0.1:5173 and proxies /api
		// here with changeOrigin: false, so same-origin would reject dev.
		expect((await withOrigin(ROUTES.sessions, "http://127.0.0.1:5173")).status).toBe(200);
		expect((await withOrigin(ROUTES.sessions, "http://localhost:5173")).status).toBe(200);
	});

	it("allows a request with no Origin, which no page can produce", async () => {
		expect((await get(ROUTES.sessions)).status).toBe(200);
	});

	it("leaves the static bundle alone", async () => {
		app = createApp({
			index,
			adapters: { pi },
			staticHandler: () => new Response("<!doctype html>", { status: 200 }),
		});
		expect((await withOrigin("/", "https://evil.example")).status).toBe(200);
	});
});
