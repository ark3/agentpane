/**
 * The node contract between agentpane and the native Emacs mode (OW-mutufa).
 *
 * FROZEN INTERFACE, in the sense of DESIGN D11: both ends are ours, the elisp
 * reads this as JSON with no type checker behind it, and this docblock is what
 * the elisp author reads. It names every field, its JSON type, and when it is
 * present; the TypeScript below says the same thing to the compiler. Change
 * the two together, and raise it before changing either.
 *
 * A transcript projects to a JSON array of **nodes**, one per visible
 * transcript entry, in transcript order. The Emacs buffer draws one section
 * per node and replaces a node in place when a streaming turn re-sends it.
 *
 * Node -- an object with these fields:
 *
 * - `index` (integer, always). The position of this entry in the session's
 *   flat message array -- the very number a `snapshot`'s `messages` is indexed
 *   by, an `upsert.index` addresses, and a fork point's `index` names. Tool
 *   results folded into their calls have no node, so consecutive nodes can
 *   skip indices. Replace by `index`, never by array position.
 * - `role` (string, always). One of `"user"`, `"assistant"`, `"tool-result"`
 *   (a result whose call is not in the transcript -- a truncated or forked
 *   slice can start mid-turn), `"compactionSummary"` (the seam the backend
 *   folded its context at), or another backend-defined role the elisp should
 *   draw generically.
 * - `parts` (array, always, possibly empty). The node's content in display
 *   order; each element is one of the parts below, told apart by `type`.
 * - `meta` (object, only on `role: "assistant"`). The turn's footer facts,
 *   present on every assistant node including a streaming one; see below.
 *
 * Parts, by `type`:
 *
 * - `{ type: "text", text }` -- `text` (string) is markdown source, exactly as
 *   the model wrote it. Nothing on this path renders HTML; Emacs fontifies.
 *   A `compactionSummary` node carries its summary as one of these when the
 *   backend supplied any; a role the projection does not know carries the
 *   whole message as JSON text so nothing is silently dropped.
 * - `{ type: "thinking", text, redacted }` -- `text` (string) is the thinking
 *   as streamed, empty when `redacted` (boolean) is true and the provider
 *   withheld it.
 * - `{ type: "tool", name, summary, args, result, state, diff? }` -- one tool
 *   call with its answer folded in. `name` (string) is the backend's own tool
 *   name, casing preserved. `summary` (string) is the one-line description the
 *   browser's tool card shows in its header: the command for a shell, the
 *   basename and line counts for a file tool, the arguments otherwise; may be
 *   empty. `args` (string) is the call's arguments pretty-printed as JSON,
 *   empty when there were none. `result` (string) is the text of the result,
 *   empty when none has arrived; a result's image parts are not carried.
 *   `state` (string) is `"running"` while the turn that owns the call is
 *   still streaming and no result has arrived, `"error"` when the result
 *   reported failure, `"ok"` otherwise -- including a call whose result never
 *   arrived in a finished turn. `diff` (array) is present only for a call
 *   named `edit` or `write` (case-insensitive) and holds the unified diff the
 *   browser draws, as `{ type, text }` lines where `type` is `"add"`, `"del"`,
 *   `"ctx"` (unchanged, kept as context), or `"gap"` (a marker standing in for
 *   a run of unchanged lines; its `text` says how many). A `write` diffs from
 *   the empty file, so every line is an `"add"`. An orphan `tool-result` node
 *   carries one of these parts too, with `args` empty and no `diff`.
 * - `{ type: "image", mimeType, data }` -- an image the user attached.
 *   `mimeType` (string) such as `"image/png"`; `data` (string) is base64.
 *
 * Meta -- the object under an assistant node's `meta`:
 *
 * - `model` (string, always; may be empty when the backend reported none).
 * - `effort` (string, only when the backend reported a reasoning effort;
 *   Codex does, others do not).
 * - `usage` (object, always): `totalTokens` (integer) and `cost` (number, in
 *   dollars); both are `0` when the backend reports no accounting.
 * - `stopReason` (string, only when the turn ended badly): `"error"` or
 *   `"aborted"`. Absent for a turn that finished normally or is still
 *   streaming; a streaming turn is recognised by the projection still
 *   re-sending the node, not by anything in it.
 * - `errorMessage` (string, only when the backend supplied one alongside
 *   `stopReason: "error"`).
 */

export interface TranscriptNode {
	index: number;
	role: string;
	parts: NodePart[];
	meta?: TurnMeta;
}

export type NodePart = TextPart | ThinkingPart | ToolPart | ImagePart;

export interface TextPart {
	type: "text";
	text: string;
}

export interface ThinkingPart {
	type: "thinking";
	text: string;
	redacted: boolean;
}

export interface ToolPart {
	type: "tool";
	name: string;
	summary: string;
	args: string;
	result: string;
	state: "running" | "ok" | "error";
	diff?: NodeDiffLine[];
}

export interface NodeDiffLine {
	type: "add" | "del" | "ctx" | "gap";
	text: string;
}

export interface ImagePart {
	type: "image";
	mimeType: string;
	data: string;
}

export interface TurnMeta {
	model: string;
	effort?: string;
	usage: { totalTokens: number; cost: number };
	stopReason?: "error" | "aborted";
	errorMessage?: string;
}
