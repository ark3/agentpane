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
import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";

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

/**
 * Play the server on every socket `routed` opens: one that is away while
 * `server.up` is false, and otherwise one that accepts a `hello` carrying
 * `TOKEN` and closes the rest 4401, as `src/server/http/socket.ts` does.
 * `empty` plays one with nothing to list and nothing live.
 */
async function playServer(routed: Pick<Page, "routeWebSocket">, { empty = false } = {}) {
	const server = { up: true, hellos: [] as string[], current: undefined as WebSocketRoute | undefined };
	await routed.routeWebSocket("/api/socket", (ws) => {
		server.current = ws;
		// A server that is away: the attempt closes at once, as a refused connect does.
		if (!server.up) {
			void ws.close({ code: 1001, reason: "away" });
			return;
		}
		ws.onMessage((message) => {
			const frame = JSON.parse(String(message)) as { id: string; cmd: string; token?: string };
			const reply = (result: unknown) => ws.send(JSON.stringify({ type: "reply", id: frame.id, ok: true, result }));
			if (frame.cmd === "hello") {
				server.hellos.push(frame.token ?? "");
				if (frame.token !== TOKEN) {
					void ws.close({ code: 4401, reason: "the first frame must be a hello carrying the token" });
					return;
				}
				if (!empty) ws.send(JSON.stringify({ type: "event", event: opening }));
				reply(null);
				return;
			}
			if (frame.cmd === "sessions/list") reply({ sessions: empty ? [] : [listed] });
			else if (frame.cmd === "models/list") reply({ models: [] });
			else if (frame.cmd === "sessions/forkPoints") reply({ points: [], forkStopsTurn: false });
			else if (frame.cmd === "sessions/preview") reply({ ref, turns: [] });
			else reply(null);
		});
	});
	return server;
}

test("the real client asks for a refused token, holds nothing live while the server is away, and reconnects on its own when it comes back", async ({ page }) => {
	await page.clock.install();
	const server = await playServer(page);
	const { hellos } = server;

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
	server.up = false;
	await server.current!.close({ code: 1001, reason: "the server is shutting down" });
	await expect(status).toHaveText("Reconnecting…");
	await expect(attachedRow).toHaveCount(0);

	// An attempt while it is still away fails, and the client keeps trying.
	await page.clock.runFor(RECONNECT_MS);
	await expect(status).toHaveText("Reconnecting…");
	expect(hellos).toEqual(["", TOKEN]);

	// It comes back: the next attempt says hello with the stored token, and the
	// opening snapshot and the listing make the session live again.
	server.up = true;
	await page.clock.runFor(RECONNECT_MS);
	await expect(attachedRow).toBeVisible();
	await expect(status).not.toHaveText("Reconnecting…");
	expect(hellos).toEqual(["", TOKEN, TOKEN]);
});

// The first run in a new browser, against a server with nothing to list. The
// refusal fails the startup listing behind the `hello` into the banner, and
// the accepted `hello` is what answers it: no listing the client makes then
// surfaces, and with a session listed, the startup preview of the top row
// would clear the slot and hide that.
test("a pasted token that is accepted takes down the dialog and the banner the refusal left", async ({ page }) => {
	await page.clock.install();
	const server = await playServer(page, { empty: true });
	await page.goto("/");
	const dialog = page.getByRole("dialog", { name: "API token needed" });
	const banner = page.getByRole("alert");
	await expect(dialog).toBeVisible();
	await expect(banner).toHaveText(/the server refused the API token/);

	await page.getByRole("textbox", { name: "API token" }).fill(TOKEN);
	await page.getByRole("button", { name: "Save token" }).click();
	await expect.poll(() => server.hellos).toEqual(["", TOKEN]);
	await expect(page.getByRole("status").first()).not.toHaveText(/Connecting…|Reconnecting…/);
	await expect(dialog).toHaveCount(0);
	await expect(banner).toHaveCount(0);
});

// `asking` was lowered only by a paste in this tab, so a tab whose dialog was
// up kept it over a connection made on the token another tab stored.
test("a tab asking for the token connects on the one another tab stored, and its dialog and banner go", async ({ context }) => {
	await context.clock.install();
	const server = await playServer(context, { empty: true });
	const asking = await context.newPage();
	await asking.goto("/");
	const dialog = asking.getByRole("dialog", { name: "API token needed" });
	const banner = asking.getByRole("alert");
	await expect(dialog).toBeVisible();
	await expect(banner).toHaveText(/the server refused the API token/);

	// Another tab on the origin is given the token, and stores it where this one reads it.
	const pasted = await context.newPage();
	await pasted.goto("/");
	await pasted.getByRole("textbox", { name: "API token" }).fill(TOKEN);
	await pasted.getByRole("button", { name: "Save token" }).click();
	await expect.poll(() => server.hellos).toEqual(["", "", TOKEN]);

	// The asking tab's next attempt carries it, and its accepted hello takes both down.
	await context.clock.runFor(RECONNECT_MS);
	await expect.poll(() => server.hellos).toEqual(["", "", TOKEN, TOKEN]);
	await expect(asking.getByRole("status").first()).not.toHaveText(/Connecting…|Reconnecting…/);
	await expect(dialog).toHaveCount(0);
	await expect(banner).toHaveCount(0);
});
