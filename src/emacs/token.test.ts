/**
 * The helper's API token, driven through `runHelper` with the same wiring
 * `main.ts` gives it: one token-adding fetch under both the api client and
 * `sseOpenEvents`, the token file under a temp home.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROUTES, type SessionRef } from "$shared/protocol.ts";
import { FrameDecoder, encodeFrame } from "./framing.ts";
import { runHelper } from "./helper.ts";
import { sseOpenEvents } from "./sse.ts";
import { withApiToken } from "./token.ts";

const pi: SessionRef = { backend: "pi", id: "/tmp/a.jsonl" };

let home: string;
let stop: (() => Promise<void>) | null = null;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "agentpane-helper-token-"));
});

afterEach(async () => {
	await stop?.();
	stop = null;
	rmSync(home, { recursive: true, force: true });
});

function tokenPath(): string {
	return join(home, ".ssh", "agentpane-token");
}

function writeToken(token: string): void {
	mkdirSync(join(home, ".ssh"), { mode: 0o700 });
	writeFileSync(tokenPath(), `${token}\n`, { mode: 0o600 });
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * The server: every call recorded with its headers; the event stream held
 * open, as the real one is; every other route answered by `answer`, or the
 * whole server absent when `answer` is "refused".
 */
function server(answer: ((key: string) => Response) | "refused") {
	const calls: { key: string; headers: Record<string, string> }[] = [];
	const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const key = `${init?.method ?? "GET"} ${String(input)}`;
		calls.push({ key, headers: { ...(init?.headers as Record<string, string> | undefined) } });
		if (answer === "refused") throw new TypeError("fetch failed");
		if (key === `GET ${ROUTES.events}`) {
			const body = new ReadableStream<Uint8Array>({ start: (c) => void streams.push(c) });
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		}
		return answer(key);
	}) as typeof globalThis.fetch;
	return { fetch, calls, streams };
}

function start(fetch: typeof globalThis.fetch) {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const input = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
	const out: Record<string, unknown>[] = [];
	const decoder = new FrameDecoder();
	const loopback = withApiToken(fetch, home);
	let exited = false;
	const done = runHelper({
		input,
		write: (frame) => {
			for (const message of decoder.push(frame)) out.push(message as Record<string, unknown>);
		},
		fetch: loopback,
		openEvents: sseOpenEvents(loopback),
		render: (markdown) => markdown,
	}).then(() => void (exited = true));
	stop = async () => {
		try {
			controller.close();
		} catch {
			// Already cancelled by the helper's own exit.
		}
		await done;
	};
	return {
		send: (message: unknown) => controller.enqueue(encodeFrame(message)),
		exited: () => exited,
		async response(id: number): Promise<Record<string, unknown>> {
			for (let i = 0; i < 200; i++) {
				const found = out.find((message) => message["id"] === id);
				if (found) return found;
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			throw new Error(`no response to ${id}: ${JSON.stringify(out)}`);
		},
	};
}

describe("the API token", () => {
	it("goes as a bearer on every request, the event stream's too, beside the headers the caller set", async () => {
		writeToken("the-token");
		const { fetch, calls } = server((key) => (key.startsWith("GET ") ? json({ sessions: [] }) : new Response(null, { status: 204 })));
		const helper = start(fetch);
		helper.send({ jsonrpc: "2.0", id: 1, method: "sessions/list", params: {} });
		helper.send({ jsonrpc: "2.0", id: 2, method: "sessions/prompt", params: { session: pi, text: "hi" } });
		expect(await helper.response(1)).toMatchObject({ result: [] });
		expect(await helper.response(2)).toMatchObject({ result: null });
		expect(calls.map((call) => call.key).sort()).toEqual(
			[`GET ${ROUTES.events}`, `GET ${ROUTES.sessions}`, `POST ${ROUTES.prompt(pi)}`].sort(),
		);
		for (const call of calls) expect(call.headers["authorization"], call.key).toBe("Bearer the-token");
		expect(calls.find((call) => call.key === `GET ${ROUTES.events}`)!.headers["accept"]).toBe("text/event-stream");
		expect(calls.find((call) => call.key === `POST ${ROUTES.prompt(pi)}`)!.headers["content-type"]).toBe("application/json");
	});

	it("with no token file, goes out without one, and a 401 names the missing file and the helper keeps serving", async () => {
		const { fetch, calls } = server((key) =>
			key === `GET ${ROUTES.sessions}`
				? json({ error: "unauthorized", detail: "this API needs its bearer token" }, 401)
				: json({ models: [] }),
		);
		const helper = start(fetch);
		helper.send({ jsonrpc: "2.0", id: 1, method: "sessions/list", params: {} });
		const reply = await helper.response(1);
		const error = reply["error"] as { code: number; message: string; data: { status: number } };
		expect(error.code).toBe(401);
		expect(error.data.status).toBe(401);
		expect(error.message).toContain(tokenPath());
		expect(error.message).toContain("does not exist");
		for (const call of calls) expect(call.headers, call.key).not.toHaveProperty("authorization");

		helper.send({ jsonrpc: "2.0", id: 2, method: "models/list", params: { backend: "pi" } });
		expect(await helper.response(2)).toMatchObject({ result: [] });
		expect(helper.exited()).toBe(false);
	});

	it("with a token file, a 401 names the file whose token was refused", async () => {
		writeToken("a-stale-token");
		const { fetch } = server(() => json({ error: "unauthorized", detail: "this API needs its bearer token" }, 401));
		const helper = start(fetch);
		helper.send({ jsonrpc: "2.0", id: 1, method: "models/list", params: { backend: "pi" } });
		const error = (await helper.response(1))["error"] as { code: number; message: string; data: { status: number } };
		expect(error.code).toBe(401);
		expect(error.data.status).toBe(401);
		expect(error.message).toContain(tokenPath());
		expect(error.message).toContain("refused");
		expect(error.message).not.toContain("does not exist");
	});

	it("with no token file and no server, answers that the server could not be reached, as ever", async () => {
		const { fetch } = server("refused");
		const helper = start(fetch);
		// A request that opens no stream fails with the connection's own error, with no `data`.
		helper.send({ jsonrpc: "2.0", id: 0, method: "models/list", params: { backend: "pi" } });
		expect(await helper.response(0)).toEqual({ jsonrpc: "2.0", id: 0, error: { code: -32603, message: "fetch failed" } });
		// One that waits on the stream's first open is answered as unreachable (`openStream` in helper.ts).
		helper.send({ jsonrpc: "2.0", id: 1, method: "sessions/list", params: {} });
		expect(await helper.response(1)).toEqual({
			jsonrpc: "2.0",
			id: 1,
			error: { code: -32603, message: "could not reach the agentpane server" },
		});
	});
});
