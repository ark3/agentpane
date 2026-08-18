/**
 * Fixture scrub guard. Not owned by any workstream.
 *
 * `capture_fixtures.py`'s `SCRUB_KEYS` substitutes by JSON *key*, so it never
 * visits free-form content. A Codex fork capture folded the host skills
 * manifest into the turn context and carried the operator's home path and
 * private `SKILL.md` list in message text and in the `host_skills` block, past
 * the key scrub and into a commit (OW-mewiga). It was caught in review, by a
 * human. `resources/fixtures/README.md` ("Scrubbed values") then asked the next
 * person to grep before committing -- which is enforcement by whoever remembers
 * to read it. This test is the actual enforcement.
 *
 * **What it scans for: absolute paths into a home directory**, the three roots
 * `/home/`, `/Users/`, `/root/`. That is the shape that leaked, it is
 * unambiguous, and it cannot occur in English.
 *
 * **Where the shapes come from: a fixed list, not the running environment.**
 * Bare identifiers read from the environment do not survive contact with these
 * fixtures. This machine's hostname is `may`; it matches 113 times across the
 * committed fixtures, every one of them the English modal verb inside Codex's
 * own ~14.7k-character vendor system prompt in `codex/fork.jsonl`, which is
 * legitimately captured and must stay. Word boundaries do not separate the two,
 * and `$USER` carries the same hazard on a machine whose username is a word.
 * Environment-derived shapes also change what the guard means per machine --
 * this project is authored on a laptop and implemented on a server -- so a
 * fixture could pass on one clone and fail on the other. All three home roots
 * are listed for the same reason: the guard should not depend on which host
 * captured the fixture.
 *
 * **Data files only** (`*.jsonl`, `*.meta.json`). The README beside them quotes
 * the leak it is warning about, so scanning the whole directory flags the
 * warning as the offence.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const FIXTURES = new URL("../resources/fixtures/", import.meta.url).pathname;

/** Absolute path prefixes that only ever name a real user's home directory. */
export const HOME_ROOTS = ["/home/", "/Users/", "/root/"];

export interface Leak {
	/** 1-based physical line in the file. */
	line: number;
	/** 1-based character offset of the match within that line. */
	column: number;
	/** The match with a little surrounding context, so the reader can see it. */
	excerpt: string;
}

/**
 * Every home-directory path in `text`. Fixture lines run to 15k characters, so
 * a leak is reported as a short window around the match rather than the line.
 */
export function findHomePaths(text: string): Leak[] {
	const leaks: Leak[] = [];
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		for (const root of HOME_ROOTS) {
			let at = line.indexOf(root);
			while (at !== -1) {
				const start = Math.max(0, at - 20);
				const end = Math.min(line.length, at + 60);
				const excerpt = `${start > 0 ? "..." : ""}${line.slice(start, end)}${
					end < line.length ? "..." : ""
				}`;
				leaks.push({ line: index + 1, column: at + 1, excerpt });
				at = line.indexOf(root, at + 1);
			}
		}
	}
	return leaks;
}

/** Every committed capture under `resources/fixtures/`, README excluded. */
export function fixtureDataFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...fixtureDataFiles(full));
		else if (extname(entry) === ".jsonl" || entry.endsWith(".meta.json")) out.push(full);
	}
	return out;
}

describe("findHomePaths", () => {
	it("catches the path that leaked (OW-mewiga)", () => {
		const line = `{"text":"- /home/operator/.claude/skills/private-thing/SKILL.md"}`;
		const [leak, ...rest] = findHomePaths(line);
		expect(rest).toEqual([]);
		expect(leak?.line).toBe(1);
		expect(leak?.excerpt).toContain("/home/operator/.claude/skills/private-thing/SKILL.md");
	});

	it.each([
		['{"cwd":"/Users/operator/work"}', "macOS home"],
		['{"cwd":"/root/.codex"}', "root's home"],
	])("catches %s (%s)", (line) => {
		expect(findHomePaths(line)).toHaveLength(1);
	});

	it("reports the line and column so the reader is told where to look", () => {
		const text = ["clean", "clean", `xx/home/operator/x`].join("\n");
		expect(findHomePaths(text)).toEqual([
			{ line: 3, column: 3, excerpt: "xx/home/operator/x" },
		]);
	});

	it("catches several leaks on one line", () => {
		expect(findHomePaths("/home/a/x and /home/b/y")).toHaveLength(2);
	});

	it("passes the throwaway capture directories the probes actually use", () => {
		const line = `{"cwd":"/var/tmp/agentpane-fixture-k2ds8egd","path":"greeting.txt"}`;
		expect(findHomePaths(line)).toEqual([]);
	});

	it("does not read English prose as a path", () => {
		// The reason the shapes are paths and not bare identifier tokens: this
		// machine's hostname is `may`, and Codex's vendor system prompt -- which
		// is legitimately captured -- is full of it, along with the word "home".
		const prose =
			"You may edit files in the user's home directory. The user may ask you to run a command.";
		expect(findHomePaths(prose)).toEqual([]);
	});

	it("does not read a relative path as a home path", () => {
		expect(findHomePaths("home/operator/notes.md")).toEqual([]);
	});
});

describe("fixture scrub", () => {
	const files = fixtureDataFiles(FIXTURES);

	it("has captures to scan", () => {
		// Without this, renaming the fixtures directory turns the guard below
		// into a test that scans nothing and passes.
		expect(files.length).toBeGreaterThan(0);
	});

	it("no committed capture carries an operator home path", () => {
		const violations: string[] = [];
		for (const file of files) {
			for (const leak of findHomePaths(readFileSync(file, "utf8"))) {
				violations.push(
					`${file.replace(FIXTURES, "resources/fixtures/")}:${leak.line}:${leak.column}: ${leak.excerpt}`,
				);
			}
		}
		expect(
			violations,
			`operator home path in a committed fixture -- scrub it and recapture, see resources/fixtures/README.md:\n${violations.join("\n")}`,
		).toEqual([]);
	});
});
