/**
 * Runs the streaming-cost harness and prints a table. Not a test -- there is no
 * assertion here, because the question it answers ("where does the time go")
 * has a number for an answer, not a boolean. Run it by hand:
 *
 *   ./node_modules/.bin/vite --port 5199 --strictPort &
 *   bun e2e/perf-probe.ts
 */

import { chromium } from "@playwright/test";

const URL = process.env.PERF_URL ?? "http://127.0.0.1:5199/e2e/perf.html";

interface Stats {
	count: number;
	total: number;
	mean: number;
	median: number;
	p95: number;
	max: number;
	mutations: number;
}

interface Scenario {
	name: string;
	sessions: number;
	seedTurns: number;
	otherTurns: number;
}

const SCENARIOS: Scenario[] = [
	{ name: "short transcript, 2 sessions", sessions: 2, seedTurns: 5, otherTurns: 5 },
	{ name: "long transcript, 2 sessions", sessions: 2, seedTurns: 60, otherTurns: 5 },
	{ name: "long transcript, 400 sessions", sessions: 400, seedTurns: 60, otherTurns: 5 },
	{ name: "short transcript, 400 sessions", sessions: 400, seedTurns: 5, otherTurns: 5 },
];

const CHUNKS = 60;

async function main(): Promise<void> {
	const browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
	page.on("pageerror", (error) => console.error("pageerror:", error.message));
	await page.goto(URL);
	await page.waitForFunction(() => "perf" in globalThis);

	const rows: string[] = [];
	for (const scenario of SCENARIOS) {
		await page.evaluate(
			(opts) => (globalThis as any).perf.setup(opts),
			{ sessions: scenario.sessions, seedTurns: scenario.seedTurns, otherTurns: scenario.otherTurns },
		);
		const rendered = await page.evaluate(() => (globalThis as any).perf.rendered());
		// Warm-up pass, discarded: first-paint of a freshly seeded transcript
		// pays one-off costs (highlighting, font metrics) that are not streaming.
		await page.evaluate((n) => (globalThis as any).perf.stream("a", n), 10);
		const selected: Stats = await page.evaluate(
			(n) => (globalThis as any).perf.stream("a", n),
			CHUNKS,
		);
		const background: Stats = await page.evaluate(
			(n) => (globalThis as any).perf.stream("b", n),
			CHUNKS,
		);
		rows.push(
			[
				scenario.name.padEnd(32),
				`rendered=${String(rendered).padStart(4)}`,
				`selected: median=${fmt(selected.median)} mut=${String(selected.mutations).padStart(5)}`,
				`background: median=${fmt(background.median)} mut=${String(background.mutations).padStart(5)}`,
			].join("  "),
		);
		console.log(rows[rows.length - 1]);
	}

	await browser.close();
}

const fmt = (value: number) => `${value.toFixed(2)}ms`.padStart(8);

await main();
