import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendId } from "../shared/protocol.ts";
import { ApiTokenError, apiTokenPath, loadApiToken } from "./api-token.ts";
import { createProductionDeps } from "./composition.ts";
import { emptySessionIndex } from "./http/deps.ts";

// Every agent reaches the OS through `node:child_process.spawn`: Claude Code and
// Codex through `spawnClaude` and `spawnCodex`, which pass `env: options.env ??
// process.env`, and Pi through `PiAdapterDeps.spawn`'s default, which passes
// `{ cwd }` alone. Intercepting it here, below all three, records what each
// real seam hands the child without starting one.
const spawned = vi.hoisted(() => [] as { command: string; options: { env?: NodeJS.ProcessEnv } | undefined }[]);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (command: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
			spawned.push({ command, options });
			throw new Error("spawn intercepted");
		},
	};
});

// The suite runs under `vmThreads`, and a worker thread's `process.env` is its
// own copy: stubbing `HOME` there does not reach the `getenv` that
// `os.homedir()` reads, which went on answering the real home. So the home is
// pointed at the temp directory here instead.
const fake = vi.hoisted(() => ({ home: "" }));

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => fake.home };
});

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "agentpane-token-"));
	fake.home = home;
	spawned.length = 0;
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function withSsh(): string {
	mkdirSync(join(home, ".ssh"), { mode: 0o700 });
	return join(home, ".ssh", "agentpane-token");
}

function refusal(): ApiTokenError {
	try {
		loadApiToken();
	} catch (err) {
		if (err instanceof ApiTokenError) return err;
		throw err;
	}
	throw new Error("loadApiToken did not refuse");
}

describe("loadApiToken", () => {
	it("resolves the path under the home it is called with", () => {
		expect(apiTokenPath()).toBe(join(home, ".ssh", "agentpane-token"));
	});

	it("creates a missing file at 0600 holding 32 random bytes, and reads the same token again", () => {
		const path = withSsh();
		const token = loadApiToken();
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(Buffer.from(readFileSync(path, "utf8"), "base64url")).toHaveLength(32);
		expect(Buffer.from(token, "base64url")).toHaveLength(32);
		expect(loadApiToken()).toBe(token);
	});

	it.each([0o640, 0o604])("refuses a file at %o, naming its path", (mode) => {
		const path = withSsh();
		writeFileSync(path, "secret\n");
		chmodSync(path, mode);
		const err = refusal();
		expect(err.message).toContain(path);
		expect(err.message).toContain(`chmod 600 ${path}`);
	});

	it("refuses when ~/.ssh is missing, naming it, and does not create it", () => {
		const dir = join(home, ".ssh");
		expect(refusal().message).toContain(dir);
		expect(existsSync(dir)).toBe(false);
	});

	it("refuses an empty file, naming its path", () => {
		const path = withSsh();
		writeFileSync(path, "", { mode: 0o600 });
		expect(refusal().message).toContain(path);
	});

	it("refuses a whitespace-only file", () => {
		const path = withSsh();
		writeFileSync(path, " \n\t\n", { mode: 0o600 });
		expect(refusal().message).toContain(path);
	});

	it("trims a newline after a hand-written token", () => {
		const path = withSsh();
		writeFileSync(path, "hand-written-token\n", { mode: 0o600 });
		expect(loadApiToken()).toBe("hand-written-token");
	});
});

describe("the token and agent environments", () => {
	it("is in no spawned agent's environment", async () => {
		withSsh();
		const token = loadApiToken();
		const { adapters } = createProductionDeps({ index: emptySessionIndex });
		for (const backend of ["claude", "codex", "pi"] satisfies BackendId[]) {
			spawned.length = 0;
			const adapter = adapters[backend]!.create({ backend, id: `${backend}-session` });
			await expect(adapter.start({ cwd: home })).rejects.toThrow("spawn intercepted");
			await adapter.dispose();
			expect(spawned).toHaveLength(1);
			// An absent `env` is an inherited `process.env`, as Node defines it.
			const env = spawned[0]!.options?.env ?? process.env;
			const carriers = Object.keys(env).filter((name) => env[name]?.includes(token));
			expect({ backend, carriers }).toEqual({ backend, carriers: [] });
		}
	});
});
