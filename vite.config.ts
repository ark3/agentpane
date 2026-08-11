import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { DEFAULT_PORT } from "./src/shared/protocol.ts";

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
	server: {
		// Loopback only (D8). The dev server proxies API traffic to the Bun
		// server so the client sees one origin.
		host: "127.0.0.1",
		proxy: {
			"/api": {
				target: `http://127.0.0.1:${DEFAULT_PORT}`,
				changeOrigin: false,
			},
		},
	},
	build: {
		outDir: "dist/client",
		emptyOutDir: true,
	},
	test: {
		// Server-side code (adapters, session index, transport) needs a real
		// node environment -- `node:fs` and file: URLs do not work under jsdom.
		// Client component tests need a DOM. Splitting by project means neither
		// side has to remember a per-file environment docblock.
		projects: [
			{
				extends: true,
				test: {
					name: "server",
					environment: "node",
					globals: true,
					include: ["src/server/**/*.{test,spec}.ts", "src/shared/**/*.{test,spec}.ts", "src/*.{test,spec}.ts"],
				},
			},
			{
				extends: true,
				// Without the browser condition, Svelte 5 resolves to its server
				// build and `mount()` throws lifecycle_function_unavailable.
				resolve: { conditions: ["browser"] },
				test: {
					name: "client",
					environment: "jsdom",
					globals: true,
					setupFiles: ["./vitest.setup.ts"],
					include: ["src/client/**/*.{test,spec}.ts"],
				},
			},
		],
	},
});
