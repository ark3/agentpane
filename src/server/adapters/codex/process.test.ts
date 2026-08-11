import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: childProcess.spawn }));

import { CodexClient } from "./jsonrpc.ts";
import { LineSplitter, spawnCodex } from "./process.ts";

class FakeReadable extends EventEmitter {
	encoding: string | undefined;

	setEncoding(encoding: string): void {
		this.encoding = encoding;
	}
}

class FakeWritable extends EventEmitter {
	readonly chunks: string[] = [];
	endCalls = 0;
	destroyed = false;

	write(chunk: string): boolean {
		this.chunks.push(chunk);
		return true;
	}

	end(): void {
		this.endCalls++;
		this.destroyed = true;
	}
}

class FakeChild extends EventEmitter {
	readonly stdout = new FakeReadable();
	readonly stderr = new FakeReadable();
	readonly stdin = new FakeWritable();
	killCalls = 0;

	kill(): boolean {
		this.killCalls++;
		return true;
	}
}

function spawnHarness(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
	const child = new FakeChild();
	childProcess.spawn.mockReturnValue(child);
	const cwd = options.cwd ?? "/home/u/src/project";
	const proc = spawnCodex({ cwd, ...(options.env ? { env: options.env } : {}) });
	return { child, cwd, proc };
}

beforeEach(() => {
	childProcess.spawn.mockReset();
});

describe("LineSplitter", () => {
	it("uses LF as the only record delimiter, preserving U+2028 and U+2029 inside JSON", () => {
		const splitter = new LineSplitter();
		const lines: string[] = [];
		const lineSeparator = String.fromCharCode(0x2028);
		const paragraphSeparator = String.fromCharCode(0x2029);
		const text = `before${lineSeparator}middle${paragraphSeparator}after`;
		const payload = JSON.stringify({ method: "item/agentMessage/delta", params: { delta: text } });

		splitter.push(`${payload}\n`, (line) => lines.push(line));

		expect(lines).toEqual([payload]);
		expect(JSON.parse(lines[0] as string).params.delta).toBe(text);
	});

	it("buffers partial chunks and emits each completed LF-delimited line", () => {
		const splitter = new LineSplitter();
		const lines: string[] = [];

		splitter.push('{"id":1,"res', (line) => lines.push(line));
		expect(lines).toEqual([]);
		splitter.push('ult":true}\n{"id":2,"result":false}\n', (line) => lines.push(line));

		expect(lines).toEqual(['{"id":1,"result":true}', '{"id":2,"result":false}']);
	});

	it("flushes a final unterminated line exactly once", () => {
		const splitter = new LineSplitter();
		const lines: string[] = [];
		splitter.push('{"id":1,"result":true}\n{"id":2,"result":false}', (line) => lines.push(line));

		splitter.flush((line) => lines.push(line));
		splitter.flush((line) => lines.push(line));

		expect(lines).toEqual(['{"id":1,"result":true}', '{"id":2,"result":false}']);
	});

	it("preserves a whitespace-only LF frame for protocol validation", () => {
		const splitter = new LineSplitter();
		const lines: string[] = [];

		splitter.push(" \t\n", (line) => lines.push(line));

		expect(lines).toEqual([" \t"]);
	});
});

describe("spawnCodex", () => {
	it("spawns the exact direnv/sbox command in the workspace with the supplied environment", () => {
		const env = { PATH: "/usr/bin", AGENTPANE_TEST: "1" };
		const { cwd } = spawnHarness({ env });

		expect(childProcess.spawn).toHaveBeenCalledOnce();
		expect(childProcess.spawn).toHaveBeenCalledWith(
			"direnv",
			["exec", cwd, "sbox", "--", "codex", "app-server"],
			{ cwd, env, stdio: ["pipe", "pipe", "pipe"] },
		);
	});

	it("writes one LF-framed message and reassembles stdout chunks", () => {
		const { child, proc } = spawnHarness();
		const lines: string[] = [];
		proc.onLine((line) => lines.push(line));

		proc.write('{"id":1,"method":"initialize"}');
		child.stdout.emit("data", '{"id":1,"res');
		child.stdout.emit("data", 'ult":{}}\n{"id":2,"result":true}');
		expect(lines).toEqual(['{"id":1,"result":{}}']);
		child.stdout.emit("end");

		expect(child.stdin.chunks).toEqual(['{"id":1,"method":"initialize"}\n']);
		expect(lines).toEqual(['{"id":1,"result":{}}', '{"id":2,"result":true}']);
	});
});

describe("Codex process lifecycle", () => {
	it("retains routine stderr without reporting a healthy process as terminated", () => {
		const { child, proc } = spawnHarness();
		const onExit = vi.fn();
		proc.onExit(onExit);

		child.stderr.emit("data", "direnv: loading /home/u/src/project/.envrc\n");
		child.stderr.emit("data", "sbox: mounting workspace\n");

		expect(onExit).not.toHaveBeenCalled();
	});

	it("waits for close after a spawn error, then rejects initialization once with the spawn cause", async () => {
		const { child, proc } = spawnHarness();
		const onExit = vi.fn();
		proc.onExit(onExit);
		const client = new CodexClient(proc, { onMessage: vi.fn() });
		const initialized = client.request("initialize");
		let rejection: unknown;
		void initialized.catch((error: unknown) => {
			rejection = error;
		});

		child.emit("error", new Error("spawn direnv ENOENT"));
		await Promise.resolve();
		expect(rejection).toBeUndefined();
		expect(onExit).not.toHaveBeenCalled();

		child.emit("close", -2, null);
		await expect(initialized).rejects.toThrow(/Failed to spawn Codex \(direnv\): spawn direnv ENOENT/);
		expect(onExit).toHaveBeenCalledOnce();
	});

	it("captures an asynchronous stdin EPIPE and rejects on close with its cause", async () => {
		const { child, proc } = spawnHarness();
		const onExit = vi.fn();
		proc.onExit(onExit);
		const client = new CodexClient(proc, { onMessage: vi.fn() });
		const pending = client.request("initialize");
		let rejection: unknown;
		let rejectionCount = 0;
		void pending.catch((error: unknown) => {
			rejection = error;
			rejectionCount++;
		});

		expect(() => child.stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
		await Promise.resolve();
		expect(rejection).toBeUndefined();
		expect(onExit).not.toHaveBeenCalled();

		child.emit("close", 1, null);
		await expect(pending).rejects.toThrow("Codex app-server stdin failed: write EPIPE");
		child.emit("close", 1, null);
		await Promise.resolve();
		expect(rejectionCount).toBe(1);
		expect(onExit).toHaveBeenCalledOnce();
	});

	it("settles termination on close even when no exit event arrives", async () => {
		const { child, proc } = spawnHarness();
		const client = new CodexClient(proc, { onMessage: vi.fn() });
		const pending = client.request("initialize");

		child.emit("close", 1, null);

		await expect(pending).rejects.toThrow("codex app-server exited (code=1, signal=null)");
	});

	it("includes only a bounded stderr tail in death diagnostics", async () => {
		const { child, proc } = spawnHarness();
		const client = new CodexClient(proc, { onMessage: vi.fn() });
		const pending = client.request("initialize");
		const discardedPrefix = "discard-me:";

		child.stderr.emit("data", `${discardedPrefix}${"x".repeat(10_000)}TAIL: auth.json.lock: EROFS\n`);
		child.emit("close", 1, null);

		const error = await pending.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("TAIL: auth.json.lock: EROFS");
		expect((error as Error).message).not.toContain(discardedPrefix);
		expect((error as Error).message.length).toBeLessThan(9_000);
	});

	it("kills and closes stdin at most once", () => {
		const { child, proc } = spawnHarness();

		proc.kill();
		proc.kill();

		expect(child.stdin.endCalls).toBe(1);
		expect(child.killCalls).toBe(1);
	});

	it("refuses writes after kill starts teardown", () => {
		const { proc } = spawnHarness();
		proc.kill();

		expect(() => proc.write('{"id":1}')).toThrow("Codex process is not running");
	});

	it("refuses writes after the child has closed", () => {
		const { child, proc } = spawnHarness();
		child.emit("close", 0, null);

		expect(() => proc.write('{"id":1}')).toThrow("Codex process is not running");
	});
});
