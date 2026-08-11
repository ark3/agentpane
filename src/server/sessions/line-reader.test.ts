import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLinesLfOnly } from "./line-reader.ts";

async function collect(filePath: string, opts?: Parameters<typeof readLinesLfOnly>[1]): Promise<string[]> {
	const lines: string[] = [];
	for await (const line of readLinesLfOnly(filePath, opts)) {
		lines.push(line);
	}
	return lines;
}

describe("readLinesLfOnly", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "agentpane-linereader-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("splits on \\n and yields a trailing line with no final newline", async () => {
		const file = join(dir, "a.jsonl");
		await writeFile(file, "one\ntwo\nthree");
		expect(await collect(file)).toEqual(["one", "two", "three"]);
	});

	it("does not split on U+2028/U+2029 embedded inside a line", async () => {
		// The hazard readline has: it treats U+2028 (LINE SEPARATOR) and U+2029
		// as line breaks by default, which would corrupt a JSON string value
		// containing one. These session files hold arbitrary agent/tool text,
		// so this is a real risk, not a hypothetical one.
		const file = join(dir, "b.jsonl");
		const payload = JSON.stringify({ text: "line one line two line three" });
		await writeFile(file, `${payload}\nnext-line`);

		const lines = await collect(file);
		expect(lines).toEqual([payload, "next-line"]);
		expect(JSON.parse(lines[0] as string).text).toBe("line one line two line three");
	});

	it("respects maxLines", async () => {
		const file = join(dir, "c.jsonl");
		await writeFile(file, "1\n2\n3\n4\n5\n");
		expect(await collect(file, { maxLines: 2 })).toEqual(["1", "2"]);
	});

	it("respects maxBytes by stopping once the cap is crossed", async () => {
		// Big enough to span several stream chunks (default highWaterMark is
		// 64KB), so the cap has a real chance to bite between chunks rather
		// than the whole file landing in one read.
		const file = join(dir, "d.jsonl");
		const line = "x".repeat(1000);
		const lineCount = 300; // ~301KB total
		await writeFile(file, `${Array.from({ length: lineCount }, () => line).join("\n")}\n`);

		const lines = await collect(file, { maxBytes: 50_000 });
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.length).toBeLessThan(lineCount);
	});

	it("returns nothing for an empty file", async () => {
		const file = join(dir, "empty.jsonl");
		await writeFile(file, "");
		expect(await collect(file)).toEqual([]);
	});

	it("propagates a clean rejection for a missing file rather than hanging", async () => {
		const file = join(dir, "missing.jsonl");
		await expect(collect(file)).rejects.toThrow();
	});
});
