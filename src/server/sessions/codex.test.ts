import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCodexSession } from "./codex.ts";

/**
 * Fixtures below are synthesized, not copied from real transcripts -- see
 * the workstream brief ("do not commit anything derived from real session
 * contents"). Shapes are drawn from the protocol description in
 * DESIGN/HANDOFF plus structural patterns confirmed against this machine's
 * real sessions during development (never committed).
 */

async function write(dir: string, name: string, lines: unknown[]): Promise<string> {
	const file = join(dir, name);
	await writeFile(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	return file;
}

function sessionMetaHeader(overrides: Record<string, unknown> = {}) {
	return {
		timestamp: "2026-06-30T22:37:29.620Z",
		type: "session_meta",
		payload: {
			id: "019f1aae-2a5e-7173-a90a-aad3e2b17d0b",
			timestamp: "2026-06-30T22:37:29.570Z",
			cwd: "/home/user/workspace/project",
			originator: "codex-tui",
			cli_version: "0.142.4",
			model_provider: "openai",
			...overrides,
		},
	};
}

function userResponseItem(texts: string[]) {
	return {
		timestamp: "2026-06-30T22:37:30.000Z",
		type: "response_item",
		payload: {
			type: "message",
			role: "user",
			content: texts.map((text) => ({ type: "input_text", text })),
		},
	};
}

describe("parseCodexSession", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "agentpane-codex-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("extracts id/cwd/createdAt from a session_meta header and a plain first user message", async () => {
		const file = await write(dir, "a.jsonl", [
			sessionMetaHeader(),
			userResponseItem(["What does this function do?"]),
		]);
		const s = await parseCodexSession(file, await stat(file));

		expect(s.ref).toEqual({ backend: "codex", id: "019f1aae-2a5e-7173-a90a-aad3e2b17d0b" });
		expect(s.cwd).toBe("/home/user/workspace/project");
		expect(s.createdAt).toBe("2026-06-30T22:37:29.570Z");
		expect(s.preview).toBe("What does this function do?");
		expect(s.status).toBe("detached");
		expect(s.isStreaming).toBe(false);
		expect(s.updatedAt).toBe((await stat(file)).mtime.toISOString());
	});

	it("skips synthetic wrapper turns (AGENTS.md dump, environment_context) to find the real first message", async () => {
		// This is the common real-world shape: the first (sometimes first two)
		// "user"-role items are 100% harness-injected content.
		const file = await write(dir, "b.jsonl", [
			sessionMetaHeader(),
			userResponseItem([
				"# AGENTS.md instructions for /home/user/workspace/project\n\n<INSTRUCTIONS>\nFollow the rules.",
				"<environment_context>\n  <cwd>/home/user/workspace/project</cwd>\n</environment_context>",
			]),
			userResponseItem(["Please fix the failing test in OrderServiceTest."]),
		]);
		const s = await parseCodexSession(file, await stat(file));

		expect(s.preview).toBe("Please fix the failing test in OrderServiceTest.");
	});

	it("returns a null preview if no real user message appears within the scan window", async () => {
		const file = await write(dir, "c.jsonl", [
			sessionMetaHeader(),
			userResponseItem(["<environment_context>\n  <cwd>/x</cwd>\n</environment_context>"]),
		]);
		const s = await parseCodexSession(file, await stat(file));

		expect(s.preview).toBeNull();
		expect(s.cwd).toBe("/home/user/workspace/project");
	});

	it("handles the drifted bare {id,timestamp} header with no cwd (HANDOFF finding 20)", async () => {
		const file = await write(dir, "d.jsonl", [
			{ id: "fb46154d-ac7b-41f3-aabc-e571edd4860b", timestamp: "2025-06-16T16:16:23.544Z" },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Investigate the test failure." }] },
		]);
		const s = await parseCodexSession(file, await stat(file));

		expect(s.ref).toEqual({ backend: "codex", id: "fb46154d-ac7b-41f3-aabc-e571edd4860b" });
		expect(s.cwd).toBeNull();
		expect(s.createdAt).toBe("2025-06-16T16:16:23.544Z");
		expect(s.preview).toBe("Investigate the test failure.");
	});

	it("never throws on a header it does not recognise, and falls back to a filename-derived id", async () => {
		const file = join(dir, "rollout-2026-01-01T00-00-00-019f1aae-2a5e-7173-a90a-aad3e2b17d0b.jsonl");
		await writeFile(file, "not json at all\nneither is this\n");

		const s = await parseCodexSession(file, await stat(file));

		expect(s.ref).toEqual({ backend: "codex", id: "019f1aae-2a5e-7173-a90a-aad3e2b17d0b" });
		expect(s.cwd).toBeNull();
		expect(s.createdAt).toBeNull();
		expect(s.preview).toBeNull();
	});

	it("falls back to the full path when even the filename has no recognisable uuid", async () => {
		const file = join(dir, "not-a-rollout-name.jsonl");
		await writeFile(file, "garbage\n");

		const s = await parseCodexSession(file, await stat(file));

		expect(s.ref).toEqual({ backend: "codex", id: file });
	});

	it("does not throw when the file disappears before it can be read", async () => {
		const file = join(dir, "vanishes.jsonl");
		await writeFile(file, `${JSON.stringify(sessionMetaHeader())}\n`);
		const s0 = await stat(file);
		await rm(file);

		const s = await parseCodexSession(file, s0);
		expect(s.preview).toBeNull();
	});
});
