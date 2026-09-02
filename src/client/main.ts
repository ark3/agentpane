import { mount } from "svelte";
import App from "./App.svelte";
import { createAgentpaneApi } from "./api.ts";
import "./app.css";
import { createController } from "./controller.ts";

// Resolve the non-persistent default before Svelte mounts, so the first app
// paint has a concrete palette rather than waiting for component lifecycle.
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
document.documentElement.dataset.theme = systemTheme.matches ? "dark" : "light";

const target = document.getElementById("app");
if (!target) throw new Error("missing #app");

// The preview poll must never run against a hidden tab (OW-76). The predicate
// is injected here because `controller.ts` stays free of `window`/`document`.
const controller = createController(createAgentpaneApi(), () => document.visibilityState !== "hidden");

export default mount(App, { target, props: { controller } });
