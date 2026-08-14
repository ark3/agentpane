import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionPreviewTurn, SessionRef } from "../../shared/protocol.ts";
import { readSessionPreview } from "./preview.ts";

/**
 * OW-38: the read-only, non-attaching preview path. These prove it reads
 * exactly one session file by ref -- Pi by its path (D9), Codex by the uuid
 * embedded in the filename -- and never the whole corpus.
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

function piMessage(role: "user" | "assistant", text: string) {
	return {
		type: "message",
		id: "m",
		parentId: null,
		timestamp: "t",
		message: { role, content: [{ type: "text", text }] },
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
		payload: { type: "message", role: "user", content: texts.map((text) => ({ type: "input_text", text })) },
	};
}

function codexAssistant(text: string) {
	return {
		type: "response_item",
		payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
	};
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
		it("returns the flattened user/assistant text conversation from the ref's file (D9)", async () => {
			const file = join(root, "session.jsonl");
			await writeJsonl(file, [
				piHeader(),
				piMessage("user", "First question."),
				piMessage("assistant", "First answer."),
				piMessage("user", "Second question."),
				piMessage("assistant", "Second answer."),
			]);

			const ref: SessionRef = { backend: "pi", id: file };
			const turns = await readSessionPreview(ref, { piRoot: root });

			expect(turns).toEqual<SessionPreviewTurn[]>([
				{ role: "user", text: "First question." },
				{ role: "assistant", text: "First answer." },
				{ role: "user", text: "Second question." },
				{ role: "assistant", text: "Second answer." },
			]);
		});

		it("drops tool results and thinking, keeping only the text turns", async () => {
			const file = join(root, "with-tools.jsonl");
			await writeJsonl(file, [
				piHeader(),
				piMessage("user", "Read the file."),
				{
					type: "message",
					id: "a",
					parentId: null,
					timestamp: "t",
					// assistant turn that is only a tool call + thinking, no text
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "internal" },
							{ type: "toolCall", toolName: "read", toolCallId: "c1" },
						],
					},
				},
				{
					type: "message",
					id: "r",
					parentId: null,
					timestamp: "t",
					message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "file body" }] },
				},
				piMessage("assistant", "It says hello."),
			]);

			const turns = await readSessionPreview({ backend: "pi", id: file }, { piRoot: root });

			expect(turns).toEqual<SessionPreviewTurn[]>([
				{ role: "user", text: "Read the file." },
				{ role: "assistant", text: "It says hello." },
			]);
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
						return [{ role: "user", text: "only me" }];
					},
				},
			);

			expect(turns).toEqual([{ role: "user", text: "only me" }]);
			expect(reads).toEqual([wanted]);
		});
	});

	describe("Codex", () => {
		const THREAD = "019f1aae-2a5e-7173-a90a-aad3e2b17d0b";

		it("finds the one file whose name carries the thread id and flattens its text turns", async () => {
			const file = join(root, "2026", "08", "12", `rollout-2026-08-12T22-10-29-${THREAD}.jsonl`);
			await writeJsonl(file, [
				codexHeader(THREAD),
				codexUser("<environment_context>\n  <cwd>/x</cwd>\n</environment_context>"),
				codexUser("Fix the failing test."),
				codexAssistant("Done, it passes now."),
			]);

			const turns = await readSessionPreview({ backend: "codex", id: THREAD }, { codexRoot: root });

			// The synthetic wrapper turn is dropped; the real turns survive in order.
			expect(turns).toEqual<SessionPreviewTurn[]>([
				{ role: "user", text: "Fix the failing test." },
				{ role: "assistant", text: "Done, it passes now." },
			]);
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
						return [{ role: "user", text: "only me" }];
					},
				},
			);

			expect(turns).toEqual([{ role: "user", text: "only me" }]);
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
	});
});
