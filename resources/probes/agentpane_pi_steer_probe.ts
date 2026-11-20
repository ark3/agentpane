/**
 * Where does a prompt sent mid-turn land on Pi? (OW-yuyofu)
 *
 * `docs/DESIGN.md` D16 says a prompt submitted while a turn is running joins
 * *that* turn, and that an adapter whose backend cannot do that rejects rather
 * than silently downgrading to a follow-up. Claude Code's rejection and Codex's
 * steer were both settled live; Pi's half rested on `submit()` in
 * `src/server/adapters/pi/process.ts` setting `streamingBehavior: "steer"` when
 * `this.state.isStreaming`, plus Pi's own `rpc.md` (which lives on the work
 * laptop -- see `docs/ENVIRONMENT.md`, "Reference material"), and on nothing
 * anyone ran. A mid-turn prompt being admitted was separately observed, as a
 * 202 when prompts were HTTP posts, but an admitted prompt can mean three
 * things: one that steers into the running turn, one that queues for a
 * following turn, and one that drops the text are three different products
 * behind one reply.
 *
 * This drives the real chain -- `direnv exec <workspace> sbox -- pi --mode rpc`,
 * spawned by agentpane's own built server, through the socket's ordinary
 * `sessions/prompt` (D31) addressed by the session's handle -- because the
 * adapter's `submit()` path is the subject and only exists there. Copied from
 * `agentpane_pi_smoke.py` (spawn/build/attach/event stream/shutdown) rather
 * than added to it, and ported with it to Bun and the socket by
 * ark3/agentpane#54; the measurement's shape comes from `codex_turn_probe.py`'s
 * steer phase.
 *
 * ## Why it taps Pi's stdout
 *
 * The discriminating evidence is Pi's own turn bookkeeping, and none of it
 * reaches agentpane's wire: `src/server/adapters/pi/reducer.ts` maps
 * `agent_start`/`agent_settled` to `isStreaming` and drops `turn_start`,
 * `turn_end`, `agent_end` and `queue_update` on the floor -- the first two as
 * redundant with the `message_*` pair, `agent_end` by falling through to
 * `default`, and `queue_update` as "session bookkeeping outside the
 * AgentMessage/isStreaming contract". `agent_settled` on its own cannot settle
 * the question either, because that same docblock records that an `agent_end`
 * may be followed by *queued continuations* -- so a follow-up queue could
 * drain without any `agent_settled` in between and look identical on the
 * socket.
 *
 * So the probe puts a `pi` shim first on the server's PATH that pipes the real
 * binary's stdout through `tee`. Stdin, stdout and stderr pass through
 * untouched and the tap file is a verbatim copy of every line Pi wrote.
 * `queue_update` is the load-bearing one: Pi names the queue it put the text
 * in, `steering` or `followUp`.
 *
 * The one thing the shim does *not* pass through is Pi's exit status: `sh`
 * reports a pipeline's last stage, so the server sees `tee`'s status and never
 * Pi's. That costs this probe nothing -- it decides on positive evidence in the
 * tap and never reads the agent's exit code -- but a probe copied from this one
 * that wants to assert on how Pi exited has to take the status out of the
 * pipeline first.
 *
 * The tap preserves **order**, not time -- `tee` stamps nothing. Every duration
 * in the record is measured on the probe's side of the wire, from a stamp taken
 * immediately before the request that caused the event, which is the hazard
 * OW-hahohi recorded: an event's arrival stamp minus another arrival stamp once
 * came out negative, because the first event was already buffered before the
 * wait began. Positions in the tap are pinned the same way -- the tap's line
 * count is read at the instant the mid-turn prompt goes out, and the census
 * below that cut is the one that decides the verdict.
 *
 * ## The tool turn (`--turn tool`, OW-nufitu)
 *
 * The text turn above never calls a tool, so it says nothing about the case
 * Pi's own `rpc-commands.md` describes `"steer"` by: the text "is delivered
 * after the current assistant turn finishes executing its tool calls, before
 * the next LLM call" (`pi 0.87.1`'s copy). `--turn tool` replaces the essay
 * with a prompt asking for three `bash` calls in one response, each a `sleep`
 * of a different length, and sends the marker while that batch is executing.
 * The wait is read off the tap, not the socket, because agentpane's events
 * cannot show a tool call execute: the prompt goes out once the newest
 * assistant message carrying tool calls has at least one call with a
 * `tool_execution_start` and no `tool_execution_end` -- and, if the batch holds
 * more than one call, at least one already ended, so that "between two calls"
 * and "after the whole batch" are different positions in the tap. The tap read
 * that satisfies the condition is the one whose length becomes the cut.
 *
 * `toolPlacement` then reports where the steered `user` message landed against
 * each call's `tool_execution_start`/`tool_execution_end` and `toolResult`
 * message and the batch's `turn_end`, by tap index. That a call was
 * demonstrably still executing when the steer was queued is read from Pi's own
 * ordering -- the `queue_update` naming the marker sits before that call's
 * `tool_execution_end` -- and a run that cannot show it has not measured the
 * case and fails. Where the steer landed is recorded, not asserted.
 *
 * ## The model flag
 *
 * `AGENTS.md` pins the home server's Pi to one model and says the flag is the
 * whole of the constraint, because `~/.pi/agent/settings.json` is mutable and
 * was for one day unreadable. This probe passes it explicitly, as the Pi smoke
 * has since OW-yehisa, through `sessions/create`'s `model` field, which reaches
 * `buildPiSpawnCommand`'s `--model`: the long first turn's length is a
 * criterion here, so a run that silently answered on a different model would
 * not be measuring what it reports. The model that actually answered is read
 * back off the wire regardless, and it is the wire string -- carrying a
 * provider prefix the settings file's string does not -- that the write-up
 * names.
 *
 * This makes real model calls. It never invokes Codex or Claude, copies Pi
 * credentials by name without reading them, and scopes process inspection to
 * the server it started.
 *
 * Usage:  bun resources/probes/agentpane_pi_steer_probe.ts [--app-root DIR] [--workspace DIR]
 *           [--port N] [--model REF] [--credential-source DIR] [--skip-build] [--turn text|tool]
 * Prints the evidence as JSON; exits 0 on pass, 1 on fail.
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
	AgentpaneSocket,
	type Evidence,
	type ProcessRow,
	REPO,
	type Server,
	type Stamped,
	TimeoutError,
	assistantText,
	buildClient,
	cliVersion,
	compactTree,
	describeError,
	descendants,
	finalize,
	lastStreaming,
	logTail,
	makeStateHome,
	maxAssistantLength,
	now,
	refsUnder,
	sleep,
	startServer,
	streamingValue,
	tempLogPath,
	waitForBuiltClient,
} from "./agentpane_live_support.ts";
import { PINNED_MODEL, PI_STATE_FILES, piWorkers } from "./agentpane_pi_smoke.ts";

const PORT = 44176;

// A turn has to still be running when the second prompt lands or the run
// measures nothing. "Integers 1 through 10000" is the known trap: OW-hahohi
// measured that the model declines it and explains itself in under 500
// characters. An essay it has opinions about is complied with; the floors below
// are asserted from the evidence rather than assumed.
const LONG_PROMPT =
	"Do not use tools. Write a detailed guide to growing vegetables in a home garden. " +
	"Cover each of these in its own titled section, and write at least 120 words in each " +
	"section: soil preparation, watering, sunlight and siting, pest control, composting, " +
	"crop rotation, harvesting, and planning across the seasons. Write the sections in that " +
	"order and do not summarise at the end.";
const MIN_CHARS_BEFORE_STEER = 1200;
const MIN_UPSERTS_BEFORE_STEER = 25;

// Staggered so that the batch has a call that has ended while others are still
// running, and long enough that the prompt lands well inside the second sleep.
// Pi 0.87.1 runs a batch's calls in parallel by default (`toolExecution`
// defaults to "parallel" in pi-agent-core), so these overlap rather than queue.
const TOOL_PROMPT =
	"Use the bash tool. In one single response, issue exactly three bash tool calls together, " +
	"not one after another, with exactly these commands: `sleep 4; echo first`, " +
	"`sleep 15; echo second`, `sleep 25; echo third`. After all three have returned, reply with " +
	"one short sentence listing their outputs.";

/** One structural event of the tap, as `timeline` keeps it. */
type Row = Record<string, any>;

/**
 * This run's agent-side processes inside the sandbox.
 *
 * `piWorkers` in `agentpane_pi_smoke.ts` explains why the match is on the
 * program and not on argv: Pi sets `process.title`, so its own
 * `/proc/<pid>/cmdline` is bare `pi` and the `bwrap` wrappers are the only
 * processes still carrying `--mode rpc`. The `tee` of the stdout tap and the
 * `sh` running the shim's pipeline are this probe's own additions to that tree
 * and have to be reaped with it, or a "no orphans" result would be reading a
 * smaller tree than the run created.
 */
function steerWorkers(rows: ProcessRow[]): ProcessRow[] {
	return rows.filter(
		(row) => piWorkers([row]).length > 0 || row.comm === "tee" || (row.comm === "sh" && row.cmd.includes("--mode rpc")),
	);
}

/**
 * A `pi` that is the real `pi` with its stdout copied to a tap file in the
 * same directory; the directory and the tap's path.
 *
 * Lives under /tmp because that is mounted read-write inside sbox on the home
 * server, and is found because the server's PATH names it first. `exec` in the
 * first stage of a pipeline still forks a shell to wait on the pipeline, so
 * the sandbox tree gains an `sh` and a `tee` alongside the agent;
 * `steerWorkers` above accounts for both.
 */
function makeShim(realPi: string): { shimDir: string; tap: string } {
	const shimDir = mkdtempSync(join("/tmp", "agentpane-pi-tap-"));
	const tap = join(shimDir, "stdout.jsonl");
	const script = join(shimDir, "pi");
	writeFileSync(script, `#!/bin/sh\nexec "${realPi}" "$@" | tee -a "${tap}"\n`);
	chmodSync(script, 0o755);
	return { shimDir, tap };
}

/** Every line Pi has written to stdout so far, parsed where it is JSON. */
function tapEvents(tap: string): unknown[] {
	if (!existsSync(tap)) return [];
	const out: unknown[] = [];
	for (const raw of readFileSync(tap, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			out.push({ type: "<unparsed>", raw: line.slice(0, 200) });
		}
	}
	return out;
}

function isObject(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text of a Pi `AgentMessage`, whose `content` is a string or block list. */
function messageText(message: unknown): string {
	if (!isObject(message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => isObject(block) && block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

/**
 * The structural events, in order, with the deltas counted rather than kept.
 *
 * `message_update` is thousands of lines of text deltas and says nothing about
 * turn structure; everything else is retained, because "which events did Pi
 * emit between the steer and its answer" is exactly the question and a
 * filtered list would be the probe answering it in advance.
 */
function timeline(events: unknown[], marker: string): Row[] {
	const rows: Row[] = [];
	events.forEach((event, index) => {
		if (!isObject(event)) return;
		const kind = event.type;
		if (kind === "message_update") return;
		const row: Row = { i: index, type: kind };
		if (kind === "queue_update") {
			row.steering = event.steering;
			row.followUp = event.followUp;
		} else if (kind === "message_start" || kind === "message_end") {
			const message = event.message ?? {};
			const text = messageText(message);
			row.role = isObject(message) ? message.role : null;
			row.chars = text.length;
			row.has_marker = text.includes(marker);
			if (row.role === "toolResult") {
				row.toolCallId = message.toolCallId;
			} else if (row.role === "assistant" && Array.isArray(message.content)) {
				const calls = message.content.filter((block: unknown) => isObject(block) && block.type === "toolCall").map((block: Row) => block.id);
				if (calls.length) row.toolCallIds = calls;
			}
		} else if (kind === "tool_execution_start" || kind === "tool_execution_end") {
			row.toolCallId = event.toolCallId;
			row.toolName = event.toolName;
			if (kind === "tool_execution_start") {
				row.args = event.args;
			} else {
				row.isError = event.isError;
				row.result_text = messageText(event.result).slice(0, 200);
			}
		} else if (kind === "turn_end") {
			const message = event.message ?? {};
			const text = messageText(message);
			row.role = isObject(message) ? message.role : null;
			row.chars = text.length;
			row.has_marker = text.includes(marker);
		} else if (kind === "response") {
			row.command = event.command;
			row.success = event.success;
		} else if (kind === "agent_end") {
			row.willRetry = event.willRetry;
		}
		rows.push(row);
	});
	return rows;
}

function census(events: unknown[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const event of events) {
		const kind = String(isObject(event) ? event.type : "<non-object>");
		counts[kind] = (counts[kind] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function queueNames(row: Row, queue: "steering" | "followUp", marker: string): boolean {
	return (row[queue] ?? []).some((text: unknown) => String(text).includes(marker));
}

/**
 * Which of D16's three the admitted prompt was, read off Pi's own events.
 *
 * `cut` is the tap's line count read immediately before the mid-turn prompt
 * goes out, so everything considered here is strictly later in the tap than
 * that pin. That is a hair earlier than the request itself, which is the safe
 * direction: a stray line from the gap can only add to `agent_settled_between`
 * and push the verdict toward `following_turn` or `indeterminate`, never
 * toward a false steer.
 *
 * Two readings are taken, and they are **not** equals -- only the first tells
 * steer from follow-up:
 *
 * - **Which queue Pi put it in.** `queue_update` carries `steering` and
 *   `followUp` arrays. Pi naming the queue is the whole discriminator: it is
 *   the only thing here that a follow-up would answer differently, which is
 *   why a run that does not produce one is `indeterminate` rather than a pass
 *   on the other reading.
 * - **Whether the session left the turn in between.** The boundary is
 *   `agent_settled`, because that is the one Pi event agentpane turns into a
 *   turn boundary: `reducer.ts` maps `agent_settled`, and only
 *   `agent_settled`, to `isStreaming: false`, which is the session going idle
 *   on the wire and the turn ending as D16, the wire contract and the user all
 *   mean it. An answer with no `agent_settled` before it was answered without
 *   the session ever leaving the turn the prompt was sent into.
 *   This does **not** discriminate: the reducer's docblock records that an
 *   `agent_end` can be followed by queued continuations, so a `followUp` queue
 *   draining inside the same span would read identically. It is a necessary
 *   condition for D16 and not a sufficient one, and it is recorded as such.
 *
 * Deliberately *not* `agent_end`, and not Pi's own `turn_start`/`turn_end`,
 * both of which are finer than an agentpane turn and neither of which
 * survives as a discriminator:
 *
 * - `turn_start`/`turn_end` bound one LLM round. A steered message is drained
 *   into a round of its own, so even the cleanest steer shows two of them --
 *   the "same turn id throughout" reading that settled Codex under OW-tifuha
 *   has no Pi equivalent, and could not have one: `protocol.ts` types
 *   `turn_start` as `{ type: "turn_start" }`, carrying no id at all.
 *   This is not a boundary chosen after seeing which one gave the wanted
 *   answer. `resources/fixtures/pi/tool-read.jsonl` and `tool-edit.jsonl`,
 *   captured long before this probe existed, each hold **two**
 *   `turn_start`/`turn_end` pairs inside a single
 *   `agent_start`...`agent_settled` span, against one pair in `text.jsonl` --
 *   so an agentpane turn already demonstrably spanned several of Pi's, with
 *   no steer involved.
 * - `agent_end` is the inner agent loop ending, and the reducer's own docblock
 *   says it "can be followed by retry/compaction/queued continuations" -- so
 *   it is not the turn ending. Measured on `pi 0.85.1`, whether one falls
 *   between the request and the answer is a **race** and came out both ways
 *   across two runs minutes apart: when the first reply was still generating
 *   as the steer was drained there was none, and when it had just finished
 *   Pi closed the loop and opened a fresh `agent_start` to drain the same
 *   `steering` queue. Neither run went through `agent_settled`. `agent_end`
 *   is therefore recorded here as `agent_end_between`, for the reader, and
 *   decides nothing.
 *
 * Returns `verdict: "indeterminate"` when the two disagree or when the queue
 * reading -- the only discriminating one -- never fires: a verdict this probe
 * treats as a failed run, because a reader who cannot tell the three apart
 * from the record is exactly what the card forbids.
 */
function classify(rows: Row[], cut: number, marker: string): Row {
	const after = rows.filter((row) => row.i >= cut);

	let queuedAs: "steering" | "followUp" | null = null;
	let queueRow: Row | null = null;
	for (const row of after) {
		if (row.type !== "queue_update") continue;
		const inSteering = queueNames(row, "steering", marker);
		const inFollowUp = queueNames(row, "followUp", marker);
		if (inSteering || inFollowUp) {
			queuedAs = inSteering ? "steering" : "followUp";
			queueRow = row;
			break;
		}
	}

	const answer = after.find((row) => row.type === "message_end" && row.role === "assistant" && row.has_marker);
	if (!answer) {
		return { verdict: "dropped", queued_as: queuedAs, queue_update: queueRow, answer: null, agent_end_between: null, agent_settled_between: null };
	}

	const between = after.filter((row) => row.i < answer.i);
	const agentEnds = between.filter((row) => row.type === "agent_end").length;
	const agentSettled = between.filter((row) => row.type === "agent_settled").length;

	const byBoundary = agentSettled === 0 ? "steered_into_running_turn" : "following_turn";
	const byQueue = queuedAs === null ? null : queuedAs === "steering" ? "steered_into_running_turn" : "following_turn";
	// `byQueue === null` is not a pass on `byBoundary` alone: that reading
	// cannot tell a steer from a drained follow-up, so with nothing to agree
	// with it the run has not answered the question.
	const verdict = byQueue === byBoundary ? byBoundary : "indeterminate";

	return {
		verdict,
		by_turn_boundary: byBoundary,
		by_queue: byQueue,
		queued_as: queuedAs,
		queue_update: queueRow,
		answer,
		agent_end_between: agentEnds,
		agent_settled_between: agentSettled,
		events_between: between,
	};
}

interface Call {
	toolCallId: string;
	start?: number;
	end?: number;
	toolResult?: number;
	toolName?: unknown;
	args?: unknown;
	isError?: unknown;
	result_text?: unknown;
}

interface BatchState {
	assistant_message_end: number;
	calls: Call[];
	executing: string[];
	ended: string[];
}

/**
 * A tool batch in the tap, and how far through executing it is.
 *
 * A batch is the tool calls of one assistant `message_end`; Pi executes them
 * after that message ends and before the round's `turn_end`. `at` names that
 * `message_end` by tap index; without it, the newest batch is read.
 */
function batchState(rows: Row[], at?: number): BatchState | undefined {
	let batch: Row | undefined;
	for (const row of rows) {
		if (row.type === "message_end" && row.role === "assistant" && row.toolCallIds && (at === undefined || row.i === at)) batch = row;
	}
	if (!batch) return undefined;
	const calls = new Map<string, Call>(batch.toolCallIds.map((id: string) => [id, { toolCallId: id }]));
	for (const row of rows) {
		const call = row.i > batch.i ? calls.get(row.toolCallId) : undefined;
		if (!call) continue;
		if (row.type === "tool_execution_start") {
			call.start = row.i;
			call.toolName = row.toolName;
			call.args = row.args;
		} else if (row.type === "tool_execution_end") {
			call.end = row.i;
			call.isError = row.isError;
			call.result_text = row.result_text;
		} else if (row.type === "message_end" && row.role === "toolResult") {
			call.toolResult = row.i;
		}
	}
	const ordered = batch.toolCallIds.map((id: string) => calls.get(id)!) as Call[];
	return {
		assistant_message_end: batch.i,
		calls: ordered,
		executing: ordered.filter((call) => call.start !== undefined && call.end === undefined).map((call) => call.toolCallId),
		ended: ordered.filter((call) => call.end !== undefined).map((call) => call.toolCallId),
	};
}

/** A call is executing, and -- in a batch of several -- another has ended. */
function readyToSteer(state: BatchState | undefined): boolean {
	if (!state || !state.executing.length) return false;
	return state.calls.length === 1 || state.ended.length > 0;
}

/**
 * Where the steered text landed against the batch that was executing.
 *
 * Every position is a tap index. `user_message_start` is the `message_start`
 * of the `user` message carrying the marker -- the point at which Pi drained
 * its steering queue into the conversation. It is compared against the
 * batch's `tool_execution_end`s, its `toolResult` messages and the round's
 * `turn_end`, which are the three places Pi could have put it after the
 * prompt: between calls, between results, or after the whole batch.
 *
 * `executing_at_queue` names the calls whose `tool_execution_end` comes after
 * the `queue_update` that put the marker on a queue: Pi's own ordering, and
 * not the probe's clock, showing those calls still running when Pi accepted
 * the steer.
 */
function toolPlacement(rows: Row[], cut: number, marker: string, batchAtCut: BatchState): Row {
	// The batch that was executing at the cut, re-read to completion.
	const state = batchState(rows, batchAtCut.assistant_message_end)!;
	const after = rows.filter((row) => row.i >= cut);
	const queueRow = after.find((row) => row.type === "queue_update" && (queueNames(row, "steering", marker) || queueNames(row, "followUp", marker)));
	const userRow = after.find((row) => row.type === "message_start" && row.role === "user" && row.has_marker);
	const batchTurnEnd = rows.find((row) => row.i > state.assistant_message_end && row.type === "turn_end")?.i as number | undefined;
	const ends = state.calls.flatMap((call) => (call.end === undefined ? [] : [call.end]));
	const results = state.calls.flatMap((call) => (call.toolResult === undefined ? [] : [call.toolResult]));
	const complete = ends.length === state.calls.length && results.length === state.calls.length;

	let placement: string | null = null;
	if (userRow && complete && batchTurnEnd !== undefined) {
		const u = userRow.i;
		if (u < Math.max(...ends)) placement = "between_calls_before_batch_finished";
		else if (u < Math.max(...results)) placement = "after_executions_between_tool_results";
		else if (u < batchTurnEnd) placement = "after_tool_results_before_turn_end";
		else placement = "after_batch_turn_end";
	}

	const executingAtQueue = queueRow ? state.calls.filter((call) => (call.end ?? -1) > queueRow.i).map((call) => call.toolCallId) : [];

	// What Pi did next, so the reader can see the round the steer opened.
	const following = userRow
		? rows
				.filter((row) => row.i > userRow.i && ["turn_start", "turn_end", "message_end", "agent_end", "agent_settled"].includes(row.type))
				.slice(0, 8)
		: null;

	return {
		placement,
		batch_complete: complete,
		batch: state,
		batch_turn_end: batchTurnEnd ?? null,
		queue_update: queueRow?.i ?? null,
		user_message_start: userRow?.i ?? null,
		executing_at_queue: executingAtQueue,
		events_after_user_message: following,
	};
}

/**
 * Poll the tap until `predicate(rows)` is truthy; it and that read's length.
 *
 * The length returned is the cut: the condition and the pin come from the
 * same read of the file, so the prompt sent after it is strictly later than
 * every line the condition saw.
 */
async function waitForTap<T>(tap: string, marker: string, predicate: (rows: Row[]) => T | undefined, timeoutSeconds: number, label: string): Promise<[T, number]> {
	const deadline = performance.now() + timeoutSeconds * 1000;
	while (performance.now() < deadline) {
		const raw = tapEvents(tap);
		const found = predicate(timeline(raw, marker));
		if (found) return [found, raw.length];
		await sleep(0.05);
	}
	throw new TimeoutError(`timed out waiting for ${label}`);
}

function processEvidence(serverPid: number) {
	const tree = descendants(serverPid);
	return { tree: compactTree(tree), workers: steerWorkers(tree) };
}

function parseArguments() {
	return parseArgs({
		options: {
			"app-root": { type: "string", default: REPO },
			workspace: { type: "string" },
			port: { type: "string", default: String(PORT) },
			// Passed to Pi's --model; the default is the model AGENTS.md pins.
			model: { type: "string", default: PINNED_MODEL },
			// Pi's auth and model state; contents are never printed.
			"credential-source": { type: "string", default: join(homedir(), ".pi", "agent") },
			// Reuse an existing dist/client bundle.
			"skip-build": { type: "boolean", default: false },
			// Steer into a long text turn (OW-yuyofu, the default) or into an
			// executing tool batch (OW-nufitu).
			turn: { type: "string", default: "text" },
		},
	}).values;
}

async function main(): Promise<number> {
	const args = parseArguments();
	if (args.turn !== "text" && args.turn !== "tool") {
		console.error(`--turn must be text or tool, not ${args.turn}`);
		return 2;
	}
	const turn = args.turn;
	const repo = resolve(args["app-root"]!);
	const workspace = resolve(args.workspace ?? repo);
	const port = Number(args.port);
	const model = args.model!;
	const marker = `AGENTPANE-STEER-${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;

	const found = Bun.which("pi");
	if (!found) {
		console.error("pi is not on PATH");
		return 1;
	}
	const realPi = realpathSync(found);
	const { shimDir, tap } = makeShim(realPi);

	const { home: stateHome, copied } = makeStateHome(resolve(args["credential-source"]!), PI_STATE_FILES, "agentpane-steer-pihome-");
	const serverLog = tempLogPath("agentpane-steer-server-");
	let server: Server | undefined;
	const sockets: AgentpaneSocket[] = [];
	const launchedWorkers = new Set<number>();
	const checks: Record<string, Record<string, unknown>> = {};
	const evidence: Evidence = {
		started_at: now(),
		backend: "pi",
		probe: "agentpane_pi_steer_probe.ts",
		card: turn === "text" ? "OW-yuyofu" : "OW-nufitu",
		turn,
		workspace,
		commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim(),
		pi_version: cliVersion(realPi),
		model_flag: model,
		marker,
		temporary_state_home: stateHome,
		copied_credential_files: copied,
		checks,
	};
	let exitCode = 1;
	try {
		if (!copied.includes("auth.json")) throw new Error(`missing Pi credentials under ${args["credential-source"]}`);
		if (!args["skip-build"]) evidence.build = buildClient(repo);

		server = startServer(
			repo,
			{ ...process.env, PATH: `${shimDir}:${process.env.PATH}`, PI_CODING_AGENT_DIR: stateHome, PORT: String(port) },
			serverLog,
		);
		evidence.server_pid = server.pid;
		await waitForBuiltClient(port, server, 20);

		const socket = await AgentpaneSocket.open(port);
		sockets.push(socket);

		const create = await socket.request("sessions/create", { cwd: workspace, backend: "pi", model }, 120);
		if (!create.ok) throw new Error(`create failed: ${create.code} ${create.detail}`);
		// The create starts the session and answers as an attach does (D30).
		// D9: Pi's id is its JSONL path, adopted at the start or on the first
		// prompt, so the ref moves under this probe. Every reading and every
		// command below is keyed by the handle instead, which a rename never
		// changes (D24, D31 point 9); the create's ref is kept only to say when
		// the move came.
		const createdRef = create.result.session.ref;
		const handle = create.result.session.handle;
		if (typeof handle !== "string" || !handle) throw new Error(`the create answered no handle: ${JSON.stringify(create.result.session)}`);

		const { tree, workers } = processEvidence(server.pid);
		for (const row of workers) launchedWorkers.add(row.pid);
		const chain = tree.map((row) => row.comm);
		if (!chain.includes("bwrap")) throw new Error(`Pi was not spawned through the sandbox chain: ${chain}`);
		checks.startup = { result: "pass", create_reply: "ok", process_chain: chain, process_tree: tree };

		// -- 1. a turn to steer into -------------------------------------
		const longStart = socket.events.length;
		const longRequestedAt = now();
		const long = await socket.request("sessions/prompt", { handle, text: turn === "text" ? LONG_PROMPT : TOOL_PROMPT });
		if (!long.ok) throw new Error(`first prompt failed: ${long.code} ${long.detail}`);

		let batchAtCut: BatchState | undefined;
		let toolCut = 0;
		if (turn === "text") {
			// The floor is asserted, not assumed: a model that declined the prompt
			// never reaches it and this times out rather than steering into a turn
			// that had already finished.
			const reached = await socket.waitFor(
				(events) => {
					let upserts = 0;
					let longest = 0;
					for (const [, event] of events.slice(longStart)) {
						if (event.handle !== handle || event.type !== "upsert") continue;
						upserts++;
						longest = Math.max(longest, assistantText(event.message ?? {}).length);
					}
					return upserts >= MIN_UPSERTS_BEFORE_STEER && longest >= MIN_CHARS_BEFORE_STEER ? { upserts, assistant_chars: longest } : undefined;
				},
				180,
				`the first turn to stream at least ${MIN_CHARS_BEFORE_STEER} assistant characters`,
			);
			checks.long_turn = {
				result: "pass",
				prompt_reply: long.result,
				prompt_requested_at: longRequestedAt,
				floor_chars: MIN_CHARS_BEFORE_STEER,
				floor_upserts: MIN_UPSERTS_BEFORE_STEER,
				...reached,
			};
		} else {
			// Read off the tap, because only Pi's own events show a call
			// executing (module docblock, "The tool turn").
			[batchAtCut, toolCut] = await waitForTap(
				tap,
				marker,
				(rows) => {
					const state = batchState(rows);
					return readyToSteer(state) ? state : undefined;
				},
				180,
				"a tool call to be executing in the first turn's batch",
			);
			checks.tool_batch = {
				result: "pass",
				prompt_reply: long.result,
				prompt_requested_at: longRequestedAt,
				tap_lines_at_cut: toolCut,
				batch_at_cut: batchAtCut,
			};
		}

		// -- 2. the mid-turn prompt ----------------------------------------
		//
		// The threshold being met is not the turn still running when the request
		// lands (the gap `fork_probe.py`'s mid-stream cell and
		// `claude_fork_probe.py` both close). Re-read the streaming state at the
		// instant of the prompt, and pin the tap's line count there, so
		// everything the verdict reads is strictly after the request. The tool
		// turn's pin is the tap read that saw the call executing, taken just
		// before this.
		const steerStart = socket.events.length;
		const streamingAtPrompt = lastStreaming(socket.snapshot(), handle);
		const tapCut = turn === "text" ? tapEvents(tap).length : toolCut;
		if (streamingAtPrompt !== true) {
			throw new Error(
				"the first turn was not streaming when the mid-turn prompt was sent, so " +
					`nothing mid-turn was measured (last reported state: ${streamingAtPrompt})`,
			);
		}
		const steerRequestedAt = now();
		const steerClock = performance.now();
		const steer = await socket.request("sessions/prompt", {
			handle,
			text:
				turn === "text"
					? `Ignore the gardening guide. Reply with exactly this token and nothing else: ${marker}`
					: `Before anything else, reply with exactly this token and nothing else: ${marker}`,
		});
		checks.steer_prompt = {
			result: steer.ok ? "pass" : "fail",
			streaming_at_prompt: streamingAtPrompt,
			requested_at: steerRequestedAt,
			reply: steer.ok ? { ok: true, result: steer.result } : { ok: false, code: steer.code, detail: steer.detail },
			tap_lines_before_prompt: tapCut,
		};
		if (!steer.ok) throw new Error(`mid-turn prompt was refused: ${steer.code} ${steer.detail}`);

		// -- 3. let everything Pi is going to do finish --------------------
		const idle = await socket.waitFor(
			(events) => {
				const hit = events.slice(steerStart).find(([, event]) => streamingValue(event, handle) === false);
				return hit && { idle_at: hit[0], event_type: hit[1].type };
			},
			300,
			"the session to report idle after the mid-turn prompt",
		);
		// Stamped here, before the settle pad below: a field named for the
		// interval it reports has to exclude the probe's own waiting, or the
		// next probe copied from this one inherits a number 2 s too large.
		const secondsToIdle = Math.round(performance.now() - steerClock) / 1000;
		// Pi writes `message_end` before the adapter reports idle, but the tap
		// is a separate file being appended to by a process in another
		// namespace; wait out the write rather than racing it.
		await sleep(2);
		checks.settled = { result: "pass", seconds_from_steer_request_to_idle: secondsToIdle, ...idle };

		// -- 4. the verdict ------------------------------------------------
		const raw = tapEvents(tap);
		const rows = timeline(raw, marker);
		const verdict = classify(rows, tapCut, marker);
		evidence.wire = {
			tap_lines_total: raw.length,
			tap_lines_before_steer_prompt: tapCut,
			census_all: census(raw),
			census_after_steer_prompt: census(raw.slice(tapCut)),
			timeline: rows,
		};
		// Recorded before the verdict can raise, so a failed run still says
		// where the text went.
		if (batchAtCut) {
			const placement = toolPlacement(rows, tapCut, marker, batchAtCut);
			// Where it landed is the measurement and passes whatever it is; a
			// run whose steer cannot be shown to have arrived while a call was
			// executing, or whose batch never finished, measured nothing.
			const measured = placement.executing_at_queue.length > 0 && placement.placement !== null;
			checks.tool_placement = { result: measured ? "pass" : "fail", ...placement };
		}
		// Only a steer is a pass. `dropped` and `following_turn` are real
		// outcomes this probe exists to be able to report, and each is a
		// divergence from D16 -- a run that found one must stop the probe, or
		// the check can never go red on the answer that matters.
		checks.verdict = { result: verdict.verdict === "steered_into_running_turn" ? "pass" : "fail", ...verdict };
		if (verdict.verdict === "indeterminate") {
			throw new Error(
				"Pi's events do not tell the three outcomes apart: " +
					`queue said ${verdict.by_queue}, turn boundaries said ${verdict.by_turn_boundary}`,
			);
		}
		if (verdict.verdict !== "steered_into_running_turn") {
			throw new Error(
				`a prompt sent mid-turn was ${verdict.verdict} rather than steered into the running turn, ` +
					`which D16 does not allow of the Pi adapter (queued as ${JSON.stringify(verdict.queued_as)})`,
			);
		}
		if (batchAtCut && checks.tool_placement!.result !== "pass") {
			throw new Error(
				"the steer was not shown to arrive while a tool call was executing, or the batch " +
					"never finished, so where it landed in the batch was not measured",
			);
		}

		const modelSeen = socket
			.snapshot()
			.reverse()
			.find(([, event]) => event.handle === handle && (event.type === "snapshot" || event.type === "status") && typeof event.model === "string" && event.model);
		if (!modelSeen) throw new Error("no snapshot or status event named the model Pi resolved");
		checks.model = { result: "pass", flag_passed: model, at: modelSeen[0], model: modelSeen[1].model, event_type: modelSeen[1].type };
		evidence.final_max_assistant_chars = maxAssistantLength(socket.snapshot(), handle);

		// What the session was called, recorded rather than required: a rename
		// at the start and one on the first prompt are both D9's contract.
		const refs = refsUnder(socket.snapshot(), handle);
		const current = refs.at(-1) ?? createdRef;
		evidence.session = {
			handle,
			refs,
			renamed_during: !createdRef.id.startsWith("virtual:") ? "create" : !current.id.startsWith("virtual:") ? "first prompt" : null,
			session_id_is_jsonl_path: current.id.endsWith(".jsonl"),
		};

		evidence.finished_at = now();
		evidence.result = "pass";
		exitCode = 0;
	} catch (error) {
		evidence.finished_at = now();
		evidence.result = "fail";
		evidence.error = describeError(error);
		// The tap is removed below, so a run that died before the verdict would
		// otherwise leave nothing at all about what Pi emitted.
		evidence.wire = { ...((evidence.wire as object | undefined) ?? {}), census_all: census(tapEvents(tap)) };
		evidence.server_log_tail = logTail(serverLog);
		exitCode = 1;
	} finally {
		exitCode = await finalize(evidence, exitCode, { server, sockets, stateHome, serverLog, launchedWorkers, workerFilter: steerWorkers });
		rmSync(shimDir, { recursive: true, force: true });
	}
	console.log(JSON.stringify(evidence, null, 2));
	return exitCode;
}

if (import.meta.main) process.exit(await main());
