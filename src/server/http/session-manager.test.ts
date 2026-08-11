/**
 * Process-table edges that are awkward to provoke through HTTP: concurrent
 * attaches, a spawn that fails, and the bookkeeping that must not outlive a
 * session.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { type SessionRef, sessionKey } from "../../shared/protocol.ts";
import { Broadcaster } from "./broadcaster.ts";
import { SessionManager, UnknownBackendError, UnknownSessionError } from "./session-manager.ts";
import { FakeAdapterFactory, FakeSessionIndex, storedSession, userMessage } from "./testing/fakes.ts";

const REF: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/a.jsonl" };
const WORKSPACE = "/home/u/src/agentpane";

let index: FakeSessionIndex;
let pi: FakeAdapterFactory;
let broadcaster: Broadcaster;
let sessions: SessionManager;

beforeEach(() => {
	index = new FakeSessionIndex([storedSession(REF, WORKSPACE)]);
	pi = new FakeAdapterFactory();
	broadcaster = new Broadcaster();
	sessions = new SessionManager({ index, adapters: { pi } }, broadcaster);
});

describe("attach", () => {
	it("spawns once even when two attaches race", async () => {
		const [a, b] = await Promise.all([sessions.attach(REF), sessions.attach(REF)]);
		expect(a).toBe(b);
		expect(pi.created).toHaveLength(1);
	});

	it("refuses a session with no recorded workspace rather than jailing the wrong tree (D7)", async () => {
		index.summaries = [{ ...storedSession(REF, WORKSPACE), cwd: null }];
		await expect(sessions.attach(REF)).rejects.toThrow(/workspace/);
		expect(pi.created).toHaveLength(0);
	});

	it("leaves nothing half-registered when the spawn fails, and a retry still works", async () => {
		const flaky = new FakeAdapterFactory({ failStart: "sbox: no git root" });
		sessions = new SessionManager({ index, adapters: { pi: flaky } }, broadcaster);

		await expect(sessions.attach(REF)).rejects.toThrow("sbox: no git root");
		expect(sessions.isAttached(REF)).toBe(false);
		expect((await sessions.list()).find((s) => sessionKey(s.ref) === sessionKey(REF))?.status).toBe(
			"detached",
		);

		// A failed adapter must not stay subscribed: its events would be
		// broadcast for a session that is not running.
		flaky.created[0]?.append(userMessage("ghost"));
		expect(broadcaster.seqOf(REF)).toBe(0);

		sessions = new SessionManager({ index, adapters: { pi } }, broadcaster);
		await expect(sessions.attach(REF)).resolves.toBeDefined();
	});

	it("rejects a backend with no factory", async () => {
		await expect(sessions.attach({ backend: "codex", id: "x" })).rejects.toBeInstanceOf(
			UnknownBackendError,
		);
		expect(() => sessions.createVirtual(WORKSPACE, "codex")).toThrow(UnknownBackendError);
	});

	it("rejects a session no store knows about", async () => {
		await expect(sessions.attach({ backend: "pi", id: "/nope" })).rejects.toBeInstanceOf(
			UnknownSessionError,
		);
	});
});

describe("an adapter that renames itself (the Pi contract)", () => {
	// `PiAdapter.ref` is not stable at construction: Pi's session id IS its JSONL
	// path (D9) and a `virtual` session has no path until its first prompt writes
	// one. The adapter documents that its caller must re-read `adapter.ref` after
	// start() and after the first submit(); these are that contract.
	const REAL = "/home/u/.pi/agent/sessions/materialised.jsonl";

	it("adopts the id the adapter took during start()", async () => {
		const renaming = new FakeAdapterFactory({ materialiseOnStart: REAL });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);

		await sessions.attach(REF);

		expect(sessions.canonicalRef(REF)).toEqual({ backend: "pi", id: REAL });
		expect(sessions.liveRefs()).toEqual([{ backend: "pi", id: REAL }]);
		// One session, listed once -- not once under each id.
		const listed = await sessions.list();
		expect(listed.filter((s) => s.status === "attached")).toHaveLength(1);
	});

	it("adopts the id a virtual session materialises on its first prompt (D9)", async () => {
		const renaming = new FakeAdapterFactory({ materialiseOnSubmit: REAL });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		const virtualRef = sessions.createVirtual(WORKSPACE, "pi");

		await sessions.attach(virtualRef);
		expect(sessions.canonicalRef(virtualRef)).toEqual(virtualRef);

		await sessions.submit(virtualRef, "first");

		const real: SessionRef = { backend: "pi", id: REAL };
		expect(sessions.canonicalRef(virtualRef)).toEqual(real);
		expect(sessions.liveRefs()).toEqual([real]);
		expect(sessions.adapterFor(real)).toBeDefined();
		// A session listed under a `virtual:` id it no longer has is a session the
		// browser can never find on disk again.
		const listed = await sessions.list();
		expect(listed.map((s) => s.ref.id)).not.toContain(virtualRef.id);
	});

	it("keeps the pre-rename id working for a client that still holds it", async () => {
		const renaming = new FakeAdapterFactory({ materialiseOnSubmit: REAL });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		const virtualRef = sessions.createVirtual(WORKSPACE, "pi");
		await sessions.submit(virtualRef, "first");

		// The browser POSTed against the id it created and has not refetched yet.
		await expect(sessions.submit(virtualRef, "second")).resolves.toBeUndefined();
		expect(renaming.forRef(virtualRef)?.prompts.map((p) => p.text)).toEqual(["first", "second"]);
		expect(renaming.created).toHaveLength(1);
		expect(sessions.isAttached(virtualRef)).toBe(true);
	});

	it("moves a pending request's owner across the rename", async () => {
		const renaming = new FakeAdapterFactory({ materialiseOnSubmit: REAL });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		const virtualRef = sessions.createVirtual(WORKSPACE, "pi");
		await sessions.attach(virtualRef);
		const request = renaming.forRef(virtualRef)?.emitRequest("approval");

		await sessions.submit(virtualRef, "first");

		// The agent is still blocked on it, so the reply must still find a session.
		expect(sessions.sessionOfRequest(request?.requestId ?? "")).toEqual({
			backend: "pi",
			id: REAL,
		});
	});

	it("closes a renamed session under either id", async () => {
		const renaming = new FakeAdapterFactory({ materialiseOnStart: REAL });
		sessions = new SessionManager({ index, adapters: { pi: renaming } }, broadcaster);
		await sessions.attach(REF);

		await sessions.close(REF);

		expect(sessions.liveRefs()).toEqual([]);
		expect(sessions.canonicalRef(REF)).toEqual(REF);
		expect(renaming.created[0]?.disposed).toBe(true);
	});
});

describe("lifecycle", () => {
	it("keeps virtual sessions out of the backend store until prompted (D9)", async () => {
		const ref = sessions.createVirtual(WORKSPACE, "pi", "pi-1");
		expect(pi.created).toHaveLength(0);

		await sessions.attach(ref);
		expect(pi.forRef(ref)?.startOptions).toEqual({ cwd: WORKSPACE, model: "pi-1" });

		const before = await sessions.list();
		expect(before.find((s) => sessionKey(s.ref) === sessionKey(ref))?.status).toBe("attached");

		sessions.markPrompted(ref);
		// Still attached; "virtual" was only ever about the store, not the process.
		const after = await sessions.list();
		expect(after.find((s) => sessionKey(s.ref) === sessionKey(ref))?.status).toBe("attached");
	});

	it("forgets a session's pending requests when it closes", async () => {
		const adapter = await sessions.attach(REF);
		const request = pi.forRef(REF)?.emitRequest("approval");
		expect(sessions.sessionOfRequest(request?.requestId ?? "")).toEqual(REF);

		await sessions.close(REF);

		expect(sessions.sessionOfRequest(request?.requestId ?? "")).toBeUndefined();
		expect((adapter as { disposed?: boolean }).disposed).toBe(true);
	});

	it("disposes everything on shutdown, and only then", async () => {
		await sessions.attach(REF);
		const adapter = pi.forRef(REF);
		expect(adapter?.disposed).toBe(false);

		await sessions.disposeAll();
		expect(adapter?.disposed).toBe(true);
		expect(sessions.liveRefs()).toEqual([]);
	});

	it("shutdown does not stop at the first adapter that fails to die", async () => {
		// Every session left undisposed on shutdown is a sandboxed agent still
		// holding its workspace, so one casualty must not spare the rest.
		const brittle = new FakeAdapterFactory({ failDispose: "kill: no such process" });
		sessions = new SessionManager({ index, adapters: { pi: brittle } }, broadcaster);
		const a = sessions.createVirtual(WORKSPACE, "pi");
		const b = sessions.createVirtual(WORKSPACE, "pi");
		await sessions.attach(a);
		await sessions.attach(b);

		await expect(sessions.disposeAll()).resolves.toBeUndefined();
		expect(brittle.created.map((c) => c.disposed)).toEqual([true, true]);
	});

	it("an explicit close survives an adapter that throws on dispose", async () => {
		const brittle = new FakeAdapterFactory({ failDispose: "kill: no such process" });
		sessions = new SessionManager({ index, adapters: { pi: brittle } }, broadcaster);
		await sessions.attach(REF);

		await expect(sessions.close(REF)).resolves.toBeUndefined();
		expect(sessions.isAttached(REF)).toBe(false);
	});

	it("disposes an adapter whose start() failed, rather than leaking the subprocess", async () => {
		// PiAdapter.start() spawns first and only then round-trips a readiness
		// probe, so a rejection can leave a live agent behind. Dropping the
		// reference is not enough -- nothing else will ever reap it.
		const flaky = new FakeAdapterFactory({ failStart: "sbox: no git root" });
		sessions = new SessionManager({ index, adapters: { pi: flaky } }, broadcaster);

		await expect(sessions.attach(REF)).rejects.toThrow("sbox: no git root");
		expect(flaky.created[0]?.disposed).toBe(true);
	});
});
