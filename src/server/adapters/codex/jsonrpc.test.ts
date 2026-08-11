import { describe, expect, it, vi } from "vitest";
import { CodexClient, CodexRpcError } from "./jsonrpc.ts";
import type { CodexProcess } from "./process.ts";

class FakeProcess implements CodexProcess {
	readonly written: Record<string, unknown>[] = [];
	writeError: Error | undefined;
	private readonly lineHandlers: ((line: string) => void)[] = [];
	private readonly exitHandlers: ((code: number | null, signal: string | null) => void)[] = [];

	write(line: string): void {
		if (this.writeError) throw this.writeError;
		this.written.push(JSON.parse(line) as Record<string, unknown>);
	}

	onLine(cb: (line: string) => void): void {
		this.lineHandlers.push(cb);
	}

	onExit(cb: (code: number | null, signal: string | null) => void): void {
		this.exitHandlers.push(cb);
	}

	kill(): void {}

	emit(message: unknown): void {
		this.emitRaw(JSON.stringify(message));
	}

	emitRaw(line: string): void {
		for (const handler of this.lineHandlers) handler(line);
	}

	exit(code: number | null, signal: string | null): void {
		for (const handler of this.exitHandlers) handler(code, signal);
	}
}

function makeClient() {
	const proc = new FakeProcess();
	const onMessage = vi.fn();
	const onMalformed = vi.fn();
	const onExit = vi.fn();
	const client = new CodexClient(proc, { onMessage, onMalformed, onExit });
	return { client, proc, onMessage, onMalformed, onExit };
}

describe("CodexClient request correlation", () => {
	it("routes concurrent responses by id when they arrive out of order", async () => {
		const { client, proc } = makeClient();

		const first = client.request("thread/read", { threadId: "thread-1" });
		const second = client.request("model/list", { limit: 10 });
		expect(proc.written).toEqual([
			{ id: 1, method: "thread/read", params: { threadId: "thread-1" } },
			{ id: 2, method: "model/list", params: { limit: 10 } },
		]);

		proc.emit({ id: 2, result: { data: ["model-a"] } });
		proc.emit({ id: 1, result: { thread: { id: "thread-1" } } });

		expect(await first).toEqual({ thread: { id: "thread-1" } });
		expect(await second).toEqual({ data: ["model-a"] });
	});

	it("rejects only the matching request with the server error metadata", async () => {
		const { client, proc } = makeClient();
		const failed = client.request("turn/start");
		const successful = client.request("thread/read");

		proc.emit({ id: 1, error: { code: -32602, message: "invalid turn", data: { field: "input" } } });
		proc.emit({ id: 2, result: { thread: { id: "thread-1" } } });

		const error = await failed.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(CodexRpcError);
		expect(error).toMatchObject({
			name: "CodexRpcError",
			message: "invalid turn",
			code: -32602,
			data: { field: "input" },
		});
		expect(await successful).toEqual({ thread: { id: "thread-1" } });
	});

	it("returns a rejected promise when the transport write fails synchronously", async () => {
		const { client, proc } = makeClient();
		proc.writeError = new Error("stdin is closed");
		let request: Promise<unknown> | undefined;

		expect(() => {
			request = client.request("initialize");
		}).not.toThrow();

		await expect(request).rejects.toThrow("stdin is closed");
		expect(proc.written).toEqual([]);
	});
});

describe("CodexClient inbound messages", () => {
	it("delivers notifications without consuming pending responses", async () => {
		const { client, proc, onMessage } = makeClient();
		const pending = client.request("initialize");
		const notification = { method: "thread/started", params: { thread: { id: "thread-1" } } };

		proc.emit(notification);
		expect(onMessage).toHaveBeenCalledOnce();
		expect(onMessage).toHaveBeenCalledWith(notification);

		proc.emit({ id: 1, result: { userAgent: "codex" } });
		expect(await pending).toEqual({ userAgent: "codex" });
	});

	it("delivers server-initiated requests for the adapter to answer", () => {
		const { proc, onMessage } = makeClient();
		const request = {
			id: "approval-7",
			method: "item/commandExecution/requestApproval",
			params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
		};

		proc.emit(request);

		expect(onMessage).toHaveBeenCalledOnce();
		expect(onMessage).toHaveBeenCalledWith(request);
	});

	it("reports malformed JSON and continues consuming later messages", () => {
		const { proc, onMessage, onMalformed } = makeClient();
		const notification = { method: "thread/started", params: { thread: { id: "thread-1" } } };

		proc.emitRaw("not-json");
		proc.emit(notification);

		expect(onMalformed).toHaveBeenCalledOnce();
		expect(onMalformed).toHaveBeenCalledWith("not-json");
		expect(onMessage).toHaveBeenCalledWith(notification);
	});

	it("reports parsed primitives and whitespace-only records as malformed", () => {
		const { proc, onMessage, onMalformed } = makeClient();

		proc.emitRaw("42");
		proc.emitRaw(" \t");

		expect(onMalformed.mock.calls).toEqual([["42"], [" \t"]]);
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("reports an incomplete response without consuming its pending request", async () => {
		const { client, proc, onMalformed } = makeClient();
		const pending = client.request("initialize");

		proc.emit({ id: 1 });
		proc.emit({ id: 1, result: { userAgent: "codex" } });

		expect(onMalformed).toHaveBeenCalledWith('{"id":1}');
		expect(await pending).toEqual({ userAgent: "codex" });
	});

	it("rejects invalid response variants without disturbing correlation", async () => {
		const { client, proc, onMalformed } = makeClient();
		const pending = client.request("initialize");
		const malformed = [
			{ id: 1, result: null, error: { code: -1, message: "both" } },
			{ id: 1, error: { code: "-1", message: "wrong code" } },
			{ id: 1, error: { code: -1, message: 7 } },
		];

		for (const envelope of malformed) proc.emit(envelope);
		proc.emit({ id: 1, result: "ready" });

		expect(onMalformed.mock.calls.map(([line]) => JSON.parse(line as string))).toEqual(malformed);
		expect(await pending).toBe("ready");
	});

	it("reports invalid pushed envelopes instead of dispatching them", () => {
		const { proc, onMessage, onMalformed } = makeClient();
		const malformed = [
			[],
			{ method: 7, params: {} },
			{ id: null, method: "approval", params: {} },
			{ method: "thread/started", params: {}, result: null },
		];

		for (const envelope of malformed) proc.emit(envelope);

		expect(onMalformed).toHaveBeenCalledTimes(malformed.length);
		expect(onMessage).not.toHaveBeenCalled();
	});
});

describe("CodexClient termination", () => {
	it("rejects every pending and future request when the process exits", async () => {
		const { client, proc, onExit } = makeClient();
		const first = client.request("initialize");
		const second = client.request("thread/start");

		proc.exit(1, null);

		const results = await Promise.allSettled([first, second, client.request("model/list")]);
		for (const result of results) {
			expect(result.status).toBe("rejected");
			if (result.status === "rejected") {
				expect(result.reason).toMatchObject({
					name: "CodexRpcError",
					message: "codex app-server exited (code=1, signal=null)",
				});
			}
		}
		expect(onExit).toHaveBeenCalledOnce();
		expect(onExit).toHaveBeenCalledWith(1, null);
		expect(proc.written).toHaveLength(2);
	});

	it("disposal rejects pending calls and makes later calls fail fast", async () => {
		const { client, proc } = makeClient();
		const pending = client.request("initialize");

		client.dispose("session disposed");
		client.dispose("ignored second reason");

		await expect(pending).rejects.toMatchObject({ name: "CodexRpcError", message: "session disposed" });
		await expect(client.request("thread/start")).rejects.toMatchObject({
			name: "CodexRpcError",
			message: "session disposed",
		});
		expect(proc.written).toHaveLength(1);
	});
});
