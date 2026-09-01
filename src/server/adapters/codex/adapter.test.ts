import { describe, expect, it, vi } from "vitest";
import type { AgentRequest, SessionRef } from "../../../shared/protocol.ts";
import { CodexAdapter, CodexAdapterFactory, type CodexAdapterOptions } from "./index.ts";
import type { CodexProcess } from "./process.ts";
import { FakeCodexProcess } from "./test-support.ts";

const VIRTUAL_REF: SessionRef = { backend: "codex", id: "virtual:test" };
const STORED_REF: SessionRef = { backend: "codex", id: "thread-stored" };

type WireMessage = Record<string, unknown>;

function deferred<T>() {
	let resolve: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve: resolve! };
}

class AdapterProcess extends FakeCodexProcess implements CodexProcess {
	killCount = 0;
	readonly #errorAwareExitHandlers: ((
		code: number | null,
		signal: string | null,
		error?: Error,
	) => void)[] = [];

	override onExit(
		cb: (code: number | null, signal: string | null, error?: Error) => void,
	): void {
		this.#errorAwareExitHandlers.push(cb);
	}

	override kill(): Promise<void> {
		this.killCount += 1;
		return super.kill();
	}

	override exit(
		code: number | null = 0,
		signal: string | null = null,
		error?: Error,
	): void {
		for (const handler of [...this.#errorAwareExitHandlers]) handler(code, signal, error);
	}
}

class DelayedTerminationProcess extends AdapterProcess {
	readonly termination = deferred<void>();

	override kill(): Promise<void> {
		void super.kill();
		return this.termination.promise;
	}
}

class SynchronousRegistrationProcess extends AdapterProcess {
	override onLine(cb: (line: string) => void): void {
		super.onLine(cb);
		cb(
			JSON.stringify({
				id: 91,
				method: "item/fileChange/requestApproval",
				params: { itemId: "too-early" },
			}),
		);
	}

	override onExit(
		cb: (code: number | null, signal: string | null, error?: Error) => void,
	): void {
		super.onExit(cb);
		cb(null, null, new Error("registration-time exit"));
	}
}

interface HappyServerOptions {
	threadId?: string;
	turns?: unknown[];
	model?: string;
	modelProvider?: string;
	holdTurnStart?: boolean;
	holdTurnStartAt?: number;
	holdThreadStart?: boolean;
	failCompact?: string;
}

function configureHappyServer(proc: AdapterProcess, options: HappyServerOptions = {}): void {
	let turn = 0;
	proc.onWrite((message) => {
		const id = message["id"];
		if (typeof id !== "number") return;
		switch (message["method"]) {
			case "initialize":
				proc.emit({ id, result: { userAgent: "test" } });
				break;
			case "thread/start":
			case "thread/resume":
				if (options.holdThreadStart) break;
				proc.emit({
					id,
					result: {
						thread: { id: options.threadId ?? "thread-real", turns: options.turns ?? [] },
						model: options.model ?? "gpt-started",
						modelProvider: options.modelProvider ?? "openai",
					},
				});
				break;
			case "turn/start":
				turn += 1;
				if (!options.holdTurnStart && options.holdTurnStartAt !== turn) {
					proc.emit({ id, result: { turn: { id: `turn-${turn}` } } });
				}
				break;
			case "turn/interrupt":
				proc.emit({ id, result: {} });
				break;
			case "thread/compact/start":
				// OW-72: params `{ threadId }`, response an empty object.
				if (options.failCompact) proc.emit({ id, error: { code: -32603, message: options.failCompact } });
				else proc.emit({ id, result: {} });
				break;
		}
	});
}

function request(proc: AdapterProcess, method: string): WireMessage {
	const message = proc.lastRequest(method);
	if (!message) throw new Error(`missing ${method} request`);
	return message;
}

function methods(proc: AdapterProcess): unknown[] {
	return proc.written.filter((message) => "method" in message).map((message) => message["method"]);
}

function responses(proc: AdapterProcess): WireMessage[] {
	return proc.written.filter((message) => !("method" in message));
}

async function startedAdapter(
	options: HappyServerOptions & CodexAdapterOptions = {},
	ref: SessionRef = VIRTUAL_REF,
): Promise<{ adapter: CodexAdapter; proc: AdapterProcess }> {
	const proc = new AdapterProcess();
	configureHappyServer(proc, options);
	const adapter = new CodexAdapter(ref, { ...options, spawn: () => proc });
	await adapter.start({ cwd: "/workspace", ...(ref === STORED_REF ? { resumeId: ref.id } : {}) });
	return { adapter, proc };
}

describe("CodexAdapter lifecycle", () => {
	it("keeps construction side-effect-free and initializes before starting a virtual thread", async () => {
		const proc = new AdapterProcess();
		configureHappyServer(proc);
		const spawn = vi.fn(() => proc);
		const env = { PATH: "/test/bin" };
		const adapter = new CodexAdapter(VIRTUAL_REF, {
			spawn,
			env,
			ephemeral: true,
			clientInfo: { name: "test-client", title: "Test Client", version: "1.2.3" },
		});

		expect(spawn).not.toHaveBeenCalled();
		expect(adapter.ref).toEqual(VIRTUAL_REF);

		await adapter.start({ cwd: "/workspace", model: "gpt-requested" });

		expect(spawn).toHaveBeenCalledOnce();
		expect(spawn).toHaveBeenCalledWith({ cwd: "/workspace", env });
		expect(methods(proc)).toEqual(["initialize", "thread/start"]);
		expect(request(proc, "initialize")["params"]).toEqual({
			clientInfo: { name: "test-client", title: "Test Client", version: "1.2.3" },
			capabilities: null,
		});
		expect(request(proc, "thread/start")["params"]).toEqual({
			cwd: "/workspace",
			model: "gpt-requested",
			ephemeral: true,
			sandbox: "danger-full-access",
		});
	});

	it("resumes a stored thread and hydrates its returned transcript", async () => {
		const proc = new AdapterProcess();
		configureHappyServer(proc, {
			threadId: STORED_REF.id,
			turns: [
				{
					id: "turn-stored",
					items: [
						{
							type: "userMessage",
							id: "user-stored",
							clientId: null,
							content: [{ type: "text", text: "saved prompt", text_elements: [] }],
						},
						{
							type: "agentMessage",
							id: "agent-stored",
							text: "saved answer",
							phase: "final_answer",
							memoryCitation: null,
						},
					],
					itemsView: "full",
					status: "completed",
					error: null,
					startedAt: 1_700_000_000,
					completedAt: 1_700_000_001,
					durationMs: 1000,
				},
			],
		});
		const adapter = new CodexAdapter(STORED_REF, { spawn: () => proc });
		const updates = vi.fn();
		adapter.onUpdate(updates);

		await adapter.start({ cwd: "/workspace", resumeId: STORED_REF.id });

		expect(methods(proc)).toEqual(["initialize", "thread/resume"]);
		expect(request(proc, "thread/resume")["params"]).toEqual({
			threadId: STORED_REF.id,
			cwd: "/workspace",
			sandbox: "danger-full-access",
		});
		expect(adapter.getState().messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(adapter.getState().messages[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "saved prompt" }],
		});
		expect(adapter.getState().messages[1]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "saved answer" }],
			model: "gpt-started",
			provider: "openai",
		});
		expect(updates).toHaveBeenCalledWith(adapter.getState(), undefined);
	});

	it("adopts the real Codex thread id while start resolves", async () => {
		const { adapter } = await startedAdapter({ threadId: "thread-adopted" });

		expect(adapter.ref).toEqual({ backend: "codex", id: "thread-adopted" });
	});

	it("cleans up its client and process when thread startup fails", async () => {
		const proc = new AdapterProcess();
		proc.onWrite((message) => {
			const id = message["id"];
			if (typeof id !== "number") return;
			if (message["method"] === "initialize") proc.emit({ id, result: {} });
			if (message["method"] === "thread/start") {
				proc.emit({ id, error: { code: -32000, message: "workspace rejected" } });
			}
		});
		const adapter = new CodexAdapter(VIRTUAL_REF, { spawn: () => proc });

		await expect(adapter.start({ cwd: "/workspace" })).rejects.toThrow("workspace rejected");

		expect(proc.killCount).toBe(1);
		await expect(adapter.submit("after failure")).rejects.toThrow("codex adapter not started");
	});

	it("rejects pending RPCs on disposal and kills its process exactly once", async () => {
		const { adapter, proc } = await startedAdapter({ holdTurnStart: true });
		const pending = adapter.submit("wait forever");
		const rejected = expect(pending).rejects.toThrow("adapter disposed");

		await adapter.dispose();
		await adapter.dispose();

		await rejected;
		expect(proc.killCount).toBe(1);
	});

	it("keeps disposal pending until process termination settles", async () => {
		const proc = new DelayedTerminationProcess();
		configureHappyServer(proc);
		const adapter = new CodexAdapter(VIRTUAL_REF, { spawn: () => proc });
		await adapter.start({ cwd: "/workspace" });
		let disposed = false;

		const disposal = adapter.dispose().then(() => {
			disposed = true;
		});
		await Promise.resolve();
		expect(disposed).toBe(false);

		proc.termination.resolve();
		await disposal;
		expect(disposed).toBe(true);
	});

	it("surfaces the process-provided exit cause to error subscribers", async () => {
		const { adapter, proc } = await startedAdapter();
		const errors = vi.fn();
		adapter.onError(errors);

		proc.exit(null, null, new Error("Failed to spawn Codex: ENOENT\nstderr detail"));

		expect(errors).toHaveBeenCalledWith("Failed to spawn Codex: ENOENT\nstderr detail");
	});

	it("rejects start after public disposal without spawning", async () => {
		const proc = new AdapterProcess();
		configureHappyServer(proc);
		const spawn = vi.fn(() => proc);
		const adapter = new CodexAdapter(VIRTUAL_REF, { spawn });
		await adapter.dispose();

		await expect(adapter.start({ cwd: "/workspace" })).rejects.toThrow("codex adapter disposed");

		expect(spawn).not.toHaveBeenCalled();
	});

	it("settles a held start on disposal without adopting a ref or killing twice", async () => {
		const proc = new AdapterProcess();
		configureHappyServer(proc, { holdThreadStart: true });
		const adapter = new CodexAdapter(VIRTUAL_REF, { spawn: () => proc });
		const starting = adapter.start({ cwd: "/workspace" });
		const rejected = expect(starting).rejects.toThrow("adapter disposed");
		await Promise.resolve();
		const held = request(proc, "thread/start");

		await adapter.dispose();
		await rejected;
		proc.emit({
			id: held["id"],
			result: { thread: { id: "thread-too-late", turns: [] }, model: "gpt", modelProvider: "openai" },
		});
		await adapter.dispose();

		expect(adapter.ref).toEqual(VIRTUAL_REF);
		expect(proc.killCount).toBe(1);
	});

	it("ignores buffered pushed messages after disposal", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-disposed" });
		await adapter.dispose();
		const updates = vi.fn();
		const requests = vi.fn();
		adapter.onUpdate(updates);
		adapter.onRequest(requests);

		proc.emit({
			method: "turn/started",
			params: {
				threadId: "thread-disposed",
				turn: {
					id: "turn-too-late",
					items: [],
					itemsView: "notLoaded",
					status: "inProgress",
					error: null,
					startedAt: 1,
					completedAt: null,
					durationMs: null,
				},
			},
		});
		proc.emit({ id: 9, method: "item/fileChange/requestApproval", params: {} });

		expect(adapter.getState()).toEqual({ messages: [], isStreaming: false, compaction: null });
		expect(updates).not.toHaveBeenCalled();
		expect(requests).not.toHaveBeenCalled();
	});

	it("ignores buffered pushed messages after startup failure", async () => {
		const proc = new AdapterProcess();
		proc.onWrite((message) => {
			const id = message["id"];
			if (typeof id !== "number") return;
			if (message["method"] === "initialize") proc.emit({ id, result: {} });
			if (message["method"] === "thread/start") {
				proc.emit({ id, error: { code: -32000, message: "workspace rejected" } });
			}
		});
		const adapter = new CodexAdapter(VIRTUAL_REF, { spawn: () => proc });
		const requests = vi.fn();
		adapter.onRequest(requests);
		await expect(adapter.start({ cwd: "/workspace" })).rejects.toThrow("workspace rejected");

		proc.emit({ id: 10, method: "item/fileChange/requestApproval", params: {} });

		expect(requests).not.toHaveBeenCalled();
	});

	it("ignores synchronous process callbacks until client ownership is installed", async () => {
		const proc = new SynchronousRegistrationProcess();
		const adapter = new CodexAdapter(VIRTUAL_REF, { spawn: () => proc });
		const requests = vi.fn();
		adapter.onRequest(requests);

		await expect(adapter.start({ cwd: "/workspace" })).rejects.toThrow("registration-time exit");

		expect(adapter.getState()).toEqual({ messages: [], isStreaming: false, compaction: null });
		expect(requests).not.toHaveBeenCalled();
		expect(proc.killCount).toBe(1);
	});

	it("rejects resume when a hydration update listener disposes the adapter", async () => {
		const proc = new AdapterProcess();
		configureHappyServer(proc, {
			threadId: STORED_REF.id,
			turns: [
				{
					id: "turn-stored",
					items: [
						{
							type: "userMessage",
							id: "user-stored",
							clientId: null,
							content: [{ type: "text", text: "saved", text_elements: [] }],
						},
					],
					itemsView: "full",
					status: "completed",
					error: null,
					startedAt: 1,
					completedAt: 2,
					durationMs: 1000,
				},
			],
		});
		const adapter = new CodexAdapter(STORED_REF, { spawn: () => proc });
		let disposal: Promise<void> | undefined;
		adapter.onUpdate(() => {
			disposal = adapter.dispose();
		});

		await expect(
			adapter.start({ cwd: "/workspace", resumeId: STORED_REF.id }),
		).rejects.toThrow("codex adapter start aborted: disposed during startup");
		await disposal;

		expect(proc.killCount).toBe(1);
	});

	it("drops requests received before a failed start before a later retry", async () => {
		const failed = new AdapterProcess();
		failed.onWrite((message) => {
			const id = message["id"];
			if (typeof id !== "number") return;
			if (message["method"] === "initialize") failed.emit({ id, result: {} });
			if (message["method"] === "thread/start") {
				failed.emit({ id: 4, method: "item/fileChange/requestApproval", params: {} });
				failed.emit({ id, error: { code: -32000, message: "startup rejected" } });
			}
		});
		const replacement = new AdapterProcess();
		configureHappyServer(replacement, { threadId: "thread-replacement" });
		const processes = [failed, replacement];
		const adapter = new CodexAdapter(VIRTUAL_REF, {
			spawn: () => processes.shift() ?? replacement,
		});
		const requests: AgentRequest[] = [];
		adapter.onRequest((request) => requests.push(request));

		await expect(adapter.start({ cwd: "/workspace" })).rejects.toThrow("startup rejected");
		const staleExternalId = requests[0]?.requestId ?? "";
		await adapter.start({ cwd: "/workspace" });
		await adapter.reply(staleExternalId, { decision: "accept" });

		expect(responses(replacement)).toEqual([]);
	});
});

describe("CodexAdapter turns", () => {
	it("maps text and images into turn/start input", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-input" });

		await adapter.submit("describe this", [
			{ mimeType: "image/png", base64: "iVBORw0=" },
			{ mimeType: "image/jpeg", base64: "/9j/" },
		]);

		expect(request(proc, "turn/start")["params"]).toEqual({
			threadId: "thread-input",
			input: [
				{ type: "text", text: "describe this", text_elements: [] },
				{ type: "image", url: "data:image/png;base64,iVBORw0=" },
				{ type: "image", url: "data:image/jpeg;base64,/9j/" },
			],
			model: "gpt-started",
		});
	});

	it("interrupts the active turn returned by turn/start", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-abort" });
		await adapter.submit("begin");

		await adapter.abort();

		expect(request(proc, "turn/interrupt")["params"]).toEqual({
			threadId: "thread-abort",
			turnId: "turn-1",
		});
	});

	it("does not interrupt a completed turn", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-completed" });
		await adapter.submit("begin");
		proc.emit({
			method: "turn/completed",
			params: {
				threadId: "thread-completed",
				turn: {
					id: "turn-1",
					items: [],
					itemsView: "summary",
					status: "completed",
					error: null,
					startedAt: 1,
					completedAt: 2,
					durationMs: 1000,
				},
			},
		});

		await adapter.abort();

		expect(methods(proc)).not.toContain("turn/interrupt");
	});

	it("clears the completed turn before publishing its reducer update", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-completion-order" });
		await adapter.submit("begin");
		let abortFromCompletion: Promise<void> | undefined;
		adapter.onUpdate((state) => {
			if (!state.isStreaming) abortFromCompletion = adapter.abort();
		});
		proc.emit({
			method: "turn/started",
			params: {
				threadId: "thread-completion-order",
				turn: {
					id: "turn-1",
					items: [],
					itemsView: "notLoaded",
					status: "inProgress",
					error: null,
					startedAt: 1,
					completedAt: null,
					durationMs: null,
				},
			},
		});
		proc.emit({
			method: "turn/completed",
			params: {
				threadId: "thread-completion-order",
				turn: {
					id: "turn-1",
					items: [],
					itemsView: "summary",
					status: "completed",
					error: null,
					startedAt: 1,
					completedAt: 2,
					durationMs: 1000,
				},
			},
		});

		expect(abortFromCompletion).toBeDefined();
		await abortFromCompletion;

		expect(methods(proc)).not.toContain("turn/interrupt");
	});

	it("ignores lifecycle notifications for another thread", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-current" });
		await adapter.submit("begin");
		const activeTurn = {
			id: "turn-1",
			items: [],
			itemsView: "notLoaded",
			status: "inProgress",
			error: null,
			startedAt: 1,
			completedAt: null,
			durationMs: null,
		};
		proc.emit({
			method: "turn/started",
			params: { threadId: "thread-current", turn: activeTurn },
		});
		proc.emit({
			method: "turn/completed",
			params: {
				threadId: "thread-other",
				turn: {
					...activeTurn,
					id: "turn-other",
					itemsView: "summary",
					status: "completed",
					completedAt: 2,
					durationMs: 1000,
				},
			},
		});

		expect(adapter.getState().isStreaming).toBe(true);
		await adapter.abort();
		expect(request(proc, "turn/interrupt")["params"]).toEqual({
			threadId: "thread-current",
			turnId: "turn-1",
		});
	});

	it("rejects a submit while a turn is active without erasing its abort target", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-active-submit" });
		await adapter.submit("first");

		await expect(adapter.submit("second")).rejects.toThrow(
			"codex adapter cannot submit while a turn is active",
		);

		await adapter.abort();

		expect(methods(proc).filter((method) => method === "turn/start")).toHaveLength(1);
		expect(request(proc, "turn/interrupt")["params"]).toEqual({
			threadId: "thread-active-submit",
			turnId: "turn-1",
		});
	});

	it("compacts an idle thread via thread/compact/start with just the thread id (OW-72)", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-compact" });
		const updates: ("requesting" | "running" | null)[] = [];
		adapter.onUpdate((state) => updates.push(state.compaction));

		await adapter.compact();

		expect(request(proc, "thread/compact/start")["params"]).toEqual({ threadId: "thread-compact" });
		expect(updates).toEqual(["requesting"]);
	});

	it("clears requesting when app-server rejects compaction", async () => {
		const { adapter } = await startedAdapter({ threadId: "thread-compact-fail", failCompact: "no room" });
		const updates: ("requesting" | "running" | null)[] = [];
		adapter.onUpdate((state) => updates.push(state.compaction));
		await expect(adapter.compact()).rejects.toThrow("no room");
		expect(updates).toEqual(["requesting", null]);
	});

	it("refuses to compact while a turn is active, and sends nothing on the wire (OW-72)", async () => {
		// Codex runs compaction as its own non-steerable turn, so app-server
		// would reject a second turn anyway; the adapter's single-flight gate
		// turns that opaque wire error into a well-defined "busy". Same gate as
		// submit's, deliberately.
		const { adapter, proc } = await startedAdapter({ threadId: "thread-compact-busy" });
		await adapter.submit("begin");

		await expect(adapter.compact()).rejects.toThrow(
			"codex adapter cannot submit while a turn is active",
		);
		expect(methods(proc)).not.toContain("thread/compact/start");

		await adapter.abort(); // leave the fixture's turn tidily interrupted
	});

	it("compacts once the active turn has completed (OW-72)", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-compact-after" });
		await adapter.submit("begin");
		proc.emit({
			method: "turn/completed",
			params: {
				threadId: "thread-compact-after",
				turn: {
					id: "turn-1",
					items: [],
					itemsView: "summary",
					status: "completed",
					error: null,
					startedAt: 1,
					completedAt: 2,
					durationMs: 1000,
				},
			},
		});

		await adapter.compact();

		expect(request(proc, "thread/compact/start")["params"]).toEqual({
			threadId: "thread-compact-after",
		});
	});

	it("does not revive a turn completed in the same chunk as turn/start response", async () => {
		const proc = new AdapterProcess();
		proc.onWrite((message) => {
			const id = message["id"];
			if (typeof id !== "number") return;
			switch (message["method"]) {
				case "initialize":
					proc.emit({ id, result: {} });
					break;
				case "thread/start":
					proc.emit({
						id,
						result: {
							thread: { id: "thread-same-chunk", turns: [] },
							model: "gpt",
							modelProvider: "openai",
						},
					});
					break;
				case "turn/start": {
					const turn = {
						id: "turn-same-chunk",
						items: [],
						itemsView: "notLoaded",
						status: "inProgress",
						error: null,
						startedAt: 1,
						completedAt: null,
						durationMs: null,
					};
					proc.emit({ id, result: { turn } });
					proc.emit({
						method: "turn/started",
						params: { threadId: "thread-same-chunk", turn },
					});
					proc.emit({
						method: "turn/completed",
						params: {
							threadId: "thread-same-chunk",
							turn: {
								...turn,
								itemsView: "summary",
								status: "completed",
								completedAt: 2,
								durationMs: 1000,
							},
						},
					});
					break;
				}
				case "turn/interrupt":
					proc.emit({ id, result: {} });
					break;
			}
		});
		const adapter = new CodexAdapter(VIRTUAL_REF, { spawn: () => proc });
		await adapter.start({ cwd: "/workspace" });

		await adapter.submit("finish synchronously");
		await adapter.abort();

		expect(methods(proc)).not.toContain("turn/interrupt");
	});

	it("rejects a settled submit disposed by its completion update without reviving turn state", async () => {
		const { adapter, proc } = await startedAdapter({
			threadId: "thread-dispose-completion",
			holdTurnStart: true,
		});
		let disposal: Promise<void> | undefined;
		adapter.onUpdate((state) => {
			if (!state.isStreaming) disposal = adapter.dispose();
		});
		const submitting = adapter.submit("finish and dispose");
		const held = request(proc, "turn/start");
		const turn = {
			id: "turn-dispose-completion",
			items: [],
			itemsView: "notLoaded",
			status: "inProgress",
			error: null,
			startedAt: 1,
			completedAt: null,
			durationMs: null,
		};
		proc.emit({ id: held["id"], result: { turn } });
		proc.emit({
			method: "turn/started",
			params: { threadId: "thread-dispose-completion", turn },
		});
		proc.emit({
			method: "turn/completed",
			params: {
				threadId: "thread-dispose-completion",
				turn: {
					...turn,
					itemsView: "summary",
					status: "completed",
					completedAt: 2,
					durationMs: 1000,
				},
			},
		});

		await expect(submitting).rejects.toMatchObject({
			name: "Error",
			message: "codex adapter submit aborted: disposed during turn startup",
		});

		expect(disposal).toBeDefined();
		await disposal;
		expect(
			adapter as unknown as {
				turnId: string | null;
				turnStartPending: boolean;
				turnBusy: unknown;
				pendingTurnCompletions: Map<string, string>;
				pendingTurnCompletionOverflow: boolean;
			},
		).toMatchObject({
			turnId: null,
			turnStartPending: false,
			turnBusy: null,
			pendingTurnCompletionOverflow: false,
		});
		expect(
			(adapter as unknown as { pendingTurnCompletions: Map<string, string> })
				.pendingTurnCompletions.size,
		).toBe(0);
		expect(proc.killCount).toBe(1);
	});

	it("rejects an overlapping pending submit without mutating the first turn's tracking", async () => {
		const proc = new AdapterProcess();
		configureHappyServer(proc, { threadId: "thread-overlap", holdTurnStart: true });
		const adapter = new CodexAdapter(VIRTUAL_REF, { spawn: () => proc });
		await adapter.start({ cwd: "/workspace" });
		const first = adapter.submit("first held prompt");
		const firstRequest = request(proc, "turn/start");
		const secondRejected = expect(adapter.submit("second overlapping prompt")).rejects.toThrow(
			"codex adapter cannot submit while turn/start is pending",
		);
		const turn = {
			id: "turn-overlap-a",
			items: [],
			itemsView: "notLoaded",
			status: "inProgress",
			error: null,
			startedAt: 1,
			completedAt: null,
			durationMs: null,
		};
		proc.emit({
			method: "turn/started",
			params: { threadId: "thread-overlap", turn },
		});
		proc.emit({
			method: "turn/completed",
			params: {
				threadId: "thread-overlap",
				turn: {
					...turn,
					itemsView: "summary",
					status: "completed",
					completedAt: 2,
					durationMs: 1000,
				},
			},
		});
		proc.emit({ id: firstRequest["id"], result: { turn } });

		await first;
		await secondRejected;
		await adapter.abort();

		expect(methods(proc).filter((method) => method === "turn/start")).toHaveLength(1);
		expect(methods(proc)).not.toContain("turn/interrupt");
	});

	it("bounds held-start tracking without reviving the real turn after completion floods", async () => {
		const proc = new AdapterProcess();
		configureHappyServer(proc, { threadId: "thread-bounded", holdTurnStart: true });
		const adapter = new CodexAdapter(VIRTUAL_REF, { spawn: () => proc });
		await adapter.start({ cwd: "/workspace" });
		const submitting = adapter.submit("held prompt");
		const held = request(proc, "turn/start");
		const emitCompletion = (threadId: string, turnId: string): void => {
			proc.emit({
				method: "turn/completed",
				params: {
					threadId,
					turn: {
						id: turnId,
						items: [],
						itemsView: "summary",
						status: "completed",
						error: null,
						startedAt: 1,
						completedAt: 2,
						durationMs: 1000,
					},
				},
			});
		};

		for (let index = 0; index < 1000; index += 1) {
			emitCompletion("thread-unrelated", `turn-unrelated-${index}`);
			emitCompletion("thread-bounded", `turn-unmatched-${index}`);
		}
		const nonlocalTurn = {
			id: "turn-nonlocal",
			items: [],
			itemsView: "notLoaded",
			status: "inProgress",
			error: null,
			startedAt: 1,
			completedAt: null,
			durationMs: null,
		};
		proc.emit({
			method: "turn/started",
			params: { threadId: "thread-bounded", turn: nonlocalTurn },
		});
		emitCompletion("thread-bounded", nonlocalTurn.id);

		const turn = {
			id: "turn-held",
			items: [],
			itemsView: "notLoaded",
			status: "inProgress",
			error: null,
			startedAt: 1,
			completedAt: null,
			durationMs: null,
		};
		proc.emit({
			method: "turn/started",
			params: { threadId: "thread-bounded", turn },
		});
		emitCompletion("thread-bounded", turn.id);
		proc.emit({ id: held["id"], result: { turn } });
		const retainedTurnIds = (
			adapter as unknown as { pendingTurnCompletions: Map<string, string> }
		).pendingTurnCompletions.size;

		await submitting;
		await adapter.abort();

		expect(retainedTurnIds).toBeLessThanOrEqual(1);
		expect(methods(proc)).not.toContain("turn/interrupt");
	});

	it("does not adopt a mismatched response after the sole candidate completed", async () => {
		const proc = new AdapterProcess();
		configureHappyServer(proc, { threadId: "thread-steered", holdTurnStart: true });
		const adapter = new CodexAdapter(VIRTUAL_REF, { spawn: () => proc });
		await adapter.start({ cwd: "/workspace" });
		const submitting = adapter.submit("held prompt");
		const held = request(proc, "turn/start");
		const candidate = {
			id: "turn-active-candidate",
			items: [],
			itemsView: "notLoaded",
			status: "inProgress",
			error: null,
			startedAt: 1,
			completedAt: null,
			durationMs: null,
		};
		proc.emit({
			method: "turn/started",
			params: { threadId: "thread-steered", turn: candidate },
		});
		proc.emit({
			method: "turn/completed",
			params: {
				threadId: "thread-steered",
				turn: {
					...candidate,
					itemsView: "summary",
					status: "completed",
					completedAt: 2,
					durationMs: 1000,
				},
			},
		});
		proc.emit({ id: held["id"], result: { turn: { id: "turn-submission-id" } } });

		await submitting;
		await adapter.abort();

		expect(methods(proc)).not.toContain("turn/interrupt");
	});

	it("keeps an ambiguous successful submission busy until its response lifecycle completes", async () => {
		const proc = new AdapterProcess();
		configureHappyServer(proc, {
			threadId: "thread-ambiguous-response",
			holdTurnStartAt: 1,
		});
		const adapter = new CodexAdapter(VIRTUAL_REF, { spawn: () => proc });
		await adapter.start({ cwd: "/workspace" });
		const submitting = adapter.submit("held prompt");
		const held = request(proc, "turn/start");
		const candidate = {
			id: "turn-candidate",
			items: [],
			itemsView: "notLoaded",
			status: "inProgress",
			error: null,
			startedAt: 1,
			completedAt: null,
			durationMs: null,
		};
		const completed = (turn: typeof candidate) => ({
			...turn,
			itemsView: "summary",
			status: "completed",
			completedAt: 2,
			durationMs: 1000,
		});
		proc.emit({
			method: "turn/started",
			params: { threadId: "thread-ambiguous-response", turn: candidate },
		});
		proc.emit({
			method: "turn/completed",
			params: {
				threadId: "thread-ambiguous-response",
				turn: completed(candidate),
			},
		});
		const responseTurn = { ...candidate, id: "turn-response" };
		proc.emit({ id: held["id"], result: { turn: responseTurn } });

		await submitting;
		await adapter.abort();
		await expect(adapter.submit("must stay blocked")).rejects.toThrow(
			"codex adapter cannot submit while a turn is active",
		);
		expect(methods(proc)).not.toContain("turn/interrupt");
		expect(methods(proc).filter((method) => method === "turn/start")).toHaveLength(1);

		proc.emit({
			method: "turn/completed",
			params: {
				threadId: "thread-ambiguous-response",
				turn: completed(candidate),
			},
		});
		await expect(adapter.submit("stale completion must not unblock")).rejects.toThrow(
			"codex adapter cannot submit while a turn is active",
		);

		proc.emit({
			method: "turn/started",
			params: { threadId: "thread-ambiguous-response", turn: responseTurn },
		});
		proc.emit({
			method: "turn/completed",
			params: {
				threadId: "thread-ambiguous-response",
				turn: completed(responseTurn),
			},
		});
		await adapter.submit("allowed after correlated completion");

		expect(methods(proc).filter((method) => method === "turn/start")).toHaveLength(2);
	});

	it("observes response lifecycle completion before the submit continuation resumes", async () => {
		const { adapter, proc } = await startedAdapter({
			threadId: "thread-response-completed",
			holdTurnStartAt: 1,
		});
		const submitting = adapter.submit("held prompt");
		const held = request(proc, "turn/start");
		const inProgressTurn = (id: string) => ({
			id,
			items: [],
			itemsView: "notLoaded",
			status: "inProgress",
			error: null,
			startedAt: 1,
			completedAt: null,
			durationMs: null,
		});
		const emitCompleted = (turn: ReturnType<typeof inProgressTurn>): void => {
			proc.emit({
				method: "turn/completed",
				params: {
					threadId: "thread-response-completed",
					turn: {
						...turn,
						itemsView: "summary",
						status: "completed",
						completedAt: 2,
						durationMs: 1000,
					},
				},
			});
		};
		const candidate = inProgressTurn("turn-candidate-before-response");
		proc.emit({
			method: "turn/started",
			params: { threadId: "thread-response-completed", turn: candidate },
		});
		emitCompleted(candidate);
		const responseTurn = inProgressTurn("turn-response-completed");
		proc.emit({ id: held["id"], result: { turn: responseTurn } });
		proc.emit({
			method: "turn/started",
			params: { threadId: "thread-response-completed", turn: responseTurn },
		});
		emitCompleted(responseTurn);

		await submitting;
		await adapter.abort();
		await adapter.submit("allowed after synchronous completion");

		expect(methods(proc)).not.toContain("turn/interrupt");
		expect(methods(proc).filter((method) => method === "turn/start")).toHaveLength(2);
	});

	it("does not revive a retained candidate after a newer turn completed", async () => {
		const proc = new AdapterProcess();
		configureHappyServer(proc, { threadId: "thread-superseded", holdTurnStart: true });
		const adapter = new CodexAdapter(VIRTUAL_REF, { spawn: () => proc });
		await adapter.start({ cwd: "/workspace" });
		const submitting = adapter.submit("held prompt");
		const held = request(proc, "turn/start");
		const inProgressTurn = (id: string) => ({
			id,
			items: [],
			itemsView: "notLoaded",
			status: "inProgress",
			error: null,
			startedAt: 1,
			completedAt: null,
			durationMs: null,
		});
		const retainedTurn = inProgressTurn("turn-retained");
		const newerTurn = inProgressTurn("turn-newer");
		for (const turn of [retainedTurn, newerTurn]) {
			proc.emit({
				method: "turn/started",
				params: { threadId: "thread-superseded", turn },
			});
		}
		proc.emit({
			method: "turn/completed",
			params: {
				threadId: "thread-superseded",
				turn: {
					...newerTurn,
					itemsView: "summary",
					status: "completed",
					completedAt: 2,
					durationMs: 1000,
				},
			},
		});
		proc.emit({ id: held["id"], result: { turn: retainedTurn } });

		await submitting;
		await adapter.abort();

		expect(methods(proc)).not.toContain("turn/interrupt");
	});

	it("keeps a matching started turn active after bounded candidate overflow", async () => {
		const proc = new AdapterProcess();
		configureHappyServer(proc, { threadId: "thread-overflow-active", holdTurnStart: true });
		const adapter = new CodexAdapter(VIRTUAL_REF, { spawn: () => proc });
		await adapter.start({ cwd: "/workspace" });
		const submitting = adapter.submit("held prompt");
		const held = request(proc, "turn/start");
		const inProgressTurn = (id: string) => ({
			id,
			items: [],
			itemsView: "notLoaded",
			status: "inProgress",
			error: null,
			startedAt: 1,
			completedAt: null,
			durationMs: null,
		});
		proc.emit({
			method: "turn/started",
			params: {
				threadId: "thread-overflow-active",
				turn: inProgressTurn("turn-nonlocal"),
			},
		});
		const realTurn = inProgressTurn("turn-real");
		proc.emit({
			method: "turn/started",
			params: { threadId: "thread-overflow-active", turn: realTurn },
		});
		proc.emit({ id: held["id"], result: { turn: realTurn } });

		await submitting;
		await adapter.abort();

		expect(request(proc, "turn/interrupt")["params"]).toEqual({
			threadId: "thread-overflow-active",
			turnId: "turn-real",
		});
	});

	it("does not retain completion ids received without a pending turn start", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-idle-completions" });

		for (let index = 0; index < 100; index += 1) {
			proc.emit({
				method: "turn/completed",
				params: {
					threadId: "thread-idle-completions",
					turn: {
						id: `turn-idle-${index}`,
						items: [],
						itemsView: "summary",
						status: "completed",
						error: null,
						startedAt: 1,
						completedAt: 2,
						durationMs: 1000,
					},
				},
			});
		}

		expect(
			(adapter as unknown as { pendingTurnCompletions: Map<string, string> })
				.pendingTurnCompletions.size,
		).toBe(0);
	});

	it("applies a selected model to subsequent turns", async () => {
		const { adapter, proc } = await startedAdapter();

		await adapter.setModel("gpt-selected");
		await adapter.submit("use it");

		expect(request(proc, "turn/start")["params"]).toMatchObject({ model: "gpt-selected" });
	});
});

describe("CodexAdapter reducer effects", () => {
	it("publishes streaming and message changes with the reducer's changed index", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-events" });
		const updates = vi.fn();
		adapter.onUpdate(updates);

		proc.emit({
			method: "turn/started",
			params: {
				threadId: "thread-events",
				turn: {
					id: "turn-live",
					items: [],
					itemsView: "notLoaded",
					status: "inProgress",
					error: null,
					startedAt: 1,
					completedAt: null,
					durationMs: null,
				},
			},
		});
		proc.emit({
			method: "item/started",
			params: {
				threadId: "thread-events",
				turnId: "turn-live",
				item: {
					type: "agentMessage",
					id: "message-live",
					text: "",
					phase: null,
					memoryCitation: null,
				},
				startedAtMs: 10,
			},
		});

		expect(updates).toHaveBeenNthCalledWith(1, { messages: [], isStreaming: true, compaction: null }, undefined);
		expect(updates).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ isStreaming: true, messages: [expect.objectContaining({ role: "assistant" })] }),
			0,
		);
	});

	it("publishes blocking requests with the adopted session ref", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-requests" });
		const requests = vi.fn();
		adapter.onRequest(requests);

		proc.emit({
			id: 17,
			method: "item/fileChange/requestApproval",
			params: { threadId: "thread-requests", turnId: "turn-1", itemId: "edit-1" },
		});

		expect(requests).toHaveBeenCalledWith({
			requestId: expect.not.stringMatching(/^17$/),
			session: { backend: "codex", id: "thread-requests" },
			kind: "item/fileChange/requestApproval",
			payload: { threadId: "thread-requests", turnId: "turn-1", itemId: "edit-1" },
		});
	});

	it("publishes reducer errors", async () => {
		const { adapter, proc } = await startedAdapter();
		const errors = vi.fn();
		adapter.onError(errors);

		proc.emit({ method: "error", params: { error: { message: "turn failed" } } });

		expect(errors).toHaveBeenCalledWith("turn failed");
	});
});

describe("CodexAdapter request replies", () => {
	it("uses a distinct request namespace for a later adapter lifetime of the same thread", async () => {
		const first = await startedAdapter({ threadId: "thread-reopened" });
		const second = await startedAdapter({ threadId: "thread-reopened" });
		const firstRequests: AgentRequest[] = [];
		const secondRequests: AgentRequest[] = [];
		first.adapter.onRequest((request) => firstRequests.push(request));
		second.adapter.onRequest((request) => secondRequests.push(request));

		first.proc.emit({ id: 0, method: "item/fileChange/requestApproval", params: {} });
		second.proc.emit({ id: 0, method: "item/fileChange/requestApproval", params: {} });

		expect(firstRequests[0]?.requestId).not.toBe(secondRequests[0]?.requestId);
	});

	it("resolves a pre-adoption request through its typed reverse mapping", async () => {
		const proc = new AdapterProcess();
		proc.onWrite((message) => {
			const id = message["id"];
			if (typeof id !== "number") return;
			if (message["method"] === "initialize") proc.emit({ id, result: {} });
			if (message["method"] === "thread/start") {
				proc.emit({ id: 0, method: "item/fileChange/requestApproval", params: {} });
				proc.emit({
					id,
					result: {
						thread: { id: "thread-adopted-after-request", turns: [] },
						model: "gpt",
						modelProvider: "openai",
					},
				});
			}
		});
		const adapter = new CodexAdapter(VIRTUAL_REF, { spawn: () => proc });
		const requests: AgentRequest[] = [];
		adapter.onRequest((request) => requests.push(request));

		await adapter.start({ cwd: "/workspace" });
		proc.emit({ method: "serverRequest/resolved", params: { requestId: 0 } });
		await adapter.reply(requests[0]?.requestId ?? "", { decision: "accept" });

		expect(responses(proc)).toEqual([]);
	});

	it("scopes equal wire request ids to their adapter sessions", async () => {
		const first = await startedAdapter({ threadId: "thread-first" });
		const second = await startedAdapter({ threadId: "thread-second" });
		const firstRequests: AgentRequest[] = [];
		const secondRequests: AgentRequest[] = [];
		first.adapter.onRequest((request) => firstRequests.push(request));
		second.adapter.onRequest((request) => secondRequests.push(request));

		first.proc.emit({ id: 0, method: "item/fileChange/requestApproval", params: {} });
		second.proc.emit({ id: 0, method: "item/fileChange/requestApproval", params: {} });
		const firstId = firstRequests[0]?.requestId ?? "";
		const secondId = secondRequests[0]?.requestId ?? "";

		expect(firstId).not.toBe(secondId);
		await first.adapter.reply(firstId, { decision: "accept" });
		expect(responses(first.proc)).toEqual([{ id: 0, result: { decision: "accept" } }]);
		expect(responses(second.proc)).toEqual([]);
		await second.adapter.reply(secondId, { decision: "decline" });
		expect(responses(second.proc)).toEqual([{ id: 0, result: { decision: "decline" } }]);
	});

	it("distinguishes numeric and string wire request ids", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-typed-ids" });
		const requests: AgentRequest[] = [];
		adapter.onRequest((request) => requests.push(request));

		proc.emit({ id: 0, method: "item/fileChange/requestApproval", params: {} });
		proc.emit({ id: "0", method: "item/fileChange/requestApproval", params: {} });
		const numericId = requests[0]?.requestId ?? "";
		const stringId = requests[1]?.requestId ?? "";

		expect(numericId).not.toBe(stringId);
		await adapter.reply(numericId, { decision: "numeric" });
		await adapter.reply(stringId, { decision: "string" });
		expect(responses(proc)).toEqual([
			{ id: 0, result: { decision: "numeric" } },
			{ id: "0", result: { decision: "string" } },
		]);
	});

	it("correlates replies to the original numeric request id", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-correlate" });
		const requests: AgentRequest[] = [];
		adapter.onRequest((request) => requests.push(request));
		proc.emit({ id: 23, method: "item/fileChange/requestApproval", params: { itemId: "edit-1" } });

		await adapter.reply(requests[0]?.requestId ?? "", { decision: "accept" });

		expect(proc.written.at(-1)).toEqual({ id: 23, result: { decision: "accept" } });
	});

	it("declines approvals with their protocol response shape", async () => {
		const { adapter, proc } = await startedAdapter();
		const requests: AgentRequest[] = [];
		adapter.onRequest((request) => requests.push(request));
		proc.emit({ id: "approval-1", method: "item/fileChange/requestApproval", params: {} });

		await adapter.reply(requests[0]?.requestId ?? "", null);

		expect(proc.written.at(-1)).toEqual({ id: "approval-1", result: { decision: "decline" } });
	});

	it("declines MCP elicitations with their generated protocol response shape", async () => {
		const { adapter, proc } = await startedAdapter();
		const requests: AgentRequest[] = [];
		adapter.onRequest((request) => requests.push(request));
		proc.emit({ id: "elicitation-1", method: "mcpServer/elicitation/request", params: {} });

		await adapter.reply(requests[0]?.requestId ?? "", null);

		expect(proc.written.at(-1)).toEqual({
			id: "elicitation-1",
			result: { action: "decline", content: null, _meta: null },
		});
	});
});

describe("CodexAdapterFactory", () => {
	it("creates only Codex adapters without spawning them", () => {
		const spawn = vi.fn(() => new AdapterProcess());
		const factory = new CodexAdapterFactory({ spawn });

		expect(factory.create(VIRTUAL_REF)).toBeInstanceOf(CodexAdapter);
		expect(spawn).not.toHaveBeenCalled();
		expect(() => factory.create({ backend: "pi", id: "pi-session" })).toThrow(
			'CodexAdapterFactory cannot create a "pi" adapter',
		);
	});
});
