/**
 * Same harness, but records a V8 CPU profile over the streaming window and
 * prints the top functions by self time. Answers "where does the time go",
 * which the wall-clock probe deliberately does not.
 *
 *   ./node_modules/.bin/vite --port 5199 --strictPort &
 *   bun e2e/perf-profile.ts [selected|background]
 */

import { chromium } from "@playwright/test";

const URL = process.env.PERF_URL ?? "http://127.0.0.1:5199/e2e/perf.html";
const TARGET = (process.argv[2] ?? "background") as "selected" | "background";

interface ProfileNode {
	id: number;
	callFrame: { functionName: string; url: string; lineNumber: number };
	hitCount?: number;
	children?: number[];
}

async function main(): Promise<void> {
	const browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
	page.on("pageerror", (error) => console.error("pageerror:", error.message));
	await page.goto(URL);
	await page.waitForFunction(() => "perf" in globalThis);

	await page.evaluate((opts) => (globalThis as any).perf.setup(opts), {
		sessions: 400,
		seedTurns: 60,
		otherTurns: 5,
	});
	// Warm-up, outside the profile.
	await page.evaluate(() => (globalThis as any).perf.stream("a", 10));

	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Profiler.enable");
	await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
	await cdp.send("Profiler.start");
	await page.evaluate(
		(id) => (globalThis as any).perf.stream(id, 40),
		TARGET === "selected" ? "a" : "b",
	);
	const { profile } = (await cdp.send("Profiler.stop")) as {
		profile: { nodes: ProfileNode[]; startTime: number; endTime: number };
	};

	const self = new Map<string, number>();
	let totalHits = 0;
	for (const node of profile.nodes) {
		const hits = node.hitCount ?? 0;
		if (hits === 0) continue;
		totalHits += hits;
		const frame = node.callFrame;
		const file = frame.url.split("/").slice(-1)[0]?.split("?")[0] ?? "?";
		const name = frame.functionName || "(anonymous)";
		const key = `${name} — ${file}:${frame.lineNumber + 1}`;
		self.set(key, (self.get(key) ?? 0) + hits);
	}

	const wall = (profile.endTime - profile.startTime) / 1000;
	console.log(`\nstreaming into the ${TARGET} session — ${wall.toFixed(0)}ms wall, ${totalHits} samples\n`);
	const ranked = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
	for (const [key, hits] of ranked) {
		const pct = ((hits / totalHits) * 100).toFixed(1);
		console.log(`${pct.padStart(5)}%  ${((hits / totalHits) * wall).toFixed(0).padStart(5)}ms  ${key}`);
	}

	await browser.close();
}

await main();
