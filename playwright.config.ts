import { defineConfig } from "@playwright/test";

const PORT = 5199;

/**
 * One browser test vehicle, for follow mode (OW-47). It serves `e2e/harness.html`
 * through the project's own Vite config, so the aliases and the Svelte plugin
 * are the real ones. No backend is involved -- see `e2e/harness.ts`.
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
