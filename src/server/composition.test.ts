import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterFactory } from "./adapters/types.ts";
import { PiAdapterFactory } from "./adapters/pi/index.ts";
import { createProductionDeps, createSessionIndex } from "./composition.ts";

const fixture = vi.hoisted(() => ({ codexRoot: "", piRoot: "" }));

vi.mock("./sessions/index.ts", async (importOriginal) => {
	const sessions = await importOriginal<typeof import("./sessions/index.ts")>();
	return {
		...sessions,
		listSessions: (options = {}) =>
			sessions.listSessions({ ...options, codexRoot: fixture.codexRoot, piRoot: fixture.piRoot }),
	};
});

function codexHeader(id: string, cwd: string) {
	return {
		type: "session_meta",
		payload: { id, timestamp: "2026-01-01T00:00:00.000Z", cwd, model_provider: "openai" },
	};
}

function oldCodexHeader(id: string) {
	return { id, timestamp: "2025-06-16T16:16:23.544Z" };
}

function codexUserItem(text: string) {
	return {
		type: "response_item",
		payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
	};
}

async function writeJsonl(file: string, lines: unknown[]): Promise<void> {
	await mkdir(join(file, ".."), { recursive: true });
	await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

describe("production composition", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "agentpane-composition-"));
		fixture.codexRoot = join(root, "codex-sessions");
		fixture.piRoot = join(root, "pi-sessions");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("lists filesystem sessions for the requested workspace", async () => {
		await writeJsonl(join(fixture.codexRoot, "one.jsonl"), [
			codexHeader("one", "/workspace/one"),
			codexUserItem("first"),
		]);
		await writeJsonl(join(fixture.codexRoot, "two.jsonl"), [
			codexHeader("two", "/workspace/two"),
			codexUserItem("second"),
		]);

		const sessions = await createSessionIndex().list({ cwd: "/workspace/one" });

		expect(sessions.map(({ ref, cwd, preview }) => ({ ref, cwd, preview }))).toEqual([
			{ ref: { backend: "codex", id: "one" }, cwd: "/workspace/one", preview: "first" },
		]);
	});

	it("gets the matching session and returns null for an unknown ref", async () => {
		await writeJsonl(join(fixture.codexRoot, "known.jsonl"), [
			codexHeader("known", "/workspace/one"),
			codexUserItem("saved session"),
		]);
		const index = createSessionIndex();

		expect(await index.get({ backend: "codex", id: "known" })).toMatchObject({
			ref: { backend: "codex", id: "known" },
			cwd: "/workspace/one",
		});
		expect(await index.get({ backend: "codex", id: "unknown" })).toBeNull();
	});

	it("gets old Codex sessions that have no recorded workspace", async () => {
		await writeJsonl(join(fixture.codexRoot, "old.jsonl"), [
			oldCodexHeader("old"),
			codexUserItem("old session"),
		]);

		await expect(createSessionIndex().get({ backend: "codex", id: "old" })).resolves.toMatchObject({
			ref: { backend: "codex", id: "old" },
			cwd: null,
		});
	});

	it("registers Pi and accepts a replacement adapter registry", () => {
		const codex = {} as AdapterFactory;

		expect(createProductionDeps().adapters.pi).toBeInstanceOf(PiAdapterFactory);
		expect(createProductionDeps({ adapters: { codex } }).adapters).toEqual({ codex });
	});
});
