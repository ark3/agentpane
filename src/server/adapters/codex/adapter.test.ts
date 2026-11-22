import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionRef } from "../../../shared/protocol.ts";
import { CodexConnectionRegistry } from "./connection.ts";
import { CodexAdapter, CodexAdapterFactory, type CodexAdapterOptions } from "./index.ts";
import type { CodexProcess } from "./process.ts";
import type { Thread } from "./protocol.ts";
import { CodexReducer } from "./reducer.ts";
import { BackendRefusedError, type StateChange, TurnRunningError } from "../types.ts";
import { FakeCodexProcess } from "./test-support.ts";
import { eventTimeoutMs } from "./adapter.ts";
import { FakeTimers } from "../../http/testing/fakes.ts";

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

/**
 * Once `closed` is set, writes throw and replies are dropped, as
 * `ChildProcessShell.write` and `reply` do once the child's stdin is gone.
 */
class ClosedStdinProcess extends AdapterProcess {
	closed = false;

	override write(line: string): void {
		if (this.closed) throw new Error("Codex process is not running");
		super.write(line);
	}

	override reply(line: string): void {
		if (this.closed) return;
		super.reply(line);
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
	/** Answer `turn/start` and send its `thread/status/changed`, but not its `turn/started`. */
	holdTurnStarted?: boolean;
	holdThreadStart?: boolean;
	failCompact?: string;
	failSteer?: string;
	/** Refuse `turn/start` with this message. */
	failTurnStart?: string;
	/** End each turn `turn/start` begins in the same chunk as its reply, as a turn with nothing to say could. */
	completeTurns?: boolean;
	/** The stored thread's `historyMode`; `paginated` is what `thread/start` created as of `codex-cli` 0.156.0. */
	historyMode?: "legacy" | "paginated";
	/** The `thread.name` a `thread/start` or `thread/resume` answers with; absent, the thread has none. */
	threadName?: string;
	/** Answer `thread/name/set` without the `thread/name/updated` that follows it. */
	holdNameUpdated?: boolean;
}

/**
 * The notice `codex-cli` 0.156.0 sent, naming no thread, for each full-history
 * load of a `paginated` thread: a `thread/resume` or `thread/fork` without
 * `excludeTurns`, and a `thread/read` with `includeTurns`. A `legacy` thread
 * drew none (docs/MANUAL_TESTING.md, OW-kelene).
 */
function fullHistoryDeprecation(proc: AdapterProcess, options: HappyServerOptions): void {
	if ((options.historyMode ?? "paginated") !== "paginated") return;
	proc.emit({
		method: "deprecationNotice",
		params: { summary: "Full-history hydration is deprecated for paginated threads", details: null },
	});
}

/**
 * One `thread/turns/list` page, as `codex-cli` 0.156.0 answered it: one turn
 * per page here, so a transcript of two turns or more is paged, and `summary`
 * -- the default -- keeping only a turn's first user message and last agent
 * message, which is what the measured summaries held.
 */
function turnsPage(turns: unknown[], params: Record<string, unknown>): unknown {
	const ordered = params["sortDirection"] === "asc" ? turns : [...turns].reverse();
	const at = typeof params["cursor"] === "string" ? Number(params["cursor"]) : 0;
	const view = params["itemsView"] ?? "summary";
	const data = ordered.slice(at, at + 1).map((raw) => {
		const turn = raw as { items: { type: string }[] };
		if (view === "full") return turn;
		if (view === "notLoaded") return { ...turn, items: [], itemsView: view };
		const user = turn.items.find((item) => item.type === "userMessage");
		const agent = turn.items.findLast((item) => item.type === "agentMessage");
		return { ...turn, items: [user, agent].filter(Boolean), itemsView: view };
	});
	return { data, nextCursor: at + 1 < ordered.length ? String(at + 1) : null, backwardsCursor: null };
}

/** A `turn/started` or `turn/completed` turn, in progress or completed. */
function wireTurn(id: string, status: "inProgress" | "completed" = "inProgress"): Record<string, unknown> {
	return status === "inProgress"
		? { id, items: [], itemsView: "notLoaded", status, error: null, startedAt: 1, completedAt: null, durationMs: null }
		: { id, items: [], itemsView: "summary", status, error: null, startedAt: 1, completedAt: 2, durationMs: 1000 };
}

/**
 * What followed every `turn/start` reply and both `thread/compact/start`
 * replies in the wire captures, `codex-cli 0.147.0` to `0.170.0`: the thread
 * going `active`, then the turn's `turn/started`.
 */
function startTurn(proc: AdapterProcess, threadId: unknown, turnId: string, withStarted = true): void {
	proc.emit({ method: "thread/status/changed", params: { threadId, status: { type: "active", activeFlags: [] } } });
	if (withStarted) proc.emit({ method: "turn/started", params: { threadId, turn: wireTurn(turnId) } });
}

/** How a turn ended in the wire captures: the thread going `idle`, then its `turn/completed`. */
function endTurn(proc: AdapterProcess, threadId: unknown, turnId: string): void {
	proc.emit({ method: "thread/status/changed", params: { threadId, status: { type: "idle" } } });
	proc.emit({ method: "turn/completed", params: { threadId, turn: wireTurn(turnId, "completed") } });
}

function configureHappyServer(proc: AdapterProcess, options: HappyServerOptions = {}): void {
	let turn = 0;
	let compactions = 0;
	const historyMode = options.historyMode ?? "paginated";
	proc.onWrite((message) => {
		const id = message["id"];
		if (typeof id !== "number") return;
		const params = (message["params"] ?? {}) as Record<string, unknown>;
		switch (message["method"]) {
			case "initialize":
				proc.emit({ id, result: { userAgent: "test" } });
				break;
			case "thread/start":
			case "thread/resume": {
				if (options.holdThreadStart) break;
				// A start has no history; a resume carries it all unless told not to.
				const full = message["method"] === "thread/resume" && params["excludeTurns"] !== true;
				if (full) fullHistoryDeprecation(proc, options);
				proc.emit({
					id,
					result: {
						thread: {
							id: options.threadId ?? "thread-real",
							historyMode,
							status: { type: "idle" },
							turns: full ? (options.turns ?? []) : [],
							...(options.threadName !== undefined ? { name: options.threadName } : {}),
						},
						model: options.model ?? "gpt-started",
						modelProvider: options.modelProvider ?? "openai",
						reasoningEffort: options.reasoningEffort ?? null,
					},
				});
				break;
			}
			case "thread/turns/list":
				proc.emit({ id, result: turnsPage(options.turns ?? [], params) });
				break;
			case "model/list":
				proc.emit({ id, result: { data: options.models ?? [], nextCursor: null } });
				break;
			case "turn/start":
				turn += 1;
				if (options.failTurnStart) {
					proc.emit({ id, error: { code: -32603, message: options.failTurnStart } });
					break;
				}
				if (!options.holdTurnStart) {
					proc.emit({ id, result: { turn: { id: `turn-${turn}` } } });
					startTurn(proc, params["threadId"], `turn-${turn}`, !options.holdTurnStarted);
				}
				if (options.completeTurns) endTurn(proc, params["threadId"], `turn-${turn}`);
				break;
			case "thread/read": {
				const full = params["includeTurns"] === true;
				if (full) fullHistoryDeprecation(proc, options);
				proc.emit({
					id,
					result: { thread: { id: options.threadId ?? "thread-real", historyMode, turns: full ? (options.turns ?? []) : [] } },
				});
				break;
			}
			case "thread/fork":
				if (params["excludeTurns"] !== true) fullHistoryDeprecation(proc, options);
				proc.emit({ id, result: { thread: { id: "thread-forked", historyMode, turns: [] } } });
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
			case "thread/name/set":
				// As of `codex-cli` 0.154.0, and mid-turn on 0.160.0, the answer is
				// `{}`, and a `thread/name/updated` naming the thread and name follows.
				proc.emit({ id, result: {} });
				if (!options.holdNameUpdated) {
					proc.emit({ method: "thread/name/updated", params: { threadId: params["threadId"], threadName: params["name"] } });
				}
				break;
			case "thread/compact/start":
				// OW-72: params `{ threadId }`, response an empty object.
				if (options.failCompact) {
					proc.emit({ id, error: { code: -32603, message: options.failCompact } });
					break;
				}
				compactions += 1;
				proc.emit({ id, result: {} });
				startTurn(proc, params["threadId"], `turn-compaction-${compactions}`, !options.holdTurnStarted);
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

/** Two completed turns, each opened by one user message, for a fork to cut between. */
function twoStoredTurns(): unknown[] {
	return ["first", "second"].map((name, n) => ({
		id: `turn-${name}`,
		items: [
			{
				type: "userMessage",
				id: `user-${name}`,
				clientId: null,
				content: [{ type: "text", text: `${name} prompt`, text_elements: [] }],
			},
		],
		itemsView: "full",
		status: "completed",
		error: null,
		startedAt: 1_700_000_000 + n,
		completedAt: 1_700_000_001 + n,
		durationMs: 1000,
	}));
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

	it("resumes a stored thread and hydrates its paged transcript", async () => {
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

		expect(methods(proc)).toEqual(["initialize", "thread/resume", "thread/turns/list"]);
		expect(request(proc, "thread/resume")["params"]).toEqual({
			threadId: STORED_REF.id,
			cwd: "/workspace",
			sandbox: "danger-full-access",
			approvalPolicy: "never",
			excludeTurns: true,
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
		expect(updates).toHaveBeenCalledWith(adapter.getState(), "transcript");
	});

	it("carries both policies onto the forked thread", async () => {
		// A fork is a thread-creation path like start and resume, and as of
		// codex-cli 0.154.0 it inherits the parent's approval policy but not its
		// sandbox (D7a), so both are passed.
		const { adapter, proc } = await startedAdapter({ threadId: STORED_REF.id, turns: twoStoredTurns() }, STORED_REF);

		const forked = await adapter.fork("turn-second");

		// Codex has already flushed the forked thread, but only this app-server
		// may open it, so `fork()` hands over the adapter that will drive it
		// along with the resume to start it as (OW-lajehi).
		expect(forked.ref).toEqual({ backend: "codex", id: "thread-forked" });
		expect(forked.start).toEqual({ cwd: "/workspace", resumeId: "thread-forked" });
		expect(forked.adapter).toBeDefined();
		expect(request(proc, "thread/fork")["params"]).toEqual({
			threadId: STORED_REF.id,
			lastTurnId: "turn-first",
			cwd: "/workspace",
			sandbox: "danger-full-access",
			approvalPolicy: "never",
			excludeTurns: true,
		});
	});

	it("forks at the first user message as a fresh thread, never a `thread/fork` (OW-hojefo)", async () => {
		// As of `codex-cli` 0.156.0 a `thread/fork` with no `lastTurnId` kept the
		// parent's whole history, and one naming no real turn was refused, so no
		// fork request keeps nothing (docs/MANUAL_TESTING.md, OW-hojefo). The fork
		// is a new thread in the parent's workspace, spawned by its own adapter
		// the way Claude Code's session-start fork is.
		const { adapter, proc } = await startedAdapter(
			{ threadId: STORED_REF.id, turns: twoStoredTurns(), model: "gpt-parent", reasoningEffort: "medium" },
			STORED_REF,
		);
		await adapter.setEffort("low");

		const forked = await adapter.fork("turn-first");

		expect(methods(proc)).not.toContain("thread/fork");
		expect(forked.adapter).toBeUndefined();
		expect(forked.ref.backend).toBe("codex");
		expect(forked.ref.id).toMatch(/^virtual:/);
		expect(forked.start).toEqual({
			cwd: "/workspace",
			model: "gpt-parent",
			forkOf: { parentId: STORED_REF.id, entryId: "turn-first", effort: "low" },
		});
	});

	it("refuses a fork at a turn the thread does not have, without a `thread/fork` (OW-fesuwe)", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: STORED_REF.id, turns: twoStoredTurns() }, STORED_REF);

		const forking = adapter.fork("nope");
		await expect(forking).rejects.toBeInstanceOf(BackendRefusedError);
		await expect(forking).rejects.toThrow("unknown fork point: nope");
		expect(methods(proc)).not.toContain("thread/fork");
	});

	it("starts a fork that keeps no turn at the parent's model and effort (D23, OW-hojefo)", async () => {
		// Nothing is stored for it to read back, and `thread/start` answers the
		// config's effort (OW-sayaju, OW-hojefo), so the pair rides the start.
		const proc = new AdapterProcess();
		configureHappyServer(proc, { threadId: "thread-fresh", model: "gpt-parent", reasoningEffort: "high" });
		const adapter = new CodexAdapter(VIRTUAL_REF, { spawn: () => proc, codexRoot: NO_STORE });

		await adapter.start({
			cwd: "/workspace",
			model: "gpt-parent",
			forkOf: { parentId: STORED_REF.id, entryId: "turn-first", effort: "low" },
		});

		expect(methods(proc)).toEqual(["initialize", "thread/start"]);
		expect(request(proc, "thread/start")["params"]).toEqual({
			cwd: "/workspace",
			model: "gpt-parent",
			sandbox: "danger-full-access",
			approvalPolicy: "never",
		});
		expect(adapter.ref).toEqual({ backend: "codex", id: "thread-fresh" });
		expect(adapter.getState()).toMatchObject({ model: "gpt-parent", effort: "low" });

		await adapter.submit("go");

		expect(request(proc, "turn/start")["params"]).toMatchObject({
			threadId: "thread-fresh",
			model: "gpt-parent",
			effort: "low",
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
		adapter.onUpdate(updates);

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

		expect(adapter.getState()).toEqual({ messages: [], isStreaming: false, compaction: null, model: "gpt-started", effort: null, name: null });
		expect(updates).not.toHaveBeenCalled();
		expect(responses(proc)).toEqual([]);
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
		await expect(adapter.start({ cwd: "/workspace" })).rejects.toThrow("workspace rejected");

		proc.emit({ id: 10, method: "item/fileChange/requestApproval", params: {} });

		expect(responses(proc)).toEqual([]);
	});

	it("ignores synchronous process callbacks until client ownership is installed", async () => {
		const proc = new SynchronousRegistrationProcess();
		const adapter = new CodexAdapter(VIRTUAL_REF, { spawn: () => proc });

		await expect(adapter.start({ cwd: "/workspace" })).rejects.toThrow("registration-time exit");

		expect(adapter.getState()).toEqual({ messages: [], isStreaming: false, compaction: null, model: null, effort: null, name: null });
		expect(responses(proc)).toEqual([]);
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

	it("answers a request received during a failed start on that start's process, and nothing on a later retry's", async () => {
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

		await expect(adapter.start({ cwd: "/workspace" })).rejects.toThrow("startup rejected");
		await adapter.start({ cwd: "/workspace" });

		expect(responses(failed)).toEqual([{ id: 4, result: { decision: "decline" } }]);
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
		let abortFromCompletion: Promise<string[]> | undefined;
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
		const updates: [string | null, boolean][] = [];
		adapter.onUpdate((state) => updates.push([state.compaction, state.isStreaming]));

		await adapter.compact();

		expect(request(proc, "thread/compact/start")["params"]).toEqual({ threadId: "thread-compact" });
		// Requesting at the call, then the thread going active for the compaction's turn.
		expect(updates).toEqual([
			["requesting", false],
			["requesting", true],
		]);
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

	it("leaves the adapter idle after a reply, turn/started and turn/completed in one chunk, and admits the next submit", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-same-chunk", completeTurns: true });
		const errors = vi.fn();
		adapter.onError(errors);

		await expect(adapter.submit("finish synchronously")).resolves.toBe("started");
		await adapter.abort();
		await expect(adapter.submit("next")).resolves.toBe("started");

		expect(methods(proc)).not.toContain("turn/interrupt");
		expect(methods(proc)).not.toContain("turn/steer");
		expect(methods(proc).filter((method) => method === "turn/start")).toHaveLength(2);
		expect(errors).not.toHaveBeenCalled();
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
		await expect(adapter.abort()).rejects.toThrow("codex adapter not started");
		expect(methods(proc)).not.toContain("turn/interrupt");
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

	it("says nothing of a turn/completed or an idle status while no turn/start waits", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-idle-completions" });
		const errors = vi.fn();
		adapter.onError(errors);

		for (let index = 0; index < 100; index += 1) endTurn(proc, "thread-idle-completions", `turn-idle-${index}`);
		await adapter.submit("admitted");

		expect(errors).not.toHaveBeenCalled();
		expect(methods(proc).filter((method) => method === "turn/start")).toHaveLength(1);
	});

	describe("the gate from turn/start to its turn/started (D34 point 5)", () => {
		const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

		it("refuses a second submit after the reply and before turn/started, with one turn/start on the wire", async () => {
			const { adapter, proc } = await startedAdapter({ threadId: "thread-gate", holdTurnStarted: true });
			let answered = false;
			const first = adapter.submit("first").then((disposition) => {
				answered = true;
				return disposition;
			});
			await tick();

			const second = expect(adapter.submit("second")).rejects.toThrow(
				"codex adapter cannot submit while turn/start is pending",
			);
			await tick();
			expect(methods(proc).filter((method) => method === "turn/start")).toHaveLength(1);
			await second;
			expect(answered).toBe(false);

			proc.emit({ method: "turn/started", params: { threadId: "thread-gate", turn: wireTurn("turn-1") } });
			await expect(first).resolves.toBe("started");
			await adapter.submit("third");

			expect(request(proc, "turn/steer")["params"]).toMatchObject({ expectedTurnId: "turn-1" });
			expect(methods(proc).filter((method) => method === "turn/start")).toHaveLength(1);
		});

		it.each([
			["an idle status", "thread/status/changed to idle", true],
			["turn/completed", "turn/completed for turn turn-1", false],
		])(
			"raises one session error at a reply and %s with no turn/started, and releases the gate",
			async (_arrival, named, withStatus) => {
				const { adapter, proc } = await startedAdapter({ threadId: "thread-unstarted", holdTurnStarted: true });
				const errors: string[] = [];
				adapter.onError((message) => errors.push(message));
				const submitting = adapter.submit("first");
				await tick();

				if (withStatus) endTurn(proc, "thread-unstarted", "turn-1");
				else proc.emit({ method: "turn/completed", params: { threadId: "thread-unstarted", turn: wireTurn("turn-1", "completed") } });

				expect(errors).toEqual([`codex sent ${named} with no turn/started for agentpane's turn/start`]);
				await expect(submitting).resolves.toBe("started");
				await adapter.abort();
				const next = adapter.submit("next");
				await tick();
				proc.emit({ method: "turn/started", params: { threadId: "thread-unstarted", turn: wireTurn("turn-2") } });
				await expect(next).resolves.toBe("started");
				expect(errors).toHaveLength(1);
				expect(methods(proc)).not.toContain("turn/interrupt");
				expect(methods(proc).filter((method) => method === "turn/start")).toHaveLength(2);
			},
		);

		it("raises nothing for a turn/started that comes on a later tick than its reply", async () => {
			const { adapter, proc } = await startedAdapter({ threadId: "thread-later", holdTurnStarted: true });
			const errors = vi.fn();
			adapter.onError(errors);
			const submitting = adapter.submit("first");
			await tick();
			await tick();

			proc.emit({ method: "turn/started", params: { threadId: "thread-later", turn: wireTurn("turn-1") } });

			await expect(submitting).resolves.toBe("started");
			expect(errors).not.toHaveBeenCalled();
		});

		it("releases the gate on an error reply", async () => {
			const { adapter, proc } = await startedAdapter({ threadId: "thread-refused", failTurnStart: "turn refused" });

			await expect(adapter.submit("first")).rejects.toThrow("turn refused");
			await expect(adapter.submit("second")).rejects.toThrow("turn refused");

			expect(methods(proc).filter((method) => method === "turn/start")).toHaveLength(2);
		});

		it("fails a submit still waiting for its turn/started when app-server exits", async () => {
			const { adapter, proc } = await startedAdapter({ threadId: "thread-exit", holdTurnStarted: true });
			adapter.onError(() => {});
			const submitting = adapter.submit("first");
			await tick();

			proc.exit(1, null, new Error("app-server died"));

			await expect(submitting).rejects.toThrow("app-server died");
		});

		it("fails a submit still waiting for its turn/started when the adapter is disposed", async () => {
			const { adapter } = await startedAdapter({ threadId: "thread-disposed", holdTurnStarted: true });
			const submitting = adapter.submit("first");
			await tick();

			await adapter.dispose();

			await expect(submitting).rejects.toThrow("codex adapter submit aborted: disposed during turn startup");
		});

		describe("the deadline on that turn/started (#91)", () => {
			const missed = (method: string) => `codex sent no turn/started for agentpane's ${method} within 60s`;

			it("refuses a submit whose turn/started has not come by eventTimeoutMs, and runs the verb queued behind it", async () => {
				const timers = new FakeTimers();
				const { adapter, proc } = await startedAdapter({ threadId: "thread-silent", holdTurnStarted: true, setTimer: timers.set });
				const errors: string[] = [];
				adapter.onError((message) => errors.push(message));
				const submitting = adapter.submit("first");
				// As `SessionManager.#serially` runs the next verb once this one settles.
				const queued = submitting.catch(() => {}).then(() => adapter.submit("queued"));
				await tick();
				expect(timers.pending).toEqual([eventTimeoutMs]);

				timers.runOut();

				await expect(submitting).rejects.toThrow(missed("turn/start"));
				expect(errors).toEqual([missed("turn/start")]);
				await tick();
				proc.emit({ method: "turn/started", params: { threadId: "thread-silent", turn: wireTurn("turn-2") } });
				await expect(queued).resolves.toBe("started");
				expect(methods(proc).filter((method) => method === "turn/start")).toHaveLength(2);
				expect(methods(proc)).not.toContain("turn/steer");
				expect(errors).toHaveLength(1);
				expect(timers.pending).toEqual([]);
			});

			it("leaves no turn and the streaming the events said after a miss, and takes a turn/started that comes late", async () => {
				const timers = new FakeTimers();
				const { adapter, proc } = await startedAdapter({ threadId: "thread-late", holdTurnStarted: true, setTimer: timers.set });
				const errors: string[] = [];
				adapter.onError((message) => errors.push(message));
				const submitting = adapter.submit("first");
				await tick();
				timers.runOut();
				await expect(submitting).rejects.toThrow(missed("turn/start"));

				// No turn app-server named, so nothing to interrupt; the thread said `active`.
				expect(adapter.getState().isStreaming).toBe(true);
				await adapter.abort();
				expect(methods(proc)).not.toContain("turn/interrupt");

				proc.emit({ method: "turn/started", params: { threadId: "thread-late", turn: wireTurn("turn-1") } });
				await adapter.abort();
				expect(request(proc, "turn/interrupt")["params"]).toEqual({ threadId: "thread-late", turnId: "turn-1" });
				endTurn(proc, "thread-late", "turn-1");
				expect(adapter.getState().isStreaming).toBe(false);
				expect(errors).toHaveLength(1);
			});

			it("refuses a compaction whose turn/started has not come by eventTimeoutMs, clears its requesting, and runs the verb queued behind it", async () => {
				const timers = new FakeTimers();
				const { adapter, proc } = await startedAdapter({ threadId: "thread-uncompacted", holdTurnStarted: true, setTimer: timers.set });
				const errors: string[] = [];
				adapter.onError((message) => errors.push(message));
				const compacting = adapter.compact();
				const queued = compacting.catch(() => {}).then(() => adapter.submit("queued"));
				await tick();
				expect(adapter.getState().compaction).toBe("requesting");
				expect(timers.pending).toEqual([eventTimeoutMs]);

				timers.runOut();

				await expect(compacting).rejects.toThrow(missed("thread/compact/start"));
				expect(errors).toEqual([missed("thread/compact/start")]);
				expect(adapter.getState().compaction).toBeNull();
				await tick();
				proc.emit({ method: "turn/started", params: { threadId: "thread-uncompacted", turn: wireTurn("turn-1") } });
				await expect(queued).resolves.toBe("started");
				expect(methods(proc)).toContain("turn/start");
				expect(errors).toHaveLength(1);
			});
		});

		it("refuses a prompt between a compaction's reply and its turn/started, so that turn/started releases no prompt's gate", async () => {
			const { adapter, proc } = await startedAdapter({ threadId: "thread-compacting", holdTurnStarted: true });
			let answered = false;
			const compacting = adapter.compact().then(() => {
				answered = true;
			});
			await tick();

			expect(answered).toBe(false);
			const inWindow = expect(adapter.submit("in the window")).rejects.toThrow(
				"codex adapter cannot submit while turn/start is pending",
			);
			await tick();
			expect(methods(proc)).not.toContain("turn/start");
			await inWindow;

			proc.emit({ method: "turn/started", params: { threadId: "thread-compacting", turn: wireTurn("turn-compaction-1") } });
			proc.emit({
				method: "item/started",
				params: { threadId: "thread-compacting", turnId: "turn-compaction-1", item: { type: "contextCompaction", id: "item-compaction" } },
			});
			await compacting;

			await expect(adapter.submit("during the compaction")).rejects.toThrow(
				"codex adapter cannot submit while a turn is active",
			);
			expect(methods(proc)).not.toContain("turn/start");
			expect(methods(proc)).not.toContain("turn/steer");
		});
	});
	it("applies a selected model to subsequent turns", async () => {
		const { adapter, proc } = await startedAdapter();

		await adapter.setModel("gpt-selected");
		expect(adapter.getState().model).toBe("gpt-selected");
		await adapter.submit("use it");

		expect(request(proc, "turn/start")["params"]).toMatchObject({ model: "gpt-selected" });
	});

	it("names the selected model on the turn it ran, not the one the thread started at (OW-9)", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-model", model: "gpt-start" });

		await adapter.setModel("gpt-selected");
		await adapter.submit("go");
		proc.emit({
			method: "item/completed",
			params: {
				threadId: "thread-model",
				turnId: "turn-1",
				item: { type: "agentMessage", id: "answer", text: "ok", phase: "final_answer", memoryCitation: null },
				completedAtMs: 10,
			},
		});

		const [answer] = adapter.getState().messages;
		expect(answer).toMatchObject({ role: "assistant", model: "gpt-selected" });
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
		expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({ effort: "low" }), "status");
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

describe("CodexAdapter session name (D27, OW-jamaha)", () => {
	it("names the thread with thread/name/set and carries the name from thread/name/updated", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: STORED_REF.id, turns: twoStoredTurns() }, STORED_REF);
		const seen: StateChange[] = [];
		adapter.onUpdate((_state, change) => seen.push(change));

		await adapter.setName("probe name");

		expect(methods(proc).filter((method) => String(method).includes("name"))).toEqual(["thread/name/set"]);
		expect(request(proc, "thread/name/set")["params"]).toEqual({ threadId: STORED_REF.id, name: "probe name" });
		expect(adapter.getState().name).toBe("probe name");
		expect(seen).toEqual(["status"]);
	});

	it("takes no name from thread/name/set's reply, and answers only once thread/name/updated has come (D34 point 5)", async () => {
		const { adapter, proc } = await startedAdapter(
			{ threadId: STORED_REF.id, turns: twoStoredTurns(), threadName: "named before", holdNameUpdated: true },
			STORED_REF,
		);
		const seen: StateChange[] = [];
		adapter.onUpdate((_state, change) => seen.push(change));
		let answered = false;
		const renamed = adapter.setName("probe name").then(() => {
			answered = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		// The reply has come and gone; the name has not moved, and the rename waits.
		expect(request(proc, "thread/name/set")["params"]).toEqual({ threadId: STORED_REF.id, name: "probe name" });
		expect(adapter.getState().name).toBe("named before");
		expect(seen).toEqual([]);
		expect(answered).toBe(false);

		proc.emit({ method: "thread/name/updated", params: { threadId: STORED_REF.id, threadName: "probe name" } });
		await renamed;
		expect(adapter.getState().name).toBe("probe name");
		expect(seen).toEqual(["status"]);
	});

	it("fails a rename still waiting for its thread/name/updated when app-server exits", async () => {
		const { adapter, proc } = await startedAdapter(
			{ threadId: STORED_REF.id, turns: twoStoredTurns(), holdNameUpdated: true },
			STORED_REF,
		);
		adapter.onError(() => {});
		const renamed = adapter.setName("probe name");
		await new Promise((resolve) => setTimeout(resolve, 0));

		proc.exit(1, null, new Error("app-server died"));

		await expect(renamed).rejects.toThrow("app-server died");
		expect(adapter.getState().name).toBeNull();
	});

	it("refuses a rename whose thread/name/updated has not come by eventTimeoutMs, and runs the verb queued behind it (#91)", async () => {
		const timers = new FakeTimers();
		const { adapter, proc } = await startedAdapter(
			{ threadId: STORED_REF.id, turns: twoStoredTurns(), holdNameUpdated: true, setTimer: timers.set },
			STORED_REF,
		);
		const errors: string[] = [];
		adapter.onError((message) => errors.push(message));
		const renamed = adapter.setName("probe name");
		// As `SessionManager.#serially` runs the next verb once this one settles.
		const queued = renamed.catch(() => {}).then(() => adapter.submit("queued"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(request(proc, "thread/name/set")["params"]).toEqual({ threadId: STORED_REF.id, name: "probe name" });
		expect(timers.pending).toEqual([eventTimeoutMs]);

		timers.runOut();

		const missed = "codex sent no thread/name/updated for agentpane's thread/name/set within 60s";
		await expect(renamed).rejects.toThrow(missed);
		expect(errors).toEqual([missed]);
		await expect(queued).resolves.toBe("started");
		expect(methods(proc)).toContain("turn/start");
		expect(adapter.getState().name).toBeNull();
		expect(timers.pending).toEqual([]);

		// One that comes after the miss is a rename like any other.
		proc.emit({ method: "thread/name/updated", params: { threadId: STORED_REF.id, threadName: "probe name" } });
		expect(adapter.getState().name).toBe("probe name");
		expect(errors).toHaveLength(1);
	});

	it("refuses to name a thread with no conversation yet, sending nothing (OW-kametu)", async () => {
		// As of `codex-cli 0.160.0` a `thread/name/set` before the first turn wrote
		// a `session_index.jsonl` line and a `threads` row for a thread with no
		// rollout, and both outlived the process (docs/MANUAL_TESTING.md, OW-kametu).
		const { adapter, proc } = await startedAdapter({ threadId: "thread-fresh" });
		const seen: StateChange[] = [];
		adapter.onUpdate((_state, change) => seen.push(change));

		await expect(adapter.setName("probe name")).rejects.toBeInstanceOf(BackendRefusedError);

		expect(methods(proc)).not.toContain("thread/name/set");
		expect(adapter.getState().name).toBeNull();
		expect(seen).toEqual([]);
	});

	it("names a thread it started once its first turn's user message has arrived (OW-kametu)", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-prompted" });
		await adapter.submit("first prompt");
		proc.emit({
			method: "item/started",
			params: {
				threadId: "thread-prompted",
				turnId: "turn-1",
				item: {
					type: "userMessage",
					id: "user-live",
					clientId: null,
					content: [{ type: "text", text: "first prompt", text_elements: [] }],
				},
				startedAtMs: 10,
			},
		});
		proc.emit({
			method: "turn/completed",
			params: {
				threadId: "thread-prompted",
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
		expect(adapter.getState().messages.map((message) => message.role)).toContain("user");

		await adapter.setName("probe name");

		expect(request(proc, "thread/name/set")["params"]).toEqual({ threadId: "thread-prompted", name: "probe name" });
		expect(adapter.getState().name).toBe("probe name");
	});

	it("follows a thread/name/updated for its own thread, and no other", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-named" });
		const seen: StateChange[] = [];
		adapter.onUpdate((_state, change) => seen.push(change));

		proc.emit({ method: "thread/name/updated", params: { threadId: "thread-other", threadName: "not mine" } });
		expect(adapter.getState().name).toBeNull();

		proc.emit({ method: "thread/name/updated", params: { threadId: "thread-named", threadName: "renamed elsewhere" } });
		expect(adapter.getState().name).toBe("renamed elsewhere");
		expect(seen).toEqual(["status"]);
	});

	it("carries the name thread/resume answers with, before any rename", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: STORED_REF.id, threadName: "named before" }, STORED_REF);

		expect(adapter.getState().name).toBe("named before");
		expect(methods(proc)).not.toContain("thread/name/set");
	});
});

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

describe("CodexAdapter history loading (OW-kelene)", () => {
	// As of `codex-cli` 0.156.0 a full-history load of a `paginated` thread --
	// `thread/resume` or `thread/fork` without `excludeTurns`, `thread/read`
	// with `includeTurns` -- drew a `deprecationNotice`, while
	// `thread/turns/list` at `itemsView: "full"` answered the same turns with
	// the same items for `paginated` and `legacy` threads alike
	// (docs/MANUAL_TESTING.md, OW-kelene). The fake server here answers the same
	// way, so each case runs for both modes.

	/** Three turns: one with a hidden reasoning item, one steered, so indices are not item positions. */
	function storedTurns(): unknown[] {
		const user = (id: string, text: string) => ({
			type: "userMessage",
			id,
			clientId: null,
			content: [{ type: "text", text, text_elements: [] }],
		});
		const agent = (id: string, text: string) => ({ type: "agentMessage", id, text, phase: "final_answer", memoryCitation: null });
		const turn = (id: string, n: number, items: unknown[]) => ({
			id,
			items,
			itemsView: "full",
			status: "completed",
			error: null,
			startedAt: 1_700_000_000 + n,
			completedAt: 1_700_000_001 + n,
			durationMs: 1000,
		});
		return [
			turn("turn-one", 0, [user("user-a", "first ask"), { type: "reasoning", id: "reason-a", summary: [], content: [] }, agent("agent-a", "an answer")]),
			turn("turn-two", 2, [user("user-b", "second ask"), agent("agent-b", "part one"), user("user-steer", "also this"), agent("agent-c", "part two")]),
			turn("turn-three", 4, [user("user-c", "third ask"), agent("agent-d", "last answer")]),
		];
	}

	/** What hydrating the whole history at once painted, which is what a reattach painted before. */
	function paintedWhole(turns: unknown[]): unknown[] {
		const reducer = new CodexReducer();
		reducer.setIdentity({ threadId: STORED_REF.id, model: "gpt-started", modelProvider: "openai" });
		reducer.hydrate({ id: STORED_REF.id, turns: turns as Thread["turns"] });
		return reducer.getState().messages;
	}

	/** No request the adapter wrote asked for the whole history in one answer. */
	function expectNoFullHistoryLoad(proc: AdapterProcess): void {
		for (const message of proc.written) {
			const params = (message["params"] ?? {}) as Record<string, unknown>;
			expect(params["includeTurns"], `${String(message["method"])} asked for includeTurns`).not.toBe(true);
			if (message["method"] === "thread/resume" || message["method"] === "thread/fork") {
				expect(params["excludeTurns"], `${String(message["method"])} without excludeTurns`).toBe(true);
			}
		}
	}

	describe.each(["paginated", "legacy"] as const)("a %s thread", (historyMode) => {
		it("repaints a reattach with the transcript and fork points a whole-history load gave, and draws no deprecation", async () => {
			const turns = storedTurns();
			const proc = new AdapterProcess();
			configureHappyServer(proc, { threadId: STORED_REF.id, turns, historyMode });
			const adapter = new CodexAdapter(STORED_REF, { spawn: () => proc, codexRoot: NO_STORE });
			const notices = vi.fn();
			adapter.onNotice(notices);

			await adapter.start({ cwd: "/workspace", resumeId: STORED_REF.id });

			expect(adapter.getState().messages).toEqual(paintedWhole(turns));
			expect(await adapter.listForkPoints()).toEqual([
				{ id: "turn-one", text: "first ask", index: 0 },
				{ id: "turn-two", text: "second ask", index: 2 },
				{ id: "turn-three", text: "third ask", index: 6 },
			]);
			expectNoFullHistoryLoad(proc);
			expect(notices).not.toHaveBeenCalled();
		});

		it("forks at a turn of a reattached thread without a whole-history load", async () => {
			const turns = storedTurns();
			const proc = new AdapterProcess();
			configureHappyServer(proc, { threadId: STORED_REF.id, turns, historyMode });
			const adapter = new CodexAdapter(STORED_REF, { spawn: () => proc, codexRoot: NO_STORE });
			const notices = vi.fn();
			adapter.onNotice(notices);
			await adapter.start({ cwd: "/workspace", resumeId: STORED_REF.id });

			await adapter.fork("turn-three");

			expect(request(proc, "thread/fork")["params"]).toMatchObject({ threadId: STORED_REF.id, lastTurnId: "turn-two" });
			expectNoFullHistoryLoad(proc);
			expect(notices).not.toHaveBeenCalled();
		});

		it("lists the fork points of a thread started here, whose turns only the server holds", async () => {
			// `fork()` falls back to listing when it has no turn order, which is the
			// case for a thread this adapter started and then drove.
			const turns = storedTurns();
			const { adapter, proc } = await startedAdapter({ threadId: "thread-live", turns, historyMode });
			const notices = vi.fn();
			adapter.onNotice(notices);

			await adapter.fork("turn-two");

			expect(request(proc, "thread/fork")["params"]).toMatchObject({ threadId: "thread-live", lastTurnId: "turn-one" });
			expectNoFullHistoryLoad(proc);
			expect(notices).not.toHaveBeenCalled();
		});
	});
});

describe("CodexAdapter reducer effects", () => {
	it("publishes a warning as a notice and not as an error (OW-tujiya)", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-events" });
		const notices = vi.fn();
		const errors = vi.fn();
		adapter.onNotice(notices);
		adapter.onError(errors);

		proc.emit({ method: "warning", params: { threadId: "thread-events", message: "fallback metadata" } });

		expect(notices).toHaveBeenCalledExactlyOnceWith({
			kind: "warning",
			message: "fallback metadata",
			details: null,
			path: null,
		});
		expect(errors).not.toHaveBeenCalled();
	});

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

		// The turn's start moved the status alone (OW-yirosu).
		expect(updates).toHaveBeenNthCalledWith(1, { messages: [], isStreaming: true, compaction: null, model: "gpt-started", effort: null, name: null }, "status");
		expect(updates).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ isStreaming: true, messages: [expect.objectContaining({ role: "assistant" })] }),
			0,
		);
	});

	it("publishes reducer errors", async () => {
		const { adapter, proc } = await startedAdapter();
		const errors = vi.fn();
		adapter.onError(errors);

		proc.emit({ method: "error", params: { error: { message: "turn failed" } } });

		expect(errors).toHaveBeenCalledWith("turn failed");
	});
});

describe("CodexAdapter requests, refused at arrival (D2a)", () => {
	it("declines a request that arrives before the thread is adopted, and writes nothing more when Codex resolves it", async () => {
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
		const errors: string[] = [];
		adapter.onError((message) => errors.push(message));

		await adapter.start({ cwd: "/workspace" });
		proc.emit({ method: "serverRequest/resolved", params: { requestId: 0 } });

		expect(responses(proc)).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(errors).toEqual([expect.stringContaining("item/fileChange/requestApproval")]);
	});

	it("declines equal wire request ids each on its own adapter's wire", async () => {
		const first = await startedAdapter({ threadId: "thread-first" });
		const second = await startedAdapter({ threadId: "thread-second" });

		first.proc.emit({ id: 0, method: "item/fileChange/requestApproval", params: {} });
		second.proc.emit({ id: 0, method: "item/fileChange/requestApproval", params: {} });

		expect(responses(first.proc)).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(responses(second.proc)).toEqual([{ id: 0, result: { decision: "decline" } }]);
	});

	it("distinguishes numeric and string wire request ids", async () => {
		const { proc } = await startedAdapter({ threadId: "thread-typed-ids" });

		proc.emit({ id: 0, method: "item/fileChange/requestApproval", params: {} });
		proc.emit({ id: "0", method: "item/fileChange/requestApproval", params: {} });

		expect(responses(proc)).toEqual([
			{ id: 0, result: { decision: "decline" } },
			{ id: "0", result: { decision: "decline" } },
		]);
	});

	it("correlates replies to the original numeric request id", async () => {
		const { proc } = await startedAdapter({ threadId: "thread-correlate" });

		proc.emit({ id: 23, method: "item/fileChange/requestApproval", params: { itemId: "edit-1" } });

		expect(proc.written.at(-1)).toEqual({ id: 23, result: { decision: "decline" } });
	});

	it("declines approvals with their protocol response shape", async () => {
		const { proc } = await startedAdapter();

		proc.emit({ id: "approval-1", method: "item/fileChange/requestApproval", params: {} });

		expect(responses(proc)).toEqual([{ id: "approval-1", result: { decision: "decline" } }]);
	});

	it("declines MCP elicitations with their generated protocol response shape", async () => {
		const { proc } = await startedAdapter();

		proc.emit({ id: "elicitation-1", method: "mcpServer/elicitation/request", params: {} });

		expect(responses(proc)).toEqual([
			{ id: "elicitation-1", result: { action: "decline", content: null, _meta: null } },
		]);
	});

	it("answers a request kind it has no handler for and names it in an error (OW-nujawi)", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "thread-unknown" });
		const errors: string[] = [];
		adapter.onError((message) => errors.push(message));

		proc.emit({ id: 31, method: "workspace/trust/request", params: { threadId: "thread-unknown" } });

		expect(responses(proc)).toEqual([
			{ id: 31, error: { code: -32601, message: expect.stringContaining("workspace/trust/request") } },
		]);
		expect(errors).toEqual([expect.stringContaining("workspace/trust/request")]);
	});

	it("declines a request it has a decline shape for at arrival and names its kind in an error (OW-zisumi)", async () => {
		const threadId = "thread-declining";
		const { adapter, proc } = await startedAdapter({ threadId });
		const errors: { message: string; answered: unknown[] }[] = [];
		adapter.onError((message) => errors.push({ message, answered: responses(proc) }));

		proc.emit({
			id: 41,
			method: "item/commandExecution/requestApproval",
			params: { threadId, turnId: "turn-1", itemId: "item-1", startedAtMs: 1, command: "rm -rf build" },
		});

		// Named once the decline is on the wire, not before.
		expect(errors).toEqual([
			{
				message: expect.stringContaining("item/commandExecution/requestApproval"),
				answered: [{ id: 41, result: { decision: "decline" } }],
			},
		]);
	});

	it("does not throw out of the line handler when the child is gone while a request line still drains (OW-pivuho)", async () => {
		const threadId = "thread-draining";
		const proc = new ClosedStdinProcess();
		configureHappyServer(proc, { threadId });
		const adapter = new CodexAdapter(VIRTUAL_REF, { codexRoot: NO_STORE, spawn: () => proc });
		await adapter.start({ cwd: "/workspace" });
		const errors: string[] = [];
		adapter.onError((message) => errors.push(message));
		const before = responses(proc).length;

		proc.closed = true;
		expect(() =>
			proc.emit({ id: 51, method: "item/fileChange/requestApproval", params: { threadId } }),
		).not.toThrow();
		expect(() =>
			proc.emit({ id: 52, method: "workspace/trust/request", params: { threadId } }),
		).not.toThrow();
		proc.exit(1, null, new Error("app-server died"));

		expect(responses(proc).length).toBe(before);
		expect(errors).toEqual([
			expect.stringContaining("item/fileChange/requestApproval"),
			expect.stringContaining("workspace/trust/request"),
			"app-server died",
		]);
	});

	it("declines a child-thread blocking request through the parent, under the child's wire id (OW-futewo)", async () => {
		const { adapter, proc } = await startedAdapter({ threadId: "parent-thread" });
		const errors: string[] = [];
		adapter.onError((message) => errors.push(message));

		proc.emit({
			id: "child-approval-1",
			method: "item/commandExecution/requestApproval",
			params: {
				threadId: "child-thread",
				turnId: "turn-1",
				itemId: "item-1",
				startedAtMs: 1000,
				command: "echo test",
			},
		});

		expect(responses(proc)).toEqual([
			{ id: "child-approval-1", result: { decision: "decline" } },
		]);
		expect(errors).toEqual([expect.stringContaining("item/commandExecution/requestApproval")]);
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
		/** The turns the fork inherited, which `thread/turns/list` pages out for any thread but the parent. */
		forkTurns?: unknown[];
		/** What a resume of any thread but the parent reads its status as; idle unless given. */
		resumeStatus?: { type: string; activeFlags?: string[] };
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
						const full = params["excludeTurns"] !== true && threadId !== "thread-parent";
						const turns = full ? (options.forkTurns ?? []) : [];
						const status = (threadId !== "thread-parent" && options.resumeStatus) || { type: "idle" };
						proc.emit({ id, result: { thread: { id: threadId, status, turns }, ...settings } });
					};
					if (options.holdResume) void options.holdResume.promise.then(answer);
					else answer();
					break;
				}
				case "thread/turns/list":
					proc.emit({
						id,
						result: turnsPage(
							options.forkTurns && params["threadId"] !== "thread-parent"
								? options.forkTurns
								: [{ id: "turn-1", items: [] }, { id: "turn-2", items: [] }],
							params,
						),
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
					startTurn(proc, params["threadId"], "turn-x");
					break;
				case "turn/steer":
					proc.emit({ id, result: { turnId: params["expectedTurnId"] } });
					break;
				case "turn/interrupt":
					proc.emit({ id, result: {} });
					break;
			}
		});
	}

	async function forkedPair(options: ShareableOptions = {}) {
		const proc = new AdapterProcess();
		shareableServer(proc, options);
		const parent = new CodexAdapter(VIRTUAL_REF, { spawn: () => proc, codexRoot: options.codexRoot ?? NO_STORE });
		await parent.start({ cwd: "/workspace" });
		// `fork()` needs a turn to cut at, past the first: a fork at the first
		// keeps no turn and is no `thread/fork` at all (OW-hojefo).
		await parent.listForkPoints();
		const forked = await parent.fork("turn-2");
		const borrower = forked.adapter as CodexAdapter | undefined;
		if (!borrower) throw new Error("fork() handed back no adapter to drive the fork with");
		return { proc, parent, borrower, forked };
	}

	it("announces a fresh start's thread id once, and nothing for a fork, its borrower's start or a resume (D24, OW-nikogo)", async () => {
		const seen: string[] = [];
		const record = (who: string) => (ref: SessionRef, cause: string) => seen.push(`${who} ${cause} ${ref.id}`);
		const proc = new AdapterProcess();
		shareableServer(proc);
		const parent = new CodexAdapter(VIRTUAL_REF, { spawn: () => proc, codexRoot: NO_STORE });
		parent.onRefChanged(record("parent"));
		await parent.start({ cwd: "/workspace" });
		expect(seen.splice(0)).toEqual(["parent rename thread-parent"]);

		await parent.listForkPoints();
		const forked = await parent.fork("turn-2");
		const borrower = forked.adapter as CodexAdapter;
		borrower.onRefChanged(record("borrower"));
		await borrower.start(forked.start as { cwd: string; resumeId: string });

		const resumeProc = new AdapterProcess();
		configureHappyServer(resumeProc, { threadId: STORED_REF.id });
		const resumed = new CodexAdapter(STORED_REF, { spawn: () => resumeProc, codexRoot: NO_STORE });
		resumed.onRefChanged(record("resumed"));
		await resumed.start({ cwd: "/workspace", resumeId: STORED_REF.id });

		expect(seen).toEqual([]);
		expect(parent.ref).toEqual({ backend: "codex", id: "thread-parent" });
	});

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

	it("repaints the fork's inherited transcript from pages, never a whole-history resume (OW-kelene)", async () => {
		const forkTurns = twoStoredTurns();
		const { proc, forked, borrower } = await forkedPair({ forkTurns });

		await borrower.start(forked.start as { cwd: string; resumeId: string });

		expect(request(proc, "thread/fork")["params"]).toMatchObject({ excludeTurns: true });
		expect(request(proc, "thread/resume")["params"]).toMatchObject({ threadId: "thread-forked", excludeTurns: true });
		expect(borrower.getState().messages).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "first prompt" }] },
			{ role: "user", content: [{ type: "text", text: "second prompt" }] },
		]);
		expect(await borrower.listForkPoints()).toEqual([
			{ id: "turn-first", text: "first prompt", index: 0 },
			{ id: "turn-second", text: "second prompt", index: 1 },
		]);
	});

	it("starts a fork at the model and effort the kept prefix's last turn ran at (D23)", async () => {
		// As of `codex-cli` 0.156.0 `thread/fork` carries neither: the fork, and a
		// resume of it on the app-server that minted it, answered the config's
		// defaults, and a turn sent on it naming no effort ran at the config's
		// (docs/MANUAL_TESTING.md, OW-sayaju). The fork's rollout holds only its
		// own records and names its parent's as its history (OW-buligi), ending
		// where the `lastTurnId` a fork at the second message sends ends, so the
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

	it("gives a notice naming no thread to every session on the connection, and one naming a thread to that thread's alone (OW-tujiya)", async () => {
		const { proc, parent, borrower, forked } = await forkedPair();
		await borrower.start(forked.start as { cwd: string; resumeId: string });
		const toParent = vi.fn();
		const toBorrower = vi.fn();
		parent.onNotice(toParent);
		borrower.onNotice(toBorrower);

		proc.emit({ method: "configWarning", params: { summary: "unknown key", details: null } });
		proc.emit({ method: "warning", params: { threadId: "thread-forked", message: "the fork's" } });
		proc.emit({ method: "warning", params: { threadId: "thread-parent", message: "the parent's" } });

		expect(toParent.mock.calls.map(([notice]) => notice.message)).toEqual(["unknown key", "the parent's"]);
		expect(toBorrower.mock.calls.map(([notice]) => notice.message)).toEqual(["unknown key", "the fork's"]);
	});

	it("gives a warning naming a thread no session drives to every session on the connection (OW-weyefe)", async () => {
		const { proc, parent, borrower, forked } = await forkedPair();
		await borrower.start(forked.start as { cwd: string; resumeId: string });
		const toParent = vi.fn();
		const toBorrower = vi.fn();
		parent.onNotice(toParent);
		borrower.onNotice(toBorrower);

		proc.emit({ method: "warning", params: { threadId: "thread-subagent", message: "a subagent's" } });
		proc.emit({ method: "guardianWarning", params: { threadId: "thread-subagent", message: "a subagent's guardian" } });
		proc.emit({ method: "guardianWarning", params: { threadId: "thread-forked", message: "the fork's guardian" } });

		expect(toParent.mock.calls.map(([notice]) => [notice.kind, notice.message])).toEqual([
			["warning", "a subagent's"],
			["guardianWarning", "a subagent's guardian"],
		]);
		expect(toBorrower.mock.calls.map(([notice]) => [notice.kind, notice.message])).toEqual([
			["warning", "a subagent's"],
			["guardianWarning", "a subagent's guardian"],
			["guardianWarning", "the fork's guardian"],
		]);
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

	describe("re-attaching a thread a live app-server holds (D34)", () => {
		// The re-attach of OW-voyezi: the fork's session is closed while the
		// parent keeps the app-server, and the thread it held may still be running
		// a turn. As of `codex-cli 0.170.0` the resume read such a thread
		// `{"type": "active"}` and named no turn (docs/MANUAL_TESTING.md,
		// ark3/agentpane#78), so that is what refuses the attach.

		/** A fork closed and re-attached over the parent's app-server, whose resume reads `resumeStatus`. */
		async function reattach(resumeStatus: { type: string; activeFlags?: string[] }) {
			const connections = new CodexConnectionRegistry();
			const proc = new AdapterProcess();
			shareableServer(proc, { forkTurns: twoStoredTurns(), resumeStatus });
			const spawn = vi.fn(() => proc);
			const parent = new CodexAdapter(VIRTUAL_REF, { spawn, codexRoot: NO_STORE, connections });
			await parent.start({ cwd: "/workspace" });
			await parent.listForkPoints();
			const forked = await parent.fork("turn-2");
			await forked.adapter?.dispose();
			let storeReads = 0;
			const reattached = new CodexAdapter(forked.ref, {
				spawn,
				connections,
				get codexRoot() {
					storeReads += 1;
					return NO_STORE;
				},
			});
			const before = proc.written.length;
			const started = await reattached.start({ cwd: "/workspace", resumeId: "thread-forked" }).then(
				() => null,
				(error: unknown) => error,
			);
			expect(spawn).toHaveBeenCalledTimes(1);
			const sent = proc.written.slice(before).map((message) => message["method"]);
			return { proc, reattached, started, sent, storeReads };
		}

		it("refuses turn_running when the resume reads the thread active, and hydrates nothing", async () => {
			const { reattached, started, sent, storeReads } = await reattach({ type: "active", activeFlags: [] });

			expect(started).toBeInstanceOf(TurnRunningError);
			expect(sent).toEqual(["thread/resume"]);
			expect(storeReads).toBe(0);
			expect(reattached.getState().messages).toEqual([]);
		});

		it("re-attaches and hydrates a thread whose resume reads it idle", async () => {
			const { reattached, started, sent, storeReads } = await reattach({ type: "idle" });

			expect(started).toBeNull();
			expect(sent).toEqual(["thread/resume", "thread/turns/list", "thread/turns/list"]);
			expect(storeReads).toBe(1);
			expect(reattached.getState()).toMatchObject({
				isStreaming: false,
				messages: [
					{ role: "user", content: [{ type: "text", text: "first prompt" }] },
					{ role: "user", content: [{ type: "text", text: "second prompt" }] },
				],
			});
		});

		it("names a delta for an item it never saw start, after a resume that read the thread idle (ark3/agentpane#79)", async () => {
			const { proc, reattached } = await reattach({ type: "idle" });
			const errors: string[] = [];
			reattached.onError((message) => errors.push(message));
			const delta = (itemId: string) =>
				proc.emit({ method: "item/agentMessage/delta", params: { threadId: "thread-forked", turnId: "t", itemId, delta: "x" } });

			delta("item-before-attach");
			delta("item-before-attach");

			expect(errors).toEqual([
				"codex sent item/agentMessage/delta for item item-before-attach, which started before a re-attach that read the thread idle; agentpane cannot show it",
			]);
		});

		it("says nothing of a delta for an item it saw start, nor for an unknown one once a turn has started", async () => {
			const { proc, reattached } = await reattach({ type: "idle" });
			const errors: string[] = [];
			reattached.onError((message) => errors.push(message));
			proc.emit({ method: "turn/started", params: { threadId: "thread-forked", turn: { id: "t", items: [], status: "inProgress" } } });
			proc.emit({
				method: "item/started",
				params: { threadId: "thread-forked", turnId: "t", startedAtMs: 1, item: { type: "agentMessage", id: "seen", text: "" } },
			});
			for (const itemId of ["seen", "unseen"]) {
				proc.emit({ method: "item/agentMessage/delta", params: { threadId: "thread-forked", turnId: "t", itemId, delta: "x" } });
			}

			expect(errors).toEqual([]);
		});

		it("says nothing of an unknown item's delta on a fork's first attach", async () => {
			const { proc, borrower, forked } = await forkedPair();
			await borrower.start(forked.start as { cwd: string; resumeId: string });
			const errors: string[] = [];
			borrower.onError((message) => errors.push(message));
			proc.emit({ method: "item/agentMessage/delta", params: { threadId: "thread-forked", turnId: "t", itemId: "unseen", delta: "x" } });

			expect(errors).toEqual([]);
		});

		it("does not refuse a fork's first attach, whatever its resume reads", async () => {
			const { borrower, forked } = await forkedPair({ resumeStatus: { type: "active", activeFlags: [] } });

			await expect(borrower.start(forked.start as { cwd: string; resumeId: string })).resolves.toBeUndefined();
		});
	});

	it("declines a blocking request once across both adapters, in the one it names", async () => {
		const { proc, parent, borrower, forked } = await forkedPair();
		await borrower.start(forked.start as { cwd: string; resumeId: string });
		const seen: string[] = [];
		parent.onError(() => seen.push("parent"));
		borrower.onError(() => seen.push("fork"));
		const before = responses(proc).length;
		proc.emit({
			id: 77,
			method: "item/fileChange/requestApproval",
			params: { threadId: "thread-parent", turnId: "t", itemId: "i", startedAtMs: 1 },
		});

		expect(seen).toEqual(["parent"]);
		expect(responses(proc).slice(before)).toEqual([{ id: 77, result: { decision: "decline" } }]);
	});

	it("routes a request for the fork's own thread to the fork alone", async () => {
		const { proc, parent, borrower, forked } = await forkedPair();
		await borrower.start(forked.start as { cwd: string; resumeId: string });
		const seen: string[] = [];
		parent.onError(() => seen.push("parent"));
		borrower.onError(() => seen.push("fork"));

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

		expect(responses(proc).slice(before)).toEqual([
			{ id: 79, error: { code: -32601, message: expect.stringContaining("item/tool/requestUserInput") } },
		]);
		expect(errors).toEqual([expect.stringContaining("item/tool/requestUserInput")]);
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
		// until `start()`. Close the parent before the fork has started and the
		// unstarted borrower would otherwise become the fallback recipient for a
		// thread nobody drives (D19's subagent): not started, so it can write no
		// refusal, and named to nobody -- D2a's silent stall, now pinning the
		// shared app-server too.
		const { proc, parent, borrower } = await forkedPair();
		const seen: string[] = [];
		parent.onError(() => seen.push("parent"));
		borrower.onError(() => seen.push("fork"));
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
		const grandchild = (await borrower.fork("turn-2")).adapter as CodexAdapter | undefined;
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
