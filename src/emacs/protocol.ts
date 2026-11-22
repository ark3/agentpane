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
 * D32 raised it a twenty-fourth, under points 1 to 3: a transcript buffer
 * is a view, named by an integer agentpane-mode mints, and every
 * per-session request carries `view` where it carried `token`, `tokens` or
 * `handle`, the helper holding each view's binding and filling in the
 * handle; every per-session notification carries `view` beside `handle`;
 * `sessions/prompt` carries `live`; `sessions/forkAndPrompt` carries
 * `forkView`; and a reply, or a refusal's `attached` or `fork`, names the
 * view holding the session where another does. The tokens of OW-wukako,
 * OW-linowe and OW-nowihu, and those ark3/agentpane#48, #49 and #51 put on
 * `sessions/create`, `sessions/prompt` and `sessions/forkAndPrompt`, are
 * history.
 * D32 raised it a twenty-fifth, under point 4 (ark3/agentpane#71): the
 * helper holds each view's requests still out, refusing a second send
 * from a view `busy`, and a send or a second compact while a compact from
 * the view is out, joining a second attach from a view to its first
 * still out, holding a prompt from an unbound view until the view's
 * attach still out has bound it, and refusing an attach or a by-ref
 * prompt of a session a `sessions/forkAndPrompt` still out forks
 * `forking`.
 * D32 raised it a twenty-sixth, under point 6 (ark3/agentpane#72): the
 * helper holds the turn-done watch and the streaming levels, and sends
 * `session/turnEnded` for every live session whose turn ends, saying
 * whether this Emacs's prompt was watching it; `sessions/forkAndPrompt`
 * carries `stops`; `sessions/abort` and `sessions/fork` carry `unwatch`; and
 * `session/detached` loses OW-kutome's `cause`, its only reader the watch
 * agentpane-mode no longer keeps.
 * D32 raised it a twenty-seventh, under point 7 (ark3/agentpane#73): a
 * request still out when the socket closes is answered `-32001` before
 * the helper exits, where it got no reply and agentpane-mode's teardown
 * answered it as the helper's death.
 * ark3/agentpane#75 raised it a twenty-eighth, under D33: `sessions/fork`
 * goes, agentpane-mode forking only by an edit, and with it the `unwatch`
 * on `sessions/abort` and on that fork.
 * ark3/agentpane#76 raised it a twenty-ninth, under D33 point 4: the helper
 * fetches each bound view's fork points and sends them as
 * `session/forkPoints`, and the `sessions/forkPoints` request goes,
 * agentpane-mode reading the set it was sent rather than asking at the
 * press.
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
 * server sends on a session does, and `view` beside it. `view` (integer) is
 * the transcript buffer's name for itself: agentpane-mode mints one when it
 * makes a buffer, the buffer keeps it for its life, and every per-session
 * request below carries its own, beside `session` (D32 point 1). The helper
 * holds each view's binding, the handle it is attached under, at most one
 * view to a handle, and fills that handle in for every request on a live
 * session, refusing one from a view bound to none with `data.error`
 * `not_attached`, as the server refuses a handle that has ended (D31 point
 * 9). A view is bound by the `session/snapshot` that answers its attach,
 * and unbound by its own `sessions/detach`, by the server's `ended` under
 * its handle, and by a `seq` gap, the last two said by `session/detached`.
 * No request carries `handle`, `token` or `tokens`.
 * `compaction` is `"requesting"`, `"running"` or `null`;
 * `model` is a string or `null`; so is `effort`, the reasoning effort the
 * session's next turn runs at, `null` when the backend reports none; so is
 * `defaultEffort`, the `defaultEffort` of `model`'s `models/list` entry,
 * which the helper asks for once per backend and holds (D32 point 8), `null`
 * until that listing has answered, when a status follows carrying it, or
 * when the entry names none; and so
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
 * - `sessions/create` -- `{ cwd, backend, model?, view }` -> the new
 *   session's `SessionSummary`, carrying its `handle`. Creates the session
 *   and starts its agent, as one server operation (D30), and answers once it
 *   is attached; nothing hits disk until its first turn (D9). A start that
 *   fails is refused as an attach's would be and leaves no session behind,
 *   so a retry is a new create. It is also an attach, as
 *   `sessions/forkAndPrompt` is, for `view`, the buffer agentpane-mode made
 *   for the session before sending (D32 point 3): the `session/snapshot`
 *   under the reply's handle binds `view`, sent as for `sessions/attach` and
 *   before the reply. Until ark3/agentpane#48 it started nothing, and
 *   answered the bare ref.
 * - `models/list` -- `{ backend }` -> array of `{ id, label, efforts,
 *   defaultEffort }`, the server's listing unchanged. `efforts` is an array of
 *   `{ id, description }`, the reasoning efforts that model accepts, empty
 *   when the model or its backend offers none -- and then there is no effort
 *   to choose; `defaultEffort` (string or `null`) is what the backend runs it
 *   at when none is chosen.
 * - `sessions/attach` -- `{ session, view }` -> the `SessionSummary` the
 *   server's `sessions/attach` answers, carrying the session's `handle`, and
 *   `view` (integer) beside it where another view holds that handle.
 *   The reply's `ref` is authoritative and may differ from the one asked
 *   for. The reply ends the request and says nothing about attachment:
 *   the session is attached from the `session/snapshot` under the view that
 *   sent the attach, and only then (OW-rebawa). That is a snapshot under
 *   the handle the reply names, sent as the reply arrives and before it
 *   goes out, from the view the helper's reducer holds under that handle,
 *   which the attach's own snapshot formed before the reply (D31 point 3);
 *   one that came under another handle, the same ref or not, answers
 *   nothing. A reply that goes out with no snapshot having answered its
 *   attach means none will: a `seq` gap or the server's `ended` took the
 *   session's view before the reply was handled, the view's
 *   `sessions/detach` landed while it was in flight, or another view holds
 *   the handle (D32 point 2), which the reply then names by `view`: nothing
 *   is bound for the view that asked, and no buffers merge. An attach from
 *   the view that already holds the handle, as `g` sends, is answered with
 *   the snapshot again. A snapshot under a handle already bound goes out as
 *   it arrives, as every later snapshot under it does.
 *   An attach from a view whose first `sessions/attach`, `sessions/create`
 *   or by-ref `sessions/prompt` is still out joins that one: nothing goes
 *   to the server, no second snapshot goes out, and it is answered with
 *   that one's answer, its reply, `view` included, or its refusal (D32
 *   point 4). One sent once that has been answered goes to the server.
 *   One naming a session a `sessions/forkAndPrompt` still out forks is
 *   refused `forking`, from any view.
 *   From here on the per-session notifications below flow for this
 *   session, under the view.
 * - `sessions/prompt` -- `{ session, view, text, images?, priorErrorId?,
 *   live? }` -> `null` for a prompt that started a turn or joined one, or
 *   `{ disposition: "handled" }` for one the backend consumed without
 *   starting a turn for it: the server's own `PromptResponse`
 *   (OW-dulipe); either with `view` (integer) where the prompt attached a
 *   session another view holds, `{ view }` standing for `null`. An extension that handled it may still start work of its
 *   own, whose notifications arrive as usual (`docs/rpc-commands.md` "prompt"
 *   in `pi 1.2.0`, read at the installed package, not measured); after
 *   `/refs`, `/llama` and `/mcp` on `pi 1.2.0` none did (docs/MANUAL_TESTING.md,
 *   OW-kokotu). No other backend answers it.
 *   One prompt at a time from a view: one sent while a `sessions/prompt`,
 *   a `sessions/forkAndPrompt` or a `sessions/compact` from the view is
 *   still out is refused `busy` and reaches no server (D32 point 4).
 *   The view's binding says what it may do (D30). From a bound view it goes
 *   only to the live session under the view's handle and starts nothing: a
 *   handle that has ended is refused with `data.error` `not_attached`, a
 *   close and a re-attach crossing it included. `live` (boolean, absent
 *   meaning false) says the buffer held a handle when it sent: one marked
 *   so from a view the helper has unbound since, at an `ended` or a gap, is
 *   refused `not_attached` too and reaches no server, since by ref it would
 *   resume a session another client closed. From an unbound view whose
 *   attach is still out, and not `live`, it waits for that attach, and
 *   then goes under the handle it bound, as from a bound view. Where the
 *   attach bound nothing it never goes by ref: it is refused with the
 *   attach's refusal where the attach was refused, and otherwise with
 *   `not_attached`, carrying `attached`, `{ ref, handle, view }`, where the
 *   attach landed on the handle another view holds (D32 point 4). From an
 *   unbound view with no attach out, and not `live`, it goes by ref, unless
 *   a `sessions/forkAndPrompt` still out forks the session, which refuses
 *   it `forking`; and the server attaches the session if it must
 *   and then prompts it: the snapshot that answers that attach binds the
 *   view and goes out before the reply, as `sessions/attach` above says of
 *   its own, and where another view holds the handle nothing is bound and
 *   the reply names that view. A refusal after the attach carries
 *   `attached`, `{ ref, handle, view? }`, in its `data`, `view` naming the
 *   view that holds the handle where another does, and answers the same way
 *   before its error goes out; one whose start failed names nothing and
 *   binds nothing.
 *   `priorErrorId` (string or `null`) is the `errorId` of the turn
 *   error the buffer held when the user sent, `null` when it held none, read
 *   at the send: admitting the prompt clears the session's error only while
 *   it is still that one, so an error raised after the send, the start of
 *   the attach a prompt naming no handle makes among them, stays
 *   (OW-jokoto). Absent, the server takes whatever error it holds when the
 *   prompt arrives.
 * Every request on a live session below, from `sessions/abort` on but
 * `sessions/close` and `sessions/detach`, takes `{ session, view }`, and the
 * helper sends the server the handle the view is bound to, which the server
 * refuses `not_attached` once it has ended, so a request that crosses a
 * close and a re-attach cannot land on the new session (D31 point 9); one
 * from a view bound to none the helper refuses `not_attached` itself.
 * `session` goes nowhere.
 *
 * - `sessions/abort` -- `{ session, view }` -> `null` for a stop that took nothing
 *   out of the backend's queue, or `{ queued }` for one that did: the
 *   server's own `AbortResponse`, the text of each prompt steered into the turn
 *   and not yet delivered, which only Pi holds, for the buffer that stopped
 *   it to take back (D16, OW-wisifo). No notification carries them.
 * - `sessions/compact` -- `{ session, view }` -> `null`. While it is out,
 *   a `sessions/prompt`, a `sessions/forkAndPrompt` or a second
 *   `sessions/compact` from `view` is refused `busy`, as the browser's
 *   `compacting` holds Send and Compact from the click to the reply; from
 *   before the reply the session's `compaction` says one runs, until it
 *   ends (D32 point 4).
 * - `sessions/close` -- `{ session, view }` -> `null`. Kills the
 *   subprocess of the session `session` names; the server's `ended` for its
 *   handle, written ahead of the reply, unbinds the view and stops this
 *   session's notifications.
 * - `sessions/dismissError` -- `{ session, view, errorId }` -> `null`. Clears the
 *   session's turn error, so later `session/snapshot`s carry `error: null`,
 *   but only while `errorId` (string) still names the error the server
 *   holds: a newer one survives the dismissal of the one Emacs was showing
 *   (OW-desufa), even one with the same text (OW-jokoto).
 * - `sessions/detach` -- `{ session, view }` -> `null`. Stops
 *   showing a session, and does nothing else: nothing goes to the server, and the
 *   session goes on running on the server. Sent when a buffer is killed,
 *   and for a Pi fork's parent at an edit's send. Every attach from `view` still out is given
 *   up: its reply still goes out, and no snapshot answers it. The view's
 *   binding goes, and the notifications under its handle stop. Until D32 it
 *   carried `tokens`, every attach its buffer and every buffer it absorbed
 *   had sent, and the notifications under a handle stopped once every token
 *   answered under it was released (OW-nowihu).
 * - `sessions/setModel` -- `{ session, view, model }` -> `null`. A chosen effort the
 *   new model does not list falls back to that model's `defaultEffort`, or
 *   where that is `null` to whatever the backend then picks, which the
 *   `session/status` that follows reports.
 * - `sessions/setName` -- `{ session, view, name }` -> `null`. Names the session,
 *   written through to its backend, which holds it; agentpane keeps no copy
 *   (D13, "Names are not marks"). Only an attached session can be named:
 *   the server refuses any other `not_attached`, and a `name` empty once
 *   trimmed `bad_request`; line breaks in it become one space.
 *   The name arrives in the listing the
 *   `sessions/changed` that follows asks for.
 * - `sessions/setEffort` -- `{ session, view, effort }` -> `null`. `effort` is one of
 *   the session's model's `efforts` ids, taking effect from the next turn;
 *   the server refuses any other `bad_request`, and any at all while that
 *   model lists none or is not yet known.
 * - `sessions/forkAndPrompt` -- `{ session, view, index, text, images?,
 *   forkView, stops? }` -> `{ session, disposition }`. An edit of an earlier message as one
 *   server operation (D30): fork at the user message whose transcript
 *   `index` this is, attach the fork, and prompt it with `text`, clearing no
 *   turn error. `session` in the result is the fork's summary, with its
 *   `handle`, and `disposition` is `"started"` or `"handled"`, as
 *   `sessions/prompt`'s. An index no fork point names is refused
 *   `not_a_fork_point` and nothing forked. A failure after the fork was
 *   created carries `fork`, `{ ref, handle }`, in its `data`, `handle` being
 *   `null` where the fork's own start failed; the server removes nothing.
 *   `view` is the edit's buffer, whose binding names the session forked;
 *   `forkView` (integer) is the buffer agentpane-mode made for the fork
 *   before sending (D32 point 3). It is also an attach of the fork for
 *   `forkView`: the `session/snapshot` under the fork's handle binds it,
 *   sent as for `sessions/attach` and before the reply. A refusal that
 *   names a fork under a handle answers the same way before its error goes
 *   out; one that names none, or no fork, answers nothing.
 *   It is `view`'s send still out, so a `sessions/prompt` from `view`
 *   meanwhile is refused `busy`, as it is itself while a `sessions/compact`
 *   from `view` is out, and while it is out an attach, or a
 *   by-ref prompt, of the session forked, by the ref it names or the one
 *   the helper holds under the handle, is refused `forking` from any view
 *   (D30, D32 point 4). Until ark3/agentpane#71 agentpane-mode refused its
 *   own buffer's attach meanwhile, and nothing refused another's.
 *   Until ark3/agentpane#51 it attached nothing.
 *   `stops` (boolean, absent meaning false) says the edit's hint read the
 *   fork as stopping a running turn (`forkStopsTurn` on
 *   `session/forkPoints` below): the turn-done
 *   watch on `view`'s handle goes as the request goes out, raising nothing
 *   for the turn the fork stops, as the browser reads `stopsBeforeFork`.
 *   The fork's watch is armed at the reply, unless the prompt was handled
 *   (`session/turnEnded` below).
 *
 * Errors: a request the server refused answers with `-32000` as `code`, the
 * server's text as `message`, and `{ error, detail }` as `data`, `error`
 * being the refusal's code (D31 point 2) and `detail` its text, and `fork`
 * or `attached` beside them where the refusal has one
 * (`sessions/forkAndPrompt`, `sessions/prompt`), so a mid-turn prompt
 * rejection reads in Emacs as it does in the browser. One that would start
 * an agent -- `sessions/attach`, `sessions/create`, a `sessions/prompt`
 * naming no handle, and the fork `sessions/forkAndPrompt` made -- is refused
 * `at_capacity` when D12's cap is reached and no live session may be closed
 * for it, its `message` saying so, and `start_timeout` when the agent's
 * start outruns the server's deadline, the agent stopped and nothing left
 * (D35). `sessions/attach` and a `sessions/prompt`
 * naming no handle are refused `turn_running` when the session's turn is
 * still running on a backend that holds it elsewhere (D34), its `message`
 * saying so and nothing started. A request that never
 * reached the server is refused the same way, with a code of the helper's
 * own: `unreachable` for one read with the socket not up, `frame_too_large`
 * for one over the server's frame limit, and `unauthorized`, its `message`
 * naming the token file, for each one out when the server refused the
 * token. Any other failure is `-32603` with its message and no `data`, and
 * says nothing of whether the server acted on the request; an unknown
 * method is `-32601`. A request on a live session from a view bound to no
 * handle is refused `not_attached` by the helper, its `message` saying so.
 * Two more of the helper's own refusals reach no server (D32 point 4):
 * `busy`, for a prompt or a fork and prompt from a view whose send or
 * compact is still out, or a compact from one whose compact is, and
 * `forking`, for an attach or a by-ref prompt of a session
 * a fork and prompt still out forks. A prompt that waited on its view's
 * attach is refused with that attach's refusal, or `not_attached`.
 * A request still out when the socket closes, at the
 * end of the helper's input or the server's going, is answered before the
 * helper exits with `-32001`, its message saying the connection closed,
 * and no `data` (`runHelper` in helper.ts, D32 point 7): like `-32603`, it
 * says nothing of whether the server acted on the request, and is never a
 * refusal. At a socket close it follows the `session/turnEnded` the close
 * raises.
 *
 * Notifications, by `method`, with `params`; each names the session it is
 * about and the view it is for, and none arrives for a session no view is
 * bound to, except `sessions/changed` and `session/turnEnded`; the first
 * under a view's handle is the `session/snapshot` that binds it. Emacs
 * drops one for a view no buffer holds, but `session/turnEnded`, which it
 * reads before any view:
 *
 * - `session/snapshot` -- `{ session, view, handle, nodes, isStreaming, compaction,
 *   model, effort, defaultEffort, unrestoredModel, error, errorId, notices }`.
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
 *   The snapshot that answers an attach is the first notification under
 *   the view it binds; it is sent under the view that asked, whatever ref
 *   it names, and the view, not the reply, is what binds it (OW-rebawa).
 *   Until D32 it carried that attach's `token`, and until OW-wukako
 *   `askedFor`, the ref asked for. Nor could the receiver rely on handling
 *   the reply first -- as of jsonrpc.el 1.0.29 on Emacs 31.1, the reply to
 *   an asynchronous request that arrives while a synchronous one is
 *   outstanding runs only once that one returns, while notifications are
 *   handled at once (docs/MANUAL_TESTING.md, "jsonrpc.el runs an async reply
 *   after later notifications").
 * - `session/node` -- `{ session, view, handle, node }`. One node to replace by
 *   `index`.
 * - `session/status` -- `{ session, view, handle, isStreaming, compaction, model,
 *   effort, defaultEffort, unrestoredModel }`.
 * - `session/error` -- `{ session, view, handle, message, errorId }`. A turn error.
 *   `errorId` (string, opaque) names this raise: two with the same
 *   `message` are two errors, and `sessions/dismissError` and
 *   `sessions/prompt` name the one the buffer showed by it (OW-jokoto). No
 *   server mints one twice, a restarted one included, so one a buffer kept
 *   across a restart names nothing the new process raised. Every later
 *   `session/snapshot` carries it again, in `error` and `errorId`, until it
 *   is cleared, which `session/errorCleared` says.
 * - `session/errorCleared` -- `{ session, view, handle }`. The server no longer
 *   holds the session's turn error: a prompt that started or joined a turn
 *   was admitted over it, it being still the one its sender held, or a
 *   client dismissed it by its `errorId` (OW-jopifu, OW-jokoto). Drop its
 *   line. It follows every
 *   snapshot sent before the clear on the one ordered stream, so a line such
 *   a snapshot drew again goes with it; one Emacs never drew is nothing to
 *   drop.
 * - `session/notice` -- `{ session, view, handle, notice }`. Something non-fatal the
 *   backend said (OW-tujiya), never a turn error: `notice` is the server's
 *   `AgentNotice` unchanged -- `kind` (string, the backend's own name for
 *   it), `message` (string, the text to show, which may span lines, each
 *   drawn as a line), `details` (string or `null`, further guidance) and
 *   `path` (string or `null`, the file it is about, with `:LINE:COLUMN`
 *   where the backend named a place in it). The Codex and Pi adapters
 *   produce them; Claude Code's does not. Every later `session/snapshot`
 *   carries it again, in `notices`.
 * - `session/detached` -- `{ session, view, handle }`. Nothing more comes
 *   under `handle`, and the helper has unbound `view`: either the
 *   server let go of the handle and said so with an `ended` under it -- a
 *   close, by another client or this one, or on Pi a fork moving the
 *   process onto a conversation of its own (D26) -- or the session's `seq`
 *   gapped, and the helper detaches that one session rather than attach it
 *   again (D25 point 5, OW-filuge): the handle stays live on the server,
 *   and a turn running under it may go on unheard. `session` is the ref it
 *   last named the session by. The view's buffer lets go of the handle and
 *   counts itself detached and not streaming, keeping its ref and what it
 *   drew; its next `sessions/attach`, by that ref, is answered under
 *   whatever handle and ref the session has now, if any, as a first attach
 *   is. Until D32 point 6 it carried `cause`, `"ended"` or `"gapped"`,
 *   which agentpane-mode's turn-done watch read (OW-kutome).
 * - `session/turnEnded` -- `{ session, handle, watched, view? }`. A turn
 *   ended in the live session under `handle`, whether or not a view of
 *   Emacs's is bound to it, and `view` (integer) names the one that is, if
 *   any. Sent wherever the session's `isStreaming` falls from true to false
 *   after one read true, every live session included (D32 point 6), as the
 *   browser's row marks fold it (`foldSessionTurns`); a false that follows
 *   no true is no turn's end. `watched` (boolean) says this Emacs's prompt
 *   was watching that turn, as the browser's favicon watch does
 *   (`src/client/favicon.ts`): a prompt or a fork and prompt arms the
 *   watch where none stands, from the session's level as it goes, and its
 *   refusal or a `handled` disposition takes down only a watch it armed.
 *   The watch also raises, `watched` true, for a turn seen streaming whose
 *   handle the server's `ended` let go of, ahead of the `session/detached`
 *   under it, and for each turn seen streaming when the socket closes,
 *   before the helper exits (D31 point 6). It raises nothing, and goes,
 *   at a `seq` gap, at the view's `sessions/detach`, at a close's reply,
 *   at the end of the helper's input (D25 points 4 and 5), and with
 *   `sessions/forkAndPrompt`'s `stops`.
 *   The watch on a handle and what has been seen are agentpane-mode's to
 *   draw: it marks the session's row unless a window shows the session,
 *   and raises its indicator for a turn watched in a buffer no window
 *   shows.
 * - `session/forkPoints` -- `{ session, view, handle, indices,
 *   forkStopsTurn }`. The transcript indices the session can be forked at,
 *   `indices` an array of integers, each a fork point's `index`, which
 *   names a node's `index`; and `forkStopsTurn` (boolean) whether a fork
 *   of the session stops a turn running when it lands, which is what
 *   "Stop and fork" reads (D30). The helper fetches them through the
 *   server's `sessions/forkPoints` at each `session/snapshot` it sends the
 *   view and wherever the session's `isStreaming` changes, at most one
 *   fetch out per handle, and sends each answer under the view bound to
 *   the handle when it lands, if one is; a failed fetch sends nothing, and
 *   the last set stands (D33 point 4). Until one arrives the view's set is
 *   unknown, and every user message is offered, as the browser offers
 *   each while its set is unknown. None is sent for an unbound view.
 *   Until ark3/agentpane#76 agentpane-mode asked for them by a
 *   `sessions/forkPoints` request at the press.
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
	ModelInfo,
	PromptRequest,
	PromptResponse,
	SessionRef,
	SessionSummary,
} from "$shared/protocol.ts";

/**
 * What a per-session request names its session by: the ref, and the view
 * that sends it, the integer agentpane-mode named its transcript buffer by
 * (D32 point 1). The helper fills in the handle from the view's binding.
 */
export interface ViewParams {
	session: SessionRef;
	view: number;
}

/** The reply to a request that attaches, naming the view that holds the session where another does (D32 point 2). */
type Naming<T> = T & { view?: number };

export interface HelperRequests {
	"sessions/list": { params: { cwd?: string }; result: SessionSummary[] };
	"sessions/preview": { params: { session: SessionRef }; result: TranscriptNode[] };
	"sessions/create": { params: CreateSessionRequest & { view: number }; result: Naming<SessionSummary> };
	"models/list": { params: { backend: BackendId }; result: ModelInfo[] };
	"sessions/attach": { params: ViewParams; result: Naming<SessionSummary> };
	"sessions/prompt": {
		params: ViewParams & Omit<PromptRequest, "handle"> & { live?: boolean };
		result: Naming<{ disposition?: "handled" }> | null;
	};
	"sessions/abort": { params: ViewParams; result: AbortResponse | null };
	"sessions/compact": { params: ViewParams; result: null };
	"sessions/close": { params: ViewParams; result: null };
	"sessions/dismissError": { params: ViewParams & DismissErrorRequest; result: null };
	"sessions/detach": { params: ViewParams; result: null };
	"sessions/setModel": { params: ViewParams & { model: string }; result: null };
	"sessions/setEffort": { params: ViewParams & { effort: string }; result: null };
	"sessions/setName": { params: ViewParams & { name: string }; result: null };
	"sessions/forkAndPrompt": { params: ViewParams & ForkAndPromptRequest & { forkView: number; stops?: boolean }; result: Naming<ForkAndPromptResponse> };
}

export interface SessionStatusParams {
	session: SessionRef;
	view: number;
	handle: string;
	isStreaming: boolean;
	compaction: "requesting" | "running" | null;
	model: string | null;
	effort: string | null;
	defaultEffort: string | null;
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
			};
	  }
	| { method: "session/node"; params: { session: SessionRef; view: number; handle: string; node: TranscriptNode } }
	| { method: "session/status"; params: SessionStatusParams }
	| { method: "session/error"; params: { session: SessionRef; view: number; handle: string; message: string; errorId: string } }
	| { method: "session/errorCleared"; params: { session: SessionRef; view: number; handle: string } }
	| { method: "session/notice"; params: { session: SessionRef; view: number; handle: string; notice: AgentNotice } }
	| { method: "session/detached"; params: { session: SessionRef; view: number; handle: string } }
	| { method: "session/turnEnded"; params: { session: SessionRef; handle: string; watched: boolean; view?: number } }
	| {
			method: "session/forkPoints";
			params: { session: SessionRef; view: number; handle: string; indices: number[]; forkStopsTurn: boolean };
	  }
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
