import { mount } from "svelte";
import App from "./App.svelte";
import { createAgentpaneApi } from "./api.ts";
import "./app.css";
import { createController } from "./controller.ts";

const target = document.getElementById("app");
if (!target) throw new Error("missing #app");

// The preview poll must never run against a hidden tab (OW-76). The predicate
// is injected here because `controller.ts` stays free of `window`/`document`.
const controller = createController(createAgentpaneApi(), () => document.visibilityState !== "hidden");

export default mount(App, { target, props: { controller } });
