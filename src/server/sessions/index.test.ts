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

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "agentpane-index-"));
		codexRoot = join(root, "codex-sessions");
		piRoot = join(root, "pi-sessions");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("returns an empty list when neither store exists on disk (smoke: no sessions yet)", async () => {
		const result = await listSessions({ codexRoot, piRoot });
		expect(result).toEqual([]);
	});

	it("merges both backends and sorts by recency (most recent first)", async () => {
		const oldFile = join(codexRoot, "2026", "01", "01", "rollout-old.jsonl");
		const midFile = join(piRoot, "ws", "mid.jsonl");
		const newFile = join(codexRoot, "2026", "01", "02", "rollout-new.jsonl");

		await writeJsonl(oldFile, [codexHeader("codex-old", "/ws/a"), codexUserItem("old question")]);
		await writeJsonl(midFile, [piHeader("pi-mid", "/ws/b"), piUserMessage("mid question")]);
		await writeJsonl(newFile, [codexHeader("codex-new", "/ws/a"), codexUserItem("new question")]);

		const now = Date.now();
		await utimes(oldFile, new Date(now - 3000), new Date(now - 3000));
		await utimes(midFile, new Date(now - 2000), new Date(now - 2000));
		await utimes(newFile, new Date(now - 1000), new Date(now - 1000));

		const result = await listSessions({ codexRoot, piRoot });

		// Pi's ref.id is its file path (D9), not the header's own `id` field.
		expect(result.map((s) => s.ref.id)).toEqual(["codex-new", midFile, "codex-old"]);
		expect(result.every((s) => s.status === "detached" && s.isStreaming === false)).toBe(true);
	});

	it("filters by cwd", async () => {
		const a = join(codexRoot, "a.jsonl");
		const b = join(codexRoot, "b.jsonl");
		await writeJsonl(a, [codexHeader("a", "/ws/one"), codexUserItem("q")]);
		await writeJsonl(b, [codexHeader("b", "/ws/two"), codexUserItem("q")]);

		const result = await listSessions({ codexRoot, piRoot, cwd: "/ws/one" });

		expect(result.map((s) => s.ref.id)).toEqual(["a"]);
	});

	it("includes unknown-workspace (cwd: null) sessions when no cwd filter is given", async () => {
		const drifted = join(codexRoot, "drifted.jsonl");
		await writeJsonl(drifted, [{ id: "drifted-id", timestamp: "2026-01-01T00:00:00.000Z" }]);

		const result = await listSessions({ codexRoot, piRoot });

		expect(result).toHaveLength(1);
		expect(result[0]?.cwd).toBeNull();
	});

	it("excludes unknown-workspace sessions when a cwd filter is given", async () => {
		const drifted = join(codexRoot, "drifted.jsonl");
		await writeJsonl(drifted, [{ id: "drifted-id", timestamp: "2026-01-01T00:00:00.000Z" }]);

		const result = await listSessions({ codexRoot, piRoot, cwd: "/ws/one" });

		expect(result).toEqual([]);
	});

	it("tolerates a directory that fails to parse mixed in with good ones", async () => {
		const good = join(codexRoot, "good.jsonl");
		const bad = join(codexRoot, "bad.jsonl");
		await writeJsonl(good, [codexHeader("good", "/ws/a"), codexUserItem("q")]);
		await mkdir(join(root, "codex-sessions"), { recursive: true });
		await writeFile(bad, "");

		const result = await listSessions({ codexRoot, piRoot });
		const ids = result.map((s) => s.ref.id);
		expect(ids).toContain("good");
		expect(result).toHaveLength(2);
	});
});
