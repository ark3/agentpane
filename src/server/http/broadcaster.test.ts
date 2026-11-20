/**
 * The event hub's own edges: the per-handle sequence, and the handle on every
 * event. Its fan-out to sockets is `socket.test.ts`'s.
 */

import { describe, expect, it } from "vitest";
import type { ServerEvent, SessionRef } from "../../shared/protocol.ts";
import { Broadcaster } from "./broadcaster.ts";
import { userMessage } from "./testing/fakes.ts";

const REF: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/a.jsonl" };
const HANDLE = "h1";

function oneSession() {
	const broadcaster = new Broadcaster();
	const session = { handle: HANDLE, ref: REF };
	broadcaster.setSnapshotSource((handle) =>
		handle === session.handle
			? { ref: session.ref, messages: [], isStreaming: false, compaction: null, model: null, effort: null, error: null, errorId: null, notices: [] }
			: null,
	);
	const events: ServerEvent[] = [];
	const client = broadcaster.addClient((event) => events.push(event));
	return { broadcaster, session, events, client };
}

describe("sequence bookkeeping", () => {
	it("forgets a closed session's counter rather than growing with uptime", () => {
		const { broadcaster, session } = oneSession();
		broadcaster.status(session, true, null, null, null, null);
		expect(broadcaster.seqOf(HANDLE)).toBe(1);

		broadcaster.forget(HANDLE);
		expect(broadcaster.seqOf(HANDLE)).toBe(0);
	});

	it("keeps one counter across a rename, since the handle it is keyed by does not move (D24)", () => {
		const { broadcaster, session, events } = oneSession();
		broadcaster.status(session, true, null, null, null, null);
		broadcaster.upsert(session, 0, userMessage("hi"));
		const renamed: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/b.jsonl" };

		session.ref = renamed;
		broadcaster.broadcastSnapshot(HANDLE);
		broadcaster.upsert(session, 0, userMessage("hi"));

		// Nothing is copied from the old ref's counter to the new one's: there is
		// only the handle's, which the snapshot carrying the new ref resets, as
		// every broadcast snapshot does (OW-mofuho).
		expect(events.map((event) => [event.type, "seq" in event ? event.seq : null, "session" in event ? event.session : null])).toEqual([
			["status", 1, REF],
			["upsert", 2, REF],
			["snapshot", 0, renamed],
			["upsert", 1, renamed],
		]);
		expect(broadcaster.seqOf(HANDLE)).toBe(1);
	});

	it("says a handle ended with no seq, and does not bring back the counter its forget dropped (D26)", () => {
		const { broadcaster, session, events } = oneSession();
		broadcaster.status(session, true, null, null, null, null);

		broadcaster.forget(HANDLE);
		broadcaster.ended(session);

		expect(events.at(-1)).toEqual({ type: "ended", session: REF, handle: HANDLE });
		expect(broadcaster.seqOf(HANDLE)).toBe(0);
	});
});

describe("the handle (D24, OW-suyinu)", () => {
	it("rides every per-session event beside its ref", () => {
		const { broadcaster, session, events } = oneSession();
		const notice = { kind: "warning", message: "careful", details: null, path: null };

		broadcaster.broadcastSnapshot(HANDLE);
		broadcaster.upsert(session, 0, userMessage("hi"));
		broadcaster.status(session, true, null, null, null, null);
		broadcaster.error(session, "boom", "e1");
		broadcaster.notice(session, notice);

		expect(events.map((event) => event.type)).toEqual([
			"snapshot",
			"upsert",
			"status",
			"error",
			"notice",
		]);
		for (const event of events) expect(event).toMatchObject({ session: REF, handle: HANDLE });
	});

	it("rides a connecting client's opening snapshots, under the session's current ref", () => {
		const { broadcaster, session, events, client } = oneSession();
		const renamed: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/b.jsonl" };
		session.ref = renamed;

		broadcaster.sendOpeningSnapshots(client, [HANDLE, "a handle nobody holds"]);

		expect(events).toEqual([expect.objectContaining({ type: "snapshot", session: renamed, handle: HANDLE, seq: 0 })]);
	});
});
