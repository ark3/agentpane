/**
 * The real client against a server that goes away and comes back (D31 point
 * 6, ark3/agentpane#26).
 *
 * `/` is the real `index.html`, so this is the shipped `main.ts`: the real
 * api over a real browser `WebSocket`, the real controller and its own
 * reconnect, and the real token prompt. Playwright's `routeWebSocket` plays
 * the server, answering the socket's frames as `src/server/http/socket.ts`
 * does, so the close and the reopening are the browser's own; no agentpane
 * server or backend runs. The clock is Playwright's, so the fixed reconnect
 * delay (`RECONNECT_MS`) is stepped over rather than waited out.
 */
import { expect, test, type WebSocketRoute } from "@playwright/test";

const RECONNECT_MS = 5_000;
const TOKEN = "the-token";
const ref = { backend: "pi", id: "/work/a.jsonl" };
const listed = {
	ref,
	cwd: "/work",
	preview: "socket session",
	createdAt: "2026-11-19T00:00:00.000Z",
	updatedAt: "2026-11-19T00:00:01.000Z",
	status: "attached",
	isStreaming: false,
	name: null,
	onDisk: true,
	handle: "h1",
};
const opening = {
	type: "snapshot",
	session: ref,
	handle: "h1",
	seq: 1,
	messages: [],
	isStreaming: false,
	compaction: null,
	model: null,
	effort: null,
	unrestoredModel: null,
	error: null,
	errorId: null,
	notices: [],
};

test("the real client asks for a refused token, holds nothing live while the server is away, and reconnects on its own when it comes back", async ({ page }) => {
	let up = true;
	const hellos: string[] = [];
	let current: WebSocketRoute | undefined;
	await page.clock.install();
	await page.routeWebSocket("/api/socket", (ws) => {
		current = ws;
		// A server that is away: the attempt closes at once, as a refused connect does.
		if (!up) {
			void ws.close({ code: 1001, reason: "away" });
			return;
		}
		ws.onMessage((message) => {
			const frame = JSON.parse(String(message)) as { id: string; cmd: string; token?: string };
			const reply = (result: unknown) => ws.send(JSON.stringify({ type: "reply", id: frame.id, ok: true, result }));
			if (frame.cmd === "hello") {
				hellos.push(frame.token ?? "");
				if (frame.token !== TOKEN) {
					void ws.close({ code: 4401, reason: "the first frame must be a hello carrying the token" });
					return;
				}
				ws.send(JSON.stringify({ type: "event", event: opening }));
				reply(null);
				return;
			}
			if (frame.cmd === "sessions/list") reply({ sessions: [listed] });
			else if (frame.cmd === "models/list") reply({ models: [] });
			else if (frame.cmd === "sessions/forkPoints") reply({ points: [], forkStopsTurn: false });
			else if (frame.cmd === "sessions/preview") reply({ ref, turns: [] });
			else reply(null);
		});
	});

	await page.goto("/");
	const status = page.getByRole("status").first();
	const attachedRow = page.getByRole("button", { name: /\(attached\)$/ });

	// No token stored: the hello carries none, and the refusal asks for one.
	await page.getByRole("textbox", { name: "API token" }).fill(TOKEN);
	await page.getByRole("button", { name: "Save token" }).click();
	await expect(attachedRow).toBeVisible();
	expect(hellos).toEqual(["", TOKEN]);
	await expect(status).not.toHaveText("Reconnecting…");

	// The server goes away: every view goes at once, and every row reads detached.
	up = false;
	await current!.close({ code: 1001, reason: "the server is shutting down" });
	await expect(status).toHaveText("Reconnecting…");
	await expect(attachedRow).toHaveCount(0);

	// An attempt while it is still away fails, and the client keeps trying.
	await page.clock.runFor(RECONNECT_MS);
	await expect(status).toHaveText("Reconnecting…");
	expect(hellos).toEqual(["", TOKEN]);

	// It comes back: the next attempt says hello with the stored token, and the
	// opening snapshot and the listing make the session live again.
	up = true;
	await page.clock.runFor(RECONNECT_MS);
	await expect(attachedRow).toBeVisible();
	await expect(status).not.toHaveText("Reconnecting…");
	expect(hellos).toEqual(["", TOKEN, TOKEN]);
});
