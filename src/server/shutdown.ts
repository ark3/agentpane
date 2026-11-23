/**
 * How the server stops, apart from the binding in `index.ts` so a test can
 * drive it over a fake process.
 */

/** The part of `process` this touches. */
export interface ShutdownProcess {
	on(event: string, listener: (...args: unknown[]) => void): unknown;
	exit(code: number): void;
}

/**
 * `stop` lets every agent go and closes the server; its settling is the
 * licence to exit. A signal runs it, and so does an error nothing else
 * caught: left to the runtime, that exits at once, and every agent with it.
 * Whether to keep serving after such an error instead is the owner's call
 * (ark3/agentpane#96); this is the first cut.
 */
export function installShutdown(proc: ShutdownProcess, stop: () => Promise<void>): void {
	let shuttingDown = false;

	const shutDown = (code: number) => {
		shuttingDown = true;
		void (async () => {
			try {
				await stop();
			} catch (err) {
				console.error("shutdown did not complete cleanly:", err);
			} finally {
				proc.exit(code);
			}
		})();
	};

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		proc.on(signal, () => {
			// A second Ctrl-C means the user is done waiting. Without this, a
			// shutdown that stalls on an adapter is a terminal you have to kill from
			// another one.
			if (shuttingDown) {
				proc.exit(130);
				return;
			}
			shutDown(0);
		});
	}

	for (const event of ["uncaughtException", "unhandledRejection"] as const) {
		proc.on(event, (error) => {
			console.error(`agentpane is shutting down on an ${event}:`, error);
			if (!shuttingDown) shutDown(1);
		});
	}
}
