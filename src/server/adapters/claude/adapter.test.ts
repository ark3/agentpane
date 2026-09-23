import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionRef } from "../../../shared/protocol.ts";
import type { ClaudeStoreMessageEntry } from "../../sessions/claude.ts";
import { ClaudeAdapter, ClaudeAdapterFactory, CLAUDE_FORK_SESSION_START } from "./adapter.ts";
import type { ClaudeProcess, ClaudeSpawnOptions } from "./process.ts";
import { FakeClaudeProcess, readFixture } from "./test-support.ts";

const VIRTUAL_REF: SessionRef = { backend: "claude", id: "virtual:test" };

/**
 * A two-turn parent session's store entries, shaped like real store lines
 * (`type`/`uuid`/`message`), for hydration and fork-point tests.
 */
function storedEntries(): ClaudeStoreMessageEntry[] {
	const make = (
		uuid: string,
		type: "user" | "assistant",
		message: Record<string, unknown>,
	): ClaudeStoreMessageEntry => ({
		uuid,
		type,
		record: { type, uuid, timestamp: "2026-08-25T12:00:00.000Z", message },
	});
	return [
		make("u1", "user", { role: "user", content: "first prompt" }),
		make("a1", "assistant", {
			id: "msg_a",
			role: "assistant",
			model: "m",
			content: [{ type: "thinking", thinking: "stored thought" }],
		}),
		make("a2", "assistant", {
			id: "msg_a",
			role: "assistant",
			model: "m",
			content: [{ type: "text", text: "first answer" }],
		}),
		make("u2", "user", { role: "user", content: "second prompt" }),
		make("a3", "assistant", {
			id: "msg_b",
			role: "assistant",
			model: "last-model",
			content: [{ type: "text", text: "second answer" }],
		}),
	];
}

interface Harness {
	adapter: ClaudeAdapter;
	procs: FakeClaudeProcess[];
	spawns: ClaudeSpawnOptions[];
	proc: () => FakeClaudeProcess;
}

function harness(options: {
	entries?: ClaudeStoreMessageEntry[];
	ids?: string[];
	/** The ref the adapter is constructed with; a fork's adapter is built on the id `fork()` minted. */
	ref?: SessionRef;
	/** What each child's `get_settings` reports as `applied.effort`. */
	appliedEffort?: string | null;
} = {}): Harness {
	const procs: FakeClaudeProcess[] = [];
	const spawns: ClaudeSpawnOptions[] = [];
	const ids = [...(options.ids ?? ["minted-1", "minted-2"])];
	const adapter = new ClaudeAdapter(options.ref ?? VIRTUAL_REF, {
		spawn: (opts) => {
			spawns.push(opts);
			const proc = new FakeClaudeProcess();
			proc.appliedEffort = options.appliedEffort ?? null;
			procs.push(proc);
			return proc;
		},
		now: () => 1_000,
		newSessionId: () => ids.shift() ?? "minted-overflow",
		readStoreEntries: async () => options.entries ?? [],
	});
	return { adapter, procs, spawns, proc: () => procs.at(-1) as FakeClaudeProcess };
}

describe("ClaudeAdapter lifecycle", () => {
	it("keeps construction side-effect-free and mints the session id at spawn", async () => {
		const h = harness();
		expect(h.procs).toHaveLength(0);
		expect(h.adapter.ref).toEqual(VIRTUAL_REF);

		await h.adapter.start({ cwd: "/workspace", model: "haiku" });

		expect(h.spawns).toEqual([{ cwd: "/workspace", sessionId: "minted-1", model: "haiku" }]);
		expect(h.adapter.ref).toEqual({ backend: "claude", id: "minted-1" });
	});

	it("resumes a stored session by hydrating from its store file, then spawning --resume", async () => {
		const h = harness({ entries: storedEntries() });
		const updates = vi.fn();
		h.adapter.onUpdate(updates);

		await h.adapter.start({ cwd: "/workspace", resumeId: "stored-id" });

		expect(h.spawns).toEqual([
			{ cwd: "/workspace", resumeId: "stored-id", model: "last-model" },
		]);
		expect(h.adapter.ref).toEqual({ backend: "claude", id: "stored-id" });
		expect(h.adapter.getState().messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(updates).toHaveBeenLastCalledWith(
			expect.objectContaining({ model: "last-model" }),
			undefined,
		);
	});

	it("exposes the last stored assistant model immediately when resuming", async () => {
		const h = harness({ entries: storedEntries() });

		await h.adapter.start({ cwd: "/workspace", resumeId: "stored-id" });

		expect(h.adapter.getState().model).toBe("last-model");
		expect(h.spawns).toEqual([
			{ cwd: "/workspace", resumeId: "stored-id", model: "last-model" },
		]);
	});

	it("keeps an explicit model when resuming a stored session", async () => {
		const h = harness({ entries: storedEntries() });

		await h.adapter.start({ cwd: "/workspace", resumeId: "stored-id", model: "explicit-model" });

		expect(h.adapter.getState().model).toBe("explicit-model");
		expect(h.spawns).toEqual([
			{ cwd: "/workspace", resumeId: "stored-id", model: "explicit-model" },
		]);
	});

	it("keeps the model null when a resumed transcript has no assistant", async () => {
		const h = harness({ entries: storedEntries().slice(0, 1) });

		await h.adapter.start({ cwd: "/workspace", resumeId: "stored-id" });

		expect(h.adapter.getState().model).toBeNull();
		expect(h.spawns).toEqual([{ cwd: "/workspace", resumeId: "stored-id" }]);
	});

	it("adopts the session id the init event reports", async () => {
		const h = harness();
		await h.adapter.start({ cwd: "/workspace" });

		h.proc().emit({ type: "system", subtype: "init", session_id: "cli-chosen", model: "claude-haiku-accepted" });

		expect(h.adapter.ref).toEqual({ backend: "claude", id: "cli-chosen" });
		expect(h.adapter.getState().model).toBe("claude-haiku-accepted");
	});

	it("disposes idempotently, killing the child once and rejecting pending controls", async () => {
		const h = harness();
		await h.adapter.start({ cwd: "/workspace" });
		const pending = h.adapter.listModels();
		const rejected = expect(pending).rejects.toThrow("claude adapter disposed");

		await h.adapter.dispose();
		await h.adapter.dispose();

		await rejected;
		expect(h.proc().killCount).toBe(1);
	});

	it("ignores events emitted after disposal", async () => {
		const h = harness();
		await h.adapter.start({ cwd: "/workspace" });
		await h.adapter.dispose();
		const updates = vi.fn();
		h.adapter.onUpdate(updates);

		h.proc().emit({ type: "system", subtype: "status", status: "requesting" });

		expect(updates).not.toHaveBeenCalled();
		expect(h.adapter.getState().isStreaming).toBe(false);
	});

	it("rejects start after disposal without spawning", async () => {
		const h = harness();
		await h.adapter.dispose();
		await expect(h.adapter.start({ cwd: "/workspace" })).rejects.toThrow(
			"claude adapter disposed",
		);
		expect(h.procs).toHaveLength(0);
	});

	it("rejects start when the child fails to spawn", async () => {
		const proc = new FakeClaudeProcess(false);
		const adapter = new ClaudeAdapter(VIRTUAL_REF, {
			spawn: () => {
				queueMicrotask(() =>
					proc.exit(null, null, new Error("Failed to spawn Claude Code (direnv): ENOENT")),
				);
				return proc;
			},
			newSessionId: () => "minted-1",
		});

		await expect(adapter.start({ cwd: "/workspace" })).rejects.toThrow(
			"Failed to spawn Claude Code (direnv): ENOENT",
		);
	});

	it("rejects start when disposed before the child finishes spawning", async () => {
		const proc = new FakeClaudeProcess(false);
		const adapter = new ClaudeAdapter(VIRTUAL_REF, {
			spawn: () => proc,
			newSessionId: () => "minted-1",
		});
		const starting = adapter.start({ cwd: "/workspace" });

		await adapter.dispose();
		proc.spawn();

		await expect(starting).rejects.toThrow("disposed during startup");
	});

	it("surfaces a child exit as an error", async () => {
		const h = harness();
		await h.adapter.start({ cwd: "/workspace" });
		const errors = vi.fn();
		h.adapter.onError(errors);

		h.proc().exit(1, null, new Error("claude exited (code=1, signal=null)\nboom"));

		expect(errors).toHaveBeenCalledWith("claude exited (code=1, signal=null)\nboom");
	});
});

describe("ClaudeAdapter turns", () => {
	it("submits by writing a stream-json user line and adding the prompt locally", async () => {
		const h = harness();
		await h.adapter.start({ cwd: "/workspace" });

		await h.adapter.submit("describe this", [{ mimeType: "image/png", base64: "iVBORw0=" }]);

		expect(h.proc().lastUserMessage()).toEqual({
			type: "user",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "describe this" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0=" } },
				],
			},
		});
		const state = h.adapter.getState();
		expect(state.isStreaming).toBe(true);
		expect(state.messages[0]?.role).toBe("user");
	});

	it("rejects a submit while a turn is active, then admits one after its result", async () => {
		const h = harness();
		await h.adapter.start({ cwd: "/workspace" });
		await h.adapter.submit("first prompt");
		const before = h.proc().written.length;

		await expect(h.adapter.submit("queued prompt")).rejects.toThrow(
			"claude adapter cannot submit while a turn is active",
		);
		expect(h.proc().written).toHaveLength(before);
		expect(h.adapter.getState().messages).toHaveLength(1);

		h.proc().emit({ type: "result", subtype: "success", is_error: false });
		await h.adapter.submit("next prompt");
		expect(h.proc().lastUserMessage()).toEqual({
			type: "user",
			message: { role: "user", content: [{ type: "text", text: "next prompt" }] },
		});
	});

	it("refuses to queue compaction behind an active turn", async () => {
		const h = harness();
		await h.adapter.start({ cwd: "/workspace" });
		await h.adapter.submit("active prompt");
		const before = h.proc().written.length;

		await expect(h.adapter.compact()).rejects.toThrow(
			"claude adapter cannot submit while a turn is active",
		);
		expect(h.proc().written).toHaveLength(before);
		expect(h.adapter.getState().compaction).toBeNull();

		h.proc().emit({ type: "result", subtype: "success", is_error: false });
		await h.adapter.compact();
		expect(h.proc().lastUserMessage()).toEqual({
			type: "user",
			message: { role: "user", content: [{ type: "text", text: "/compact" }] },
		});
	});

	it("replays a recorded turn through the live process seam", async () => {
		const h = harness();
		await h.adapter.start({ cwd: "/workspace" });
		await h.adapter.submit("prompt");

		for (const event of readFixture("text-turn")) h.proc().emit(event);

		const { messages, isStreaming } = h.adapter.getState();
		expect(isStreaming).toBe(false);
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it("names each assistant turn with the effort in force when it started", async () => {
		const h = harness({ appliedEffort: "low" });
		await h.adapter.start({ cwd: "/workspace", model: "sonnet" });
		await h.adapter.submit("prompt");

		// A change landing mid-turn does not relabel the turn already running.
		const setting = h.adapter.setEffort("high");
		const request = h.proc().lastControlRequest("apply_flag_settings");
		h.proc().appliedEffort = "high";
		h.proc().emit({ type: "control_response", response: { subtype: "success", request_id: request?.request_id } });
		await setting;
		for (const event of readFixture("text-turn")) h.proc().emit(event);

		const assistant = h.adapter.getState().messages.find((m) => m.role === "assistant");
		expect(assistant && "effort" in assistant ? assistant.effort : undefined).toBe("low");
		expect(h.adapter.getState().effort).toBe("high");
	});

	it("names a resumed turn with the effort its store line records", async () => {
		const entries = storedEntries();
		const last = entries.at(-1);
		if (last) last.record = { ...last.record, effort: "max" };
		const h = harness({ entries, appliedEffort: "high" });

		await h.adapter.start({ cwd: "/workspace", resumeId: "stored-id" });

		const efforts = h.adapter
			.getState()
			.messages.filter((m) => m.role === "assistant")
			.map((m) => ("effort" in m ? m.effort : undefined));
		expect(efforts).toEqual([undefined, "max"]);
		expect(h.adapter.getState().effort).toBe("high");
	});

	it("aborts via the interrupt control request and tolerates an error reply", async () => {
		const h = harness();
		await h.adapter.start({ cwd: "/workspace" });
		await h.adapter.submit("long turn");

		const aborting = h.adapter.abort();
		const request = h.proc().lastControlRequest("interrupt");
		expect(request).toBeDefined();
		h.proc().emit({
			type: "control_response",
			response: { subtype: "error", request_id: request?.request_id, error: "not executing" },
		});
		await aborting; // an errored interrupt is a no-op, not a failure

		// Idle: no turn to interrupt, nothing written.
		const before = h.proc().written.length;
		h.proc().emit({ type: "result", subtype: "success", is_error: false });
		await h.adapter.abort();
		expect(h.proc().written.length).toBe(before);
	});

	it("compacts by sending the literal /compact user message", async () => {
		const h = harness();
		await h.adapter.start({ cwd: "/workspace" });
		const updates: ("requesting" | "running" | null)[] = [];
		h.adapter.onUpdate((state) => updates.push(state.compaction));

		await h.adapter.compact();

		expect(h.proc().lastUserMessage()).toEqual({
			type: "user",
			message: { role: "user", content: [{ type: "text", text: "/compact" }] },
		});
		expect(updates).toEqual(["requesting"]);
	});

	it("clears requesting when writing the compact command fails", async () => {
		const h = harness();
		await h.adapter.start({ cwd: "/workspace" });
		const updates: ("requesting" | "running" | null)[] = [];
		h.adapter.onUpdate((state) => updates.push(state.compaction));
		await h.proc().kill();
		await expect(h.adapter.compact()).rejects.toThrow("not running");
		expect(updates).toEqual(["requesting", null]);
	});
});

describe("ClaudeAdapter session controls", () => {
	it("lists models from the initialize control response", async () => {
		const h = harness();
		await h.adapter.start({ cwd: "/workspace" });

		const listing = h.adapter.listModels();
		const request = h.proc().lastControlRequest("initialize");
		expect(request).toBeDefined();
		// Hand-built response: the real one carries the operator's account email
		// and must never be fixtured (OW-yilabe).
		h.proc().emit({
			type: "control_response",
			response: {
				subtype: "success",
				request_id: request?.request_id,
				response: {
					models: [
						{
							value: "default",
							displayName: "Default (recommended)",
							supportsEffort: true,
							supportedEffortLevels: ["low", "medium", "high"],
						},
						// As `claude 2.1.280` lists haiku: neither effort field.
						{ value: "haiku" },
					],
				},
			},
		});

		expect(await listing).toEqual([
			{
				id: "default",
				label: "Default (recommended)",
				efforts: [
					{ id: "low", description: "" },
					{ id: "medium", description: "" },
					{ id: "high", description: "" },
				],
				defaultEffort: null,
			},
			{ id: "haiku", label: "haiku", efforts: [], defaultEffort: null },
		]);
	});

	it("reports the effort get_settings applies at start, before anything is chosen", async () => {
		const h = harness({ appliedEffort: "high" });
		await h.adapter.start({ cwd: "/workspace" });

		expect(h.proc().lastControlRequest("get_settings")).toBeDefined();
		expect(h.adapter.getState().effort).toBe("high");
	});

	it("sends a chosen effort as apply_flag_settings and reports what the CLI then applies", async () => {
		const h = harness({ appliedEffort: "high" });
		await h.adapter.start({ cwd: "/workspace", model: "sonnet" });
		const updates = vi.fn();
		h.adapter.onUpdate(updates);

		const setting = h.adapter.setEffort("low");
		const request = h.proc().lastControlRequest("apply_flag_settings");
		expect(request?.request).toEqual({ subtype: "apply_flag_settings", settings: { effortLevel: "low" } });
		h.proc().appliedEffort = "low";
		h.proc().emit({
			type: "control_response",
			response: { subtype: "success", request_id: request?.request_id },
		});
		await setting;

		expect(h.adapter.getState().effort).toBe("low");
		expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({ effort: "low" }), undefined);
	});

	it("reports the effort the CLI applies, not the one requested", async () => {
		// As `claude 2.1.280` answers an unknown level: success, and nothing applied.
		const h = harness({ appliedEffort: "high" });
		await h.adapter.start({ cwd: "/workspace", model: "sonnet" });

		const setting = h.adapter.setEffort("bogus");
		const request = h.proc().lastControlRequest("apply_flag_settings");
		h.proc().emit({
			type: "control_response",
			response: { subtype: "success", request_id: request?.request_id },
		});
		await setting;

		expect(h.adapter.getState().effort).toBe("high");
	});

	it("re-reads the effort after set_model, since a model without effort applies none", async () => {
		const h = harness({ appliedEffort: "low" });
		await h.adapter.start({ cwd: "/workspace", model: "sonnet" });

		const setting = h.adapter.setModel("haiku");
		const request = h.proc().lastControlRequest("set_model");
		h.proc().appliedEffort = null;
		h.proc().emit({
			type: "control_response",
			response: { subtype: "success", request_id: request?.request_id },
		});
		await setting;

		expect(h.adapter.getState().effort).toBeNull();
	});

	it("sets the model via set_model and hands it to a fork", async () => {
		const h = harness({ entries: storedEntries() });
		await h.adapter.start({ cwd: "/workspace" });

		const setting = h.adapter.setModel("haiku");
		const request = h.proc().lastControlRequest("set_model");
		expect(request?.request).toMatchObject({ subtype: "set_model", model: "haiku" });
		h.proc().emit({
			type: "control_response",
			response: { subtype: "success", request_id: request?.request_id },
		});
		await setting;
		expect(h.adapter.getState().model).toBe("haiku");

		const forked = await h.adapter.fork("u1");
		expect(forked.start?.model).toBe("haiku");
		expect(h.adapter.getState().model).toBe("haiku");
	});

	it("rejects setModel when the CLI rejects the model id", async () => {
		const h = harness();
		await h.adapter.start({ cwd: "/workspace" });

		const setting = h.adapter.setModel("bogus");
		const request = h.proc().lastControlRequest("set_model");
		h.proc().emit({
			type: "control_response",
			response: {
				subtype: "error",
				request_id: request?.request_id,
				error: 'Model "bogus" is not a recognized model id',
			},
		});

		await expect(setting).rejects.toThrow("not a recognized model id");
	});
});

describe("ClaudeAdapter fork", () => {
	it("returns no fork points for a started session with no store file yet", async () => {
		const claudeRoot = await mkdtemp(join(tmpdir(), "agentpane-claude-adapter-"));
		const adapter = new ClaudeAdapter(VIRTUAL_REF, {
			spawn: () => new FakeClaudeProcess(),
			newSessionId: () => "never-prompted",
			claudeRoot,
		});
		try {
			await adapter.start({ cwd: "/workspace" });

			expect(await adapter.listForkPoints()).toEqual([]);
		} finally {
			await adapter.dispose();
			await rm(claudeRoot, { recursive: true, force: true });
		}
	});

	it("offers one fork point per human prompt, carrying the PRECEDING entry uuid", async () => {
		const h = harness({ entries: storedEntries() });
		await h.adapter.start({ cwd: "/workspace", resumeId: "parent" });

		const points = await h.adapter.listForkPoints();

		// Truncation is inclusive of the named entry (OW-mayuza): forking before
		// the second prompt names the last entry of the first turn, and the
		// first prompt -- with nothing before it -- gets the session-start id.
		expect(points).toEqual([
			{ id: CLAUDE_FORK_SESSION_START, text: "first prompt", index: 0 },
			{ id: "a2", text: "second prompt", index: 2 },
		]);
	});

	/**
	 * A pre-existing off-by-one, fixed by taking the answer from the reducer
	 * (OW-roveze). `/compact` writes the summary back as an `isCompactSummary`
	 * user line, which the reducer folds onto the compaction marker and never
	 * makes a user message of -- but the old `claudePromptText` filter saw a user
	 * line with text and emitted a point for it. That extra point pushed every
	 * ordinal after the compaction one step along, so on a compacted session the
	 * wrong message got forked.
	 */
	it("emits no fork point for a compaction summary, which is not a human turn (OW-roveze)", async () => {
		const entry = (
			uuid: string,
			type: "user" | "assistant",
			message: Record<string, unknown>,
			extra: Record<string, unknown> = {},
		): ClaudeStoreMessageEntry => ({
			uuid,
			type,
			record: { type, uuid, timestamp: "2026-08-25T12:00:00.000Z", message, ...extra },
		});
		const h = harness({
			entries: [
				entry("u1", "user", { role: "user", content: "first prompt" }),
				entry("a1", "assistant", {
					id: "msg_a",
					role: "assistant",
					model: "m",
					content: [{ type: "text", text: "first answer" }],
				}),
				entry("s1", "user", { role: "user", content: "a summary of everything above" }, { isCompactSummary: true }),
				entry("u2", "user", { role: "user", content: "second prompt" }),
				entry("a2", "assistant", {
					id: "msg_b",
					role: "assistant",
					model: "m",
					content: [{ type: "text", text: "second answer" }],
				}),
			],
		});
		await h.adapter.start({ cwd: "/workspace", resumeId: "parent" });

		// Four transcript messages: the summary line made none of them.
		expect(h.adapter.getState().messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(await h.adapter.listForkPoints()).toEqual([
			{ id: CLAUDE_FORK_SESSION_START, text: "first prompt", index: 0 },
			{ id: "s1", text: "second prompt", index: 2 },
		]);
	});

	it("forks without touching the parent, returning a ref and the recipe that spawns it", async () => {
		const h = harness({ entries: storedEntries(), ids: ["forked-1"] });
		await h.adapter.start({ cwd: "/workspace", resumeId: "parent" });

		const forked = await h.adapter.fork("a2");

		expect(forked.ref).toEqual({ backend: "claude", id: "forked-1" });
		// The parent keeps its id, its child and its whole transcript: the fork is
		// a second session, not a move of this one (OW-razoki).
		expect(h.adapter.ref).toEqual({ backend: "claude", id: "parent" });
		expect(h.procs).toHaveLength(1);
		expect(h.procs[0]?.killCount).toBe(0);
		expect(h.adapter.getState().messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(forked.start).toEqual({
			cwd: "/workspace",
			forkOf: { parentId: "parent", entryId: "a2" },
			model: "last-model",
		});
	});

	it("leaves the parent's in-flight turn running across a fork", async () => {
		const h = harness({ entries: storedEntries() });
		await h.adapter.start({ cwd: "/workspace", resumeId: "parent" });
		await h.adapter.submit("keep going");

		await h.adapter.fork("a2");

		// The turn gate still holds, which is only true if the parent's turn is
		// still this adapter's business after the fork.
		await expect(h.adapter.submit("again")).rejects.toThrow("while a turn is active");
	});

	it("keeps the parent's child streaming after a fork", async () => {
		const h = harness({ entries: storedEntries() });
		await h.adapter.start({ cwd: "/workspace", resumeId: "parent" });
		const parent = h.proc();
		await h.adapter.fork("a2");
		const updates = vi.fn();
		h.adapter.onUpdate(updates);

		parent.emit({ type: "system", subtype: "status", status: "requesting" });

		expect(updates).toHaveBeenCalled();
	});

	it("starts a fork on its own child, hydrated from the parent's truncated history", async () => {
		const h = harness({ entries: storedEntries(), ref: { backend: "claude", id: "forked-1" } });

		await h.adapter.start({ cwd: "/workspace", forkOf: { parentId: "parent", entryId: "a2" } });

		expect(h.spawns).toEqual([
			{
				cwd: "/workspace",
				resumeId: "parent",
				forkAtEntryId: "a2",
				sessionId: "forked-1",
				model: "m",
			},
		]);
		expect(h.adapter.ref).toEqual({ backend: "claude", id: "forked-1" });
		// Everything through a2 survives; the second turn is gone. The cut is
		// INCLUSIVE of the named entry (OW-mayuza): a2's text block must be here.
		const messages = h.adapter.getState().messages;
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		const assistant = messages[1] as { content: { type: string }[] };
		expect(assistant.content.map((block) => block.type)).toEqual(["thinking", "text"]);
	});

	it("forks before the first message as a fresh session in the same workspace", async () => {
		const h = harness({ entries: storedEntries(), ids: ["forked-1"] });
		await h.adapter.start({ cwd: "/workspace", resumeId: "parent" });

		const forked = await h.adapter.fork(CLAUDE_FORK_SESSION_START);

		expect(forked.ref).toEqual({ backend: "claude", id: "forked-1" });
		expect(forked.start).toEqual({
			cwd: "/workspace",
			forkOf: { parentId: "parent", entryId: CLAUDE_FORK_SESSION_START },
			model: "last-model",
		});
		expect(h.procs).toHaveLength(1);
		expect(h.adapter.getState().messages).toHaveLength(4);
	});

	it("starts a session-start fork as a fresh child with an empty transcript", async () => {
		const h = harness({ entries: storedEntries(), ref: { backend: "claude", id: "forked-1" } });

		await h.adapter.start({
			cwd: "/workspace",
			forkOf: { parentId: "parent", entryId: CLAUDE_FORK_SESSION_START },
			model: "last-model",
		});

		expect(h.spawns).toEqual([
			{ cwd: "/workspace", sessionId: "forked-1", model: "last-model" },
		]);
		expect(h.adapter.getState().messages).toEqual([]);
	});

	it("rejects an unknown fork point without touching the child", async () => {
		const h = harness({ entries: storedEntries() });
		await h.adapter.start({ cwd: "/workspace", resumeId: "parent" });

		await expect(h.adapter.fork("nope")).rejects.toThrow("unknown fork point: nope");
		expect(h.procs).toHaveLength(1);
		expect(h.procs[0]?.killed).toBe(false);
	});
});

describe("ClaudeAdapterFactory", () => {
	it("creates only Claude adapters without spawning them", () => {
		const spawn = vi.fn(() => new FakeClaudeProcess());
		const factory = new ClaudeAdapterFactory({ spawn });

		expect(factory.create(VIRTUAL_REF)).toBeInstanceOf(ClaudeAdapter);
		expect(spawn).not.toHaveBeenCalled();
		expect(() => factory.create({ backend: "pi", id: "pi-session" })).toThrow(
			'ClaudeAdapterFactory cannot create a "pi" adapter',
		);
	});
});
