import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePiSession } from "./pi.ts";

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

function userMessage(text: string) {
	return {
		type: "message",
		id: "dc9a1ed5",
		parentId: "3bad6d37",
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
