/**
 * The helper's API token, driven through `runHelper` with the wiring
 * `main.ts` gives it: the token file read under a temp home, carried by the
 * socket's `hello` (D31 point 5).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeSocket } from "$client/test-support.ts";
import { SOCKET_CLOSE, SOCKET_PATH } from "$shared/protocol.ts";
import { FrameDecoder, encodeFrame } from "./framing.ts";
import { runHelper } from "./helper.ts";
import { readApiToken } from "./token.ts";

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

/**
 * The helper against one socket that accepts a `hello` carrying `accepted`
 * and closes on any other, as the server does, and answers a listing with
 * none; with `accepted` null, a socket that never opens, as with no server.
 */
function start(accepted: string | null) {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const input = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
	const out: Record<string, unknown>[] = [];
	const decoder = new FrameDecoder();
	const socket = new FakeSocket(SOCKET_PATH, (from, frame) => {
		if (frame["cmd"] === "hello") {
			if (frame["token"] === accepted) from.deliver({ type: "reply", id: frame["id"] as string, ok: true, result: null });
			else from.drop(SOCKET_CLOSE.unauthorized, "the first frame must be a hello carrying the token");
		} else if (frame["cmd"] === "sessions/list") {
			from.deliver({ type: "reply", id: frame["id"] as string, ok: true, result: { sessions: [] } });
		}
	});
	let exited = false;
	const done = runHelper({
		input,
		write: (frame) => {
			for (const message of decoder.push(frame)) out.push(message as Record<string, unknown>);
		},
		openSocket: () => socket,
		token: () => readApiToken(home),
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
		socket,
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
	it("goes in the hello, the socket's first frame, read from the file", async () => {
		writeToken("the-token");
		const helper = start("the-token");
		helper.send({ jsonrpc: "2.0", id: 1, method: "sessions/list", params: {} });
		await new Promise((resolve) => setTimeout(resolve, 5));
		helper.socket.open();
		expect(await helper.response(1)).toMatchObject({ result: [] });
		expect(helper.socket.sent[0]).toEqual({ id: expect.any(String), cmd: "hello", token: "the-token" });
		expect(helper.exited()).toBe(false);
	});

	it("with no token file, sends an empty one, and the refusal names the missing file and the helper exits", async () => {
		const helper = start("the-token");
		helper.send({ jsonrpc: "2.0", id: 1, method: "sessions/list", params: {} });
		await new Promise((resolve) => setTimeout(resolve, 5));
		helper.socket.open();
		const error = (await helper.response(1))["error"] as { message: string; data: { error: string } };
		expect(helper.socket.sent[0]).toMatchObject({ cmd: "hello", token: "" });
		expect(error.data.error).toBe("unauthorized");
		expect(error.message).toContain(tokenPath());
		expect(error.message).toContain("does not exist");
		await stop?.();
		stop = null;
		expect(helper.exited()).toBe(true);
	});

	it("with a token file, the refusal names the file whose token was refused", async () => {
		writeToken("a-stale-token");
		const helper = start("the-token");
		helper.send({ jsonrpc: "2.0", id: 1, method: "models/list", params: { backend: "pi" } });
		await new Promise((resolve) => setTimeout(resolve, 5));
		helper.socket.open();
		const error = (await helper.response(1))["error"] as { message: string; data: { error: string } };
		expect(error.data.error).toBe("unauthorized");
		expect(error.message).toContain(tokenPath());
		expect(error.message).toContain("refused");
		expect(error.message).not.toContain("does not exist");
	});

	it("with no token file and no server, answers that the server could not be reached, as ever", async () => {
		const helper = start(null);
		helper.send({ jsonrpc: "2.0", id: 1, method: "sessions/list", params: {} });
		await new Promise((resolve) => setTimeout(resolve, 5));
		helper.socket.drop(1006);
		const error = (await helper.response(1))["error"] as { message: string; data: { error: string } };
		expect(error.message).toBe("could not reach the agentpane server");
		expect(error.data.error).toBe("unreachable");
	});
});
