/**
 * The live transcript and the preview of one Codex run held against each
 * other, one recorded run at a time (OW-zadupu).
 *
 * An attached session reaches the transcript through `mapItem`
 * (`adapters/codex/mapping.ts`, driven by `CodexReducer`). A preview reads the
 * rollout Codex wrote to disk, and one whose `item_completed` records are a
 * full copy, as every rollout here is, translates them and maps them through
 * `mapItem` as well (`./codex.ts`, OW-luvema). So what this holds is the
 * translation and the reducer's handling around `mapItem`; the preview's
 * fallback, `extractStoreTurn`, is not reached. Each scenario below is one
 * capture by `resources/probes/capture_fixtures.py` that kept both halves of
 * the same run: `<scenario>.jsonl`, the app-server stream, and
 * `<scenario>.rollout.jsonl`, the rollout. The stream is replayed through the
 * reducer, the rollout through the preview, and both are projected onto what a
 * reader would notice: the role sequence, tool names, whether each call has its
 * result and each result its call, `isError`, `stopReason`, and a compaction
 * marker's figure and whether it carries a summary. Timestamps, usage and model
 * identity differ by design and are left out, as is any text but one piece: a
 * user message that opens with a `<tag>` wrapper, such as `<turn_aborted>`,
 * keeps the tag, so a row says which injected message it is and a typed prompt
 * stays bare `user`. A result row names its call by how many calls back it
 * sits, said only when it is not the latest call, so results that answer
 * same-named calls out of order still differ, and a call the other side lacks
 * shifts no later row.
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
	const calls: string[] = [];
	return messages.map((message) => {
		switch (message.role) {
			case "assistant": {
				const blocks = (message.content as { type: string; id: string; name: string }[]).map((block) => {
					if (block.type !== "toolCall") return block.type;
					calls.push(block.id);
					return `call ${block.name}${results.has(block.id) ? "" : " (no result)"}`;
				});
				return `assistant ${message.stopReason} [${blocks.join(", ")}]`;
			}
			case "toolResult": {
				const at = calls.lastIndexOf(message.toolCallId ?? "");
				const back = calls.length - 1 - at;
				const link = at === -1 ? " (no call)" : back > 0 ? ` (call ${back} back)` : "";
				return `toolResult ${message.toolName} ${message.isError ? "error" : "ok"}${link}`;
			}
			case "compactionSummary":
				return `compactionSummary tokensBefore=${message.tokensBefore} summary=${message.summary ? "present" : "empty"}`;
			case "user": {
				const first = (message.content as { type: string; text?: string }[])[0];
				const tag = first?.type === "text" ? /^\s*(<[A-Za-z_][\w-]*>)/.exec(first.text ?? "")?.[1] : undefined;
				return tag ? `user ${tag}` : "user";
			}
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

/**
 * Captured on `codex-cli 0.157.1`, on 2026-09-30; see each `.meta.json`, and
 * `docs/MANUAL_TESTING.md`, "Codex fixtures that keep their rollout
 * (OW-zadupu)".
 */
const KNOWN_DIFFERENCES: Record<string, KnownDifference[]> = {
	plan: [],
	interrupt: [
		{
			owners: {
				"OW-yobuyi":
					"live, the reply cut off by `turn/interrupt` stays `pending`, though `turn/completed` says `interrupted`; " +
					"stored, Codex keeps no partial reply and writes no item for it, so the preview draws nothing there",
			},
			live: ["assistant pending [text]"],
			preview: [],
		},
	],
	"collab-failed": [],
	"collab-multi": [],
	"long-shell": [],
	"multi-patch": [],
	"compact-rollout": [],
};

describe("the projection", () => {
	const call = (id: string): Message => ({
		role: "assistant",
		stopReason: "toolUse",
		content: [{ type: "toolCall", id, name: "bash" }],
	});
	const result = (id: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "bash", isError: false });

	it("tells apart two same-named calls whose results arrive swapped", () => {
		const inOrder = project([call("a"), call("b"), result("a"), result("b")]);
		const swapped = project([call("a"), call("b"), result("b"), result("a")]);
		expect(hunks(inOrder, swapped)).not.toEqual([]);
	});
});

describe("live and preview agree on a Codex run, but for the known differences", () => {
	for (const [scenario, known] of Object.entries(KNOWN_DIFFERENCES)) {
		it(scenario, async () => {
			const name = scenario as FixtureName;
			const differences = hunks(live(name), await preview(name));
			expect(differences).toEqual(known.map(({ live, preview }) => ({ live, preview })));
		});
	}
});
