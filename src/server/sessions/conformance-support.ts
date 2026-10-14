/**
 * Test-only helpers shared by the conformance tests, which hold a backend's
 * live transcript against its stored preview of the same run
 * (`codex-conformance.test.ts`, `pi-conformance.test.ts`).
 *
 * Not a test file (vitest only collects `*.test.ts`), and nothing in the
 * shipping path imports it.
 */

export interface Hunk {
	live: string[];
	preview: string[];
}

export interface KnownDifference extends Hunk {
	/** Each card that owns part of this hunk, and what its part is. */
	owners: Record<string, string>;
}

/**
 * Where two row sequences part, as hunks between the rows they share (a
 * longest common subsequence), in order. Equal sequences give none.
 */
export function hunks(a: string[], b: string[]): Hunk[] {
	const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
		}
	}
	const out: Hunk[] = [];
	let open: Hunk | null = null;
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			open = null;
			i++;
			j++;
			continue;
		}
		if (!open) out.push((open = { live: [], preview: [] }));
		if (j >= b.length || (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) open.live.push(a[i++]!);
		else open.preview.push(b[j++]!);
	}
	return out;
}
