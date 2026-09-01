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
			model: "m",
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
} = {}): Harness {
	const procs: FakeClaudeProcess[] = [];
	const spawns: ClaudeSpawnOptions[] = [];
	const ids = [...(options.ids ?? ["minted-1", "minted-2"])];
	const adapter = new ClaudeAdapter(VIRTUAL_REF, {
		spawn: (opts) => {
			spawns.push(opts);
			const proc = new FakeClaudeProcess();
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

		expect(h.spawns).toEqual([{ cwd: "/workspace", resumeId: "stored-id" }]);
		expect(h.adapter.ref).toEqual({ backend: "claude", id: "stored-id" });
		expect(h.adapter.getState().messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(updates).toHaveBeenCalled();
	});

	it("adopts the session id the init event reports", async () => {
		const h = harness();
		await h.adapter.start({ cwd: "/workspace" });

		h.proc().emit({ type: "system", subtype: "init", session_id: "cli-chosen" });

		expect(h.adapter.ref).toEqual({ backend: "claude", id: "cli-chosen" });
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

	it("replays a recorded turn through the live process seam", async () => {
		const h = harness();
		await h.adapter.start({ cwd: "/workspace" });
		await h.adapter.submit("prompt");

		for (const event of readFixture("text-turn")) h.proc().emit(event);

		const { messages, isStreaming } = h.adapter.getState();
		expect(isStreaming).toBe(false);
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
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
						{ value: "default", displayName: "Default (recommended)" },
						{ value: "haiku" },
					],
				},
			},
		});

		expect(await listing).toEqual([
			{ id: "default", label: "Default (recommended)" },
			{ id: "haiku", label: "haiku" },
		]);
	});

	it("sets the model via set_model and keeps it for later respawns", async () => {
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

		await h.adapter.fork("u1");
		expect(h.spawns.at(-1)?.model).toBe("haiku");
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
	it("offers one fork point per human prompt, carrying the PRECEDING entry uuid", async () => {
		const h = harness({ entries: storedEntries() });
		await h.adapter.start({ cwd: "/workspace", resumeId: "parent" });

		const points = await h.adapter.listForkPoints();

		// Truncation is inclusive of the named entry (OW-mayuza): forking before
		// the second prompt names the last entry of the first turn, and the
		// first prompt -- with nothing before it -- gets the session-start id.
		expect(points).toEqual([
			{ id: CLAUDE_FORK_SESSION_START, text: "first prompt" },
			{ id: "a2", text: "second prompt" },
		]);
	});

	it("forks by respawning onto a minted id and hydrating the truncated history", async () => {
		const h = harness({ entries: storedEntries(), ids: ["forked-1"] });
		await h.adapter.start({ cwd: "/workspace", resumeId: "parent" });

		const forked = await h.adapter.fork("a2");

		expect(forked).toEqual({ backend: "claude", id: "forked-1" });
		expect(h.adapter.ref).toEqual(forked);
		expect(h.procs[0]?.killCount).toBe(1);
		expect(h.spawns.at(-1)).toEqual({
			cwd: "/workspace",
			resumeId: "parent",
			forkAtEntryId: "a2",
			sessionId: "forked-1",
		});
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

		expect(forked).toEqual({ backend: "claude", id: "forked-1" });
		expect(h.spawns.at(-1)).toEqual({ cwd: "/workspace", sessionId: "forked-1" });
		expect(h.adapter.getState().messages).toEqual([]);
	});

	it("rejects an unknown fork point without touching the child", async () => {
		const h = harness({ entries: storedEntries() });
		await h.adapter.start({ cwd: "/workspace", resumeId: "parent" });

		await expect(h.adapter.fork("nope")).rejects.toThrow("unknown fork point: nope");
		expect(h.procs).toHaveLength(1);
		expect(h.procs[0]?.killed).toBe(false);
	});

	it("ignores lines from the retired child after a fork", async () => {
		const h = harness({ entries: storedEntries() });
		await h.adapter.start({ cwd: "/workspace", resumeId: "parent" });
		const old = h.proc();
		await h.adapter.fork("a2");
		const updates = vi.fn();
		h.adapter.onUpdate(updates);

		old.emit({ type: "system", subtype: "status", status: "requesting" });

		expect(updates).not.toHaveBeenCalled();
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
