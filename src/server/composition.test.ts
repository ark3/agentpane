import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterFactory } from "./adapters/types.ts";
import { CodexAdapterFactory } from "./adapters/codex/index.ts";
import { PiAdapterFactory } from "./adapters/pi/index.ts";
import { createProductionDeps, createSessionIndex } from "./composition.ts";

const fixture = vi.hoisted(() => ({ codexRoot: "", piRoot: "", claudeRoot: "" }));
// Counts which files' content the parsers actually see, so a test can prove
// `get` reads only the one matching file, not the whole corpus.
const reads = vi.hoisted(() => ({ codex: [] as string[], pi: [] as string[] }));

vi.mock("./sessions/index.ts", async (importOriginal) => {
	const sessions = await importOriginal<typeof import("./sessions/index.ts")>();
	return {
		...sessions,
		listSessions: (options = {}) =>
			sessions.listSessions({ ...options, codexRoot: fixture.codexRoot, piRoot: fixture.piRoot, claudeRoot: fixture.claudeRoot }),
		getSession: (ref: Parameters<typeof sessions.getSession>[0], options = {}) =>
			sessions.getSession(ref, { ...options, codexRoot: fixture.codexRoot, piRoot: fixture.piRoot, claudeRoot: fixture.claudeRoot }),
	};
});

vi.mock("./sessions/codex.ts", async (importOriginal) => {
	const codex = await importOriginal<typeof import("./sessions/codex.ts")>();
	return {
		...codex,
		parseCodexSession: (filePath: string, stat: Parameters<typeof codex.parseCodexSession>[1]) => {
			reads.codex.push(filePath);
			return codex.parseCodexSession(filePath, stat);
		},
	};
});

vi.mock("./sessions/pi.ts", async (importOriginal) => {
	const pi = await importOriginal<typeof import("./sessions/pi.ts")>();
	return {
		...pi,
		parsePiSession: (filePath: string, stat: Parameters<typeof pi.parsePiSession>[1]) => {
			reads.pi.push(filePath);
			return pi.parsePiSession(filePath, stat);
		},
	};
});

// The preview path locates one file under the store root (OW-38); redirect it
// at the same seam the listSessions mock uses, so it reads the fixture tree
// rather than the operator's real ~/.codex/sessions.
vi.mock("./sessions/preview.ts", async (importOriginal) => {
	const preview = await importOriginal<typeof import("./sessions/preview.ts")>();
	return {
		...preview,
		readSessionPreview: (ref: Parameters<typeof preview.readSessionPreview>[0], opts = {}) =>
			preview.readSessionPreview(ref, { ...opts, codexRoot: fixture.codexRoot, piRoot: fixture.piRoot, claudeRoot: fixture.claudeRoot }),
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

function piHeader(id: string, cwd: string) {
	return { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd };
}

function piUserMessage(text: string) {
	return {
		type: "message",
		id: "m",
		parentId: null,
		timestamp: "2026-01-01T00:00:05.000Z",
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

function piAssistantMessage(text: string) {
	return {
		type: "message",
		id: "a",
		parentId: null,
		timestamp: "2026-01-01T00:00:07.000Z",
		message: { role: "assistant", content: [{ type: "text", text }] },
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
		fixture.claudeRoot = join(root, "claude-projects");
		reads.codex = [];
		reads.pi = [];
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

	it("gets a session by reading only its own file, never the rest of the corpus", async () => {
		// Five sibling files per backend besides the wanted one, so a whole-corpus
		// `get` (the pre-fix implementation) shows up unmistakably in the counters.
		const wantedPi = join(fixture.piRoot, "ws", "wanted.jsonl");
		await writeJsonl(wantedPi, [piHeader("pi-wanted", "/workspace/one"), piUserMessage("wanted")]);
		for (let i = 0; i < 5; i++) {
			await writeJsonl(join(fixture.piRoot, "ws", `other-${i}.jsonl`), [
				piHeader(`pi-other-${i}`, "/workspace/other"),
				piUserMessage("other"),
			]);
		}

		const thread = "019f1aae-2a5e-7173-a90a-aad3e2b17d0b";
		const wantedCodex = join(fixture.codexRoot, "2026", "08", "12", `rollout-2026-08-12T22-10-29-${thread}.jsonl`);
		await writeJsonl(wantedCodex, [codexHeader(thread, "/workspace/two"), codexUserItem("wanted")]);
		for (let i = 0; i < 5; i++) {
			await writeJsonl(join(fixture.codexRoot, `other-${i}.jsonl`), [
				codexHeader(`codex-other-${i}`, "/workspace/other"),
				codexUserItem("other"),
			]);
		}

		const index = createSessionIndex();
		const piSummary = await index.get({ backend: "pi", id: wantedPi });
		const codexSummary = await index.get({ backend: "codex", id: thread });

		expect(piSummary).toMatchObject({ ref: { backend: "pi", id: wantedPi }, cwd: "/workspace/one" });
		expect(codexSummary).toMatchObject({ ref: { backend: "codex", id: thread }, cwd: "/workspace/two" });
		// 6 Pi files and 6 Codex files exist; only the two matching ones were ever
		// handed to a parser.
		expect(reads.pi).toEqual([wantedPi]);
		expect(reads.codex).toEqual([wantedCodex]);
	});

	it("previews a stored Pi session by reading only its own file (OW-38)", async () => {
		// Pi's ref is its JSONL path (D9); the preview reads it directly. The other
		// seeded file is here to prove the preview does not walk the whole store
		// the way `list`/`get` do.
		const wanted = join(fixture.piRoot, "ws", "wanted.jsonl");
		await writeJsonl(wanted, [
			piHeader("pi-wanted", "/workspace/one"),
			piUserMessage("the real question"),
			piAssistantMessage("the real answer"),
		]);
		await writeJsonl(join(fixture.piRoot, "ws", "other.jsonl"), [
			piHeader("pi-other", "/workspace/two"),
			piUserMessage("a different conversation"),
		]);

		const turns = await createSessionIndex().preview({ backend: "pi", id: wanted });
		expect(turns).toEqual([
			{ role: "user", text: "the real question", timestamp: "2026-01-01T00:00:05.000Z" },
			{ role: "assistant", text: "the real answer", timestamp: "2026-01-01T00:00:07.000Z" },
		]);
	});

	it("previews a stored Codex session found by the uuid in its filename (OW-38)", async () => {
		const thread = "019f1aae-2a5e-7173-a90a-aad3e2b17d0b";
		await writeJsonl(
			join(fixture.codexRoot, "2026", "08", "12", `rollout-2026-08-12T22-10-29-${thread}.jsonl`),
			[codexHeader(thread, "/workspace/one"), codexUserItem("the codex question")],
		);

		const turns = await createSessionIndex().preview({ backend: "codex", id: thread });
		expect(turns).toEqual([{ role: "user", text: "the codex question" }]);
	});

	it("registers Pi and Codex and accepts a replacement adapter registry", () => {
		const codex = {} as AdapterFactory;
		const adapters = createProductionDeps().adapters;

		expect(adapters.pi).toBeInstanceOf(PiAdapterFactory);
		expect(adapters.codex).toBeInstanceOf(CodexAdapterFactory);
		expect(createProductionDeps({ adapters: { codex } }).adapters).toEqual({ codex });
	});
});
