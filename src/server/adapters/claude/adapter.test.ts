import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionRef } from "../../../shared/protocol.ts";
import { BackendRefusedError } from "../types.ts";
import type { ClaudeStoreMessageEntry } from "../../sessions/claude.ts";
import { ClaudeAdapter, ClaudeAdapterFactory, CLAUDE_FORK_SESSION_START } from "./adapter.ts";
import type { ClaudeProcess, ClaudeSpawnOptions } from "./process.ts";
import type { ClaudeModelDescriptor } from "./protocol.ts";
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

// As `claude 2.1.280` answered on the home server, 2026-09-23: `default` and
// `opus[1m]` share a resolved id, and haiku lists no effort.
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODELS: ClaudeModelDescriptor[] = [
	{ value: "default", resolvedModel: "claude-opus-5-5[1m]", supportedEffortLevels: EFFORTS },
	{ value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", supportedEffortLevels: EFFORTS },
	{ value: "sonnet", resolvedModel: "claude-sonnet-5", supportedEffortLevels: EFFORTS },
	{ value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" },
];

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
	/** What each child's `get_settings` reports as `applied.model`. */
	appliedModel?: string | null;
	/** Each child's `initialize` model entries; unset, `initialize` goes unanswered. */
	models?: ClaudeModelDescriptor[];
} = {}): Harness {
	const procs: FakeClaudeProcess[] = [];
	const spawns: ClaudeSpawnOptions[] = [];
	const ids = [...(options.ids ?? ["minted-1", "minted-2"])];
	const adapter = new ClaudeAdapter(options.ref ?? VIRTUAL_REF, {
		spawn: (opts) => {
			spawns.push(opts);
			const proc = new FakeClaudeProcess();
			proc.appliedEffort = options.appliedEffort ?? null;
			proc.appliedModel = options.appliedModel ?? null;
			proc.initializeModels = options.models ?? null;
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
			{ cwd: "/workspace", resumeId: "stored-id" },
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
			{ cwd: "/workspace", resumeId: "stored-id" },
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

	it("announces the init's session id before that line's update and the reducer's effects (D24, OW-nikogo)", async () => {
		const h = harness();
		const seen: string[] = [];
		h.adapter.onRefChanged((ref, cause) => seen.push(`${cause} ${ref.id}`));
		await h.adapter.start({ cwd: "/workspace" });
		expect(seen.splice(0)).toEqual(["rename minted-1"]);
		h.adapter.onUpdate((state) => seen.push(`update ${state.model}`));
		await h.adapter.submit("hi");
		seen.length = 0;

		h.proc().emit({ type: "system", subtype: "init", session_id: "cli-chosen", model: "claude-haiku-accepted" });
		h.proc().emit({ type: "system", subtype: "init", session_id: "cli-chosen", model: "claude-haiku-accepted" });

		expect(seen[0]).toBe("rename cli-chosen");
		expect(seen.slice(1).every((entry) => entry.startsWith("update "))).toBe(true);
		expect(seen.slice(1)).toContain("update claude-haiku-accepted");
		expect(seen.filter((entry) => entry.startsWith("rename"))).toHaveLength(1);
	});

	it("announces nothing for a resume, which holds the id already, or for a fork, which moves nothing (D24, OW-nikogo)", async () => {
		const h = harness({ entries: storedEntries(), ref: { backend: "claude", id: "stored-id" } });
		const seen: string[] = [];
		h.adapter.onRefChanged((ref, cause) => seen.push(`${cause} ${ref.id}`));

		await h.adapter.start({ cwd: "/workspace", resumeId: "stored-id" });
		await h.adapter.fork("u2");

		expect(seen).toEqual([]);
		expect(h.adapter.ref).toEqual({ backend: "claude", id: "stored-id" });
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

	it("resumes at the model and effort the store's last assistant line records (D23)", async () => {
		const entries = storedEntries();
		const last = entries.at(-1);
		if (last) last.record = { ...last.record, effort: "max" };
		const h = harness({ entries, appliedEffort: "max" });

		await h.adapter.start({ cwd: "/workspace", resumeId: "stored-id" });

		// Told at spawn, so no turn can run at the CLI's default first.
		expect(h.spawns).toEqual([
			{ cwd: "/workspace", resumeId: "stored-id", effort: "max" },
		]);
		expect(h.adapter.getState().effort).toBe("max");
	});

	it("resumes past a synthetic assistant line to the last turn a model ran (D23)", async () => {
		const entries = storedEntries();
		const last = entries.at(-1);
		if (last) last.record = { ...last.record, effort: "max" };
		// Shaped like a real store line (`claude 2.1.270`): the CLI's own
		// session-limit notice, with no effort.
		const notice = {
			id: "04d1020c-b051-4c71-8530-e1c5319c1d83",
			role: "assistant",
			model: "<synthetic>",
			stop_reason: "stop_sequence",
			content: [{ type: "text", text: "You've hit your session limit" }],
		};
		entries.push({
			uuid: "s1",
			type: "assistant",
			record: {
				type: "assistant",
				uuid: "s1",
				timestamp: "2026-08-25T12:01:00.000Z",
				isApiErrorMessage: true,
				error: "rate_limit",
				message: notice,
			},
		});
		const h = harness({ entries });

		await h.adapter.start({ cwd: "/workspace", resumeId: "stored-id" });

		expect(h.spawns).toEqual([
			{ cwd: "/workspace", resumeId: "stored-id", effort: "max" },
		]);
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

	describe("naming the model in force when none was chosen", () => {
		it("names the listed default, whose efforts the clients then offer, before any turn", async () => {
			const h = harness({ appliedEffort: "high", appliedModel: "claude-opus-5-5[1m]", models: MODELS });
			const updates = vi.fn();
			h.adapter.onUpdate(updates);
			await h.adapter.start({ cwd: "/workspace" });

			expect(h.adapter.getState().model).toBe("default");
			expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({ model: "default" }), undefined);
			const listed = (await h.adapter.listModels()).find((model) => model.id === h.adapter.getState().model);
			expect(listed?.efforts.map((effort) => effort.id)).toEqual(EFFORTS);
			// Nothing was chosen, so the spawn carried no `--model`.
			expect(h.spawns[0]?.model).toBeUndefined();
		});

		it("names default over an earlier entry sharing its resolved id", async () => {
			const models = [MODELS[1], MODELS[0]] as ClaudeModelDescriptor[];
			const h = harness({ appliedModel: "claude-opus-5-5[1m]", models });
			await h.adapter.start({ cwd: "/workspace" });

			expect(h.adapter.getState().model).toBe("default");
		});

		it("names the one listed id a settings default resolves to", async () => {
			const h = harness({ appliedEffort: "high", appliedModel: "claude-sonnet-5", models: MODELS });
			await h.adapter.start({ cwd: "/workspace" });

			expect(h.adapter.getState().model).toBe("sonnet");
		});

		it("names nothing when no listed id resolves to the model in force", async () => {
			const h = harness({ appliedModel: "claude-unlisted-1", models: MODELS });
			await h.adapter.start({ cwd: "/workspace" });

			expect(h.adapter.getState().model).toBeNull();
		});

		it("keeps a chosen model and asks no initialize for it", async () => {
			const h = harness({ appliedModel: "claude-opus-5-5[1m]", models: MODELS });
			await h.adapter.start({ cwd: "/workspace", model: "opus[1m]" });

			expect(h.adapter.getState().model).toBe("opus[1m]");
			expect(h.proc().lastControlRequest("initialize")).toBeUndefined();
		});
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
		await expect(setting).rejects.toBeInstanceOf(BackendRefusedError);
	});

	it("does not call a CLI that exited before answering set_model a refusal (OW-pizaki)", async () => {
		const h = harness();
		await h.adapter.start({ cwd: "/workspace" });

		const setting = h.adapter.setModel("haiku");
		h.proc().exit(1, null);
		const error = await setting.catch((e: unknown) => e);
		expect((error as Error).message).toMatch(/claude exited/);
		expect(error).not.toBeInstanceOf(BackendRefusedError);
	});

	/**
	 * As of `claude 2.1.280`, a `set_model` on a process whose session has a
	 * turn behind it -- a resume included -- writes an `isReplay` user event
	 * carrying the `/model` command's `<local-command-stdout>` ahead of its
	 * control_response; on a fresh session before its first turn it writes
	 * none (MANUAL_TESTING OW-hiligu). It is the CLI echoing its own command,
	 * not anything a human said.
	 */
	it("adds nothing to the transcript for the user event a set_model emits (OW-hiligu)", async () => {
		const h = harness({ entries: storedEntries() });
		await h.adapter.start({ cwd: "/workspace", resumeId: "stored-id" });
		const before = structuredClone(h.adapter.getState().messages);
		const changed = vi.fn();
		h.adapter.onUpdate((_state, index) => {
			if (index !== undefined) changed(index);
		});

		const lines = readFixture("set-model");
		expect(lines.filter((event) => event.type === "user")).toHaveLength(2);
		for (const model of ["sonnet", "haiku"]) {
			const setting = h.adapter.setModel(model);
			const request = h.proc().lastControlRequest("set_model");
			// The recording's lines up to its next control_response, which is
			// re-addressed to the request this adapter actually sent.
			for (let event = lines.shift(); event; event = lines.shift()) {
				if (event.type === "control_response") {
					h.proc().emit({ ...event, response: { ...event.response, request_id: request?.request_id } });
					break;
				}
				h.proc().emit(event);
			}
			await setting;
		}

		expect(lines).toEqual([]);
		expect(h.adapter.getState().model).toBe("haiku");
		expect(h.adapter.getState().messages).toEqual(before);
		expect(changed).not.toHaveBeenCalled();
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

	/**
	 * The store half of OW-hiligu: as of `claude 2.1.280`, a `set_model` writes
	 * nothing to the store until a turn runs on the same process, and that turn
	 * then writes three user lines per `set_model` ahead of its prompt -- an
	 * `isMeta` caveat, the `/model` command line, and its stdout, whose uuid is
	 * the live event's. The lines below are the recorded ones, minus the
	 * bookkeeping keys the reducer never reads.
	 */
	it("hydrates no message and emits no fork point for the lines a set_model leaves in the store (OW-hiligu)", async () => {
		const entry = (
			uuid: string,
			type: "user" | "assistant",
			message: Record<string, unknown>,
			extra: Record<string, unknown> = {},
		): ClaudeStoreMessageEntry => ({
			uuid,
			type,
			record: { type, uuid, timestamp: "2026-09-24T01:18:02.874Z", message, ...extra },
		});
		const h = harness({
			entries: [
				entry("u1", "user", { role: "user", content: [{ type: "text", text: "first prompt" }] }),
				entry("a1", "assistant", {
					id: "msg_a",
					role: "assistant",
					model: "m",
					content: [{ type: "text", text: "first answer" }],
				}),
				entry(
					"caveat",
					"user",
					{
						role: "user",
						content:
							"<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>",
					},
					{ isMeta: true },
				),
				entry("command", "user", {
					role: "user",
					content:
						"<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>sonnet</command-args>",
				}),
				entry("stdout", "user", {
					role: "user",
					content: "<local-command-stdout>Set model to `sonnet (claude-sonnet-5)`</local-command-stdout>",
				}),
				entry("u2", "user", { role: "user", content: [{ type: "text", text: "second prompt" }] }),
				entry("a2", "assistant", {
					id: "msg_b",
					role: "assistant",
					model: "m",
					content: [{ type: "text", text: "second answer" }],
				}),
			],
		});
		await h.adapter.start({ cwd: "/workspace", resumeId: "parent" });

		expect(h.adapter.getState().messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		// Forking before the second prompt keeps the `/model` lines, inclusive of
		// the last one, and they hydrate to nothing on the fork too.
		expect(await h.adapter.listForkPoints()).toEqual([
			{ id: CLAUDE_FORK_SESSION_START, text: "first prompt", index: 0 },
			{ id: "stdout", text: "second prompt", index: 2 },
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

	/**
	 * As of `claude 2.1.280`, a `--resume` and a `--fork-session` spawn with no
	 * `--model` put in force the model the last assistant line records -- for
	 * the fork, the kept prefix's -- and a `--model` would override it
	 * (docs/MANUAL_TESTING.md, OW-tebibo).
	 */
	it("resumes and forks at an entry with no model, naming the one the store restores (OW-tebibo)", async () => {
		const parent = harness({ entries: storedEntries(), ids: ["forked-1"] });
		await parent.adapter.start({ cwd: "/workspace", resumeId: "parent" });
		const forked = await parent.adapter.fork("a2");
		const fork = harness({ entries: storedEntries(), ref: forked.ref });
		await fork.adapter.start(forked.start ?? { cwd: "/workspace" });

		expect(parent.spawns).toEqual([{ cwd: "/workspace", resumeId: "parent" }]);
		expect(parent.adapter.getState().model).toBe("last-model");
		// The parent's second turn ran on another model; the prefix's is the fork's.
		expect(fork.spawns).toEqual([
			{ cwd: "/workspace", resumeId: "parent", forkAtEntryId: "a2", sessionId: "forked-1" },
		]);
		expect(fork.adapter.getState().model).toBe("m");
	});

	it("forks at an entry with the parent's model when the kept prefix names none", async () => {
		const h = harness({ entries: storedEntries(), ref: { backend: "claude", id: "forked-1" } });

		await h.adapter.start({ cwd: "/workspace", forkOf: { parentId: "parent", entryId: "u1" }, model: "haiku" });

		expect(h.spawns).toEqual([
			{ cwd: "/workspace", resumeId: "parent", forkAtEntryId: "u1", sessionId: "forked-1", model: "haiku" },
		]);
		expect(h.adapter.getState().model).toBe("haiku");
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

	it("starts a fork at the effort the kept prefix's last assistant line records (D23)", async () => {
		const entries = storedEntries();
		// Every line of one message carries its effort, as in a real store.
		for (const entry of entries) {
			if (entry.type !== "assistant") continue;
			entry.record = { ...entry.record, effort: entry.uuid === "a3" ? "max" : "low" };
		}
		const h = harness({ entries, ref: { backend: "claude", id: "forked-1" } });

		await h.adapter.start({ cwd: "/workspace", forkOf: { parentId: "parent", entryId: "a2" } });

		expect(h.spawns).toEqual([
			{
				cwd: "/workspace",
				resumeId: "parent",
				forkAtEntryId: "a2",
				sessionId: "forked-1",
				effort: "low",
			},
		]);
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

	/**
	 * A fork before the first message keeps no turn to read an effort from, so
	 * it runs at the parent's in force when cut (D23), and the flag is what puts
	 * it there: as of `claude 2.1.280`, `--effort` took effect on a spawn
	 * (docs/MANUAL_TESTING.md, OW-nabano).
	 */
	it("forks before the first message at the effort the parent runs at (D23)", async () => {
		const parent = harness({ entries: storedEntries(), ids: ["forked-1"], appliedEffort: "max" });
		await parent.adapter.start({ cwd: "/workspace", resumeId: "parent" });
		expect(parent.adapter.getState().effort).toBe("max");

		const forked = await parent.adapter.fork(CLAUDE_FORK_SESSION_START);
		const fork = harness({ entries: storedEntries(), ref: forked.ref });
		await fork.adapter.start(forked.start ?? { cwd: "/workspace" });

		expect(fork.spawns).toEqual([
			{ cwd: "/workspace", sessionId: "forked-1", model: "last-model", effort: "max" },
		]);
	});

	it("forks before the first message with no effort when the parent's model has none", async () => {
		// As of `claude 2.1.280`, haiku applied a null effort (OW-hokaye).
		const parent = harness({ entries: storedEntries(), ids: ["forked-1"], appliedEffort: null });
		await parent.adapter.start({ cwd: "/workspace", resumeId: "parent" });

		const forked = await parent.adapter.fork(CLAUDE_FORK_SESSION_START);
		const fork = harness({ entries: storedEntries(), ref: forked.ref });
		await fork.adapter.start(forked.start ?? { cwd: "/workspace" });

		expect(fork.spawns).toEqual([{ cwd: "/workspace", sessionId: "forked-1", model: "last-model" }]);
	});

	/**
	 * As of `claude 2.1.280`, a resume restores the stored model widened to the
	 * `[1m]` variant the settings or the store's `model` attachment name, and
	 * a fresh spawn with `--model claude-opus-5-5` drops it, while `--model
	 * opus[1m]` keeps it (docs/MANUAL_TESTING.md, OW-tebibo, OW-faledu and
	 * OW-lizupu).
	 */
	describe("naming the model a store restores after the CLI's own answer (OW-faledu)", () => {
		function entriesOn(model: string): ClaudeStoreMessageEntry[] {
			return storedEntries().map((entry) =>
				entry.uuid === "a3"
					? { ...entry, record: { ...entry.record, message: { ...(entry.record.message as object), model } } }
					: entry,
			);
		}

		it("forks a resumed session at its start on the model the parent runs, [1m] included", async () => {
			const parent = harness({
				entries: entriesOn("claude-opus-5-5"),
				ids: ["forked-1"],
				appliedModel: "claude-opus-5-5[1m]",
				models: MODELS,
			});
			await parent.adapter.start({ cwd: "/workspace", resumeId: "parent" });

			expect(parent.adapter.getState().model).toBe("opus[1m]");
			expect(parent.spawns).toEqual([{ cwd: "/workspace", resumeId: "parent" }]);

			const forked = await parent.adapter.fork(CLAUDE_FORK_SESSION_START);
			const fork = harness({ entries: entriesOn("claude-opus-5-5"), ref: forked.ref });
			await fork.adapter.start(forked.start ?? { cwd: "/workspace" });

			const spawned = fork.spawns[0]?.model;
			expect(fork.spawns).toEqual([{ cwd: "/workspace", sessionId: "forked-1", model: "opus[1m]" }]);
			expect(MODELS.find((model) => model.value === spawned)?.resolvedModel).toBe("claude-opus-5-5[1m]");
		});

		it("names a stored model the settings do not select by its listed id", async () => {
			const h = harness({
				entries: entriesOn("claude-sonnet-5"),
				ids: ["forked-1"],
				appliedModel: "claude-sonnet-5",
				models: MODELS,
			});
			await h.adapter.start({ cwd: "/workspace", resumeId: "parent" });

			expect(h.adapter.getState().model).toBe("sonnet");
			expect((await h.adapter.fork(CLAUDE_FORK_SESSION_START)).start?.model).toBe("sonnet");
		});

		/**
		 * As of `claude 2.1.280`, a turn's `init` names the model in force as
		 * `get_settings`'s `applied.model` does, `[1m]` included, while its
		 * assistant event and store line name the id without the variant: on
		 * a sonnet `[1m]` session, fresh and resumed, `init` read
		 * `claude-sonnet-5[1m]` and the assistant `claude-sonnet-5`
		 * (docs/MANUAL_TESTING.md, OW-lizupu). No opus turn ran; this applies
		 * that relation to the owner's `opus[1m]`, where `init` replaces a
		 * listed id and so the branch that handles it is exercised.
		 */
		it("forks at its start after a turn on a model that keeps [1m] (OW-lizupu)", async () => {
			const h = harness({
				entries: entriesOn("claude-opus-5-5"),
				ids: ["forked-1"],
				appliedModel: "claude-opus-5-5[1m]",
				models: MODELS,
			});
			await h.adapter.start({ cwd: "/workspace", resumeId: "parent" });
			expect(h.adapter.getState().model).toBe("opus[1m]");
			await h.adapter.submit("Reply with the single word ok");

			h.proc().emit({ type: "system", subtype: "init", session_id: "parent", model: "claude-opus-5-5[1m]" });
			h.proc().emit({
				type: "assistant",
				message: {
					id: "msg_c",
					role: "assistant",
					model: "claude-opus-5-5",
					content: [{ type: "text", text: "ok" }],
				},
			});
			h.proc().emit({ type: "result", subtype: "success", is_error: false });

			// Either name puts `claude-opus-5-5[1m]` in force in a fresh spawn (OW-faledu).
			const spawned = (await h.adapter.fork(CLAUDE_FORK_SESSION_START)).start?.model;
			expect(["opus[1m]", "claude-opus-5-5[1m]"]).toContain(spawned);
		});

		it("names the model in force itself when no listed id resolves to it", async () => {
			// A stored opus under a settings model of sonnet runs without the variant.
			const h = harness({
				entries: entriesOn("claude-opus-5-5"),
				ids: ["forked-1"],
				appliedModel: "claude-opus-5-5",
				models: MODELS,
			});
			await h.adapter.start({ cwd: "/workspace", resumeId: "parent" });

			expect(h.adapter.getState().model).toBe("claude-opus-5-5");
			expect((await h.adapter.fork(CLAUDE_FORK_SESSION_START)).start?.model).toBe("claude-opus-5-5");
		});

		it("names a fork at an entry by the model its own process runs", async () => {
			const h = harness({
				entries: entriesOn("claude-opus-5-5"),
				ref: { backend: "claude", id: "forked-1" },
				appliedModel: "claude-opus-5-5[1m]",
				models: [
					{ value: "default", resolvedModel: "claude-opus-5-5[1m]" },
					{ value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]" },
				],
			});
			// The kept prefix names `m`, which the fake's process widens like the CLI would.
			await h.adapter.start({ cwd: "/workspace", forkOf: { parentId: "parent", entryId: "a2" } });

			expect(h.spawns[0]?.model).toBeUndefined();
			expect(h.adapter.getState().model).toBe("opus[1m]");
		});

		it("keeps a model chosen at resume and asks no initialize for it", async () => {
			const h = harness({ entries: storedEntries(), appliedModel: "claude-opus-5-5[1m]", models: MODELS });
			await h.adapter.start({ cwd: "/workspace", resumeId: "parent", model: "sonnet" });

			expect(h.adapter.getState().model).toBe("sonnet");
			expect(h.proc().lastControlRequest("initialize")).toBeUndefined();
		});
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
