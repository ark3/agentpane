import { describe, expect, it } from "vitest";
import { buildClaudeSpawnCommand } from "./process.ts";

const BASE = [
	"exec",
	"/workspace",
	"sbox",
	"--",
	"claude",
	"-p",
	"--input-format",
	"stream-json",
	"--output-format",
	"stream-json",
	"--verbose",
	"--include-partial-messages",
];

describe("buildClaudeSpawnCommand", () => {
	it("builds the sandboxed base invocation (D7), with --verbose but without --permission-mode", () => {
		const { command, args, cwd } = buildClaudeSpawnCommand({ cwd: "/workspace" });
		expect(command).toBe("direnv");
		expect(args).toEqual(BASE);
		expect(cwd).toBe("/workspace");
		// sbox injects bypassPermissions itself; passing it here would fight sbox.
		expect(args).not.toContain("--permission-mode");
		expect(args).toContain("--verbose");
	});

	it("chooses the session id at spawn for a fresh session", () => {
		const { args } = buildClaudeSpawnCommand({ cwd: "/workspace", sessionId: "id-1" });
		expect(args).toEqual([...BASE, "--session-id", "id-1"]);
	});

	it("resumes a stored session, with the model when one is set", () => {
		const { args } = buildClaudeSpawnCommand({
			cwd: "/workspace",
			model: "haiku",
			resumeId: "parent-id",
		});
		expect(args).toEqual([...BASE, "--model", "haiku", "--resume", "parent-id"]);
	});

	it("forks pre-tip with --resume-session-at --fork-session and a chosen id", () => {
		const { args } = buildClaudeSpawnCommand({
			cwd: "/workspace",
			resumeId: "parent-id",
			forkAtEntryId: "entry-uuid",
			sessionId: "forked-id",
		});
		expect(args).toEqual([
			...BASE,
			"--resume",
			"parent-id",
			"--resume-session-at",
			"entry-uuid",
			"--fork-session",
			"--session-id",
			"forked-id",
		]);
	});
});
