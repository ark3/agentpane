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
import type { SessionRef } from "../../../shared/protocol.ts";
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

	it("resolves the id after the first prompt when the session had not materialised at start", async () => {
		const h = makeHarness();
		const adapter = new PiAdapter({ backend: "pi", id: "__new__" }, { spawn: () => h.child as unknown as PiChild });

		// A virtual session has no file yet, so Pi reports none (D9).
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

		expect(await forkPoints).toEqual([{ id: "e1", text: "first prompt" }]);
		// ModelInfo.id is `provider/modelId` -- the bridge to Pi's split set_model.
		expect(await models).toEqual([{ id: "anthropic/claude-opus-5", label: "Opus 5" }]);
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
	it("surfaces a blocking dialog and sends the matching extension_ui_response", async () => {
		const h = makeHarness();
		await startAdapter(h);
		const requests: { requestId: string; kind: string }[] = [];
		h.adapter.onRequest((r) => requests.push({ requestId: r.requestId, kind: r.kind }));

		h.child.emitLine({
			type: "extension_ui_request",
			id: "ui-1",
			method: "confirm",
			title: "Run this?",
			message: "rm -rf build",
		});

		expect(requests).toEqual([{ requestId: "ui-1", kind: "confirm" }]);
		await h.adapter.reply("ui-1", true);
		// Correlates on the *request* id, not a fresh command id -- an
		// extension_ui_response is a reply, not a new command.
		expect(h.child.lastSent("extension_ui_response")).toEqual({
			type: "extension_ui_response",
			id: "ui-1",
			confirmed: true,
		});
	});

	it("does not surface fire-and-forget presentation methods as requests", async () => {
		const h = makeHarness();
		await startAdapter(h);
		const onRequest = vi.fn();
		h.adapter.onRequest(onRequest);

		h.child.emitLine({ type: "extension_ui_request", id: "ui-2", method: "notify", message: "done" });

		expect(onRequest).not.toHaveBeenCalled();
		await expect(h.adapter.reply("ui-2", "x")).rejects.toThrow(/No pending Pi UI request/);
	});
});

describe("PiAdapter.fork", () => {
	it("re-adopts the moved active file and refetches the whole transcript as a snapshot", async () => {
		const h = makeHarness();
		await startAdapter(h);
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

		expect(await forked).toEqual({ backend: "pi", id: MOVED }); // moved file, NOT REF
		expect(h.adapter.ref).toEqual({ backend: "pi", id: MOVED });
		expect(h.adapter.getState().messages).toHaveLength(1);
		// changedIndex omitted: a fork touches the whole transcript (D3).
		expect(seen).toEqual([undefined]);
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
