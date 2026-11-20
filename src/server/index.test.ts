/**
 * The Bun binding, `src/server/index.ts`, which no in-process test reaches:
 * the real entry point run by `bun` against a throwaway home, and driven
 * over a real socket. What a command does behind the binding is
 * `http/socket.test.ts`'s; here is only what the binding itself decides --
 * which request is upgraded, the frame limit, a binary frame, and shutdown.
 *
 * Not covered: the close on `backpressureLimit`, which needs a client that
 * stops reading (`docs/MANUAL_TESTING.md`, "The socket through agentpane's
 * own binding").
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { type IncomingMessage, request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_SOCKET_FRAME_BYTES, SOCKET_CLOSE, SOCKET_PATH } from "../shared/protocol.ts";

type Reply = { type: "reply"; id: string; ok: boolean; code?: string };

let home: string;
let port: number;
let token: string;
let server: ChildProcess;
let exited: Promise<number | null>;

beforeAll(async () => {
	// The server reads its token and every session store under the home
	// directory, so a home of its own keeps the owner's out of the run.
	home = mkdtempSync(join(tmpdir(), "agentpane-binding-"));
	mkdirSync(join(home, ".ssh"), { mode: 0o700 });
	port = await freePort();
	server = spawn("bun", ["src/server/index.ts"], {
		cwd: fileURLToPath(new URL("../..", import.meta.url)),
		env: { PATH: process.env.PATH, HOME: home, PORT: String(port) },
		stdio: ["ignore", "pipe", "inherit"],
	});
	exited = new Promise((done) => server.once("exit", (code) => done(code)));
	await new Promise<void>((listening, failed) => {
		server.stdout?.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("listening")) listening();
		});
		void exited.then((code) => failed(new Error(`the server exited ${code} before listening`)));
	});
	token = readFileSync(join(home, ".ssh", "agentpane-token"), "utf8").trim();
}, 20_000);

afterAll(async () => {
	server.kill("SIGKILL");
	await exited;
	rmSync(home, { recursive: true, force: true });
});

function freePort(): Promise<number> {
	return new Promise((found) => {
		const probe = createServer();
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => found(port));
		});
	});
}

/** An upgrade request written by hand, since a `WebSocket` cannot name its `Origin`. */
function upgrade(headers: Record<string, string>): Promise<{ status: number; upgraded: boolean }> {
	return new Promise((answered, failed) => {
		const req = request({ host: "127.0.0.1", port, path: SOCKET_PATH, headers });
		req.on("response", (response: IncomingMessage) => {
			response.resume();
			answered({ status: response.statusCode ?? 0, upgraded: false });
		});
		req.on("upgrade", (response, socket) => {
			socket.destroy();
			answered({ status: response.statusCode ?? 0, upgraded: true });
		});
		req.on("error", failed);
		req.end();
	});
}

const UPGRADE = {
	connection: "Upgrade",
	upgrade: "websocket",
	"sec-websocket-version": "13",
	"sec-websocket-key": randomBytes(16).toString("base64"),
};

interface Client {
	replies: Reply[];
	/** The close code, once the socket has closed. */
	closed: Promise<number>;
	send(frame: Record<string, unknown>): void;
	raw(data: Uint8Array): void;
	reply(id: string): Promise<Reply>;
}

async function open(): Promise<Client> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}${SOCKET_PATH}`);
	const replies: Reply[] = [];
	const waiting = new Map<string, (reply: Reply) => void>();
	socket.addEventListener("message", (message) => {
		const frame = JSON.parse(String(message.data)) as Reply;
		if (frame.type !== "reply") return;
		replies.push(frame);
		waiting.get(frame.id)?.(frame);
	});
	const closed = new Promise<number>((done) => socket.addEventListener("close", (event) => done(event.code)));
	await new Promise<void>((opened, failed) => {
		socket.addEventListener("open", () => opened());
		socket.addEventListener("error", () => failed(new Error("the socket did not open")));
	});
	return {
		replies,
		closed,
		send: (frame) => socket.send(JSON.stringify(frame)),
		raw: (data) => socket.send(data),
		reply: (id) => new Promise((got) => waiting.set(id, got)),
	};
}

async function greeted(): Promise<Client> {
	const client = await open();
	const hello = client.reply("hello");
	client.send({ id: "hello", cmd: "hello", token });
	expect((await hello).ok).toBe(true);
	return client;
}

describe("the upgrade", () => {
	it("is given to a request with no Origin, and refused one from a page elsewhere", async () => {
		expect(await upgrade(UPGRADE)).toEqual({ status: 101, upgraded: true });
		expect(await upgrade({ ...UPGRADE, origin: "https://example.com" })).toEqual({ status: 403, upgraded: false });
	});

	it("is the only thing the socket's path answers", async () => {
		expect(await upgrade({})).toEqual({ status: 426, upgraded: false });
	});
});

describe("a socket through the binding", () => {
	it("is closed for a hello carrying the wrong token", async () => {
		const client = await open();
		client.send({ id: "hello", cmd: "hello", token: `${token}x` });
		expect(await client.closed).toBe(SOCKET_CLOSE.unauthorized);
		expect(client.replies).toEqual([]);
	});

	it("answers the hello, then a listing of the empty home", async () => {
		const client = await greeted();
		const listed = client.reply("list");
		client.send({ id: "list", cmd: "sessions/list" });
		expect(await listed).toMatchObject({ ok: true, result: { sessions: [] } });
		expect(client.replies.map((reply) => reply.id)).toEqual(["hello", "list"]);
	});

	it("reads a binary frame as a bad frame", async () => {
		const client = await greeted();
		client.raw(new TextEncoder().encode(JSON.stringify({ id: "binary", cmd: "sessions/list" })));
		expect(await client.closed).toBe(SOCKET_CLOSE.badFrame);
		expect(client.replies.map((reply) => reply.id)).toEqual(["hello"]);
	});

	it("answers a frame just under the limit, and closes on one over it", async () => {
		const client = await greeted();
		const under = client.reply("under");
		client.send({ id: "under", cmd: "no such command", pad: "x".repeat(MAX_SOCKET_FRAME_BYTES - 1024) });
		expect(await under).toMatchObject({ ok: false, code: "bad_request" });

		client.send({ id: "over", cmd: "no such command", pad: "x".repeat(MAX_SOCKET_FRAME_BYTES + 1024) });
		await client.closed;
		expect(client.replies.map((reply) => reply.id)).toEqual(["hello", "under"]);
	});
});

describe("shutdown", () => {
	it("closes every socket as going away, and exits cleanly", async () => {
		const client = await greeted();
		server.kill("SIGTERM");
		expect(await client.closed).toBe(SOCKET_CLOSE.goingAway);
		expect(await exited).toBe(0);
	});
});
