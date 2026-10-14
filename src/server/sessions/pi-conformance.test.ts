/**
 * The live transcript and the preview of one Pi run held against each other,
 * one recorded run at a time (OW-piyulu); the Pi counterpart of
 * `codex-conformance.test.ts`.
 *
 * An attached session's transcript is what `reducePiNotification`
 * (`adapters/pi/reducer.ts`) builds from Pi's RPC events. A preview reads the
 * session file Pi wrote, through `extractPiPreviewTurns` (`./pi.ts`) and
 * `storedAgentMessage`. Each scenario below is one capture by
 * `resources/probes/capture_fixtures.py` that kept both halves of the same
 * run: `<scenario>.jsonl`, the RPC stream, and `<scenario>.session.jsonl`, the
 * session file. The stream is replayed through the reducer, the file through
 * the preview, and both are projected onto what a reader would notice: the
 * role sequence, content-block kinds, tool names, whether each call has its
 * result and each result its call, `isError`, `stopReason`, the effort a
 * footer names, and a compaction marker's figure and whether it carries a
 * summary. Timestamps, usage and model identity differ by design and are left
 * out, as is all text. A result row names its call by how many calls back it
 * sits, said only when it is not the latest call.
 *
 * The replay starts at the effort `process.ts` holds once `get_state` answers
 * at spawn: the level the capture's `--model` ref named, since the model it
 * pins reasons. The capture sent no `get_state`, so the stream cannot say it.
 *
 * Every place the two disagree is listed in `KNOWN_DIFFERENCES`, keyed to the
 * card that owns it. Fixing a row is that card's work, not this file's; when it
 * lands, the scenario here fails until its entry is removed, which is the
 * point -- the table stays a true list of what still differs.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PiNotification, PiOutputLine } from "../adapters/pi/protocol.ts";
import { createInitialPiState, type PiReducerState, reducePiNotification } from "../adapters/pi/reducer.ts";
import { hunks, type KnownDifference } from "./conformance-support.ts";
import { extractPiPreviewTurns } from "./pi.ts";

const FIXTURE_DIR = fileURLToPath(new URL("../../../resources/fixtures/pi/", import.meta.url));

type Scenario = "tool-read-session" | "compact-session";

interface Message {
	role: string;
	content?: unknown;
	stopReason?: string;
	effort?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	summary?: string;
	tokensBefore?: number;
}

/** One row per message; see the header for what a row keeps and what it drops. */
function project(messages: Message[]): string[] {
	const results = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolCallId !== undefined) results.add(message.toolCallId);
	}
	const calls: string[] = [];
	return messages.map((message) => {
		switch (message.role) {
			case "assistant": {
				const blocks = (message.content as { type: string; id: string; name: string }[]).map((block) => {
					if (block.type !== "toolCall") return block.type;
					calls.push(block.id);
					return `call ${block.name}${results.has(block.id) ? "" : " (no result)"}`;
				});
				const effort = message.effort ? ` effort=${message.effort}` : "";
				return `assistant ${message.stopReason} [${blocks.join(", ")}]${effort}`;
			}
			case "toolResult": {
				const at = calls.lastIndexOf(message.toolCallId ?? "");
				const back = calls.length - 1 - at;
				const link = at === -1 ? " (no call)" : back > 0 ? ` (call ${back} back)` : "";
				return `toolResult ${message.toolName} ${message.isError ? "error" : "ok"}${link}`;
			}
			case "compactionSummary":
				return `compactionSummary tokensBefore=${message.tokensBefore} summary=${message.summary ? "present" : "empty"}`;
			default:
				return message.role;
		}
	});
}

function live(name: Scenario): string[] {
	const meta = JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.meta.json`, "utf8")) as { model_flag: string };
	let state: PiReducerState = { ...createInitialPiState(), effort: meta.model_flag.split(":").at(-1)! };
	for (const line of readFileSync(`${FIXTURE_DIR}${name}.jsonl`, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		const event = JSON.parse(line) as PiOutputLine;
		// Command correlation, which `process.ts` never hands the reducer.
		if (event.type === "response") continue;
		state = reducePiNotification(state, event as PiNotification).state;
	}
	return project(state.messages as Message[]);
}

async function preview(name: Scenario): Promise<string[]> {
	return project((await extractPiPreviewTurns(`${FIXTURE_DIR}${name}.session.jsonl`)) as Message[]);
}

/** What `OW-zarine` owns in each hunk below. */
const EFFORT =
	"live, each assistant turn names the level in force as it started; stored, the message carries it as " +
	"`thinkingLevel`, which `storedAgentMessage` keeps but does not name as the turn's `effort`, " +
	"so the preview's footer shows none";

/**
 * Captured on `pi 1.2.0`, on 2026-10-14; see each `.meta.json`, and
 * `docs/MANUAL_TESTING.md`, "Pi fixtures that keep their session file
 * (OW-piyulu)".
 */
const KNOWN_DIFFERENCES: Record<Scenario, KnownDifference[]> = {
	"tool-read-session": [
		{
			owners: { "OW-zarine": EFFORT },
			live: ["assistant toolUse [thinking, call read] effort=high"],
			preview: ["assistant toolUse [thinking, call read]"],
		},
		{
			owners: { "OW-zarine": EFFORT },
			live: ["assistant stop [text] effort=high"],
			preview: ["assistant stop [text]"],
		},
	],
	"compact-session": [
		{
			owners: { "OW-zarine": EFFORT },
			live: ["assistant stop [thinking, text] effort=high"],
			preview: ["assistant stop [thinking, text]"],
		},
		{
			owners: {
				"OW-zarine": EFFORT,
				"OW-livowu":
					"live, `compaction_end` appends a `compactionSummary` marker; stored, Pi writes the compaction as a " +
					"`type: \"compaction\"` entry, not a `message`, and the preview reads only `message` entries, so it draws no marker",
			},
			live: ["assistant stop [thinking, text] effort=high", "compactionSummary tokensBefore=5915 summary=present"],
			preview: ["assistant stop [thinking, text]"],
		},
	],
};

describe("live and preview agree on a Pi run, but for the known differences", () => {
	for (const [scenario, known] of Object.entries(KNOWN_DIFFERENCES)) {
		it(scenario, async () => {
			const name = scenario as Scenario;
			const differences = hunks(live(name), await preview(name));
			expect(differences).toEqual(known.map(({ live, preview }) => ({ live, preview })));
		});
	}
});
