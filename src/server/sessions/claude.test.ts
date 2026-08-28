import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionPreviewTurn } from "../../shared/protocol.ts";
import { extractClaudePreviewTurns, findClaudeSessionFiles, parseClaudeSession } from "./claude.ts";

/**
 * Fixtures below are synthesized, not copied from real transcripts -- see
 * the workstream brief ("do not commit anything derived from real session
 * contents"). Shapes are drawn from OW-votasi's store description plus
 * structural patterns confirmed against this machine's real
 * ~/.claude/projects during development (never committed).
 */

const SID = "3af1e5da-9f22-4f34-9c2b-6b7e2f1c9d44";

async function write(dir: string, name: string, lines: unknown[]): Promise<string> {
	const file = join(dir, name);
	await writeFile(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	return file;
}

/** A message line's envelope fields, shared by user and assistant lines. */
function envelope(overrides: Record<string, unknown> = {}) {
	return {
		sessionId: SID,
		timestamp: "2026-08-20T10:00:00.000Z",
		cwd: "/home/user/workspace/project",
		gitBranch: "main",
		version: "2.1.230",
		isSidechain: false,
		userType: "external",
		parentUuid: null,
		uuid: "u1",
		...overrides,
	};
}

function userLine(content: string | unknown[], overrides: Record<string, unknown> = {}) {
	return { type: "user", ...envelope(overrides), message: { role: "user", content } };
}

function assistantLine(text: string, overrides: Record<string, unknown> = {}) {
	return {
		type: "assistant",
		...envelope(overrides),
		message: { role: "assistant", content: [{ type: "text", text }] },
	};
}

function textBlock(text: string) {
	return { type: "text", text };
}

function previewText(turn: SessionPreviewTurn | undefined): string {
	if (!turn || (turn.role !== "user" && turn.role !== "assistant")) return "";
	if (typeof turn.content === "string") return turn.content;
	return turn.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

describe("parseClaudeSession", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "agentpane-claude-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("reads sessionId/cwd/first-timestamp from the lines (there is no header) and previews the first human message", async () => {
		const file = await write(dir, `${SID}.jsonl`, [
			// Real files open with any of user/queue-operation/mode/custom-title/
			// ai-title lines; metadata must come from whichever line carries it.
			{ type: "queue-operation", operation: "dequeue", sessionId: SID, timestamp: "2026-08-20T09:59:59.000Z" },
			{ type: "ai-title", aiTitle: "Fixing the widget", sessionId: SID },
			userLine([textBlock("What does this function do?")]),
			assistantLine("It parses the store."),
		]);
		const s = await parseClaudeSession(file, await stat(file));

		expect(s.ref).toEqual({ backend: "claude", id: SID });
		expect(s.cwd).toBe("/home/user/workspace/project");
		expect(s.createdAt).toBe("2026-08-20T09:59:59.000Z");
		expect(s.preview).toBe("What does this function do?");
		expect(s.status).toBe("detached");
		expect(s.isStreaming).toBe(false);
		expect(s.updatedAt).toBe((await stat(file)).mtime.toISOString());
	});

	it("accepts plain-string user content, which real files carry alongside block arrays", async () => {
		const file = await write(dir, `${SID}.jsonl`, [userLine("Just a plain string prompt.")]);
		const s = await parseClaudeSession(file, await stat(file));

		expect(s.preview).toBe("Just a plain string prompt.");
	});

	it("skips isSidechain lines (inline subagent traffic) when deriving the preview", async () => {
		const file = await write(dir, `${SID}.jsonl`, [
			userLine([textBlock("subagent prompt, not the human")], { isSidechain: true }),
			userLine([textBlock("the human's actual question")]),
		]);
		const s = await parseClaudeSession(file, await stat(file));

		expect(s.preview).toBe("the human's actual question");
	});

	it("skips wrapper content (<command-name>, <system-reminder>, caveat) to find the real first message", async () => {
		const file = await write(dir, `${SID}.jsonl`, [
			userLine("<local-command-caveat>Caveat: the messages below were generated.</local-command-caveat>"),
			userLine("<command-name>/execute</command-name>"),
			userLine([
				textBlock("<system-reminder>\nSomething injected.\n</system-reminder>"),
				textBlock("Please fix the failing test."),
			]),
		]);
		const s = await parseClaudeSession(file, await stat(file));

		expect(s.preview).toBe("Please fix the failing test.");
	});

	it("returns a null preview when every user turn is wrapper content", async () => {
		const file = await write(dir, `${SID}.jsonl`, [
			userLine("<command-name>/clear</command-name>"),
			userLine("<local-command-stdout></local-command-stdout>"),
		]);
		const s = await parseClaudeSession(file, await stat(file));

		expect(s.preview).toBeNull();
		expect(s.cwd).toBe("/home/user/workspace/project");
	});

	it("ignores tool-result user lines, whose content blocks carry no text", async () => {
		const file = await write(dir, `${SID}.jsonl`, [
			userLine([{ type: "tool_result", tool_use_id: "t1", content: "output of a tool" }], {
				toolUseResult: { stdout: "output of a tool" },
			}),
			userLine([textBlock("the real question")]),
		]);
		const s = await parseClaudeSession(file, await stat(file));

		expect(s.preview).toBe("the real question");
	});

	it("buckets unknown line types rather than throwing (Claude Code versions weekly; drift is a certainty)", async () => {
		const file = await write(dir, `${SID}.jsonl`, [
			{ type: "some-future-line-type", payload: { anything: true } },
			userLine([textBlock("still found")]),
		]);
		const s = await parseClaudeSession(file, await stat(file));

		expect(s.preview).toBe("still found");
	});

	it("never throws on unparseable content, and falls back to the filename uuid for the id", async () => {
		const file = join(dir, `${SID}.jsonl`);
		await writeFile(file, "not json at all\nneither is this\n");

		const s = await parseClaudeSession(file, await stat(file));

		expect(s.ref).toEqual({ backend: "claude", id: SID });
		expect(s.cwd).toBeNull();
		expect(s.createdAt).toBeNull();
		expect(s.preview).toBeNull();
	});

	it("falls back to the full path when even the filename carries no uuid", async () => {
		const file = join(dir, "not-a-session-name.jsonl");
		await writeFile(file, "garbage\n");

		const s = await parseClaudeSession(file, await stat(file));

		expect(s.ref).toEqual({ backend: "claude", id: file });
	});

	it("does not throw when the file disappears before it can be read", async () => {
		const file = join(dir, "vanishes.jsonl");
		await writeFile(file, `${JSON.stringify(userLine("hello"))}\n`);
		const s0 = await stat(file);
		await rm(file);

		const s = await parseClaudeSession(file, s0);
		expect(s.preview).toBeNull();
	});
});

describe("findClaudeSessionFiles", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "agentpane-claude-walk-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("lists <root>/<munged-cwd>/<uuid>.jsonl and excludes deeper per-session auxiliaries (subagents/)", async () => {
		const projectDir = join(root, "-home-user-workspace-project");
		const session = join(projectDir, `${SID}.jsonl`);
		const subagent = join(projectDir, SID, "subagents", "agent-a41b55adb50bd4b1d.jsonl");
		await mkdir(join(subagent, ".."), { recursive: true });
		await writeFile(session, "{}\n");
		await writeFile(subagent, "{}\n");
		// A stray non-jsonl sibling must not be picked up either.
		await writeFile(join(projectDir, "notes.txt"), "x\n");

		expect(await findClaudeSessionFiles(root)).toEqual([session]);
	});

	it("returns an empty list for a missing root (no sessions on this machine yet)", async () => {
		expect(await findClaudeSessionFiles(join(root, "does-not-exist"))).toEqual([]);
	});
});

describe("extractClaudePreviewTurns", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "agentpane-claude-turns-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("maps non-sidechain transcript messages in order, dropping wrappers and title lines", async () => {
		const file = await write(dir, `${SID}.jsonl`, [
			{ type: "ai-title", aiTitle: "A generated title", sessionId: SID },
			userLine("<command-name>/execute</command-name>"),
			userLine([textBlock("First question.")], { timestamp: "2026-08-20T10:00:00.000Z" }),
			assistantLine("First answer.", { timestamp: "2026-08-20T10:00:05.000Z" }),
			userLine([{ type: "tool_result", tool_use_id: "t1", content: "tool output" }]),
			userLine([textBlock("sidechain, not ours")], { isSidechain: true }),
			userLine([textBlock("Second question.")], { timestamp: "2026-08-20T10:01:00.000Z" }),
		]);

		const turns = await extractClaudePreviewTurns(file);

		expect(turns.map((turn) => ({ role: turn.role, timestamp: turn.timestamp }))).toEqual([
			{ role: "user", timestamp: "2026-08-20T10:00:00.000Z" },
			{ role: "assistant", timestamp: "2026-08-20T10:00:05.000Z" },
			{ role: "toolResult", timestamp: "2026-08-20T10:00:00.000Z" },
			{ role: "user", timestamp: "2026-08-20T10:01:00.000Z" },
		]);
		expect(turns.map((turn) => previewText(turn))).toEqual([
			"First question.",
			"First answer.",
			"",
			"Second question.",
		]);
	});

	it("retains thinking and tool-use blocks alongside assistant text", async () => {
		const file = await write(dir, `${SID}.jsonl`, [
			{
				type: "assistant",
				...{ sessionId: SID, isSidechain: false, timestamp: "2026-08-20T10:00:05.000Z" },
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "internal" },
						{ type: "tool_use", id: "t1", name: "Read", input: {} },
						textBlock("The visible reply."),
					],
				},
			},
		]);

		const turns = await extractClaudePreviewTurns(file);

		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({
			role: "assistant",
			content: [
				{ type: "thinking" },
				{ type: "toolCall", id: "t1", name: "Read" },
				{ type: "text" },
			],
			timestamp: "2026-08-20T10:00:05.000Z",
		});
	});

	it("carries no timestamp for a record without a string timestamp (OW-71)", async () => {
		const file = await write(dir, `${SID}.jsonl`, [userLine("no time on me", { timestamp: undefined })]);

		const turns = await extractClaudePreviewTurns(file);

		expect(turns).toMatchObject([{ role: "user", content: [{ type: "text" }] }]);
		expect(turns[0]).not.toHaveProperty("timestamp");
	});

	it("reads past line-reader's enumeration caps (200 lines, 512KB) to the real end of a long session (OW-43)", async () => {
		const filler = "x".repeat(3000);
		const messageCount = 300;
		const lines: unknown[] = [];
		for (let i = 0; i < messageCount; i++) {
			lines.push(
				i % 2 === 0
					? userLine([textBlock(`${filler} turn-${i}`)])
					: assistantLine(`${filler} turn-${i}`),
			);
		}
		const file = await write(dir, `${SID}.jsonl`, lines);

		const turns = await extractClaudePreviewTurns(file);

		expect(turns.length).toBe(messageCount);
		const late = turns[250];
		expect(previewText(late)).toContain("turn-250");
	});
});
