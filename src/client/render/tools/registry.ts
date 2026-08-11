/**
 * The tool renderer registry (D5).
 *
 * A `Map<string, Component>` with a **default entry**. The default is
 * load-bearing rather than a fallback afterthought:
 *
 * - Codex emits `mcpToolCall` and `dynamicToolCall` with arbitrary names that
 *   cannot be pre-registered (HANDOFF 12, 16).
 * - The Pi fixtures show Pi choosing `bash` to perform a file edit rather than
 *   a dedicated edit tool (HANDOFF 24) -- even a "known" backend's tool
 *   vocabulary is not fixed.
 *
 * `pi-web-ui` has no such hook at all; pipane had to patch one in. Here it is
 * the five lines it always was, owned by us.
 */

import type { Component } from "svelte";
import type { ToolRenderProps } from "../types.ts";
import BashTool from "./BashTool.svelte";
import DefaultTool from "./DefaultTool.svelte";
import EditTool from "./EditTool.svelte";
import ReadTool from "./ReadTool.svelte";
import WriteTool from "./WriteTool.svelte";

export type ToolRenderer = Component<ToolRenderProps>;

const renderers = new Map<string, ToolRenderer>([
	["bash", BashTool as ToolRenderer],
	["shell", BashTool as ToolRenderer],
	["read", ReadTool as ToolRenderer],
	["write", WriteTool as ToolRenderer],
	["edit", EditTool as ToolRenderer],
]);

/** Used for every name not in the map. Never null. */
export const defaultToolRenderer: ToolRenderer = DefaultTool as ToolRenderer;

/**
 * Tool names are matched case-insensitively: backends differ on casing for the
 * same underlying tool (`Bash` vs `bash`), and nothing is gained by treating
 * them as different tools.
 */
export function resolveToolRenderer(name: string): ToolRenderer {
	return renderers.get(name.toLowerCase()) ?? defaultToolRenderer;
}

/** Register (or override) a renderer. Later workstreams and Codex-specific tools use this. */
export function registerToolRenderer(name: string, renderer: ToolRenderer): void {
	renderers.set(name.toLowerCase(), renderer);
}

/** Test seam: names with a bespoke renderer. */
export function registeredToolNames(): string[] {
	return [...renderers.keys()].sort();
}
