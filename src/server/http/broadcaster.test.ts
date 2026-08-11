/**
 * The SSE hub's own edges: framing, and the keepalive that `src/server/index.ts`
 * depends on to hold a stream open past Bun's idle timeout.
 */

import { describe, expect, it, vi } from "vitest";
import type { SessionRef } from "../../shared/protocol.ts";
import { Broadcaster, formatSseFrame } from "./broadcaster.ts";
import { userMessage } from "./testing/fakes.ts";

const REF: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/a.jsonl" };

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

describe("sequence bookkeeping", () => {
	it("forgets a closed session's counter rather than growing with uptime", () => {
		const broadcaster = new Broadcaster();
		broadcaster.setSnapshotSource(() => ({ messages: [], isStreaming: false }));
		broadcaster.status(REF, true);
		expect(broadcaster.seqOf(REF)).toBe(1);

		broadcaster.forget(REF);
		expect(broadcaster.seqOf(REF)).toBe(0);
	});
});
