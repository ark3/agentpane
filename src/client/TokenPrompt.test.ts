import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTES } from "$shared/protocol.ts";
import { createAgentpaneApi } from "./api.ts";
import { createController } from "./controller.ts";
import TokenPrompt from "./TokenPrompt.svelte";
import { createTokenGate, TOKEN_STORAGE_KEY } from "./token.ts";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const unauthorized = () => json({ error: "unauthorized", detail: "this API needs its bearer token" }, 401);

/**
 * The real api, controller and gate, wired as `main.ts` wires them, over a
 * fake `fetch` answering each listing from `answers` in turn.
 */
function mountWired(answers: Array<() => Response>) {
	const fetch = vi.fn<(...args: Parameters<typeof globalThis.fetch>) => Promise<Response>>(async () => {
		const next = answers.shift();
		if (!next) throw new Error("unexpected request");
		return next();
	});
	const gate = createTokenGate(localStorage);
	const api = createAgentpaneApi({
		fetch: fetch as unknown as typeof globalThis.fetch,
		openEvents: () => ({ close() {} }),
		token: gate.token,
		onUnauthorized: gate.unauthorized,
	});
	const controller = createController(api);
	render(TokenPrompt, { gate, onStored: () => void controller.refreshSessions() });
	return { fetch, controller };
}

function authorizationOf(init: RequestInit | undefined): string | null {
	return new Headers(init?.headers).get("authorization");
}

describe("TokenPrompt", () => {
	beforeEach(() => localStorage.clear());

	it("asks for the token on a 401, stores the paste, retries the listing with it, and asks again on a later 401", async () => {
		const { fetch, controller } = mountWired([unauthorized, () => json({ sessions: [] }), unauthorized]);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		await controller.start();
		const dialog = await screen.findByRole("dialog");
		expect(dialog).toHaveTextContent("~/.ssh/agentpane-token");
		expect(authorizationOf(fetch.mock.calls[0]![1])).toBeNull();

		await fireEvent.input(screen.getByLabelText("API token"), { target: { value: "  pasted-token\n" } });
		await fireEvent.click(screen.getByRole("button", { name: "Save token" }));

		expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("pasted-token");
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		expect(fetch.mock.calls[1]![0]).toBe(ROUTES.sessions);
		expect(authorizationOf(fetch.mock.calls[1]![1])).toBe("Bearer pasted-token");
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

		// The token was rotated on the server: the stored one is refused.
		await controller.refreshSessions();
		expect(authorizationOf(fetch.mock.calls[2]![1])).toBe("Bearer pasted-token");
		await screen.findByRole("dialog");
		// Asked again with an empty field: the stored token is never shown.
		expect(screen.getByLabelText("API token")).toHaveValue("");
		expect(document.body).not.toHaveTextContent("pasted-token");
		controller.dispose();
	});

	it("stores nothing for a blank paste", async () => {
		const { controller } = mountWired([unauthorized]);
		await controller.start();
		await screen.findByRole("dialog");

		await fireEvent.input(screen.getByLabelText("API token"), { target: { value: "   " } });
		await fireEvent.click(screen.getByRole("button", { name: "Save token" }));

		expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		controller.dispose();
	});
});
