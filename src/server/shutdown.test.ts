/**
 * The shutdown over a fake process. `index.test.ts` runs a SIGTERM through
 * the real binding; an error nothing else caught cannot be raised from
 * outside it, so it is driven here.
 */

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installShutdown } from "./shutdown.ts";

class FakeProcess extends EventEmitter {
	readonly exit = vi.fn<(code: number) => void>();
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("installShutdown", () => {
	it.each(["uncaughtException", "unhandledRejection"])(
		"writes an error from %s to stderr, runs the shutdown a SIGTERM runs, and exits 1 (#96)",
		async (event) => {
			const logged = vi.spyOn(console, "error").mockImplementation(() => {});
			const proc = new FakeProcess();
			const stop = vi.fn(async () => {});
			installShutdown(proc, stop);
			const error = new Error("a handler threw");

			proc.emit(event, error);

			await vi.waitFor(() => expect(proc.exit).toHaveBeenCalled());
			expect(stop).toHaveBeenCalledOnce();
			expect(proc.exit).toHaveBeenCalledExactlyOnceWith(1);
			expect(logged.mock.calls[0]).toContain(error);
		},
	);

	it("does not start a second shutdown for an error raised during the first", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const proc = new FakeProcess();
		let finish!: () => void;
		const stop = vi.fn(() => new Promise<void>((done) => (finish = done)));
		installShutdown(proc, stop);

		proc.emit("SIGTERM");
		proc.emit("uncaughtException", new Error("during shutdown"));
		finish();

		await vi.waitFor(() => expect(proc.exit).toHaveBeenCalled());
		expect(stop).toHaveBeenCalledOnce();
		expect(proc.exit).toHaveBeenCalledExactlyOnceWith(0);
	});
});
