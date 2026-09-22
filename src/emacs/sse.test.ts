/**
 * The hand-rolled SSE reader over `fetch` (OW-refibu), driven by a scripted
 * response body so the chunking is the test's, not the network's.
 */

import { describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "$shared/protocol.ts";
import type { EventHandlers } from "$client/api.ts";
import { sseOpenEvents } from "./sse.ts";

const encoder = new TextEncoder();

function scriptedBody(): { body: ReadableStream<Uint8Array>; write(text: string): void; end(): void } {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
	return {
		body,
		write: (text) => controller.enqueue(encoder.encode(text)),
		end: () => controller.close(),
	};
}

function handlers(): EventHandlers & { events: ServerEvent[] } {
	const events: ServerEvent[] = [];
	return {
		events,
		onEvent: (event) => events.push(event),
		onOpen: vi.fn(),
		onDisconnect: vi.fn(),
		onMalformed: vi.fn(),
	};
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("sseOpenEvents", () => {
	it("opens the url with an event-stream accept header and reports open on a 200", async () => {
		const script = scriptedBody();
		const fetch = vi.fn(async () => new Response(script.body, { status: 200, headers: { "content-type": "text/event-stream" } }));
		const h = handlers();
		sseOpenEvents(fetch as unknown as typeof globalThis.fetch)("/api/events", h);
		await settle();
		expect(fetch).toHaveBeenCalledWith("/api/events", expect.objectContaining({ headers: { accept: "text/event-stream" } }));
		expect(h.onOpen).toHaveBeenCalledOnce();
		expect(h.onDisconnect).not.toHaveBeenCalled();
	});

	it("delivers data frames whatever the chunking, and skips comments", async () => {
		const script = scriptedBody();
		const fetch = async () => new Response(script.body, { status: 200 });
		const h = handlers();
		sseOpenEvents(fetch as unknown as typeof globalThis.fetch)("/api/events", h);
		script.write(': ping\n\ndata: {"type":"sessions-changed"}\n\ndata: {"type":"sta');
		script.write('tus","session":{"backend":"pi","id":"a"},"seq":1,"isStreaming":true,"compaction":null,"model":null}\n\n');
		await settle();
		expect(h.events).toEqual([
			{ type: "sessions-changed" },
			{ type: "status", session: { backend: "pi", id: "a" }, seq: 1, isStreaming: true, compaction: null, model: null },
		]);
		expect(h.onMalformed).not.toHaveBeenCalled();
	});

	it("reports malformed JSON without dropping the frames around it", async () => {
		const script = scriptedBody();
		const fetch = async () => new Response(script.body, { status: 200 });
		const h = handlers();
		sseOpenEvents(fetch as unknown as typeof globalThis.fetch)("/api/events", h);
		script.write('data: {oops\n\ndata: {"type":"sessions-changed"}\n\n');
		await settle();
		expect(h.onMalformed).toHaveBeenCalledWith(expect.any(Error));
		expect(h.events).toEqual([{ type: "sessions-changed" }]);
	});

	it("reports a disconnect when the body ends, and when the response is not a 200", async () => {
		const script = scriptedBody();
		const ended = handlers();
		sseOpenEvents((async () => new Response(script.body, { status: 200 })) as unknown as typeof globalThis.fetch)("/api/events", ended);
		script.end();
		await settle();
		expect(ended.onDisconnect).toHaveBeenCalledOnce();

		const refused = handlers();
		sseOpenEvents((async () => new Response("nope", { status: 404 })) as unknown as typeof globalThis.fetch)("/api/events", refused);
		await settle();
		expect(refused.onOpen).not.toHaveBeenCalled();
		expect(refused.onDisconnect).toHaveBeenCalledOnce();

		const failed = handlers();
		sseOpenEvents((async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof globalThis.fetch)("/api/events", failed);
		await settle();
		expect(failed.onDisconnect).toHaveBeenCalledOnce();
	});

	it("aborts the request on close and reports nothing after it", async () => {
		const script = scriptedBody();
		let signal: AbortSignal | undefined;
		const fetch = async (_url: string, init?: RequestInit) => {
			signal = init?.signal ?? undefined;
			return new Response(script.body, { status: 200 });
		};
		const h = handlers();
		const connection = sseOpenEvents(fetch as unknown as typeof globalThis.fetch)("/api/events", h);
		await settle();
		connection.close();
		expect(signal?.aborted).toBe(true);
		script.write('data: {"type":"sessions-changed"}\n\n');
		script.end();
		await settle();
		expect(h.events).toEqual([]);
		expect(h.onDisconnect).not.toHaveBeenCalled();
	});
});
