import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionPreviewTurn, SessionRef } from "../../shared/protocol.ts";
import { readSessionPreview } from "./preview.ts";

/**
 * OW-38: the read-only, non-attaching preview path. These prove it reads
 * exactly one session file by ref -- Pi by its path (D9), Codex by the uuid
 * embedded in the filename -- and never the whole corpus. A Codex fork also
 * reads the rollouts its inherited history lives in (OW-buligi).
 *
 * Fixtures below are synthesized store-format JSONL, matching the sibling
 * parser tests (pi.test.ts / codex.test.ts): the recorded `resources/fixtures`
 * are RPC-stream captures, a different shape from the on-disk store these
 * parsers read.
 */

async function writeJsonl(file: string, lines: unknown[]): Promise<void> {
	await mkdir(join(file, ".."), { recursive: true });
	await writeFile(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

function piHeader(cwd = "/ws/project") {
	return { type: "session", version: 3, id: "hdr-id", timestamp: "2026-01-01T00:00:00.000Z", cwd };
}

function piMessage(role: "user" | "assistant", text: string, timestamp = "2026-06-05T18:25:00.147Z") {
	return {
		type: "message",
		id: "m",
		parentId: null,
		timestamp,
		message: { role, content: [{ type: "text", text }], timestamp: Date.parse(timestamp) },
	};
}

function claudeUser(content: string | unknown[], timestamp = "2026-08-20T10:00:00.000Z") {
	return {
		type: "user",
		sessionId: "sid",
		timestamp,
		cwd: "/ws/project",
		isSidechain: false,
		message: { role: "user", content },
	};
}

function claudeAssistant(text: string, timestamp = "2026-08-20T10:00:05.000Z") {
	return {
		type: "assistant",
		sessionId: "sid",
		timestamp,
		cwd: "/ws/project",
		isSidechain: false,
		message: { role: "assistant", content: [{ type: "text", text }] },
	};
}

function codexHeader(id: string, cwd = "/ws/project") {
	return {
		type: "session_meta",
		payload: { id, timestamp: "2026-01-01T00:00:00.000Z", cwd, model_provider: "openai" },
	};
}

function codexUser(...texts: string[]) {
	return {
		type: "response_item",
		timestamp: "2026-08-13T02:10:54.809Z",
		payload: { type: "message", role: "user", content: texts.map((text) => ({ type: "input_text", text })) },
	};
}

function codexTokenCount(totalTotal: number, lastTotal: number) {
	return {
		type: "event_msg",
		timestamp: "2026-08-28T07:29:00.000Z",
		payload: {
			type: "token_count",
			info: {
				total_token_usage: { total_tokens: totalTotal },
				last_token_usage: { total_tokens: lastTotal },
				model_context_window: 258400,
			},
			rate_limits: {},
		},
	};
}

function codexCompacted(timestamp: string) {
	return {
		type: "compacted",
		timestamp,
		payload: {
			message: "summary of the conversation so far",
			replacement_history: [],
			window_number: 1,
			first_window_id: "w0",
			previous_window_id: "w0",
			window_id: "w1",
		},
	};
}

function codexAssistant(text: string) {
	return {
		type: "response_item",
		timestamp: "2026-08-13T02:10:54.809Z",
		payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
	};
}

/**
 * One turn as `codex-cli` 0.156.0 writes it to a rollout, each record trimmed
 * to its type (OW-buligi). Only the two messages project, but every record
 * counts toward the ordinal a fork's `history_base` cuts at, so none is left
 * out. `opening` is what the first turn carries between `task_started` and
 * `turn_context`: injected instructions and a `world_state`.
 */
function codexTurn(prompt: string, reply: string, opening: unknown[] = []): unknown[] {
	return [
		{ type: "event_msg", payload: { type: "task_started" } },
		...opening,
		{ type: "turn_context", payload: {} },
		codexUser(prompt),
		{ type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage" } } },
		{ type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage" } } },
		codexAssistant(reply),
		{ type: "token_usage_record", payload: {} },
		codexTokenCount(31271, 15639),
		{ type: "event_msg", payload: { type: "task_complete" } },
	];
}

const CODEX_FIRST_TURN_OPENING = [
	{
		type: "response_item",
		payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<skills_instructions>" }] },
	},
	codexUser("<recommended_plugins>\n</recommended_plugins>"),
	{ type: "world_state", payload: {} },
];

const CODEX_SETTINGS_APPLIED = { type: "event_msg", payload: { type: "thread_settings_applied" } };

/**
 * A fork's header as 0.156.0 writes it: the file holds none of the inherited
 * records, and `history_base` says where they end in `base`'s rollout -- as an
 * ordinal over `base`'s whole history, which is its own lines plus whatever
 * `base` in turn inherited, and as a byte offset into `base`'s own file.
 */
function codexForkHeader(
	id: string,
	forkedFrom: string,
	base: { id: string; lines: unknown[]; inherited: number },
	ownLines: number,
) {
	const endOrdinal = base.inherited + ownLines;
	const endByteOffset = Buffer.byteLength(
		base.lines.slice(0, ownLines).map((line) => `${JSON.stringify(line)}\n`).join(""),
	);
	return {
		type: "session_meta",
		payload: {
			id,
			forked_from_id: forkedFrom,
			forked_from_ordinal_exclusive: endOrdinal,
			timestamp: "2026-09-22T23:44:00.679Z",
			cwd: "/ws/project",
			cli_version: "0.156.0",
			history_mode: "paginated",
			history_base: { thread_id: base.id, end_ordinal_exclusive: endOrdinal, end_byte_offset: endByteOffset },
		},
	};
}

function codexRollout(root: string, id: string): string {
	return join(root, "2026", "09", "22", `rollout-2026-09-22T19-43-49-${id}.jsonl`);
}

function previewText(turn: SessionPreviewTurn | undefined): string {
	if (!turn || (turn.role !== "user" && turn.role !== "assistant")) return "";
	if (typeof turn.content === "string") return turn.content;
	return turn.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

describe("readSessionPreview", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "agentpane-preview-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	describe("Pi", () => {
		it("does not read a ref outside the configured store root", async () => {
			const piRoot = join(root, "pi-sessions");
			const outside = join(root, "outside.jsonl");
			await mkdir(piRoot, { recursive: true });
			await writeJsonl(outside, [piHeader(), piMessage("user", "must stay unread")]);
			const readPiTurns = vi.fn(async () => []);

			const turns = await readSessionPreview(
				{ backend: "pi", id: outside },
				{ piRoot, readPiTurns },
			);

			expect(turns).toEqual([]);
			expect(readPiTurns).not.toHaveBeenCalled();
		});

		it("returns the user/assistant conversation from the ref's file (D9)", async () => {
			const file = join(root, "session.jsonl");
			await writeJsonl(file, [
				piHeader(),
				piMessage("user", "First question.", "2026-06-05T18:25:00.147Z"),
				piMessage("assistant", "First answer.", "2026-06-05T18:25:03.200Z"),
				piMessage("user", "Second question.", "2026-06-05T18:26:00.000Z"),
				piMessage("assistant", "Second answer.", "2026-06-05T18:26:07.500Z"),
			]);

			const ref: SessionRef = { backend: "pi", id: file };
			const turns = await readSessionPreview(ref, { piRoot: root });

			// The record's own timestamp rides each turn (OW-71), not dropped.
			expect(turns.map((turn) => ({ role: turn.role, timestamp: turn.timestamp }))).toEqual([
				{ role: "user", timestamp: "2026-06-05T18:25:00.147Z" },
				{ role: "assistant", timestamp: "2026-06-05T18:25:03.200Z" },
				{ role: "user", timestamp: "2026-06-05T18:26:00.000Z" },
				{ role: "assistant", timestamp: "2026-06-05T18:26:07.500Z" },
			]);
			expect(turns.map((turn) => previewText(turn))).toEqual([
				"First question.",
				"First answer.",
				"Second question.",
				"Second answer.",
			]);
		});

		it("carries no timestamp for a record whose timestamp is not a string (OW-71)", async () => {
			// Absent must stay absent: the client edge renders no time rather than
			// the epoch. A non-string timestamp is the shape a malformed record has.
			const file = join(root, "no-stamp.jsonl");
			await writeJsonl(file, [
				piHeader(),
				{ type: "message", id: "m", parentId: null, message: { role: "user", content: [{ type: "text", text: "no time on me" }] } },
			]);

			const turns = await readSessionPreview({ backend: "pi", id: file }, { piRoot: root });

			expect(turns).toMatchObject([{ role: "user", content: [{ type: "text" }] }]);
			expect(turns[0]).not.toHaveProperty("timestamp");
		});

		it("retains thinking, tool calls, and tool results in transcript order", async () => {
			const file = join(root, "with-tools.jsonl");
			await writeJsonl(file, [
				piHeader(),
				piMessage("user", "Read the file."),
				{
					type: "message",
					id: "a",
					parentId: null,
					timestamp: "t",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "internal" },
							{ type: "toolCall", id: "c1", name: "read", arguments: { path: "file.txt" } },
						],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "test-model",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						stopReason: "toolUse",
					},
				},
				{
					type: "message",
					id: "r",
					parentId: null,
					timestamp: "t",
					message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "file body" }], isError: false },
				},
				piMessage("assistant", "It says hello."),
			]);

			const turns = await readSessionPreview({ backend: "pi", id: file }, { piRoot: root });

			expect(turns.map((turn) => turn.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(turns[1]).toMatchObject({
				role: "assistant",
				content: [
					{ type: "thinking" },
					{ type: "toolCall", id: "c1", name: "read" },
				],
			});
			expect(turns[2]).toMatchObject({ role: "toolResult", toolCallId: "c1", toolName: "read" });
		});

		it("reads only the ref's file, never any sibling in the store", async () => {
			const wanted = join(root, "wanted.jsonl");
			const other1 = join(root, "ws-a", "other1.jsonl");
			const other2 = join(root, "ws-b", "other2.jsonl");
			await writeJsonl(wanted, [piHeader(), piMessage("user", "only me")]);
			await writeJsonl(other1, [piHeader(), piMessage("user", "not me 1")]);
			await writeJsonl(other2, [piHeader(), piMessage("user", "not me 2")]);

			const reads: string[] = [];
			const turns = await readSessionPreview(
				{ backend: "pi", id: wanted },
				{
					piRoot: root,
					readPiTurns: async (filePath) => {
						reads.push(filePath);
						return [{ role: "user", content: "only me" }];
					},
				},
			);

			expect(turns).toEqual([{ role: "user", content: "only me" }]);
			expect(reads).toEqual([wanted]);
		});

		it("reads past line-reader's enumeration caps (200 lines, 512KB) to the real end of a long session (OW-43)", async () => {
			// readLinesLfOnly defaults to 200 lines / 512KB -- sized for enumeration,
			// which reads just far enough to find one message and stops. The preview
			// extractor must not inherit those caps: it needs the whole file. This
			// fixture crosses both defaults well before its last message.
			const file = join(root, "long-session.jsonl");
			const filler = "x".repeat(3000);
			const messageCount = 300;
			const lines: unknown[] = [piHeader()];
			for (let i = 0; i < messageCount; i++) {
				lines.push(piMessage(i % 2 === 0 ? "user" : "assistant", `${filler} turn-${i}`));
			}
			await writeJsonl(file, lines);

			const turns = await readSessionPreview({ backend: "pi", id: file }, { piRoot: root });

			expect(turns.length).toBe(messageCount);
			// This turn sits past both the 200-line cap and the 512KB cap (each
			// ~3KB message line pushes bytesRead past 512KB by line ~170).
			const late = turns[250];
			expect(previewText(late)).toContain("turn-250");
		});
	});

	describe("Codex", () => {
		const THREAD = "019f1aae-2a5e-7173-a90a-aad3e2b17d0b";

		it("finds the one file whose name carries the thread id and maps its transcript", async () => {
			const file = join(root, "2026", "08", "12", `rollout-2026-08-12T22-10-29-${THREAD}.jsonl`);
			await writeJsonl(file, [
				codexHeader(THREAD),
				codexUser("<environment_context>\n  <cwd>/x</cwd>\n</environment_context>"),
				codexUser("Fix the failing test."),
				codexAssistant("Done, it passes now."),
			]);

			const turns = await readSessionPreview({ backend: "codex", id: THREAD }, { codexRoot: root });

			// The synthetic wrapper turn is dropped; the real turns survive in order,
			// each carrying its record's own timestamp (OW-71).
			expect(turns.map((turn) => ({ role: turn.role, timestamp: turn.timestamp }))).toEqual([
				{ role: "user", timestamp: "2026-08-13T02:10:54.809Z" },
				{ role: "assistant", timestamp: "2026-08-13T02:10:54.809Z" },
			]);
			expect(turns.map((turn) => previewText(turn))).toEqual([
				"Fix the failing test.",
				"Done, it passes now.",
			]);
		});

		it("carries no timestamp for a record without a string timestamp (OW-71)", async () => {
			const file = join(root, "2026", "08", "12", `rollout-2026-08-12T22-10-29-${THREAD}.jsonl`);
			await writeJsonl(file, [
				codexHeader(THREAD),
				{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "no time on me" }] } },
			]);

			const turns = await readSessionPreview({ backend: "codex", id: THREAD }, { codexRoot: root });

			expect(turns).toMatchObject([{ role: "user", content: [{ type: "text" }] }]);
			expect(turns[0]).not.toHaveProperty("timestamp");
		});

		it("retains response-item reasoning, tool calls, and tool results", async () => {
			const file = join(root, "2026", "08", "12", `rollout-2026-08-12T22-10-29-${THREAD}.jsonl`);
			await writeJsonl(file, [
				codexHeader(THREAD),
				codexUser("Inspect the file."),
				{
					type: "response_item",
					timestamp: "2026-08-13T02:10:55.000Z",
					payload: { type: "reasoning", summary: [{ type: "summary_text", text: "checking" }], content: [] },
				},
				{
					type: "response_item",
					timestamp: "2026-08-13T02:10:56.000Z",
					payload: { type: "function_call", call_id: "c1", name: "read", arguments: "{\"path\":\"file.txt\"}" },
				},
				{
					type: "response_item",
					timestamp: "2026-08-13T02:10:57.000Z",
					payload: { type: "function_call_output", call_id: "c1", output: "file body" },
				},
				codexAssistant("The file was inspected."),
			]);

			const turns = await readSessionPreview({ backend: "codex", id: THREAD }, { codexRoot: root });

			expect(turns.map((turn) => turn.role)).toEqual([
				"user",
				"assistant",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(turns[1]).toMatchObject({ role: "assistant", content: [{ type: "thinking" }] });
			expect(turns[2]).toMatchObject({
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "read" }],
			});
			expect(turns[3]).toMatchObject({ role: "toolResult", toolCallId: "c1" });
		});

		it("previews a stored function_call named exec_command as bash with the command and cwd (OW-jakahe)", async () => {
			const file = join(root, "2026", "08", "12", `rollout-2026-08-12T22-10-29-${THREAD}.jsonl`);
			await writeJsonl(file, [
				codexHeader(THREAD),
				{
					type: "response_item",
					payload: {
						type: "function_call",
						call_id: "c1",
						name: "exec_command",
						arguments: "{\"cmd\":\"echo probe\\npwd\",\"workdir\":\"/var/tmp/x\",\"yield_time_ms\":10000,\"max_output_tokens\":20000}",
					},
				},
				{ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "probe\n/var/tmp/x" } },
			]);

			const turns = await readSessionPreview({ backend: "codex", id: THREAD }, { codexRoot: root });

			expect(turns[0]).toMatchObject({
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo probe\npwd", cwd: "/var/tmp/x" } }],
			});
			expect(turns[1]).toMatchObject({ role: "toolResult", toolCallId: "c1", toolName: "bash" });
		});

		it.each([
			["bare", "{cmd:\"echo probe\\npwd\",workdir:\"/var/tmp/x\",yield_time_ms:10000,max_output_tokens:1000}"],
			["double-quoted", "{\"cmd\":\"echo probe\\npwd\",\"workdir\":\"/var/tmp/x\",\"yield_time_ms\":10000,\"max_output_tokens\":1000}"],
		])("previews a stored custom_tool_call named exec wrapping tools.exec_command with %s keys as bash (OW-jakahe)", async (_keys, object) => {
			const file = join(root, "2026", "08", "12", `rollout-2026-08-12T22-10-29-${THREAD}.jsonl`);
			await writeJsonl(file, [
				codexHeader(THREAD),
				{
					type: "response_item",
					payload: {
						type: "custom_tool_call",
						call_id: "c1",
						name: "exec",
						input: `const r = await tools.exec_command(${object}); text(r.output);\n`,
					},
				},
				{
					type: "response_item",
					payload: {
						type: "custom_tool_call_output",
						call_id: "c1",
						output: [{ type: "input_text", text: "Script completed\nWall time 0.2 seconds\nOutput:\n" }, { type: "input_text", text: "probe\n/var/tmp/x" }],
					},
				},
			]);

			const turns = await readSessionPreview({ backend: "codex", id: THREAD }, { codexRoot: root });

			expect(turns[0]).toMatchObject({
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo probe\npwd", cwd: "/var/tmp/x" } }],
			});
			expect(turns[1]).toMatchObject({ role: "toolResult", toolCallId: "c1", toolName: "bash" });
		});

		it("leaves a custom_tool_call named exec whose input is not a tools.exec_command script previewing under its raw name (OW-jakahe)", async () => {
			const file = join(root, "2026", "08", "12", `rollout-2026-08-12T22-10-29-${THREAD}.jsonl`);
			await writeJsonl(file, [
				codexHeader(THREAD),
				{
					type: "response_item",
					payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: "text(\"hello\");\n" },
				},
			]);

			const turns = await readSessionPreview({ backend: "codex", id: THREAD }, { codexRoot: root });

			expect(turns[0]).toMatchObject({
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "exec", arguments: { value: "text(\"hello\");\n" } }],
			});
		});

		it("returns an empty preview when no file carries the thread id, rather than throwing", async () => {
			await writeJsonl(join(root, "2026", "08", "12", "rollout-someone-else.jsonl"), [
				codexHeader("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
				codexUser("not the one you want"),
			]);

			const turns = await readSessionPreview({ backend: "codex", id: THREAD }, { codexRoot: root });
			expect(turns).toEqual([]);
		});

		it("reads only the matching file, never the other seeded sessions", async () => {
			const wanted = join(root, "2026", "08", "12", `rollout-2026-08-12T22-10-29-${THREAD}.jsonl`);
			const others = [
				join(root, "2026", "08", "10", "rollout-a-11111111-1111-1111-1111-111111111111.jsonl"),
				join(root, "2026", "08", "11", "rollout-b-22222222-2222-2222-2222-222222222222.jsonl"),
			];
			await writeJsonl(wanted, [codexHeader(THREAD), codexUser("only me")]);
			for (const o of others) await writeJsonl(o, [codexHeader("x"), codexUser("not me")]);

			const reads: string[] = [];
			const turns = await readSessionPreview(
				{ backend: "codex", id: THREAD },
				{
					codexRoot: root,
					readCodexTurns: async (filePath) => {
						reads.push(filePath);
						return [{ role: "user", content: "only me" }];
					},
				},
			);

			expect(turns).toEqual([{ role: "user", content: "only me" }]);
			// N files seeded, exactly one read: the N-1 others are never opened.
			expect(reads).toEqual([wanted]);
		});

		it("does not match a longer thread id that merely contains this one as a substring", async () => {
			const longer = `${THREAD}-extra`;
			await writeJsonl(join(root, `rollout-2026-08-12T22-10-29-${longer}.jsonl`), [
				codexHeader(longer),
				codexUser("longer id"),
			]);

			const turns = await readSessionPreview({ backend: "codex", id: THREAD }, { codexRoot: root });
			expect(turns).toEqual([]);
		});

		it("draws a compaction marker carrying the last token_count figure before the compacted record (OW-bisubi)", async () => {
			const file = join(root, "2026", "08", "12", `rollout-2026-08-12T22-10-29-${THREAD}.jsonl`);
			await writeJsonl(file, [
				codexHeader(THREAD),
				codexUser("Keep going."),
				codexTokenCount(11095489, 190000),
				codexTokenCount(11095489, 207782),
				// Nearer the `compacted` record than the last token_count, and
				// deliberately not used: this is the compaction call's own usage.
				{ type: "token_usage_record", timestamp: "2026-08-28T07:30:00.000Z", payload: { usage: { total_tokens: 231383 } } },
				codexCompacted("2026-08-28T07:30:01.000Z"),
				// 0.150.1 also writes this a few milliseconds later; matching it too
				// would draw a second marker for the one compaction.
				{ type: "event_msg", timestamp: "2026-08-28T07:30:01.010Z", payload: { type: "context_compacted" } },
				codexTokenCount(11095489, 6925),
				codexAssistant("Carrying on."),
			]);

			const turns = await readSessionPreview({ backend: "codex", id: THREAD }, { codexRoot: root });

			expect(turns.map((turn) => turn.role)).toEqual(["user", "compactionSummary", "assistant"]);
			expect(turns[1]).toMatchObject({
				role: "compactionSummary",
				summary: "",
				tokensBefore: 207782,
				timestamp: "2026-08-28T07:30:01.000Z",
			});
		});

		it("keeps the last figure across a null info, and reports 0 when none precedes the compaction (OW-bisubi)", async () => {
			const file = join(root, "2026", "08", "12", `rollout-2026-08-12T22-10-29-${THREAD}.jsonl`);
			await writeJsonl(file, [
				codexHeader(THREAD),
				codexUser("Keep going."),
				// `codex-cli` 0.147.0's compaction is preceded only by a null info,
				// so the first marker has no figure to draw.
				{ type: "event_msg", timestamp: "2026-08-12T22:30:00.000Z", payload: { type: "token_count", info: null } },
				codexCompacted("2026-08-12T22:30:01.000Z"),
				codexTokenCount(11095489, 190000),
				// A null info does not clear the figure, matching the live path,
				// where tokenUsage keeps its last non-null value.
				{ type: "event_msg", timestamp: "2026-08-12T22:31:00.000Z", payload: { type: "token_count", info: null } },
				codexCompacted("2026-08-12T22:31:01.000Z"),
			]);

			const turns = await readSessionPreview({ backend: "codex", id: THREAD }, { codexRoot: root });

			expect(turns.map((turn) => turn.role)).toEqual(["user", "compactionSummary", "compactionSummary"]);
			expect(turns[1]).toMatchObject({ tokensBefore: 0 });
			expect(turns[2]).toMatchObject({ tokensBefore: 190000 });
		});

		it("never lends one compaction's figure to the next (OW-bisubi)", async () => {
			const file = join(root, "2026", "08", "12", `rollout-2026-08-12T22-10-29-${THREAD}.jsonl`);
			await writeJsonl(file, [
				codexHeader(THREAD),
				codexUser("Keep going."),
				codexTokenCount(11095489, 207782),
				codexCompacted("2026-08-28T07:30:01.000Z"),
				// No token_count between the two: the second marker reports nothing
				// rather than borrowing 207782, which is why the live path keys its
				// figure by item id.
				codexCompacted("2026-08-28T07:31:01.000Z"),
			]);

			const turns = await readSessionPreview({ backend: "codex", id: THREAD }, { codexRoot: root });

			expect(turns.map((turn) => turn.role)).toEqual(["user", "compactionSummary", "compactionSummary"]);
			expect(turns[1]).toMatchObject({ tokensBefore: 207782 });
			expect(turns[2]).toMatchObject({ tokensBefore: 0 });
		});

		it("reads past line-reader's enumeration caps (200 lines, 512KB) to the real end of a long session (OW-43)", async () => {
			const file = join(root, "2026", "08", "12", `rollout-2026-08-12T22-10-29-${THREAD}.jsonl`);
			const filler = "x".repeat(3000);
			const messageCount = 300;
			const lines: unknown[] = [codexHeader(THREAD)];
			for (let i = 0; i < messageCount; i++) {
				lines.push(i % 2 === 0 ? codexUser(`${filler} turn-${i}`) : codexAssistant(`${filler} turn-${i}`));
			}
			await writeJsonl(file, lines);

			const turns = await readSessionPreview({ backend: "codex", id: THREAD }, { codexRoot: root });

			expect(turns.length).toBe(messageCount);
			const late = turns[250];
			expect(previewText(late)).toContain("turn-250");
		});

		describe("a fork whose rollout holds none of its inherited history (OW-buligi)", () => {
			const PARENT = "01a0cb81-1557-7a01-b5a1-7b22be24fbdd";
			const FORK = "01a0cb81-4088-7e73-b4ea-d20ab523535a";
			const FORK_OF_FORK = "01a0cbd3-9b9c-7852-904e-c4f3d521516c";

			// Two exchanges; a fork at the second user message keeps the first,
			// which ends with the parent's 13th line.
			const parentLines = [
				codexHeader(PARENT),
				...codexTurn("first prompt", "first reply", CODEX_FIRST_TURN_OPENING),
				CODEX_SETTINGS_APPLIED,
				...codexTurn("parent's second prompt", "parent's second reply"),
			];
			const fromParent = { id: PARENT, lines: parentLines, inherited: 0 };
			const forkLines = [
				codexForkHeader(FORK, PARENT, fromParent, 13),
				CODEX_SETTINGS_APPLIED,
				CODEX_SETTINGS_APPLIED,
				...codexTurn("fork's own prompt", "fork's own reply"),
				CODEX_SETTINGS_APPLIED,
				...codexTurn("fork's later prompt", "fork's later reply"),
			];

			it("draws the parent's turns through the fork point ahead of the fork's own", async () => {
				await writeJsonl(codexRollout(root, PARENT), parentLines);
				await writeJsonl(codexRollout(root, FORK), forkLines);

				const turns = await readSessionPreview({ backend: "codex", id: FORK }, { codexRoot: root });

				expect(turns.map((turn) => previewText(turn))).toEqual([
					"first prompt",
					"first reply",
					"fork's own prompt",
					"fork's own reply",
					"fork's later prompt",
					"fork's later reply",
				]);
			});

			it("draws only the fork's own turns when the parent's rollout is not in the store", async () => {
				await writeJsonl(codexRollout(root, FORK), forkLines);

				const turns = await readSessionPreview({ backend: "codex", id: FORK }, { codexRoot: root });

				expect(turns.map((turn) => previewText(turn))).toEqual([
					"fork's own prompt",
					"fork's own reply",
					"fork's later prompt",
					"fork's later reply",
				]);
			});

			it("draws a fork of a fork through its parent's own turn and its grandparent's", async () => {
				// Measured by `resources/probes/codex_fork_history_probe.py` on
				// 0.156.0: the base names the fork, the ordinal counts the 13
				// records the fork inherited plus the 13 of its own file kept here.
				await writeJsonl(codexRollout(root, PARENT), parentLines);
				await writeJsonl(codexRollout(root, FORK), forkLines);
				await writeJsonl(codexRollout(root, FORK_OF_FORK), [
					codexForkHeader(FORK_OF_FORK, FORK, { id: FORK, lines: forkLines, inherited: 13 }, 13),
					CODEX_SETTINGS_APPLIED,
				]);

				const turns = await readSessionPreview({ backend: "codex", id: FORK_OF_FORK }, { codexRoot: root });

				expect(turns.map((turn) => previewText(turn))).toEqual([
					"first prompt",
					"first reply",
					"fork's own prompt",
					"fork's own reply",
				]);
			});

			it("follows the base the header names, not the thread it was forked from", async () => {
				// A fork of a fork cut inside what that fork inherited: 0.154.0 wrote
				// its base as the grandparent (home-server rollouts, 2026-09-15).
				await writeJsonl(codexRollout(root, PARENT), parentLines);
				await writeJsonl(codexRollout(root, FORK), forkLines);
				await writeJsonl(codexRollout(root, FORK_OF_FORK), [
					codexForkHeader(FORK_OF_FORK, FORK, fromParent, 13),
					CODEX_SETTINGS_APPLIED,
				]);

				const turns = await readSessionPreview({ backend: "codex", id: FORK_OF_FORK }, { codexRoot: root });

				expect(turns.map((turn) => previewText(turn))).toEqual(["first prompt", "first reply"]);
			});

			it("leaves a subagent's rollout, which copies its parent's history inline, drawn once", async () => {
				// Through 0.154.0 a subagent carries `forked_from_id` but no
				// `history_base`, and its file repeats the parent's records after a
				// second `session_meta`.
				const SUBAGENT = "01a08be7-6b91-79b2-a508-ab46ec970c52";
				await writeJsonl(codexRollout(root, PARENT), parentLines);
				await writeJsonl(codexRollout(root, SUBAGENT), [
					{
						type: "session_meta",
						payload: { id: SUBAGENT, forked_from_id: PARENT, thread_source: "subagent", cwd: "/ws/project" },
					},
					...parentLines.slice(0, 13),
					codexAssistant("subagent's reply"),
				]);

				const turns = await readSessionPreview({ backend: "codex", id: SUBAGENT }, { codexRoot: root });

				expect(turns.map((turn) => previewText(turn))).toEqual([
					"first prompt",
					"first reply",
					"subagent's reply",
				]);
			});
		});
	});

	describe("Claude Code", () => {
		const SID = "3af1e5da-9f22-4f34-9c2b-6b7e2f1c9d44";

		it("finds the one file named after the session uuid and maps its transcript", async () => {
			const file = join(root, "-ws-project", `${SID}.jsonl`);
			await writeJsonl(file, [
				claudeUser("<command-name>/execute</command-name>"),
				claudeUser([{ type: "text", text: "Fix the failing test." }]),
				claudeAssistant("Done, it passes now."),
			]);

			const turns = await readSessionPreview({ backend: "claude", id: SID }, { claudeRoot: root });

			// The wrapper turn is dropped; the real turns survive in order, each
			// carrying its record's own timestamp (OW-71).
			expect(turns.map((turn) => ({ role: turn.role, timestamp: turn.timestamp }))).toEqual([
				{ role: "user", timestamp: "2026-08-20T10:00:00.000Z" },
				{ role: "assistant", timestamp: "2026-08-20T10:00:05.000Z" },
			]);
			expect(turns.map((turn) => previewText(turn))).toEqual([
				"Fix the failing test.",
				"Done, it passes now.",
			]);
		});

		it("retains thinking, tool use, and correlated tool results", async () => {
			const file = join(root, "-ws-project", `${SID}.jsonl`);
			await writeJsonl(file, [
				claudeUser([{ type: "text", text: "Inspect the file." }]),
				{
					type: "assistant",
					sessionId: SID,
					timestamp: "2026-08-20T10:00:05.000Z",
					isSidechain: false,
					message: {
						id: "msg-1",
						role: "assistant",
						model: "test-model",
						content: [
							{ type: "thinking", thinking: "checking" },
							{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "file.txt" } },
						],
					},
				},
				{
					type: "user",
					sessionId: SID,
					timestamp: "2026-08-20T10:00:06.000Z",
					isSidechain: false,
					message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "file body" }] },
				},
				claudeAssistant("The file was inspected."),
			]);

			const turns = await readSessionPreview({ backend: "claude", id: SID }, { claudeRoot: root });

			expect(turns.map((turn) => turn.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(turns[1]).toMatchObject({
				role: "assistant",
				content: [
					{ type: "thinking" },
					{ type: "toolCall", id: "c1", name: "Read" },
				],
			});
			expect(turns[2]).toMatchObject({ role: "toolResult", toolCallId: "c1", toolName: "Read" });
		});

		it("maps stored compaction metadata and its continuation summary onto one marker", async () => {
			const file = join(root, "-ws-project", `${SID}.jsonl`);
			await writeJsonl(file, [
				{
					type: "system",
					subtype: "compact_boundary",
					timestamp: "2026-08-20T10:02:00.000Z",
					compactMetadata: { trigger: "manual", preTokens: 12_345 },
				},
				{
					type: "user",
					timestamp: "2026-08-20T10:02:00.100Z",
					isCompactSummary: true,
					message: {
						role: "user",
						content: "This session is being continued from a compacted conversation.",
					},
				},
			]);

			const turns = await readSessionPreview({ backend: "claude", id: SID }, { claudeRoot: root });

			expect(turns).toHaveLength(1);
			expect(turns[0]).toMatchObject({
				role: "compactionSummary",
				tokensBefore: 12_345,
				timestamp: "2026-08-20T10:02:00.000Z",
			});
			if (turns[0]?.role !== "compactionSummary") throw new Error("missing compaction marker");
			expect(turns[0].summary.length).toBeGreaterThan(0);
		});

		it("returns an empty preview when no file carries the session uuid, rather than throwing", async () => {
			await writeJsonl(join(root, "-ws-project", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"), [
				claudeUser([{ type: "text", text: "not the one you want" }]),
			]);

			const turns = await readSessionPreview({ backend: "claude", id: SID }, { claudeRoot: root });
			expect(turns).toEqual([]);
		});

		it("reads only the matching file, never the other seeded sessions", async () => {
			const wanted = join(root, "-ws-project", `${SID}.jsonl`);
			const others = [
				join(root, "-ws-project", "11111111-1111-1111-1111-111111111111.jsonl"),
				join(root, "-ws-other", "22222222-2222-2222-2222-222222222222.jsonl"),
			];
			await writeJsonl(wanted, [claudeUser([{ type: "text", text: "only me" }])]);
			for (const o of others) await writeJsonl(o, [claudeUser([{ type: "text", text: "not me" }])]);

			const reads: string[] = [];
			const turns = await readSessionPreview(
				{ backend: "claude", id: SID },
				{
					claudeRoot: root,
					readClaudeTurns: async (filePath) => {
						reads.push(filePath);
						return [{ role: "user", content: "only me" }];
					},
				},
			);

			expect(turns).toEqual([{ role: "user", content: "only me" }]);
			expect(reads).toEqual([wanted]);
		});
	});
});
