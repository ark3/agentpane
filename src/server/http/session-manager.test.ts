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
});
