import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractPiPreviewTurns, parsePiSession } from "./pi.ts";

async function write(dir: string, name: string, lines: unknown[]): Promise<string> {
	const file = join(dir, name);
	await writeFile(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	return file;
}

function sessionHeader(overrides: Record<string, unknown> = {}) {
	return {
		type: "session",
		version: 3,
		id: "019e9905-f4fb-7e65-a8c0-03ce1074b653",
		timestamp: "2026-06-05T18:22:44.987Z",
		cwd: "/home/user/workspace/project",
		...overrides,
	};
}

function userMessage(text: string, id = "dc9a1ed5", parentId: string | null = "3bad6d37") {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-06-05T18:25:00.147Z",
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

describe("parsePiSession", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "agentpane-pi-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("uses the file path as the session id, per DESIGN D9", async () => {
		const file = await write(dir, "a.jsonl", [sessionHeader(), userMessage("Please help me with X.")]);
		const s = await parsePiSession(file, await stat(file));

		expect(s.ref).toEqual({ backend: "pi", id: file });
		expect(s.cwd).toBe("/home/user/workspace/project");
		expect(s.createdAt).toBe("2026-06-05T18:22:44.987Z");
		expect(s.preview).toBe("Please help me with X.");
		expect(s.status).toBe("detached");
		expect(s.isStreaming).toBe(false);
	});

	it("skips non-message lines (model_change, thinking_level_change) before the first user message", async () => {
		const file = await write(dir, "b.jsonl", [
			sessionHeader(),
			{ type: "model_change", id: "01adba6b", parentId: null, timestamp: "t", provider: "x", modelId: "y" },
			{ type: "thinking_level_change", id: "3bad6d37", parentId: "01adba6b", timestamp: "t", thinkingLevel: "high" },
			userMessage("Real first question."),
		]);
		const s = await parsePiSession(file, await stat(file));

		expect(s.preview).toBe("Real first question.");
	});

	it("collapses and truncates a long, multi-line preview", async () => {
		const long = "line one\nline two   with   spaces\n".repeat(20);
		const file = await write(dir, "c.jsonl", [sessionHeader(), userMessage(long)]);
		const s = await parsePiSession(file, await stat(file));

		expect(s.preview).not.toBeNull();
		expect(s.preview?.includes("\n")).toBe(false);
		expect((s.preview as string).length).toBeLessThanOrEqual(200);
	});

	it("returns a null preview when no user message appears at all", async () => {
		const file = await write(dir, "d.jsonl", [sessionHeader()]);
		const s = await parsePiSession(file, await stat(file));

		expect(s.preview).toBeNull();
		expect(s.cwd).toBe("/home/user/workspace/project");
	});

	it("buckets unknown-workspace when the header has no recognisable type, without throwing", async () => {
		const file = join(dir, "e.jsonl");
		await writeFile(file, "not json\n");
		const s = await parsePiSession(file, await stat(file));

		expect(s.cwd).toBeNull();
		expect(s.createdAt).toBeNull();
		expect(s.ref).toEqual({ backend: "pi", id: file });
	});
});

describe("extractPiPreviewTurns", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "agentpane-pi-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("draws a compaction entry as a compactionSummary turn where it sits in the file (OW-livowu)", async () => {
		const file = await write(dir, "f.jsonl", [
			sessionHeader(),
			userMessage("Before the compaction.", "dc9a1ed5", null),
			{
				type: "compaction",
				id: "c85baa76",
				parentId: "dc9a1ed5",
				timestamp: "2026-06-05T18:26:00.000Z",
				summary: "## Goal\nExplain TCP/IP.",
				firstKeptEntryId: "dc9a1ed5",
				tokensBefore: 5915,
				details: { readFiles: [], modifiedFiles: [] },
				fromHook: false,
			},
			userMessage("After the compaction.", "5e0f2c11", "c85baa76"),
		]);
		const turns = await extractPiPreviewTurns(file);

		expect(turns.map((t) => t.role)).toEqual(["user", "compactionSummary", "user"]);
		expect(turns[1]).toEqual({
			role: "compactionSummary",
			summary: "## Goal\nExplain TCP/IP.",
			tokensBefore: 5915,
			timestamp: "2026-06-05T18:26:00.000Z",
		});
	});

	function entry(id: string, parentId: string | null, message: Record<string, unknown>) {
		return { type: "message", id, parentId, timestamp: `stamp-${id}`, message };
	}
	const system = { role: "system", content: "You are a coding agent." };
	const user = { role: "user", content: [{ type: "text", text: "A question." }] };
	const reply = (stopReason: string) => ({ role: "assistant", content: [{ type: "text", text: "A reply." }], stopReason });

	it("draws only the branch ending at the last entry, not the abandoned one it re-parents past (OW-gogoka)", async () => {
		// The shape OW-tadoju surveyed on the home server (`pi 1.2.0`): a user
		// message re-parented onto the system message, past a user message and
		// its aborted reply, which stay in the file.
		const file = await write(dir, "g.jsonl", [
			sessionHeader(),
			{ type: "model_change", id: "m", parentId: null, timestamp: "t", provider: "x", modelId: "y" },
			entry("s", "m", system),
			entry("u1", "s", user),
			entry("a1", "u1", reply("aborted")),
			entry("u2", "s", user),
			entry("a2", "u2", reply("stop")),
		]);
		const turns = await extractPiPreviewTurns(file);

		expect(turns.map((t) => t.timestamp)).toEqual(["stamp-s", "stamp-u2", "stamp-a2"]);
	});

	it("draws an earlier branch the file returned to, skipping the abandoned one between (OW-gogoka)", async () => {
		const file = await write(dir, "h.jsonl", [
			sessionHeader(),
			entry("u1", null, user),
			entry("a1", "u1", reply("stop")),
			entry("u2", "a1", user),
			entry("a2", "u2", reply("stop")),
			entry("u3", "a1", user),
			entry("a3", "u3", reply("stop")),
		]);
		const turns = await extractPiPreviewTurns(file);

		expect(turns.map((t) => t.timestamp)).toEqual(["stamp-u1", "stamp-a1", "stamp-u3", "stamp-a3"]);
	});

	it("draws a version 1 file, whose entries carry no ids, in file order (OW-gogoka)", async () => {
		const file = await write(dir, "i.jsonl", [
			sessionHeader({ version: undefined }),
			{ type: "message", timestamp: "stamp-u1", message: user },
			{ type: "message", timestamp: "stamp-a1", message: reply("stop") },
			{ type: "message", timestamp: "stamp-u2", message: user },
		]);
		const turns = await extractPiPreviewTurns(file);

		expect(turns.map((t) => t.timestamp)).toEqual(["stamp-u1", "stamp-a1", "stamp-u2"]);
	});

	it("times a reply by the message's own timestamp, not its entry's append time (OW-jiwaso)", async () => {
		const file = await write(dir, "j.jsonl", [
			sessionHeader(),
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "2026-10-14T22:14:02.371Z",
				message: { ...reply("stop"), timestamp: Date.parse("2026-10-14T22:13:49.797Z") },
			},
		]);
		const turns = await extractPiPreviewTurns(file);

		expect(turns.map((t) => t.timestamp)).toEqual(["2026-10-14T22:13:49.797Z"]);
	});

	it("falls back to the entry's time for a reply without its own (OW-jiwaso)", async () => {
		const file = await write(dir, "k.jsonl", [
			sessionHeader(),
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "2026-10-14T22:14:02.371Z",
				message: reply("stop"),
			},
		]);
		const turns = await extractPiPreviewTurns(file);

		expect(turns.map((t) => t.timestamp)).toEqual(["2026-10-14T22:14:02.371Z"]);
	});

	it("keeps an error reply's errorMessage, which both clients draw (OW-kejele)", async () => {
		const file = await write(dir, "l.jsonl", [
			sessionHeader(),
			entry("a1", null, { ...reply("error"), errorMessage: "The provider refused." }),
		]);
		const turns = await extractPiPreviewTurns(file);

		expect(turns).toEqual([
			expect.objectContaining({ role: "assistant", stopReason: "error", errorMessage: "The provider refused." }),
		]);
	});

	// What `pi 1.2.0` stored for a Stop during a `bash` call (docs/MANUAL_TESTING.md,
	// OW-yewiku): the call's error result, then an empty reply that failed on the
	// aborted signal. The file does not record that anyone pressed Stop.
	const call = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_sleep", name: "bash", arguments: { command: "sleep 20; echo done" } }],
		stopReason: "toolUse",
	};
	const aborted = {
		role: "toolResult",
		toolCallId: "call_sleep",
		toolName: "bash",
		content: [{ type: "text", text: "Command aborted" }],
		isError: true,
	};

	it("reads a Stop during a tool call as the stop it reads as live (OW-kibabi)", async () => {
		const file = await write(dir, "m.jsonl", [
			sessionHeader(),
			entry("u1", null, user),
			entry("a1", "u1", call),
			entry("r1", "a1", aborted),
			entry("a2", "r1", { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" }),
		]);
		const turns = await extractPiPreviewTurns(file);

		expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(turns[2]).toMatchObject({ isError: true });
		expect(turns[3]).toMatchObject({ role: "assistant", stopReason: "aborted", content: [] });
		expect(turns[3]).not.toHaveProperty("errorMessage");
	});

	it("keeps an error after a failed tool call that nobody stopped as an error (OW-kibabi)", async () => {
		const file = await write(dir, "n.jsonl", [
			sessionHeader(),
			entry("u1", null, user),
			entry("a1", "u1", call),
			entry("r1", "a1", aborted),
			entry("a2", "r1", { role: "assistant", content: [], stopReason: "error", errorMessage: "The provider refused." }),
		]);
		const turns = await extractPiPreviewTurns(file);

		expect(turns[3]).toMatchObject({ stopReason: "error", errorMessage: "The provider refused." });
	});
});
