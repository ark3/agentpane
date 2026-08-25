/**
 * Smoke test against the real session stores on this machine. Structural
 * assertions only -- this must never assert on, print, or otherwise surface
 * actual transcript content (those are the user's private data), and it must
 * pass on a machine with no sessions at all (fresh checkout, CI, ...).
 */

import { describe, expect, it } from "vitest";
import { listSessions } from "./index.ts";
import type { SessionSummary } from "../../shared/protocol.ts";

function isValidSummary(s: SessionSummary): boolean {
	return (
		(s.ref.backend === "pi" || s.ref.backend === "codex" || s.ref.backend === "claude") &&
		typeof s.ref.id === "string" &&
		s.ref.id.length > 0 &&
		(s.cwd === null || typeof s.cwd === "string") &&
		(s.preview === null || typeof s.preview === "string") &&
		(s.createdAt === null || typeof s.createdAt === "string") &&
		typeof s.updatedAt === "string" &&
		s.status === "detached" &&
		s.isStreaming === false
	);
}

describe("listSessions against the real dirs (smoke)", () => {
	it("resolves without throwing and returns structurally valid summaries, sorted by recency", async () => {
		const result = await listSessions();

		expect(Array.isArray(result)).toBe(true);
		expect(result.every(isValidSummary)).toBe(true);

		for (let i = 1; i < result.length; i++) {
			const prev = Date.parse((result[i - 1] as SessionSummary).updatedAt as string);
			const cur = Date.parse((result[i] as SessionSummary).updatedAt as string);
			expect(prev).toBeGreaterThanOrEqual(cur);
		}

		// Every ref must be unique -- backend-qualified id collisions would be
		// a real bug (two files mapping to the same SessionRef).
		const keys = result.map((s) => `${s.ref.backend}:${s.ref.id}`);
		expect(new Set(keys).size).toBe(keys.length);

		// Claude ids are the session uuid the store file is named after. A
		// non-uuid id here means the walk descended into per-session auxiliaries
		// (subagents/agent-*.jsonl) and surfaced a phantom session (OW-votasi).
		for (const s of result) {
			if (s.ref.backend === "claude") {
				expect(s.ref.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
			}
		}
	});
});
