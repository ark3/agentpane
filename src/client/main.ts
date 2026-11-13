import { mount } from "svelte";
import App from "./App.svelte";
import { createAgentpaneApi } from "./api.ts";
import "./app.css";
import { createController } from "./controller.ts";
import TokenPrompt from "./TokenPrompt.svelte";
import { createTokenGate } from "./token.ts";

// Resolve the non-persistent default before Svelte mounts, so the first app
// paint has a concrete palette rather than waiting for component lifecycle.
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
document.documentElement.dataset.theme = systemTheme.matches ? "dark" : "light";

const target = document.getElementById("app");
if (!target) throw new Error("missing #app");

// The API token lives in this origin's `localStorage`, and a 401 asks the owner
// to paste it; both are wired here for the same reason as the predicate below.
const tokenGate = createTokenGate(window.localStorage);
const api = createAgentpaneApi({ token: tokenGate.token, onUnauthorized: tokenGate.unauthorized });

// The preview poll must never run against a hidden tab (OW-76). The predicate
// is injected here because `controller.ts` stays free of `window`/`document`.
const controller = createController(api, () => document.visibilityState !== "hidden");

// Once a token is pasted, the listing is asked again, so the page recovers
// with nothing more from the owner; whatever action met the 401 is not retried.
mount(TokenPrompt, {
	target: document.body,
	props: { gate: tokenGate, onStored: () => void controller.refreshSessions() },
});

export default mount(App, { target, props: { controller } });
