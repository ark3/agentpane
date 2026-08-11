/**
 * Proves the client test project works end to end: jsdom + Svelte 5 +
 * @testing-library/svelte. The renderer workstream builds on this setup, so if
 * it breaks, that is a scaffold problem rather than a component problem.
 */
import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import App from "./App.svelte";

describe("App", () => {
	it("mounts and renders", () => {
		render(App);
		expect(screen.getByRole("heading", { name: "agentpane" })).toBeInTheDocument();
	});
});
