import { describe, expect, it } from "vitest";
import { ROUTES, sessionKey, type SessionRef } from "./protocol.ts";

describe("protocol", () => {
	const pi: SessionRef = { backend: "pi", id: "/home/u/.pi/agent/sessions/a b.jsonl" };
	const codex: SessionRef = { backend: "codex", id: "019feee5-cc20-7290-95fa-599abc243e55" };

	it("keys sessions by backend and id", () => {
		expect(sessionKey(pi)).not.toBe(sessionKey(codex));
		expect(sessionKey(codex)).toBe(`codex:${codex.id}`);
	});

	it("escapes ids in routes -- Pi ids are filesystem paths", () => {
		expect(ROUTES.prompt(pi)).toBe(
			"/api/sessions/pi/%2Fhome%2Fu%2F.pi%2Fagent%2Fsessions%2Fa%20b.jsonl/prompt",
		);
		expect(ROUTES.prompt(pi)).not.toContain("sessions/pi//home");
	});
});
