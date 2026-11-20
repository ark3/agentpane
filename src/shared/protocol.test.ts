import { describe, expect, it } from "vitest";
import { sessionKey, type SessionRef } from "./protocol.ts";

describe("protocol", () => {
	const pi: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/a b.jsonl" };
	const codex: SessionRef = { backend: "codex", id: "019feee5-cc20-7290-95fa-599abc243e55" };

	it("keys sessions by backend and id", () => {
		expect(sessionKey(pi)).not.toBe(sessionKey(codex));
		expect(sessionKey(codex)).toBe(`codex:${codex.id}`);
	});
});
