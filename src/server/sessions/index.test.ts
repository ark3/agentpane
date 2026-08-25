import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSessions } from "./index.ts";

function codexHeader(id: string, cwd: string) {
	return {
		type: "session_meta",
		payload: { id, timestamp: "2026-01-01T00:00:00.000Z", cwd, model_provider: "openai" },
	};
}

function codexUserItem(text: string) {
	return {
		type: "response_item",
		payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
	};
}

function piHeader(id: string, cwd: string) {
	return { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd };
}

function claudeUserLine(sessionId: string, cwd: string, text: string) {
	return {
		type: "user",
		sessionId,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd,
		isSidechain: false,
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

function piUserMessage(text: string) {
	return { type: "message", id: "m1", parentId: null, timestamp: "t", message: { role: "user", content: [{ type: "text", text }] } };
}

async function writeJsonl(file: string, lines: unknown[]): Promise<void> {
	await mkdir(join(file, ".."), { recursive: true });
	await writeFile(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

describe("listSessions", () => {
	let root: string;
	let codexRoot: string;
	let piRoot: string;
	let claudeRoot: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "agentpane-index-"));
		codexRoot = join(root, "codex-sessions");
		piRoot = join(root, "pi-sessions");
		claudeRoot = join(root, "claude-projects");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("returns an empty list when no store exists on disk (smoke: no sessions yet)", async () => {
		const result = await listSessions({ codexRoot, piRoot, claudeRoot });
		expect(result).toEqual([]);
	});

	it("merges all three backends and sorts by recency (most recent first)", async () => {
		const oldFile = join(codexRoot, "2026", "01", "01", "rollout-old.jsonl");
		const midFile = join(piRoot, "ws", "mid.jsonl");
		const newFile = join(codexRoot, "2026", "01", "02", "rollout-new.jsonl");
		const claudeId = "3af1e5da-9f22-4f34-9c2b-6b7e2f1c9d44";
		const claudeFile = join(claudeRoot, "-ws-c", `${claudeId}.jsonl`);

		await writeJsonl(oldFile, [codexHeader("codex-old", "/ws/a"), codexUserItem("old question")]);
		await writeJsonl(midFile, [piHeader("pi-mid", "/ws/b"), piUserMessage("mid question")]);
		await writeJsonl(newFile, [codexHeader("codex-new", "/ws/a"), codexUserItem("new question")]);
		await writeJsonl(claudeFile, [claudeUserLine(claudeId, "/ws/c", "claude question")]);

		const now = Date.now();
		await utimes(oldFile, new Date(now - 4000), new Date(now - 4000));
		await utimes(claudeFile, new Date(now - 3000), new Date(now - 3000));
		await utimes(midFile, new Date(now - 2000), new Date(now - 2000));
		await utimes(newFile, new Date(now - 1000), new Date(now - 1000));

		const result = await listSessions({ codexRoot, piRoot, claudeRoot });

		// Pi's ref.id is its file path (D9), not the header's own `id` field.
		expect(result.map((s) => s.ref.id)).toEqual(["codex-new", midFile, claudeId, "codex-old"]);
		expect(result.map((s) => s.ref.backend)).toEqual(["codex", "pi", "claude", "codex"]);
		expect(result.every((s) => s.status === "detached" && s.isStreaming === false)).toBe(true);
	});

	it("filters by cwd", async () => {
		const a = join(codexRoot, "a.jsonl");
		const b = join(codexRoot, "b.jsonl");
		await writeJsonl(a, [codexHeader("a", "/ws/one"), codexUserItem("q")]);
		await writeJsonl(b, [codexHeader("b", "/ws/two"), codexUserItem("q")]);

		const result = await listSessions({ codexRoot, piRoot, claudeRoot, cwd: "/ws/one" });

		expect(result.map((s) => s.ref.id)).toEqual(["a"]);
	});

	it("includes unknown-workspace (cwd: null) sessions when no cwd filter is given", async () => {
		const drifted = join(codexRoot, "drifted.jsonl");
		await writeJsonl(drifted, [{ id: "drifted-id", timestamp: "2026-01-01T00:00:00.000Z" }]);

		const result = await listSessions({ codexRoot, piRoot, claudeRoot });

		expect(result).toHaveLength(1);
		expect(result[0]?.cwd).toBeNull();
	});

	it("excludes unknown-workspace sessions when a cwd filter is given", async () => {
		const drifted = join(codexRoot, "drifted.jsonl");
		await writeJsonl(drifted, [{ id: "drifted-id", timestamp: "2026-01-01T00:00:00.000Z" }]);

		const result = await listSessions({ codexRoot, piRoot, claudeRoot, cwd: "/ws/one" });

		expect(result).toEqual([]);
	});

	it("tolerates a directory that fails to parse mixed in with good ones", async () => {
		const good = join(codexRoot, "good.jsonl");
		const bad = join(codexRoot, "bad.jsonl");
		await writeJsonl(good, [codexHeader("good", "/ws/a"), codexUserItem("q")]);
		await mkdir(join(root, "codex-sessions"), { recursive: true });
		await writeFile(bad, "");

		const result = await listSessions({ codexRoot, piRoot, claudeRoot });
		const ids = result.map((s) => s.ref.id);
		expect(ids).toContain("good");
		expect(result).toHaveLength(2);
	});
});
