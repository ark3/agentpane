import { defineConfig } from "@playwright/test";

const PORT = 5199;

/**
 * The browser UI suite, for the claims jsdom cannot host: layout, scroll
 * anchoring, real scroll-event timing, the Popover API, and files nothing in
 * the module graph imports. Follow mode and the transcript nav rail (OW-47,
 * OW-60), the composer's action row and its tools menu (OW-relehi, OW-80), the
 * assistant footer row (OW-75), the edit-and-fork chrome (OW-hezidi), and the
 * turn-done favicon badge and its icon (OW-diyuwu, OW-ropuwo) all live here;
 * `bunx playwright test --list` reports the current shape. It serves
 * `e2e/harness.html` through the project's own Vite config, so the aliases and
 * the Svelte plugin are the real ones. No backend is involved -- see
 * `e2e/harness.ts`.
 */
export default defineConfig({
	testDir: "e2e",
	testMatch: /.*\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	// `list`, not the default `html`: no report directory, and nothing opens a
	// browser window at the end of a run.
	reporter: "list",
	use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 900, height: 700 } },
	webServer: {
		command: `./node_modules/.bin/vite --port ${PORT} --strictPort`,
		url: `http://127.0.0.1:${PORT}/e2e/harness.html`,
		reuseExistingServer: true,
		stdout: "ignore",
	},
});
