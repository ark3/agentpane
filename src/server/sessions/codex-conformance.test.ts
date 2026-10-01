/**
 * The two Codex mappers held against each other, one recorded run at a time
 * (OW-zadupu).
 *
 * An attached session reaches the transcript through `mapItem`
 * (`adapters/codex/mapping.ts`, driven by `CodexReducer`); a preview reads the
 * rollout Codex wrote to disk through `extractStoreTurn` (`./codex.ts`).
 * Nothing else ties them together. Each scenario below is one capture by
 * `resources/probes/capture_fixtures.py` that kept both halves of the same
 * run: `<scenario>.jsonl`, the app-server stream, and `<scenario>.rollout.jsonl`,
 * the rollout. The stream is replayed through the reducer, the rollout through
 * the preview, and both are projected onto what a reader would notice: the
 * role sequence, tool names, whether each call has its result and each result
 * its call, `isError`, `stopReason`, and a compaction marker's figure and
 * whether it carries a summary. Timestamps, usage and model identity differ by
 * design and are left out, as is any text.
 *
 * Every place the two disagree is listed in `KNOWN_DIFFERENCES`, keyed to the
 * card that owns it. Fixing a row is that card's work, not this file's; when it
 * lands, the scenario here fails until its entry is removed, which is the
 * point -- the table stays a true list of what still differs.
 */

import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { CodexReducer } from "../adapters/codex/reducer.ts";
import { readFixture, type FixtureName } from "../adapters/codex/test-support.ts";
import { extractCodexPreviewTurns } from "./codex.ts";

const FIXTURE_DIR = fileURLToPath(new URL("../../../resources/fixtures/codex/", import.meta.url));

interface Message {
	role: string;
	content?: unknown;
	stopReason?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	summary?: string;
	tokensBefore?: number;
}

/** One row per message; see the header for what a row keeps and what it drops. */
function project(messages: Message[]): string[] {
	const results = new Map<string, number>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolCallId !== undefined) {
			results.set(message.toolCallId, (results.get(message.toolCallId) ?? 0) + 1);
		}
	}
	const calls = new Set<string>();
	return messages.map((message) => {
		switch (message.role) {
			case "assistant": {
				const blocks = (message.content as { type: string; id: string; name: string }[]).map((block) => {
					if (block.type !== "toolCall") return block.type;
					calls.add(block.id);
					return `call ${block.name}${results.has(block.id) ? "" : " (no result)"}`;
				});
				return `assistant ${message.stopReason} [${blocks.join(", ")}]`;
			}
			case "toolResult":
				return `toolResult ${message.toolName} ${message.isError ? "error" : "ok"}${
					calls.has(message.toolCallId ?? "") ? "" : " (no call)"
				}`;
			case "compactionSummary":
				return `compactionSummary tokensBefore=${message.tokensBefore} summary=${message.summary ? "present" : "empty"}`;
			default:
				return message.role;
		}
	});
}

function live(name: FixtureName): string[] {
	const reducer = new CodexReducer({ now: () => 1_000 });
	for (const line of readFixture(name)) reducer.handle(line);
	return project(reducer.getState().messages as Message[]);
}

async function preview(name: FixtureName): Promise<string[]> {
	const turns = await extractCodexPreviewTurns(`${FIXTURE_DIR}${name}.rollout.jsonl`, () => undefined);
	return project(turns as Message[]);
}

interface Hunk {
	live: string[];
	preview: string[];
}

/**
 * Where two row sequences part, as hunks between the rows they share (a
 * longest common subsequence), in order. Equal sequences give none.
 */
function hunks(a: string[], b: string[]): Hunk[] {
	const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
		}
	}
	const out: Hunk[] = [];
	let open: Hunk | null = null;
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			open = null;
			i++;
			j++;
			continue;
		}
		if (!open) out.push((open = { live: [], preview: [] }));
		if (j >= b.length || (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) open.live.push(a[i++]!);
		else open.preview.push(b[j++]!);
	}
	return out;
}

interface KnownDifference extends Hunk {
	/** Each card that owns part of this hunk, and what its part is. */
	owners: Record<string, string>;
}

const call = (name: string) => `assistant toolUse [call ${name}]`;
const ok = (name: string) => `toolResult ${name} ok`;

/**
 * Captured on `codex-cli 0.157.1`, on 2026-09-30; see each `.meta.json`, and
 * `docs/MANUAL_TESTING.md`, "Codex fixtures that keep their rollout
 * (OW-zadupu)". An entry keyed `unfiled` has no card yet.
 */
const KNOWN_DIFFERENCES: Record<string, KnownDifference[]> = {
	plan: [],
	interrupt: [
		{
			owners: {
				"OW-yobuyi":
					"live, the reply cut off by `turn/interrupt` stays `pending`, though `turn/completed` says `interrupted`; " +
					"stored, Codex keeps no partial reply, and the `<turn_aborted>` notice it writes instead previews as a user turn",
			},
			live: ["assistant pending [text]"],
			preview: ["user"],
		},
	],
	"collab-failed": [
		{
			owners: {
				"OW-zabiko":
					"the first `exec` script only searched the tool list and called no tool; live has no item for it, the preview draws it",
				"OW-kelise":
					"the failed `wait` is `subagent` live and an `exec` script calling `tools.multi_agent_v1__wait_agent` on disk",
				unfiled: "the preview sets `isError: false` on every tool result, so the failed call reads as a success",
			},
			live: [call("subagent"), "toolResult subagent error"],
			preview: [call("exec"), ok("exec"), call("exec"), ok("exec")],
		},
	],
	"collab-multi": [
		{
			owners: {
				"OW-zabiko": "the tool-list search script again, with no live item",
				"OW-kelise":
					"both spawns are one `exec` script on disk, calling `tools.multi_agent_v1__spawn_agent` twice, and two `subagent` pairs live",
			},
			live: [call("subagent"), ok("subagent"), call("subagent"), ok("subagent")],
			preview: [call("exec"), ok("exec"), call("exec"), ok("exec")],
		},
		{
			owners: {
				unfiled:
					"each child's completion is a `<subagent_notification>` user-role message on disk, which " +
					"`SYNTHETIC_USER_PREFIXES` does not list, so the preview draws two user turns nobody typed",
				"OW-kelise": "the `wait` naming both children is `subagent` live and an `exec` script on disk",
			},
			live: [call("subagent"), ok("subagent")],
			preview: ["user", "user", call("exec"), ok("exec")],
		},
	],
	"long-shell": [
		{
			owners: {
				"OW-zabiko":
					"the run outlasted its `exec_command` yield and was polled with `tools.write_stdin`; live that is the one " +
					"`commandExecution`, on disk a second `exec` script the preview draws as its own pair",
			},
			live: [],
			preview: [call("exec"), ok("exec")],
		},
	],
	"multi-patch": [
		{
			owners: {
				"OW-zabiko":
					"the patch is a `fileChange` live, drawn as `edit`, and an `exec` script calling `tools.apply_patch` on disk",
			},
			live: [call("edit"), ok("edit")],
			preview: [call("exec"), ok("exec")],
		},
	],
	"compact-rollout": [],
};

describe("live and preview agree on a Codex run, but for the known differences", () => {
	for (const [scenario, known] of Object.entries(KNOWN_DIFFERENCES)) {
		it(scenario, async () => {
			const name = scenario as FixtureName;
			const differences = hunks(live(name), await preview(name));
			expect(differences).toEqual(known.map(({ live, preview }) => ({ live, preview })));
		});
	}
});
