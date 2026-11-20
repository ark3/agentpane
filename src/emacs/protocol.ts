/**
 * The node contract between agentpane and the native Emacs mode (OW-mutufa).
 *
 * FROZEN INTERFACE, in the sense of DESIGN D11: both ends are ours, the elisp
 * reads this as JSON with no type checker behind it, and this docblock is what
 * the elisp author reads. It names every field, its JSON type, and when it is
 * present; the TypeScript below says the same thing to the compiler. Change
 * the two together, and raise it before changing either. D24 raised it twice:
 * the `handle` every per-session notification carries, and every request
 * accepts, below (OW-suyinu); and the retirement of `session/renamed`, whose
 * one use no other notification covered -- joining the ref an attach asked
 * for to the handle it was answered under -- `session/snapshot`'s
 * `askedFor` took over (OW-mofuho). OW-gusaru raised it a third time, for
 * `session/snapshot`'s `movedFrom`, and OW-yibijo a fourth, retiring
 * `movedFrom` for `session/detached`. OW-jokoto raised it a fifth, for the
 * `errorId` that names a turn error on `session/error` and
 * `session/snapshot`, and that `sessions/dismissError` and `sessions/prompt`
 * send back. OW-nufafi raised it a sixth, opening the event stream at the
 * first `sessions/list` as well as at the first `sessions/attach`, so
 * `sessions/changed` flows to a picker before anything is attached.
 * OW-mareju raised it a seventh, for `stream/changed`, which says the event
 * stream dropped and came back, where the helper had reopened it silently.
 * OW-filuge raised it an eighth, sending `session/detached` for a session
 * whose `seq` gapped, where the helper had attached it again. OW-mepufi
 * raised it a ninth, retiring `stream/changed`: the helper exits when its
 * event stream drops or its first open fails (D25 point 4), and reopens
 * nothing. OW-rebawa raised it a tenth: the reply to `sessions/attach` no
 * longer says a buffer is attached, only the `session/snapshot` that
 * answers the attach does; the reply goes out after that snapshot, or once
 * none will; and `askedFor` rides every snapshot that answers an attach,
 * one for each, whatever ref it names. OW-letevu raised it an eleventh,
 * retiring the request that answered an agent request, the two
 * notifications that published and retracted one, and `session/snapshot`'s
 * `requests`: agentpane never holds an agent request (D2a), so there is
 * nothing pending to carry or answer, and the refusal reaches Emacs as a
 * `session/error` naming the request's kind. OW-likopo raised it a twelfth,
 * under D26: `session/detached` for a handle the server let go of follows
 * the server's own `ended` under it, where it followed a listing the helper
 * asked at each `sessions/changed`; and `sessions/list` and
 * `sessions/attach` wait for the event stream's open before their own call.
 * OW-kutome raised it a thirteenth, for `session/detached`'s `cause`, which
 * tells the server letting go of the handle from a `seq` gap, since only
 * the first says a turn running under it is over. OW-wukako raised it a
 * fourteenth, correlating an attach by a token rather than by the ref it
 * asked for: `sessions/attach` carries a `token` agentpane-mode mints, the
 * snapshot that answers it carries that `token` where it carried
 * `askedFor`, and `sessions/detach` and `sessions/close` carry one too,
 * giving up that attach alone where they gave up every attach of the ref;
 * no snapshot answers an attach before its reply names the handle; and an
 * attach given up on while the stream's open is pending is never sent.
 * OW-linowe raised it a fifteenth: a `sessions/detach` or `sessions/close`
 * with no `handle` stops the attachment the snapshot answering its
 * `token`'s attach created, if that snapshot created one, where it stopped
 * whatever the helper had last named to Emacs by `session`, which another
 * buffer attached to that ref since could hold. OW-nowihu raised it a
 * sixteenth: `sessions/detach` and `sessions/close` carry `tokens`, every
 * attach their buffer sent and every one a buffer it absorbed sent, where
 * they carried one `token`, and stop the attachment under a handle once
 * every token answered under it is released, where the handle stopped it,
 * or without one the token whose answer created it. OW-novuye raised it a
 * seventeenth, deciding before changing it: what the elisp needs of a tool
 * call reaches it as typed fields on the tool part, derived in
 * `src/emacs/nodes.ts`, never as something the elisp parses out of `args`,
 * which is display text. OW-gakide added `threadIds`, the child threads a
 * subagent call names. OW-4 is to add `files`, one entry per file an edit
 * or write touches carrying its path, its kind where the backend names one,
 * and its diff lines, retiring the flat `diff`.
 * OW-jamaha raised it an eighteenth, under D27: `sessions/setName`, and
 * `name` on the `SessionSummary` that `sessions/list` answers.
 * OW-wavini raised it a nineteenth: the `"system"` role and its `system`
 * part, for the system-role message `pi 1.2.0` opens every session with and
 * sends again whenever its configuration changes.
 * ark3/agentpane#51 raised it a twentieth, under D30: `sessions/forkAndPrompt`
 * carries a `token` and attaches the fork for the buffer that minted it, as
 * `sessions/attach` does, so an edit sends one request.
 * ark3/agentpane#48 raised it a twenty-first, under D30: `sessions/create`
 * starts the session's agent, carries a `token` and answers the session's
 * summary, attaching it for the token as `sessions/attach` does.
 * ark3/agentpane#49 raised it a twenty-second, under D30: `sessions/prompt`
 * sends its `handle` to the server, which prompts only the live session
 * under it, and one naming none carries a `token` and attaches its session
 * for the buffer that minted it, as `sessions/attach` does.
 * D31 raised it a twenty-third, moving the helper onto one socket: every
 * request on a live session names its `handle`, which the server refuses
 * once it has ended; an error the server refused carries its `code` and no
 * HTTP status; an attach's reply follows its snapshot, so nothing waits on
 * a snapshot or on an open; and a request that reached no server is refused
 * as such, where it answered `-32603`.
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
 *   folded its context at), `"system"` (a system-role message: the system
 *   prompt, or a later change to it, carrying one `system` part and no role
 *   label of its own), or another backend-defined role the elisp should draw
 *   generically.
 * - `parts` (array, always, possibly empty). The node's content in display
 *   order; each element is one of the parts below, told apart by `type`.
 * - `meta` (object, only on `role: "assistant"`). The turn's footer facts,
 *   present on every assistant node including a streaming one; see below.
 * - `timestamp` (number, only on `role: "user"` and `role: "assistant"`, and
 *   only when the message carries a usable one). When the message happened,
 *   as epoch milliseconds, exactly as the message holds it; the drawer
 *   formats it in its own zone, as the browser's `formatTimestamp` does in
 *   the browser's. Absent for a stored turn whose record had no time.
 * - `tokensBefore` (integer, only on `role: "compactionSummary"`, always
 *   there). The context size the backend folded, `0` when it reported none;
 *   the browser's marker names it only when it is above `0`.
 *
 * Parts, by `type`:
 *
 * - `{ type: "text", text, html }` -- `text` (string) is markdown source,
 *   exactly as the model wrote it; `html` (string) is the sanitized HTML the
 *   browser renders for that markdown, the very string `renderMarkdown` in
 *   `$client/render/markdown.ts` returns, for the buffer to draw through
 *   `shr` (D22, OW-refibu). Empty when `text` is empty.
 *   A `compactionSummary` node carries its summary as one of these when the
 *   backend supplied any; a role the projection does not know carries the
 *   whole message as JSON text so nothing is silently dropped.
 * - `{ type: "thinking", text, redacted }` -- `text` (string) is the thinking
 *   as streamed, empty when `redacted` (boolean) is true and the provider
 *   withheld it. `text` may also be empty with `redacted` false: Pi emits
 *   thinking blocks carrying only a signature, and the browser draws nothing
 *   for such a part unless the turn is still streaming.
 * - `{ type: "tool", name, summary, args, result, state, timestamp?,
 *   images?, diff?, threadIds? }` -- one tool call with its answer folded in.
 *   `name` (string) is the backend's own tool name, casing preserved. `summary`
 *   (string) is the one-line description the browser's tool card shows in
 *   its header: the command for a shell, the basename and line counts for a
 *   file tool, the arguments otherwise; may be empty. `args` (string) is the
 *   call's arguments pretty-printed as JSON, empty when there were none.
 *   `result` (string) is the text of the result, empty when none has
 *   arrived. `timestamp` (number) is the result's own, epoch milliseconds
 *   like a node's, present only once a result carrying a usable one has
 *   arrived; the browser shows it in the card's body. `images` (array) is
 *   the result's image parts in order, each an `image` part as below,
 *   present only when the result has any: Pi's `read` answers an image path
 *   with one. `state` (string) is `"running"` while the session is streaming, the
 *   call's node is the last one, and no result has arrived -- the browser's
 *   own rule; `"error"` when the result reported failure; `"ok"` otherwise,
 *   including a call whose result never arrived in a finished turn. The
 *   state is as of the node's sending: no node is re-sent when streaming
 *   ends or a later node is appended, so the drawer applies the rule again
 *   and draws a held `"running"` as `"ok"` once either has happened. `diff`
 *   (array) is present only for a call named `edit` or `write`
 *   (case-insensitive), as `{ type, text }` lines where `type` is `"add"`,
 *   `"del"`, `"ctx"` (unchanged, kept as context), or `"gap"` (a marker
 *   standing in for a run of unchanged lines; its `text` says how many). For
 *   `edit` it is the unified diff the browser draws. For `write` it is the
 *   whole written content as `"add"` lines: the browser shows a write as
 *   plain content, never a diff, and the lines are here so one drawer serves
 *   both. `threadIds` (array of strings) is present only for a call named
 *   `subagent` (case-insensitive), Codex's collab call, that names child
 *   threads: each a Codex thread id, the `id` of the child's ref with
 *   `backend: "codex"`, in the order the call names them, exactly the
 *   threads the browser's subagent card offers Open thread on. Absent for
 *   any other call, and for a subagent call naming none, as a spawn's
 *   `item/started` does. An orphan `tool-result` node carries one of these
 *   parts too, with `args` empty and no `diff` or `threadIds`.
 * - `{ type: "system", summary, body }` -- the one part of a `"system"` node,
 *   drawn as the browser draws it: `summary` (string, never empty) as a
 *   one-line marker naming what the message carries, and `body` (string,
 *   plain text, not markdown) folded beneath it, collapsed until opened --
 *   the message's own text, each section under its name, and the tools it
 *   adds and removes. Both come from `systemView` in
 *   `$client/render/system.ts`, which the browser draws from too.
 * - `{ type: "image", mimeType, data }` -- an image the user attached, or
 *   one in a tool result's `images`.
 *   `mimeType` (string) such as `"image/png"`; `data` (string) is base64.
 *
 * Meta -- the object under an assistant node's `meta`:
 *
 * - `model` (string, always; may be empty when the backend reported none).
 * - `effort` (string, only when the backend reported a reasoning effort;
 *   Codex does, Claude Code does on a model with effort, and Pi does on a
 *   model that reasons, for turns streamed live and for turns loaded from its
 *   store on a resume or after a fork alike: a loaded turn names the level
 *   its store recorded when it ran, and none where the store cannot say, as
 *   for a turn at `off` on a model other than the current one).
 * - `usage` (object, always): `totalTokens` (integer) and `cost` (number, in
 *   dollars); both are `0` when the backend reports no accounting.
 * - `stopReason` (string, only when the turn ended badly): `"error"` or
 *   `"aborted"`. Absent for a turn that finished normally or is still
 *   streaming; a streaming turn is recognised by the projection still
 *   re-sending the node, not by anything in it.
 * - `errorMessage` (string, only when the backend supplied one alongside
 *   `stopReason: "error"`).
 *
 * ---------------------------------------------------------------------------
 *
 * The JSON-RPC 2.0 link the helper speaks (OW-refibu), `Content-Length`
 * framed over stdio as `jsonrpc-process-connection` expects. Emacs sends
 * requests; the helper answers each and pushes notifications on its own.
 * `session` in every payload is a ref, `{ backend, id }`, exactly as the
 * server's `SessionRef`; `handle` (string) is the session's
 * `SessionSummary.handle`, the name the server gave the live session: opaque,
 * never moved by a rename, and a different one for a fork (D24, OW-suyinu).
 * A rename is said by nothing else: the `session` of any notification under
 * a handle is the session's ref from then on.
 * Every per-session notification below carries it, as every event the
 * server sends on a session does, and every request on a live session sends
 * its own to the server, which refuses one that has ended (D31 point 9); `sessions/detach`
 * and `sessions/close` accept one and send it nowhere (OW-nowihu); `compaction` is `"requesting"`, `"running"` or `null`;
 * `model` is a string or `null`; so is `effort`, the reasoning effort the
 * session's next turn runs at, `null` when the backend reports none; and so
 * is `unrestoredModel`, the model the session's store last recorded when the
 * backend did not restore it on a resume or a fork and `model` is another in
 * its place (D23, OW-jitoni), `null` otherwise. Only Pi reports one. It
 * outlives the first turn on `model`, which records `model` as though chosen,
 * and clears once a `sessions/setModel` succeeds.
 *
 * Requests, by `method`, with `params` and `result`:
 *
 * - `sessions/list` -- `{ cwd? }` -> array of `SessionSummary` (the server's
 *   listing, unchanged: `ref`, `cwd`, `preview`, `createdAt`, `updatedAt`,
 *   `status`, `isStreaming`, `onDisk`, `name`, and `handle` for a session
 *   the server holds, virtual or attached). `name` (string or `null`) is
 *   the session's name as its backend holds it; as of OW-jamaha only an
 *   attached session's is known, and a change to it sends
 *   `sessions/changed`. `sessions/changed` flows from the helper's first
 *   request on, whether or not anything is attached: that request opens
 *   the helper's socket, and the listing is ordered against the events
 *   around it (D31 point 1).
 * - `sessions/preview` -- `{ session }` -> array of nodes, read from the
 *   stored transcript; spawns nothing. A session the
 *   server does not hold and no file backs answers an error whose `data`
 *   carries `error: "gone"` (D26 point 5); one it holds with nothing on
 *   disk yet answers no nodes.
 * - `sessions/create` -- `{ cwd, backend, model?, token }` -> the new
 *   session's `SessionSummary`, carrying its `handle`. Creates the session
 *   and starts its agent, as one server operation (D30), and answers once it
 *   is attached; nothing hits disk until its first turn (D9). A start that
 *   fails is refused as an attach's would be and leaves no session behind,
 *   so a retry is a new create. It is also an attach, as
 *   `sessions/forkAndPrompt` is, for whoever minted `token` (integer,
 *   always, from the count `sessions/attach`'s come from): the session is
 *   attached from the `session/snapshot` under the reply's handle that
 *   carries `token`, sent as for `sessions/attach` and before the reply, and
 *   released by a `sessions/detach` or `sessions/close` carrying it. Until
 *   ark3/agentpane#48 it carried no token, started nothing, and answered the
 *   bare ref.
 * - `models/list` -- `{ backend }` -> array of `{ id, label, efforts,
 *   defaultEffort }`, the server's listing unchanged. `efforts` is an array of
 *   `{ id, description }`, the reasoning efforts that model accepts, empty
 *   when the model or its backend offers none -- and then there is no effort
 *   to choose; `defaultEffort` (string or `null`) is what the backend runs it
 *   at when none is chosen.
 * - `sessions/attach` -- `{ session, token }` -> the `SessionSummary` the
 *   server's `sessions/attach` answers, carrying the session's `handle`. `token`
 *   (integer, always) names this attach: agentpane-mode mints it, no two
 *   attaches it sends carry the same one, and the helper sends it nowhere
 *   but back, on the snapshot that answers this attach, and holds it to
 *   match a `sessions/detach` or `sessions/close` carrying it among its
 *   `tokens` (OW-wukako, OW-nowihu).
 *   The reply's `ref` is authoritative and may differ from the one asked
 *   for. The reply ends the request and says nothing about attachment:
 *   the session is attached from the `session/snapshot` that answers the
 *   attach, carrying its `token`, and only then (OW-rebawa). That is a
 *   snapshot under the handle the reply names, sent as the reply arrives
 *   and before it goes out, from the view the helper holds under that
 *   handle, which the attach's own snapshot formed before the reply
 *   (D31 point 3); one that came under another handle, the same ref or
 *   not, answers nothing. A reply that goes out with no snapshot having
 *   answered its attach means none will: a `seq` gap or the server's
 *   `ended` took the session's view before the reply was handled, or a
 *   `sessions/detach` or `sessions/close` carrying this attach's token
 *   landed while it was in flight; the session ends not attached, as after
 *   any gap (D25). A snapshot under a handle already attached goes out
 *   untagged as it arrives, as every later snapshot under it does, so a
 *   second attach answered under that handle is preceded by one.
 *   From here on the per-session notifications below flow for this
 *   session.
 * - `sessions/prompt` -- `{ session, handle, text, images?, priorErrorId? }`
 *   or `{ session, token, text, images?, priorErrorId? }` ->
 *   `null` for a prompt that started a turn or joined one, or
 *   `{ disposition: "handled" }` for one the backend consumed without
 *   starting a turn for it: the server's own `PromptResponse`
 *   (OW-dulipe). An extension that handled it may still start work of its
 *   own, whose notifications arrive as usual (`docs/rpc-commands.md` "prompt"
 *   in `pi 1.2.0`, read at the installed package, not measured); after
 *   `/refs`, `/llama` and `/mcp` on `pi 1.2.0` none did (docs/MANUAL_TESTING.md,
 *   OW-kokotu). No other backend answers it.
 *   How it is addressed says what it may do (D30). Sent from a buffer
 *   holding the session live, it names that buffer's `handle`, goes only to
 *   the live session under it and starts nothing: a handle that has ended is
 *   refused with `data.error` `not_attached`, a close and a
 *   re-attach crossing it included. Sent from a buffer that knows the
 *   session is not running, it names no handle and carries a `token`, and
 *   the server attaches the session if it must and then prompts it: the
 *   snapshot that answers that attach carries the `token`, is about the
 *   buffer whose `agentpane--attach-sent` it is, and goes out before the
 *   reply, as `sessions/attach` above says of its own. A refusal after the
 *   attach carries `attached`, `{ ref, handle }`, in its `data`, and answers
 *   the same way before its error goes out; one whose start failed names
 *   nothing and binds nothing.
 *   `priorErrorId` (string or `null`) is the `errorId` of the turn
 *   error the buffer held when the user sent, `null` when it held none, read
 *   at the send: admitting the prompt clears the session's error only while
 *   it is still that one, so an error raised after the send, the start of
 *   the attach a prompt naming no handle makes among them, stays
 *   (OW-jokoto). Absent, the server takes whatever error it holds when the
 *   prompt arrives.
 * Every request on a live session below, from `sessions/abort` on but
 * `sessions/close` and `sessions/detach`, takes `{ session, handle }`: the
 * handle the buffer holds, which the server refuses `not_attached` once it
 * has ended, so a request that crosses a close and a re-attach cannot land
 * on the new session (D31 point 9). `session` goes nowhere.
 *
 * - `sessions/abort` -- `{ session, handle }` -> `null` for a stop that took nothing
 *   out of the backend's queue, or `{ queued }` for one that did: the
 *   server's own `AbortResponse`, the text of each prompt steered into the turn
 *   and not yet delivered, which only Pi holds, for the buffer that stopped
 *   it to take back (D16, OW-wisifo). No notification carries them.
 * - `sessions/compact` -- `{ session, handle }` -> `null`.
 * - `sessions/close` -- `{ session, handle?, tokens? }` -> `null`. Kills the
 *   subprocess, then gives up and releases the attaches `tokens` names, as
 *   `sessions/detach` below says; the server's `ended` for the handle
 *   stops this session's notifications whatever claims still stand.
 * - `sessions/dismissError` -- `{ session, handle, errorId }` -> `null`. Clears the
 *   session's turn error, so later `session/snapshot`s carry `error: null`,
 *   but only while `errorId` (string) still names the error the server
 *   holds: a newer one survives the dismissal of the one Emacs was showing
 *   (OW-desufa), even one with the same text (OW-jokoto).
 * - `sessions/detach` -- `{ session, handle?, tokens? }` -> `null`. Stops
 *   showing a session, and does nothing else: nothing goes to the server, and the
 *   session goes on running on the server. Sent when Emacs stops showing a
 *   session. `tokens` (array of integers, absent meaning none) names every
 *   `sessions/attach` the buffer sent and every one a buffer it absorbed
 *   sent, save those a `sessions/close` of its already carried; one
 *   carried twice releases nothing the second time. Each that no snapshot
 *   has answered and whose reply has not gone out yet is given up: its
 *   reply still goes out, and no snapshot answers it. No other attach is, another of the
 *   same ref included. Each answered under a handle releases its claim
 *   there, and the notifications under a handle stop once every attach
 *   answered under it is released, whichever buffer releases last
 *   (OW-nowihu). A claim goes with the handle's notifications, so a token
 *   answered under a handle whose notifications stopped since -- a
 *   detach, a close or a `session/detached` -- releases nothing. `handle`
 *   and `session` pick out no notifications. Until OW-nowihu `token` named
 *   one attach, and `handle` stopped the notifications under it, or
 *   without one the handle of the snapshot answering that attach, if
 *   nothing was attached under it before (OW-linowe). What stays is named
 *   at `forget` in helper.ts.
 * - `sessions/setModel` -- `{ session, handle, model }` -> `null`. A chosen effort the
 *   new model does not list falls back to that model's `defaultEffort`, or
 *   where that is `null` to whatever the backend then picks, which the
 *   `session/status` that follows reports.
 * - `sessions/setName` -- `{ session, handle, name }` -> `null`. Names the session,
 *   written through to its backend, which holds it; agentpane keeps no copy
 *   (D13, "Names are not marks"). Only an attached session can be named:
 *   the server refuses any other `not_attached`, and a `name` empty once
 *   trimmed `bad_request`; line breaks in it become one space.
 *   The name arrives in the listing the
 *   `sessions/changed` that follows asks for.
 * - `sessions/setEffort` -- `{ session, handle, effort }` -> `null`. `effort` is one of
 *   the session's model's `efforts` ids, taking effect from the next turn;
 *   the server refuses any other `bad_request`, and any at all while that
 *   model lists none or is not yet known.
 * - `sessions/forkPoints` -- `{ session, handle }` -> `{ points, forkStopsTurn }`:
 *   `points` an array of `{ id, text, index }`, and `forkStopsTurn` whether
 *   a fork of the session stops a turn running when it lands, which is what
 *   "Stop and fork" reads (D30). Until ark3/agentpane#47 the result was the
 *   array alone.
 * - `sessions/fork` -- `{ session, handle, entryId }` -> the fork's ref.
 * - `sessions/forkAndPrompt` -- `{ session, handle, index, text, images?, token }`
 *   -> `{ session, disposition }`. An edit of an earlier message as one
 *   server operation (D30): fork at the user message whose transcript
 *   `index` this is, attach the fork, and prompt it with `text`, clearing no
 *   turn error. `session` in the result is the fork's summary, with its
 *   `handle`, and `disposition` is `"started"` or `"handled"`, as
 *   `sessions/prompt`'s. An index no fork point names is refused
 *   `not_a_fork_point` and nothing forked. A failure after the fork was
 *   created carries `fork`, `{ ref, handle }`, in its `data`, `handle` being
 *   `null` where the fork's own start failed; the server removes nothing.
 *   It is also an attach of the fork, for the buffer that minted `token`
 *   (integer, always, from the count `sessions/attach`'s come from): the
 *   fork is attached from the `session/snapshot` under its handle that
 *   carries `token`, sent as for `sessions/attach` and before the reply,
 *   and released by a `sessions/detach` or `sessions/close` carrying it,
 *   so agentpane-mode binds the fork's buffer as an attach binds one (D25).
 *   A refusal that names a fork under a handle answers the same way before
 *   its error goes out; one that names none, or no fork, answers nothing.
 *   Until ark3/agentpane#51 it carried no token and attached nothing.
 *
 * Errors: a request the server refused answers with `-32000` as `code`, the
 * server's text as `message`, and `{ error, detail }` as `data`, `error`
 * being the refusal's code (D31 point 2) and `detail` its text, and `fork`
 * or `attached` beside them where the refusal has one
 * (`sessions/forkAndPrompt`, `sessions/prompt`), so a mid-turn prompt
 * rejection reads in Emacs as it does in the browser. A request that never
 * reached the server is refused the same way, with a code of the helper's
 * own: `unreachable` for one read with the socket not up, `frame_too_large`
 * for one over the server's frame limit, and `unauthorized`, its `message`
 * naming the token file, for each one out when the server refused the
 * token. Any other failure is `-32603` with its message and no `data`, and
 * says nothing of whether the server acted on the request; an unknown
 * method is `-32601`. A request still out when the socket closes, at the
 * end of the helper's input or the server's going, gets no reply at all
 * (`runHelper` in helper.ts): Emacs answers it as the helper's death
 * (OW-hiliti).
 *
 * Notifications, by `method`, with `params`; each names the session it is
 * about, and none arrives for a session Emacs has not attached, except
 * `sessions/changed`; the first under a handle is the `session/snapshot`
 * that attaches it:
 *
 * - `session/snapshot` -- `{ session, handle, nodes, isStreaming, compaction,
 *   model, effort, unrestoredModel, error, errorId, notices }`.
 *   Replaces everything the buffer holds; also how a session first appears
 *   after `sessions/attach`, and how a missed event is healed. `error` and
 *   `notices` are what the server holds for the session, and what
 *   `session/error` and `session/notice` below have said, whether or not
 *   Emacs was attached to hear them (OW-bipume): `error` (string or `null`)
 *   the last turn error, `null` again once the server clears it, which
 *   `session/errorCleared` says, with `errorId` (string, or `null` exactly
 *   when `error` is) naming it as `session/error` does; and `notices`
 *   (array, always, possibly empty) every notice, oldest first, each the
 *   `notice` a `session/notice` carried.
 *   The buffer draws both after `nodes`, since a snapshot replaces
 *   everything the buffer holds and would otherwise wipe them.
 *   `token` (integer, only on a snapshot that answers a
 *   `sessions/attach`, one such snapshot for each attach it answers) is
 *   the `token` that attach carried, whatever ref it asked for and the
 *   snapshot names (OW-wukako). It is request correlation, not identity:
 *   it says which waiting attach this snapshot answers, so the receiver can
 *   bind the handle to what sent that attach -- which may hold another
 *   ref, the ref of a session another buffer holds under that handle, or
 *   a handle of its own already -- and is the only thing that does, the
 *   reply binding nothing (OW-rebawa). Until OW-wukako it was `askedFor`,
 *   the ref asked for, which two attaches of one ref shared. Nor could the
 *   receiver rely on handling
 *   the reply first -- as of jsonrpc.el 1.0.29 on Emacs 31.1, the reply to
 *   an asynchronous request that arrives while a synchronous one is
 *   outstanding runs only once that one returns, while notifications are
 *   handled at once (docs/MANUAL_TESTING.md, "jsonrpc.el runs an async reply
 *   after later notifications").
 * - `session/node` -- `{ session, handle, node }`. One node to replace by
 *   `index`.
 * - `session/status` -- `{ session, handle, isStreaming, compaction, model,
 *   effort, unrestoredModel }`.
 * - `session/error` -- `{ session, handle, message, errorId }`. A turn error.
 *   `errorId` (string, opaque) names this raise: two with the same
 *   `message` are two errors, and `sessions/dismissError` and
 *   `sessions/prompt` name the one the buffer showed by it (OW-jokoto). No
 *   server mints one twice, a restarted one included, so one a buffer kept
 *   across a restart names nothing the new process raised. Every later
 *   `session/snapshot` carries it again, in `error` and `errorId`, until it
 *   is cleared, which `session/errorCleared` says.
 * - `session/errorCleared` -- `{ session, handle }`. The server no longer
 *   holds the session's turn error: a prompt that started or joined a turn
 *   was admitted over it, it being still the one its sender held, or a
 *   client dismissed it by its `errorId` (OW-jopifu, OW-jokoto). Drop its
 *   line. It follows every
 *   snapshot sent before the clear on the one ordered stream, so a line such
 *   a snapshot drew again goes with it; one Emacs never drew is nothing to
 *   drop.
 * - `session/notice` -- `{ session, handle, notice }`. Something non-fatal the
 *   backend said (OW-tujiya), never a turn error: `notice` is the server's
 *   `AgentNotice` unchanged -- `kind` (string, the backend's own name for
 *   it), `message` (string, the text to show, which may span lines, each
 *   drawn as a line), `details` (string or `null`, further guidance) and
 *   `path` (string or `null`, the file it is about, with `:LINE:COLUMN`
 *   where the backend named a place in it). The Codex and Pi adapters
 *   produce them; Claude Code's does not. Every later `session/snapshot`
 *   carries it again, in `notices`.
 * - `session/detached` -- `{ session, handle, cause }`. Nothing more comes
 *   under `handle`, and the helper has dropped the attachment: either the
 *   server let go of the handle and said so with an `ended` under it -- a
 *   close, by another client or this one, or on Pi a fork moving the
 *   process onto a conversation of its own (D26) -- and `cause` is
 *   `"ended"`, or the session's `seq` gapped, and the helper detaches that
 *   one session rather than attach it again (D25 point 5, OW-filuge), and
 *   `cause` is `"gapped"`: the handle stays live on the server, and a turn
 *   running under it may go on unheard. `session` is the ref it last named
 *   the session by. The buffer holding `handle` lets go of it and counts
 *   itself detached and not streaming, keeping its ref and what it drew;
 *   its next `sessions/attach`, by that ref, is answered under whatever
 *   handle and ref the session has now, if any, as a first attach is.
 * - `sessions/changed` -- no `params`. Refetch the listing. A listing
 *   detaches nothing: where the server lets go of a handle Emacs attached,
 *   the `session/detached` for it goes out ahead of the `sessions/changed`
 *   the same close or fork sends.
 *
 * No notification says the socket closed. When it does, or it fails to
 * open, the helper exits (D25 point 4, OW-mepufi, D31 point 6), and Emacs
 * sees its process end. A failed first open first answers each request read
 * before it as `unreachable` (OW-pezelo).
 */

import type {
	AbortResponse,
	AgentNotice,
	BackendId,
	CreateSessionRequest,
	DismissErrorRequest,
	ForkAndPromptRequest,
	ForkAndPromptResponse,
	ForkPointsResponse,
	ForkRequest,
	ModelInfo,
	PromptRequest,
	PromptResponse,
	SessionRef,
	SessionSummary,
} from "$shared/protocol.ts";

/** What a request names its session by: the ref, and the handle it may carry beside it. */
export interface SessionParams {
	session: SessionRef;
	handle?: string;
}

/**
 * What a request on a live session names it by: the handle the buffer holds,
 * which the server refuses `not_attached` once it has ended, so a request
 * that crosses a close and a re-attach cannot land on the new session (D31
 * point 9); and the ref beside it, which the helper sends nowhere.
 */
export interface LiveParams {
	session: SessionRef;
	handle: string;
}

export interface HelperRequests {
	"sessions/list": { params: { cwd?: string }; result: SessionSummary[] };
	"sessions/preview": { params: SessionParams; result: TranscriptNode[] };
	"sessions/create": { params: CreateSessionRequest & { token: number }; result: SessionSummary };
	"models/list": { params: { backend: BackendId }; result: ModelInfo[] };
	"sessions/attach": { params: SessionParams & { token: number }; result: SessionSummary };
	"sessions/prompt": {
		params: { session: SessionRef } & Omit<PromptRequest, "handle"> & ({ handle: string; token?: undefined } | { handle?: undefined; token: number });
		result: PromptResponse | null;
	};
	"sessions/abort": { params: LiveParams; result: AbortResponse | null };
	"sessions/compact": { params: LiveParams; result: null };
	"sessions/close": { params: SessionParams & { tokens?: number[] }; result: null };
	"sessions/dismissError": { params: LiveParams & DismissErrorRequest; result: null };
	"sessions/detach": { params: SessionParams & { tokens?: number[] }; result: null };
	"sessions/setModel": { params: LiveParams & { model: string }; result: null };
	"sessions/setEffort": { params: LiveParams & { effort: string }; result: null };
	"sessions/setName": { params: LiveParams & { name: string }; result: null };
	"sessions/forkPoints": { params: LiveParams; result: ForkPointsResponse };
	"sessions/fork": { params: LiveParams & ForkRequest; result: SessionRef };
	"sessions/forkAndPrompt": { params: LiveParams & ForkAndPromptRequest & { token: number }; result: ForkAndPromptResponse };
}

export interface SessionStatusParams {
	session: SessionRef;
	handle: string;
	isStreaming: boolean;
	compaction: "requesting" | "running" | null;
	model: string | null;
	effort: string | null;
	unrestoredModel: string | null;
}

export type HelperNotification =
	| {
			method: "session/snapshot";
			params: SessionStatusParams & {
				nodes: TranscriptNode[];
				error: string | null;
				errorId: string | null;
				notices: AgentNotice[];
				token?: number;
			};
	  }
	| { method: "session/node"; params: { session: SessionRef; handle: string; node: TranscriptNode } }
	| { method: "session/status"; params: SessionStatusParams }
	| { method: "session/error"; params: { session: SessionRef; handle: string; message: string; errorId: string } }
	| { method: "session/errorCleared"; params: { session: SessionRef; handle: string } }
	| { method: "session/notice"; params: { session: SessionRef; handle: string; notice: AgentNotice } }
	| { method: "session/detached"; params: { session: SessionRef; handle: string; cause: "ended" | "gapped" } }
	| { method: "sessions/changed"; params?: undefined };

export interface TranscriptNode {
	index: number;
	role: string;
	parts: NodePart[];
	meta?: TurnMeta;
	timestamp?: number;
	tokensBefore?: number;
}

export type NodePart = TextPart | ThinkingPart | ToolPart | SystemPart | ImagePart;

export interface TextPart {
	type: "text";
	text: string;
	html: string;
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
	timestamp?: number;
	images?: ImagePart[];
	diff?: NodeDiffLine[];
	threadIds?: string[];
}

export interface SystemPart {
	type: "system";
	summary: string;
	body: string;
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
