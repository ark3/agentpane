import { describe, expect, it } from "vitest";
import { buildPiSpawnCommand } from "./spawn.ts";

describe("buildPiSpawnCommand", () => {
	it("builds the D7 direnv/sbox/pi command line for a fresh session", () => {
		const result = buildPiSpawnCommand({ cwd: "/work/proj" });
		expect(result.command).toBe("direnv");
		expect(result.args).toEqual(["exec", "/work/proj", "sbox", "--", "pi", "--mode", "rpc"]);
	});

	it("passes cwd through as the process's own OS cwd, not just an argv value", () => {
		// See the module doc: `direnv exec DIR CMD` does not itself chdir --
		// sbox's workspace auto-detection reads the process's real cwd.
		const result = buildPiSpawnCommand({ cwd: "/work/proj" });
		expect(result.cwd).toBe("/work/proj");
	});

	it("adds --session for resumeId (Pi's id is its JSONL path, D9)", () => {
		const result = buildPiSpawnCommand({
			cwd: "/work/proj",
			resumeId: "/home/user/.pi/agent/sessions/abc.jsonl",
		});
		expect(result.args).toEqual([
			"exec",
			"/work/proj",
			"sbox",
			"--",
			"pi",
			"--mode",
			"rpc",
			"--session",
			"/home/user/.pi/agent/sessions/abc.jsonl",
		]);
	});

	it("adds --model, in provider/modelId form", () => {
		const result = buildPiSpawnCommand({ cwd: "/work/proj", model: "anthropic/claude-sonnet-4-20250514" });
		expect(result.args).toEqual([
			"exec",
			"/work/proj",
			"sbox",
			"--",
			"pi",
			"--mode",
			"rpc",
			"--model",
			"anthropic/claude-sonnet-4-20250514",
		]);
	});

	it("combines --session and --model, session first", () => {
		const result = buildPiSpawnCommand({
			cwd: "/work/proj",
			resumeId: "/home/user/.pi/agent/sessions/abc.jsonl",
			model: "anthropic/claude-sonnet-4-20250514",
		});
		expect(result.args).toEqual([
			"exec",
			"/work/proj",
			"sbox",
			"--",
			"pi",
			"--mode",
			"rpc",
			"--session",
			"/home/user/.pi/agent/sessions/abc.jsonl",
			"--model",
			"anthropic/claude-sonnet-4-20250514",
		]);
	});
});
