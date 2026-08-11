/**
 * Recursive `.jsonl` file discovery under a session store root.
 *
 * Deliberately depth-agnostic: HANDOFF/DESIGN describe Codex's layout as
 * `YYYY/MM/DD/rollout-*.jsonl`, but on this machine 3 of the 583 files sit
 * directly at the store root (no date nesting at all) -- see the agent
 * report for the census. Pi's `**\/*.jsonl` is depth-agnostic by design. So
 * this walks to arbitrary depth rather than assuming any fixed nesting,
 * matching D9's "tolerate drift" instruction.
 */

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function findJsonlFiles(root: string): Promise<string[]> {
	const out: string[] = [];

	async function walk(dir: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
		} catch {
			// Missing root (no sessions yet on this machine -- smoke test
			// scenario) or an unreadable subdirectory. Either way, this is an
			// enumeration walk: treat it as "nothing here," never throw.
			return;
		}

		const subdirs: string[] = [];
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				subdirs.push(full);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				out.push(full);
			}
		}
		// Sequential, not Promise.all: keeps directory-descent from spiking fd
		// usage on a deep tree; file reads (the actual cost) are parallelized
		// by the caller instead.
		for (const sub of subdirs) {
			await walk(sub);
		}
	}

	await walk(root);
	return out;
}
