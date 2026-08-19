/** Throwaway: a production build of the streaming-cost harness (e2e/perf.html). */
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
	plugins: [svelte()],
	resolve: {
		alias: {
			$shared: resolve("./src/shared"),
			$server: resolve("./src/server"),
			$client: resolve("./src/client"),
		},
	},
	build: {
		outDir: "dist/perf",
		emptyOutDir: true,
		minify: false,
		sourcemap: false,
		rollupOptions: { input: resolve("./e2e/perf.html") },
	},
});
