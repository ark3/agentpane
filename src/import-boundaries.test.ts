/**
 * Project-wide import guards. Not owned by any workstream.
 *
 * D10 says the pi packages are devDependencies we take *types* from and no
 * runtime code. `verbatimModuleSyntax` does NOT enforce that -- it only makes
 * type-only imports explicit so their erasure is predictable. A plain value
 * import from a devDependency typechecks happily and then ships pi-agent-core
 * into the browser bundle. This test is the actual enforcement.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL(".", import.meta.url).pathname;

/** Packages we may reference for types only. */
export const TYPE_ONLY_PACKAGES = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai"];

/**
 * Match every import statement and capture its clause and module specifier.
 *
 * Matching *all* specifiers rather than only the interesting ones is what
 * makes this correct: lazy matching binds each `import` to the nearest
 * following `from`, so statements cannot bleed into each other. An earlier
 * version hardcoded the package into the pattern, which forced the lazy span
 * to run past unrelated imports and flag innocent files.
 *
 * `^[ \t]*` anchors the clause to the start of a line, which is where a real
 * import statement begins (indented inside a `<script>` block, in a .svelte
 * file). Prose that happens to contain the word `import` mid-sentence does
 * not start a match, and `stripComments` removes the docblocks such prose
 * lives in anyway. Both were needed: a docblock explaining that "every import
 * here is `import type`, so nothing from them reaches the bundle" flagged its
 * own file, because the lazy span ran from the word `import` in the sentence
 * to the specifier of the real (legal) import below it.
 */
const IMPORT_RE = /^[ \t]*import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;
/** Side-effect import: `import "pkg"`. Never legitimate for a type-only package. */
const BARE_IMPORT_RE = /^[ \t]*import\s+["']([^"']+)["']/gm;

/**
 * Drop comments so prose is never scanned as code. The `[^:]` guard keeps
 * `https://` inside a string from being mistaken for a line comment.
 */
export function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function clauseIsTypeOnly(clause: string): boolean {
	if (/^\s*type\b/.test(clause)) return true; // import type { A } / import type * as A
	const inner = clause.trim();
	if (!inner.startsWith("{") || !inner.endsWith("}")) return false; // default or namespace import
	const specifiers = inner.slice(1, -1).split(",").filter((s) => s.trim());
	if (specifiers.length === 0) return false;
	return specifiers.every((s) => /^\s*type\b/.test(s)); // import { type A, type B }
}

/** Returns a description of each offending import, empty when clean. */
export function findValueImports(source: string, packages: string[]): string[] {
	const offences: string[] = [];
	const text = stripComments(source);
	for (const match of text.matchAll(IMPORT_RE)) {
		const [whole, clause = "", specifier = ""] = match;
		if (!packages.includes(specifier)) continue;
		if (!clauseIsTypeOnly(clause)) offences.push((whole.split("\n")[0] ?? whole).trim());
	}
	for (const match of text.matchAll(BARE_IMPORT_RE)) {
		if (packages.includes(match[1] ?? "")) offences.push(match[0].trim());
	}
	return offences;
}

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
		else if ([".ts", ".svelte"].includes(extname(entry))) out.push(full);
	}
	return out;
}

describe("findValueImports", () => {
	const PKG = "@earendil-works/pi-agent-core";

	it.each([
		['import type { AgentMessage } from "PKG";', "import type"],
		['import { type AgentMessage } from "PKG";', "inline type specifier"],
		['import { type A, type B } from "PKG";', "several inline type specifiers"],
		['import type * as core from "PKG";', "type namespace import"],
	])("allows %s (%s)", (line) => {
		expect(findValueImports(line.replace("PKG", PKG), [PKG])).toEqual([]);
	});

	it.each([
		['import { Agent } from "PKG";', "value import"],
		['import Agent from "PKG";', "default import"],
		['import * as core from "PKG";', "namespace import"],
		['import { type A, Agent } from "PKG";', "mixed type and value"],
		['import "PKG";', "side-effect import"],
	])("rejects %s (%s)", (line) => {
		expect(findValueImports(line.replace("PKG", PKG), [PKG])).toHaveLength(1);
	});

	it("does not let an earlier unrelated import bleed into the match", () => {
		// Regression: the original pattern hardcoded the package, so its lazy
		// span ran from this first `import` all the way to the pi specifier and
		// flagged the file, naming the wrong line.
		const text = [
			'import { sessionKey } from "../shared/protocol.ts";',
			`import type { AgentMessage } from "${PKG}";`,
		].join("\n");
		expect(findValueImports(text, [PKG])).toEqual([]);
	});

	it("still catches a violation that follows unrelated imports", () => {
		const text = [
			'import { sessionKey } from "../shared/protocol.ts";',
			`import { Agent } from "${PKG}";`,
		].join("\n");
		expect(findValueImports(text, [PKG])).toEqual([`import { Agent } from "${PKG}"`]);
	});

	it("ignores packages that are not restricted", () => {
		expect(findValueImports('import { marked } from "marked";', [PKG])).toEqual([]);
	});

	it("does not read prose in a docblock as code", () => {
		// Regression: this exact docblock (from src/client/render/types.ts) failed
		// the guard. The word `import` in the sentence opened a lazy match that
		// ran down to the specifier of the legal `import type` below it, so the
		// file was reported as a violation and the reported "import" was a
		// fragment of English.
		const text = [
			"/**",
			" * D6 keeps `AgentMessage` as the internal contract, and D10 says the pi",
			" * packages are types only -- every import here is `import type`, so nothing",
			" * from them reaches the bundle.",
			" */",
			`import type { AgentMessage } from "${PKG}";`,
		].join("\n");
		expect(findValueImports(text, [PKG])).toEqual([]);
	});

	it("does not read prose in a line comment as code", () => {
		const text = [
			`// We deliberately import nothing but types from "${PKG}".`,
			`import type { AgentMessage } from "${PKG}";`,
		].join("\n");
		expect(findValueImports(text, [PKG])).toEqual([]);
	});

	it("does not read a commented-out import block as code", () => {
		// The line anchor alone does not save us here: inside a block comment an
		// import can start at column 0. This is what `stripComments` is for.
		const text = ["/*", `import { Agent } from "${PKG}";`, "*/"].join("\n");
		expect(findValueImports(text, [PKG])).toEqual([]);
	});

	it("does not read prose in a string literal as code", () => {
		// `stripComments` cannot help here -- this is code, just not an import.
		// The line anchor is what stops the lazy span starting mid-string.
		const text = [
			'const hint = "you can import Agent from the core package";',
			`import type { AgentMessage } from "${PKG}";`,
		].join("\n");
		expect(findValueImports(text, [PKG])).toEqual([]);
	});

	it("catches an indented violation, as in a .svelte <script> block", () => {
		const text = ["<script lang=\"ts\">", `\timport { Agent } from "${PKG}";`, "</script>"].join(
			"\n",
		);
		expect(findValueImports(text, [PKG])).toEqual([`import { Agent } from "${PKG}"`]);
	});
});

describe("import boundaries", () => {
	it("only ever imports types from the pi packages (D10)", () => {
		const violations: string[] = [];
		for (const file of sourceFiles(SRC)) {
			for (const offence of findValueImports(readFileSync(file, "utf8"), TYPE_ONLY_PACKAGES)) {
				violations.push(`${file.replace(SRC, "src/")}: ${offence}`);
			}
		}
		expect(violations, `value import(s) from a type-only package:\n${violations.join("\n")}`)
			.toEqual([]);
	});
});
