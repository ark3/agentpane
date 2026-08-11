import { mount } from "svelte";
import App from "./App.svelte";
import { createAgentpaneApi } from "./api.ts";
import "./app.css";
import { createController } from "./controller.ts";

const target = document.getElementById("app");
if (!target) throw new Error("missing #app");

const controller = createController(createAgentpaneApi());

export default mount(App, { target, props: { controller } });
