/**
 * Drives the whole Pi process shell over a scripted fake child: argv, the
 * readiness handshake, command/response correlation, framing, the D2a
 * request/reply channel, and teardown. No subprocess, no model.
 *
 * `reducer.test.ts` already covers message assembly against the recorded
 * fixtures, so nothing here re-asserts transcript content -- these tests are
 * about the plumbing that file deliberately knows nothing about.
 *
 * The fake reproduces the child-process event contract exactly as verified on
 * this machine, which is load-bearing for the teardown tests: a failed spawn
 * emits `error` then `close` and **never** `exit`.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantTurn, PaneMessage, SessionRef } from "../../../shared/protocol.ts";
import { BackendRefusedError } from "../types.ts";
import { type PiChild, PiAdapter } from "./process.ts";

const REF: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/s.jsonl" };
const WORKSPACE = "/home/u/src/proj";

// ---------------------------------------------------------------------------
// Fake child
// ---------------------------------------------------------------------------

class FakeStream extends EventEmitter {
	setEncoding(): void {}
}

class FakeStdin {
	destroyed = false;
	endCalls = 0;
	chunks: string[] = [];
	write(chunk: string): boolean {
		this.chunks.push(chunk);
		return true;
	}
	end(): void {
		// Node raises ERR_STREAM_ALREADY_FINISHED on a second end(); a teardown
		// that can happen twice must not reach this twice.
		this.endCalls++;
		this.destroyed = true;
	}
}

class FakeChild extends EventEmitter {
	readonly stdout = new FakeStream();
	readonly stderr = new FakeStream();
	readonly stdin = new FakeStdin();
	killed = false;
	killCalls = 0;
	readonly signals: (string | undefined)[] = [];
	/** A real child closes when signalled; tests that need it not to clear this. */
	autoClose = true;
	kill(signal?: string): boolean {
		this.killed = true;
		this.killCalls++;
		this.signals.push(signal);
		if (this.autoClose) queueMicrotask(() => this.emit("close", 0, signal ?? "SIGTERM"));
		return true;
	}

	/** Everything the adapter has written to stdin, as parsed JSON lines. */
	sent(): Record<string, any>[] {
		return this.stdin.chunks
			.join("")
			.split("\n")
			.filter((l) => l.trim() !== "")
			.map((l) => JSON.parse(l));
	}

	/** The most recent command of a given type -- where its correlation `id` lives. */
	lastSent(type: string): Record<string, any> {
		const match = this.sent().filter((c) => c.type === type).at(-1);
		if (!match) throw new Error(`fake child was never sent a "${type}" command`);
		return match;
	}

	/** Feed raw stdout text, exactly as the real pipe would deliver it. */
	emitStdout(text: string): void {
		this.stdout.emit("data", text);
	}

	emitLine(obj: unknown): void {
		this.emitStdout(`${JSON.stringify(obj)}\n`);
	}

	/** Answer the pending command of `type` with a success payload. */
	respondTo(type: string, data?: unknown): void {
		const cmd = this.lastSent(type);
		this.emitLine({ id: cmd.id, type: "response", command: type, success: true, ...(data ? { data } : {}) });
	}

	failCommand(type: string, error: string): void {
		const cmd = this.lastSent(type);
		this.emitLine({ id: cmd.id, type: "response", command: type, success: false, error });
	}
}

interface Harness {
	adapter: PiAdapter;
	child: FakeChild;
	spawnArgs: { command: string; args: string[]; cwd: string }[];
	errors: string[];
}

function makeHarness(): Harness {
	const child = new FakeChild();
	const spawnArgs: Harness["spawnArgs"] = [];
	const adapter = new PiAdapter(REF, {
		spawn: (command, args, options) => {
			spawnArgs.push({ command, args, cwd: options.cwd });
			return child as unknown as PiChild;
		},
	});
	const errors: string[] = [];
	adapter.onError((m) => errors.push(m));
	return { adapter, child, spawnArgs, errors };
}

/**
 * `start()` writes its `get_state` probe synchronously, so the command is on
 * the wire before this awaits anything; answering it is what lets `start()`
 * resolve.
 */
async function startAdapter(h: Harness, extraState: Record<string, unknown> = {}): Promise<void> {
	const started = h.adapter.start({ cwd: WORKSPACE });
	h.child.respondTo("get_state", { model: null, isStreaming: false, ...extraState });
	await started;
}

const assistantMessage = (text: string): AgentMessage =>
	({ role: "assistant", content: [{ type: "text", text }] }) as AgentMessage;

const userMessage = (text: string): AgentMessage =>
	({ role: "user", content: [{ type: "text", text }] }) as AgentMessage;

// ---------------------------------------------------------------------------

describe("PiAdapter.start", () => {
	it("spawns the D7 command with the workspace as the process's real cwd, not just in argv", async () => {
		const h = makeHarness();
		await startAdapter(h);

		expect(h.spawnArgs).toHaveLength(1);
		const [spawned] = h.spawnArgs;
		expect(spawned?.command).toBe("direnv");
		expect(spawned?.args).toEqual(["exec", WORKSPACE, "sbox", "--", "pi", "--mode", "rpc"]);
		// The half that is easy to omit and silently jails the wrong tree: sbox
		// reads its workspace from the process cwd, not from argv (see spawn.ts).
		expect(spawned?.cwd).toBe(WORKSPACE);
	});

	it("reports the model accepted by the startup state probe", async () => {
		const h = makeHarness();
		await startAdapter(h, { model: { provider: "anthropic", id: "claude-haiku", name: "Haiku" } });

		expect(h.adapter.getState().model).toBe("anthropic/claude-haiku");
	});

	it("does not resolve until Pi answers the get_state probe", async () => {
		const h = makeHarness();
		let resolved = false;
		const started = h.adapter.start({ cwd: WORKSPACE }).then(() => {
			resolved = true;
		});

		expect(h.child.lastSent("get_state")).toBeTruthy();
		await Promise.resolve();
		expect(resolved).toBe(false); // spawning is not readiness

		h.child.respondTo("get_state", { model: null, isStreaming: false });
		await started;
		expect(resolved).toBe(true);
	});

	it("rejects rather than hanging when the spawn fails, where Node emits error+close but no exit", async () => {
		const h = makeHarness();
		const started = h.adapter.start({ cwd: WORKSPACE });

		// The exact ENOENT sequence verified against node:child_process: `error`,
		// then `close` with code -2, and no `exit` event at all. An adapter that
		// only listened for `exit` left this promise pending forever.
		h.child.emit("error", Object.assign(new Error("spawn direnv ENOENT"), { code: "ENOENT" }));
		h.child.emit("close", -2, null);

		await expect(started).rejects.toThrow(/Failed to spawn Pi \(direnv\)/);
	});

	it("attributes a spawn failure to the error event, not the meaningless exit code", async () => {
		const h = makeHarness();
		const started = h.adapter.start({ cwd: WORKSPACE }).catch(() => {});
		h.child.emit("error", new Error("spawn direnv ENOENT"));
		h.child.emit("close", -2, null);
		await started;

		expect(h.errors).toHaveLength(1);
		expect(h.errors[0]).toContain("ENOENT");
		expect(h.errors[0]).not.toContain("code=-2");
	});
});

describe("PiAdapter session identity (D9: Pi's id is its JSONL path)", () => {
	it("adopts the real session file Pi reports, replacing the placeholder id", async () => {
		const h = makeHarness();
		const virtualRef: SessionRef = { backend: "pi", id: "__new__" };
		const adapter = new PiAdapter(virtualRef, { spawn: () => h.child as unknown as PiChild });

		const started = adapter.start({ cwd: WORKSPACE });
		h.child.respondTo("get_state", {
			model: null,
			isStreaming: false,
			sessionFile: "/home/u/.pi/agent/sessions/real.jsonl",
		});
		await started;

		expect(adapter.ref.id).toBe("/home/u/.pi/agent/sessions/real.jsonl");
		expect(adapter.ref.backend).toBe("pi");
	});

	it("resolves the id after the first prompt when start's get_state named no file", async () => {
		const h = makeHarness();
		const adapter = new PiAdapter({ backend: "pi", id: "__new__" }, { spawn: () => h.child as unknown as PiChild });

		// Pi names the path at start as of `pi 0.84.1` (D9); a start that names
		// none is the case the post-submit probe stays for.
		const started = adapter.start({ cwd: WORKSPACE });
		h.child.respondTo("get_state", { model: null, isStreaming: false });
		await started;
		expect(adapter.ref.id).toBe("__new__");

		const submitted = adapter.submit("first prompt");
		h.child.respondTo("prompt");
		await Promise.resolve();
		h.child.respondTo("get_state", {
			model: null,
			isStreaming: false,
			sessionFile: "/home/u/.pi/agent/sessions/materialised.jsonl",
		});
		await submitted;

		expect(adapter.ref.id).toBe("/home/u/.pi/agent/sessions/materialised.jsonl");
	});

	it("still admits the turn when the follow-up id probe fails, because the prompt was accepted", async () => {
		// `submit()` resolving means "the backend admitted the turn" (the frozen
		// adapter contract), and the HTTP layer turns a rejection into a 500 that
		// tells the browser to preserve its draft for retry. The id probe runs
		// *after* Pi has accepted the prompt, so failing the submit on it would
		// invite the user to resend a prompt that is already running -- and the
		// resend would arrive mid-turn, where Pi steers it in as a second message.
		const h = makeHarness();
		const adapter = new PiAdapter(
			{ backend: "pi", id: "__new__" },
			{ spawn: () => h.child as unknown as PiChild },
		);
		const started = adapter.start({ cwd: WORKSPACE });
		h.child.respondTo("get_state", { model: null, isStreaming: false });
		await started;

		const submitted = adapter.submit("first prompt");
		h.child.respondTo("prompt");
		await Promise.resolve();
		h.child.failCommand("get_state", "session not ready");

		await expect(submitted).resolves.toBeUndefined();
		// Unresolved rather than wrongly resolved: the next prompt probes again.
		expect(adapter.ref.id).toBe("__new__");

		const second = adapter.submit("second prompt");
		h.child.respondTo("prompt");
		await Promise.resolve();
		h.child.respondTo("get_state", {
			model: null,
			isStreaming: false,
			sessionFile: "/home/u/.pi/agent/sessions/materialised.jsonl",
		});
		await second;
		expect(adapter.ref.id).toBe("/home/u/.pi/agent/sessions/materialised.jsonl");
	});

	it("stops re-probing once the id is known, so later prompts cost one round trip", async () => {
		const h = makeHarness();
		await startAdapter(h, { sessionFile: "/home/u/.pi/agent/sessions/known.jsonl" });

		const submitted = h.adapter.submit("hello");
		h.child.respondTo("prompt");
		await submitted;

		// One at start, and no follow-up probe after the prompt.
		expect(h.child.sent().filter((c) => c.type === "get_state")).toHaveLength(1);
	});
});

describe("PiAdapter cold start (D3)", () => {
	it("re-queries the transcript when resuming, so a resumed session is not blank", async () => {
		const h = makeHarness();
		const resumeId = "/home/u/.pi/agent/sessions/old.jsonl";

		const started = h.adapter.start({ cwd: WORKSPACE, resumeId });
		h.child.respondTo("get_state", { model: null, isStreaming: false, sessionFile: resumeId });
		await Promise.resolve();
		h.child.respondTo("get_messages", {
			messages: [assistantMessage("from a previous session"), assistantMessage("and another")],
		});
		h.child.respondTo("get_entries", { entries: [], leafId: null });
		h.child.respondTo("get_available_models", { models: [] });
		await started;

		// Nothing replays the events that built this transcript, so without the
		// refetch the session renders empty until the next turn.
		expect(h.adapter.getState().messages).toHaveLength(2);
	});

	it("does not refetch for a fresh session, which has nothing to fetch", async () => {
		const h = makeHarness();
		await startAdapter(h);

		expect(h.child.sent().some((c) => c.type === "get_messages")).toBe(false);
		expect(h.adapter.getState().messages).toEqual([]);
	});
});

describe("PiAdapter command correlation", () => {
	it("routes concurrent responses to their own callers even when they arrive out of order", async () => {
		const h = makeHarness();
		await startAdapter(h);

		// A fork point is paired with the user message it forks at (OW-roveze), so
		// the transcript has to hold one for the answer to be anything but empty.
		h.child.emitLine({ type: "message_start", message: userMessage("first prompt") });
		const models = h.adapter.listModels();
		const forkPoints = h.adapter.listForkPoints();

		const modelsCmd = h.child.lastSent("get_available_models");
		const forkCmd = h.child.lastSent("get_fork_messages");
		expect(modelsCmd.id).not.toBe(forkCmd.id);

		// Answer in the opposite order to make the id the only thing that can
		// be doing the routing.
		h.child.emitLine({
			id: forkCmd.id,
			type: "response",
			command: "get_fork_messages",
			success: true,
			data: { messages: [{ entryId: "e1", text: "first prompt" }] },
		});
		h.child.emitLine({
			id: modelsCmd.id,
			type: "response",
			command: "get_available_models",
			success: true,
			data: { models: [{ provider: "anthropic", id: "claude-opus-5", name: "Opus 5" }] },
		});

		expect(await forkPoints).toEqual([{ id: "e1", text: "first prompt", index: 0 }]);
		// ModelInfo.id is `provider/modelId` -- the bridge to Pi's split set_model.
		expect(await models).toEqual([{ id: "anthropic/claude-opus-5", label: "Opus 5", efforts: [], defaultEffort: null }]);
	});

	it("rejects the caller with Pi's own error text on success:false", async () => {
		const h = makeHarness();
		await startAdapter(h);

		const submitted = h.adapter.submit("hello");
		h.child.failCommand("prompt", "Agent is streaming; specify streamingBehavior");
		await expect(submitted).rejects.toThrow(/streamingBehavior/);
	});

	it("splits a model ref into provider and modelId for set_model", async () => {
		const h = makeHarness();
		await startAdapter(h);

		const done = h.adapter.setModel("anthropic/claude-opus-5");
		expect(h.child.lastSent("set_model")).toMatchObject({ provider: "anthropic", modelId: "claude-opus-5" });
		h.child.respondTo("set_model", { provider: "anthropic", id: "claude-opus-5", name: "Opus 5" });
		await done;
		expect(h.adapter.getState().model).toBe("anthropic/claude-opus-5");
	});

	/**
	 * Pi's `--model` flag takes `provider/modelId:thinkingLevel` and its
	 * `set_model` does not, so the pin's own form answered 500 "Model not
	 * found" (`pi 0.85.1`, 2026-09-16). The string still goes to Pi unchanged;
	 * only the refusal's message learns why.
	 */
	it("refuses a model Pi refuses, and names the level suffix when that is why (OW-pizaki)", async () => {
		const h = makeHarness();
		await startAdapter(h);

		const suffixed = h.adapter.setModel("openrouter/deepseek/deepseek-v4.1-flash:high");
		expect(h.child.lastSent("set_model")).toMatchObject({
			provider: "openrouter",
			modelId: "deepseek/deepseek-v4.1-flash:high",
		});
		h.child.failCommand("set_model", "Model not found: openrouter/deepseek/deepseek-v4.1-flash:high");
		const refusal = await suffixed.catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(BackendRefusedError);
		expect((refusal as Error).message).toContain("Model not found: openrouter/deepseek/deepseek-v4.1-flash:high");
		expect((refusal as Error).message).toContain('"provider/modelId"');
		expect((refusal as Error).message).toContain("effort");

		// A colon that is not a level is part of the id as far as anyone here
		// knows (`pi 0.87.1` lists `openrouter/anthropic/claude-fable-5:batch`),
		// so Pi's own words go through alone.
		for (const model of ["openrouter/anthropic/claude-fable-5:batch", "nobody/nothing"]) {
			const refused = h.adapter.setModel(model);
			h.child.failCommand("set_model", `Model not found: ${model}`);
			const error = await refused.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(BackendRefusedError);
			expect((error as Error).message).toBe(`Model not found: ${model}`);
		}

		const bare = h.adapter.setModel("deepseek-v4.1-flash");
		await expect(bare).rejects.toBeInstanceOf(BackendRefusedError);
		expect(h.child.sent().filter((c) => c.type === "set_model")).toHaveLength(3);
	});

	it("does not call a Pi that died before answering set_model a refusal (OW-pizaki)", async () => {
		const h = makeHarness();
		await startAdapter(h);

		const done = h.adapter.setModel("anthropic/claude-opus-5");
		h.child.emit("close", 1, null);
		const error = await done.catch((e: unknown) => e);
		expect((error as Error).message).toMatch(/before responding/);
		expect(error).not.toBeInstanceOf(BackendRefusedError);
	});

	it("sends a bare compact command and resolves on its response (OW-72)", async () => {
		const h = makeHarness();
		await startAdapter(h);
		const updates: ("requesting" | "running" | null)[] = [];
		h.adapter.onUpdate((state) => updates.push(state.compaction));

		const done = h.adapter.compact();
		// Pi's manual-compaction command is `{ type: "compact" }` and nothing
		// else (rpc.md; verified against 0.84.2). The summary rides the
		// compaction_end notification, not this response, so the adapter needs
		// only wait for the command to be acknowledged.
		const cmd = h.child.lastSent("compact");
		expect(cmd).toMatchObject({ type: "compact" });
		expect(Object.keys(cmd).sort()).toEqual(["id", "type"]);
		h.child.respondTo("compact", {
			summary: "folded",
			firstKeptEntryId: "e9",
			tokensBefore: 17660,
			estimatedTokensAfter: 4040,
		});
		await expect(done).resolves.toBeUndefined();
		expect(updates).toEqual(["requesting"]);
	});

	it("clears requesting when Pi rejects the compact command", async () => {
		const h = makeHarness();
		await startAdapter(h);
		const updates: ("requesting" | "running" | null)[] = [];
		h.adapter.onUpdate((state) => updates.push(state.compaction));
		const done = h.adapter.compact();
		h.child.failCommand("compact", "Nothing to compact");
		await expect(done).rejects.toThrow("Nothing to compact");
		expect(updates).toEqual(["requesting", null]);
	});
});

describe("PiAdapter stdout framing", () => {
	it("reassembles a JSON line split across chunk boundaries", async () => {
		const h = makeHarness();
		await startAdapter(h);
		const updates: number[] = [];
		h.adapter.onUpdate((_s, i) => updates.push(i ?? -1));

		const line = JSON.stringify({ type: "message_start", message: assistantMessage("hi") });
		h.child.emitStdout(line.slice(0, 20));
		expect(h.adapter.getState().messages).toHaveLength(0); // still partial
		h.child.emitStdout(`${line.slice(20)}\n`);

		expect(h.adapter.getState().messages).toHaveLength(1);
		expect(updates).toEqual([0]);
	});

	it("does not split a line on U+2028, which is valid inside a JSON string", async () => {
		const h = makeHarness();
		await startAdapter(h);

		// The node:readline trap HANDOFF warns about. Written as an escape here so
		// it survives editors, diffs and terminals, but it reaches the wire as a
		// literal character: JSON.stringify does not escape U+2028, so Pi really
		// can put one inside a string. readline would tear this line in half and
		// the JSON parse would fail.
		const LINE_SEPARATOR = "\u2028";
		const line = JSON.stringify({
			type: "message_start",
			message: assistantMessage(`before${LINE_SEPARATOR}after`),
		});
		expect(line).toContain(LINE_SEPARATOR); // the premise: literal, not escaped
		h.child.emitStdout(`${line}\n`);

		const [message] = h.adapter.getState().messages;
		expect(message).toBeDefined();
		expect(JSON.stringify(message)).toContain(LINE_SEPARATOR);
		expect(h.errors).toEqual([]);
	});

	it("reports a non-JSON line but keeps consuming the stream", async () => {
		const h = makeHarness();
		await startAdapter(h);

		h.child.emitStdout("this is not json\n");
		h.child.emitLine({ type: "message_start", message: assistantMessage("still here") });

		expect(h.errors).toHaveLength(1);
		expect(h.errors[0]).toContain("non-JSON");
		expect(h.adapter.getState().messages).toHaveLength(1);
	});
});

describe("PiAdapter notification fan-out", () => {
	it("emits streaming status and tail indices as a turn progresses", async () => {
		const h = makeHarness();
		await startAdapter(h);
		const seen: { streaming: boolean; index?: number }[] = [];
		h.adapter.onUpdate((s, i) => seen.push({ streaming: s.isStreaming, index: i }));

		h.child.emitLine({ type: "agent_start" });
		h.child.emitLine({ type: "message_start", message: assistantMessage("") });
		h.child.emitLine({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
		});
		h.child.emitLine({ type: "agent_settled" });

		expect(seen.map((s) => s.streaming)).toEqual([true, true, true, false]);
		expect(seen.map((s) => s.index)).toEqual([undefined, 0, 0, undefined]);
		expect(h.adapter.getState().isStreaming).toBe(false);
	});

	it("stays silent on notifications the reducer treats as no-ops", async () => {
		const h = makeHarness();
		await startAdapter(h);
		const onUpdate = vi.fn();
		h.adapter.onUpdate(onUpdate);

		h.child.emitLine({ type: "turn_start" });
		h.child.emitLine({ type: "queue_update", steering: [], followUp: [] });
		h.child.emitLine({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });

		expect(onUpdate).not.toHaveBeenCalled();
	});
});

describe("PiAdapter request/reply (D2a)", () => {
	it("publishes a dialog, cancels it under its own request id, retracts it, and names its method in an error (OW-yosuzo)", async () => {
		const h = makeHarness();
		await startAdapter(h);
		const requests: { requestId: string; kind: string }[] = [];
		const resolved: { requestId: string; answered: Record<string, any>[] }[] = [];
		const answered = () => h.child.sent().filter((c) => c.type === "extension_ui_response");
		h.adapter.onRequest((r) => requests.push({ requestId: r.requestId, kind: r.kind }));
		h.adapter.onRequestResolved((requestId) => resolved.push({ requestId, answered: answered() }));
		const reply = vi.spyOn(h.adapter, "reply");

		h.child.emitLine({
			type: "extension_ui_request",
			id: "ui-1",
			method: "confirm",
			title: "Run this?",
			message: "rm -rf build",
		});

		expect(requests).toEqual([{ requestId: "ui-1", kind: "confirm" }]);
		expect(reply).toHaveBeenCalledExactlyOnceWith("ui-1", null);
		// Correlates on the *request* id, not a fresh command id -- an
		// extension_ui_response is a reply, not a new command. Retracted once
		// the cancel is on the wire, not before.
		expect(resolved).toEqual([
			{ requestId: "ui-1", answered: [{ type: "extension_ui_response", id: "ui-1", cancelled: true }] },
		]);
		expect(h.errors).toEqual([expect.stringContaining("confirm")]);
	});

	it("cancels every dialog method, and a late reply finds nothing pending", async () => {
		const h = makeHarness();
		await startAdapter(h);

		h.child.emitLine({ type: "extension_ui_request", id: "s", method: "select", title: "Pick", options: ["a", "b"] });
		h.child.emitLine({ type: "extension_ui_request", id: "i", method: "input", title: "Name?" });
		h.child.emitLine({ type: "extension_ui_request", id: "e", method: "editor", title: "Edit", prefill: "x" });

		await expect(h.adapter.reply("s", "a")).rejects.toThrow(/No pending Pi UI request/);
		expect(h.child.sent().filter((c) => c.type === "extension_ui_response")).toEqual([
			{ type: "extension_ui_response", id: "s", cancelled: true },
			{ type: "extension_ui_response", id: "i", cancelled: true },
			{ type: "extension_ui_response", id: "e", cancelled: true },
		]);
		expect(h.errors).toEqual([
			expect.stringContaining("select"),
			expect.stringContaining("input"),
			expect.stringContaining("editor"),
		]);
	});

	it("does not surface fire-and-forget presentation methods as requests", async () => {
		const h = makeHarness();
		await startAdapter(h);
		const onRequest = vi.fn();
		const onResolved = vi.fn();
		h.adapter.onRequest(onRequest);
		h.adapter.onRequestResolved(onResolved);

		h.child.emitLine({ type: "extension_ui_request", id: "ui-2", method: "notify", message: "done" });

		expect(onRequest).not.toHaveBeenCalled();
		// Nothing to cancel and nothing to retract: a notify expects no reply.
		expect(onResolved).not.toHaveBeenCalled();
		expect(h.child.sent().filter((c) => c.type === "extension_ui_response")).toEqual([]);
		expect(h.errors).toEqual([]);
		await expect(h.adapter.reply("ui-2", "x")).rejects.toThrow(/No pending Pi UI request/);
	});

	it("does not fail on a dialog that arrives after dispose, when the cancel has no pipe to go to", async () => {
		const h = makeHarness();
		await startAdapter(h);
		h.child.autoClose = false;
		const requests = vi.fn();
		h.adapter.onRequest(requests);

		const disposing = h.adapter.dispose();
		// stdout is still delivering what Pi wrote before it saw the signal.
		h.child.emitLine({ type: "extension_ui_request", id: "ui-3", method: "confirm", title: "Late?", message: "" });
		await Promise.resolve();
		h.child.emit("close", 0, "SIGTERM");
		await disposing;

		expect(requests).toHaveBeenCalledOnce();
		expect(h.child.sent().filter((c) => c.type === "extension_ui_response")).toEqual([]);
	});
});

describe("PiAdapter fork points", () => {
	/**
	 * The pairing the client used to do, done where both lists are in hand
	 * (OW-roveze). Pi answers one entry per user message, so the k-th entry is
	 * the k-th user message, whatever sits between them.
	 */
	it("pairs each fork point with the transcript index of its user message (OW-roveze)", async () => {
		const h = makeHarness();
		await startAdapter(h);
		h.child.emitLine({ type: "message_start", message: userMessage("first prompt") });
		h.child.emitLine({ type: "message_start", message: assistantMessage("first answer") });
		h.child.emitLine({ type: "message_start", message: userMessage("second prompt") });

		const points = h.adapter.listForkPoints();
		h.child.respondTo("get_fork_messages", {
			messages: [
				{ entryId: "e1", text: "first prompt" },
				{ entryId: "e2", text: "second prompt" },
			],
		});

		expect(await points).toEqual([
			{ id: "e1", text: "first prompt", index: 0 },
			{ id: "e2", text: "second prompt", index: 2 },
		]);
	});

	/**
	 * Nothing here can say *where* two lists of different lengths diverged, and
	 * pairing the common prefix anyway is the silent mis-fork this change exists
	 * to remove. Answering with nothing costs every Edit control, which is
	 * visible and recoverable; forking a turn away from where the user pointed is
	 * neither (OW-roveze).
	 */
	it("answers with no points at all when the two lists disagree on length (OW-roveze)", async () => {
		const h = makeHarness();
		await startAdapter(h);
		h.child.emitLine({ type: "message_start", message: userMessage("only prompt") });

		const points = h.adapter.listForkPoints();
		h.child.respondTo("get_fork_messages", {
			messages: [
				{ entryId: "e1", text: "only prompt" },
				{ entryId: "e2", text: "a prompt the transcript does not have" },
			],
		});

		expect(await points).toEqual([]);
	});
});

describe("PiAdapter.fork", () => {
	it("re-adopts the moved active file and refetches the whole transcript as a snapshot", async () => {
		const h = makeHarness();
		await startAdapter(h, { model: { provider: "anthropic", id: "claude-haiku", name: "Haiku" } });
		const seen: (number | undefined)[] = [];
		h.adapter.onUpdate((_s, i) => seen.push(i));

		// Pi's fork is copy-on-write: the process's active sessionFile moves to a
		// new file at the fork call (settled live on 0.84.2, MANUAL_TESTING.md
		// OW-pifowo). The adapter re-queries get_state and adopts that moved file.
		const MOVED = "/home/u/.pi/agent/sessions/s-fork.jsonl";
		const forked = h.adapter.fork("e1");
		h.child.respondTo("fork", { text: "original prompt", cancelled: false });
		await Promise.resolve();
		h.child.respondTo("get_state", { model: null, isStreaming: false, sessionFile: MOVED });
		await Promise.resolve();
		h.child.respondTo("get_messages", { messages: [assistantMessage("rewound")] });
		h.child.respondTo("get_entries", { entries: [], leafId: null });
		h.child.respondTo("get_available_models", { models: [] });

		// No `start`: the fork IS the file this live process is already writing.
		expect(await forked).toEqual({ ref: { backend: "pi", id: MOVED } }); // moved file, NOT REF
		expect(h.adapter.ref).toEqual({ backend: "pi", id: MOVED });
		expect(h.adapter.getState().messages).toHaveLength(1);
		expect(h.adapter.getState().model).toBe("anthropic/claude-haiku");
		// changedIndex omitted: a fork touches the whole transcript (D3).
		expect(seen).toEqual([undefined]);
	});

	it("holds the rewound branch alone when the abandoned turn streams in the window before get_messages answers (OW-dutute)", async () => {
		// A fork truncates (OW-yudoni, OW-sededi), so the merge D24 asks of a
		// hydrate keeps nothing of the parent's in-flight turn. As of `pi 0.87.1`
		// nothing arrived in this window at all: the abandoned turn's last
		// events all preceded the `fork` response (docs/MANUAL_TESTING.md,
		// OW-dutute). This scripts the window anyway, since a union would let
		// the parent's partial reply into the fork's transcript.
		const h = makeHarness();
		await startAdapter(h);
		const delta = (text: string) => ({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
		});
		for (const message of [userMessage("Say ALPHA"), assistantMessage("ALPHA"), userMessage("Count to 400")]) {
			h.child.emitLine({ type: "message_start", message });
			h.child.emitLine({ type: "message_end", message });
		}
		h.child.emitLine({ type: "agent_start" });
		h.child.emitLine({ type: "message_start", message: assistantMessage("") });
		h.child.emitLine(delta("1\n"));
		expect(h.adapter.getState().messages).toHaveLength(4);

		const forked = h.adapter.fork("e-count");
		h.child.respondTo("fork", { text: "Count to 400", cancelled: false });
		h.child.emitLine(delta("2\n"));
		await Promise.resolve();
		h.child.respondTo("get_state", { model: null, isStreaming: false, messageCount: 2 });
		h.child.emitLine(delta("3\n"));
		// Both reached the parent's partial reply, which the hydrate then drops.
		expect(h.adapter.getState().messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "1\n2\n3\n" }] });
		await Promise.resolve();
		h.child.respondTo("get_messages", { messages: [userMessage("Say ALPHA"), assistantMessage("ALPHA")] });
		h.child.respondTo("get_entries", { entries: [], leafId: null });
		h.child.respondTo("get_available_models", { models: [] });
		await forked;

		expect(h.adapter.getState().messages).toEqual([userMessage("Say ALPHA"), assistantMessage("ALPHA")]);
		expect(h.adapter.getState().isStreaming).toBe(false);
	});

	it("rejects when an extension vetoes the fork, which Pi reports as success:true", async () => {
		const h = makeHarness();
		await startAdapter(h);

		const forked = h.adapter.fork("e1");
		h.child.respondTo("fork", { text: "original prompt", cancelled: true });

		await expect(forked).rejects.toThrow(/cancelled by an extension/);
		// The veto must not leave us claiming a rewind happened.
		expect(h.child.sent().some((c) => c.type === "get_messages")).toBe(false);
	});
});

describe("PiAdapter reasoning effort (OW-ruzuhu)", () => {
	// The shape `get_available_models` answered for the pinned model on
	// `pi 0.87.1` (docs/MANUAL_TESTING.md, OW-ruzuhu): `null` marks a level the
	// model lacks, and `xhigh`/`max` exist only where the map names them.
	const FLASH = {
		provider: "openrouter",
		id: "deepseek/deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		reasoning: true,
		thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
	};
	/** A reasoning model with no `off`, like `openrouter/anthropic/claude-fable-5` on 0.87.1. */
	const NO_OFF = {
		provider: "openrouter",
		id: "anthropic/claude-fable-5",
		name: "Fable 5",
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	};
	const PLAIN = { provider: "openrouter", id: "openai/plain", name: "Plain", reasoning: false };

	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
	const ids = (efforts: { id: string }[]) => efforts.map((effort) => effort.id);

	it("offers each model the levels Pi would, from its reasoning flag and thinkingLevelMap", async () => {
		const h = makeHarness();
		await startAdapter(h);

		const models = h.adapter.listModels();
		h.child.respondTo("get_available_models", { models: [FLASH, NO_OFF, PLAIN] });
		const [flash, noOff, plain] = await models;

		expect(ids(flash?.efforts ?? [])).toEqual(["off", "low", "high", "max"]);
		expect(ids(noOff?.efforts ?? [])).toEqual(["low", "medium", "high", "xhigh", "max"]);
		// Pi answers `["off"]` for a model that does not reason: nothing to choose.
		expect(plain?.efforts).toEqual([]);
		// What Pi picks for a model comes from settings.json, which the catalogue does not carry.
		expect([flash, noOff, plain].map((model) => model?.defaultEffort)).toEqual([null, null, null]);
	});

	it("reports the level get_state names, and none for a model that does not reason", async () => {
		const reasoning = makeHarness();
		await startAdapter(reasoning, { model: FLASH, thinkingLevel: "high" });
		expect(reasoning.adapter.getState().effort).toBe("high");

		const plain = makeHarness();
		await startAdapter(plain, { model: PLAIN, thinkingLevel: "off" });
		expect(plain.adapter.getState().effort).toBeNull();
	});

	it("sends the chosen level to Pi as set_thinking_level before the first prompt", async () => {
		const h = makeHarness();
		await startAdapter(h, { model: FLASH, thinkingLevel: "high", sessionFile: REF.id });

		const set = h.adapter.setEffort("low");
		expect(h.child.lastSent("set_thinking_level")).toMatchObject({ level: "low" });
		// Pi announces the change before it answers the command.
		h.child.emitLine({ type: "thinking_level_changed", level: "low" });
		h.child.respondTo("set_thinking_level");
		await set;

		const submitted = h.adapter.submit("hello");
		h.child.respondTo("prompt");
		await submitted;

		const order = h.child.sent().map((command) => command.type);
		expect(order.indexOf("set_thinking_level")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("set_thinking_level")).toBeLessThan(order.indexOf("prompt"));
		expect(h.adapter.getState().effort).toBe("low");
	});

	it("follows the level Pi reports, whatever changed it", async () => {
		const h = makeHarness();
		await startAdapter(h, { model: FLASH, thinkingLevel: "high" });
		const seen: (string | null)[] = [];
		h.adapter.onUpdate((state) => seen.push(state.effort));

		h.child.emitLine({ type: "thinking_level_changed", level: "max" });

		expect(seen).toEqual(["max"]);
		expect(h.adapter.getState().effort).toBe("max");
	});

	it("re-asserts the chosen level after set_model, which Pi resets from its settings", async () => {
		const h = makeHarness();
		await startAdapter(h, { model: FLASH, thinkingLevel: "high" });
		const set = h.adapter.setEffort("off");
		h.child.emitLine({ type: "thinking_level_changed", level: "off" });
		h.child.respondTo("set_thinking_level");
		await set;

		const changed = h.adapter.setModel("openrouter/deepseek/deepseek-v4.1-flash");
		const levelsSent = () => h.child.sent().filter((command) => command.type === "set_thinking_level");
		await flush();
		// Not before Pi answers: a resend that raced `set_model` would be undone by it.
		expect(levelsSent()).toHaveLength(1);
		// Measured on 0.87.1: with `modelThinkingLevels` naming `high` for this
		// model, `set_model` put the level back to `high`.
		h.child.emitLine({ type: "thinking_level_changed", level: "high" });
		h.child.respondTo("set_model", FLASH);
		await flush();
		expect(h.child.sent().filter((command) => command.type === "set_thinking_level").map((command) => command.level)).toEqual(["off", "off"]);
		h.child.emitLine({ type: "thinking_level_changed", level: "off" });
		h.child.respondTo("set_thinking_level");
		await changed;

		expect(h.adapter.getState().effort).toBe("off");
	});

	it("keeps Pi's own level after set_model to a model that does not list the chosen one", async () => {
		const h = makeHarness();
		await startAdapter(h, { model: FLASH, thinkingLevel: "high" });
		const set = h.adapter.setEffort("off");
		h.child.emitLine({ type: "thinking_level_changed", level: "off" });
		h.child.respondTo("set_thinking_level");
		await set;

		const changed = h.adapter.setModel("openrouter/anthropic/claude-fable-5");
		// Pi clamps `off` to the new model's lowest level.
		h.child.emitLine({ type: "thinking_level_changed", level: "low" });
		h.child.respondTo("set_model", NO_OFF);
		await changed;

		expect(h.child.sent().filter((command) => command.type === "set_thinking_level")).toHaveLength(1);
		expect(h.adapter.getState().effort).toBe("low");
	});

	it("never pairs the old model with the level set_model resets to (OW-zasozo)", async () => {
		const h = makeHarness();
		await startAdapter(h, { model: FLASH, thinkingLevel: "high" });
		const seen: [string | null, string | null][] = [];
		h.adapter.onUpdate((state) => seen.push([state.model, state.effort]));

		const changed = h.adapter.setModel("openrouter/anthropic/claude-fable-5");
		// On 0.87.1 Pi announces the reset before it answers `set_model`.
		h.child.emitLine({ type: "thinking_level_changed", level: "medium" });
		// Any other update in that window carries the effort too.
		h.child.emitLine({ type: "agent_start" });
		h.child.emitLine({ type: "message_start", message: assistantMessage("") });
		h.child.respondTo("set_model", NO_OFF);
		await changed;

		const flash = "openrouter/deepseek/deepseek-v4.1-flash";
		const fable = "openrouter/anthropic/claude-fable-5";
		// FLASH has no `medium` at all.
		expect(seen.filter(([model, effort]) => model === flash && effort !== "high")).toEqual([]);
		expect(seen.at(-1)).toEqual([fable, "medium"]);
	});

	it("reports the new model's level while the chosen one is re-sent (OW-zasozo)", async () => {
		const h = makeHarness();
		await startAdapter(h, { model: FLASH, thinkingLevel: "high" });
		const set = h.adapter.setEffort("low");
		h.child.emitLine({ type: "thinking_level_changed", level: "low" });
		h.child.respondTo("set_thinking_level");
		await set;
		// An extension moves the level away from the one chosen.
		h.child.emitLine({ type: "thinking_level_changed", level: "max" });
		const seen: [string | null, string | null][] = [];
		h.adapter.onUpdate((state) => seen.push([state.model, state.effort]));

		const changed = h.adapter.setModel("openrouter/anthropic/claude-fable-5");
		h.child.emitLine({ type: "thinking_level_changed", level: "medium" });
		h.child.respondTo("set_model", NO_OFF);
		await flush();
		// An update while the re-sent `low` is still in flight.
		h.child.emitLine({ type: "agent_start" });
		h.child.emitLine({ type: "thinking_level_changed", level: "low" });
		h.child.respondTo("set_thinking_level");
		await changed;

		const fable = "openrouter/anthropic/claude-fable-5";
		expect(seen.filter(([model]) => model === fable)).toEqual([
			[fable, "medium"],
			[fable, "low"],
			[fable, "low"],
		]);
	});

	it("reports a level that changed while a refused set_model was in flight (OW-zasozo)", async () => {
		const h = makeHarness();
		await startAdapter(h, { model: FLASH, thinkingLevel: "high" });
		const seen: [string | null, string | null][] = [];
		h.adapter.onUpdate((state) => seen.push([state.model, state.effort]));

		const refused = h.adapter.setModel("openrouter/anthropic/claude-fable-5");
		// A `set_thinking_level` sent alongside lands on the old model.
		h.child.emitLine({ type: "thinking_level_changed", level: "max" });
		h.child.failCommand("set_model", "No API key for openrouter");
		await expect(refused).rejects.toBeInstanceOf(BackendRefusedError);

		expect(h.adapter.getState().effort).toBe("max");
		expect(seen).toEqual([["openrouter/deepseek/deepseek-v4.1-flash", "max"]]);
	});

	it("follows Pi's level again after it refuses a set_model (OW-zasozo)", async () => {
		const h = makeHarness();
		await startAdapter(h, { model: FLASH, thinkingLevel: "high" });

		const refused = h.adapter.setModel("openrouter/nope/nothing");
		h.child.failCommand("set_model", "Model not found: openrouter/nope/nothing");
		await expect(refused).rejects.toBeInstanceOf(BackendRefusedError);
		h.child.emitLine({ type: "thinking_level_changed", level: "max" });

		expect(h.adapter.getState().effort).toBe("max");
	});

	it("names the level in force on each assistant turn, which the footer shows", async () => {
		const h = makeHarness();
		await startAdapter(h, { model: FLASH, thinkingLevel: "high" });
		const set = h.adapter.setEffort("low");
		h.child.emitLine({ type: "thinking_level_changed", level: "low" });
		h.child.respondTo("set_thinking_level");
		await set;

		h.child.emitLine({ type: "agent_start" });
		h.child.emitLine({ type: "message_start", message: userMessage("hello") });
		h.child.emitLine({ type: "message_end", message: userMessage("hello") });
		h.child.emitLine({ type: "message_start", message: assistantMessage("") });
		h.child.emitLine({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
		});
		const streamed = h.adapter.getState().messages[1] as AssistantTurn;
		h.child.emitLine({ type: "message_end", message: assistantMessage("hi") });
		h.child.emitLine({ type: "agent_settled" });

		const [user, assistant] = h.adapter.getState().messages as PaneMessage[];
		expect(streamed.effort).toBe("low");
		expect((assistant as AssistantTurn).effort).toBe("low");
		expect(user).not.toHaveProperty("effort");
	});

	it("adopts the level get_state reports after a fork", async () => {
		const h = makeHarness();
		await startAdapter(h, { model: PLAIN, thinkingLevel: "off" });

		const forked = h.adapter.fork("e1");
		h.child.respondTo("fork", { text: "original prompt", cancelled: false });
		await flush();
		h.child.respondTo("get_state", { model: FLASH, thinkingLevel: "max", isStreaming: false });
		await flush();
		h.child.respondTo("get_messages", { messages: [] });
		h.child.respondTo("get_entries", { entries: [], leafId: null });
		h.child.respondTo("get_available_models", { models: [] });
		await forked;

		expect(h.adapter.getState().effort).toBe("max");
	});

	it("re-asserts the chosen level after a fork, which puts a suffixed --model's level back (OW-dojebo)", async () => {
		const h = makeHarness();
		const started = h.adapter.start({ cwd: WORKSPACE, model: "openrouter/deepseek/deepseek-v4.1-flash:high" });
		h.child.respondTo("get_state", { model: FLASH, thinkingLevel: "high", isStreaming: false, sessionFile: REF.id });
		await started;
		const set = h.adapter.setEffort("off");
		h.child.emitLine({ type: "thinking_level_changed", level: "off" });
		h.child.respondTo("set_thinking_level");
		await set;

		const forked = h.adapter.fork("e1");
		h.child.respondTo("fork", { text: "original prompt", cancelled: false });
		await flush();
		// Measured on 0.87.1: the fork rebuilds the session from the spawn's
		// command line, so the suffix's `high` is in force again, announced by no
		// event and recorded nowhere.
		h.child.respondTo("get_state", { model: FLASH, thinkingLevel: "high", isStreaming: false, sessionFile: "/home/u/.pi/agent/sessions/s-fork.jsonl" });
		await flush();
		expect(h.child.sent().filter((command) => command.type === "set_thinking_level").map((command) => command.level)).toEqual(["off", "off"]);
		h.child.emitLine({ type: "thinking_level_changed", level: "off" });
		h.child.respondTo("set_thinking_level");
		await flush();
		h.child.respondTo("get_messages", { messages: [] });
		h.child.respondTo("get_entries", { entries: [], leafId: null });
		h.child.respondTo("get_available_models", { models: [] });
		await forked;

		expect(h.adapter.getState().effort).toBe("off");
	});

	it("re-asserts the chosen model, then the chosen level, after a fork, which puts the spawn's --model back (OW-sinoha)", async () => {
		const SPAWNED = { provider: "openrouter", id: "google/gemini-2.5-flash-lite", name: "Flash Lite", reasoning: true };
		const h = makeHarness();
		const started = h.adapter.start({ cwd: WORKSPACE, model: "openrouter/google/gemini-2.5-flash-lite" });
		h.child.respondTo("get_state", { model: SPAWNED, thinkingLevel: "medium", isStreaming: false, sessionFile: REF.id });
		await started;
		const changed = h.adapter.setModel("openrouter/deepseek/deepseek-v4.1-flash");
		h.child.emitLine({ type: "thinking_level_changed", level: "high" });
		h.child.respondTo("set_model", FLASH);
		await changed;
		const set = h.adapter.setEffort("low");
		h.child.emitLine({ type: "thinking_level_changed", level: "low" });
		h.child.respondTo("set_thinking_level");
		await set;

		const forked = h.adapter.fork("u2");
		h.child.respondTo("fork", { text: "original prompt", cancelled: false });
		await flush();
		// Measured on 0.87.1: the fork rebuilds the session from the spawn's
		// command line, so its `--model` is in force again, announced by no event
		// and recorded nowhere, while the chosen level survives it.
		h.child.respondTo("get_state", { model: SPAWNED, thinkingLevel: "low", isStreaming: false, sessionFile: "/home/u/.pi/agent/sessions/s-fork.jsonl" });
		await flush();
		expect(h.child.lastSent("set_model")).toMatchObject({ provider: "openrouter", modelId: "deepseek/deepseek-v4.1-flash" });
		expect(h.child.sent().filter((command) => command.type === "set_model")).toHaveLength(2);
		// And `set_model` puts the level back to the settings default, as it did live.
		h.child.emitLine({ type: "thinking_level_changed", level: "high" });
		h.child.respondTo("set_model", FLASH);
		await flush();
		const afterFork = h.child.sent().slice(h.child.sent().findIndex((command) => command.type === "fork"));
		expect(afterFork.map((command) => command.type).filter((type) => type.startsWith("set_"))).toEqual(["set_model", "set_thinking_level"]);
		expect(h.child.lastSent("set_thinking_level")).toMatchObject({ level: "low" });
		h.child.emitLine({ type: "thinking_level_changed", level: "low" });
		h.child.respondTo("set_thinking_level");
		await flush();
		const u1 = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };
		const a1 = { role: "assistant", content: [{ type: "text", text: "ok" }], provider: FLASH.provider, model: FLASH.id, timestamp: 2 };
		h.child.respondTo("get_messages", { messages: [u1, a1] });
		h.child.respondTo("get_entries", {
			entries: [
				{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-24T10:00:00.000Z", provider: SPAWNED.provider, modelId: SPAWNED.id },
				{ type: "model_change", id: "m2", parentId: "m1", timestamp: "2026-09-24T10:00:00.000Z", provider: FLASH.provider, modelId: FLASH.id },
				{ type: "message", id: "u1", parentId: "m2", timestamp: "2026-09-24T10:00:01.000Z", message: u1 },
				{ type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-24T10:00:02.000Z", message: a1 },
			],
			leafId: "a1",
		});
		h.child.respondTo("get_available_models", { models: [FLASH, SPAWNED] });
		await forked;

		expect(h.adapter.getState()).toMatchObject({ model: "openrouter/deepseek/deepseek-v4.1-flash", effort: "low", unrestoredModel: null });
	});

	it("still completes a fork whose re-sent model is refused, naming the chosen model as unrestored (OW-sinoha)", async () => {
		const SPAWNED = { provider: "openrouter", id: "google/gemini-2.5-flash-lite", name: "Flash Lite", reasoning: true };
		const h = makeHarness();
		const started = h.adapter.start({ cwd: WORKSPACE, model: "openrouter/google/gemini-2.5-flash-lite" });
		h.child.respondTo("get_state", { model: SPAWNED, thinkingLevel: "medium", isStreaming: false, sessionFile: REF.id });
		await started;
		const changed = h.adapter.setModel("openrouter/deepseek/deepseek-v4.1-flash");
		h.child.emitLine({ type: "thinking_level_changed", level: "high" });
		h.child.respondTo("set_model", FLASH);
		await changed;
		const set = h.adapter.setEffort("low");
		h.child.emitLine({ type: "thinking_level_changed", level: "low" });
		h.child.respondTo("set_thinking_level");
		await set;

		const forked = h.adapter.fork("u2");
		h.child.respondTo("fork", { text: "original prompt", cancelled: false });
		await flush();
		h.child.respondTo("get_state", { model: SPAWNED, thinkingLevel: "medium", isStreaming: false, sessionFile: "/home/u/.pi/agent/sessions/s-fork.jsonl" });
		await flush();
		// The chosen model left the catalogue or lost its auth since it was chosen.
		h.child.failCommand("set_model", "Model not found: openrouter/deepseek/deepseek-v4.1-flash");
		await flush();
		// The chosen level still goes to the model actually in force.
		expect(h.child.lastSent("set_thinking_level")).toMatchObject({ level: "low" });
		expect(h.child.sent().filter((command) => command.type === "set_thinking_level")).toHaveLength(2);
		h.child.emitLine({ type: "thinking_level_changed", level: "low" });
		h.child.respondTo("set_thinking_level");
		await flush();
		const u1 = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };
		const a1 = { role: "assistant", content: [{ type: "text", text: "rewound" }], provider: FLASH.provider, model: FLASH.id, timestamp: 2 };
		h.child.respondTo("get_messages", { messages: [u1, a1] });
		h.child.respondTo("get_entries", {
			entries: [
				{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-24T10:00:00.000Z", provider: SPAWNED.provider, modelId: SPAWNED.id },
				{ type: "model_change", id: "m2", parentId: "m1", timestamp: "2026-09-24T10:00:00.000Z", provider: FLASH.provider, modelId: FLASH.id },
				{ type: "message", id: "u1", parentId: "m2", timestamp: "2026-09-24T10:00:01.000Z", message: u1 },
				{ type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-24T10:00:02.000Z", message: a1 },
			],
			leafId: "a1",
		});
		h.child.respondTo("get_available_models", { models: [SPAWNED] });
		await expect(forked).resolves.toEqual({ ref: { backend: "pi", id: "/home/u/.pi/agent/sessions/s-fork.jsonl" } });

		expect(h.adapter.getState()).toMatchObject({
			model: "openrouter/google/gemini-2.5-flash-lite",
			effort: "low",
			unrestoredModel: "openrouter/deepseek/deepseek-v4.1-flash",
		});
		expect(h.adapter.getState().messages).toHaveLength(2);
	});

	it("re-asserts the parent's model, then its level, after a resumed session's fork that keeps no message (OW-riyeku)", async () => {
		const DEFAULT = { provider: "openrouter", id: "google/gemini-2.5-flash-lite", name: "Flash Lite", reasoning: true };
		const u1 = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };
		const a1 = { role: "assistant", content: [{ type: "text", text: "ok" }], provider: FLASH.provider, model: FLASH.id, timestamp: 2 };
		const recorded = [
			{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-24T10:00:00.000Z", provider: FLASH.provider, modelId: FLASH.id },
			{ type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2026-09-24T10:00:00.000Z", thinkingLevel: "high" },
		];
		const h = makeHarness();
		// A resume spawn carries no `--model`, so nothing is chosen in this process.
		const started = h.adapter.start({ cwd: WORKSPACE, resumeId: REF.id });
		h.child.respondTo("get_state", { model: FLASH, thinkingLevel: "high", isStreaming: false, sessionFile: REF.id, messageCount: 2 });
		await flush();
		h.child.respondTo("get_messages", { messages: [u1, a1] });
		h.child.respondTo("get_entries", {
			entries: [
				...recorded,
				{ type: "message", id: "u1", parentId: "t1", timestamp: "2026-09-24T10:00:01.000Z", message: u1 },
				{ type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-24T10:00:02.000Z", message: a1 },
			],
			leafId: "a1",
		});
		h.child.respondTo("get_available_models", { models: [FLASH, DEFAULT] });
		await started;

		const forked = h.adapter.fork("u1");
		h.child.respondTo("fork", { text: "hi", cancelled: false });
		await flush();
		// Measured on 0.87.1: a fork at the first user message of a session file
		// holding no system message keeps no message, and Pi rebuilds it at the
		// settings default model and level, announced by no event.
		h.child.respondTo("get_state", { model: DEFAULT, thinkingLevel: "low", isStreaming: false, sessionFile: "/home/u/.pi/agent/sessions/s-fork.jsonl", messageCount: 0 });
		await flush();
		expect(h.child.sent().filter((command) => command.type === "set_model")).toEqual([
			expect.objectContaining({ provider: FLASH.provider, modelId: FLASH.id }),
		]);
		// With no `modelThinkingLevels` entry for it, `set_model` kept `low`, as it did live.
		h.child.respondTo("set_model", FLASH);
		await flush();
		expect(h.child.lastSent("set_thinking_level")).toMatchObject({ level: "high" });
		h.child.emitLine({ type: "thinking_level_changed", level: "high" });
		h.child.respondTo("set_thinking_level");
		await flush();
		h.child.respondTo("get_messages", { messages: [] });
		h.child.respondTo("get_entries", {
			entries: [
				...recorded,
				{ type: "model_change", id: "m2", parentId: "t1", timestamp: "2026-09-24T10:01:00.000Z", provider: DEFAULT.provider, modelId: DEFAULT.id },
				{ type: "thinking_level_change", id: "t2", parentId: "m2", timestamp: "2026-09-24T10:01:00.000Z", thinkingLevel: "low" },
				{ type: "model_change", id: "m3", parentId: "t2", timestamp: "2026-09-24T10:01:01.000Z", provider: FLASH.provider, modelId: FLASH.id },
				{ type: "thinking_level_change", id: "t3", parentId: "m3", timestamp: "2026-09-24T10:01:01.000Z", thinkingLevel: "high" },
			],
			leafId: "t3",
		});
		h.child.respondTo("get_available_models", { models: [FLASH, DEFAULT] });
		await forked;

		expect(h.adapter.getState()).toMatchObject({ model: "openrouter/deepseek/deepseek-v4.1-flash", effort: "high", unrestoredModel: null });
	});

	it("keeps the level a turn started at when the level changes before it ends", async () => {
		const h = makeHarness();
		await startAdapter(h, { model: FLASH, thinkingLevel: "low" });

		h.child.emitLine({ type: "message_start", message: assistantMessage("") });
		// A direct POST .../effort, or an extension, while the turn streams.
		h.child.emitLine({ type: "thinking_level_changed", level: "high" });
		h.child.emitLine({ type: "message_end", message: assistantMessage("hi") });

		expect((h.adapter.getState().messages[0] as AssistantTurn).effort).toBe("low");
		expect(h.adapter.getState().effort).toBe("high");
	});

	it("names no level on the turns of a model that does not reason", async () => {
		const h = makeHarness();
		await startAdapter(h, { model: PLAIN, thinkingLevel: "off" });

		h.child.emitLine({ type: "message_start", message: assistantMessage("") });
		h.child.emitLine({ type: "message_end", message: assistantMessage("hi") });

		expect(h.adapter.getState().messages[0]).not.toHaveProperty("effort");
	});

	/**
	 * A turn loaded by `get_messages` carries no level, so its label is read
	 * from the session file's `thinking_level_change` entries (OW-helumu): the
	 * level in force when the turn ran, not the one in force now.
	 */
	describe("on loaded turns (OW-helumu)", () => {
		const T0 = Date.parse("2026-09-23T10:00:00.000Z");
		const at = (seconds: number) => T0 + seconds * 1000;
		type Model = { provider: string; id: string };
		const reply = (text: string, timestamp: number, model: Model = FLASH): AgentMessage =>
			({ role: "assistant", content: [{ type: "text", text }], provider: model.provider, model: model.id, timestamp }) as AgentMessage;
		const prompt = (text: string, timestamp: number): AgentMessage =>
			({ role: "user", content: [{ type: "text", text }], timestamp }) as AgentMessage;
		const entry = (id: string, parentId: string | null, seconds: number, fields: Record<string, unknown>) => ({
			id,
			parentId,
			timestamp: new Date(at(seconds)).toISOString(),
			...fields,
		});
		const level = (id: string, parentId: string | null, seconds: number, thinkingLevel: string) =>
			entry(id, parentId, seconds, { type: "thinking_level_change", thinkingLevel });
		const message = (id: string, parentId: string | null, m: AgentMessage) =>
			entry(id, parentId, (m.timestamp - T0) / 1000, { type: "message", message: m });
		const efforts = (h: Harness) =>
			(h.adapter.getState().messages as PaneMessage[]).map((m) => (m.role === "assistant" ? m.effort : m.role));

		async function resume(h: Harness, state: Record<string, unknown>, messages: AgentMessage[], entries: unknown[], leafId: string) {
			const started = h.adapter.start({ cwd: WORKSPACE, resumeId: REF.id });
			h.child.respondTo("get_state", { isStreaming: false, sessionFile: REF.id, ...state });
			await flush();
			h.child.respondTo("get_messages", { messages });
			h.child.respondTo("get_entries", { entries, leafId });
			h.child.respondTo("get_available_models", { models: [FLASH, NO_OFF, PLAIN] });
			await started;
		}

		it("names each resumed turn the level recorded ahead of it, not the level in force now", async () => {
			const h = makeHarness();
			const u1 = prompt("first", at(2));
			const a1 = reply("one", at(3));
			const u2 = prompt("second", at(5));
			const a2 = reply("two", at(6));
			const entries = [
				entry("m", null, 0, { type: "model_change", provider: FLASH.provider, modelId: FLASH.id }),
				level("l1", "m", 0, "high"),
				message("u1", "l1", u1),
				message("a1", "u1", a1),
				level("l2", "a1", 4, "low"),
				message("u2", "l2", u2),
				// An abandoned branch sits between the active branch's entries in file
				// order; read in that order, it would name `a2` wrongly.
				level("x", "u2", 5.5, "max"),
				message("a2", "u2", a2),
			];

			await resume(h, { model: FLASH, thinkingLevel: "off" }, [u1, a1, u2, a2], entries, "a2");

			expect(efforts(h)).toEqual(["user", "high", "user", "low"]);
			expect(h.adapter.getState().effort).toBe("off");
		});

		it("keeps the level of turns that streamed live across a fork, which reloads them", async () => {
			const h = makeHarness();
			await startAdapter(h, { model: FLASH, thinkingLevel: "high", sessionFile: REF.id });
			const u1 = prompt("first", at(2));
			const a1 = reply("one", at(3));
			const u2 = prompt("second", at(5));
			const a2 = reply("two", at(6));
			const stream = (user: AgentMessage, assistant: AgentMessage) => {
				h.child.emitLine({ type: "agent_start" });
				for (const m of [user, assistant]) {
					h.child.emitLine({ type: "message_start", message: m });
					h.child.emitLine({ type: "message_end", message: m });
				}
				h.child.emitLine({ type: "agent_settled" });
			};
			stream(u1, a1);
			const set = h.adapter.setEffort("low");
			h.child.emitLine({ type: "thinking_level_changed", level: "low" });
			h.child.respondTo("set_thinking_level");
			await set;
			stream(u2, a2);
			h.child.emitLine({ type: "message_start", message: prompt("third", at(8)) });
			expect(efforts(h)).toEqual(["user", "high", "user", "low", "user"]);

			const forked = h.adapter.fork("u3");
			h.child.respondTo("fork", { text: "third", cancelled: false });
			await flush();
			h.child.respondTo("get_state", { model: FLASH, thinkingLevel: "low", isStreaming: false, sessionFile: "/home/u/.pi/agent/sessions/s-fork.jsonl" });
			await flush();
			h.child.respondTo("get_messages", { messages: [u1, a1, u2, a2] });
			h.child.respondTo("get_entries", {
				entries: [
					level("l1", null, 0, "high"),
					message("u1", "l1", u1),
					message("a1", "u1", a1),
					level("l2", "a1", 4, "low"),
					message("u2", "l2", u2),
					message("a2", "u2", a2),
				],
				leafId: "a2",
			});
			h.child.respondTo("get_available_models", { models: [FLASH, NO_OFF, PLAIN] });
			await forked;

			expect(efforts(h)).toEqual(["user", "high", "user", "low"]);
		});

		it("does not name a turn by a change recorded while it streamed, as live streaming does not", async () => {
			const h = makeHarness();
			const u1 = prompt("first", at(2));
			const a1 = reply("one", at(3));
			// Pi appends the change when it is made and the turn's entry when it
			// ends, so the change sits ahead of the turn it did not govern.
			const entries = [level("l1", null, 0, "low"), message("u1", "l1", u1), level("l2", "u1", 4, "high"), message("a1", "l2", a1)];

			await resume(h, { model: FLASH, thinkingLevel: "high" }, [u1, a1], entries, "a1");

			expect(efforts(h)).toEqual(["user", "low"]);
		});

		it("names `off` only where the turn's model is known to reason, and leaves an unmatched turn unlabelled", async () => {
			const h = makeHarness();
			// Pi pins a model that does not reason at `off`, so `off` alone cannot
			// tell the two apart; `get_state` says whether the current model reasons.
			const a1 = reply("plain", at(3), PLAIN);
			const a2 = reply("flash at off", at(6), FLASH);
			// A compaction summary and a reply the branch does not hold: nothing to read a level from.
			const summary = { role: "compactionSummary", summary: "folded", tokensBefore: 1, timestamp: at(1) } as AgentMessage;
			const stray = reply("not on the branch", at(9), FLASH);
			const entries = [level("l1", null, 0, "off"), message("a1", "l1", a1), message("a2", "a1", a2)];

			await resume(h, { model: FLASH, thinkingLevel: "off" }, [summary, a1, a2, stray], entries, "a2");

			expect(efforts(h)).toEqual(["compactionSummary", undefined, "off", undefined]);
		});

		it("names a turn after a resume that clamped the recorded level the clamped level, which Pi records nowhere (OW-lehita)", async () => {
			const h = makeHarness();
			// The recorded model has left the catalogue, so the resume fell back to
			// FLASH and clamped the recorded `medium`, which FLASH lacks, up to `high`
			// without appending an entry (docs/MANUAL_TESTING.md, OW-lehita).
			const GONE = { provider: "openrouter", id: "retired/model" };
			const u1 = prompt("first", at(2));
			const a1 = reply("on the retired model", at(3), GONE);
			const u2 = prompt("after the resume", at(10));
			const a2 = reply("on flash", at(11), FLASH);
			const entries = [
				entry("m", null, 0, { type: "model_change", provider: GONE.provider, modelId: GONE.id }),
				level("l1", "m", 0, "medium"),
				message("u1", "l1", u1),
				message("a1", "u1", a1),
				message("u2", "a1", u2),
				message("a2", "u2", a2),
			];

			await resume(h, { model: FLASH, thinkingLevel: "high" }, [u1, a1, u2, a2], entries, "a2");

			// The retired model's own levels are unknown, so its turn keeps the level recorded.
			expect(efforts(h)).toEqual(["user", "medium", "user", "high"]);
		});
	});
});

describe("PiAdapter recorded model a resume could not restore (OW-jitoni)", () => {
	// As of `pi 0.87.1` a resume whose recorded model had left the catalogue ran
	// the settings default, and one whose provider lost its auth resolved
	// `unknown`, saying nothing over RPC (docs/MANUAL_TESTING.md, OW-zujofa).
	const RECORDED = { provider: "openrouter", id: "deepseek/deepseek-v0-nonexistent", name: "Gone", reasoning: true };
	const FALLBACK = { provider: "openrouter", id: "google/gemini-2.5-flash-lite", name: "Flash Lite", reasoning: true };
	const UNKNOWN = { provider: "unknown", id: "unknown", name: "unknown", reasoning: false };
	const T0 = Date.parse("2026-09-24T10:00:00.000Z");
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
	type Model = { provider: string; id: string };
	const prompt = (seconds: number): AgentMessage => ({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: T0 + seconds * 1000 }) as AgentMessage;
	const reply = (seconds: number, model: Model): AgentMessage =>
		({ role: "assistant", content: [{ type: "text", text: "ok" }], provider: model.provider, model: model.id, timestamp: T0 + seconds * 1000 }) as AgentMessage;
	const entry = (id: string, parentId: string | null, fields: Record<string, unknown>) => ({ id, parentId, timestamp: new Date(T0).toISOString(), ...fields });
	const modelChange = (id: string, parentId: string | null, model: Model) => entry(id, parentId, { type: "model_change", provider: model.provider, modelId: model.id });
	const message = (id: string, parentId: string | null, m: AgentMessage) => entry(id, parentId, { type: "message", message: m });

	/** A session that ran one turn on `RECORDED`, as OW-zujofa's file held it. */
	const u1 = prompt(1);
	const a1 = reply(2, RECORDED);
	const ranOnRecorded = [modelChange("m", null, RECORDED), message("u1", "m", u1), message("a1", "u1", a1)];

	async function resume(h: Harness, inForce: Model | null, messages: AgentMessage[], entries: unknown[], leafId: string | null): Promise<void> {
		const started = h.adapter.start({ cwd: WORKSPACE, resumeId: REF.id });
		h.child.respondTo("get_state", { model: inForce, thinkingLevel: "high", isStreaming: false, sessionFile: REF.id });
		await flush();
		h.child.respondTo("get_messages", { messages });
		h.child.respondTo("get_entries", { entries, leafId });
		h.child.respondTo("get_available_models", { models: [FALLBACK] });
		await started;
	}

	it("names the recorded model when the model in force is another, by the time start() returns", async () => {
		const h = makeHarness();
		const updates: { model: string | null; unrestoredModel?: string | null }[] = [];
		h.adapter.onUpdate((state) => updates.push(state));

		await resume(h, FALLBACK, [u1, a1], ranOnRecorded, "a1");

		expect(h.adapter.getState()).toMatchObject({ model: "openrouter/google/gemini-2.5-flash-lite", unrestoredModel: "openrouter/deepseek/deepseek-v0-nonexistent" });
		// Set before `start()` returns, which is what puts it on the snapshot the
		// manager broadcasts at attach: the first thing a client holding no view
		// of the session takes, before any turn. The hydration update itself
		// reaches the manager as a `status`, which such a client drops.
		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({ model: "openrouter/google/gemini-2.5-flash-lite", unrestoredModel: "openrouter/deepseek/deepseek-v0-nonexistent" });
	});

	it("names nothing when the resume restored the recorded model", async () => {
		const h = makeHarness();
		await resume(h, RECORDED, [u1, a1], ranOnRecorded, "a1");

		expect(h.adapter.getState()).toMatchObject({ model: "openrouter/deepseek/deepseek-v0-nonexistent", unrestoredModel: null });
	});

	it("names the recorded model when the resume resolved no model at all", async () => {
		const h = makeHarness();
		await resume(h, UNKNOWN, [u1, a1], ranOnRecorded, "a1");

		expect(h.adapter.getState()).toMatchObject({ model: "unknown/unknown", unrestoredModel: "openrouter/deepseek/deepseek-v0-nonexistent" });
	});

	it("reads the recorded model as Pi does: the active branch's last model change or assistant turn", async () => {
		const h = makeHarness();
		const entries = [
			modelChange("m", null, RECORDED),
			message("u1", "m", u1),
			// A turn on another model after the change is what Pi restores from.
			message("a1", "u1", reply(2, FALLBACK)),
			// An abandoned branch naming the other model is not.
			modelChange("x", "a1", RECORDED),
		];

		await resume(h, FALLBACK, [u1, reply(2, FALLBACK)], entries, "a1");

		expect(h.adapter.getState().unrestoredModel).toBeNull();
	});

	it("reads a model change recorded after the last turn over that turn's model", async () => {
		const h = makeHarness();
		// A model chosen after the last turn, and the process closed before the
		// next: Pi's own reading takes the later entry, whatever its kind.
		const entries = [...ranOnRecorded, modelChange("m2", "a1", FALLBACK)];

		await resume(h, RECORDED, [u1, a1], entries, "m2");

		expect(h.adapter.getState()).toMatchObject({
			model: "openrouter/deepseek/deepseek-v0-nonexistent",
			unrestoredModel: "openrouter/google/gemini-2.5-flash-lite",
		});
	});

	it("names nothing for a session with no messages, which Pi does not restore a model for", async () => {
		const h = makeHarness();
		await resume(h, FALLBACK, [], [modelChange("m", null, RECORDED)], "m");

		expect(h.adapter.getState().unrestoredModel).toBeNull();
	});

	it("keeps naming it after a turn on the fallback, which records the fallback, and clears it once a model is chosen", async () => {
		const h = makeHarness();
		await resume(h, FALLBACK, [u1, a1], ranOnRecorded, "a1");

		h.child.emitLine({ type: "agent_start" });
		h.child.emitLine({ type: "message_start", message: reply(4, FALLBACK) });
		h.child.emitLine({ type: "message_end", message: reply(4, FALLBACK) });
		h.child.emitLine({ type: "agent_settled" });
		expect(h.adapter.getState().unrestoredModel).toBe("openrouter/deepseek/deepseek-v0-nonexistent");

		const updates: { unrestoredModel?: string | null }[] = [];
		h.adapter.onUpdate((state) => updates.push(state));
		const set = h.adapter.setModel("openrouter/google/gemini-2.5-flash-lite");
		h.child.respondTo("set_model", FALLBACK);
		await set;

		expect(h.adapter.getState().unrestoredModel).toBeNull();
		expect(updates.at(-1)?.unrestoredModel).toBeNull();
	});

	it("reads it again at a fork, from the branch the fork kept", async () => {
		const h = makeHarness();
		await resume(h, FALLBACK, [u1, a1], ranOnRecorded, "a1");
		const u2 = prompt(3);
		const a2 = reply(4, FALLBACK);
		const u3 = prompt(5);

		// Cut after the turn that ran on the fallback: that branch records it.
		const forked = h.adapter.fork("u3");
		h.child.respondTo("fork", { text: "hi", cancelled: false });
		await flush();
		h.child.respondTo("get_state", { model: FALLBACK, thinkingLevel: "high", isStreaming: false, sessionFile: "/home/u/.pi/agent/sessions/s-fork.jsonl" });
		await flush();
		h.child.respondTo("get_messages", { messages: [u1, a1, u2, a2] });
		h.child.respondTo("get_entries", {
			entries: [...ranOnRecorded, message("u2", "a1", u2), message("a2", "u2", a2), message("u3", "a2", u3)],
			leafId: "a2",
		});
		h.child.respondTo("get_available_models", { models: [FALLBACK] });
		await forked;

		expect(h.adapter.getState().unrestoredModel).toBeNull();
	});
});

describe("PiAdapter teardown", () => {
	it("treats stderr as diagnostics, not as per-chunk errors", async () => {
		const h = makeHarness();
		await startAdapter(h);

		// Routine chatter from the spawn chain on a perfectly healthy start.
		h.child.stderr.emit("data", "direnv: loading /home/u/src/proj/.envrc\n");
		h.child.stderr.emit("data", "sbox: mounting workspace\n");

		expect(h.errors).toEqual([]);
	});

	it("spends the retained stderr on the death report, where it is the only clue", async () => {
		const h = makeHarness();
		await startAdapter(h);

		h.child.stderr.emit("data", "pi: auth.json.lock: EROFS\n");
		h.child.emit("close", 1, null);

		expect(h.errors).toHaveLength(1);
		expect(h.errors[0]).toContain("code=1");
		expect(h.errors[0]).toContain("EROFS");
	});

	it("rejects in-flight commands and clears the streaming flag when the process dies", async () => {
		const h = makeHarness();
		await startAdapter(h);
		h.child.emitLine({ type: "agent_start" });
		expect(h.adapter.getState().isStreaming).toBe(true);

		const submitted = h.adapter.submit("hello");
		h.child.emit("close", 1, null);

		await expect(submitted).rejects.toThrow(/before responding/);
		// A UI left with a permanent spinner is the failure this prevents.
		expect(h.adapter.getState().isStreaming).toBe(false);
	});

	it("is silent when a disposed adapter's process closes, since that is its expected end", async () => {
		const h = makeHarness();
		await startAdapter(h);

		await h.adapter.dispose();
		h.child.emit("close", null, "SIGTERM");

		expect(h.child.killed).toBe(true);
		expect(h.errors).toEqual([]);
	});

	it("does not resolve dispose() until the child has actually closed", async () => {
		// The contract on BackendAdapter.dispose: shutdown resolving is the
		// server's licence to exit, so an adapter that resolves on "SIGTERM sent"
		// rather than "child gone" hands that licence out early. CodexAdapter
		// waits and escalates; this is the same guarantee on the Pi side.
		const h = makeHarness();
		await startAdapter(h);
		h.child.autoClose = false;

		let settled = false;
		const disposing = h.adapter.dispose().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(h.child.killed).toBe(true);
		expect(settled).toBe(false);

		h.child.emit("close", 0, null);
		await disposing;
		expect(settled).toBe(true);
	});

	it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
		vi.useFakeTimers();
		try {
			const h = makeHarness();
			await startAdapter(h);
			h.child.autoClose = false;

			const disposing = h.adapter.dispose();
			await Promise.resolve();
			expect(h.child.signals).toEqual([undefined]);

			await vi.advanceTimersByTimeAsync(2_000);
			expect(h.child.signals).toEqual([undefined, "SIGKILL"]);

			// A child that outlives SIGKILL must not hang shutdown forever.
			await vi.advanceTimersByTimeAsync(1_000);
			await expect(disposing).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("tears down once however many times it is disposed", async () => {
		// The manager can reach one adapter from two directions -- an explicit
		// close and the startup's own failure path, or a shutdown that walks both
		// the process table and the in-flight startups. `stdin.end()` on an
		// already-finished stream raises ERR_STREAM_ALREADY_FINISHED, and nothing
		// listens for `error` on the child's stdin, so the second teardown would
		// take the server down with it.
		const h = makeHarness();
		await startAdapter(h);

		await Promise.all([h.adapter.dispose(), h.adapter.dispose()]);
		await h.adapter.dispose();

		expect(h.child.stdin.endCalls).toBe(1);
		expect(h.child.killCalls).toBe(1);
	});

	it("refuses commands issued after dispose, before the stream has finished tearing down", async () => {
		const h = makeHarness();
		await startAdapter(h);

		await h.adapter.dispose();
		// The real `stdin.end()` does not flip `destroyed` synchronously, so the
		// fake leaves it set to what Node would report mid-teardown.
		h.child.stdin.destroyed = false;

		await expect(h.adapter.submit("hello")).rejects.toThrow(/not running/);
	});

	it("reports a death once, even if close somehow arrives twice", async () => {
		const h = makeHarness();
		await startAdapter(h);

		h.child.emit("close", 1, null);
		h.child.emit("close", 1, null);

		expect(h.errors).toHaveLength(1);
	});

	it("fails a command written after the process is gone instead of writing into the void", async () => {
		const h = makeHarness();
		await startAdapter(h);
		h.child.emit("close", 1, null);

		await expect(h.adapter.submit("hello")).rejects.toThrow(/not running/);
	});
});
