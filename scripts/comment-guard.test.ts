import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { problems } from "./comment-guard.ts";

const hasEmacs = !spawnSync("emacs", ["--version"]).error;

describe("comment guard: TypeScript", () => {
	const base = `/** Adds. */\nexport function add(a: number, b: number): number {\n\t// sum\n\treturn a + b; // done\n}\nconst s = "text";\nconst t = \`n=\${s}\`;\n`;

	it("passes a change to comments alone, reflowed or deleted", () => {
		const after = `/**\n * Adds two numbers,\n * as it says.\n */\nexport function add(a: number, b: number): number {\n\treturn a + b;\n}\nconst s = "text";\nconst t = \`n=\${s}\`;\n`;
		expect(problems("x.ts", base, after)).toEqual([]);
	});

	it("fails an operator change", () => {
		expect(problems("x.ts", base, base.replace("a + b", "a - b"))).toHaveLength(1);
	});

	it("fails a change inside a string or a template", () => {
		expect(problems("x.ts", base, base.replace('"text"', '"texts"'))).toHaveLength(1);
		expect(problems("x.ts", base, base.replace("n=", "m="))).toHaveLength(1);
	});

	it("fails a removed directive comment, though it is a comment", () => {
		const withDirective = `// @ts-expect-error untyped\nconst x: number = "a";\n`;
		expect(problems("x.ts", withDirective, `const x: number = "a";\n`)).toEqual(["directive comments changed"]);
	});
});

describe("comment guard: Svelte", () => {
	const base = `<script lang="ts">\n\t// state\n\tlet n = $state(0);\n</script>\n\n<!-- a button -->\n<button onclick={() => n++}>{n}</button>\n`;

	it("passes a change to script and markup comments", () => {
		const after = base.replace("// state", "// the count").replace("<!-- a button -->", "<!-- counts\n     clicks -->");
		expect(problems("x.svelte", base, after)).toEqual([]);
	});

	it("fails a markup change and a script change", () => {
		expect(problems("x.svelte", base, base.replace("<button", "<span></span><button"))).toHaveLength(1);
		expect(problems("x.svelte", base, base.replace("$state(0)", "$state(1)"))).toHaveLength(1);
	});

	it("fails a markup change ahead of a script block", () => {
		const twoBlocks = `<script module>\n\texport const k = 1;\n</script>\n<p>a</p>\n${base}`;
		expect(problems("x.svelte", twoBlocks, twoBlocks.replace("<p>a</p>", "<p>b</p>"))).toHaveLength(1);
	});
});

describe.skipIf(!hasEmacs)("comment guard: Elisp", () => {
	const base = [
		";;; x.el --- test  -*- lexical-binding: t; -*-",
		";; A comment.",
		"(defvar x-level 1",
		'  "The level.")',
		"(defun x-greet (name)",
		'  "Greet NAME."',
		"  ;; Say it.",
		'  (when name (message "hi %s" name)))',
		"(defun x-answer ()",
		'  "42")',
		"",
	].join("\n");

	it("passes a change to docstrings and comments", () => {
		const after = base
			.replace(";; A comment.", "")
			.replace('"The level."', '"The level,\nnow longer."')
			.replace('"Greet NAME."', '"Say hello to NAME."')
			.replace("  ;; Say it.\n", "");
		expect(problems("x.el", base, after)).toEqual([]);
	});

	it("fails a code change", () => {
		expect(problems("x.el", base, base.replace("(when name", "(unless name"))).toHaveLength(1);
	});

	it("fails a change to a string that is not a docstring", () => {
		expect(problems("x.el", base, base.replace('"hi %s"', '"hello %s"'))).toHaveLength(1);
		// A lone string body is the return value, not a docstring.
		expect(problems("x.el", base, base.replace('"42")', '"43")'))).toHaveLength(1);
	});

	it("fails a change to the header line's lexical-binding cookie", () => {
		const after = base.replace("  -*- lexical-binding: t; -*-", "");
		expect(problems("x.el", base, after)).toContain("header line changed");
	});
});
