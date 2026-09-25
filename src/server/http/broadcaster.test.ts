/**
 * The SSE hub's own edges: framing, and the keepalive that `src/server/index.ts`
 * depends on to hold a stream open past Bun's idle timeout.
 */

import { describe, expect, it, vi } from "vitest";
import type { ServerEvent, SessionRef } from "../../shared/protocol.ts";
import { Broadcaster, formatSseFrame } from "./broadcaster.ts";
import { userMessage } from "./testing/fakes.ts";

const REF: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/a.jsonl" };
const HANDLE = "h1";

describe("framing", () => {
	it("puts every event on one line, terminated by a blank line", () => {
		const frame = formatSseFrame({ type: "sessions-changed" });
		expect(frame).toBe('data: {"type":"sessions-changed"}\n\n');
	});

	it("survives message text that contains newlines and separators", () => {
		// A transcript is full of newlines, and SSE splits records on them. JSON
		// escapes those; U+2028/U+2029 it does not escape, but SSE does not treat
		// them as line terminators either (unlike node:readline, which is why
		// Pi's own framing is LF-only -- HANDOFF's environment gotchas).
		const text = "line one\nline two\r\nthree four five";
		const frame = formatSseFrame({
			type: "upsert",
			session: REF,
			handle: "h1",
			seq: 1,
			index: 0,
			message: userMessage(text),
		});
		const body = frame.slice("data: ".length, -2);
		expect(body).not.toContain("\n");
		expect(body).not.toContain("\r");
		const parsed = JSON.parse(body) as { message: { content: { text: string }[] } };
		expect(parsed.message.content[0]?.text).toBe(text);
	});
});

describe("keepalive", () => {
	it("pings idle streams, so they outlive the server's idle timeout", async () => {
		vi.useFakeTimers();
		try {
			const broadcaster = new Broadcaster(1000);
			const chunks: string[] = [];
			broadcaster.addClient((c) => chunks.push(c));

			await vi.advanceTimersByTimeAsync(3500);
			expect(chunks.filter((c) => c.startsWith(":"))).toHaveLength(3);
			// A comment frame, so a client parsing `data:` lines ignores it.
			expect(chunks.at(-1)).toBe(": ping\n\n");
			broadcaster.closeAll();
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops once the last client leaves, so it cannot hold the process open", async () => {
		vi.useFakeTimers();
		try {
			const broadcaster = new Broadcaster(1000);
			const chunks: string[] = [];
			const a = broadcaster.addClient((c) => chunks.push(c));
			const b = broadcaster.addClient(() => {});

			a.close();
			await vi.advanceTimersByTimeAsync(1500);
			const afterOneLeft = chunks.length;
			expect(vi.getTimerCount(), "one client left, keepalive still running").toBeGreaterThan(0);

			b.close();
			await vi.advanceTimersByTimeAsync(5000);
			expect(vi.getTimerCount(), "no clients, no timer").toBe(0);
			expect(chunks).toHaveLength(afterOneLeft);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not start a keepalive at all when it is disabled", async () => {
		vi.useFakeTimers();
		try {
			const broadcaster = new Broadcaster(0);
			broadcaster.addClient(() => {});
			expect(vi.getTimerCount()).toBe(0);
			broadcaster.closeAll();
		} finally {
			vi.useRealTimers();
		}
	});

	it("drops a client whose socket died during a ping, without disturbing the rest", async () => {
		vi.useFakeTimers();
		try {
			const broadcaster = new Broadcaster(1000);
			const alive: string[] = [];
			broadcaster.addClient((c) => alive.push(c));
			// Accepts the opening `retry:` directive, then the socket goes away --
			// which is what a closed tab looks like from in here.
			let writes = 0;
			broadcaster.addClient(() => {
				if (++writes > 1) throw new Error("EPIPE");
			});
			expect(broadcaster.clientCount).toBe(2);

			await vi.advanceTimersByTimeAsync(1000);

			expect(broadcaster.clientCount).toBe(1);
			expect(alive.at(-1)).toBe(": ping\n\n");
			broadcaster.closeAll();
		} finally {
			vi.useRealTimers();
		}
	});
});

/** A broadcaster whose snapshot source holds one session, under `HANDLE`, at whatever `session.ref` says. */
function oneSession() {
	const broadcaster = new Broadcaster();
	const session = { handle: HANDLE, ref: REF };
	broadcaster.setSnapshotSource((handle) =>
		handle === session.handle
			? { ref: session.ref, messages: [], isStreaming: false, compaction: null, model: null, effort: null, error: null, requests: [], notices: [] }
			: null,
	);
	const events: ServerEvent[] = [];
	const client = broadcaster.addClient((chunk) => {
		for (const line of chunk.split("\n")) {
			if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)) as ServerEvent);
		}
	});
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
});

describe("the handle (D24, OW-suyinu)", () => {
	it("rides every per-session event beside its ref", () => {
		const { broadcaster, session, events } = oneSession();
		const request = { requestId: "r1", session: REF, kind: "approval", payload: {} };
		const notice = { kind: "warning", message: "careful", details: null, path: null };

		broadcaster.broadcastSnapshot(HANDLE);
		broadcaster.upsert(session, 0, userMessage("hi"));
		broadcaster.status(session, true, null, null, null, null);
		broadcaster.request(session, request);
		broadcaster.requestResolved(session, "r1");
		broadcaster.error(session, "boom");
		broadcaster.notice(session, notice);

		expect(events.map((event) => event.type)).toEqual([
			"snapshot",
			"upsert",
			"status",
			"request",
			"request-resolved",
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
