/**
 * Pi's system-role messages, projected once for both clients (OW-wavini).
 *
 * As of `pi 1.2.0`, `Message` includes `SystemMessage`: every Pi session opens
 * with a leading one carrying the whole system prompt as named `sections` and
 * every tool definition in `toolsAdded` (about 10 KB as JSON), and a later one
 * lands mid-conversation whenever the configuration changes, carrying only the
 * delta -- sections replaced by name, `null` for one removed, tools added and
 * removed (`docs/MANUAL_TESTING.md`, "Pi's system-role messages arrive live and
 * from `get_messages`").
 * Pi counts them in its message indexes, so they stay in the transcript and
 * only their drawing is condensed.
 *
 * The decision, a first cut chosen by the owner on 2026-10-14 and to be judged
 * in use: every system message, the leading one included, draws as a one-line
 * marker naming what it carries, with its text behind a disclosure collapsed by
 * default, in the browser (`Message.svelte`) and in Emacs (`nodes.ts`) alike.
 * Behind it go the content, each section under its name, and the tools added
 * by name and description -- never their JSON parameter schemas -- and removed
 * by name.
 *
 * Which message is the leading one is a matter of position, as it is to Pi:
 * pi-ai's own types call the leading system message the system prompt and
 * every later one a change to it. So the first system message in the
 * transcript reads "System prompt" and counts what it declares, and every
 * later one reads "System prompt changed" and names what it changes.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import type { TranscriptView } from "./transcript.ts";

export interface SystemSection {
	name: string;
	/** The section's text, or null when the message removes it. */
	text: string | null;
}

export interface SystemTool {
	name: string;
	description: string;
}

export interface SystemView {
	/** The marker: one line naming what the message carries. */
	summary: string;
	/** The message's own instruction text, empty when it has none (the leading one Pi wrote on 2026-10-14 had none). */
	content: string;
	sections: SystemSection[];
	toolsAdded: SystemTool[];
	toolsRemoved: string[];
}

/**
 * Whether a session is not yet prompted, which is when its model and effort
 * may still be chosen: its transcript holds system messages at most
 * (OW-widozi). As of `pi 1.2.0` a fresh Pi session held none until its first
 * prompt, but a fork at the first user message kept the leading one and
 * nothing else (`docs/MANUAL_TESTING.md`, OW-wavini and OW-vijine), and D23
 * has a fork that keeps no turn run as an unprompted session does.
 * False for a session this tab holds no view of.
 */
export function unprompted(messages: readonly AgentMessage[] | undefined): boolean {
	return messages !== undefined && messages.every((message) => message.role === "system");
}

/** The `messages` index of the transcript's leading system message, or -1. */
export function leadingSystemIndex(view: TranscriptView): number {
	return view.entries.find((entry) => entry.message.role === "system")?.index ?? -1;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function systemView(message: SystemMessage, leading: boolean): SystemView {
	const content =
		typeof message.content === "string"
			? message.content
			: message.content.map((block) => block.text).join("\n");
	const sections = Object.entries(message.sections ?? {}).map(([name, text]) => ({ name, text }));
	const toolsAdded = (message.toolsAdded ?? []).map(({ name, description }) => ({ name, description }));
	const toolsRemoved = (message.toolsRemoved ?? []).map(({ name }) => name);

	const facts: string[] = [];
	if (content.trim()) facts.push("instructions");
	if (leading) {
		if (sections.length > 0) facts.push(plural(sections.length, "section"));
		if (toolsAdded.length > 0) facts.push(plural(toolsAdded.length, "tool"));
	} else {
		if (sections.length > 0) {
			facts.push(sections.map(({ name, text }) => (text === null ? `−${name}` : name)).join(", "));
		}
		const tools = [...toolsAdded.map(({ name }) => `+${name}`), ...toolsRemoved.map((name) => `−${name}`)];
		if (tools.length > 0) facts.push(`tools ${tools.join(" ")}`);
	}

	return {
		summary: [leading ? "System prompt" : "System prompt changed", ...facts].join(" · "),
		content,
		sections,
		toolsAdded,
		toolsRemoved,
	};
}
