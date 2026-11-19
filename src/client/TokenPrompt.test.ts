import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it } from "vitest";
import { SOCKET_CLOSE } from "$shared/protocol.ts";
import { createAgentpaneApi } from "./api.ts";
import { createController } from "./controller.ts";
import { FakeSocket } from "./test-support.ts";
import TokenPrompt from "./TokenPrompt.svelte";
import { createTokenGate, TOKEN_STORAGE_KEY } from "./token.ts";

/**
 * The real api, controller and gate, wired as `main.ts` wires them, over fake
 * sockets that accept a `hello` carrying `accepted` and close the rest
 * `SOCKET_CLOSE.unauthorized`, as the server does (D31 point 5).
 */
function mountWired(accepted: { token: string }) {
	const sockets: FakeSocket[] = [];
	const gate = createTokenGate(localStorage);
	const api = createAgentpaneApi({
		openSocket: (path) => {
			const socket = new FakeSocket(path, (from, frame) => {
				if (frame["cmd"] === "hello") {
					if (frame["token"] === accepted.token) from.deliver({ type: "reply", id: frame["id"] as string, ok: true, result: null });
					else from.drop(SOCKET_CLOSE.unauthorized, "the first frame must be a hello carrying the token");
				} else if (frame["cmd"] === "sessions/list") {
					from.deliver({ type: "reply", id: frame["id"] as string, ok: true, result: { sessions: [] } });
				}
			});
			sockets.push(socket);
			queueMicrotask(() => socket.open());
			return socket;
		},
		token: gate.token,
		onUnauthorized: gate.unauthorized,
	});
	const controller = createController(api);
	render(TokenPrompt, { gate, onStored: () => controller.reconnect() });
	return { sockets, controller };
}

const hellos = (sockets: FakeSocket[]) => sockets.map((socket) => socket.sent.find((frame) => frame["cmd"] === "hello")?.["token"]);

describe("TokenPrompt", () => {
	beforeEach(() => localStorage.clear());

	it("asks for the token when the server refuses the hello, stores the paste, connects with it at once, and asks again on a later refusal", async () => {
		const accepted = { token: "pasted-token" };
		const { sockets, controller } = mountWired(accepted);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		await controller.start();
		const dialog = await screen.findByRole("dialog");
		expect(dialog).toHaveTextContent("~/.ssh/agentpane-token");
		expect(hellos(sockets)).toEqual([""]);
		// A text field, so the owner sees what they pasted.
		expect(screen.getByLabelText("API token")).toHaveAttribute("type", "text");

		await fireEvent.input(screen.getByLabelText("API token"), { target: { value: "  pasted-token\n" } });
		await fireEvent.click(screen.getByRole("button", { name: "Save token" }));

		expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("pasted-token");
		await waitFor(() => expect(controller.getView().connection).toBe("connected"));
		expect(hellos(sockets)).toEqual(["", "pasted-token"]);
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

		// The token was rotated on the server and the server restarted: the stored one is refused.
		accepted.token = "rotated";
		sockets.at(-1)!.drop(1006);
		controller.reconnect();
		await screen.findByRole("dialog");
		expect(hellos(sockets)).toEqual(["", "pasted-token", "pasted-token"]);
		// Asked again with an empty field: the stored token is never shown.
		expect(screen.getByLabelText("API token")).toHaveValue("");
		expect(document.body).not.toHaveTextContent("pasted-token");
		controller.dispose();
	});

	it("stores nothing for a blank paste", async () => {
		const { controller } = mountWired({ token: "pasted-token" });
		await controller.start();
		await screen.findByRole("dialog");

		await fireEvent.input(screen.getByLabelText("API token"), { target: { value: "   " } });
		await fireEvent.click(screen.getByRole("button", { name: "Save token" }));

		expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		controller.dispose();
	});
});
