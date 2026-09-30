/**
 * The shell's own contract, over a fake child. What each backend's adapter
 * does with it is pinned in that backend's `process.test.ts`.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { type ChildLike, ChildProcessShell } from "./child-process.ts";

class FakeReadable extends EventEmitter {
	setEncoding(): void {}
}

class FakeWritable extends EventEmitter {
	destroyed = false;
	write(): boolean {
		return true;
	}
	end(): void {
		this.destroyed = true;
	}
}

/** Never closes on its own: every `close` is the test's. */
class FakeChild extends EventEmitter {
	readonly stdout = new FakeReadable();
	readonly stderr = new FakeReadable();
	readonly stdin = new FakeWritable();
	readonly signals: (string | undefined)[] = [];
	kill(signal?: string): boolean {
		this.signals.push(signal);
		return true;
	}
}

function makeShell() {
	const child = new FakeChild();
	const shell = new ChildProcessShell(child as unknown as ChildLike, "direnv", {
		name: "Test",
		process: "test",
		stdin: "test",
	});
	const onExit = vi.fn<(code: number | null, signal: string | null, error: Error) => void>();
	shell.onExit(onExit);
	return { child, shell, onExit };
}

describe("ChildProcessShell", () => {
	it("reports a child that has not closed within the deadline after SIGKILL through the exit channel, once (OW-sozopu)", async () => {
		vi.useFakeTimers();
		try {
			const { child, shell, onExit } = makeShell();
			const stopping = shell.kill();

			await vi.advanceTimersByTimeAsync(2_000);
			expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
			expect(onExit).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1_000);
			await expect(stopping).resolves.toBeUndefined();
			expect(onExit).toHaveBeenCalledOnce();
			const [code, signal, error] = onExit.mock.calls[0] as [number | null, string | null, Error];
			expect(code).toBeNull();
			expect(signal).toBeNull();
			expect(error.message).toMatch(/SIGKILL/);

			// A close arriving after the shell gave up is not a second death.
			child.emit("close", null, "SIGKILL");
			expect(onExit).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a spawn failure's original error as the cause of the one it reports (OW-sozopu)", () => {
		const { child, onExit } = makeShell();
		const spawnError = Object.assign(new Error("spawn direnv ENOENT"), { code: "ENOENT" });

		child.emit("error", spawnError);
		child.emit("close", -2, null);

		expect(onExit).toHaveBeenCalledOnce();
		const error = onExit.mock.calls[0]?.[2] as Error;
		expect(error.message).toContain("Failed to spawn Test (direnv): spawn direnv ENOENT");
		expect(error.cause).toBe(spawnError);
	});
});
