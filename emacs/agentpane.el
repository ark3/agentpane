;;; agentpane.el --- Native Emacs client for agentpane sessions  -*- lexical-binding: t; -*-

;; Copyright (C) 2026 Abhay Saxena

;; This file is not part of GNU Emacs.

;; Package-Requires: ((emacs "31.1"))

;;; Commentary:

;; The native agentpane mode (D22): a session picker (OW-wavone) and a
;; transcript buffer that is also a client (OW-gunuke).  It talks to the
;; helper `bun run src/emacs/main.ts' -- JSON-RPC 2.0 with Content-Length
;; framing over stdio, which Emacs's bundled `jsonrpc.el' speaks -- and the
;; helper is a client of the agentpane server's socket on loopback.  One helper per
;; Emacs, started lazily and shared by every buffer.  Browsing spawns no
;; agent subprocess, since `sessions/preview' reads the stored transcript
;; and opens no stream; attaching a session does, on the server's side.
;;
;; Set `agentpane-project-directory' to the agentpane checkout and run
;;
;;     M-x agentpane-sessions
;;
;; for the picker: one row per stored session, `RET' opens its transcript,
;; `g' refetches, and a `sessions/changed' notification refetches too.  The
;; list is filtered to the project of the buffer the command was called
;; from, over a listing of every session, as the browser's sidebar filters;
;; a prefix argument lifts the filter, and `w' in the picker chooses another
;; workspace the listing carries, or every session.  The notification flows from the picker's first listing on,
;; whether or not any buffer has attached a session: the helper opens its
;; socket at the first request it reads, the picker's `sessions/list'
;; (src/emacs/helper.ts).  A row's dot
;; says its session is streaming; a red one, that a turn ended while no
;; window showed its transcript, until one does.  In a transcript buffer
;; `n' and `p' step between nodes, `TAB' toggles the fold at point, `g'
;; refetches, `a' attaches a previewed transcript, sending nothing, and
;; moves point to the prompt region, as the browser's Attach does,
;; `o' opens a child thread the subagent call at point names, previewing
;; it as the picker's `RET' does, as the browser's Open thread does,
;; `e' or `f' takes the user message at point, if it carries the ✎ that
;; marks a message the session can be forked at, back into the prompt
;; region to edit, as the browser's pencil does, so that `C-RET' forks at
;; that message and sends the edited text and the message's images into
;; the fork, opened in a buffer of its own -- on a previewed transcript it
;; attaches first, and edits at the next press -- and
;; `C-c C-k' abandons the edit -- `C-c C-e' does as `e' does on the last
;; user message, wherever point is, and on a streaming Pi turn stops the
;; turn too, as the browser's Edit last message and Stop and edit do --
;; `r' toggles reading view, and `q' buries.
;; Reading view is the browser's (`condense' in
;; src/client/render/transcript.ts): tool calls, tool results and thinking
;; are elided, and while a turn streams the line above the prompt names the
;; tool or thinking it is running.  It is per buffer and not kept, and the
;; mode line says when it is on.  Killing a transcript buffer stops its
;; session's notifications and leaves the session running on the server;
;; `C-c C-q' (`agentpane-close-session') ends the session's subprocess
;; instead, as the browser's Tools Detach does, while no turn runs, and
;; leaves the buffer previewing the stored transcript, or kills it when
;; there is none on disk.
;;
;; `M-x agentpane-new-session' asks for a backend, creates a session in the
;; current buffer's project, opens it attached and asks for one of the
;; backend's models, then one of that model's efforts when it offers any;
;; the first prompt on a previewed transcript attaches it.  Once attached,
;; the helper's notifications drive the buffer: a snapshot redraws every
;; node, a node update redraws the node with its index or appends it, and
;; the mode line shows streaming, compaction, the model and its effort,
;; the model's default one when the session reports none.  When the
;; helper's socket closes, the helper exits, and every buffer it served
;; is left detached (D25).  A prompt is
;; typed in the region below the last node, or in the composer
;; `M-x agentpane-prompt' opens below the transcript; in both `RET' inserts
;; a newline and `C-RET' sends, `C-c C-a' aborts the running turn, and
;; `C-c C-e' edits the last user message in the transcript's prompt region.
;; A turn sent from this Emacs that ends while no window shows its buffer
;; puts a red `●agentpane' in every mode line, until a window shows it.
;; A buffer holds one turn error, the one the server holds: a newer one
;; replaces it, and it goes when the server says it cleared it, at the
;; admission of a prompt sent over it that started or joined a turn, this
;; buffer's own included, or at any client's dismissal, or when a snapshot
;; arrives without it.  The
;; buffer drops it without waiting only when `C-c C-d' in the transcript
;; buffer dismisses it.
;; `M-x agentpane-compact' compacts, and `M-x agentpane-set-model' and
;; `M-x agentpane-set-effort' set the model and its reasoning effort, but
;; only before the first prompt.
;; `M-x agentpane-rename-session' names an attached session between turns,
;; and the picker labels its row by that name.
;; `M-x agentpane-shutdown' stops the helper; the next command that needs
;; it starts a fresh one.
;;
;; Nothing beyond what Emacs ships is required: text parts are drawn through
;; `shr' from the HTML the helper sends beside each part's markdown source,
;; the very string the browser renders (`renderMarkdown' in
;; src/client/render/markdown.ts).  The node contract is the docblock of
;; src/emacs/protocol.ts; `jsonrpc.el' hands each node over as a plist with
;; keyword keys, arrays as vectors, JSON null as nil and false as
;; `:json-false', and the drawing functions below take exactly that shape.
;;
;; Drawing a fixed node list into a buffer, notifications driving it through
;; no process at all, the helper connection against a fake helper
;; (emacs/fake-helper.ts), and `agentpane-shutdown' against the real one
;; are covered by `ert' tests in agentpane-test.el, which need `bun'
;; on the PATH and `bun install' done, run from the repository root with
;;
;;     emacs --batch -L emacs -l ert -l agentpane -l agentpane-test \
;;       -f ert-run-tests-batch-and-exit
;;
;; which on Emacs 31.1 (measured 2026-09-29) ends, after one "passed" or
;; "skipped" line per test, with a line beginning
;;
;;     Ran 219 tests, 216 results as expected, 0 unexpected, 3 skipped
;;
;; followed by the run's timestamp and duration.  It is not part of `bun run check',
;; which stays Bun-only.
;;
;; The three it skips are tagged `tty': they drive `vertical-motion', which
;; cuts a long fold header in three layouts where a binary search takes one
;; per step, and which on Emacs 31.1 (measured 2026-09-25) does not move in
;; batch Emacs.  They run in a tty Emacs that `script' gives a terminal,
;; pinned to 80 by 24, with the terminal's drawing thrown away and ERT's
;; report sent to standard error by `agentpane-test-run-tty':
;;
;;     timeout 60 env TERM=xterm-256color script -qec 'stty cols 80 rows 24; \
;;       emacs -nw -Q -L emacs -l ert -l agentpane -l agentpane-test \
;;       -f agentpane-test-run-tty 2>&3' /dev/null 3>&2 >/dev/null </dev/null
;;
;; which on Emacs 31.1 and util-linux 2.42.3 (measured 2026-09-25) ends,
;; after one "passed" line per test, with a line beginning
;;
;;     Ran 3 tests, 3 results as expected, 0 unexpected
;;
;; and exits 0, 1 when a test fails, or 2 when the run itself signals.  The
;; `timeout' is what ends a run that cannot start: a file that signals as
;; it loads leaves `emacs -nw' waiting at its echo area, and the command
;; exits 124 with nothing else to show for it.

;;; Code:

(eval-when-compile (require 'cl-lib))
(require 'diff-mode)
(require 'dom)
(require 'ewoc)
(require 'iso8601)
(require 'jsonrpc)
(require 'project)
(require 'shr)
(require 'tabulated-list)
(require 'text-property-search)
(require 'visual-wrap)

;;;; Customization and faces

(defgroup agentpane nil
  "Native Emacs client for agentpane sessions."
  :group 'applications)

(defcustom agentpane-project-directory "~/projects/agentpane"
  "The agentpane checkout the helper command runs in.
`bun run src/emacs/main.ts' is resolved against it."
  :type 'directory)

(defface agentpane-role-other
  '((t :inherit font-lock-type-face :weight bold))
  "Face for the role line of a node whose role is not user, assistant,
compactionSummary or system, which draw none.")

(defface agentpane-tool
  '((t :inherit font-lock-doc-markup-face))
  "Face for a tool call's name and thinking's label on a fold header, after
agent-shell's `agent-shell-section-heading', which its tool calls and
thinking share.")

(defface agentpane-tool-ok
  '((t :inherit success))
  "Face for the mark of a tool call that finished: agent-shell's
`agent-shell-success'.")

(defface agentpane-thinking
  '((t :inherit shadow :slant italic))
  "Face for a thinking part.")

(defface agentpane-dim
  '((t :inherit shadow))
  "Face for the meta line and other secondary text.")

(defface agentpane-warning
  '((t :inherit warning))
  "Face for an aborted or errored turn and an errored tool call.")

(defface agentpane-notice
  '((t :inherit shadow))
  "Face for a backend's non-fatal notice, set apart from a turn error.")

(defface agentpane-turn-finished
  '((((background dark)) :foreground "#ff6b75")
    (((background light)) :foreground "#d63b45"))
  "Face for the picker's mark on a session whose turn finished unseen, and
for the mode line's turn-done indicator: the browser's
`--ap-turn-finished' for each theme (`src/client/app.css'), a first cut
to judge from use there as here.")

(defface agentpane-prose
  '((t :inherit variable-pitch))
  "Face the buffer's `default' is remapped to: proportional prose at the same
size as the owner's markdown buffers.  Code, tables and diffs stay monospace
by inheriting `fixed-pitch'.")

(defface agentpane-user-box
  '((((background dark)) :background "#21252c" :extend t)
    (((background light)) :background "#f1f3f6" :extend t))
  "Face tinting a user turn, the browser's one raised surface in the transcript:
its `--ap-surface-raised' for each theme (`src/client/app.css').
Appended under the text's own faces, so it supplies only the background.")

(defface agentpane-user-bar
  '((((background dark)) :foreground "#7f9dff")
    (((background light)) :foreground "#3959d9"))
  "Face for the accent bar down the left edge of a user turn, after the
browser's `border-left' on `.msg.user', in its `--ap-accent' for each theme.")

(defface agentpane-meta
  '((t :inherit shadow :height 0.8))
  "Face for an assistant turn's meta line: the browser's `.meta', small and subtle.")

(defface agentpane-code-block
  '((((background dark)) :background "#1b1f27" :extend t)
    (((background light)) :background "#f5f6f8" :extend t))
  "Background behind a fenced code block drawn through shr, after the
browser's tinted `pre.ap-code'.  The browser sinks it below its page; the
owner's dark theme is already darker than that page, so here the block
lifts instead, a step under the user turn's surface.  The first tint,
\"#161b22\", was too close to the theme's \"#0E1415\" to read (2026-09-22).")

;; The typography copies `Markdown.svelte''s stylesheet, each number a ratio
;; to the browser's body size (`--ap-text-md', 0.9375rem): headings at
;; 1.25rem, 1.0625rem and the body size, all weight 600; tables at
;; 0.8125rem; code at 0.9em, inline code on the raised surface; table
;; headers on the raised surface.  Emacs `:height' floats compose the same
;; way `em' does, so each face states its ratio and inherits the rest.

(defface agentpane-h1
  '((t :weight bold :height 1.333))
  "Face for a level-one heading drawn through shr: the browser's `h1'.")

(defface agentpane-h2
  '((t :weight bold :height 1.133))
  "Face for a level-two heading drawn through shr: the browser's `h2'.")

(defface agentpane-h3
  '((t :weight bold))
  "Face for a heading of level three or below drawn through shr: the browser
gives those the body size and only the weight.")

(defface agentpane-table
  '((t :height 0.95))
  "Face for a table's cells drawn through shr, a little under the prose size,
after the browser's `table' at `--ap-text-sm'.  The stylesheet's exact ratio,
0.867, gave 14px under 18px prose and read too small to the owner on
2026-09-22, and 0.9 of the 10pt prose is 9pt, the code size, 15px; 0.95 is
the step between, 16px.  Bound as shr's current font while the table is laid
out, so the column widths are measured at this size.")

(defface agentpane-th
  '((t :inherit bold))
  "Face for a table header cell drawn through shr: bold, and nothing else.
The browser's raised surface behind it was tried on 2026-09-22 and the
owner found it did not fit the look.")

(defface agentpane-code
  '((t :inherit fixed-pitch))
  "Face for code drawn through shr, inline or fenced.
Its size comes from the buffer-local remap of `fixed-pitch' that
`agentpane-transcript-mode' installs; see there.")

(defface agentpane-inline-code
  '((((background dark)) :inherit agentpane-code :background "#1f2733")
    (((background light)) :inherit agentpane-code :background "#eef2f8"))
  "Face for inline code drawn through shr: `agentpane-code' on the
raised surface, after the browser's `:not(pre) > code'.")

(defconst agentpane--hljs-faces
  '(("hljs-keyword" . font-lock-keyword-face)
    ("hljs-built_in" . font-lock-builtin-face)
    ("hljs-type" . font-lock-type-face)
    ("hljs-literal" . font-lock-constant-face)
    ("hljs-number" . font-lock-constant-face)
    ("hljs-symbol" . font-lock-constant-face)
    ("hljs-string" . font-lock-string-face)
    ("hljs-regexp" . font-lock-string-face)
    ("hljs-comment" . font-lock-comment-face)
    ("hljs-doctag" . font-lock-doc-face)
    ("hljs-meta" . font-lock-preprocessor-face)
    ("hljs-title" . font-lock-function-name-face)
    ("hljs-function" . font-lock-function-name-face)
    ("hljs-section" . font-lock-function-name-face)
    ("hljs-name" . font-lock-function-name-face)
    ("hljs-tag" . font-lock-function-name-face)
    ("hljs-attr" . font-lock-variable-name-face)
    ("hljs-attribute" . font-lock-variable-name-face)
    ("hljs-variable" . font-lock-variable-name-face)
    ("hljs-params" . font-lock-variable-name-face)
    ("hljs-property" . font-lock-property-name-face)
    ("hljs-selector-tag" . font-lock-keyword-face)
    ("hljs-selector-class" . font-lock-type-face)
    ("hljs-selector-id" . font-lock-type-face)
    ("hljs-addition" . diff-added)
    ("hljs-deletion" . diff-removed)
    ("hljs-emphasis" . italic)
    ("hljs-strong" . bold))
  "The highlight.js class names the browser's code blocks carry, each with
the face it draws in here, since `shr' ignores classes and there is no
stylesheet.  Roughly the browser's theme, by role rather than by colour.")

(defconst agentpane--bar "▌ "
  "The accent bar and the gap after it, carried as `line-prefix' and
`wrap-prefix' on every line of a user turn so wrapped rows keep it.")

;;;; The helper connection

(defvar agentpane--connection nil
  "The `jsonrpc-process-connection' to the helper, once started.")

(defun agentpane--start-helper ()
  "Start the helper process in `agentpane-project-directory'.
The stderr buffer is named as `jsonrpc-process-connection' expects for a
connection named \"agentpane\", so the helper's own stderr lands there."
  (let ((default-directory
         (file-name-as-directory (expand-file-name agentpane-project-directory))))
    (make-process :name "agentpane helper"
                  :command '("bun" "run" "src/emacs/main.ts")
                  :connection-type 'pipe
                  :noquery t
                  :stderr (get-buffer-create "*agentpane stderr*"))))

(defun agentpane--connection (&optional dead)
  "The connection to the helper, started on first use.
A helper starts only once the last one's teardown has run, which alone
forgets it (`agentpane--helper-gone'); until then, one that has exited
is refused with an error, and nothing is started or sent -- or, with
DEAD non-nil, returned for the caller to send nothing through.  Its
process reads as not live before its sentinel has run, which it does
only once Emacs next waits (Emacs 31.1, measured 2026-09-28; OW-toyupa),
so this is met only by code running in the same command or timer pass
as the death, or by a handler of what the helper wrote last, which runs
before the teardown; see `agentpane--helper-exited'.
`agentpane--request' passes DEAD, and sends nothing through it: those
handlers run in jsonrpc.el's timers, and a request one chained signalled
out of it, which Emacs reported as `Error running timer' (OW-hiliti).
The error stays for the synchronous `jsonrpc-request's of
`agentpane--attach-now', `agentpane-new-session' and the model and
effort readers, each run by a command, where it names why input typed
ahead of the teardown did nothing.
Started there instead, a replacement stood beside a connection buffers
were still attached through, and the teardown missed a buffer re-attached
through it, a late attach reply bound a buffer to it, and a late reply
could carry the id of a request sent through it (OW-bukupu)."
  (cond
   ((null agentpane--connection)
    (setq agentpane--connection
          (make-instance 'jsonrpc-process-connection
                         :name "agentpane"
                         :process #'agentpane--start-helper
                         :notification-dispatcher #'agentpane--on-notification
                         :on-shutdown #'agentpane--helper-exited)))
   ((and (not dead) (not (jsonrpc-running-p agentpane--connection)))
    (error "The agentpane helper has exited")))
  agentpane--connection)

(defun agentpane--helper-exited (connection)
  "Tear CONNECTION down once what its helper wrote last has been handled.
The connection's `:on-shutdown', which its sentinel calls.  Emacs reads
what a dead process wrote before it runs the sentinel, and jsonrpc.el
hands each message on from a zero-delay timer, so at the sentinel the
helper's last messages are queued but not yet handled; the zero-delay
timer started here runs after them (Emacs 31.1, jsonrpc.el 1.0.29,
measured 2026-09-28).  So they are handled while CONNECTION is still
current, and reach the buffers it served: the node the helper flushes
before it exits at a drop is drawn (OW-mepufi), and a buffer's last
status is read before the teardown reads it idle (OW-bukupu).  Run at
the sentinel, the teardown let go of the buffers first, and those
messages then found a buffer by its ref and bound the dead helper's
handle to it again."
  (run-at-time 0 nil #'agentpane--helper-gone connection))

(defvar agentpane--handle)
(defvar agentpane--sending)
(defvar agentpane--fork-sent)

(defun agentpane--helper-gone (connection)
  "Tear down CONNECTION, the helper's, which has exited: forget it, and
leave each transcript buffer attached through it, by a snapshot it sent
\(`agentpane--attached'), detached, through `agentpane--let-go', a
helper that crashed over a live server being rare and costing an attach
\(D25), since `g' previews a buffer not attached (D26).  The teardown
raises no turn-done indicator: the helper raises each watched turn seen
streaming as `session/turnEnded' before it exits at its socket's close,
and nothing at the end of its input, as `agentpane-shutdown' ends it, or
at a crash (D32 point 6, D25 point 4).
A buffer made for a create or a fork that no snapshot has filled
\(`agentpane--made-before') is killed, since none will fill it now.
Run from its sentinel, behind what the helper wrote last; see
`agentpane--helper-exited'.  Only this forgets a connection, and no
helper starts before it has (`agentpane--connection'), so every buffer
attached through a helper is attached through the one being torn down,
and CONNECTION is still `agentpane--connection' here.
The helper exits when its socket closes or its first open fails, so
this is also how a server that went away reaches the buffers (D25).

It also resets, in every transcript buffer, what a request in flight
holds there, since a request the helper did not answer before it exited,
as a crash leaves one, will never be answered (D32 point 7):
`agentpane--sending', with the text it held back released
\(`agentpane--release-queued'), and `agentpane--fork-sent'.  A request
the helper answered at its socket's close has run its FAILED already,
among what the helper wrote last.  Until D32 agentpane-mode recorded
every request it sent and answered those still out here, as the death,
one tick later (OW-mopuyi)."
  (setq agentpane--connection nil)
  (dolist (buffer (buffer-list))
    (when (eq (buffer-local-value 'agentpane--attached buffer) connection)
      (with-current-buffer buffer
        (agentpane--let-go)))
    (when (buffer-local-value 'agentpane--session buffer)
      (with-current-buffer buffer
        (setq agentpane--sending nil
              agentpane--fork-sent nil)
        (agentpane--release-queued)))
    ;; Made for a create or a fork that no snapshot has filled, it
    ;; never will be now (D32 point 3).
    (when (and (buffer-live-p buffer)
               (buffer-local-value 'agentpane--session buffer)
               (not (with-current-buffer buffer (agentpane--made-p))))
      (kill-buffer buffer))))

(defun agentpane-shutdown ()
  "Stop the helper, if one is running.
Its stdin is closed first, since that is what the helper exits on
\(`runHelper' in src/emacs/helper.ts); `jsonrpc-shutdown' does not close
it, and after 0.3s without an exit it warns and kills the process.  Once
the helper is reading its input, it exited within 0.1s of the close, even
with its event stream, as it then had, open or an HTTP request of its own
unanswered, which it aborts (Emacs 31.1, bun 1.4.0, measured 2026-09-22;
docs/MANUAL_TESTING.md, OW-bonode and OW-kofuda).
The teardown, which the sentinel defers behind what the helper wrote last
\(`agentpane--helper-exited'), ran within `jsonrpc-shutdown''s wait too,
so the helper is forgotten once this returns (Emacs 31.1, jsonrpc.el
1.0.29, measured 2026-09-28 by `agentpane-test-shutdown-ends-the-helper').
The server keeps a turn running when a client's socket closes, so nothing
is raised for it: the helper tells its input's end from its socket's
close, and raises a watched turn only at the second (D25 point 4, D32
point 6).  Until D32 this marked the process for the teardown to read
\(OW-nuzoto)."
  (interactive)
  (when (and agentpane--connection (jsonrpc-running-p agentpane--connection))
    (process-send-eof (jsonrpc--process agentpane--connection))
    (jsonrpc-shutdown agentpane--connection)))

(defvar-local agentpane--latest-request nil
  "The id of this buffer's most recent request to the helper.")

(defvar-local agentpane--session nil
  "The summary plist of the session this transcript buffer shows.")

(defvar agentpane--views 0
  "The last view id `agentpane--new-transcript' minted.")

(defvar-local agentpane--view nil
  "This transcript buffer's view id, minted when the buffer is made and
never changed (D32 point 1): an integer, unique over this Emacs's life.
Every per-session request the buffer sends carries it, and the helper
sends every per-session notification under it, holding for each view the
handle it is bound to (`sessions/attach' in src/emacs/protocol.ts).
Minted by Emacs, not the helper, so it outlives a helper's death.
Permanent, so that re-running the mode keeps it.")
(put 'agentpane--view 'permanent-local t)

(defvar-local agentpane--handle nil
  "The handle of the live session this transcript buffer holds, or nil.
The server's name for the session's container, which a rename never moves
and a fork does not share (D24): the one the snapshot that attached the
buffer carried, never the attach's reply (OW-rebawa).  No request sends
it, the helper holding the buffer's binding by its view (D32 point 1);
the picker and `agentpane--transcript-buffer' read it.
Nil in a buffer that has not attached.  One the helper detached, by a
`session/detached', lets go of it -- a Pi fork's parent among them,
since the server's `ended' for it goes out inside the fork, ahead of the
reply (D26) -- as does one attached through a helper that has exited
\(D25); see `agentpane--let-go'.")

(defconst agentpane--spawn-timeout 90
  "Seconds to wait for a request that may spawn the session's backend:
`sessions/attach', and since D30 `sessions/create',
`sessions/forkAndPrompt' and a `sessions/prompt' not marked `:live',
which the helper may send by ref; every other command acts on a session
already attached, or is refused (src/server/http/socket.ts).  A
`sessions/prompt' marked `:live' still takes this too, from when its
HTTP route attached first; it now waits only on a backend already
running, and whether it wants
jsonrpc.el's default instead, as `sessions/setModel' takes, has not been
weighed.  Until ark3/agentpane#76 `sessions/forkPoints' took it too.
`sessions/abort' takes it to outlast the server's bound on a Pi stop
\(`agentpane-abort').
Past this the reply is discarded even if it comes, so a request that ran
long but succeeded reads as a failure and leaves the buffer unattached
though its session is live.  jsonrpc.el's default is 10s, and the one
attach measured took 1.138s, a re-attach on `pi 0.85.1' on 2026-09-16,
driven at the HTTP route of the time (docs/MANUAL_TESTING.md, OW-jamoyi);
no cold spawn has been timed.  90s outlasts the server's own deadline on
a start, 60s (`startTimeoutMs' in src/server/http/session-manager.ts,
D35), so a start that hangs reaches the buffer as the server's
`start_timeout' refusal, which leaves nothing running, and not as a
timeout here, which cannot say whether the server acted.
`agentpane-new-session''s synchronous create takes it too, where waiting
blocks Emacs; elsewhere it blocks nothing, and a hung helper costs a
minute and a half before a refused second send is accepted again.")

(defun agentpane--request (method params callback &optional always failed timeout erred)
  "Send METHOD with PARAMS, a plist, to the helper for the current buffer.
Return at once; CALLBACK runs later with the result, in this buffer, unless
the buffer has been killed or has sent a later request since, whose reply
is the one it wants.  An error or a timeout is reported in the echo area.
With no PARAMS the request carries no `params' at all: a null one would
reach the helper as a JSON null, which is not the absence it tests for.
TIMEOUT is in seconds, `jsonrpc-default-request-timeout' when nil.

FAILED, when given, runs with no arguments in this buffer, if it is still
live, after an error or a timeout has been reported, whatever ALWAYS says.
It runs too, and the signal goes on, when sending the request or running
CALLBACK exits non-locally -- the helper failing to start, or a reply's
handling failing partway -- so a flag that FAILED clears never outlives the
request that set it.
ERRED, when given, runs after FAILED with the `data' of the error the
helper answered with, where CALLBACK would have run with a result: in
this buffer, if it is still live, and, unless ALWAYS, has sent no later
request since.  That `data' is the
server's refusal, its `error' code and `detail' (`toRpcError' in
src/emacs/helper.ts), nil for an error the
helper raised itself, so a caller can tell one error code from another,
as `agentpane-refetch' tells a preview's `gone' (D26); a timeout and a
non-local exit carry none and run no ERRED.
Nothing here tells a request that reached no backend from one that may
have: the turn-done watch a prompt arms is the helper's, which only the
server's refusal disarms (D32 point 6).

Each request has one answer, the first of its reply and its timeout;
whatever comes after is dropped.  A request still out when the helper's
socket closes is answered by the helper before it exits, with an error
of its own carrying no `data', the outcome unknown (D32 point 7); that
reply is among what the helper wrote last, which jsonrpc.el hands on
after its sentinel and before the teardown (`agentpane--helper-exited').
The \"Server died\" jsonrpc.el's sentinel calls every pending request's
error handler with carries the code -1, which the helper never writes,
and answers nothing: it reaches only some requests, and a reply read
after it still reaches its request (jsonrpc.el 1.0.29; OW-bukupu,
OW-laluso).  A helper that crashes leaves its requests unanswered, and
nothing here records them: the teardown resets what a request in flight
holds in a buffer (`agentpane--helper-gone').  Until D32 every request
was recorded, and the teardown answered those still out (OW-mopuyi).
A request made through a helper that has exited, before its teardown
-- from a handler of what that helper wrote last, which runs in
jsonrpc.el's timer -- is sent nowhere and signals nothing, which from
that timer Emacs would report as `Error running timer' (OW-hiliti): it
says so once and runs FAILED at once.

With ALWAYS non-nil, CALLBACK runs even when a later request has been sent
since: for a command -- attach, prompt, abort -- whose reply is not a view
that the later request's replaces.  Such a request still supersedes every
earlier one, so a preview refetch still in flight when the buffer attaches
is not drawn over the live transcript.  Every request's answer is
dropped with its buffer, whatever killed it.  Until D32 a buffer a merge
killed passed some answers on to the buffer that absorbed it.

Asynchronous because a synchronous `jsonrpc-request' stalled when another
one nested inside it, as the picker refetch that `sessions/changed' runs
does whenever it lands during a transcript refetch: on Emacs 31.1 with
jsonrpc.el 1.0.29 both replies were in by 0.3s and the outer call still
returned only at its own timeout's deadline, 10s later (OW-bonode; the
ert tests `agentpane-test-nested-refetch-*' provoke it)."
  (let* ((buffer (current-buffer))
         (answered nil)
         id
         (answer (lambda () (unless answered (setq answered t))))
         (connection
          (agentpane--failing (lambda () (when failed (funcall failed)))
                              (lambda () (agentpane--connection t)))))
    (if (not (jsonrpc-running-p connection))
        (progn
          (message "agentpane: %s failed: the helper exited" method)
          (when failed (funcall failed)))
      (setq id (car (agentpane--failing
                     (lambda ()
                       (when (funcall answer)
                         (when failed (funcall failed))))
                     (lambda ()
                       (jsonrpc-async-request
                        connection method (or params :jsonrpc-omit)
                        ;; An explicit nil would mean no timeout at all.
                        :timeout (or timeout jsonrpc-default-request-timeout)
                        :success-fn
                        (lambda (result)
                          (when (funcall answer)
                            (when (buffer-live-p buffer)
                              (with-current-buffer buffer
                                (when (or always (eql id agentpane--latest-request))
                                  (agentpane--failing failed (lambda () (funcall callback result))))))))
                        :error-fn
                        (lambda (error)
                          ;; jsonrpc.el's "Server died" is no reply.
                          (when (and (not (eql (plist-get error :code) -1))
                                     (funcall answer))
                            (message "agentpane: %s failed: %s" method (plist-get error :message))
                            (agentpane--failed buffer failed)
                            (when (and erred (buffer-live-p buffer))
                              (with-current-buffer buffer
                                (when (or always (eql id agentpane--latest-request))
                                  (funcall erred (plist-get error :data)))))))
                        :timeout-fn
                        (lambda ()
                          (when (funcall answer)
                            (message "agentpane: %s timed out" method)
                            (agentpane--failed buffer failed))))))))
      (setq agentpane--latest-request id))))

(defun agentpane--failing (failed fn)
  "Call FN and return its value; should it exit non-locally, call FAILED, if
non-nil, on the way out."
  (let ((done nil))
    (unwind-protect (prog1 (funcall fn) (setq done t))
      (when (and failed (not done))
        (funcall failed)))))

(defun agentpane--failed (buffer failed)
  "Call FAILED, if non-nil, in BUFFER, if it is still live."
  (when (and failed (buffer-live-p buffer))
    (with-current-buffer buffer
      (funcall failed))))

(defvar agentpane--attached)
(defvar agentpane--status)
(defvar agentpane--forkable)

(defun agentpane--on-notification (conn method params)
  "Handle notification METHOD, with PARAMS, from the helper on CONN.
Every one but `sessions/changed' is about one session, and goes to the
transcript buffer whose view it names, if any (`agentpane--notified-buffer').
A `session/snapshot' attaches that buffer, through CONN, under the
snapshot's handle; see `agentpane--attach-by'.  Every notification
gives the buffer its `session' as the
session's ref: the ref is an attribute any notification may move, and
nothing is re-keyed, so a rename needs no handling of its own, and the
helper sends none (OW-mofuho).  A buffer's name never carries the ref
\(OW-mikayi), and neither does its composer's.  A notification no buffer
is found for is dropped.
A `session/node' is recorded rather than drawn; see `agentpane--record'.
Every other notification but a snapshot, whose redraw discards what is
recorded, draws what is recorded first, so it finds the buffer as it
would have had each node been drawn on arrival.
A `session/detached' says the helper sends nothing more under the handle
the buffer holds, the server having let go of it or its `seq' having
gapped, and the buffer lets go of it too; see `agentpane--let-go'.
A `session/forkPoints' is the set the buffer marks and edits from; see
`agentpane--forkable'.
A `session/turnEnded' is read before any buffer is looked for, since it
comes for sessions no buffer shows as well; see `agentpane--turn-ended'."
  (cond
   ((eq method 'sessions/changed)
    (agentpane--revert-pickers))
   ((eq method 'session/turnEnded)
    (agentpane--turn-ended params))
   (t
    (let ((buffer (agentpane--notified-buffer params)))
      (when buffer
        (with-current-buffer buffer
          (when (eq method 'session/snapshot)
            (agentpane--attach-by conn (plist-get params :handle)))
          (agentpane--hold-ref (plist-get params :session))
          (unless (memq method '(session/node session/snapshot))
            (agentpane--draw-recorded buffer))
          (pcase method
            ('session/snapshot
             (agentpane--set-status params)
             (agentpane--keeping-points
              (lambda ()
                (agentpane--draw (plist-get params :nodes)
                                 (agentpane--transcript-header agentpane--session)
                                 (plist-get params :notices)
                                 (plist-get params :error)
                                 (plist-get params :errorId)))))
            ('session/node (agentpane--record (plist-get params :node)))
            ('session/status (agentpane--set-status params))
            ('session/error (agentpane--hold-error (plist-get params :message)
                                                   (plist-get params :errorId)))
            ('session/errorCleared (agentpane--hold-error nil))
            ('session/notice (agentpane--upsert (list :notice (plist-get params :notice))))
            ('session/forkPoints (agentpane--hold-forkable params))
            ('session/detached (agentpane--let-go)))))))))

(defun agentpane--let-go ()
  "Let go of the handle this buffer holds, which will say nothing more to
it: the server let go of it, or its `seq' gapped (`session/detached'),
or the helper it was attached through exited (`agentpane--helper-gone').
The buffer holds no handle and is not attached, and keeps its
ref and what it drew.  Not attached, it is a preview (D26):
`agentpane-refetch' previews it, and a send or `agentpane-attach'
attaches it again, a first attach of whatever handle answers, which the
snapshot under its view binds.  Until OW-vugefa it was marked dropped
instead, and `g' attached it again rather than draw the stored
transcript over the live one it still showed.  It reads as the status
that ends a turn leaves it, nothing streaming or compacting, since
nothing will say so under that handle.
What becomes of the turn-done watch on that handle is the helper's,
which raises a watched turn seen streaming at the server's `ended' and
at its socket's close, as `session/turnEnded', and nothing at a gap or
at the end of its input (D32 point 6).  Until D32 this was told why, as
`ended', `gapped' or `shutdown', and settled the watch itself
\(OW-nuzoto, OW-kutome).
The fork points it was sent go too, and their marks with them, since a
preview draws none (`agentpane--forkable')."
  (agentpane--reforking
   (lambda ()
     (setq agentpane--handle nil
           agentpane--attached nil
           agentpane--forkable nil)))
  (agentpane--read-idle))

(defun agentpane--read-idle ()
  "Show this buffer's session as the status that ends a turn leaves it,
nothing streaming or compacting, for a buffer that nothing will send
another status and that holds no handle; see `agentpane--let-go'."
  (agentpane--set-status
   (plist-put (plist-put (copy-sequence agentpane--status) :isStreaming :json-false)
              :compaction nil)))

(defun agentpane--notified-buffer (params)
  "The transcript buffer a notification with PARAMS is for: the one whose
view it names (`agentpane--view'), or nil when no buffer holds that view,
one killed since the helper sent it.  The helper sends every per-session
notification under the view bound to its handle (D32 point 1), so no
buffer is found by its handle or its ref, and none is made.
Until D32 a snapshot that answered an attach carried the attach's
`token', and the rest went by handle and then by ref, which fed a buffer
only previewing a ref an attached session was renamed onto."
  (agentpane--view-buffer (plist-get params :view)))

(defun agentpane--view-buffer (view)
  "The transcript buffer whose view id is VIEW, or nil."
  (and view
       (seq-find (lambda (buffer) (eql (buffer-local-value 'agentpane--view buffer) view))
                 (buffer-list))))

(defvar-local agentpane--ready-message nil
  "What to say once a snapshot attaches this buffer, a format taking its
name, or nil: set where `agentpane-new-session' made the buffer and
stopped waiting on its create, quit or timed out, so a snapshot that
comes after fills a buffer no one is shown (D32 point 3).")

(defun agentpane--attach-by (conn handle)
  "Attach this buffer under HANDLE, through the helper on CONN, whose
`session/snapshot' says so; see `agentpane--on-notification'.
A buffer is attached exactly when its helper has sent it a snapshot under
a handle and has not since sent `session/detached' for that handle or
exited, either of which lets go of it (`agentpane--let-go').  The
helper binds the buffer's view when it sends the snapshot that answers
the attach, and at nothing else, and the attach's reply only ends the
request (`agentpane--attach').  Bound by the reply as well, the buffer counted
itself attached where the two disagreed, while the helper sent it
nothing: a reply handled after the `session/detached' of a `seq' gap that
followed its snapshot (OW-tifiva), or held back behind a synchronous
request as an \"anxious continuation\" while the helper died, and handed
on after its teardown, to bind the buffer to no helper or to the next one
\(OW-kifuhi).  So the helper's notifications alone say it (OW-rebawa).
The helper binds no handle to two views, so no other buffer holds HANDLE
\(D32 point 2), and no buffers merge.
A buffer carrying `agentpane--ready-message' says it, once.
A HANDLE other than the one it held drops the fork points held for that
one (`agentpane--forkable'), whose indices name another transcript; the
snapshot's redraw, which follows, draws the marks."
  (unless (equal handle agentpane--handle)
    (setq agentpane--forkable nil))
  (setq agentpane--handle handle
        agentpane--attached conn)
  (when agentpane--ready-message
    (message agentpane--ready-message (buffer-name))
    (setq agentpane--ready-message nil)))

;;;; Rendering HTML through shr

(defvar agentpane--in-pre nil
  "Non-nil while shr draws the inside of a pre block, so the `code' handler
leaves a fenced block on the block's own face rather than the inline one.")

(defun agentpane--hljs-face (classes)
  "The face for the first highlight.js class in CLASSES, a class attribute, or nil."
  (seq-some (lambda (class) (cdr (assoc class agentpane--hljs-faces)))
            (split-string (or classes ""))))

(defun agentpane--shr-span (dom)
  "Draw DOM, a span, as shr does, then colour it by its highlight.js class."
  (let ((start (point))
        (face (agentpane--hljs-face (dom-attr dom 'class))))
    (shr-tag-span dom)
    (when face
      (add-face-text-property start (point) face))))

(defun agentpane--shr-pre (dom)
  "Draw DOM, a pre block, as shr does, in code on the code-block background.
Opened with a paragraph break rather than shr's bare newline: after a
table, shr's own `pre' sat flush against the last row (2026-09-22), where
the browser gives both blocks a margin."
  (shr-ensure-paragraph)
  (let ((start (point))
        (agentpane--in-pre t))
    (shr-tag-pre dom)
    ;; `shr-tag-pre' binds the current font to `default', so the text of a
    ;; block comes out without `shr-code' even inside `<code>' (Emacs
    ;; 31.1.50, measured 2026-09-21); an inline `<code>' does get it.
    (add-face-text-property start (point) 'agentpane-code t)
    (add-face-text-property start (point) 'agentpane-code-block t)))

(defun agentpane--shr-code (dom)
  "Draw DOM, a code element: inline code on its raised surface, unless inside a
pre block, where the block's own face already applies."
  (let ((start (point)))
    (shr-tag-code dom)
    (unless agentpane--in-pre
      (add-face-text-property start (point) 'agentpane-inline-code))))

(defun agentpane--shr-heading (dom face)
  "Draw DOM, a heading, as its own paragraph in FACE."
  (shr-ensure-paragraph)
  (let ((start (point)))
    (shr-generic dom)
    (add-face-text-property start (point) face))
  (shr-ensure-paragraph))

(defun agentpane--shr-h1 (dom)
  "Draw DOM, an h1, in `agentpane-h1'."
  (agentpane--shr-heading dom 'agentpane-h1))

(defun agentpane--shr-h2 (dom)
  "Draw DOM, an h2, in `agentpane-h2'."
  (agentpane--shr-heading dom 'agentpane-h2))

(defun agentpane--shr-h3 (dom)
  "Draw DOM, a heading of level three or below, in `agentpane-h3'."
  (agentpane--shr-heading dom 'agentpane-h3))

(defun agentpane--shr-table (dom)
  "Draw DOM, a table, as shr does, with its cells measured and drawn at
`agentpane-table' size."
  ;; Filling is off for prose, which wraps live; a table needs it on, so each
  ;; cell folds inside its own column instead of the row wrapping as one long
  ;; line at the window edge and the last cell landing under the first.
  (let ((shr-current-font 'agentpane-table)
        (shr-fill-text t))
    (shr-tag-table dom)))

(defun agentpane--shr-th (dom)
  "Draw DOM, a header cell, on `agentpane-th'.
shr has no `shr-tag-th' and renders the cell generically; this is the same
with the face on top."
  (let ((start (point)))
    (shr-generic dom)
    (add-face-text-property start (point) 'agentpane-th)))

(defun agentpane--shr-li (dom)
  "Draw DOM, a list item, as shr does, but number an ordered one `1.'.
`shr-tag-li' draws the counter as a bare number (Emacs 31.1, 2026-09-25),
where the browser draws `1.'.  This is its ordered arm with the period, so
the indent of whatever the item nests is measured past the whole marker."
  (if (not (numberp shr-list-mode))
      (shr-tag-li dom)
    (shr-ensure-newline)
    (let ((start (point))
          (bullet (format "%d. " shr-list-mode)))
      (setq shr-list-mode (1+ shr-list-mode))
      (insert bullet)
      (shr-mark-fill start)
      (let ((shr-indentation (+ shr-indentation (shr-string-pixel-width bullet))))
        (put-text-property start (1+ start)
                           'shr-continuation-indentation shr-indentation)
        (put-text-property start (1+ start) 'shr-prefix-length (length bullet))
        (shr-generic dom)))
    (unless (bolp)
      (insert "\n"))))

(defun agentpane--lift-emphasis (beg end)
  "Move `bold' and `italic' to the front of every face list between BEG and END.
shr prepends `shr-text' to a run after the emphasis face is already on it,
so the list reads `(shr-text bold)'; `shr-text' inherits `variable-pitch',
and the owner's `variable-pitch' sets `:weight regular' outright, which
then beats `bold' (measured 2026-09-22: the bold run drew in IBM Plex Sans
at weight regular).  In front, the emphasis face wins."
  (let ((pos beg))
    (while (< pos end)
      (let ((next (or (next-single-property-change pos 'face nil end) end))
            (faces (get-text-property pos 'face)))
        (when (and (consp faces) (not (keywordp (car faces))))
          (let ((lifted faces))
            (dolist (face '(italic bold))
              (when (memq face lifted)
                (setq lifted (cons face (delq face (copy-sequence lifted))))))
            (unless (equal lifted faces)
              (put-text-property pos next 'face lifted))))
        (setq pos next)))))

(define-hash-table-test 'agentpane--same-text
  #'equal-including-properties #'sxhash-equal-including-properties)

(defun agentpane--insert-html (html)
  "Draw HTML, the browser's rendering of one text part, through shr at point.
Filling is left to `visual-line-mode', and a visual-wrap pass gives wrapped
list rows their hanging indent.

That pass measures every list row twice with `string-pixel-width', its
marker and an average-width space beside it, although the rows of a list
hand it the same two strings, properties and all: on Emacs 31.1 (measured
2026-09-25) a full draw of a 199-node Claude transcript measured 766 times
for it (OW-johomo).  visual-wrap offers no way in to its measure, so the
pass runs with `string-pixel-width' bound to one that measures a string
once and hands a later string with the same text and properties the same
width.  That is not true of strings in general: `equal-including-properties'
does not see whether a `display' spec spanning two characters is one object
or two copies, nor the properties inside a `display' string, and either
changes the width.  It holds for what this pass measures, a marker matched
fresh from its line, whose only display specs are shr's one-character
indent and visual-wrap's `min-width', and a one-character space; so, within
one pass in one buffer, the indent drawn is the one measuring again gives."
  (let ((dom (with-temp-buffer
               (insert html)
               (libxml-parse-html-region (point-min) (point-max))))
        (shr-fill-text nil)
        (shr-inhibit-images t)
        (shr-external-rendering-functions
         '((span . agentpane--shr-span)
           (pre . agentpane--shr-pre)
           (code . agentpane--shr-code)
           (h1 . agentpane--shr-h1)
           (h2 . agentpane--shr-h2)
           (h3 . agentpane--shr-h3)
           (h4 . agentpane--shr-h3)
           (h5 . agentpane--shr-h3)
           (h6 . agentpane--shr-h3)
           (table . agentpane--shr-table)
           (th . agentpane--shr-th)
           (li . agentpane--shr-li)))
        (start (point)))
    (shr-insert-document dom)
    (agentpane--lift-emphasis start (point))
    ;; `shr-tag-table' sets `truncate-lines' in the buffer it draws into, so
    ;; one table would switch the whole transcript from wrapping to
    ;; truncation (Emacs 31.1.50, measured 2026-09-21). Wide tables then wrap
    ;; where the browser would scroll them; that is the price of prose that
    ;; wraps at all.
    (setq truncate-lines nil)
    (unless (bolp) (insert "\n"))
    ;; A list row is known by the `shr-continuation-indentation' that
    ;; `shr-tag-li' and `agentpane--shr-li' leave on its marker's first
    ;; character, past any indent (Emacs 31.1, 2026-09-25), not by its text:
    ;; a paragraph opening `2024 ' or a code line opening `- ' would
    ;; otherwise hang past a marker that is not one, which the browser
    ;; does not do.  Any other line's prefix is its leading whitespace.
    (let ((adaptive-fill-regexp "[ \t]*")
          (adaptive-fill-function
           (lambda ()
             (and (looking-at "[ \t]*\\([0-9]+\\.?\\|[-–*•‣⁃◦]\\)[ \t]+")
                  (get-text-property (match-beginning 1)
                                     'shr-continuation-indentation)
                  (match-string 0))))
          (widths (make-hash-table :test 'agentpane--same-text))
          (measure (symbol-function 'string-pixel-width)))
      (save-restriction
        (narrow-to-region start (point))
        (cl-letf (((symbol-function 'string-pixel-width)
                   (lambda (string &optional buffer)
                     (or (gethash string widths)
                         (puthash string (funcall measure string buffer) widths)))))
          (visual-wrap-prefix-function (point-min) (point-max)))))))

;;;; Drawing nodes

(defvar-local agentpane--ewoc nil
  "The ewoc drawing this buffer's nodes.")

(defvar-local agentpane--tail-index nil
  "The index of the last node drawn, the one a streaming turn is filling.
Kept apart from the ewoc because a snapshot draws its nodes one at a time,
and each would otherwise be the last while it is drawn.")

(defvar-local agentpane--recorded nil
  "The nodes `session/node' brought that are not yet drawn, as an alist from
index to the latest node at it, the index that first arrived last; see
`agentpane--record'.")

(defvar-local agentpane--error nil
  "The message of the turn error this buffer holds, or nil.
The buffer's one owner of the error, as `session.error' is the server's
\(src/server/http/session-manager.ts) and the session's `error' is the
browser's: a snapshot sets it from its `error', a `session/error' replaces
it, a `session/errorCleared' clears it, and `agentpane-dismiss-error'
clears it; a prompt's answer does not, since the server's
`session/errorCleared' says when admitting the prompt cleared it
\(OW-lohubo; see `agentpane--send-prompt').  It is drawn as the one
`(:error MESSAGE)' node; see `agentpane--hold-error'.
A snapshot sets it even from a stale error: a snapshot the server
broadcast before it cleared the error, at `submit' or `clearError' in
session-manager.ts, may be handled after `agentpane-dismiss-error',
which clears it before the server has heard.
The server announces every clear with a `session/errorCleared'
\(OW-jopifu), and the socket is one ordered stream, so that clear
always follows the stale snapshot and the line the stale one draws is
transient; the buffer keeps no send-time state to second-guess a snapshot
\(OW-sedosu).")

(defvar-local agentpane--error-id nil
  "The `errorId' the server named `agentpane--error' by, set with it.
Two errors with the same text are two errors, and this is how the buffer
names the one it shows to `sessions/dismissError', and to
`sessions/prompt' as the one held when the prompt was sent (OW-jokoto).
It names nothing while `agentpane--error' is nil.")

(defvar-local agentpane--streaming nil
  "Non-nil while the last status this buffer heard said a turn is streaming.")

(defvar-local agentpane--forkable nil
  "The fork points the helper last sent this buffer, as a plist, or nil
while none has arrived since the buffer attached: `:indices', a vector of
the transcript indices the session can be forked at, and
`:forkStopsTurn', non-nil where a fork of the session stops a running
turn (D30).  The helper fetches them at each snapshot it sends and at
each edge of the session's streaming, and sends them as
`session/forkPoints' (D33 point 4), as the browser's `refreshForkPoints'
holds `forkIndices' (src/client/controller.ts); agentpane-mode only
draws and reads them.
A user message in the set carries a ✎ mark (`agentpane--forkable-p'),
and `agentpane-edit' edits only such a message, reading this at the
press, as the browser's `startEdit' reads its set.  Nil in an attached
buffer is the browser's not-yet-known: every user message is marked and
offered, and the server refuses a send at a message no point names
\(`not_a_fork_point'), leaving the edit open.  A buffer holding no
handle, a preview, marks none.  Cleared at a let-go
\(`agentpane--let-go') and at an attach under another handle.
Until ark3/agentpane#76 agentpane-mode fetched the points itself, at the
press, and marked nothing.")

(defvar-local agentpane--reading nil
  "Non-nil while this buffer shows reading view; see `agentpane-toggle-reading'.
Per buffer and not kept, where the browser's is one global boolean (owner,
2026-09-23).")

(defvar-local agentpane--status-fields nil
  "The mode-line fields of the last status this buffer heard, as strings.")

(defvar-local agentpane--model nil
  "The model the last status this buffer heard named, or nil; the one whose
efforts `agentpane-set-effort' offers (OW-vozaku).")

(defvar-local agentpane--status nil
  "The params of the last status this buffer heard, or nil.")

(defvar-local agentpane--tail-overlay nil
  "Overlay on the prompt separator whose `before-string' is the reading-view
tail status, or the line saying reading view hides every node, when there
is one, then `agentpane--slash-warning' while the draft starts with `/',
then the line `agentpane--handled' draws; see
`agentpane--show-reading-tail'.")

(defvar-local agentpane--handled nil
  "Non-nil when the backend handled the last prompt this buffer sent
without starting a turn for it -- a Pi extension command such as `/mcp'
-- until the next send; see `agentpane--send-prompt'.  The line it draws
above the prompt separator says so, because the draft clears and nothing
else in the buffer would tell that prompt from one whose turn is slow to
start, as the browser's `handledKey' does in its composer (OW-yobayi).
It says what the prompt did not do, never that nothing follows it: the
extension that handled it may still start work of its own.")

(defconst agentpane--slash-warning
  "Agentpane does not run slash commands — depending on the agent, this may run as a command or be read as plain text."
  "The browser's warning by a draft that starts with `/', word for word.
Advisory only, a bare leading `/' with no command list, and never in the
way of a send (OW-73).  It promises neither outcome: as of `pi 1.2.0' Pi
runs an extension command such as `/mcp' itself, while Codex and Claude
Code took such text as a prompt as far as anything measured (OW-sidese).")

(defvar-local agentpane--slash-warned nil
  "Non-nil while the line above the prompt separator carries
`agentpane--slash-warning', drawn by `agentpane--show-reading-tail'.")

(defvar-local agentpane--prompt-separator nil
  "Marker at the start of the line between the nodes and the prompt region.
It advances past text inserted at it, so nodes drawn there stay above it.")

(defvar-local agentpane--prompt-start nil
  "Marker at the start of the prompt region, the editable text at the end of
a transcript buffer.")

(defvar-local agentpane--folds nil
  "Hash table of fold keys (INDEX . ORDINAL) that are currently expanded.
A key absent from the table is folded; that is every fold's initial state.")

(defun agentpane--expanded-p (key)
  "Non-nil when the fold KEY is expanded."
  (gethash key agentpane--folds))

(defun agentpane--insert-fold (key header body)
  "Insert HEADER as one line, then BODY folded beneath it under fold KEY.
HEADER is a propertized line without its newline, fitted to one screen
line by `agentpane--fit-header'; BODY is a string, possibly multi-line,
without a trailing newline, or nil when there is nothing to fold.
Both carry the `agentpane-fold' property so `TAB' finds the fold from
either, and BODY is invisible unless KEY is expanded.
Expanded, BODY is framed after agent-shell's fragment body: a blank line
after the header, and indented two spaces by `line-prefix' and
`wrap-prefix', so the indent is display only and a copy carries none.
agent-shell's blank line after the body is left out: shr, opening a text
part that follows, reads the blank line it already sees there, hidden or
not, as its paragraph break and adds none, so the text would sit flush
under a folded header.
Folded, nothing follows the header on its line: the marker says there is
a body, and an ellipsis would take room the one-line header needs."
  (let* ((expanded (agentpane--expanded-p key))
         (marker (if body (if expanded "▾ " "▸ ") "  ")))
    (insert (propertize marker 'face 'agentpane-dim 'agentpane-fold key)
            (propertize header 'agentpane-fold key)
            (propertize "\n" 'agentpane-fold key))
    (when body
      (let ((start (point)))
        (insert "\n" body "\n")
        (add-text-properties start (point) (list 'agentpane-fold key
                                                 'line-prefix "  "
                                                 'wrap-prefix "  "))
        (unless expanded
          ;; Hide from the header's newline through the body's last
          ;; character, so the line after the fold starts fresh.
          (put-text-property (1- start) (1- (point)) 'invisible 'agentpane))))))

(defvar-local agentpane--fitted-width nil
  "The width in pixels this buffer's nodes were last drawn, and their fold
headers fitted, at; see `agentpane--refit-on-resize'.")

(defvar-local agentpane--refit-timer nil
  "The idle timer that refits this buffer's fold headers, while one is pending.")

(defun agentpane--fit-window ()
  "The window fold headers are fitted to: the narrowest of the windows
showing this buffer, so that none of them wraps a header, or the selected
window while none shows it."
  (car (sort (or (get-buffer-window-list nil nil t) (list (selected-window)))
             :key (lambda (window) (window-body-width window t)))))

(defun agentpane--window-width ()
  "The body width in pixels of `agentpane--fit-window', which fold headers
are fitted to."
  (window-body-width (agentpane--fit-window) t))

(defun agentpane--motion-window ()
  "The window to cut fold headers by `vertical-motion' in, or nil to cut them
by `agentpane--cut-by-search'.
It is `agentpane--fit-window', which wraps at no narrower width than the one
a header is fitted to, since the motion stops where that window would wrap
the line.  It is nil in batch Emacs, where the motion does not move: on
Emacs 31.1 on 2026-09-25 it returned 0 and left point where it was in
`emacs --batch', though on a daemon's frame from before any client's it
moved as far as asked.  It is nil when the window is on a frame other than
the selected one: the width a header is fitted to and the measure it is
checked with are the selected frame's, while the motion lays text out in
its window's frame's fonts, so where those are wider the motion stops
short, and the check does not catch a start that is too short."
  (let ((window (agentpane--fit-window)))
    (and (not noninteractive)
         (eq (window-frame window) (selected-frame))
         window)))

(defun agentpane--cut-by-search (fits summary suffix)
  "The length of the longest start of SUMMARY, short of all of it, that FITS
beside SUFFIX, or nil when not even SUFFIX alone does.
A binary search over the length, a layout per step: about eight for a
summary a few lines long.  It is the cut wherever the frame cannot lay out
text, and the one `agentpane--cut-by-motion' is held to."
  (let ((lo -1)
        (hi (1- (length summary))))
    (while (< lo hi)
      (let ((mid (/ (+ lo hi 1) 2)))
        (if (funcall fits (concat (substring summary 0 mid) suffix))
            (setq lo mid)
          (setq hi (1- mid)))))
    (and (>= lo 0) lo)))

(defun agentpane--cut-by-motion (window width fits prefix summary suffix)
  "What `agentpane--cut-by-search' answers for FITS, SUMMARY and SUFFIX, from
one `vertical-motion' in WINDOW and one check.
SUFFIX is laid out ahead of PREFIX, the fold marker and the head, and then
SUMMARY, so that one motion to WIDTH pixels stops where the summary must
end with no measure of SUFFIX of its own.  The motion stops at the position
closest to that pixel column, as its docstring puts it, and a WINDOW
scrolled horizontally moves that column right by the scroll, even in a
buffer it does not show, so the start it finds is checked with FITS, and
where it does not fit the search takes over below it.
The work buffer takes this buffer's face remapping, as `string-pixel-width'
does, and measures pure pixel columns.  It turns off the buffer-local
`line-prefix' and line numbers, which would sit ahead of the text for the
motion to count; nothing inserted carries a `line-prefix' property of its
own.  It turns off `word-wrap', which ends the screen line at an earlier
space, and bidi reordering, which would break the tie between a position
and a column in right-to-left text.
A SUMMARY holding a tab, as a thinking part's first line may, is cut by
the search instead: a tab's width depends on its column, which SUFFIX
laid out ahead shifts."
  (if (string-match-p "\t" summary)
      (agentpane--cut-by-search fits summary suffix)
    (let* ((buffer (current-buffer))
           (cut (with-work-buffer
                  (dolist (variable '(face-remapping-alist char-property-alias-alist
                                      default-text-properties))
                    (when (local-variable-p variable buffer)
                      (set (make-local-variable variable) (buffer-local-value variable buffer))))
                  (setq-local line-prefix nil display-line-numbers nil word-wrap nil
                              bidi-display-reordering nil)
                  ;; Inserting into another buffer would deactivate the mark.
                  (let (deactivate-mark)
                    (insert suffix prefix summary))
                  (goto-char (point-min))
                  (vertical-motion (cons (/ (float width) (frame-char-width (window-frame window))) 0)
                                   window)
                  (min (- (point) (point-min) (length suffix) (length prefix))
                       (1- (length summary))))))
      (cond ((< cut 0) nil)
            ((funcall fits (concat (substring summary 0 cut) suffix)) cut)
            (t (agentpane--cut-by-search fits (substring summary 0 cut) suffix))))))

(defun agentpane--fit-header (head summary tail)
  "HEAD, SUMMARY and TAIL, in that order, fitted to one screen line.
Return (LINE CUT TAILP): LINE without the fold marker; CUT non-nil when
SUMMARY was cut short with `…' to fit, since the summary is what gives
way; and TAILP non-nil when TAIL is on LINE.  TAIL, a step's meta, may be
nil, and is left off when it would not fit even beside an ellipsis alone,
for the caller to draw on a line of its own.
The measure is `string-pixel-width' under this buffer's face remapping,
since the buffer's prose is proportional and a character count is not a
width, against `agentpane--window-width' less one character, the column a
terminal keeps for its continuation glyph.  The fold marker is counted as
`▸ ' whichever is drawn.  In batch Emacs both measures degrade to
character cells, which is what the tests fit against.
A header that fits costs that one measure.  One that does not is cut by
`agentpane--cut-by-motion' in the window `agentpane--motion-window'
answers, a motion and a check: three layouts with it.  When that motion
finds TAIL will not fit, the summary alone is measured, and if it does
not fit either a second motion and check cut it: five.  A check that
fails adds the search below it.  Where no window is answered,
`agentpane--cut-by-search' cuts, a measure per step of a binary search.
Nothing refits a header when the window changes width except a redraw;
see `agentpane--refit-on-resize'."
  (let* ((width (- (agentpane--window-width) (frame-char-width)))
         (marker (propertize "▸ " 'face 'agentpane-dim))
         (fits (lambda (text)
                 (<= (string-pixel-width (concat marker head text) (current-buffer))
                     width))))
    (cond
     ((funcall fits (concat summary tail))
      (list (concat head summary tail) nil (and tail t)))
     ((string-empty-p summary)
      (list head nil nil))
     (t
      (let* ((ellipsis (propertize "…" 'face (get-text-property 0 'face summary)))
             (window (agentpane--motion-window))
             ;; The longest start of the summary that fits beside SUFFIX,
             ;; or nil when not even SUFFIX does.
             (cut (lambda (suffix)
                    (if window
                        (agentpane--cut-by-motion
                         window width fits (concat marker head) summary suffix)
                      (agentpane--cut-by-search fits summary suffix))))
             (kept (and tail (funcall cut (concat ellipsis tail)))))
        (cond
         (kept
          (list (concat head (string-trim-right (substring summary 0 kept)) ellipsis tail)
                t t))
         ((and tail (funcall fits summary))
          (list (concat head summary) nil nil))
         (t
          (list (concat head (string-trim-right (substring summary 0 (or (funcall cut ellipsis) 0)))
                        ellipsis)
                t nil))))))))

(defun agentpane--refit-on-resize (_window)
  "Refit this buffer's fold headers once its windows settle at a new width.
On `window-size-change-functions', buffer-locally, which runs when a
window showing the buffer is added or changes size.  Only a change in
the width `agentpane--window-width' answers redraws, and only once no
input has come for 0.2s, since a drag resizes many times over and a
redraw draws every node again, text through shr included."
  (unless (or (null agentpane--ewoc) agentpane--refit-timer
              (eql agentpane--fitted-width (agentpane--window-width)))
    (setq agentpane--refit-timer
          (run-with-idle-timer 0.2 nil #'agentpane--refit (current-buffer)))))

(defun agentpane--refit (buffer)
  "Redraw every node of BUFFER, if still live, should its width have changed."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (setq agentpane--refit-timer nil)
      (unless (eql agentpane--fitted-width (agentpane--window-width))
        (agentpane--keeping-points
         (lambda () (agentpane--above-prompt (lambda () (ewoc-refresh agentpane--ewoc)))))))))

(defun agentpane--diff-text (lines)
  "Render LINES, a vector of diff-line plists, as a propertized string."
  (mapconcat
   (lambda (line)
     (let ((type (plist-get line :type))
           (text (plist-get line :text)))
       (pcase type
         ("add" (propertize (concat "+" text) 'face 'diff-added))
         ("del" (propertize (concat "-" text) 'face 'diff-removed))
         ("ctx" (propertize (concat " " text) 'face 'diff-context))
         ("gap" (propertize text 'face 'diff-hunk-header))
         (_ (propertize (format "?%s %s" type text) 'face 'agentpane-warning)))))
   lines "\n"))

(defun agentpane--image-line (part)
  "The line an image PART is drawn as, without its newline: its type, not
its pixels."
  (propertize (format "[image %s]" (plist-get part :mimeType)) 'face 'agentpane-dim))

(defun agentpane--tool-body (part &optional summary)
  "The folded body of a tool PART: SUMMARY, when given, then its diff, args
and result, then the time its result arrived, each apart by a blank line
as agent-shell sets a body's sections apart.
SUMMARY is the whole of the summary its header cut short.  The result's
image parts follow its text, as `ResultBody.svelte' draws them, and the
time goes last, where the browser's tool card draws it: in the body,
since the header is the line a reader scans."
  (let* ((diff (plist-get part :diff))
         (args (plist-get part :args))
         (result (plist-get part :result))
         (time (agentpane--format-timestamp (plist-get part :timestamp)))
         (lines (append (and result (not (string-empty-p result)) (list result))
                        (mapcar #'agentpane--image-line (plist-get part :images))))
         (chunks nil))
    (when summary
      (push summary chunks))
    ;; A `write' of empty content arrives as an empty vector, which is not nil.
    (when (and diff (> (length diff) 0))
      (push (agentpane--diff-text diff) chunks))
    (when (and args (not (string-empty-p args)))
      (push (concat (propertize "args:" 'face 'agentpane-dim) "\n" args) chunks))
    (push (concat (propertize "result:" 'face 'agentpane-dim) "\n"
                  (if lines
                      (mapconcat #'identity lines "\n")
                    (propertize "(none)" 'face 'agentpane-dim)))
          chunks)
    (when time
      (push (propertize time 'face 'agentpane-meta) chunks))
    (let ((body (mapconcat #'identity (nreverse chunks) "\n\n")))
      ;; Arguments, results and diffs are column-aligned text: keep them
      ;; monospace under the buffer's proportional default. Appended, so the
      ;; diff faces already on the text keep every attribute but the family.
      (add-face-text-property 0 (length body) 'fixed-pitch t body)
      body)))

(defconst agentpane--tool-marks
  '(("ok" "✓" agentpane-tool-ok)
    ("error" "✗" agentpane-warning)
    ("running" "◔" agentpane-dim))
  "Each tool state's mark at the head of its header, with the face it is
drawn in: agent-shell's status icons.")

(defun agentpane--tool-summary (part)
  "The summary of a tool PART as its header draws it: the line counts a file
edit's summary ends with in the diff faces, as agent-shell colours them."
  (let ((summary (copy-sequence (or (plist-get part :summary) ""))))
    (when (string-match " · \\(\\+[0-9]+\\) \\(−[0-9]+\\)\\'" summary)
      (add-face-text-property (match-beginning 1) (match-end 1) 'diff-added nil summary)
      (add-face-text-property (match-beginning 2) (match-end 2) 'diff-removed nil summary))
    summary))

(defun agentpane--insert-tool (key part &optional tail)
  "Insert a tool PART under fold KEY, with TAIL after its summary on the header.
The header is agent-shell's: the state's mark, the name as a heading, then
the summary, on one screen line, the summary cut short to fit; see
`agentpane--fit-header'.  Return non-nil when TAIL is on the header.
A `running' state is drawn as `ok' unless the node is still the streaming
tail, the contract's own rule: the helper sends no fresh node when the
streaming ends or a later node is appended, so the one held may be stale."
  (let* ((state (let ((state (plist-get part :state)))
                  (if (and (equal state "running")
                           (not (and agentpane--streaming
                                     (eql (car key) agentpane--tail-index))))
                      "ok"
                    state)))
         (mark (assoc state agentpane--tool-marks))
         (head (concat (if mark
                           (propertize (nth 1 mark) 'face (nth 2 mark))
                         (propertize (format "?%s" state) 'face 'agentpane-warning))
                       " " (propertize (plist-get part :name) 'face 'agentpane-tool) " "))
         (fit (agentpane--fit-header head (agentpane--tool-summary part) tail)))
    (agentpane--insert-fold
     key (nth 0 fit)
     (agentpane--tool-body part (and (nth 1 fit) (plist-get part :summary))))
    (nth 2 fit)))

(defun agentpane--insert-thinking (key part)
  "Insert a thinking PART under fold KEY: agent-shell's `✶ Thinking' label, then
the first line of the thinking, cut short to keep the header one screen
line.  What the header does not show is folded beneath it: the rest, or
all of it when the first line was cut."
  (let ((text (or (plist-get part :text) ""))
        (head (concat (propertize "✶ " 'face 'agentpane-thinking)
                      (propertize "Thinking" 'face 'agentpane-tool))))
    (cond
     ((eq (plist-get part :redacted) t)
      (agentpane--insert-fold
       key (concat head (propertize " (redacted)" 'face 'agentpane-thinking)) nil))
     ;; A signature-only block, which is every thinking part a Claude Code
     ;; store carried on 2026-09-21: the browser's `Thinking.svelte' renders
     ;; nothing for it, so neither does this.
     ((string-empty-p text) nil)
     (t
      (let* ((text (string-trim text))
             (split (string-search "\n" text))
             (fit (agentpane--fit-header
                   (concat head " ")
                   (propertize (if split (substring text 0 split) text)
                               'face 'agentpane-thinking)
                   nil))
             (body (cond ((nth 1 fit) text)
                         (split (string-trim (substring text (1+ split)))))))
        (agentpane--insert-fold
         key (nth 0 fit)
         (and body (not (string-empty-p body))
              (propertize body 'face 'agentpane-thinking))))))))

(defun agentpane--insert-system (key part)
  "Insert a system PART under fold KEY: its summary, the browser's marker for
a system message, as the header, cut short to keep it one screen line, and
its body folded beneath it, collapsed, as the browser's disclosure starts.
A summary the header cut short leads the body whole, as a tool's does.
The decision, a first cut chosen by the owner on 2026-10-14 and to be
judged in use, is `systemView' in src/client/render/system.ts."
  (let* ((summary (plist-get part :summary))
         (body (plist-get part :body))
         (fit (agentpane--fit-header "" (propertize summary 'face 'agentpane-dim) nil))
         (chunks (delq nil (list (and (nth 1 fit) summary)
                                 (and body (not (string-empty-p body)) body)))))
    (agentpane--insert-fold key (nth 0 fit) (and chunks (mapconcat #'identity chunks "\n\n")))))

(defun agentpane--insert-part (index ordinal part &optional tail)
  "Insert PART, part number ORDINAL of the node at INDEX.
TAIL, given only for a tool PART, is the step's meta for its header; the
return value is then non-nil when the header carries it."
  (let ((key (cons index ordinal))
        (type (plist-get part :type)))
    (pcase type
      ("text"
       (let ((html (plist-get part :html)))
         (unless (or (null html) (string-empty-p html))
           (agentpane--insert-html html))))
      ("thinking" (agentpane--insert-thinking key part))
      ("tool" (agentpane--insert-tool key part tail))
      ("system" (agentpane--insert-system key part))
      ("image" (insert (agentpane--image-line part) "\n"))
      (_
       (insert (propertize (format "[unknown part type %S]" type)
                           'face 'agentpane-warning)
               "\n")))))

(defun agentpane--draws-p (part)
  "Non-nil when PART draws anything: when reading view does not elide it and
it is neither a text part with no HTML nor a thinking part with no text
that was not redacted either."
  (and (not (and agentpane--reading (agentpane--chrome-part-p part)))
       (pcase (plist-get part :type)
         ("text" (let ((html (plist-get part :html)))
                   (and html (not (string-empty-p html)))))
         ("thinking" (or (eq (plist-get part :redacted) t)
                         (not (string-empty-p (or (plist-get part :text) "")))))
         (_ t))))

(defun agentpane--meta-ordinal (parts)
  "The ordinal among PARTS of the last one drawn, when it is a tool call,
whose header then carries the step's meta; otherwise nil."
  (let ((ordinal 0)
        last)
    (seq-doseq (part parts)
      (when (agentpane--draws-p part)
        (setq last (and (equal (plist-get part :type) "tool") ordinal)))
      (setq ordinal (1+ ordinal)))
    last))

(defun agentpane--compact-number (n)
  "N, a non-negative integer, as en-US `Intl.NumberFormat' compact notation.
That is the browser's `compact' in `Message.svelte': one decimal below ten of
a unit, none from ten up, halves rounded up, and a result that rounds to 1000
of a unit shown as 1 of the next, so 999500 is \"1M\", not \"1000K\"."
  (let ((units '(("" . 1) ("K" . 1000) ("M" . 1000000)
                 ("B" . 1000000000) ("T" . 1000000000000)))
        result)
    (while (not result)
      (let* ((suffix (caar units))
             (unit (cdar units))
             (tenths (if (< n (* 10 unit))
                         (/ (+ (* 10 n) (/ unit 2)) unit)
                       (* 10 (/ (+ n (/ unit 2)) unit)))))
        (when (or (< tenths 10000) (null (cdr units)))
          (setq result (if (zerop (% tenths 10))
                           (format "%d%s" (/ tenths 10) suffix)
                         (format "%d.%d%s" (/ tenths 10) (% tenths 10) suffix))))
        (setq units (cdr units))))
    result))

(defun agentpane--format-timestamp (ms)
  "MS, epoch milliseconds or nil, as a local date and time to the second, or nil.
The shape of `formatTimestamp' in src/client/time.ts, in Emacs's zone as
that is in the browser's; a part second is dropped, as there."
  (and ms (format-time-string "%Y-%m-%d %H:%M:%S" (floor ms 1000))))

(defun agentpane--meta-text (meta timestamp pending)
  "The meta of an assistant node from META and TIMESTAMP, its fields joined by
` · ' in the meta's face, or nil when it has none.
Drawn as a line of its own by `agentpane--insert-meta', or on the header of
a tool call that ends the node, after `agentpane--meta-tail'.
Its fields are the browser's footer in `Message.svelte': the time, the
model and the effort when present, and the tokens, then any cost, only
when there are tokens.  The stop reason and error message follow, which
the browser shows as a banner beside the footer instead.
The footer's facts are drawn under the browser's `showsMeta': not while
the turn is PENDING, and not unless there is a model or tokens.  The stop
reason and error message are drawn regardless, and with neither nor any
fact nothing is."
  (let* ((usage (plist-get meta :usage))
         (model (let ((model (plist-get meta :model)))
                  (and model (not (string-empty-p model)) model)))
         (tokens (or (plist-get usage :totalTokens) 0))
         (cost (or (plist-get usage :cost) 0))
         (stop (plist-get meta :stopReason))
         (error-message (plist-get meta :errorMessage))
         (effort (plist-get meta :effort))
         (face (if stop 'agentpane-warning 'agentpane-meta))
         (shown (and (not pending) (or model (> tokens 0))))
         (fields
          (delq nil
                (append
                 (and shown
                      (list (agentpane--format-timestamp timestamp)
                            model
                            effort
                            (and (> tokens 0)
                                 (format "%s tok" (agentpane--compact-number tokens)))
                            (and (> tokens 0) (> cost 0) (format "$%.4f" cost))))
                 (list stop error-message)))))
    (and fields (propertize (mapconcat #'identity fields " · ") 'face face))))

(defun agentpane--insert-meta (text)
  "Insert TEXT, from `agentpane--meta-text', as a meta line of its own."
  (insert (propertize "— " 'face (get-text-property 0 'face text)) text "\n"))

(defun agentpane--meta-tail (text)
  "TEXT, from `agentpane--meta-text', as it follows a tool header's summary."
  (concat (propertize " · " 'face (get-text-property 0 'face text)) text))

(defun agentpane--bar-wrap-prefixes (beg end bar)
  "Give every line between BEG and END a `wrap-prefix' that starts with BAR.
Where a text part already carries visual-wrap's hanging indent, the bar goes
in front of a space as wide as the indent, so a wrapped list item still lines
up under its own first line, whose marker visual-wrap gave that same
`min-width'; where there is none, the wrapped row gets the bar alone.  The
space is `:width', not `:align-to': an `:align-to' inside a prefix string did
not resolve against the text area on Emacs 31.1.50 (measured 2026-09-21),
and a fixed width needs no position."
  (let ((pos beg))
    (while (< pos end)
      (let* ((next (or (next-single-property-change pos 'wrap-prefix nil end) end))
             (existing (get-text-property pos 'wrap-prefix))
             (prefix
              (pcase existing
                ((pred stringp) (concat bar existing))
                (`(space :align-to ,col)
                 (concat bar (propertize " " 'display `(space :width ,col))))
                (_ bar))))
        (put-text-property pos next 'wrap-prefix prefix)
        (setq pos next)))))

(defun agentpane--pp (node)
  "Pretty-print NODE, one transcript node plist, at point.
The layout follows the browser's `Message.svelte': an assistant turn is plain
text on the page, closed by its small meta line and nothing else, so
consecutive assistant turns run together the way they do there; a user turn
is the one raised surface, a tinted box with an accent bar down its left
edge, with a blank line on either side.  Neither carries a role label.
NODE may instead be `(:error MESSAGE)', the turn error `agentpane--error'
holds, drawn as a warning line, or `(:notice NOTICE)', a
`session/notice' drawn there too, as its message with its details and
path, if any, on the lines below, in `agentpane-notice' so it does not read
as an error.  A
node reading view elides draws nothing;
see `agentpane--elided-p'.  Everything drawn is read-only, so only the
prompt region below the nodes takes typing."
  (setq agentpane--fitted-width (agentpane--window-width))
  (let ((start (point)))
    (cond
     ((plist-member node :error)
      (insert (propertize (concat "⚠ " (plist-get node :error)) 'face 'agentpane-warning)
              "\n"))
     ((plist-member node :notice)
      (let ((notice (plist-get node :notice)))
        (insert (propertize
                 (mapconcat #'identity
                            (delq nil (list (concat "ℹ " (plist-get notice :message))
                                            (plist-get notice :details)
                                            (plist-get notice :path)))
                            "\n  ")
                 'face 'agentpane-notice)
                "\n")))
     ((agentpane--elided-p node))
     (t (agentpane--pp-node node)))
    (add-text-properties start (point) '(read-only t front-sticky (read-only)))))

(defun agentpane--compaction-marker (node)
  "The line compaction marker NODE draws: the browser's divider in text, its
label between two rules, naming the context size it folded when above 0."
  (let ((tokens (plist-get node :tokensBefore)))
    (concat "── Context compacted"
            (and tokens (> tokens 0)
                 (format " · from %s tok" (agentpane--compact-number tokens)))
            " ──")))

(defun agentpane--pp-node (node)
  "Pretty-print NODE, one transcript node plist, at point; see `agentpane--pp'."
  (let* ((index (plist-get node :index))
         (role (plist-get node :role))
         (userp (equal role "user"))
         (ordinal 0))
    (when userp (insert "\n"))
    (cond
     ((equal role "compactionSummary")
      (insert (propertize (agentpane--compaction-marker node) 'face 'agentpane-dim)
              "\n"))
     ;; A system node's marker is its part's fold header.
     ((not (or userp (member role '("assistant" "system"))))
      (insert (propertize role 'face 'agentpane-role-other) "\n")))
    (let* ((body-start (point))
           (time (agentpane--format-timestamp (plist-get node :timestamp)))
           (parts (plist-get node :parts))
           (meta (plist-get node :meta))
           (meta-text (and meta (agentpane--meta-text
                                 meta (plist-get node :timestamp)
                                 (and agentpane--streaming
                                      (eql index agentpane--tail-index)))))
           ;; The one-line rule (OW-gageru): a step that ends in a tool call
           ;; carries its meta on that call's header, one screen line, unless
           ;; there is an error message, too long for it to share.
           (meta-ordinal (and meta-text (not (plist-get meta :errorMessage))
                              (agentpane--meta-ordinal parts)))
           (placed nil))
      ;; An elided part keeps its ordinal, so a fold keeps its key across
      ;; a toggle of reading view.
      (seq-doseq (part parts)
        (unless (and agentpane--reading (agentpane--chrome-part-p part))
          (if (eql ordinal meta-ordinal)
              (setq placed (agentpane--insert-part index ordinal part
                                                   (agentpane--meta-tail meta-text)))
            (agentpane--insert-part index ordinal part)))
        (setq ordinal (1+ ordinal)))
      ;; The browser puts a user turn's time on its first block's action row,
      ;; below the text inside the box, and its ✎ last on that row; this is
      ;; the box's last line (D33 point 4).
      (when userp
        (let ((row (delq nil (list time (and (agentpane--forkable-p index) "✎")))))
          (when row
            (insert (propertize (string-join row " ") 'face 'agentpane-meta) "\n"))))
      (when (and meta-text (not placed))
        (agentpane--insert-meta meta-text))
      (when userp
        ;; The bar runs down the box's left edge, and `wrap-prefix' carries it
        ;; onto the rows `visual-line-mode' wraps. Nothing here uses
        ;; `visual-wrap-prefix-mode', which would write its own `wrap-prefix'
        ;; over this one; hanging indents for wrapped list items are the price.
        (let ((bar (propertize agentpane--bar 'face 'agentpane-user-bar)))
          (put-text-property body-start (point) 'line-prefix bar)
          (agentpane--bar-wrap-prefixes body-start (point) bar)
          (add-face-text-property body-start (point) 'agentpane-user-box t))))
    (when userp (insert "\n"))))

(defun agentpane--forkable-p (index)
  "Whether the user message at INDEX is offered an edit, and marked: this
buffer holds a handle, and either no fork points have arrived yet or
they name INDEX; see `agentpane--forkable'."
  (and agentpane--handle
       (or (null agentpane--forkable)
           (seq-contains-p (plist-get agentpane--forkable :indices) index #'eql))
       t))

(defun agentpane--reforking (change)
  "Call CHANGE, which may change what `agentpane--forkable-p' answers, and
redraw each drawn user node whose answer it changed, and no other."
  (let* ((users (and agentpane--ewoc
                     (seq-filter (lambda (node) (equal (plist-get (ewoc-data node) :role) "user"))
                                 (let (nodes (node (ewoc-nth agentpane--ewoc 0)))
                                   (while node
                                     (push node nodes)
                                     (setq node (ewoc-next agentpane--ewoc node)))
                                   nodes))))
         (before (mapcar (lambda (node) (agentpane--forkable-p (plist-get (ewoc-data node) :index)))
                         users)))
    (funcall change)
    (let ((changed (seq-filter #'identity
                               (seq-mapn (lambda (node was)
                                           (and (not (eq was (agentpane--forkable-p
                                                               (plist-get (ewoc-data node) :index))))
                                                node))
                                         users before))))
      (when changed
        (agentpane--above-prompt
         (lambda () (apply #'ewoc-invalidate agentpane--ewoc changed)))))))

(defun agentpane--hold-forkable (params)
  "Hold the fork points PARAMS, a `session/forkPoints''s, carry, as
`agentpane--forkable', redrawing the user nodes whose mark they move,
and the edit's hint, which reads `:forkStopsTurn'."
  (agentpane--reforking
   (lambda ()
     (setq agentpane--forkable
           (list :indices (plist-get params :indices)
                 :forkStopsTurn (eq (plist-get params :forkStopsTurn) t)))))
  (agentpane--show-edit-hint))

(defun agentpane--draw (nodes &optional header notices error error-id)
  "Draw NODES, a sequence of node plists, as this buffer's ewoc under HEADER.
Replaces every node the buffer held and leaves the prompt region below them
as it was; expanded folds survive the redraw, since they are keyed by node
index and part ordinal rather than by position.  ERROR and NOTICES, the
turn error and notices a `session/snapshot' carries, are drawn after NODES
in that order, as an `(:error MESSAGE)' node and `(:notice NOTICE)' nodes,
so a snapshot keeps what the server still holds for the session, including what
arrived before this buffer was attached (OW-bipume).  ERROR, nil or not,
becomes the error the buffer holds, `agentpane--error', and ERROR-ID, the
snapshot's `errorId', what it names that error by, `agentpane--error-id'.
Nodes recorded and not yet drawn are discarded, since NODES supersede
them.  Point goes to the first node."
  (setq agentpane--recorded nil
        agentpane--error error
        agentpane--error-id error-id)
  (agentpane--above-prompt
   (lambda ()
     (delete-region (point-min) agentpane--prompt-separator)
     (goto-char (point-min))
     (setq agentpane--ewoc
           (ewoc-create #'agentpane--pp
                        (and header (propertize (concat header "\n")
                                                'face 'agentpane-dim
                                                'read-only t
                                                'front-sticky '(read-only)))
                        nil
                        t))
     (setq agentpane--tail-index
           (and (> (length nodes) 0) (plist-get (elt nodes (1- (length nodes))) :index)))
     (seq-doseq (node nodes)
       (ewoc-enter-last agentpane--ewoc node))
     (when error
       (ewoc-enter-last agentpane--ewoc (list :error error)))
     (seq-doseq (notice notices)
       (ewoc-enter-last agentpane--ewoc (list :notice notice)))
     (goto-char (point-min))
     (when (ewoc-nth agentpane--ewoc 0)
       (ewoc-goto-node agentpane--ewoc (ewoc-nth agentpane--ewoc 0)))))
  (agentpane--show-reading-tail)
  (agentpane--preview-pickers))

(defun agentpane--drawn (index)
  "The ewoc node drawing the node at INDEX, or nil."
  (and index
       (let ((at (ewoc-nth agentpane--ewoc -1)))
         (while (and at (not (eql index (plist-get (ewoc-data at) :index))))
           (setq at (ewoc-prev agentpane--ewoc at)))
         at)))

(defun agentpane--upsert (node)
  "Redraw the drawn node whose index is NODE's in place, or append NODE.
A node's `index' is its place in the session's flat message array, so the
match is by that and never by position; a `(:notice NOTICE)' has no
index and always appends.  The turn error is
never upserted; see `agentpane--hold-error'.  Text after the
redrawn node, the prompt region included, moves with it, and so does a
point there: at the end of the buffer before, at the end after.
A node appended with an index becomes the last, and while the session
streams the one it follows is redrawn, since it was drawn as the pending
turn and no longer is."
  (let* ((index (plist-get node :index))
         (drawn (agentpane--drawn index))
         (previous (and index (not drawn) agentpane--streaming
                        (agentpane--drawn agentpane--tail-index))))
    (when (and index (not drawn))
      (setq agentpane--tail-index index))
    (agentpane--above-prompt
     (lambda ()
       (if drawn
           (progn
             (ewoc-set-data drawn node)
             (ewoc-invalidate agentpane--ewoc drawn))
         (ewoc-enter-last agentpane--ewoc node))
       (when previous
         (ewoc-invalidate agentpane--ewoc previous))))
    (agentpane--show-reading-tail)
    (when (and index (not drawn) (equal (plist-get node :role) "user"))
      (agentpane--preview-pickers))))

(defun agentpane--record (node)
  "Record NODE, a `session/node''s, as the latest at its index, to be drawn
by `agentpane--draw-recorded' from a zero-delay timer.
A node carries its whole message, and drawing it draws all of it again,
text through shr and every fold header fitted: 2-6ms in batch Emacs for
nodes of 2,600-8,300 characters, and about twice that in a graphical
frame (measured 2026-09-25; OW-tujula).  So a node superseded before it
is drawn is not drawn at all, and a backlog costs one redraw per index
however many nodes it holds.
jsonrpc.el parses every message in a chunk of output at once and runs
each one's handler, in message order, from a ripe timer of its own, and a
timer activated during a pass of ripe timers waits for the next pass
whatever its time, so the one started here runs after the rest of the
chunk: on Emacs 31.1 with jsonrpc.el 1.0.29, six notifications written at
once reached one process-filter call, and the timer the first one's
handler started ran after all six (measured 2026-09-25;
docs/MANUAL_TESTING.md, OW-tujezi).  Redisplay and a pending input event
can run between the passes, so a command can find a chunk's trailing
nodes not yet drawn, as it would had they arrived a moment later.
An index recorded for the first time is drawn after those recorded before
it, as it would have been appended on arrival."
  (unless agentpane--recorded
    (run-at-time 0 nil #'agentpane--draw-recorded (current-buffer)))
  (setf (alist-get (plist-get node :index) agentpane--recorded) node))

(defun agentpane--draw-recorded (buffer)
  "Draw the nodes BUFFER recorded, if it is still live, each once, and
forget them; see `agentpane--record'."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (let ((recorded (reverse agentpane--recorded)))
        (setq agentpane--recorded nil)
        (pcase-dolist (`(,_ . ,node) recorded)
          (agentpane--upsert node))))))

(defun agentpane--hold-error (message &optional id)
  "Hold MESSAGE, or nil for none, as this buffer's turn error, and draw it.
ID is the `errorId' the server named it by; see `agentpane--error-id'.
The line drawn for the one held before goes, and MESSAGE's is appended,
where it arrived, so the buffer draws at most one; see `agentpane--error'."
  (setq agentpane--error message
        agentpane--error-id id)
  (agentpane--above-prompt
   (lambda ()
     (ewoc-filter agentpane--ewoc (lambda (data) (not (plist-member data :error))))
     (when message
       (ewoc-enter-last agentpane--ewoc (list :error message)))))
  (agentpane--show-reading-tail))

(defun agentpane--above-prompt (redraw)
  "Call REDRAW, which changes only the read-only text above the prompt region.
The change is kept out of `buffer-undo-list', whose entries are then all the
draft's and are shifted by the change in size, since they record absolute
positions: otherwise undo in the prompt region would reverse a node redraw,
or a node that grew would leave the draft's entries pointing into it.  The
shift is in place, since undo tracks the list by its cells: `undo-equiv-table'
and `pending-undo-list' hold them, and a fresh list breaks consecutive undo
and `undo-redo' across a redraw.  A run of undo in region walks a copy
instead, made by `undo-make-selective-list', and it is shifted too while
that run is the last command, in this buffer: undo inhibits read-only, so
an entry left pointing into the nodes edits them."
  (let ((size (buffer-size)))
    (let ((buffer-undo-list t)
          (inhibit-read-only t))
      (funcall redraw))
    (let ((delta (- (buffer-size) size)))
      (unless (or (zerop delta) (eq buffer-undo-list t))
        (dolist (list (list buffer-undo-list
                            (and undo-in-region (eq last-command 'undo)
                                 (eq (window-buffer) (current-buffer))
                                 pending-undo-list)))
          (let ((cell list))
            (while (consp cell)
              (let ((entry (car cell)))
                (pcase entry
                  ((pred integerp) (setcar cell (+ entry delta)))
                  (`(,(and beg (pred integerp)) . ,(and end (pred integerp)))
                   (setcar cell (cons (+ beg delta) (+ end delta))))
                  ;; A negative position records point at the text's end.
                  (`(,(and text (pred stringp)) . ,(and pos (pred integerp)))
                   (setcar cell (cons text (if (< pos 0) (- pos delta) (+ pos delta)))))
                  (`(nil ,prop ,value ,beg . ,end)
                   (setcar cell `(nil ,prop ,value ,(+ beg delta) . ,(+ end delta))))))
              (setq cell (cdr cell)))))))))

(defun agentpane--keeping-points (redraw)
  "Call REDRAW, which replaces every node, keeping point and each window's
point and start.  A point in the prompt region, the end of the buffer
included, stays the same distance from the end, and any other stays at its
position; a window's start goes the way of its point, so a window following
the tail keeps its view of the bottom.  Without that the redraw's deletion
leaves every start at the top, and redisplay, scrolling back to point,
recentres.  The start is kept as a hint: should point fall outside the view
it gives, redisplay picks another start rather than moving point.  That is
the whole of follow mode, deliberately less than the browser's."
  (let* ((separator (marker-position agentpane--prompt-separator))
         (size (point-max))
         (saved (mapcar (lambda (window)
                          (let ((pos (if window (window-point window) (point))))
                            (list window pos (and window (window-start window))
                                  (and (>= pos separator) (- (point-max) pos)))))
                        (cons nil (get-buffer-window-list nil nil t)))))
    (funcall redraw)
    (pcase-dolist (`(,window ,pos ,start ,from-end) saved)
      (let ((target (if from-end
                        (- (point-max) from-end)
                      (min pos agentpane--prompt-separator))))
        (if (not window)
            (goto-char target)
          (set-window-point window target)
          ;; Clamped to the buffer, as every marker is.
          (set-window-start window (if from-end (- (point-max) (- size start)) start) t))))))

;;;; Reading view

(defun agentpane--chrome-part-p (part)
  "Non-nil when PART is tool chrome that reading view elides: a tool call, its
result folded in, or thinking."
  (member (plist-get part :type) '("tool" "thinking")))

(defun agentpane--elided-p (node)
  "Non-nil when reading view is on and elides NODE entirely.
The browser's `condense' over nodes rather than messages: a `tool-result'
node goes, orphan as it is, and so does an assistant node left with no
parts once its tool calls and thinking are gone, unless it ended in an
error or an abort, whose warning is not tool chrome.  Every other node is
drawn, less its chrome parts; see `agentpane--pp-node'."
  (and agentpane--reading
       (pcase (plist-get node :role)
         ("tool-result" t)
         ("assistant"
          (and (seq-every-p #'agentpane--chrome-part-p (plist-get node :parts))
               (not (member (plist-get (plist-get node :meta) :stopReason)
                            '("error" "aborted"))))))))

(defun agentpane--shown (ewoc node step)
  "NODE, an ewoc node of EWOC, if reading view draws it, else the nearest one
it does draw in the direction STEP, `ewoc-next' or `ewoc-prev'; or nil."
  (while (and node (agentpane--elided-p (ewoc-data node)))
    (setq node (funcall step ewoc node)))
  node)

(defun agentpane--locate ()
  "The drawn node at point in this buffer's ewoc, or nil when there is none.
An elided node draws nothing and shares its position with the next drawn
node, or with the end of the nodes when none follows, and `ewoc-locate'
answers it for a point before the first node or after the last: this
answers the drawn node nearest it instead, the one before if any."
  (let* ((ewoc (agentpane--ewoc))
         (node (ewoc-locate ewoc)))
    (or (agentpane--shown ewoc node #'ewoc-prev)
        (agentpane--shown ewoc node #'ewoc-next))))

(defun agentpane--one-line (text max)
  "TEXT with its whitespace collapsed and trimmed, cut to MAX characters with
an ellipsis: the browser's `oneLine'."
  (let ((line (string-trim (replace-regexp-in-string "[[:space:]]+" " " text))))
    (if (> (length line) max)
        (concat (substring line 0 (1- max)) "…")
      line)))

(defun agentpane--tail-line (name face summary)
  "The reading-view tail status line naming NAME, in FACE, and SUMMARY."
  (concat (propertize name 'face face)
          (if (string-empty-p summary) "" (concat " " summary))
          (propertize " … running" 'face 'agentpane-dim)
          "\n"))

(defun agentpane--reading-tail ()
  "The line naming the tool or thinking a streaming turn is running, which
reading view elides, or nil; the browser's `readingTailStatus'.
Only with reading view on while the buffer streams.  Walking back from the
last node, a user node ends the walk with nothing, and within an assistant
node's parts, from the last, non-blank text does too; the first tool or
thinking part met is named.  Other nodes and parts are walked past."
  (and agentpane--reading agentpane--streaming agentpane--ewoc
       (catch 'found
         (let ((at (ewoc-nth agentpane--ewoc -1)))
           (while at
             (let ((node (ewoc-data at)))
               (pcase (plist-get node :role)
                 ("user" (throw 'found nil))
                 ("assistant"
                  (seq-doseq (part (seq-reverse (plist-get node :parts)))
                    (pcase (plist-get part :type)
                      ("text"
                       (unless (string-blank-p (or (plist-get part :text) ""))
                         (throw 'found nil)))
                      ("tool"
                       (throw 'found (agentpane--tail-line (plist-get part :name)
                                                           'agentpane-tool
                                                           (or (plist-get part :summary) ""))))
                      ("thinking"
                       (throw 'found (agentpane--tail-line
                                      "Thinking" 'agentpane-thinking
                                      (if (eq (plist-get part :redacted) t)
                                          "redacted by the provider"
                                        (agentpane--one-line (or (plist-get part :text) "")
                                                             80)))))))))
               (setq at (ewoc-prev agentpane--ewoc at))))
           nil))))

(defun agentpane--hiding-everything-p ()
  "Non-nil when reading view is on and elides every node, of which there is
at least one; the browser's `data-reading-elided' condition."
  (let ((first (and agentpane--reading agentpane--ewoc (ewoc-nth agentpane--ewoc 0))))
    (and first (not (agentpane--shown agentpane--ewoc first #'ewoc-next)))))

(defun agentpane--show-reading-tail ()
  "Show `agentpane--reading-tail' as the line above the prompt separator, or
when it is nil and `agentpane--hiding-everything-p', the browser's line
saying so, since the buffer would otherwise hold only its header; or no
line.  Below it, nearest the prompt, the line saying the last prompt
started no turn, while `agentpane--handled', and above that the
slash-command warning, while the draft starts with `/', in the browser's
order.  An overlay string rather than buffer text, so it moves no node
and no draft, is in no one's undo, and is no node `n', `p' or
`agentpane-index-at-point' can land on.
Called wherever the nodes, reading view or the streaming status change,
or `agentpane--handled', and by `agentpane--follow-slash-draft'."
  (when agentpane--tail-overlay
    (setq agentpane--slash-warned (agentpane--slash-draft-p))
    (let ((lines (delq nil
                       (list (or (agentpane--reading-tail)
                                 (and (agentpane--hiding-everything-p)
                                      (propertize
                                       "Reading view is hiding this session's tool activity and thinking.\n"
                                       'face 'agentpane-dim)))
                             (and agentpane--slash-warned
                                  (propertize (concat agentpane--slash-warning "\n")
                                              'face 'agentpane-warning))
                             (and agentpane--handled
                                  (propertize
                                   "The agent handled that prompt itself; no turn was started for it.\n"
                                   'face 'agentpane-warning))))))
      (overlay-put agentpane--tail-overlay 'before-string
                   (and lines (apply #'concat lines))))))

(defun agentpane--slash-draft-p ()
  "Non-nil when the prompt region's draft starts with `/'."
  (and agentpane--prompt-start (eq (char-after agentpane--prompt-start) ?/)))

(defun agentpane--follow-slash-draft (&rest _)
  "Redraw the line above the prompt separator when the draft has started or
stopped starting with `/'; a buffer-local `after-change-functions' entry
of a transcript, so the warning follows the draft as it is edited."
  (unless (eq (agentpane--slash-draft-p) agentpane--slash-warned)
    (agentpane--show-reading-tail)))

(defun agentpane--show-mode-line ()
  "Show the status fields in the mode line, after `reading' when reading
view is on."
  (let ((fields (if agentpane--reading
                    (cons "reading" agentpane--status-fields)
                  agentpane--status-fields)))
    (setq mode-line-process
          (and fields (concat " [" (mapconcat #'identity fields " · ") "]")))
    (force-mode-line-update)))

;;;; The transcript buffer

(defvar-local agentpane--attached nil
  "The helper connection whose snapshot attached this buffer, or nil.
The buffer's one record of being attached: set by that snapshot and by
nothing else, never by the attach's reply (`agentpane--attach-by',
OW-rebawa), and cleared wherever the helper stops sending under the
buffer's handle -- a `session/detached', or its exit (D25); see
`agentpane--let-go'.  Attached only while that is still the running
connection: a fresh helper has attached nothing.
It took over from a second record, of the connection any notification
carrying the buffer's handle came through, kept while the reply bound
this one: a snapshot could give the buffer its handle before the reply
\(D2), and a helper that exited then left the buffer holding the dead
helper's handle, reading as streaming, neither attached nor let go of
\(OW-bukupu).  Set by that snapshot, this one covers it.")

(defvar agentpane-prompt-region-map
  (let ((map (make-keymap)))
    (set-char-table-range (nth 1 map) (cons ?\s ?~) #'self-insert-command)
    ;; `special-mode-map' is suppressed, remapping this to `undefined'.
    (define-key map [remap self-insert-command] #'self-insert-command)
    (define-key map (kbd "RET") #'newline)
    (define-key map (kbd "DEL") #'delete-backward-char)
    (define-key map (kbd "S-SPC") (lambda () (interactive) (insert " ")))
    (define-key map (kbd "TAB") #'indent-for-tab-command)
    (define-key map (kbd "<tab>") #'indent-for-tab-command)
    map)
  "Keymap over the prompt region, so typing there inserts text rather than
running the transcript's single-key commands.  Keys it leaves unbound, such
as `C-RET', fall through to `agentpane-transcript-mode-map'.")

(defvar agentpane-transcript-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "n") #'agentpane-next)
    (define-key map (kbd "p") #'agentpane-prev)
    (define-key map (kbd "TAB") #'agentpane-toggle)
    (define-key map (kbd "<tab>") #'agentpane-toggle)
    (define-key map (kbd "g") #'agentpane-refetch)
    (define-key map (kbd "a") #'agentpane-attach)
    (define-key map (kbd "f") #'agentpane-edit)
    (define-key map (kbd "e") #'agentpane-edit)
    (define-key map (kbd "o") #'agentpane-open-thread)
    (define-key map (kbd "C-c C-e") #'agentpane-edit-last)
    (define-key map (kbd "C-c C-k") #'agentpane-cancel-edit)
    (define-key map (kbd "r") #'agentpane-toggle-reading)
    (define-key map (kbd "q") #'quit-window)
    (define-key map (kbd "C-<return>") #'agentpane-send)
    (define-key map (kbd "C-c C-a") #'agentpane-abort)
    (define-key map (kbd "C-c C-d") #'agentpane-dismiss-error)
    (define-key map (kbd "C-c C-q") #'agentpane-close-session)
    map)
  "Keymap for `agentpane-transcript-mode'.")

(defun agentpane--insert-prompt-region ()
  "Insert the separator line and an empty prompt region into this empty buffer.
The separator is read-only and does not stick to text typed after it, so
the prompt region below it is the one place the buffer takes typing.  It is
kept out of undo, which would otherwise delete it past the last draft edit."
  (let ((inhibit-read-only t)
        (buffer-undo-list t))
    (insert (propertize "── prompt · C-RET sends ──\n"
                        'face 'agentpane-dim
                        'read-only t
                        'front-sticky '(read-only)
                        'rear-nonsticky t))
    (setq agentpane--prompt-separator (copy-marker (point-min) t))
    (setq agentpane--prompt-start (point-marker))
    ;; Over the separator, and front-advancing, so the nodes inserted at its
    ;; start stay outside it and its string stays right above the separator.
    (setq agentpane--tail-overlay (make-overlay (point-min) (point) nil t nil))
    (overlay-put (make-overlay (point) (point) nil nil t)
                 'keymap agentpane-prompt-region-map)))

(define-derived-mode agentpane-transcript-mode special-mode "agentpane"
  "Major mode for an agentpane transcript, read-only but for the prompt
region at its end, where `RET' inserts a newline and `C-RET' sends.
\\{agentpane-transcript-mode-map}"
  ;; The drawn nodes carry the `read-only' property instead, so the prompt
  ;; region below them can take typing.
  (setq buffer-read-only nil)
  (agentpane--insert-prompt-region)
  (add-hook 'after-change-functions #'agentpane--follow-slash-draft nil t)
  (setq-local agentpane--folds (make-hash-table :test #'equal))
  (add-hook 'kill-buffer-hook #'agentpane--detach nil t)
  (add-hook 'kill-buffer-hook #'agentpane--kill-fork-sent nil t)
  (add-hook 'kill-buffer-hook #'agentpane--forget-turn-done nil t)
  (add-hook 'kill-buffer-hook #'agentpane--kill-composers nil t)
  ;; No ellipsis: a folded header's marker already says there is more, and
  ;; the one-line header needs the room (OW-gageru).
  (add-to-invisibility-spec 'agentpane)
  (add-hook 'window-size-change-functions #'agentpane--refit-on-resize nil t)
  ;; Proportional prose and word wrap at the window edge; code, tables and
  ;; tool bodies inherit `fixed-pitch', so they stay monospace under the
  ;; remapped default.
  (buffer-face-set 'agentpane-prose)
  ;; A little more leading than Emacs's default, toward the browser's 1.55
  ;; line height; the owner asked for "slightly" on 2026-09-22, and 0.15 is
  ;; the value their agent-shell setup already uses.
  (setq-local line-spacing 0.15)
  ;; `fixed-pitch' carries a family and no height, so under the proportional
  ;; default above it would take the prose face's size, larger than the
  ;; default face's (measured 2026-09-22: 19px against 15px in an ordinary
  ;; buffer). Pin it to the default face's absolute height, and everything
  ;; monospace here -- code, tool bodies, diffs -- is the size monospace
  ;; text has elsewhere, and smaller than the prose beside it as the
  ;; browser's 0.9em code is.
  (face-remap-add-relative 'fixed-pitch
                           `(:height ,(face-attribute 'default :height nil t)))
  (setq truncate-lines nil)
  (visual-line-mode 1)
  ;; The owner's init hooks `visual-wrap-prefix-mode' onto `visual-line-mode',
  ;; and that mode rewrites `wrap-prefix' with its own hanging indent, which
  ;; erased the gutter bar from every wrapped row (measured 2026-09-21).
  (when (bound-and-true-p visual-wrap-prefix-mode)
    (visual-wrap-prefix-mode -1)))

(defun agentpane--ewoc ()
  "This buffer's ewoc, or signal an error outside a transcript buffer."
  (or agentpane--ewoc
      (user-error "Not an agentpane transcript buffer")))

(defun agentpane-next (&optional n)
  "Move point to the start of the next node, or the N-th next.
As `ewoc-goto-next', but over the nodes drawn: reading view's elided ones
are stepped over, since point on one is on its drawn neighbour."
  (interactive "p")
  (let ((ewoc (agentpane--ewoc))
        (node (agentpane--locate)))
    (dotimes (_ (or n 1))
      (setq node (and node (agentpane--shown ewoc (ewoc-next ewoc node) #'ewoc-next))))
    (unless node
      (user-error "No next node"))
    (ewoc-goto-node ewoc node)))

(defun agentpane-prev (&optional n)
  "Move point to the start of the previous node, or the N-th previous.
As `ewoc-goto-prev', but over the nodes drawn, as `agentpane-next' is:
from below the last node the first step is onto it, and none goes above
the first."
  (interactive "p")
  (let ((ewoc (agentpane--ewoc))
        (node (agentpane--locate))
        (n (or n 1)))
    (when node
      (when (>= (point) agentpane--prompt-separator)
        (setq n (1- n)))
      (dotimes (_ n)
        (setq node (or (agentpane--shown ewoc (ewoc-prev ewoc node) #'ewoc-prev) node)))
      (ewoc-goto-node ewoc node))))

(defun agentpane-index-at-point ()
  "The transcript index of the node at point, or nil when the buffer has no nodes.
`agentpane--locate' answers the nearest drawn node, so the header and the
end of the buffer resolve to the first and last drawn."
  (let ((node (agentpane--locate)))
    (and node (plist-get (ewoc-data node) :index))))

(defun agentpane--goto-fold (key)
  "Move point to the summary line carrying fold KEY within the node at point."
  (let ((ewoc (agentpane--ewoc)))
    (goto-char (ewoc-location (ewoc-locate ewoc)))
    (let ((match (text-property-search-forward 'agentpane-fold key t)))
      (when match
        (goto-char (prop-match-beginning match))
        (skip-chars-forward "▸▾ ")))))

(defun agentpane-toggle ()
  "Toggle the fold at point: a tool or thinking part's folded body."
  (interactive)
  (let* ((ewoc (agentpane--ewoc))
         (key (or (get-text-property (point) 'agentpane-fold)
                  (save-excursion
                    (beginning-of-line)
                    (get-text-property (point) 'agentpane-fold))))
         (node (ewoc-locate ewoc)))
    (unless (and key node)
      (user-error "No fold at point"))
    (if (agentpane--expanded-p key)
        (remhash key agentpane--folds)
      (puthash key t agentpane--folds))
    (agentpane--above-prompt (lambda () (ewoc-invalidate ewoc node)))
    (agentpane--goto-fold key)))

(defun agentpane-toggle-reading ()
  "Toggle reading view in this buffer: the transcript with its tool calls,
tool results and thinking elided, as the browser's reading view shows it.
See `agentpane--elided-p'.  The ewoc keeps every node either way, so this
redraws and fetches nothing, and expanded folds stay expanded.  Point on a
node stays on it, or goes to the next drawn one when it is elided."
  (interactive)
  (let ((node (and agentpane--ewoc (< (point) agentpane--prompt-separator)
                   (agentpane--locate))))
    (setq agentpane--reading (not agentpane--reading))
    (when agentpane--ewoc
      (agentpane--keeping-points
       (lambda () (agentpane--above-prompt (lambda () (ewoc-refresh agentpane--ewoc)))))
      (let ((drawn (and node (or (agentpane--shown agentpane--ewoc node #'ewoc-next)
                                 (agentpane--shown agentpane--ewoc node #'ewoc-prev)))))
        (when drawn (ewoc-goto-node agentpane--ewoc drawn)))))
  (agentpane--show-reading-tail)
  (agentpane--show-mode-line))

(defun agentpane--ref (summary)
  "The session ref plist of SUMMARY."
  (plist-get summary :ref))

(defun agentpane--transcript-header (summary)
  "The line above the nodes of SUMMARY's transcript."
  (let ((ref (agentpane--ref summary)))
    (format "%s %s\n%s"
            (plist-get ref :backend) (plist-get ref :id)
            (or (plist-get summary :cwd) ""))))

(defvar agentpane--editing)

(defun agentpane-refetch ()
  "Refetch this buffer's transcript and redraw it.
An attached one is attached again, which answers with a fresh
`session/snapshot', since a preview would draw the stored transcript over
the live one.  Any other is read through `sessions/preview': a buffer is
live exactly when attached (D26), so one the helper let go of previews
too, and goes live again only by a send or `agentpane-attach'.  Until
OW-vugefa such a buffer attached here, so as not to draw the stored
transcript over the live one it still showed.
A preview answered `gone' -- the server holds nothing under the buffer's
ref and no file backs it -- kills the buffer; see `agentpane--gone'.  So
does one whose ref no longer reaches its session, D21's \"Still open\"
case, which until OW-vugefa attached again at each `g' and met a 404: a
first cut (D26 point 7), since the conversation may live on under the
name it went to, which OW-tujami asks whether the buffer can learn.
Any other failure leaves the buffer as it is, the echo area saying so.
A preview's answer draws nothing, and its `gone' kills nothing, once the
buffer is attached, as the browser's `landPreview' ignores a pane that
has gone live: an attach still out as the preview went, which the helper
answers with the snapshot that attaches the buffer, wins, so the stored
transcript is never drawn over the live one (OW-yibimi).  A second `g'
on a buffer whose attach is out sends an attach the helper joins to it
\(D32 point 4).  Until ark3/agentpane#71 a buffer still attaching sent
nothing, nor one with a close in flight, which the server's wait for the
close's disposal now covers (D32 point 5).
One whose session is not made yet \(`agentpane--made-before') sends
nothing, and says why in the echo area rather than signalling, since
opening a session from the picker refetches its buffer, and an error
would leave it unshown.  Until ark3/agentpane#75 one with a plain fork
in flight did too; an attach while an edit's fork of the session is out
the helper refuses (D32 point 4)."
  (interactive)
  (unless agentpane--session
    (user-error "Not an agentpane transcript buffer"))
  (cond
   ((not (agentpane--made-p))
    (message "agentpane: this session is not made yet; its snapshot draws it"))
   (agentpane--attached
    (agentpane--attach))
   (t
    (agentpane--request 'sessions/preview
                        (list :session (agentpane--ref agentpane--session))
                        (lambda (nodes)
                          (unless (agentpane--attached-p)
                            (agentpane--draw nodes (agentpane--transcript-header agentpane--session))))
                        nil nil nil
                        (lambda (data)
                          (when (equal (plist-get data :error) "gone")
                            (agentpane--gone)))))))

(defun agentpane--gone ()
  "Kill this buffer, whose session a preview answered `gone' (D26): it has
nothing to preview, and a send could only attach a ref the server no
longer holds (OW-vasubu), as for a session closed or forked and never
prompted.  The browser clears its selection to the startup view at the
same answer.  What the user typed in the prompt region goes on the kill
ring first, as the browser's draft survives its Detach (OW-watawe);
under an edit, as on a fork closed before its first turn, the edit's
text goes there and then the draft it displaced, so that `yank' brings
back the draft and `yank-pop' the edit.  Any composer sending here goes
too, its text going on the kill ring before these, so one `yank-pop'
further back (`agentpane--kill-composers').  The kill ring rather than
keeping the buffer, whose send could only attach that ref in vain, or
asking before the kill, which would prompt from inside the preview's
callback.  The echo area says why the buffer went, and where its text
is.  A buffer attached by then is live, and is left alone: its attach
answered after the preview went (`agentpane-refetch')."
  (unless (agentpane--attached-p)
    (let ((composed (agentpane--kill-composers))
          (texts (seq-remove
                  #'string-empty-p
                  (delq nil (list (buffer-substring-no-properties
                                   agentpane--prompt-start (point-max))
                                  (plist-get agentpane--editing :draft))))))
      (mapc #'kill-new texts)
      (message "agentpane: the session of %s is gone, and the buffer was killed%s"
               (buffer-name)
               (if (or texts composed) "; its prompt's text is on the kill ring" ""))
      (kill-buffer))))

(defun agentpane--same-ref-p (a b)
  "Non-nil when session refs A and B name the same session."
  (and (equal (plist-get a :backend) (plist-get b :backend))
       (equal (plist-get a :id) (plist-get b :id))))

(defun agentpane--buffer-for (ref &optional pred)
  "The transcript buffer holding the session REF, or nil.
With PRED, only one where PRED, called with no arguments in it, answers
non-nil.  A REF naming no session id finds nothing, so no lookup finds a
buffer made for a session not yet made (`agentpane--made-before'), which
holds no id either."
  (and (plist-get ref :id)
       (seq-find (lambda (buffer)
                   (let ((held (buffer-local-value 'agentpane--session buffer)))
                     (and held (agentpane--same-ref-p (agentpane--ref held) ref)
                          (or (null pred) (with-current-buffer buffer (funcall pred))))))
                 (buffer-list))))

(defun agentpane--buffer-holding (handle)
  "The transcript buffer holding the session handle HANDLE, or nil."
  (seq-find (lambda (buffer)
              (equal (buffer-local-value 'agentpane--handle buffer) handle))
            (buffer-list)))

(defun agentpane--buffer-name (summary)
  "The transcript buffer name for SUMMARY: the backend and the project, as
Magit names a repository -- the last component of the session's cwd, or the
session id where there is no cwd.  Sessions in one project are told apart
only by the `<2>', `<3>' that `generate-new-buffer' adds."
  (let* ((ref (agentpane--ref summary))
         (cwd (plist-get summary :cwd))
         (project (and cwd (file-name-nondirectory (directory-file-name cwd)))))
    (format "*agentpane/%s: %s*"
            (plist-get ref :backend)
            (if (or (null project) (string-empty-p project))
                (plist-get ref :id)
              project))))

(defun agentpane--transcript-buffer (summary)
  "The transcript buffer for SUMMARY's session, created if there is none.
The buffer holding the summary's handle, which a listing carries for a
session the server holds, so no second buffer opens on a live session;
else the one holding its ref; else a new one (`agentpane--new-transcript')."
  (or (and (plist-get summary :handle)
           (agentpane--buffer-holding (plist-get summary :handle)))
      (agentpane--buffer-for (agentpane--ref summary))
      (agentpane--new-transcript summary)))

(defun agentpane--new-transcript (summary)
  "A new transcript buffer holding SUMMARY, named by `agentpane--buffer-name',
under a view id minted for it (`agentpane--view').
Its `default-directory' is the session's cwd, where the summary gives one,
rather than that of whichever buffer was current (OW-ruhotu)."
  (let ((buffer (generate-new-buffer (agentpane--buffer-name summary)))
        (cwd (plist-get summary :cwd)))
    (with-current-buffer buffer
      (agentpane-transcript-mode)
      (unless (or (null cwd) (string-empty-p cwd))
        (setq default-directory (file-name-as-directory cwd)))
      (setq agentpane--session summary
            agentpane--view (setq agentpane--views (1+ agentpane--views))))
    buffer))

(defun agentpane--made-before (backend cwd)
  "A new transcript buffer, not shown, for the session a `sessions/create'
or `sessions/forkAndPrompt' about to go out will make on BACKEND in CWD,
so that the request can name its view (D32 point 3).  It holds
`(:ref (:backend BACKEND) :cwd CWD)', no session id, until the snapshot
under its view gives it the session's ref (`agentpane--hold-ref'); no ref
lookup finds it meanwhile (`agentpane--buffer-for'), and `g' and a send
say the session is not made yet (`agentpane--made-p').  A request
refused, naming no session, kills it; so does a helper's teardown while
it is still unfilled (`agentpane--helper-gone').  Until D32 the snapshot
carried a token, and the buffer was made for it."
  (agentpane--new-transcript (list :ref (list :backend backend) :cwd cwd)))

(defun agentpane--made-p ()
  "Non-nil when this buffer's session has been made: its ref names an id,
which a buffer `agentpane--made-before' made holds only once a snapshot or
a reply has given it one."
  (plist-get (agentpane--ref agentpane--session) :id))

(defun agentpane--show-holder (view)
  "Show the buffer of VIEW in each window showing this one, and say so,
for an attach or a prompt from this buffer that landed on the handle
VIEW's buffer holds: the helper bound nothing for this one, which stays a
preview with its draft (D32 point 2).  Where VIEW's buffer has been
killed since, say that instead, showing nothing.  Return VIEW's buffer,
or nil."
  (let ((holder (agentpane--view-buffer view)))
    (if (not holder)
        (message "agentpane: this session is open in a buffer killed since; %s stays a preview"
                 (buffer-name))
      (dolist (window (get-buffer-window-list nil nil t))
        (set-window-buffer window holder))
      (message "agentpane: this session is open in %s; %s stays a preview"
               (buffer-name holder) (buffer-name)))
    holder))

(defvar agentpane--composer)

(defun agentpane--hold-ref (ref)
  "Make REF, when non-nil, the ref of the session this buffer holds,
leaving the buffer's name, and its composer's, as they were: the backend
and project they name do not change with the ref, and a name that fell
back to the session id keeps the old one."
  (unless (or (null ref) (agentpane--same-ref-p ref (agentpane--ref agentpane--session)))
    (setq agentpane--session (plist-put (copy-sequence agentpane--session) :ref ref))))

(defun agentpane--set-status (params)
  "Show the streaming, compaction, model and effort fields of PARAMS in the
mode line, and keep the streaming field in `agentpane--streaming' and the
model in `agentpane--model'.
The effort is the one the status reports, named right after the model as a
turn's meta line names it (OW-zobiro).  When the status's is null, its
`defaultEffort', the model's from the helper's `models/list', stands in
for it, as the same field and unmarked, as the browser's effort select
shows it (OW-gogaki, D32 point 8); when that is null too, no effort is
named.
When the status's `unrestoredModel' names a model, the model field says it
was not restored, so a resume that fell back does not read as chosen (D23,
OW-firaja); it follows the field, which the server clears, and has no
dismissal of its own.
When streaming ends, the last node is redrawn, since it was drawn as the
pending turn, a tool call with no result on it as running, and the helper
re-sends no node for the change; and reading view's tail status goes.
The turn-done watch is the helper's, which says a turn ended by
`session/turnEnded' (`agentpane--turn-ended')."
  (setq agentpane--status params)
  (let ((was agentpane--streaming))
    (setq agentpane--streaming (eq (plist-get params :isStreaming) t))
    (when (and was (not agentpane--streaming) agentpane--ewoc)
      (let ((tail (agentpane--drawn agentpane--tail-index)))
        (when tail
          (agentpane--above-prompt
           (lambda () (ewoc-invalidate agentpane--ewoc tail)))))))
  (setq agentpane--status-fields
        (delq nil
              (list (and (eq (plist-get params :isStreaming) t) "streaming")
                    (let ((compaction (plist-get params :compaction)))
                      (and compaction (concat "compaction " compaction)))
                    (let ((unrestored (plist-get params :unrestoredModel)))
                      (if unrestored
                          (concat (plist-get params :model) " "
                                  (propertize (format "(%s not restored)" unrestored)
                                              'face 'agentpane-warning))
                        (plist-get params :model)))
                    (or (plist-get params :effort) (plist-get params :defaultEffort)))))
  (setq agentpane--model (plist-get params :model))
  (agentpane--show-edit-hint)
  (agentpane--show-reading-tail)
  (agentpane--show-mode-line))

;;;; Driving the session

(defun agentpane--attached-p ()
  "Non-nil when this buffer's session is attached through the running helper."
  (and agentpane--attached (eq agentpane--attached agentpane--connection)
       (jsonrpc-running-p agentpane--attached)))

(defun agentpane--attach (&optional then failed)
  "Attach this buffer's session through `sessions/attach', then call THEN,
or FAILED if the attach fails.
From here on the helper sends this session's notifications, starting with a
`session/snapshot' that redraws the buffer and is what attaches it
\(`agentpane--attach-by').  The reply only ends the request: it binds
nothing, and calls THEN only where that snapshot has attached the buffer
by then, and FAILED otherwise, saying so, so the caller acts on whether
the helper feeds the buffer rather than on the reply (OW-rebawa).  A reply
naming another view landed on the handle that view's buffer holds: the
helper bound nothing here, and that buffer is shown in this one's windows,
the echo area naming it once (`agentpane--show-holder', D32 point 2).  The
helper writes the reply only after the snapshot that answers the attach,
or once none will (`sessions/attach' in src/emacs/helper.ts), and
jsonrpc.el may hand the reply on later than it came but never earlier, so
at the reply the buffer is attached exactly when the helper holds an
attachment for it.  An attach whose snapshot never reaches the buffer --
a `seq' gap took it (OW-tifiva), the session went before its snapshot
came, or the helper died (OW-kifuhi) -- ends not attached.

A second attach while one is out joins it in the helper, which sends the
server nothing and answers both alike (D32 point 4), so each caller gets
its own answer and none is sent beside the first.  Until
ark3/agentpane#71 the buffer queued the waiters itself, since two in
flight answered separately and the first to fail ended the wait while
the other was still out (OW-yibimi).

The helper refuses one, `forking', while an edit's fork of the session
is out, from any view (D32 point 4), so no attach reaches the server
after it has let go of a Pi fork's parent inside the fork, where it
would resume the parent's old branch.  Until ark3/agentpane#75 a plain
fork in flight refused one here too."
  (agentpane--request 'sessions/attach
                      (list :session (agentpane--ref agentpane--session)
                            :view agentpane--view)
                      (lambda (answer)
                        (let ((holder (plist-get answer :view)))
                          (cond
                           (holder
                            (agentpane--show-holder holder)
                            (when failed (funcall failed)))
                           ((agentpane--attached-p)
                            (when then (funcall then)))
                           (t
                            (message "agentpane: the attach answered, but the session \
did not attach")
                            (when failed (funcall failed))))))
                      t failed agentpane--spawn-timeout))

(defun agentpane--attach-now ()
  "Attach this buffer's session through `sessions/attach', and return only
once the attach has answered, for a command that must then read from the
session's live adapter; see `agentpane-new-session'.  It blocks Emacs for
up to `agentpane--spawn-timeout', and a timeout, an error or a quit
signals, leaving the buffer unattached.  So does a reply by which no
snapshot has attached the buffer, since only a snapshot does
\(`agentpane--attach-by'): the helper writes the reply after the snapshot
that answers the attach, and a notification that arrives while this
waits is handled at once.  A reply naming another view shows that view's
buffer, as `agentpane--attach' does, and signals, running nothing there.

With an asynchronous attach in flight, as when `agentpane-set-model'
follows a first prompt's attach, the helper joins this one to it and
answers it with that one's answer (D32 point 4), so no second attach goes
beside it; until ark3/agentpane#71 this refused instead."
  (let ((holder (plist-get (jsonrpc-request (agentpane--connection) 'sessions/attach
                                            (list :session (agentpane--ref agentpane--session)
                                                  :view agentpane--view)
                                            :timeout agentpane--spawn-timeout)
                           :view)))
    (when holder
      (let ((buffer (agentpane--show-holder holder)))
        (user-error "This session is open in %s"
                    (if buffer (buffer-name buffer) "a buffer killed since")))))
  (unless (agentpane--attached-p)
    (user-error "The attach answered, but the session did not attach")))

(defun agentpane--detach ()
  "Stop the helper sending this buffer's session's notifications.
The buffer-local `kill-buffer-hook' of a transcript, and what a Pi fork
does for its parent, which the server leaves detached.
Without it the helper went on sending them after a kill, since only
`sessions/close' removed a session from its attached set, and a buffer
reopened from the picker drew them over its preview: a node that arrived
before the preview's reply signalled on the missing ewoc, and the reopened
buffer, not attached, took `g' to preview a live session.
`sessions/detach' rather than `sessions/close', which closes the session
on the server and lets go of its agent (`SessionManager.close' in
src/server/http/session-manager.ts): killing a buffer leaves the session
running, as closing a browser tab does.

It names the buffer's view, and the helper gives up every attach from that
view still out and drops the view's binding, whatever this buffer
believes of either: an attach that failed here -- timed out, or quit in
`agentpane--attach-now' -- may still have succeeded in the helper, and a
buffer killed before handling its snapshot left the helper bound to it
\(`sessions/detach' in src/emacs/protocol.ts).  No other view's binding
is touched, the helper binding no handle to two views (D32 point 2).
Until D32 it carried the token of every attach this buffer and every
buffer it had absorbed sent, and the helper held a handle's attachment
until every token answered under it was released (OW-nowihu).

Never sent without a running helper, so a kill never starts one, as
`agentpane--connection' would.  An error sending it, such as a pipe that
has just broken, is reported and goes no further, since an error in
`kill-buffer-hook' stops the kill; not through `with-demoted-errors',
which lets it through under `debug-on-error'.

The helper drops the turn-done watch on the view's handle at the detach,
raising nothing, as a closed tab hears nothing more (D32 point 6); a
buffer attached to the session later takes the same handle while the
server holds it, where a watch left standing would raise the indicator
for a turn from elsewhere."
  (when (and agentpane--connection (jsonrpc-running-p agentpane--connection))
    (condition-case err
        (agentpane--request 'sessions/detach
                            (list :session (agentpane--ref agentpane--session)
                                  :view agentpane--view)
                            #'ignore t)
      (error (message "agentpane: sessions/detach failed: %s" (error-message-string err))))))

(defvar agentpane--fork-sent)

(defun agentpane--kill-fork-sent ()
  "Kill the buffer made for the fork this buffer's edit has in flight
\(`agentpane--fork-sent'), if any: the buffer-local `kill-buffer-hook' of
a transcript.  Its own kill detaches its view, which gives the fork's
attach up in the helper, and nothing would show it once the edit's
buffer is gone."
  (when (buffer-live-p agentpane--fork-sent)
    (kill-buffer agentpane--fork-sent)))

(defvar-local agentpane--composer nil
  "This transcript's composer buffer, once `agentpane-prompt' has made one.")

(defvar-local agentpane--composer-transcript nil
  "The transcript buffer this composer sends to.")

(defun agentpane--transcript ()
  "The transcript buffer a command in the current buffer is about."
  (cond ((and (derived-mode-p 'agentpane-transcript-mode) agentpane--session)
         (current-buffer))
        ((and (derived-mode-p 'agentpane-composer-mode)
              (buffer-live-p agentpane--composer-transcript))
         agentpane--composer-transcript)
        (t (user-error "Not an agentpane transcript or composer buffer"))))

(defvar-local agentpane--sending nil
  "Non-nil while a prompt, or an edit's fork and prompt, this transcript
buffer sent has not answered: set as it goes out, and cleared by its
reply, its failure or its timeout.  The buffer's record of its own send,
which the helper's table does not replace (D32 point 4): it refuses a
second send here, so a `busy' from the helper never reaches the second
send's FAILED, which would clear the first's state, as the browser keeps
`submit''s guard beside its own; and it holds the release of queued text
\(`agentpane--release-queued'), an edit's opening, a rename and a close.
A teardown resets it (`agentpane--helper-gone').")

(defvar-local agentpane--editing nil
  "While the prompt region holds an earlier user message taken back to edit
\(`agentpane-edit'), a plist: `:index', that message's transcript index;
`:images', its images as the prompt's `images' take them; `:draft', the
prompt region's text the edit displaced; `:overlay', the overlay naming
the edit over the prompt separator; and `:label', the message's text as
the overlay names it.  Nil otherwise.  Whether its send stops a running
turn is read from the fork points held (`agentpane--edit-stops-p').")

(defvar-local agentpane--fork-sent nil
  "The buffer made for the fork the `sessions/forkAndPrompt' this buffer's
edit sent will make (`agentpane--made-before'), while the request has not
answered, or nil.
The snapshot under that buffer's view binds it, as the snapshot answering
an attach binds the buffer that sent it (`sessions/forkAndPrompt' in
src/emacs/protocol.ts), and a kill of this buffer kills it, giving the
fork's attach up (`agentpane--kill-fork-sent').  Nothing reads it as the
request being out: the helper refuses an attach of the session forked
while it is (D32 point 4), and `agentpane--sending' is this buffer's
record of its send.  Until ark3/agentpane#71 it refused this buffer's
attaches too.")

(defvar-local agentpane--held-queued nil
  "The prompts this buffer's stops took out of Pi's queue (D16), in the
order the stops answered, waiting for the prompt region to hold no edit
and no prompt in flight; see `agentpane-abort'.")

(defvar-local agentpane--displaced nil
  "The draft displaced by an edit whose send ended it, the fork's prompt
having answered, waiting, as `agentpane--held-queued' waits, for the
prompt region to hold no edit and no prompt in flight; nil when there is
none.  See `agentpane--send-edit' (OW-hakeno).")

(defun agentpane--with-queued (queued draft)
  "DRAFT once QUEUED, prompts a stop took out of Pi's queue (D16), come back
to it: those prompts in order, then DRAFT, blank lines between, and a blank
DRAFT dropped.  The same rule as the browser's `withQueued'
\(src/client/controller.ts), which is Pi's own for the same moment, so
that both clients give the words back in the shape Pi's TUI does
\(OW-seleri)."
  (string-join (seq-remove #'string-blank-p (list (string-join queued "\n\n") draft))
               "\n\n"))

(defun agentpane--release-queued ()
  "Join the prompts `agentpane--held-queued' holds, then the draft
`agentpane--displaced' holds, ahead of the prompt region's text, once the
region holds no edit and no prompt is in flight; the one place either is
released, run wherever an edit or a prompt ends.  The stopped prompts go
first, so every way an edit ends leaves the region as
`agentpane-cancel-edit' does; a blank displaced draft adds nothing, and a
region it would only rewrite is left alone, as in the browser's release
below `stop' in src/client/App.svelte (OW-kijuju, OW-hakeno).  See
`agentpane-abort'."
  (when (and (or agentpane--held-queued agentpane--displaced)
             (not agentpane--editing) (not agentpane--sending))
    (let ((queued (if (and agentpane--displaced (not (string-blank-p agentpane--displaced)))
                      (append agentpane--held-queued (list agentpane--displaced))
                    agentpane--held-queued)))
      (setq agentpane--held-queued nil
            agentpane--displaced nil)
      (when queued
        (agentpane--set-draft
         (agentpane--with-queued
          queued (buffer-substring-no-properties agentpane--prompt-start (point-max))))))))

(defun agentpane--send-prompt (text sent &optional images failed)
  "Send TEXT as a prompt to the session of the current buffer's transcript,
with IMAGES, a list of the plists the prompt's `images' take, then call
SENT.  A prompt the server refuses, such as one sent mid-turn
\(DESIGN D16), shows the server's text in the echo area and SENT is not
called, so the draft stays where it was; FAILED, if given, is called
instead, as it is for any other failure of the attach or the prompt.
While the transcript holds an edit (`agentpane-edit'), TEXT goes instead
into a fork at the edited message, with that message's images; see
`agentpane--send-edit'.

Every send is one `sessions/prompt' carrying the buffer's view and text,
and the helper chooses how it goes (D30, D32 point 4).  An attached
buffer marks its prompt `live', and the helper sends it under the handle
the buffer's view is bound to, the server prompting only the live
session under it and refusing it `not_attached' once that handle has
ended, as the helper refuses it once the binding has gone, at an `ended'
or a gap it read before the prompt: a close crossing the prompt starts
nothing (D32 point 1).  Any other buffer's prompt is not marked `live':
where the buffer's attach is still out the helper waits for it and sends
the prompt under the handle it bound, refusing it with the attach's error,
or `not_attached', where it bound nothing; with none out it sends it by
ref, and the server attaches the session if it must and then prompts it,
the snapshot under the view attaching this buffer as an attach's does
\(`agentpane--attach-by'), the helper writing the reply, or a refusal
naming the session it attached, after it.  A refusal still leaves the
buffer attached where the server attached the session before refusing
the prompt.  The helper refuses that one, `forking', while an edit's fork
of the session is out (D32 point 4); until ark3/agentpane#75 a plain
fork in flight refused it here too.
A reply, or a refusal's `attached', naming another view landed on the
handle that view's buffer holds (D32 point 2): the helper bound nothing
here, and that buffer is shown in this one's windows, the echo area
naming it (`agentpane--show-holder').  The text counts as sent here, as
any successful send's does, and only what was typed since stays as this
buffer's draft; the helper arms the turn-done watch on that buffer's
handle, and a prompt the backend handled says so there.
Until ark3/agentpane#71 the buffer chose among these itself, waiting on
its own attach in flight.

One send at a time per session, as the browser allows (OW-nasofa): until
the prompt has answered, which it does once the turn is accepted, a second
send says so and sends nothing.  The draft stays visible until that answer,
so pressing again while a backend spawns is the natural move, and without
this each press attached and prompted with the same text, which the Codex
adapter makes a steer of the turn the first began (D16).  The helper
refuses a second prompt from the view `busy' too, guarding the wire.
Nor does one go while the session compacts: from Compact's press to
its reply the helper refuses it `busy', which reads as any refusal,
keeping the text, and from the server's status saying so to the status
saying it has ended it is refused here, as the browser holds Send
\(`send' in src/client/App.svelte, OW-natiha): the backends cannot
safely admit a turn beside a compaction.  That covers an edit's send
too, as the browser holds Fork.

The answer leaves the turn error alone.  The server owns it, and the
`session/errorCleared' it broadcasts when it admits the prompt drops it
here as in every other client (OW-lohubo), as `submit' in
src/client/controller.ts leaves it to `error-cleared'.  A clear at the
answer could only guess from the message whether the error was still the
one held at the send, and a new turn failing at once with the same text,
its `session/errorCleared' and `session/error' both handled before the
held-back answer, lost the error the server still held.  The server
writes that `session/errorCleared' ahead of the answer (D31 point 3),
and jsonrpc.el can hand an answer on later than it came, never earlier.

The prompt names the error the buffer held when it was sent, by
`agentpane--error-id', or none, and the server clears only that one at
admission (OW-jokoto).  Read here, at the send, before the attach the
helper holds the prompt for, or the one it makes: an error that attach's
start raises, drawn from its snapshot, is newer than the prompt, and
admitting it must not clear it.

The turn-done watch is the helper's (D32 point 6): it arms it for the
prompt where none stands, from an attached buffer's at receipt and from
any other's under the handle its attach lands on, and takes it down for a
server refusal or a handled answer only where this prompt armed it, as
the browser's `disarmSubmit' does (OW-mifuki, OW-zikiga).  A timeout, the
helper's death and an error of the helper's own leave it standing, since
the prompt may have been admitted (OW-dunahe, OW-hiliti).  Until D32
agentpane-mode kept the watch, a claim per prompt (OW-kakasu), and took
its claim back from `agentpane--request''s UNSENT and REPLIED.

A prompt the backend handled itself, starting no turn for it -- a Pi
extension command such as `/mcp' -- answers `(:disposition \"handled\")'
where a started one answers nil (`sessions/prompt' in
src/emacs/protocol.ts, OW-dulipe).  It still counts as sent, so SENT
clears the draft, and the helper drops the watch it armed for it
\(OW-taviju, OW-yobayi, OW-kejire).
The buffer says no turn was started for it, `agentpane--handled', until the
next send; through an edit that is the fork's buffer, where the prompt
went.  A buffer killed before the answer says nothing."
  (when (string-blank-p text)
    (user-error "Nothing to send"))
  (with-current-buffer (agentpane--transcript)
    (cond
     ((not (agentpane--made-p))
      (user-error "This session is not made yet; send once it is"))
     (agentpane--sending
      (user-error "A prompt to this session is already being sent"))
     ((plist-get agentpane--status :compaction)
      (user-error "This session is compacting; send once the compaction ends"))
     (agentpane--editing
      (agentpane--hold-handled nil)
      (agentpane--send-edit text sent))
     (t
      (let ((live (agentpane--attached-p))
            (failed (lambda ()
                      (setq agentpane--sending nil)
                      (when failed (funcall failed))
                      (agentpane--release-queued)))
            (prior (and agentpane--error agentpane--error-id))
            (handled (lambda (answer) (equal (plist-get answer :disposition) "handled"))))
        (agentpane--hold-handled nil)
        (setq agentpane--sending t)
        (if live
            (agentpane--request 'sessions/prompt
                                (append (list :session (agentpane--ref agentpane--session)
                                              :view agentpane--view :live t
                                              :text text :priorErrorId prior)
                                        (and images (list :images (vconcat images))))
                                (lambda (answer)
                                  (setq agentpane--sending nil)
                                  (when (funcall handled answer)
                                    (agentpane--hold-handled t))
                                  (funcall sent)
                                  (agentpane--release-queued))
                                t failed agentpane--spawn-timeout)
          (agentpane--request 'sessions/prompt
                              (append (list :session (agentpane--ref agentpane--session)
                                            :view agentpane--view
                                            :text text :priorErrorId prior)
                                      (and images (list :images (vconcat images))))
                              (lambda (answer)
                                (let* ((holder (plist-get answer :view))
                                       (target (if holder (agentpane--view-buffer holder) (current-buffer))))
                                  (setq agentpane--sending nil)
                                  (unless (or holder (agentpane--attached-p))
                                    (message "agentpane: the prompt answered, but the session did not attach"))
                                  (when (and (buffer-live-p target) (funcall handled answer))
                                    (with-current-buffer target
                                      (agentpane--hold-handled t)))
                                  (funcall sent)
                                  (agentpane--release-queued)
                                  (when holder (agentpane--show-holder holder))))
                              t failed agentpane--spawn-timeout
                              (lambda (data)
                                (let ((holder (plist-get (plist-get data :attached) :view)))
                                  (when holder (agentpane--show-holder holder)))))))))))

(defun agentpane--hold-handled (handled)
  "Set `agentpane--handled' to HANDLED, and draw it or take its line down."
  (setq agentpane--handled handled)
  (agentpane--show-reading-tail))

(defun agentpane--clear-sent (buffer beg text)
  "Delete TEXT from BEG to the end of BUFFER, if it is still exactly there."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (when (equal (buffer-substring-no-properties beg (point-max)) text)
        (delete-region beg (point-max))))))

(defun agentpane-attach ()
  "Attach this buffer's session, sending it nothing, and once attached move
point to the end of the prompt region, as the browser's Attach button opens
a previewed session and focuses the prompt.  Point moves in the buffer and
in the window the press came from, if that still shows it, and in no other
window, which may be reading history, as an edit's send shows its fork
in the window the send came from (`agentpane--send-edit').  An attach
that fails moves nothing.
An attached buffer attaches nothing and only moves point; any other
moves it once its own attach answers, which the helper joins to one
still out (`agentpane--attach').
One not attached is refused by the helper while an edit's fork of the
session is in flight, as every attach is: a Pi fork's parent the server
has already let go of would be attached again, spawning its old branch
\(D32 point 4)."
  (interactive)
  (with-current-buffer (agentpane--transcript)
    (let* ((window (get-buffer-window))
           (move (lambda ()
                   (goto-char (point-max))
                   (when (and (window-live-p window) (eq (window-buffer window) (current-buffer)))
                     (set-window-point window (point-max))))))
      (if (agentpane--attached-p)
          (funcall move)
        (agentpane--attach move)))))

(defun agentpane-send ()
  "Send the prompt region's text as a prompt, and clear the region once sent.
The first prompt on a previewed session attaches it."
  (interactive)
  (let ((buffer (agentpane--transcript)))
    (with-current-buffer buffer
      (let ((start agentpane--prompt-start)
            (text (buffer-substring-no-properties agentpane--prompt-start (point-max))))
        (agentpane--send-prompt
         text (lambda () (agentpane--clear-sent buffer start text)))))))

(defun agentpane-abort ()
  "Abort the running turn of this buffer's session through `sessions/abort'.

The request waits up to `agentpane--spawn-timeout' for its answer.  On Pi
the server holds a stop behind the prompts already written to Pi for up
to 5s (`stopWaitMs' in src/server/adapters/pi/process.ts, D16) before
Pi's own abort runs, and an answer dropped at jsonrpc.el's 10s default
would take its `:queued' texts with it.

On Pi the abort also clears the prompts steered into the turn that Pi had
not yet delivered, and answers with their text, `:queued', or nil when
it cleared nothing (D16, OW-wisifo).  They are the user's own undelivered
words, and come back to this buffer's prompt region (OW-seleri) by the
rule the browser's `stop' in src/client/App.svelte follows (OW-fahoti):
where they go is decided by what the region holds when the answer lands,
never by which command sent the stop.  Joined into an open edit
\(`agentpane-edit') they would be sent into the fork as part of it, or
overwritten by `agentpane-cancel-edit' -- the case that made the browser
change shape.  Joined while a prompt from this buffer is in flight, they
would leave its sent text standing at its answer, the region no longer
being exactly what was sent (`agentpane--clear-sent').  So they wait in
`agentpane--held-queued' until the buffer holds no edit and sends
nothing, and are then joined ahead of whatever the region holds,
`agentpane--with-queued'; with neither in the way, a plain stop's usual
case, that is at once.  That covers an edit open when the answer lands,
however it was opened.  A stop answered before an edit opens lands in
the region, is displaced into the edit's draft like any draft, and comes
back with it however the edit ends (OW-hakeno).
`agentpane--release-queued' runs wherever either ends:
- Cancel puts the displaced draft back first, so they land ahead of it.
- An edit's send, once the fork's prompt has answered, ends the edit,
  clears the sent text from the region, and hands the displaced draft to
  the same release, which joins them ahead of it, so the region reads as
  Cancel would have left it (OW-kijuju, OW-hakeno).  A send that fails
  leaves the edit open, and they keep waiting with it
  (`agentpane--send-edit').
- A plain prompt's answer clears its text, and they take its place; one
  that fails leaves its text, and they land ahead of it.

They belong to this buffer, the one whose session was stopped.  The
browser has one composer for every session, so its words follow the
selection, to the fork after an edit's send; here every transcript buffer
has a prompt region of its own, and they stay in this one even when an
edit's send has put the fork in its window.

They go to the prompt region even when a composer sends here
\(`agentpane-prompt'): every transcript has the region, and it is where
an edit lives, so what they wait on is the region's own state; a
transcript may have no composer; and
`agentpane-composer-discard' kills a composer's text unasked, a discard
the user meant for their own draft, not for words put there since.  The
composer's window sits below the transcript's, whose region ends the
buffer."
  (interactive)
  (with-current-buffer (agentpane--transcript)
    (unless agentpane--handle
      (user-error "This session is not attached; attach it to stop its turn"))
    (agentpane--request 'sessions/abort
                        (list :session (agentpane--ref agentpane--session)
                              :view agentpane--view)
                        (lambda (answer)
                          (setq agentpane--held-queued
                                (append agentpane--held-queued (plist-get answer :queued) nil))
                          (agentpane--release-queued))
                        t nil agentpane--spawn-timeout)))

(defun agentpane-compact ()
  "Compact this buffer's session through `sessions/compact'.
Only an attached session, as `agentpane-abort' stops only one and as the
browser compacts only a live session, and none while one compacts or its
turn streams, as the browser's Compact is disabled then; every backend
refuses a compaction mid-turn (D16).  The buffer writes no mark of its
own.  From the press to the request's reply the helper holds it, as the
browser's `compacting' does: it refuses a send, and a second compact,
from the buffer's view `busy' (D32 point 4).  The server's status then
says the compaction is `requesting', then `running', and while it does
Send and Compact are refused here (`agentpane--send-prompt'), as the
browser refuses them while its `compaction' is set.  The server writes
that status ahead of the request's reply (D31 point 3).
Until ark3/agentpane#71 the buffer marked its status `requesting' as the
request went out, so that `agentpane-close-session' refused before the
server's status came, and a status carrying none could wipe the mark
\(OW-husivu)."
  (interactive)
  (with-current-buffer (agentpane--transcript)
    (unless (agentpane--attached-p)
      (user-error "This session is not attached; attach it to compact it"))
    (when (plist-get agentpane--status :compaction)
      (user-error "This session is already compacting"))
    (when agentpane--streaming
      (user-error "This session's turn is running; compact it once the turn ends"))
    (agentpane--request 'sessions/compact
                        (list :session (agentpane--ref agentpane--session)
                              :view agentpane--view)
                        #'ignore t)))

(defun agentpane-close-session ()
  "Close this buffer's session through `sessions/close', which ends its
subprocess on the server, as the browser's Tools Detach does (`detach' in
src/client/controller.ts).  Not `agentpane--detach', which killing the
buffer runs, and which only stops the helper's notifications, leaving the
session running: the browser's Detach is the helper's `sessions/close',
not its `sessions/detach'.

Refused, sending nothing, wherever the browser offers no Detach
\(`detachable' in src/client/App.svelte): a session this buffer has not
attached, for there is nothing of its own to close -- one whose create
is still starting among them, which the browser lists `virtual' and
offers no Detach for (D35 point 3); one streaming or compacting,
since a kill mid-turn loses the reply, on Claude Code all of it
\(OW-japuzo); and one with a prompt or a fork in flight, both of which the
browser's `sending' covers.  Compacting counts from the server's first
status that carries it (`agentpane-compact').
The close names the buffer's view; the helper closes the session by the
handle the view is bound to, and the server's `ended' for that handle,
written ahead of the close's reply, unbinds the view (`sessions/close' in
src/emacs/protocol.ts).  Until D32 it carried the token of every attach
this buffer had sent or taken from a buffer it absorbed (OW-nowihu).

Nothing refuses while the close is out, as nothing does in the browser
\(D32 point 5): the `session/detached' for the handle, which comes ahead
of the close's reply (D26, D31 point 3), leaves the buffer not attached,
and a press then is the user asking for the session back.  An attach, or
a prompt by ref, that reaches the server while it disposes of the
session waits that out and starts a fresh agent (`#disposing' in
`SessionManager.attach', src/server/http/session-manager.ts).  A second
close sent before the `session/detached' is refused `not_attached', by
the helper or the server (D35 point 3), and the echo area says so; one
pressed after it finds the buffer not attached, or closes what was
attached since.
Until ark3/agentpane#71 the buffer refused all of these while its close
was in flight (OW-dakeyi), and a close while an attach was out.

Once the close answers, the buffer lets go of the handle it closed, if
the `session/detached' has not already, and never of one it attached
since; the helper drops the turn-done watch on that handle at the
reply, if the server's `ended' has not already.  Then, if still not
attached, it previews, as `agentpane-refetch'
does in any buffer not attached, the server letting go of the session
before its subprocess is gone (D26): one on disk is redrawn from
its stored transcript, the read-only preview the browser lands on, and a
send attaches it again.  One with nothing on disk -- a session created or
forked and never prompted -- has nothing to preview, and the preview
answers `gone', which kills the buffer, its prompt region's text, and
its composer's, going to the kill ring first, as the browser clears its
selection to the startup view; see `agentpane--gone'.  Until OW-vugefa
a listing asked
after the close said whether the session was on disk, since until
OW-royosa the preview answered a ref the server no longer held with an
empty transcript rather than an error (OW-vasubu), and a listing that
failed left the buffer
holding a ref it could only attach in vain (OW-vetebu); the close stayed
in flight until that listing answered, so that a send in between could
not attach in vain and the kill then take its text (OW-watawe).  A send
while the preview is out now goes out, and a `gone' the preview answers
after it kills nothing, the send's request having superseded the
preview's; see `agentpane--request'.
A close that fails is reported in the echo area and leaves the buffer as
it was."
  (interactive)
  (with-current-buffer (agentpane--transcript)
    (cond
     ((not (agentpane--attached-p))
      (user-error "This session is not attached; there is nothing to close"))
     ((or agentpane--streaming (plist-get agentpane--status :compaction))
      (user-error "This session is running a turn; close it once the turn ends"))
     (agentpane--sending
      (user-error "A request to this session is in flight; close it once it answers")))
    (let ((handle agentpane--handle))
      (agentpane--request
       'sessions/close (list :session (agentpane--ref agentpane--session)
                             :view agentpane--view)
       (lambda (_)
         (when (equal agentpane--handle handle)
           (setq agentpane--handle nil
                 agentpane--attached nil))
         (unless (agentpane--attached-p)
           (agentpane-refetch)))
       t))))

(defun agentpane-dismiss-error ()
  "Dismiss this buffer's turn error through `sessions/dismissError'.
The server holds the error for every later snapshot (OW-bipume), so it is
told, naming the one the buffer holds by `agentpane--error-id', so that a
newer one survives, even one with the same text (OW-jokoto); the buffer
clears it at once, as the browser's banner goes before its dismissal has
answered (OW-desufa)."
  (interactive)
  (with-current-buffer (agentpane--transcript)
    (unless agentpane--error
      (user-error "No turn error to dismiss"))
    (unless agentpane--handle
      (user-error "This session is not attached; attach it to dismiss its error"))
    (agentpane--request 'sessions/dismissError
                        (list :session (agentpane--ref agentpane--session)
                              :view agentpane--view
                              :errorId agentpane--error-id)
                        #'ignore t)
    (agentpane--hold-error nil)))

(defun agentpane--read-model (backend)
  "Read a model id for BACKEND from its `models/list', with completion.
Synchronous, since the answer is what the minibuffer offers; the stall
`agentpane--request' describes needs a second synchronous request nested
inside this one, and nothing the notifications run is synchronous."
  (let ((models (jsonrpc-request (agentpane--connection) 'models/list
                                 (list :backend backend))))
    (completing-read (format "Model for %s: " backend)
                     (mapcar (lambda (model) (plist-get model :id)) models)
                     nil t)))

(defun agentpane--read-effort (backend model)
  "Read an effort id for BACKEND's MODEL, from the efforts its entry in
`models/list' offers, with completion, or return nil, prompting for
nothing, when MODEL is nil or offers none (OW-vozaku).  Synchronous for
the reason `agentpane--read-model' is."
  (let* ((models (and model (jsonrpc-request (agentpane--connection) 'models/list
                                             (list :backend backend))))
         (entry (seq-find (lambda (entry) (equal (plist-get entry :id) model)) models))
         (efforts (mapcar (lambda (effort) (plist-get effort :id))
                          (plist-get entry :efforts))))
    (when efforts
      (completing-read (format "Effort for %s: " model) efforts nil t))))

(defun agentpane--check-gate (what)
  "Signal a user error, saying WHAT is chosen before the first prompt,
unless this buffer's session is not yet prompted: it has no indexed node
but system ones, as the browser's `unprompted' (src/client/render/system.ts)
has it.  As of `pi 1.2.0' a Pi fork at the first user message kept the
session's leading system message and nothing else (docs/MANUAL_TESTING.md,
OW-vijine), and is no more prompted than an empty session (OW-widozi).
The model is chosen at conversation start, never switched later (owner,
2026-09-13), and the effort with it (OW-vozaku); the browser enforces the
same through `unprompted' and its callers, and neither the server nor
the helper does."
  (with-current-buffer (agentpane--transcript)
    (when (and agentpane--ewoc
               (ewoc-collect agentpane--ewoc
                             (lambda (data)
                               (and (plist-get data :index)
                                    (not (equal (plist-get data :role) "system"))))))
      (user-error "The %s is chosen before the first prompt" what))))

(defun agentpane-set-model (model &optional then)
  "Set this buffer's session's MODEL through `sessions/setModel'.
Allowed only before the first prompt, while the buffer has no nodes but
system ones (`agentpane--check-gate').
An empty MODEL, which `completing-read' returns for an empty `RET' even
when it requires a match, sets nothing, and the session keeps the model
it has.  Sent, \"\" was stored by the Codex adapter and reported as the
model while its turns ran on the default, refused by the Pi adapter, and
handed to Claude Code as it was (OW-kisemu, read from the adapters in
src/server/adapters/ at daf5f52, not run live).

THEN, when given, runs with no arguments once the server has taken MODEL,
in the buffer the request went from, or at once for an empty MODEL; never
when the request fails, which is reported in the echo area.  It is how
`agentpane-new-session' holds the effort back until the model is taken.

Interactively a session not yet attached is attached before the models
are read, and synchronously, as `agentpane-new-session' creates, and for
its reason: the server answers `models/list' from a live adapter of the
backend, or else from an unstarted one, which for Codex or Pi fails.
Read first, they were unreadable for a created session never prompted
whenever no other session of its backend was live, as after a server
restart (OW-kisemu, read from `listModels' in src/server/http/app.ts at
daf5f52, not run live).  Called on a session not attached, it attaches
it the same way before sending MODEL; until ark3/agentpane#71 it waited
on an asynchronous attach the buffer held the waiters of."
  (interactive
   (progn
     (agentpane--check-gate "model")
     (with-current-buffer (agentpane--transcript)
       (unless (agentpane--attached-p)
         (agentpane--attach-now))
       (list (agentpane--read-model (plist-get (agentpane--ref agentpane--session)
                                               :backend))))))
  (if (string-empty-p model)
      (when then (funcall then))
    (agentpane--check-gate "model")
    (with-current-buffer (agentpane--transcript)
      (unless (agentpane--attached-p)
        (agentpane--attach-now))
      (agentpane--request 'sessions/setModel
                          (list :session (agentpane--ref agentpane--session)
                                :view agentpane--view :model model)
                          (lambda (_) (when then (funcall then)))
                          t))))

(defun agentpane--check-renamable ()
  "Signal a user error unless this buffer's session can be renamed now:
attached, with no turn, compaction, prompt or fork running, and, on Codex,
prompted at least once, as the browser's `renamable'
\(src/client/App.svelte) offers Rename only then, and for its reasons.
A name is written through to the backend (D13, \"Names are not
marks\"), so the server refuses one for a session not attached
\(`sessions/setName' in src/emacs/protocol.ts), and the Codex adapter
refuses one for a thread not yet prompted, which the rename alone would
write into Codex's store (docs/MANUAL_TESTING.md, OW-kametu).  A buffer
whose ewoc holds no indexed node -- notices and errors carry no index --
stands in for one not yet prompted, as an empty transcript does for the
browser and the adapter.  Not attached is therefore refused
rather than attached first, as `agentpane-set-model' would."
  (with-current-buffer (agentpane--transcript)
    (cond
     ((not (agentpane--attached-p))
      (user-error "This session is not attached; attach it to rename it"))
     ((or agentpane--streaming (plist-get agentpane--status :compaction))
      (user-error "This session is running a turn; rename it once the turn ends"))
     (agentpane--sending
      (user-error "A request to this session is in flight; rename it once it answers"))
     ((and (equal (plist-get (agentpane--ref agentpane--session) :backend) "codex")
           (not (ewoc-collect (agentpane--ewoc)
                              (lambda (data) (plist-get data :index)))))
      (user-error "Codex cannot name a session before its first prompt; prompt it first")))))

(defun agentpane-rename-session (name)
  "Name this buffer's session NAME through `sessions/setName'.
Allowed only where `agentpane--check-renamable' allows it, which is
checked before NAME is read, and again before it is sent.  A NAME blank
once trimmed sends nothing, as the browser's Rename sends nothing for one
\(`renameSession' in src/client/App.svelte); the server would refuse it.
The buffer keeps no copy of the name: it arrives in the listing the
`sessions/changed' that follows asks for.  So nothing is offered as the
name to edit, as the browser offers its row's: the buffer's summary is
the one it was last opened from (`agentpane-show-transcript'), which a
rename from this buffer leaves behind."
  (interactive
   (progn
     (agentpane--check-renamable)
     (list (read-string "Rename session: "))))
  (unless (string-blank-p name)
    (agentpane--check-renamable)
    (with-current-buffer (agentpane--transcript)
      (agentpane--request 'sessions/setName
                          (list :session (agentpane--ref agentpane--session)
                                :view agentpane--view :name name)
                          #'ignore t))))

(defun agentpane-set-effort (effort)
  "Set this buffer's session's reasoning EFFORT through `sessions/setEffort'.
Allowed only before the first prompt, as `agentpane-set-model' is, and an
empty EFFORT sets nothing, for that command's reason (OW-vozaku).

Interactively the session is attached first, as for `agentpane-set-model'
and for its reason, and the efforts offered are those of the model its
last status named, `agentpane--model'; when that model offers none, or no
status has named one yet, it prompts for nothing and says so.  Called on
a session not attached, it attaches it synchronously too, as
`agentpane-set-model' does."
  (interactive
   (progn
     (agentpane--check-gate "effort")
     (with-current-buffer (agentpane--transcript)
       (unless (agentpane--attached-p)
         (agentpane--attach-now))
       (unless agentpane--model
         (user-error "No model is known yet for this session; try again once one is"))
       (list (or (agentpane--read-effort (plist-get (agentpane--ref agentpane--session)
                                                    :backend)
                                         agentpane--model)
                 (user-error "The model offers no effort to choose"))))))
  (unless (string-empty-p effort)
    (agentpane--check-gate "effort")
    (with-current-buffer (agentpane--transcript)
      (unless (agentpane--attached-p)
        (agentpane--attach-now))
      (agentpane--request 'sessions/setEffort
                          (list :session (agentpane--ref agentpane--session)
                                :view agentpane--view :effort effort)
                          #'ignore t))))

(defun agentpane-edit ()
  "Take the user message at point back into the prompt region to edit, as the
browser's pencil does: its text replaces the prompt region's, and the
separator above it says which message is being edited.  The next send from
this buffer or its composer forks at that message and prompts the fork
with the text sent and the message's images, opening the fork in a
transcript buffer of its own (`agentpane--send-edit'), and leaving this
buffer holding its session.  The fork holds the history before that
message, without the message itself: every backend's fork point excludes
the user message it names.  `C-c C-k' \(`agentpane-cancel-edit')
abandons the edit and forks nothing.  Bound to `e' and to `f': the edit
is agentpane-mode's only fork, as it is the browser's (D33).  Until
ark3/agentpane#75 `f' forked with nothing sent, by a plain fork command
the wire no longer has.

A message no fork point names is not editable (DESIGN D20), and carries
no ✎ mark.  The press reads the set the helper last sent the buffer
\(`agentpane--forkable'), by the transcript index each point names,
never counted: a Codex steer puts two user messages in one turn, which
is one point, so the set moves under the transcript (OW-roveze).  Such
a message is refused at the press, saying it is not forkable, and the
server matches the index again at the send, refusing rather than
forking elsewhere should the set have moved meanwhile (D30), and the
edit stays open.  Before the buffer's first set has arrived every user
message is offered, as the browser offers each while its set is
unknown (D33 point 4).  Until ark3/agentpane#76 the points were fetched
at the press, and the edit opened once they answered.

A buffer not attached, only previewed, is attached and edits nothing:
once the attach answers, the echo area says the transcript now shows the
live session and to press the key pressed again.  Its indices are the
stored projection's, and the fork points are the live adapter's, which
alone answers the server's `sessions/forkPoints', and the two can name
different messages: a Pi preview drops the `custom_message' entries and
roles such as `bashExecution' that `get_messages' keeps (read from
`pi 0.87.1''s source), and nothing makes the Claude Code store and live
projections agree (OW-gekiki).  So trusting the index could fork at
another message.
Refusing, as the browser does by offering no Edit on a preview, would
cost the user an `agentpane-attach' first; attaching here takes that
step in place.  Attaching redraws the buffer from the live transcript
through the attach's snapshot, so the index at point becomes a live one,
and the second press lets the user confirm the message after that
redraw, which may have moved it.  The message follows that redraw: the
helper writes the attach's reply only after the snapshot that answers it
\(`sessions/attach' in src/emacs/helper.ts), and `agentpane--attach'
calls its THEN only once that snapshot has attached the buffer.  This
covers the parent of a Pi fork too, which is left detached.  A second
press while that attach is out sends an attach the helper joins to it
\(D32 point 4), and says the same once it answers.

A Pi fork moves the parent's live process onto the fork, a container of
its own under a handle of its own, and takes the parent's container out
of the server's table (D24, `SessionManager' in
src/server/http/session-manager.ts), so the parent's handle hears nothing
more but the `ended' that says so (D26).  The helper passes that on as a
`session/detached', which lands before the send's reply and lets go of
the handle (`agentpane--let-go').  At the reply this buffer counts itself
detached, so `g' previews it rather than attaching the parent's old
branch again, and detaches the parent from the helper, dropping its
view's binding, while it still holds the handle the send went from
\(`agentpane--forked-away').  Codex and Claude Code leave the parent
attached.  Either way the parent buffer keeps the live transcript it was
showing, unredrawn: what the server emits of the fork's shortened
transcript goes out under the fork's handle and ref, never the parent's
\(OW-zovaye, OW-nikogo).

Pressed on another message while an edit is open, the edit moves there,
and the draft put back on abandoning it is still the one the first press
displaced, as in the browser (OW-bigotu).

No edit opens while a send from this buffer or its composer is in
flight, its own edit's included, and the echo area says so, as the
browser's `startEdit' refuses (OW-kijuju, OW-hakeno): the edit would
displace whatever the region holds then, for Cancel or the fork to put
back, and that text may be the very prompt on its way, or an edit whose
send is still out, which that send ends only while it is the edit it
sent."
  (interactive)
  (let* ((at (agentpane--locate))
         (node (and at (ewoc-data at)))
         (keys (this-command-keys)))
    (unless (equal (plist-get node :role) "user")
      (user-error "No user message at point"))
    (agentpane--edit node (if (seq-empty-p keys) "e" (key-description keys))
                     "the message at point")))

(defun agentpane-edit-last ()
  "Take the last user message back into the prompt region to edit, as the
browser's Edit last message does: `agentpane-edit' on that message, which
leaves exactly the edit that would, wherever point is.  From a composer
the edit opens in its transcript's prompt region, where it is sent from,
and the transcript is shown at the press.

It is the last user message to have arrived, the nodes recorded and not
yet drawn (`agentpane--record') drawn first, or none.  One no fork point
names is refused as `agentpane-edit' refuses it, and no older message is
edited instead, as the browser withdraws the control rather than quietly
load an older one (OW-roveze).  A transcript holding no user message is
refused too.

Where the fork points held say a fork of the session stops a running
turn (`agentpane--forkable'), which as of ark3/agentpane#47 they say for
Pi alone, and one is running, this also aborts the turn, as the
browser's Stop and edit does: the send would stop it anyway
\(`agentpane--edit-stops-p'), and this stops it at the press instead.
Not through a compaction, which the browser's `streamingAction' leaves
unstoppable, showing Edit last message there.  The abort goes once the
edit is open, so a message that is not forkable costs the turn nothing,
and it is not waited on, since the server's fork stops the session again
before it forks (`PiAdapter.fork').  Codex and Claude Code keep a parent
turn running through a fork, and are not aborted.
What that abort takes out of Pi's queue never joins the edit, which would
send it into the fork: it waits in this buffer until the edit ends, then
lands ahead of the draft the edit displaced, whether
`agentpane-cancel-edit' puts that back or, once the fork's prompt has
answered, the send gives it back -- in this buffer's region, not the
fork's; see `agentpane-abort'.
An edit that does not open, its message not forkable or a send from this
buffer in flight (`agentpane-edit'), stops nothing: the stop is the
edit's."
  (interactive)
  (let ((composer (and (derived-mode-p 'agentpane-composer-mode) (current-buffer))))
    (with-current-buffer (agentpane--transcript)
      (agentpane--draw-recorded (current-buffer))
      (let ((at (ewoc-nth (agentpane--ewoc) -1)))
        (while (and at (not (equal (plist-get (ewoc-data at) :role) "user")))
          (setq at (ewoc-prev agentpane--ewoc at)))
        (unless at
          (user-error "No user message to edit"))
        (when composer
          (pop-to-buffer (current-buffer)))
        (agentpane--edit
         (ewoc-data at) "C-c C-e" "the last message"
         (lambda ()
           (when (agentpane--edit-stops-p)
             (agentpane-abort))))))))

(defun agentpane--edit (node key what &optional then)
  "Open the edit of NODE, a user node, where the fork points held offer it,
and call THEN, if given, once it is open; the body of `agentpane-edit',
which see.  KEY is the command's key and WHAT names the message, for the
echo area."
  (cond
   ((agentpane--attached-p)
    (cond
     ((not (agentpane--forkable-p (plist-get node :index)))
      (message "agentpane: %s is not forkable" what))
     (agentpane--sending
      (message "agentpane: a prompt from this buffer is still \
being sent; press %s once it has answered to edit %s" key what))
     (t (agentpane--start-edit node)
        (when then (funcall then)))))
   (t (agentpane--attach
       (lambda ()
         (message "agentpane: the transcript now shows the live session; \
press %s again to edit %s" key what))))))

(defun agentpane--start-edit (node)
  "Open the edit of NODE, a user node, in this buffer; see `agentpane-edit'.
Its text parts become the prompt region's text, joined by a blank line as
the browser's `startEdit' joins them, and its image parts, carrying `data',
are kept as the prompt's `images' take them, carrying `base64'."
  (let* ((parts (plist-get node :parts))
         (text (mapconcat (lambda (part) (plist-get part :text))
                          (seq-filter (lambda (part) (equal (plist-get part :type) "text")) parts)
                          "\n\n"))
         (images (seq-map (lambda (part)
                            (list :mimeType (plist-get part :mimeType)
                                  :base64 (plist-get part :data)))
                          (seq-filter (lambda (part) (equal (plist-get part :type) "image")) parts)))
         (overlay (if agentpane--editing
                      (plist-get agentpane--editing :overlay)
                    (make-overlay agentpane--prompt-separator (1- agentpane--prompt-start)
                                  nil t nil))))
    (setq agentpane--editing
          (list :index (plist-get node :index)
                :images images
                :draft (if agentpane--editing
                           (plist-get agentpane--editing :draft)
                         (buffer-substring-no-properties agentpane--prompt-start (point-max)))
                :overlay overlay
                :label (agentpane--one-line text 40)))
    (agentpane--show-edit-hint)
    (agentpane--set-draft text)))

(defun agentpane--edit-stops-p ()
  "Whether sending this buffer's edit now stops the session's running turn:
the fork points held say a fork of the session stops one (D30,
`agentpane--forkable'), read now rather than when the edit opened, and
one is running, not a compaction, which the browser's `streamingAction'
leaves unstoppable.  What the browser's \"Stop and fork\" reads
\(`stopsBeforeFork' in src/client/App.svelte).  Before any set has
arrived it reads as stopping nothing, as the browser reads a handle it
has not been told of."
  (and agentpane--editing
       (plist-get agentpane--forkable :forkStopsTurn)
       agentpane--streaming
       (not (plist-get agentpane--status :compaction))))

(defun agentpane--show-edit-hint ()
  "Draw the open edit's hint over the prompt separator: the message it
edits, and what a send does, which names the stop where sending stops a
running turn (`agentpane--edit-stops-p'), as the browser's primary button
reads \"Stop and fork\" there (ark3/agentpane#17).  Drawn again at every
status, which is where a turn starts and ends."
  (when agentpane--editing
    (overlay-put (plist-get agentpane--editing :overlay) 'display
                 (propertize (format "── editing “%s” · C-RET %s · C-c C-k cancels ──"
                                     (plist-get agentpane--editing :label)
                                     (if (agentpane--edit-stops-p)
                                         "stops the turn and forks there"
                                       "forks there"))
                             'face 'agentpane-warning))))

(defun agentpane--set-draft (text)
  "Replace the prompt region's text with TEXT, and move point, in this buffer
and in any window showing it, to the end."
  (delete-region agentpane--prompt-start (point-max))
  (goto-char (point-max))
  (insert text)
  (dolist (window (get-buffer-window-list nil nil t))
    (set-window-point window (point-max))))

(defun agentpane--end-edit ()
  "Close this buffer's edit, leaving the prompt region as it is."
  (delete-overlay (plist-get agentpane--editing :overlay))
  (setq agentpane--editing nil))

(defun agentpane-cancel-edit ()
  "Abandon the edit `agentpane-edit' opened, forking nothing, and put back
the draft it displaced, with what a stop took out of Pi's queue meanwhile
ahead of it (`agentpane-abort')."
  (interactive)
  (with-current-buffer (agentpane--transcript)
    (unless agentpane--editing
      (user-error "No edit to cancel"))
    (let ((draft (plist-get agentpane--editing :draft)))
      (agentpane--end-edit)
      (agentpane--set-draft draft)
      (agentpane--release-queued))))

(defun agentpane--send-edit (text sent)
  "Fork this buffer's session at the message its edit holds, and prompt the
fork with TEXT and that message's images, as one `sessions/forkAndPrompt'
the server runs to the end (D30); once it has answered, end the edit,
call SENT, and show the fork, in a buffer of its own, in the window that
showed this buffer at the send, if it is still live.  The fork's buffer
is made before the request, not shown, and the request names its view as
`forkView' (`agentpane--made-before', D32 point 3); the snapshot under
that view, which the helper writes before the reply, attaches it, as an
attach's does (D25), and where none came it is left not attached, holding
the fork's ref from the reply.  The helper arms the fork's turn-done
watch at the reply, from the level its snapshot left, and none for a
prompt the backend handled, which says so in the fork's buffer, as
`agentpane--send-prompt' says it.

Nothing stops a running turn here: where the backend abandons it at a
fork, which is Pi (D15), the server's fork stops it (`PiAdapter.fork').
The request carries `stops' where the edit's hint says the send stops a
running turn (`agentpane--edit-stops-p'), and the helper drops the
turn-done watch on this buffer's handle as it goes out, raising nothing,
since the stop's last status, and a Pi parent's `ended', arrive before
the reply (D32 point 6).  A Pi fork moves the
parent's live process onto the fork, so at the reply, or at a refusal
naming a fork, this buffer detaches, if it still holds the handle the
send went from (`agentpane--forked-away'); see `agentpane-edit'.

A refusal that names a fork, created before its prompt failed, ends the
edit and moves to the fork, so that sending again prompts that fork
rather than forking this session a second time (ark3/agentpane#17): this
buffer's prompt region gets the draft the edit displaced back, as
`agentpane-cancel-edit' leaves it, and the fork's buffer, shown as above,
gets the text the region held, the edited text unless it was changed
meanwhile.  The fork is attached where the refusal names its handle, the
helper having bound it as above, and not where it names none, the fork
closed before its prompt was refused.  A fork whose own start failed is
not named: the server leaves nothing of it (D35 point 6).  A
refusal that names none, the message no longer a fork point among them,
created nothing, and leaves the edit standing, the edited text still in
the prompt region, as the browser's `send' leaves its edit mode.  Any
failure kills the fork's buffer unless a snapshot has filled it, its
kill giving the fork's attach up in the helper; a refusal naming a fork
with no handle then shows a buffer made for the fork's ref.  From
a buffer holding no handle, one a helper's death or a gap detached, the
send is refused here, sending nothing and leaving the edit standing:
the request names the session by its view, which the helper refuses
`not_attached' where it is bound to no handle (D32 point 1).

This buffer counts as sending, `agentpane--sending', until the request
answers, as the browser's `forkAndSubmit' holds `sending' (OW-kelede),
and while it does the helper refuses an attach of the session forked,
from any view (D32 point 4); a kill of this buffer meanwhile kills the
fork's too (`agentpane--kill-fork-sent').
The edit's lifetime owns the draft it displaced, not Cancel alone
\(OW-kijuju, OW-hakeno): ending the edit here hands that draft to
`agentpane--displaced', and what a stop took out of Pi's queue waits in
this buffer across the send.  Both are released once the edit has ended
and SENT has cleared the sent text, so after SENT, the stopped prompts
ahead of the draft as `agentpane-cancel-edit' leaves them, and never into
the text the fork is prompted with (`agentpane-abort'); freeing the
buffer releases the stopped prompts too, for a send whose edit was
cancelled while it was in flight."
  (unless agentpane--handle
    (user-error "This session is not attached; attach it to send the edit"))
  (let* ((edit agentpane--editing)
         (handle agentpane--handle)
         (window (get-buffer-window))
         (fork (agentpane--made-before (plist-get (agentpane--ref agentpane--session) :backend)
                                       (plist-get agentpane--session :cwd)))
         (images (plist-get edit :images))
         (free (lambda ()
                 (setq agentpane--sending nil
                       agentpane--fork-sent nil)
                 (when (and (buffer-live-p fork)
                            (not (with-current-buffer fork (agentpane--made-p))))
                   (kill-buffer fork))
                 (agentpane--release-queued))))
    (setq agentpane--sending t
          agentpane--fork-sent fork)
    (agentpane--request
     'sessions/forkAndPrompt
     (append (list :session (agentpane--ref agentpane--session)
                   :view agentpane--view
                   :forkView (buffer-local-value 'agentpane--view fork)
                   :index (plist-get edit :index) :text text)
             (and (agentpane--edit-stops-p) (list :stops t))
             (and images (list :images (vconcat images))))
     (lambda (answer)
       (let ((summary (plist-get answer :session)))
         (setq agentpane--sending nil
               agentpane--fork-sent nil)
         (when (eq agentpane--editing edit)
           (setq agentpane--displaced (plist-get edit :draft))
           (agentpane--end-edit))
         (agentpane--forked-away handle)
         (funcall sent)
         (agentpane--release-queued)
         (with-current-buffer (agentpane--show-fork fork (plist-get summary :ref) window)
           (when (equal (plist-get answer :disposition) "handled")
             (agentpane--hold-handled t)))))
     t free agentpane--spawn-timeout
     (lambda (data)
       (let ((named (plist-get data :fork)))
         (when named
           (let ((kept (buffer-substring-no-properties agentpane--prompt-start (point-max))))
             (agentpane--forked-away handle)
             (if (not (eq agentpane--editing edit))
                 (agentpane--show-fork fork (plist-get named :ref) window)
               (let ((draft (plist-get edit :draft)))
                 (agentpane--end-edit)
                 (agentpane--set-draft draft)
                 (agentpane--release-queued))
               (with-current-buffer (agentpane--show-fork fork (plist-get named :ref) window)
                 (agentpane--set-draft kept))))))))))

(defun agentpane--forked-away (handle)
  "Detach this buffer from its session where a fork of it, sent while it
held HANDLE, moved the live process off it, which is Pi's (D24), and only
while it still holds HANDLE: the server's `ended' for it, ahead of the
fork's reply, has usually let go of it already (`agentpane--let-go'), and
a buffer attached since under another handle holds a binding the helper
made after the fork, which a detach here would drop while the buffer
counted itself attached.  See `agentpane-edit'."
  (when (and handle
             (equal agentpane--handle handle)
             (equal (plist-get (agentpane--ref agentpane--session) :backend) "pi"))
    (agentpane--detach)
    (setq agentpane--attached nil)))

(defun agentpane--show-fork (buffer ref window)
  "Show BUFFER, made for the fork REF an edit's request created
\(`agentpane--made-before'), in WINDOW if it is still live, else in the
selected one, and return it.  It takes REF where no snapshot gave it one,
drawn empty under its header and not attached; one killed meanwhile is
replaced by the buffer for REF (`agentpane--transcript-buffer')."
  (let ((cwd (plist-get agentpane--session :cwd)))
    (unless (buffer-live-p buffer)
      (setq buffer (agentpane--transcript-buffer (list :ref ref :cwd cwd))))
    (with-current-buffer buffer
      (agentpane--hold-ref ref)
      (unless agentpane--ewoc
        (agentpane--draw [] (agentpane--transcript-header agentpane--session))))
    (if (window-live-p window)
        (set-window-buffer window buffer)
      (pop-to-buffer buffer '(display-buffer-same-window)))
    buffer))

;;;###autoload
(defun agentpane-new-session (backend)
  "Create a session on BACKEND in the current buffer's project, open its
buffer attached, and read its model from `models/list' with completion,
then its effort, when that model offers any.
`sessions/create' starts the session's agent as it creates it, as one
server operation (D30), and answers once the session is attached: the
buffer is made first, not shown, and the request names its view
\(`agentpane--made-before', D32 point 3), and the snapshot under that
view attaches it, which the helper writes before the reply.  The
model is read after that, as the browser reads it: the server answers
`models/list' for Codex or Pi only from a live adapter, failing with
\"codex adapter not started\" before one exists (measured 2026-09-22).
The create is synchronous for the same reason the model list is; see
`agentpane--read-model'.  A create the helper answered with an error,
the server's refusal or a failure carrying no code, kills its buffer:
a refusal leaves no session behind.  One quit or timed out keeps its
buffer, not shown, for the snapshot, which says where it is when it
comes (`agentpane--ready-message').  A reply with no snapshot having
attached a buffer, which the helper sends only once it expects none,
shows the session's buffer, not attached, and signals.

The efforts offered are the model's just chosen, since the status naming
it may not have arrived, or with an empty choice those of the model the
session already has, if a status has named it (OW-vozaku).  The model is
sent as soon as it is read, and the effort only once the model's reply has
come, whichever of that reply and the effort's read is last: the server
checks an effort against the model the session holds when it arrives,
refusing one that model does not list (OW-tewofe), and the helper answers
requests concurrently, so one sent before could overtake the model and be
checked against the old one (OW-zayefe).  A model that fails is reported
in the echo area, and the effort read for it is never sent."
  (interactive (list (completing-read "Backend: " '("codex" "claude" "pi") nil t)))
  (let* ((cwd (agentpane--current-cwd))
         (connection (agentpane--connection))
         (buffer (agentpane--made-before backend cwd))
         (keep (lambda ()
                 (with-current-buffer buffer
                   (setq agentpane--ready-message "agentpane: the new session is ready in %s"))))
         (summary (condition-case err
                      (jsonrpc-request connection 'sessions/create
                                       (list :cwd cwd :backend backend
                                             :view (buffer-local-value 'agentpane--view buffer))
                                       :timeout agentpane--spawn-timeout)
                    (jsonrpc-error
                     ;; A code says the helper answered; only a timeout carries none.
                     (if (alist-get 'jsonrpc-error-code (cdr err))
                         (kill-buffer buffer)
                       (funcall keep))
                     (signal (car err) (cdr err)))
                    (quit
                     (funcall keep)
                     (signal (car err) (cdr err))))))
    (with-current-buffer buffer
      (agentpane--hold-ref (plist-get summary :ref))
      (unless agentpane--ewoc
        (agentpane--draw [] (agentpane--transcript-header agentpane--session))))
    (pop-to-buffer buffer '(display-buffer-same-window))
    (unless (agentpane--attached-p)
      (user-error "The create answered, but the session did not attach"))
    (let ((model (agentpane--read-model backend))
          (taken nil)
          (effort nil))
      (agentpane-set-model model (lambda ()
                                   (setq taken t)
                                   (when effort (agentpane-set-effort effort))))
      (setq effort (agentpane--read-effort
                    backend
                    (if (string-empty-p model)
                        (buffer-local-value 'agentpane--model buffer)
                      model)))
      (when (and effort taken)
        (agentpane-set-effort effort)))))

;;;; The composer

(defvar agentpane-composer-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "C-c C-c") #'agentpane-composer-send)
    (define-key map (kbd "C-<return>") #'agentpane-composer-send)
    (define-key map (kbd "C-c C-k") #'agentpane-composer-discard)
    (define-key map (kbd "C-c C-a") #'agentpane-abort)
    (define-key map (kbd "C-c C-e") #'agentpane-edit-last)
    map)
  "Keymap for `agentpane-composer-mode'.")

(define-derived-mode agentpane-composer-mode text-mode "agentpane-composer"
  "Major mode for drafting a prompt to an agentpane session, as for a commit
message: `C-c C-c' or `C-RET' sends, `C-c C-k' discards, `C-c C-a' aborts
the running turn, `C-c C-e' edits the last user message in the
transcript's prompt region.  While the draft starts with `/', the header
line carries `agentpane--slash-warning'.
\\{agentpane-composer-mode-map}"
  (add-hook 'after-change-functions #'agentpane--warn-slash-composer nil t))

(defvar-local agentpane--composer-header nil
  "While this composer shows `agentpane--slash-warning', a list holding the
header line the warning replaced, which may itself be nil; else nil.")

(defun agentpane--warn-slash-composer (&rest _)
  "Put `agentpane--slash-warning' in the header line once this composer's
draft comes to start with `/', and put back the header line it replaced
once it no longer does; a buffer-local `after-change-functions' entry.
The header line, because the whole buffer is the draft: it stays in view
above the text however the window scrolls, and puts nothing in the text
that `agentpane-composer-send' reads.  It is touched only at those two
edges, so a header line the user's own config gave the composer stands
otherwise."
  (let ((slash (eq (char-after (point-min)) ?/)))
    (cond ((and slash (not agentpane--composer-header))
           (setq agentpane--composer-header (list header-line-format)
                 header-line-format (propertize agentpane--slash-warning
                                                'face 'agentpane-warning))
           (force-mode-line-update))
          ((and (not slash) agentpane--composer-header)
           (setq header-line-format (car agentpane--composer-header)
                 agentpane--composer-header nil)
           (force-mode-line-update)))))

(defun agentpane--composer-name ()
  "The name of this transcript's composer: the transcript's own, with any
`<N>' Emacs gave it moved inside the stars and \" prompt\" before the
closing one, so `*agentpane/claude: sandbox*<2>' has the composer
`*agentpane/claude: sandbox<2> prompt*'.  Unique as the transcript's is."
  (let* ((name (buffer-name))
         (suffix (if (string-match "<[0-9]+>\\'" name) (match-string 0 name) "")))
    (format "%s%s prompt*"
            (string-remove-suffix "*" (string-remove-suffix suffix name))
            suffix)))

(defun agentpane--kill-composers ()
  "Kill every composer that sends to this transcript, which is being
killed, putting each one's text, when there is any, on the kill ring
first, and return non-nil when any did go there (OW-sihoma).
The buffer-local `kill-buffer-hook' of a transcript.  Left alive, a
composer could send nowhere, every command in it answering that it is
not an agentpane buffer, and it kept its name, so the next transcript in
the project had a composer named with a `<N>' of its own.  The kill ring
rather than asking, as `agentpane--gone' keeps a prompt region's text.
Every composer sending here rather than this buffer's own, though since
D32, which retired the merge that could leave a second, there is one.
A window showing a composer is quit, as `agentpane-composer-discard'
quits its own, so that the one `agentpane-prompt' made goes rather than
staying to show some other buffer; `kill-buffer-quit-windows' does that
through `quit-restore-window' without that function's own kill.
The echo area says the text is on the kill ring; `agentpane--gone',
which runs this before its kill so that the text it keeps goes on the
kill ring after, says so itself."
  (let ((transcript (current-buffer))
        kept)
    (dolist (composer (buffer-list))
      (when (eq (buffer-local-value 'agentpane--composer-transcript composer) transcript)
        (let ((text (with-current-buffer composer
                      (buffer-substring-no-properties (point-min) (point-max)))))
          (unless (string-empty-p text)
            (kill-new text)
            (setq kept t)))
        (let ((kill-buffer-quit-windows t))
          (kill-buffer composer))))
    (when kept
      (message "agentpane: the composer of %s was killed with it; \
its text is on the kill ring" (buffer-name transcript)))
    kept))

(defun agentpane-prompt ()
  "Open this transcript's composer in a small window below it."
  (interactive)
  (let* ((transcript (agentpane--transcript))
         (composer
          (with-current-buffer transcript
            (unless (buffer-live-p agentpane--composer)
              (setq agentpane--composer (generate-new-buffer (agentpane--composer-name)))
              (with-current-buffer agentpane--composer
                (agentpane-composer-mode)
                (setq agentpane--composer-transcript transcript)))
            agentpane--composer)))
    (select-window (display-buffer composer '(display-buffer-below-selected
                                              (window-height . 8))))))

(defun agentpane-composer-send ()
  "Send the composer's text as a prompt, and clear the composer once sent.
Refused while the transcript holds an edit (`agentpane-edit'), which lives
in the transcript's prompt region: sent from here it would fork with this
text and strand the message's text there."
  (interactive)
  (when (buffer-local-value 'agentpane--editing (agentpane--transcript))
    (user-error "The transcript holds an edit: send it from its prompt region, \
or cancel it there with C-c C-k"))
  (let ((composer (current-buffer))
        (text (buffer-substring-no-properties (point-min) (point-max))))
    (agentpane--send-prompt
     text (lambda () (agentpane--clear-sent composer 1 text)))))

(defun agentpane-composer-discard ()
  "Discard the draft: kill the composer and its window."
  (interactive)
  (quit-window t))

(defun agentpane-show-transcript (summary)
  "Show the stored transcript of the session SUMMARY describes."
  (let ((buffer (agentpane--transcript-buffer summary)))
    (with-current-buffer buffer
      (setq agentpane--session summary)
      (agentpane-refetch))
    (pop-to-buffer buffer '(display-buffer-same-window))))

(defun agentpane--thread-ids-at-point ()
  "The child threads named at point, as a list of Codex thread ids: those of
the tool part whose fold point is on, else those of every part of the node
at point.  Each comes from a tool part's `threadIds', which the helper
derives for a subagent call; `args' is display text and is never read."
  (let* ((data (ewoc-data (or (agentpane--locate) (user-error "No node at point"))))
         (key (or (get-text-property (point) 'agentpane-fold)
                  (save-excursion
                    (beginning-of-line)
                    (get-text-property (point) 'agentpane-fold))))
         (parts (append (plist-get data :parts) nil)))
    (when (and key (eql (car key) (plist-get data :index)))
      (setq parts (list (nth (cdr key) parts))))
    (delete-dups (seq-mapcat (lambda (part) (append (plist-get part :threadIds) nil))
                             parts))))

(defun agentpane-open-thread ()
  "Open a child thread the subagent call at point names, as the browser's
subagent card's Open thread does (OW-benige, OW-kelise): the child is a
Codex session of its own, opened as its picker row would open it, by
`agentpane-show-transcript', which previews it and attaches nothing.
With more than one thread named, read which with completion.  The
child's buffer takes this one's workspace, as a fork's does, since the
child's own is known only to a listing.  Works the same in a previewed
transcript as in a live one (OW-gakide)."
  (interactive)
  (let* ((ids (or (agentpane--thread-ids-at-point)
                  (user-error "No child thread at point")))
         (id (if (cdr ids)
                 (completing-read "Open thread: " ids nil t)
               (car ids))))
    (agentpane-show-transcript
     (list :ref (list :backend "codex" :id id)
           :cwd (plist-get agentpane--session :cwd)))))

;;;; The turn-done indicator

(defvar agentpane--turns-done nil
  "The transcript buffers where a turn this Emacs watched ended while no
window showed them, until a window does; see `agentpane--turn-ended'.")

(defvar agentpane--finished-turns)

(defun agentpane--turn-ended (params)
  "Mark the end of the turn a `session/turnEnded' with PARAMS tells of, and
raise the turn-done indicator for one this Emacs watched.
The helper sends it for every live session whose streaming level falls
from true to false, saying whether this Emacs's prompt was watching that
turn, as the browser's favicon watch does (src/client/favicon.ts), and
naming the view bound to its handle, if any (D32 point 6).  What windows
show, and so what has been seen, is Emacs's alone.

The session's row is marked as having finished a turn unseen
\(`agentpane--finished-turns'), watched or not, unless a window shows
the session (`agentpane--seen-p'), as the browser's sidebar marks every
live session it holds (`foldSessionTurns' in
src/client/session-turns.ts); a picker open draws the mark at once, and
one opened later draws it from the table.  Until D32 only a picker's
listings made the mark, reading the level from one listing to the next,
so a turn that ended with no picker open, or within a listing's round
trip, was never marked.

A turn watched that ended in a buffer holding the view, where no window
shows that buffer (`agentpane--shown-p'), raises the indicator, the
favicon badge's counterpart.  Emacs's own focus says nothing about where
the user is looking within it, and a buffer shown is where the turn's end
is read, its mode line's `streaming' going.  The indicator clears when a
window shows the buffer (`agentpane--clear-seen-turns') or the buffer is
killed, one buffer at a time, where the favicon's one badge clears at
once on focus: here each buffer is its own place to look.  It is a red
dot and the word agentpane in `global-mode-string', which every window's
mode line draws by default, so it is in view wherever the user is
working, as a tab's favicon is; its help echo names the buffers.  A
`message' would be gone at the next keystroke, and a desktop notification
needs a GUI, which the home server has not.
Until D32 agentpane-mode kept the watch itself, from the statuses each
buffer folded (OW-lohavi)."
  (let* ((handle (plist-get params :handle))
         (summary (list :ref (plist-get params :session) :handle handle))
         (buffer (agentpane--view-buffer (plist-get params :view))))
    (unless (agentpane--seen-p summary)
      (agentpane--track-seen)
      (puthash handle summary agentpane--finished-turns)
      (agentpane--redraw-pickers))
    (when (and (eq (plist-get params :watched) t)
               buffer
               (not (agentpane--shown-p buffer)))
      (agentpane--track-seen)
      (cl-pushnew buffer agentpane--turns-done)
      ;; Only a list whose first element is a string or a list is a
      ;; list of elements; a user's single construct, a string or an
      ;; `:eval' or conditional, becomes one element of such a list.
      (unless (or (stringp (car-safe global-mode-string))
                  (consp (car-safe global-mode-string)))
        (setq global-mode-string (delq nil (list "" global-mode-string))))
      (add-to-list 'global-mode-string '(:eval (agentpane--turn-done-lighter)) t)
      (force-mode-line-update t))))

(defun agentpane--track-seen ()
  "Install what drops a finished-turn mark and the turn-done indicator once
a window shows their session: `agentpane--clear-seen-turns' on the default
value of `window-state-change-functions', and `agentpane--binding-changed'
watching `agentpane--handle' and `agentpane--session'.  Run wherever
`agentpane--turn-ended' makes a mark or raises the indicator, and never
undone, as both outlive what made them; installing either again changes
nothing.  Until D32 a picker's mode installed them, its listings alone
making a mark."
  (add-hook 'window-state-change-functions #'agentpane--clear-seen-turns)
  (add-variable-watcher 'agentpane--handle #'agentpane--binding-changed)
  (add-variable-watcher 'agentpane--session #'agentpane--binding-changed))

(defun agentpane--turn-done-lighter ()
  "The turn-done indicator, while `agentpane--turns-done' names a buffer."
  (when agentpane--turns-done
    (propertize " ●agentpane" 'face 'agentpane-turn-finished
                'help-echo (concat "Turn finished in "
                                   (mapconcat #'buffer-name agentpane--turns-done ", ")))))

(defun agentpane--forget-turn-done ()
  "Drop this buffer, being killed, from the turn-done indicator."
  (when (memq (current-buffer) agentpane--turns-done)
    (setq agentpane--turns-done (delq (current-buffer) agentpane--turns-done))
    (force-mode-line-update t)))

;;;; The session picker

(defvar-local agentpane--cwd nil
  "The workspace this picker is filtered to, or nil for every session.")

(defvar-local agentpane--listing nil
  "This picker's last listing, every session in it, whose workspaces
`agentpane-sessions-workspace' offers: `tabulated-list-entries' holds only
the rows the filter keeps.")

(defvar agentpane-sessions-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "RET") #'agentpane-sessions-open)
    (define-key map (kbd "w") #'agentpane-sessions-workspace)
    map)
  "Keymap for `agentpane-sessions-mode'.")

(defun agentpane--format-time (iso)
  "ISO, an ISO-8601 timestamp or nil, as a local date and time, or empty."
  (if iso
      (format-time-string "%Y-%m-%d %H:%M" (encode-time (iso8601-parse iso)))
    ""))

(defvar agentpane--finished-turns (make-hash-table :test #'equal)
  "The sessions marked as having finished a turn unseen: a hash table from
the session's handle to its summary, whose ref `agentpane--seen-p' also
looks for, as `session/turnEnded' named it (`agentpane--turn-ended') or
the last listing has it since (`agentpane--note-turns').
One table for every session the helper lists, and not one per picker, as
the browser's marks cover every live session whatever its sidebar's
filter: a mark is about the session, and a picker only draws it.  One
kept per picker, fed by that picker's filtered listing and cleared
against its rows, left a mark the user had cleared by viewing a session
while the picker listed another project, and marked a turn the user
watched end while it was filtered out (OW-yufahi).")

(defun agentpane--session-entry (summary)
  "The `tabulated-list-entries' row for SUMMARY.
Its unnamed column is a dot while the session streams, and a dot in
`agentpane-turn-finished' while it is marked as having finished a turn
unseen, as the browser's row draws `.session-finished'.
Its Workspace column is the last segment of the session's cwd, the full
path as its help echo, and empty with no cwd, as the browser's
`.session-cwd' draws it.
Its Session column is the session's name, and while that is null its
stored preview, and while that is null too, as it is for a session just
prompted until the turn's end re-lists it, the text of the first user
node with any in the transcript buffer holding the session, on one line
\(`agentpane--first-user-text'), as the browser's `sessionLabel'
\(src/client/App.svelte) labels its row (D27); that buffer drawing the
node redraws the row (`agentpane--preview-pickers').  With none it is
empty: the browser's last resort, the backend and id, would repeat the
Backend column."
  (let ((ref (agentpane--ref summary))
        (handle (plist-get summary :handle))
        (cwd (plist-get summary :cwd)))
    (list summary
          (vector (plist-get ref :backend)
                  (plist-get summary :status)
                  (cond ((eq (plist-get summary :isStreaming) t) "●")
                        ((and handle (gethash handle agentpane--finished-turns))
                         (propertize "●" 'face 'agentpane-turn-finished
                                     'help-echo "Turn finished"))
                        (t ""))
                  (agentpane--format-time (plist-get summary :updatedAt))
                  (if cwd (propertize (file-name-nondirectory cwd) 'help-echo cwd) "")
                  (or (plist-get summary :name)
                      (plist-get summary :preview)
                      (agentpane--first-user-text summary)
                      "")))))

(defun agentpane--first-user-text (summary)
  "The text of the first user node whose text parts, joined by a space, are
not blank, in the transcript buffer holding SUMMARY's session by its handle
or else by its ref, as `agentpane--transcript-buffer' finds it; or nil.
The browser's `firstUserText', with each run of whitespace one space, as
the server's `trimPreview' (src/server/sessions/text.ts) makes the stored
preview and the browser's `.session-preview' draws either on one line:
a newline would split the picker's row.  Whitespace is read by the
standard syntax table, since a mode's own can give a newline another
class, as `emacs-lisp-mode' does."
  (let* ((handle (plist-get summary :handle))
         (buffer (or (and handle (agentpane--buffer-holding handle))
                     (agentpane--buffer-for (agentpane--ref summary))))
         (ewoc (and buffer (buffer-local-value 'agentpane--ewoc buffer)))
         (at (and ewoc (ewoc-nth ewoc 0)))
         (found nil))
    (while (and at (not found))
      (let ((node (ewoc-data at)))
        (when (equal (plist-get node :role) "user")
          (let ((text (with-syntax-table (standard-syntax-table)
                        (string-trim
                         (replace-regexp-in-string
                          "[[:space:]]+" " "
                          (mapconcat (lambda (part) (or (plist-get part :text) ""))
                                     (seq-filter (lambda (part)
                                                   (equal (plist-get part :type) "text"))
                                                 (plist-get node :parts))
                                     " "))))))
            (unless (string-empty-p text)
              (setq found text)))))
      (setq at (ewoc-next ewoc at)))
    found))

(defun agentpane--seen-p (summary)
  "Non-nil when a window shows a transcript buffer holding SUMMARY's
session, by its handle or by its ref, as `agentpane--shown-p' reads shown.
This is agentpane-mode's counterpart of the browser's selected session,
for the finished-turn mark: shown in any window, not only the selected
one, since the picker and a transcript side by side is the ordinary
layout, and with the picker selected a turn ending in plain sight would
otherwise be marked.  A window is where the turn's end is read, the mode
line's `streaming' going, whichever window has focus.
The browser marks nothing while no session is selected, which it is only
until its auto-select picks one; no transcript shown anywhere is instead
the ordinary state of working in other buffers, exactly when a turn ends
unseen, so it has no counterpart here."
  (let* ((handle (plist-get summary :handle))
         (held (and handle (agentpane--buffer-holding handle))))
    (or (and held (agentpane--shown-p held))
        (agentpane--buffer-for (agentpane--ref summary)
                               (lambda () (agentpane--shown-p (current-buffer)))))))

(defun agentpane--shown-p (buffer)
  "Non-nil when a window on a visible frame shows BUFFER, a transcript.
A text terminal shows only its top frame, but `frame-visible-p' answers t
for every frame on it, so a window in any other counts for nothing: a
transcript in a `C-x 5 2' frame not on top is not being looked at (Emacs
31.1, `emacs -nw' in a pty, measured 2026-09-26: two frames both answered
t, `tty-top-frame' named the one raised, and this read a transcript shown
only in the other as unseen, and as seen once that one was raised).
A child frame counts when its root frame is on top, since `tty-top-frame'
names the root: a transcript in a child frame of the top frame is in view
\(Emacs 31.1, `emacs -nw' in a pty, measured 2026-09-27: a child frame of
the top frame answered t to `frame-visible-p', and both `tty-top-frame'
and `frame-root-frame' named its parent; with another frame raised, the
child still answered t, the parent no longer on top).
A composer's window counts for nothing either: the composer shows the
draft, not the transcript, and its mode line carries no `streaming', so
the turn's end cannot be read there."
  (seq-some (lambda (window)
              (let* ((frame (window-frame window))
                     (top (tty-top-frame frame)))
                (or (null top) (eq top (frame-root-frame frame)))))
            (get-buffer-window-list buffer nil 'visible)))

(defun agentpane--note-turns (summaries)
  "Fold SUMMARIES, a fresh listing of every session, into the finished-turn
marks `agentpane--turn-ended' makes.  A marked session takes its listed
summary, whose ref a rename may have moved, and its mark is dropped once
a window shows it (`agentpane--seen-p'), here at a listing and at the
next redisplay by `agentpane--clear-seen-turns'.  Marks are kept by
handle, which a rename never moves (D24): a Pi session can take a new id
at its first prompt.  The streaming level, which until D32 this read
from one listing to the next to mark a turn's end, is the helper's
\(D32 point 6).
Nothing moves a mark from a fork's parent to the fork, here or in the
browser: a fork is another session, and a mark belongs to the session
whose turn it observed.  The fork takes the parent's window
\(`agentpane--send-edit'), so a Codex or Claude Code turn still running on
the parent ends off screen and marks the parent, as the browser marks
it when that turn ends with the fork selected; that turn did end
unseen, in a buffer the user can still open.
A handle SUMMARIES does not carry is dropped.  The
listing is never filtered, as `agentpane--refetch-sessions', the one
caller, asks for every session, and the server lists every session it
holds under its handle (`list' in src/server/http/session-manager.ts),
so such a handle is one the server has let go, and it never mints one
again (`#handlePrefix' there).  So a mark outlives a helper's death,
whose next listing carries the same handles, until its session is
shown, and not a close or the server's restart: the owner accepted on
2026-11-20 that a restart drops it (ark3/agentpane#64).  Its mark is
drawn on no row, and kept,
would be re-checked by `agentpane--clear-seen-turns' at every window
change for the life of Emacs, never to be seen: at 5 such marks among
124 buffers a call cost about 310 microseconds, and at 10 among 504
about 2.4 milliseconds (Emacs 31.1, byte-compiled, batch, measured
2026-09-27)."
  (let ((listed (make-hash-table :test #'equal)))
    (dolist (summary summaries)
      (let ((handle (plist-get summary :handle)))
        (when handle
          (puthash handle t listed)
          (when (gethash handle agentpane--finished-turns)
            (if (agentpane--seen-p summary)
                (remhash handle agentpane--finished-turns)
              (puthash handle summary agentpane--finished-turns))))))
    (maphash (lambda (handle _)
               (unless (gethash handle listed)
                 (remhash handle agentpane--finished-turns)))
             agentpane--finished-turns)))

(defun agentpane--clear-seen-turns (&rest _)
  "Drop the finished-turn mark of each session a window now shows, and
redraw every picker if one was dropped; and drop from the turn-done
indicator each buffer a window now shows (`agentpane--turn-ended').
Every mark is checked, whether or not a picker lists its session, and
this runs wherever a marked session may have come into view, so the mark
goes at the redisplay that shows its session rather than lingering until
the next listing.  It runs from one place: the default value of
`window-state-change-functions', which redisplay runs for each frame
where, among other changes, a window changed buffer, the frame was
selected or deselected, or the frame's window state change flag was set.
A window starting to show a transcript is the first.  A text terminal's
frame raised by `C-x 5 o' or `select-frame-set-input-focus', which
changes no window's buffer, is the second (Emacs 31.1, `emacs -nw' in a
pty, measured 2026-09-27: the raise ran the default values of
`window-selection-change-functions' and this hook for both frames, and not
`window-buffer-change-functions'; a `raise-frame' that did not select the
frame left it under the top one, and ran nothing).  A buffer on screen
taking a handle or a ref, which can make it the marked session with no
window changing buffer, is the third: `agentpane--binding-changed',
watching both variables, sets the flag for each frame showing the buffer,
whatever code wrote them.
The hook and the watchers are added by `agentpane--track-seen' wherever
`session/turnEnded' makes a mark or raises the turn-done indicator, and
never removed, as both outlive what made them.  The indicator needs no
watcher, as it names buffers, which a handle or a ref changing does not
move.
With no marks a call of the hook costs about half a
microsecond, and a write to either variable costs about 0.2 microseconds
more than with no watcher (Emacs 31.1, byte-compiled, measured
2026-09-27).
A frame that only comes into view is left, as nothing runs for it: a
text terminal's child frame shown again by `make-frame-visible' after
`make-frame-invisible', and an iconified GUI frame restored, unless the
restore also selects it.  For the child frame this was measured (Emacs
31.1, `emacs -nw' in a pty, 2026-09-27: made visible, it ran none of the
window change hooks for any frame, `agentpane--seen-p' then read the
transcript it shows as seen, and the mark stayed).  For the GUI frame it
is inferred from that, visibility alone running nothing, the home server
having no GUI; on a text terminal, `iconify-frame' on the top frame and
`make-frame-visible' on a root frame under it changed neither which frame
was on top nor what `frame-visible-p' answered, and ran nothing.  Such a
mark stays until the next listing, which the next start or end of any
turn asks for, as does a `g' in the picker.  It is late in going, not
wrong: the turn did end unseen."
  (let ((seen (and agentpane--turns-done
                   (seq-filter #'agentpane--shown-p agentpane--turns-done))))
    (when seen
      (setq agentpane--turns-done (seq-difference agentpane--turns-done seen))
      (force-mode-line-update t)))
  (let ((dropped nil))
    (maphash (lambda (handle summary)
               (when (agentpane--seen-p summary)
                 (push handle dropped)))
             agentpane--finished-turns)
    (when dropped
      (dolist (handle dropped)
        (remhash handle agentpane--finished-turns))
      (agentpane--redraw-pickers))))

(defun agentpane--redraw-pickers ()
  "Redraw every picker's rows from the summaries they hold
\(`agentpane--redraw-rows'), a finished-turn mark having come or gone."
  (dolist (buffer (buffer-list))
    (when (eq (buffer-local-value 'major-mode buffer) 'agentpane-sessions-mode)
      (with-current-buffer buffer
        (agentpane--redraw-rows)))))

(defun agentpane--redraw-rows ()
  "Rebuild this picker's rows from the summaries they hold, and print them:
what a row draws besides its summary has moved, and no listing is needed."
  (setq tabulated-list-entries
        (mapcar (lambda (entry) (agentpane--session-entry (car entry)))
                tabulated-list-entries))
  (tabulated-list-print t))

(defun agentpane--preview-pickers ()
  "Redraw the rows of each picker listing this transcript buffer's session,
by its handle or its ref, with no stored preview and an empty Session, so
that the row takes the text of the user node just drawn at once rather
than at the next listing (`agentpane--first-user-text').
That listing can be a whole turn away: the server asks for one at a
turn's start, which can come before the user node reaches the buffer, and
not again until the turn ends.  On Codex the `userMessage' item followed
`turn/started' by 1.1 to 2.5 seconds in the captures under
resources/fixtures/codex/ (codex-cli 0.147.0 and 0.153.4), where a
listing answers in about a quarter of a second.  The browser's label
reads its transcript reactively, and needs no such call.
The listing still reads the transcript, for a picker opened after the
node was drawn.  An empty Session is what makes this the first user node
with text: once one is drawn, later nodes redraw no picker."
  (let ((handle agentpane--handle)
        (ref (and agentpane--session (agentpane--ref agentpane--session))))
    (when (or handle ref)
      (dolist (buffer (buffer-list))
        (when (and (eq (buffer-local-value 'major-mode buffer) 'agentpane-sessions-mode)
                   (seq-some (lambda (entry)
                               (let ((summary (car entry))
                                     (row (cadr entry)))
                                 (and (null (plist-get summary :preview))
                                      (string-empty-p (aref row (1- (length row))))
                                      (or (and handle (equal (plist-get summary :handle) handle))
                                          (and ref (agentpane--same-ref-p
                                                    (agentpane--ref summary) ref))))))
                             (buffer-local-value 'tabulated-list-entries buffer)))
          (with-current-buffer buffer
            (agentpane--redraw-rows)))))))

(defun agentpane--binding-changed (_symbol _newval _operation where)
  "Have the next redisplay run `agentpane--clear-seen-turns' for each frame
that shows WHERE, a buffer whose `agentpane--handle' or `agentpane--session'
is about to change, while any mark is outstanding.
The variable watcher of both, so that every write to either -- a
notification's, an attach reply's, or any other -- reaches the one owner
of the re-check, with no call its site must remember: a buffer already on
screen can become a marked session with no window changing buffer.  It
only sets each frame's window state change flag, which makes redisplay
run the default value of `window-state-change-functions' for that frame,
since a watcher runs before the write, when a re-check would still read
the old value (Emacs 31.1, measured 2026-09-27: a flag set from a timer,
and one set from a process filter as jsonrpc.el's notifications are
handled, each ran that hook for the frame at the next redisplay, in
`emacs -nw' in a pty with no explicit `redisplay').
WHERE is nil for a `setq-default', which binds no buffer; a buffer-local
write, `let' and its unwinding, and the `makunbound' of a mode change
each name the buffer (Emacs 31.1, batch, measured 2026-09-27)."
  (when (and (bufferp where) (> (hash-table-count agentpane--finished-turns) 0))
    (dolist (window (get-buffer-window-list where nil 'visible))
      (set-frame-window-state-change (window-frame window) t))))

(defun agentpane--refetch-sessions (&rest _)
  "Refetch the listing through `sessions/list', and redraw it under this
buffer's filter when the reply lands.  The picker's `revert-buffer-function'.
Every session is asked for, and those outside the filter are dropped here,
by the exact match on each summary's cwd the browser's sidebar makes over
its own unfiltered listing (`filteredSummaries' in src/client/App.svelte),
so that `agentpane--note-turns', which drops the mark of a handle the
listing lacks, keeps the marks of sessions the picker does not show, as
the browser's cover every live session whatever its filter.  The server walks
every session's file whatever the filter, and filters after, so what
that costs is the size of the reply.
That was measured and left (Emacs 31.1 with jsonrpc.el 1.0.29, bun 1.4.0,
measured 2026-09-27; docs/MANUAL_TESTING.md, OW-wazipa): on the home
server's 369 stored sessions the reply was 116 KB, which the helper
relayed in 207 to 277 ms, where the server alone answered it in 205 to
222 ms, and a filtered one in 194 to 229 ms; Emacs parsed it in about
0.8 ms, and folding it and dropping all but one row, with no session
held, took 0.24 ms more.
The server's own `cwd' filter differs in one row: it also lists a live
session under the cwd it was created with when the file its CLI wrote
records another (`list' in src/server/http/session-manager.ts), which
neither client now asks it for."
  (agentpane--request 'sessions/list nil
                      (lambda (summaries)
                        (let ((summaries (append summaries nil)))
                          (agentpane--note-turns summaries)
                          (setq agentpane--listing summaries)
                          (setq tabulated-list-entries
                                (mapcar #'agentpane--session-entry
                                        (if agentpane--cwd
                                            (seq-filter (lambda (summary)
                                                          (equal (plist-get summary :cwd)
                                                                 agentpane--cwd))
                                                        summaries)
                                          summaries))))
                        (tabulated-list-print t))))

(define-derived-mode agentpane-sessions-mode tabulated-list-mode "agentpane-sessions"
  "Major mode listing agentpane sessions.
\\{agentpane-sessions-mode-map}"
  (setq tabulated-list-format
        [("Backend" 8 t)
         ("Status" 9 t)
         ("" 2 nil)
         ("Updated" 17 t)
         ("Workspace" 16 t)
         ("Session" 0 nil)])
  (setq tabulated-list-sort-key '("Updated" . t))
  (setq-local revert-buffer-function #'agentpane--refetch-sessions)
  (tabulated-list-init-header))

(defun agentpane--revert-pickers ()
  "Refetch every picker buffer's listing."
  (dolist (buffer (buffer-list))
    (when (eq (buffer-local-value 'major-mode buffer) 'agentpane-sessions-mode)
      (with-current-buffer buffer
        (revert-buffer)))))

(defun agentpane-sessions-open ()
  "Open the transcript of the session on this row."
  (interactive)
  (let ((summary (tabulated-list-get-id)))
    (unless summary
      (user-error "No session on this line"))
    (agentpane-show-transcript summary)))

(defun agentpane--current-cwd ()
  "The workspace of the current buffer: its project root, else `default-directory'.
Without the trailing slash, as the server stores a session's cwd."
  (let ((project (project-current nil)))
    (directory-file-name
     (expand-file-name (if project (project-root project) default-directory)))))

;;;###autoload
(defun agentpane-sessions (&optional all)
  "List agentpane sessions in the current buffer's project, and make that
project the picker's `default-directory'.
With a prefix argument ALL, list every session instead, and leave the
picker's directory as it was."
  (interactive "P")
  (let ((cwd (and (not all) (agentpane--current-cwd)))
        (buffer (get-buffer-create "*agentpane sessions*")))
    (with-current-buffer buffer
      (unless (eq major-mode 'agentpane-sessions-mode)
        (agentpane-sessions-mode))
      (agentpane--filter-picker cwd))
    (pop-to-buffer buffer '(display-buffer-same-window))))

(defun agentpane--filter-picker (cwd)
  "Filter this picker to CWD, a workspace, and make it the picker's
`default-directory', or with CWD nil list every session and leave the
directory as it was; then refetch."
  (setq agentpane--cwd cwd)
  (when cwd
    (setq default-directory (file-name-as-directory cwd)))
  (setq mode-line-process (and cwd (format " [%s]" (file-name-nondirectory cwd))))
  (revert-buffer))

(defun agentpane--workspaces ()
  "The distinct cwds of this picker's last listing, the most recently
updated session's first, as the browser's Workspace select offers them
\(`workspaceOptions' in src/client/App.svelte)."
  (let ((recency (lambda (summary)
                   (let ((iso (or (plist-get summary :updatedAt)
                                  (plist-get summary :createdAt))))
                     (if iso (float-time (encode-time (iso8601-parse iso t))) 0))))
        (cwds nil))
    (dolist (summary (sort agentpane--listing :key recency :reverse t))
      (let ((cwd (plist-get summary :cwd)))
        (when (and cwd (not (member cwd cwds)))
          (push cwd cwds))))
    (nreverse cwds)))

(defun agentpane-sessions-workspace (cwd)
  "Filter this picker to the sessions in CWD, a workspace, and make it the
picker's `default-directory', or with CWD nil list every session, as the
browser's Workspace select narrows its sidebar.
Interactively, read CWD with completion over `agentpane--workspaces', the
most recent first, after \"All workspaces\", which lists every session,
as an empty answer does."
  (interactive
   (let* ((all "All workspaces")
          (choices (cons all (agentpane--workspaces)))
          (choice (completing-read
                   "Workspace: "
                   (completion-table-with-metadata
                    choices '((display-sort-function . identity)
                              (cycle-sort-function . identity)))
                   nil t nil nil all)))
     (list (and (not (equal choice all)) choice))))
  (agentpane--filter-picker cwd))

(provide 'agentpane)

;;; agentpane.el ends here
