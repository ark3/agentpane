import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findJsonlFiles } from "./walk.ts";

describe("findJsonlFiles", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "agentpane-walk-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("returns an empty list for a root that does not exist", async () => {
		const missing = join(root, "does-not-exist");
		await expect(findJsonlFiles(missing)).resolves.toEqual([]);
	});

	it("finds files at arbitrary depth, mixed with files at the root itself", async () => {
		// Mirrors the real layout found on this machine: Codex mostly nests
		// YYYY/MM/DD, but some files sit directly at the store root.
		await writeFile(join(root, "top-level.jsonl"), "{}\n");
		await mkdir(join(root, "2026", "06", "30"), { recursive: true });
		await writeFile(join(root, "2026", "06", "30", "nested.jsonl"), "{}\n");
		await mkdir(join(root, "workspace-a"), { recursive: true });
		await writeFile(join(root, "workspace-a", "one-level.jsonl"), "{}\n");

		const found = await findJsonlFiles(root);
		const names = found.map((f) => f.slice(root.length + 1)).sort();

		expect(names).toEqual(["2026/06/30/nested.jsonl", "top-level.jsonl", "workspace-a/one-level.jsonl"]);
	});

	it("ignores non-.jsonl files", async () => {
		await writeFile(join(root, "readme.txt"), "hello\n");
		await writeFile(join(root, "session.jsonl"), "{}\n");

		const found = await findJsonlFiles(root);
		expect(found).toEqual([join(root, "session.jsonl")]);
	});
});
