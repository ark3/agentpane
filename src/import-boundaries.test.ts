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
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** Packages we may reference for types only. */
const TYPE_ONLY_PACKAGES = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai"];

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

describe("import boundaries", () => {
	it("only ever imports types from the pi packages (D10)", () => {
		const violations: string[] = [];

		for (const file of sourceFiles(SRC)) {
			const text = readFileSync(file, "utf8");
			for (const pkg of TYPE_ONLY_PACKAGES) {
				// Any import statement mentioning the package...
				const pattern = new RegExp(`import\\s+([\\s\\S]*?)from\\s+["']${pkg}["']`, "g");
				for (const match of text.matchAll(pattern)) {
					const clause = match[1] ?? "";
					// ...must either be `import type ...` or use only inline
					// `{ type Foo }` specifiers. Anything else is a value import.
					const isTypeOnly =
						/^\s*type\s/.test(clause) ||
						clause
							.replace(/[{}]/g, "")
							.split(",")
							.filter((s) => s.trim())
							.every((s) => /^\s*type\s/.test(s));
					if (!isTypeOnly) {
						violations.push(`${file.replace(SRC, "src/")}: ${match[0].split("\n")[0]}`);
					}
				}
			}
		}

		expect(violations, `value import(s) from a type-only package:\n${violations.join("\n")}`)
			.toEqual([]);
	});
});
