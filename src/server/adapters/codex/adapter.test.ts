import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRequest, SessionRef } from "../../../shared/protocol.ts";
import { CodexAdapter, CodexAdapterFactory, type CodexAdapterOptions } from "./index.ts";
import type { CodexProcess } from "./process.ts";
import { FakeCodexProcess } from "./test-support.ts";

const VIRTUAL_REF: SessionRef = { backend: "codex", id: "virtual:test" };
const STORED_REF: SessionRef = { backend: "codex", id: "thread-stored" };

/**
 * A rollout store with nothing in it, so a resume's read of its last turn
 * (D23) never reaches the real `~/.codex/sessions`.
 */
const NO_STORE = join(tmpdir(), "agentpane-codex-no-store");

type WireMessage = Record<string, unknown>;

/** A throwaway rollout store holding one file per thread, each line written as given. */
async function rolloutStore(threads: Record<string, unknown[]>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "agentpane-codex-store-"));
	const day = join(root, "2026", "09", "23");
	await mkdir(day, { recursive: true });
	for (const [threadId, lines] of Object.entries(threads)) {
		const body = lines.map((line) => JSON.stringify(line)).join("\n");
		await writeFile(join(day, `rollout-2026-09-23T00-00-00-${threadId}.jsonl`), `${body}\n`);
	}
	return root;
}

/** The fields of a stored `turn_context` record the adapter reads, as `codex-cli` 0.156.0 writes them. */
function turnContext(turnId: string, model: string, effort: string): unknown {
	return { timestamp: "2026-09-23T00:00:01.000Z", type: "turn_context", payload: { turn_id: turnId, model, effort } };
}

function eventMsg(type: string, turnId: string): unknown {
	return { timestamp: "2026-09-23T00:00:02.000Z", type: "event_msg", payload: { type, turn_id: turnId } };
}

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
	reasoningEffort?: string;
	/** `model/list`'s `data`, answered in one page. */
	models?: unknown[];
	holdTurnStart?: boolean;
	holdTurnStartAt?: number;
	holdThreadStart?: boolean;
	failCompact?: string;
	failSteer?: string;
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
						reasoningEffort: options.reasoningEffort ?? null,
					},
				});
				break;
			case "model/list":
				proc.emit({ id, result: { data: options.models ?? [], nextCursor: null } });
				break;
			case "turn/start":
				turn += 1;
				if (!options.holdTurnStart && options.holdTurnStartAt !== turn) {
					proc.emit({ id, result: { turn: { id: `turn-${turn}` } } });
				}
				break;
			case "thread/read":
				proc.emit({ id, result: { thread: { id: options.threadId ?? "thread-real", turns: options.turns ?? [] } } });
				break;
			case "thread/fork":
				proc.emit({ id, result: { thread: { id: "thread-forked", turns: [] } } });
				break;
			case "turn/steer": {
				// OW-tifuha, codex-cli 0.154.0: the result names the steered turn.
				const params = message["params"] as { expectedTurnId?: string } | undefined;
				if (options.failSteer) proc.emit({ id, error: { code: -32603, message: options.failSteer } });
				else proc.emit({ id, result: { turnId: params?.expectedTurnId } });
				break;
			}
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
	const adapter = new CodexAdapter(ref, { codexRoot: NO_STORE, ...options, spawn: () => proc });
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
			approvalPolicy: "never",
		});
		expect(adapter.getState().model).toBe("gpt-started");
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
		const adapter = new CodexAdapter(STORED_REF, { spawn: () => proc, codexRoot: NO_STORE });
		const updates = vi.fn();
		adapter.onUpdate(updates);

		await adapter.start({ cwd: "/workspace", resumeId: STORED_REF.id });

		expect(methods(proc)).toEqual(["initialize", "thread/resume"]);
		expect(request(proc, "thread/resume")["params"]).toEqual({
			threadId: STORED_REF.id,
			cwd: "/workspace",
			sandbox: "danger-full-access",
			approvalPolicy: "never",
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

	it("carries both policies onto the forked thread", async () => {
		// A fork is a thread-creation path like start and resume, and Codex does
		// not inherit the parent's policies onto it (D7a).
		const { adapter, proc } = await startedAdapter(
			{
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
						],
						itemsView: "full",
						status: "completed",
						error: null,
						startedAt: 1_700_000_000,
						completedAt: 1_700_000_001,
						durationMs: 1000,
					},
				],
			},
			STORED_REF,
		);

		const forked = await adapter.fork("turn-stored");

		// Codex has already flushed the forked thread, but only this app-server
		// may open it, so `fork()` hands over the adapter that will drive it
		// along with the resume to start it as (OW-lajehi).
		expect(forked.ref).toEqual({ backend: "codex", id: "thread-forked" });
		expect(forked.start).toEqual({ cwd: "/workspace", resumeId: "thread-forked" });
		expect(forked.adapter).toBeDefined();
		expect(request(proc, "thread/fork")["params"]).toEqual({
			threadId: STORED_REF.id,
			cwd: "/workspace",
			sandbox: "danger-full-access",
			approvalPolicy: "never",
		});
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

		expect(adapter.getState()).toEqual({ messages: [], isStreaming: false, compaction: null, model: "gpt-started", effort: null });
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

		expect(adapter.getState()).toEqual({ messages: [], isStreaming: false, compaction: null, model: null, effort: null });
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
		const adapter = new CodexAdapter(STORED_REF, { spawn: () => proc, codexRoot: NO_STORE });
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

	it("steers a submit into the active turn instead of starting a second one (OW-tifuha)", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-steer" });
		await adapter.submit("first");

		await adapter.submit("second");

		expect(request(proc, "turn/steer")["params"]).toEqual({
			threadId: "thread-steer",
			input: [{ type: "text", text: "second", text_elements: [] }],
			expectedTurnId: "turn-1",
		});
		expect(methods(proc).filter((method) => method === "turn/start")).toHaveLength(1);

		await adapter.abort(); // leave the fixture's turn tidily interrupted
	});

	it("frames a rejected steer with the adapter and the turn id it sent (OW-gemawu)", async () => {
		const { adapter } = await startedAdapter({
			threadId: "thread-steer-fail",
			failSteer: "expectedTurnId does not match the active turn",
		});
		await adapter.submit("first");

		await expect(adapter.submit("second")).rejects.toThrow(
			"codex adapter turn/steer rejected (expectedTurnId turn-1): expectedTurnId does not match the active turn",
		);
	});

	it("keeps its abort target across a mid-turn steer", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-active-submit" });
		await adapter.submit("first");
		await adapter.submit("second");

		await adapter.abort();

		expect(methods(proc).filter((method) => method === "turn/start")).toHaveLength(1);
		expect(request(proc, "turn/interrupt")["params"]).toEqual({
			threadId: "thread-active-submit",
			turnId: "turn-1",
		});
	});

	it("refuses to steer a compaction turn, and sends nothing on the wire (OW-tifuha)", async () => {
		// `compact` is one of the two `NonSteerableTurnKind`s, and a compaction
		// runs as its own turn (`resources/fixtures/codex/compact.jsonl`: a
		// `turn/started` brackets the `contextCompaction` item), so the adapter
		// holds a `turnId` naming a turn app-server will refuse to steer. Steering
		// it would turn a well-defined "busy" into an opaque wire error -- exactly
		// what `compact`'s own guard exists to prevent.
		const { adapter, proc } = await startedAdapter({ threadId: "thread-compaction-turn" });
		proc.emit({
			method: "turn/started",
			params: {
				threadId: "thread-compaction-turn",
				turn: {
					id: "turn-compaction",
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
				threadId: "thread-compaction-turn",
				item: { type: "contextCompaction", id: "item-compaction" },
			},
		});

		await expect(adapter.submit("steer the compaction")).rejects.toThrow(
			"codex adapter cannot submit while a turn is active",
		);
		expect(methods(proc)).not.toContain("turn/steer");
	});

	it("refuses to steer a turn it has already interrupted, and sends nothing on the wire (OW-pefawi)", async () => {
		// `abort()` returns once `turn/interrupt` resolves, but `turnId` is only
		// cleared by `turn/completed`, which arrives later. A submit in that window
		// would steer a turn app-server is tearing down, and `expectedTurnId` is a
		// precondition against the currently active turn -- so the caller would get
		// an opaque wire error where the adapter can say "busy" itself.
		const { adapter, proc } = await startedAdapter({ threadId: "thread-interrupted" });
		await adapter.submit("first");
		await adapter.abort();
		expect(request(proc, "turn/interrupt")["params"]).toEqual({
			threadId: "thread-interrupted",
			turnId: "turn-1",
		});

		await expect(adapter.submit("second")).rejects.toThrow(
			"codex adapter cannot submit while an interrupted turn is ending",
		);
		expect(methods(proc)).not.toContain("turn/steer");
		expect(methods(proc).filter((method) => method === "turn/start")).toHaveLength(1);
	});

	it("admits a submit once the interrupted turn completes (OW-pefawi)", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-interrupt-done" });
		await adapter.submit("first");
		await adapter.abort();
		proc.emit({
			method: "turn/completed",
			params: {
				threadId: "thread-interrupt-done",
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

		await adapter.submit("second");

		expect(methods(proc).filter((method) => method === "turn/start")).toHaveLength(2);
		expect(methods(proc)).not.toContain("turn/steer");

		await adapter.abort(); // leave the fixture's turn tidily interrupted
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

	it("cannot steer an ambiguous submission, and stays blocked until its response lifecycle completes", async () => {
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
		// The mismatched candidate left no lifecycle-corroborated `turnId`, so
		// there is no `expectedTurnId` to steer with (OW-tifuha) and the
		// submission that is nonetheless still in flight keeps this blocked.
		await expect(adapter.submit("must stay blocked")).rejects.toThrow(
			"codex adapter cannot submit while a turn is active",
		);
		expect(methods(proc)).not.toContain("turn/interrupt");
		expect(methods(proc)).not.toContain("turn/steer");
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
		expect(methods(proc)).not.toContain("turn/steer");

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
		expect(adapter.getState().model).toBe("gpt-selected");
		await adapter.submit("use it");

		expect(request(proc, "turn/start")["params"]).toMatchObject({ model: "gpt-selected" });
	});

	it("sends no effort until one is chosen, and reports the thread's own meanwhile", async () => {
		const { adapter, proc } = await startedAdapter({ reasoningEffort: "medium" });

		expect(adapter.getState().effort).toBe("medium");
		await adapter.submit("go");

		expect(request(proc, "turn/start")["params"]).not.toHaveProperty("effort");
	});

	it("applies a chosen effort to subsequent turns (OW-kokalo)", async () => {
		const { adapter, proc } = await startedAdapter({ reasoningEffort: "medium" });
		const updates = vi.fn();
		adapter.onUpdate(updates);

		await adapter.setEffort("low");
		expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({ effort: "low" }), undefined);
		await adapter.submit("use it");

		expect(request(proc, "turn/start")["params"]).toMatchObject({ effort: "low" });
	});

	it("names the chosen effort on the turn it ran, not the one the thread started at (OW-kokalo)", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-effort", reasoningEffort: "medium" });

		await adapter.setEffort("low");
		await adapter.submit("go");
		proc.emit({
			method: "item/completed",
			params: {
				threadId: "thread-effort",
				turnId: "turn-1",
				item: { type: "agentMessage", id: "answer", text: "ok", phase: "final_answer", memoryCitation: null },
				completedAtMs: 10,
			},
		});

		const [answer] = adapter.getState().messages;
		expect(answer).toMatchObject({ role: "assistant", effort: "low" });
	});

	it("resumes at the effort the rollout's last turn ran at, not the one the resume reports (D23)", async () => {
		// As of `codex-cli` 0.156.0 a resume naming no model restores the model
		// itself, but answers whatever effort the thread's settings last held,
		// which a resume naming a model resets to the config's without a turn
		// (docs/MANUAL_TESTING.md, OW-sayaju). So the effort is re-asserted.
		const codexRoot = await rolloutStore({
			[STORED_REF.id]: [
				{ type: "session_meta", payload: { id: STORED_REF.id } },
				turnContext("turn-1", "gpt-stored", "high"),
				eventMsg("task_complete", "turn-1"),
				turnContext("turn-2", "gpt-stored", "low"),
				eventMsg("task_complete", "turn-2"),
			],
		});
		try {
			const { adapter, proc } = await startedAdapter(
				{ threadId: STORED_REF.id, model: "gpt-stored", reasoningEffort: "high", codexRoot },
				STORED_REF,
			);

			expect(adapter.getState().effort).toBe("low");
			await adapter.submit("go");

			expect(request(proc, "turn/start")["params"]).toMatchObject({ effort: "low" });
		} finally {
			await rm(codexRoot, { recursive: true, force: true });
		}
	});

	it("falls back to the new model's default when it does not list the chosen effort", async () => {
		const { adapter, proc } = await startedAdapter({
			models: [
				codexModel("gpt-wide", ["low", "medium", "max"], "medium"),
				codexModel("gpt-narrow", ["low", "high"], "high"),
			],
		});

		await adapter.setEffort("max");
		await adapter.setModel("gpt-wide");
		expect(adapter.getState().effort).toBe("max");
		await adapter.setModel("gpt-narrow");
		expect(adapter.getState().effort).toBe("high");
		await adapter.submit("go");

		expect(request(proc, "turn/start")["params"]).toMatchObject({ model: "gpt-narrow", effort: "high" });
	});

	it("lists each model's efforts and default", async () => {
		const { adapter } = await startedAdapter({ models: [codexModel("gpt-wide", ["low", "max"], "low")] });

		expect(await adapter.listModels()).toEqual([
			{
				id: "gpt-wide",
				label: "gpt-wide display",
				efforts: [
					{ id: "low", description: "low effort" },
					{ id: "max", description: "max effort" },
				],
				defaultEffort: "low",
			},
		]);
	});
});

/** The fields of a `model/list` entry (`v2/Model.ts`) the adapter reads. */
function codexModel(id: string, efforts: string[], defaultEffort: string): Record<string, unknown> {
	return {
		id,
		model: id,
		displayName: `${id} display`,
		supportedReasoningEfforts: efforts.map((effort) => ({ reasoningEffort: effort, description: `${effort} effort` })),
		defaultReasoningEffort: defaultEffort,
	};
}

describe("CodexAdapter fork points", () => {
	/**
	 * Codex forks at turn granularity, so a turn answers with exactly one point
	 * however many user messages it holds -- and steering puts a second one in
	 * (D16, OW-tifuha). The point names the *first* user message's transcript
	 * index, and the steered message at index 2 is named by nothing, which is
	 * what makes the UI decline to offer an Edit there rather than fork one turn
	 * further on (OW-roveze).
	 */
	it("names the first user message's transcript index, and no point for a steered one (OW-roveze)", async () => {
		const proc = new AdapterProcess();
		configureHappyServer(proc, {
			threadId: STORED_REF.id,
			turns: [
				{
					id: "turn-steered",
					items: [
						{
							type: "userMessage",
							id: "user-a",
							clientId: null,
							content: [{ type: "text", text: "first ask", text_elements: [] }],
						},
						{ type: "agentMessage", id: "agent-a", text: "part one", phase: "final_answer", memoryCitation: null },
						{
							type: "userMessage",
							id: "user-steer",
							clientId: null,
							content: [{ type: "text", text: "also this", text_elements: [] }],
						},
						{ type: "agentMessage", id: "agent-b", text: "part two", phase: "final_answer", memoryCitation: null },
					],
					itemsView: "full",
					status: "completed",
					error: null,
					startedAt: 1_700_000_000,
					completedAt: 1_700_000_001,
					durationMs: 1000,
				},
				{
					id: "turn-next",
					items: [
						{
							type: "userMessage",
							id: "user-b",
							clientId: null,
							content: [{ type: "text", text: "second ask", text_elements: [] }],
						},
						{ type: "agentMessage", id: "agent-c", text: "an answer", phase: "final_answer", memoryCitation: null },
					],
					itemsView: "full",
					status: "completed",
					error: null,
					startedAt: 1_700_000_002,
					completedAt: 1_700_000_003,
					durationMs: 1000,
				},
			],
		});
		const adapter = new CodexAdapter(STORED_REF, { spawn: () => proc, codexRoot: NO_STORE });
		await adapter.start({ cwd: "/workspace", resumeId: STORED_REF.id });

		// Six items, six messages: the steered prompt is a transcript message of
		// its own, and it is index 2.
		expect(adapter.getState().messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(await adapter.listForkPoints()).toEqual([
			{ id: "turn-steered", text: "first ask", index: 0 },
			{ id: "turn-next", text: "second ask", index: 4 },
		]);
	});

	/**
	 * The index is the reducer's, not a count of `turn.items`: a reasoning item
	 * with nothing to show maps to no message at all, so counting items would
	 * put the second turn's point one past where its prompt actually sits.
	 */
	it("takes the index from the reducer, so items that map to nothing do not shift it (OW-roveze)", async () => {
		const proc = new AdapterProcess();
		configureHappyServer(proc, {
			threadId: STORED_REF.id,
			turns: [
				{
					id: "turn-one",
					items: [
						{
							type: "userMessage",
							id: "user-a",
							clientId: null,
							content: [{ type: "text", text: "first ask", text_elements: [] }],
						},
						{ type: "reasoning", id: "reason-a", summary: [], content: [] },
						{ type: "agentMessage", id: "agent-a", text: "an answer", phase: "final_answer", memoryCitation: null },
					],
					itemsView: "full",
					status: "completed",
					error: null,
					startedAt: 1_700_000_000,
					completedAt: 1_700_000_001,
					durationMs: 1000,
				},
				{
					id: "turn-two",
					items: [
						{
							type: "userMessage",
							id: "user-b",
							clientId: null,
							content: [{ type: "text", text: "second ask", text_elements: [] }],
						},
						{ type: "agentMessage", id: "agent-b", text: "another", phase: "final_answer", memoryCitation: null },
					],
					itemsView: "full",
					status: "completed",
					error: null,
					startedAt: 1_700_000_002,
					completedAt: 1_700_000_003,
					durationMs: 1000,
				},
			],
		});
		const adapter = new CodexAdapter(STORED_REF, { spawn: () => proc, codexRoot: NO_STORE });
		await adapter.start({ cwd: "/workspace", resumeId: STORED_REF.id });

		expect(adapter.getState().messages).toHaveLength(4);
		expect(await adapter.listForkPoints()).toEqual([
			{ id: "turn-one", text: "first ask", index: 0 },
			{ id: "turn-two", text: "second ask", index: 2 },
		]);
	});
});

describe("CodexAdapter reducer effects", () => {
	it("binds reduction to the thread returned by thread/start", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-parent" });
		const updates = vi.fn();
		adapter.onUpdate(updates);

		proc.emit({
			method: "thread/started",
			params: { thread: { id: "thread-child" } },
		});
		proc.emit({
			method: "item/started",
			params: {
				threadId: "thread-child",
				turnId: "turn-child",
				item: {
					type: "agentMessage",
					id: "message-child",
					text: "",
					phase: null,
					memoryCitation: null,
				},
				startedAtMs: 10,
			},
		});

		expect(updates).not.toHaveBeenCalled();
		expect(adapter.getState().messages).toEqual([]);
	});

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

		expect(updates).toHaveBeenNthCalledWith(1, { messages: [], isStreaming: true, compaction: null, model: "gpt-started", effort: null }, undefined);
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

	it("answers a request kind it has no handler for and names it in an error (OW-nujawi)", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-unknown" });
		const requests = vi.fn();
		const errors: string[] = [];
		adapter.onRequest(requests);
		adapter.onError((message) => errors.push(message));

		proc.emit({ id: 31, method: "workspace/trust/request", params: { threadId: "thread-unknown" } });

		expect(responses(proc)).toEqual([
			{ id: 31, error: { code: -32601, message: expect.stringContaining("workspace/trust/request") } },
		]);
		expect(errors).toEqual([expect.stringContaining("workspace/trust/request")]);
		expect(requests).not.toHaveBeenCalled();
	});

	it("identifies a child-thread blocking request and routes it through the parent (OW-futewo)", async () => {
		const parentThreadId = "parent-thread";
		const childThreadId = "child-thread";
		const { adapter, proc } = await startedAdapter({ threadId: parentThreadId });
		const requests: AgentRequest[] = [];
		adapter.onRequest((request) => requests.push(request));

		proc.emit({
			id: "child-approval-1",
			method: "item/commandExecution/requestApproval",
			params: {
				threadId: childThreadId,
				turnId: "turn-1",
				itemId: "item-1",
				startedAtMs: 1000,
				command: "echo test",
			},
		});

		expect(requests).toHaveLength(1);
		const request = requests[0];
		expect(request?.issuerThreadId).toBe(childThreadId);
		expect(request?.session.id).toBe(parentThreadId);
		expect(request?.kind).toBe("item/commandExecution/requestApproval");

		// Verify the request stays pending and replyable through the parent adapter
		await adapter.reply(request?.requestId ?? "", { decision: "accept" });

		expect(responses(proc)).toEqual([
			{ id: "child-approval-1", result: { decision: "accept" } },
		]);
	});

	it("does not set issuerThreadId for a same-thread blocking request (OW-futewo)", async () => {
		const threadId = "same-thread";
		const { adapter, proc } = await startedAdapter({ threadId });
		const requests: AgentRequest[] = [];
		adapter.onRequest((request) => requests.push(request));

		proc.emit({
			id: "same-approval-1",
			method: "item/fileChange/requestApproval",
			params: {
				threadId,
				turnId: "turn-1",
				itemId: "item-1",
			},
		});

		expect(requests).toHaveLength(1);
		const request = requests[0];
		expect(request?.issuerThreadId).toBeUndefined();
		expect(request?.session.id).toBe(threadId);

		// Verify it's still replyable
		await adapter.reply(request?.requestId ?? "", { decision: "accept" });

		expect(responses(proc)).toEqual([
			{ id: "same-approval-1", result: { decision: "accept" } },
		]);
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

describe("CodexAdapter borrowed connection (OW-lajehi)", () => {
	// As of `codex-cli` 0.154.0 a forked thread can only be opened by the
	// app-server that minted it: a second process answers `thread/resume` with
	// JSON-RPC -32600, "already has an active writer" (docs/MANUAL_TESTING.md,
	// "The app-server that mints a fork can also drive it"). So `fork()` hands
	// back an adapter that borrows this one's connection, and everything below
	// is about two adapters sharing one id space and one line stream.

	/** A server that echoes back whatever thread id a resume asked for. */
	interface ShareableOptions {
		holdResume?: { promise: Promise<void> };
		refuseResume?: string;
		/** What a fork and a resume of it answer with, as `thread/fork` left it: the config's defaults. */
		forkSettings?: { model: string; reasoningEffort: string };
		codexRoot?: string;
	}

	function shareableServer(proc: AdapterProcess, options: ShareableOptions = {}): void {
		let forks = 0;
		proc.onWrite((message) => {
			const id = message["id"];
			if (typeof id !== "number") return;
			const params = (message["params"] ?? {}) as Record<string, unknown>;
			switch (message["method"]) {
				case "initialize":
					proc.emit({ id, result: { userAgent: "test" } });
					break;
				case "thread/start":
					proc.emit({ id, result: { thread: { id: "thread-parent", turns: [] }, model: "m" } });
					break;
				case "thread/resume": {
					const threadId = params["threadId"];
					const answer = (): void => {
						if (options.refuseResume && threadId !== "thread-parent") {
							proc.emit({ id, error: { code: -32600, message: options.refuseResume } });
							return;
						}
						const settings =
							threadId !== "thread-parent" && options.forkSettings ? options.forkSettings : { model: "m" };
						proc.emit({ id, result: { thread: { id: threadId, turns: [] }, ...settings } });
					};
					if (options.holdResume) void options.holdResume.promise.then(answer);
					else answer();
					break;
				}
				case "thread/read":
					proc.emit({
						id,
						result: { thread: { id: params["threadId"], turns: [{ id: "turn-1", items: [] }] } },
					});
					break;
				case "thread/fork":
					forks += 1;
					proc.emit({
						id,
						result: {
							thread: { id: forks === 1 ? "thread-forked" : `thread-forked-${forks}`, turns: [] },
							...options.forkSettings,
						},
					});
					break;
				case "turn/start":
					proc.emit({ id, result: { turn: { id: "turn-x" } } });
					break;
			}
		});
	}

	async function forkedPair(options: ShareableOptions = {}) {
		const proc = new AdapterProcess();
		shareableServer(proc, options);
		const parent = new CodexAdapter(VIRTUAL_REF, { spawn: () => proc, codexRoot: options.codexRoot ?? NO_STORE });
		await parent.start({ cwd: "/workspace" });
		// `fork()` needs a turn to cut at; `thread/read` above answers one.
		await parent.listForkPoints();
		const forked = await parent.fork("turn-1");
		const borrower = forked.adapter as CodexAdapter | undefined;
		if (!borrower) throw new Error("fork() handed back no adapter to drive the fork with");
		return { proc, parent, borrower, forked };
	}

	it("hands back an adapter to start as a plain resume of the flushed fork", async () => {
		const { proc, forked, borrower } = await forkedPair();

		expect(forked.ref).toEqual({ backend: "codex", id: "thread-forked" });
		expect(forked.start).toEqual({ cwd: "/workspace", resumeId: "thread-forked" });
		expect(borrower.ref).toEqual({ backend: "codex", id: "thread-forked" });

		await borrower.start(forked.start as { cwd: string; resumeId: string });

		// One `initialize`, not two: the handshake is per connection and the
		// borrower is on the one the parent already shook hands over.
		expect(methods(proc).filter((m) => m === "initialize")).toHaveLength(1);
		expect(request(proc, "thread/resume")["params"]).toMatchObject({
			threadId: "thread-forked",
			cwd: "/workspace",
			sandbox: "danger-full-access",
			approvalPolicy: "never",
		});
	});

	it("starts a fork at the model and effort the kept prefix's last turn ran at (D23)", async () => {
		// As of `codex-cli` 0.156.0 `thread/fork` carries neither: the fork, and a
		// resume of it on the app-server that minted it, answered the config's
		// defaults, and a turn sent on it naming no effort ran at the config's
		// (docs/MANUAL_TESTING.md, OW-sayaju). The fork's rollout holds only its
		// own records and names its parent's as its history (OW-buligi), so the
		// parent's second turn, past the cut, is not the fork's.
		const parentLines = [
			{ type: "session_meta", payload: { id: "thread-parent" } },
			eventMsg("task_started", "turn-1"),
			turnContext("turn-1", "gpt-parent", "low"),
			eventMsg("task_complete", "turn-1"),
			eventMsg("task_started", "turn-2"),
			turnContext("turn-2", "gpt-later", "max"),
			eventMsg("task_complete", "turn-2"),
		];
		const codexRoot = await rolloutStore({
			"thread-parent": parentLines,
			"thread-forked": [
				{
					type: "session_meta",
					payload: {
						id: "thread-forked",
						forked_from_id: "thread-parent",
						history_base: { thread_id: "thread-parent", end_ordinal_exclusive: 4, end_byte_offset: 0 },
					},
				},
				{ type: "event_msg", payload: { type: "thread_settings_applied", thread_id: "thread-forked" } },
			],
		});
		try {
			const { proc, forked, borrower } = await forkedPair({
				codexRoot,
				forkSettings: { model: "gpt-config", reasoningEffort: "high" },
			});
			await borrower.start(forked.start as { cwd: string; resumeId: string });

			expect(borrower.getState()).toMatchObject({ model: "gpt-parent", effort: "low" });
			await borrower.submit("go");

			expect(request(proc, "turn/start")["params"]).toMatchObject({
				threadId: "thread-forked",
				model: "gpt-parent",
				effort: "low",
			});
		} finally {
			await rm(codexRoot, { recursive: true, force: true });
		}
	});

	it("ignores the parent's live turn while its own resume is still in flight", async () => {
		// The window the borrower fails OPEN in if its identity is not seeded
		// before the shared line stream reaches it: a fork of a STREAMING parent
		// (D15/OW-gojado) would otherwise take the parent's deltas as its own.
		const gate = deferred<void>();
		const { proc, borrower } = await forkedPair({ holdResume: gate });
		const starting = borrower.start({ cwd: "/workspace", resumeId: "thread-forked" });

		proc.emit({ method: "turn/started", params: { threadId: "thread-parent", turn: { id: "turn-live" } } });
		proc.emit({
			method: "item/started",
			params: {
				threadId: "thread-parent",
				startedAtMs: 1,
				item: { id: "item-1", type: "agentMessage", text: "" },
			},
		});
		proc.emit({
			method: "item/agentMessage/delta",
			params: { threadId: "thread-parent", itemId: "item-1", delta: "parent's words" },
		});

		expect(borrower.getState().messages).toEqual([]);
		expect(borrower.getState().isStreaming).toBe(false);

		gate.resolve();
		await starting;
		expect(borrower.getState().messages).toEqual([]);
	});

	it("publishes a blocking request once across both adapters, and answers it once", async () => {
		const { proc, parent, borrower, forked } = await forkedPair();
		await borrower.start(forked.start as { cwd: string; resumeId: string });
		const seen: { who: string; request: AgentRequest }[] = [];
		parent.onRequest((request) => seen.push({ who: "parent", request }));
		borrower.onRequest((request) => seen.push({ who: "fork", request }));

		proc.emit({
			id: 77,
			method: "item/fileChange/requestApproval",
			params: { threadId: "thread-parent", turnId: "t", itemId: "i", startedAtMs: 1 },
		});

		expect(seen).toHaveLength(1);
		expect(seen[0]?.who).toBe("parent");

		const before = responses(proc).length;
		await parent.reply(seen[0]?.request.requestId as string, null);
		expect(responses(proc).length - before).toBe(1);
	});

	it("routes a request for the fork's own thread to the fork alone", async () => {
		const { proc, parent, borrower, forked } = await forkedPair();
		await borrower.start(forked.start as { cwd: string; resumeId: string });
		const seen: string[] = [];
		parent.onRequest(() => seen.push("parent"));
		borrower.onRequest(() => seen.push("fork"));

		proc.emit({
			id: 78,
			method: "item/fileChange/requestApproval",
			params: { threadId: "thread-forked", turnId: "t", itemId: "i", startedAtMs: 1 },
		});

		expect(seen).toEqual(["fork"]);
	});

	it("declines an unanswerable request exactly once, not once per adapter", async () => {
		// `applyEffects` answers a kind with no decline shape at arrival (D18,
		// OW-nujawi). Two adapters on one connection would write two JSON-RPC
		// responses for one wire id.
		const { proc, parent, borrower, forked } = await forkedPair();
		await borrower.start(forked.start as { cwd: string; resumeId: string });
		const errors: string[] = [];
		parent.onError((message) => errors.push(message));
		borrower.onError((message) => errors.push(message));
		const before = responses(proc).length;

		proc.emit({
			id: 79,
			method: "item/tool/requestUserInput",
			params: { threadId: "thread-parent", turnId: "t", itemId: "i" },
		});

		expect(responses(proc).length - before).toBe(1);
		expect(errors).toHaveLength(1);
	});

	it("routes a legacy approval by the `conversationId` it names its thread with", async () => {
		// `ApplyPatchApprovalParams` and `ExecCommandApprovalParams` are the two
		// deprecated kinds, and they DO name their thread -- under
		// `conversationId: ThreadId` rather than `threadId`. Reading only
		// `threadId` attributes the fork's own approval to the parent.
		const { proc, parent, borrower, forked } = await forkedPair();
		await borrower.start(forked.start as { cwd: string; resumeId: string });
		// Neither legacy kind has a decline shape, so the recipient answers it at
		// arrival and raises a session error (D18, OW-nujawi) -- which is what
		// names who received it.
		const seen: string[] = [];
		parent.onError(() => seen.push("parent"));
		borrower.onError(() => seen.push("fork"));
		const before = responses(proc).length;

		proc.emit({
			id: 80,
			method: "applyPatchApproval",
			params: { conversationId: "thread-forked", callId: "c", fileChanges: {} },
		});

		expect(seen).toEqual(["fork"]);
		expect(responses(proc).length - before).toBe(1);
	});

	it("does not hand a blocking request to a fork nobody has started yet", async () => {
		// A borrower joins the stream at fork time so the share is taken before
		// any `close()` can land, but `SessionManager` does not subscribe to it
		// until `start()`. Close the parent while the fork is still parked and
		// the parked borrower would otherwise become the fallback recipient for a
		// thread nobody drives (D19's subagent): registered as pending, published
		// to nobody, answered by nobody -- D2a's silent stall, now pinning the
		// shared app-server too.
		const { proc, parent, borrower } = await forkedPair();
		const seen: string[] = [];
		parent.onRequest(() => seen.push("parent"));
		borrower.onRequest(() => seen.push("fork"));
		await parent.dispose();
		const before = responses(proc).length;

		proc.emit({
			id: 81,
			method: "item/fileChange/requestApproval",
			params: { threadId: "thread-of-a-subagent", turnId: "t", itemId: "i", startedAtMs: 1 },
		});

		expect(seen).toEqual([]);
		expect(responses(proc).length - before).toBe(0);
	});

	it("refuses to drive a borrower that was never started", async () => {
		// A borrower holds a live client from the moment it is built, so "do I
		// have a client" stopped meaning "have I been started". Without the
		// stronger guard these write real JSON-RPC for a thread no `thread/resume`
		// has ever opened, under an error message that says the opposite.
		const { proc, borrower } = await forkedPair();

		await expect(borrower.submit("hello")).rejects.toThrow("codex adapter not started");
		await expect(borrower.compact()).rejects.toThrow("codex adapter not started");
		await expect(borrower.listForkPoints()).rejects.toThrow("codex adapter not started");
		await expect(borrower.fork("turn-1")).rejects.toThrow("codex adapter not started");
		expect(proc.lastRequest("turn/start")).toBeUndefined();
		expect(proc.lastRequest("thread/compact/start")).toBeUndefined();
	});

	it("lets go of the share when its own resume is refused", async () => {
		const { proc, parent, borrower, forked } = await forkedPair({ refuseResume: "fork refused" });

		await expect(borrower.start(forked.start as { cwd: string; resumeId: string })).rejects.toThrow(
			"fork refused",
		);

		// The failed borrower still holds its share until someone disposes it --
		// `SessionManager.#start` does -- and it is no longer a recipient for
		// anything, because it never became answerable.
		await parent.dispose();
		expect(proc.killCount).toBe(0);
		await borrower.dispose();
		expect(proc.killCount).toBe(1);
	});

	it("kills the shared child only when the last holder lets go", async () => {
		const { proc, parent, borrower, forked } = await forkedPair();
		await borrower.start(forked.start as { cwd: string; resumeId: string });

		await parent.dispose();

		expect(proc.killCount).toBe(0);
		// And the fork can still reach the wire the parent opened.
		const before = proc.written.length;
		await borrower.submit("still here");
		expect(proc.written.length).toBeGreaterThan(before);

		await borrower.dispose();
		expect(proc.killCount).toBe(1);
	});

	it("counts N holders, so a fork of a fork keeps the child alive too", async () => {
		const { proc, parent, borrower, forked } = await forkedPair();
		await borrower.start(forked.start as { cwd: string; resumeId: string });
		await borrower.listForkPoints();
		const grandchild = (await borrower.fork("turn-1")).adapter as CodexAdapter | undefined;
		if (!grandchild) throw new Error("a fork of a fork handed back no adapter");

		await parent.dispose();
		await borrower.dispose();
		expect(proc.killCount).toBe(0);

		await grandchild.dispose();
		expect(proc.killCount).toBe(1);
	});

	it("tells both adapters when the shared child dies", async () => {
		const { proc, parent, borrower, forked } = await forkedPair();
		await borrower.start(forked.start as { cwd: string; resumeId: string });
		const errors: string[] = [];
		parent.onError((message) => errors.push(`parent: ${message}`));
		borrower.onError((message) => errors.push(`fork: ${message}`));

		proc.exit(1, null, new Error("app-server died"));

		expect(errors).toHaveLength(2);
		expect(errors.some((m) => m.startsWith("parent:"))).toBe(true);
		expect(errors.some((m) => m.startsWith("fork:"))).toBe(true);
	});
});
