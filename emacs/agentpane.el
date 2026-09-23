;;; agentpane.el --- Native Emacs client for agentpane sessions  -*- lexical-binding: t; -*-

;; Copyright (C) 2026 Abhay Saxena

;; This file is not part of GNU Emacs.

;;; Commentary:

;; The native agentpane mode (D22): a session picker (OW-wavone) and a
;; transcript buffer that is also a client (OW-gunuke).  It talks to the
;; helper `bun run src/emacs/main.ts' -- JSON-RPC 2.0 with Content-Length
;; framing over stdio, which Emacs's bundled `jsonrpc.el' speaks -- and the
;; helper is a client of the agentpane HTTP API on loopback.  One helper per
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
;; from, as the browser's `?cwd=' query is; a prefix argument lifts the
;; filter.  The notification only flows once a buffer in this Emacs has
;; attached a session: the helper opens its event stream from
;; `sessions/attach' (src/emacs/helper.ts).  In a transcript buffer `n'
;; and `p' step between nodes, `TAB' toggles the fold at point, `g'
;; refetches, `f' forks at the user message at point into a buffer of its
;; own -- on a previewed transcript it attaches first, and forks at the
;; next press -- `r' toggles reading view, and `q' buries.  Reading view is
;; the browser's (`condense' in src/client/render/transcript.ts): tool
;; calls, tool results and thinking are elided, and while a turn streams
;; the line above the prompt names the tool or thinking it is running.  It
;; is per buffer and not kept, and the mode line says when it is on.
;; Killing a transcript buffer stops its session's notifications and
;; leaves the session running on the server.
;;
;; `M-x agentpane-new-session' asks for a backend, creates a session in the
;; current buffer's project, opens it attached and asks for one of the
;; backend's models; the first prompt on a previewed transcript attaches it.  Once attached,
;; the helper's notifications drive the buffer: a snapshot redraws every
;; node, a node update redraws the node with its index or appends it, and
;; the mode line shows streaming, compaction and the model.  A prompt is
;; typed in the region below the last node, or in the composer
;; `M-x agentpane-prompt' opens below the transcript; in both `RET' inserts
;; a newline and `C-RET' sends, and `C-c C-a' aborts the running turn.
;; `M-x agentpane-compact' compacts, and `M-x agentpane-set-model' sets the
;; model, but only before the first prompt.
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
;; which on Emacs 31.1 (measured 2026-09-23) ends, after one "passed" line
;; per test, with a line beginning
;;
;;     Ran 74 tests, 74 results as expected, 0 unexpected
;;
;; followed by the run's timestamp and duration.  It is not part of `bun run check',
;; which stays Bun-only.

;;; Code:

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
  "Face for the role line of a node whose role is neither user nor assistant.")

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

(defun agentpane--connection ()
  "The connection to the helper, started on first use."
  (unless (and agentpane--connection (jsonrpc-running-p agentpane--connection))
    (setq agentpane--connection
          (make-instance 'jsonrpc-process-connection
                         :name "agentpane"
                         :process #'agentpane--start-helper
                         :notification-dispatcher #'agentpane--on-notification
                         :on-shutdown (lambda (_conn) (setq agentpane--connection nil)))))
  agentpane--connection)

(defun agentpane-shutdown ()
  "Stop the helper, if one is running.
Its stdin is closed first, since that is what the helper exits on
\(`runHelper' in src/emacs/helper.ts); `jsonrpc-shutdown' does not close
it, and after 0.3s without an exit it warns and kills the process.  Once
the helper is reading its input, it exited within 0.1s of the close, even
with its event stream open or an HTTP request of its own unanswered, which
it aborts (Emacs 31.1, bun 1.4.0, measured 2026-09-22;
docs/MANUAL_TESTING.md, OW-bonode and OW-kofuda)."
  (interactive)
  (when (and agentpane--connection (jsonrpc-running-p agentpane--connection))
    (process-send-eof (jsonrpc--process agentpane--connection))
    (jsonrpc-shutdown agentpane--connection)))

(defvar-local agentpane--latest-request nil
  "The id of this buffer's most recent request to the helper.")

(defvar-local agentpane--session nil
  "The summary plist of the session this transcript buffer shows.")

(defconst agentpane--spawn-timeout 60
  "Seconds to wait for a request that may spawn the session's backend:
`sessions/attach', and `sessions/prompt', `sessions/forkPoints' and
`sessions/fork', whose server routes attach first (src/server/http/app.ts).
`sessions/setModel', whose route attaches too, still takes jsonrpc.el's
default.
Past this the reply is discarded even if it comes, so a spawn that ran long
but succeeded reads as a failure and leaves the buffer unattached though
its session is live.  jsonrpc.el's default is 10s, and the one attach
measured took 1.138s, a re-attach on `pi 0.85.1' on 2026-09-16, driven at
the HTTP route (docs/MANUAL_TESTING.md, OW-jamoyi); no cold spawn has been
timed.  60s is what `agentpane-new-session''s synchronous attach already
allowed, where waiting blocks Emacs; here it blocks nothing, and a hung
helper costs only a minute before a refused second send is accepted again.")

(defun agentpane--request (method params callback &optional always failed timeout)
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

With ALWAYS non-nil, CALLBACK runs even when a later request has been sent
since: for a command -- attach, prompt, abort -- whose reply is not a view
that the later request's replaces.  Such a request still supersedes every
earlier one, so a preview refetch still in flight when the buffer attaches
is not drawn over the live transcript.

Asynchronous because a synchronous `jsonrpc-request' stalled when another
one nested inside it, as the picker refetch that `sessions/changed' runs
does whenever it lands during a transcript refetch: on Emacs 31.1 with
jsonrpc.el 1.0.29 both replies were in by 0.3s and the outer call still
returned only at its own timeout's deadline, 10s later (OW-bonode; the
ert tests `agentpane-test-nested-refetch-*' provoke it)."
  (let ((buffer (current-buffer))
        id)
    (setq id (car (agentpane--failing
                   failed
                   (lambda ()
                     (jsonrpc-async-request
                      (agentpane--connection) method (or params :jsonrpc-omit)
                      ;; An explicit nil would mean no timeout at all.
                      :timeout (or timeout jsonrpc-default-request-timeout)
                      :success-fn
                      (lambda (result)
                        (when (buffer-live-p buffer)
                          (with-current-buffer buffer
                            (when (or always (eql id agentpane--latest-request))
                              (agentpane--failing failed (lambda () (funcall callback result)))))))
                      :error-fn
                      (lambda (error)
                        (message "agentpane: %s failed: %s" method (plist-get error :message))
                        (agentpane--failed buffer failed))
                      :timeout-fn
                      (lambda ()
                        (message "agentpane: %s timed out" method)
                        (agentpane--failed buffer failed)))))))
    (setq agentpane--latest-request id)))

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

(defun agentpane--on-notification (_conn method params)
  "Handle notification METHOD, with PARAMS, from the helper.
Every one but `sessions/changed' is about one session, and goes to the
transcript buffer holding it, if there is one."
  (if (eq method 'sessions/changed)
      (agentpane--revert-pickers)
    (let ((buffer (agentpane--buffer-for
                   (plist-get params (if (eq method 'session/renamed) :from :session)))))
      (when buffer
        (with-current-buffer buffer
          (pcase method
            ('session/snapshot
             (agentpane--set-status params)
             (agentpane--keeping-points
              (lambda ()
                (agentpane--draw (plist-get params :nodes)
                                 (agentpane--transcript-header agentpane--session)))))
            ('session/node (agentpane--upsert (plist-get params :node)))
            ('session/status (agentpane--set-status params))
            ('session/error (agentpane--upsert (list :error (plist-get params :message))))
            ('session/renamed (agentpane--rekey (plist-get params :to)))))))))

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

(defun agentpane--insert-html (html)
  "Draw HTML, the browser's rendering of one text part, through shr at point.
Filling is left to `visual-line-mode', and a visual-wrap pass gives wrapped
list rows their hanging indent."
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
           (th . agentpane--shr-th)))
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
    (let ((adaptive-fill-regexp "[ \t]*\\(\\([0-9]+\\|[-–*•‣⁃◦]\\)[ \t]+\\)?"))
      (save-restriction
        (narrow-to-region start (point))
        (visual-wrap-prefix-function (point-min) (point-max))))))

;;;; Drawing nodes

(defvar-local agentpane--ewoc nil
  "The ewoc drawing this buffer's nodes.")

(defvar-local agentpane--tail-index nil
  "The index of the last node drawn, the one a streaming turn is filling.
Kept apart from the ewoc because a snapshot draws its nodes one at a time,
and each would otherwise be the last while it is drawn.")

(defvar-local agentpane--streaming nil
  "Non-nil while the last status this buffer heard said a turn is streaming.")

(defvar-local agentpane--reading nil
  "Non-nil while this buffer shows reading view; see `agentpane-toggle-reading'.
Per buffer and not kept, where the browser's is one global boolean (owner,
2026-09-23).")

(defvar-local agentpane--status-fields nil
  "The mode-line fields of the last status this buffer heard, as strings.")

(defvar-local agentpane--tail-overlay nil
  "Overlay on the prompt separator whose `before-string' is the reading-view
tail status, when there is one; see `agentpane--show-reading-tail'.")

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

(defun agentpane--window-width ()
  "The body width in pixels fold headers are fitted to: the narrowest of the
windows showing this buffer, so that none of them wraps a header, or the
selected window's while none shows it."
  (seq-min (mapcar (lambda (window) (window-body-width window t))
                   (or (get-buffer-window-list nil nil t) (list (selected-window))))))

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
             (tail (and tail (funcall fits (concat ellipsis tail)) tail)))
        (if (and (not tail) (funcall fits summary))
            (list (concat head summary) nil nil)
          ;; The longest start of the summary that fits beside the ellipsis.
          (let ((lo 0)
                (hi (1- (length summary))))
            (while (< lo hi)
              (let ((mid (/ (+ lo hi 1) 2)))
                (if (funcall fits (concat (substring summary 0 mid) ellipsis tail))
                    (setq lo mid)
                  (setq hi (1- mid)))))
            (list (concat head (string-trim-right (substring summary 0 lo)) ellipsis tail)
                  t (and tail t)))))))))

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
NODE may instead be `(:error MESSAGE)', a `session/error' drawn as a
warning line where it arrived.  A node reading view elides draws nothing;
see `agentpane--elided-p'.  Everything drawn is read-only, so only the
prompt region below the nodes takes typing."
  (setq agentpane--fitted-width (agentpane--window-width))
  (let ((start (point)))
    (cond
     ((plist-member node :error)
      (insert (propertize (concat "⚠ " (plist-get node :error)) 'face 'agentpane-warning)
              "\n"))
     ((agentpane--elided-p node))
     (t (agentpane--pp-node node)))
    (add-text-properties start (point) '(read-only t front-sticky (read-only)))))

(defun agentpane--role-suffix (node)
  "What the role line of NODE says after the role: for a compaction marker,
the context size it folded, as the browser's marker names it when above 0."
  (let ((tokens (plist-get node :tokensBefore)))
    (if (and (equal (plist-get node :role) "compactionSummary")
             tokens (> tokens 0))
        (format " · from %s tok" (agentpane--compact-number tokens))
      "")))

(defun agentpane--pp-node (node)
  "Pretty-print NODE, one transcript node plist, at point; see `agentpane--pp'."
  (let* ((index (plist-get node :index))
         (role (plist-get node :role))
         (userp (equal role "user"))
         (ordinal 0))
    (when userp (insert "\n"))
    (unless (or userp (equal role "assistant"))
      (insert (propertize (concat role (agentpane--role-suffix node))
                          'face 'agentpane-role-other)
              "\n"))
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
      ;; below the text inside the box; this is the box's last line.
      (when (and userp time)
        (insert (propertize time 'face 'agentpane-meta) "\n"))
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

(defun agentpane--draw (nodes &optional header)
  "Draw NODES, a sequence of node plists, as this buffer's ewoc under HEADER.
Replaces every node the buffer held and leaves the prompt region below them
as it was; expanded folds survive the redraw, since they are keyed by node
index and part ordinal rather than by position.  Point goes to the first
node."
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
     (goto-char (point-min))
     (when (ewoc-nth agentpane--ewoc 0)
       (ewoc-goto-node agentpane--ewoc (ewoc-nth agentpane--ewoc 0)))))
  (agentpane--show-reading-tail))

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
match is by that and never by position; an `(:error MESSAGE)' has no index
and always appends.  Text after the redrawn node, the prompt region
included, moves with it, and so does a point there: at the end of the
buffer before, at the end after.
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
    (agentpane--show-reading-tail)))

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

(defun agentpane--show-reading-tail ()
  "Show `agentpane--reading-tail' as the line above the prompt separator, or
no line when it is nil.  An overlay string rather than buffer text, so it
moves no node and no draft, and is in no one's undo."
  (when agentpane--tail-overlay
    (overlay-put agentpane--tail-overlay 'before-string (agentpane--reading-tail))))

(defun agentpane--show-mode-line ()
  "Show the status fields, after `reading' when reading view is on, in the
mode line."
  (let ((fields (if agentpane--reading
                    (cons "reading" agentpane--status-fields)
                  agentpane--status-fields)))
    (setq mode-line-process
          (and fields (concat " [" (mapconcat #'identity fields " · ") "]")))
    (force-mode-line-update)))

;;;; The transcript buffer

(defvar-local agentpane--attached nil
  "The helper connection this buffer attached its session through, or nil.
Attached only while that is still the running connection: a fresh helper
has attached nothing.")

(defvar-local agentpane--attaching nil
  "While a `sessions/attach' this buffer sent has not answered, the callers
waiting on it, oldest first, each a cons (THEN . FAILED) of the arguments
`agentpane--attach' was given; nil otherwise.")

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
    (define-key map (kbd "f") #'agentpane-fork)
    (define-key map (kbd "r") #'agentpane-toggle-reading)
    (define-key map (kbd "q") #'quit-window)
    (define-key map (kbd "C-<return>") #'agentpane-send)
    (define-key map (kbd "C-c C-a") #'agentpane-abort)
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
  (setq-local agentpane--folds (make-hash-table :test #'equal))
  (add-hook 'kill-buffer-hook #'agentpane--detach nil t)
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

(defvar agentpane--forking)

(defun agentpane-refetch ()
  "Refetch this buffer's transcript and redraw it.
A stored transcript is read through `sessions/preview'; an attached one is
attached again, which answers with a fresh `session/snapshot', since a
preview would draw the stored transcript over the live one.  One still
attaching sends nothing: its attach's snapshot is the refetch, and a
preview sent now would supersede the attach and draw over that snapshot.
Nor does one with a fork in flight; see `agentpane-fork'.  Either says
why in the echo area rather than signalling, since opening a session from
the picker refetches its buffer, and an error would leave it unshown."
  (interactive)
  (unless agentpane--session
    (user-error "Not an agentpane transcript buffer"))
  (cond
   (agentpane--attaching
    (message "agentpane: still attaching; the attach's snapshot redraws the transcript"))
   (agentpane--forking
    (message "agentpane: a fork of this session is in flight; refetch once it lands"))
   ((agentpane--attached-p)
    (agentpane--attach))
   (t
    (agentpane--request 'sessions/preview
                        (list :session (agentpane--ref agentpane--session))
                        (lambda (nodes)
                          (agentpane--draw nodes (agentpane--transcript-header agentpane--session)))))))

(defun agentpane--same-ref-p (a b)
  "Non-nil when session refs A and B name the same session."
  (and (equal (plist-get a :backend) (plist-get b :backend))
       (equal (plist-get a :id) (plist-get b :id))))

(defun agentpane--buffer-for (ref)
  "The transcript buffer holding the session REF, or nil."
  (seq-find (lambda (buffer)
              (let ((held (buffer-local-value 'agentpane--session buffer)))
                (and held (agentpane--same-ref-p (agentpane--ref held) ref))))
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
One buffer per session ref, named by `agentpane--buffer-name'.
A new buffer's `default-directory' is the session's cwd, where the summary
gives one, rather than that of whichever buffer was current (OW-ruhotu)."
  (or (agentpane--buffer-for (agentpane--ref summary))
      (let ((buffer (generate-new-buffer (agentpane--buffer-name summary)))
            (cwd (plist-get summary :cwd)))
        (with-current-buffer buffer
          (agentpane-transcript-mode)
          (unless (or (null cwd) (string-empty-p cwd))
            (setq default-directory (file-name-as-directory cwd)))
          (setq agentpane--session summary))
        buffer)))

(defvar agentpane--composer)

(defun agentpane--rekey (ref)
  "Make this buffer hold the session REF, leaving its name, and its
composer's, as they were: the backend and project they name do not change
with the ref, and a name that fell back to the session id keeps the old one.
For a `session/renamed', and for an attach whose reply names another ref.

Should another buffer already hold REF, as one the picker opened on the
canonical ref while this one previewed a virtual ref does, the two merge
into this one, and the other is killed: two buffers for one session left
notifications reaching only whichever came first in `buffer-list'
\(OW-jafini).  This one survives because it is the one attached, and its
own callbacks are running: the attach reply that rekeys it goes on to call
its waiters, a prompt among them, in this buffer.  The other's
prompt-region draft follows this one's own, and its composer, if any,
sends here from then on, and is this buffer's composer if it has none.
Should this buffer have a prompt in flight, its answer then leaves the
sent text in place rather than clearing it, as it does whenever the
region changed after the send.  Requests of the other's still in flight
are dropped with it, as any killed buffer's are; a prompt of its own that
went out leaves its text in this buffer's draft.  A window that showed
the other shows this one, and the other's kill sends no
`sessions/detach', which would silence the session this one now holds."
  (unless (agentpane--same-ref-p ref (agentpane--ref agentpane--session))
    (let ((other (agentpane--buffer-for ref)))
      (setq agentpane--session (plist-put (copy-sequence agentpane--session) :ref ref))
      (when other (agentpane--absorb other)))))

(defvar agentpane--composer-transcript)

(defun agentpane--absorb (other)
  "Take the transcript buffer OTHER's draft, composer and windows into this
buffer, then kill OTHER without detaching.  See `agentpane--rekey'.
A composer taken as this buffer's own is renamed after this buffer; one
that stays secondary to this buffer's own composer keeps its name.
The detach is disarmed for this kill alone, rather than skipped whenever
another buffer holds the ref, since only here is a second holder meant."
  (let ((buffer (current-buffer))
        (draft (with-current-buffer other
                 (buffer-substring-no-properties agentpane--prompt-start (point-max))))
        (composer (buffer-local-value 'agentpane--composer other)))
    (unless (string-empty-p draft)
      (save-excursion
        (goto-char (point-max))
        (unless (= (point) agentpane--prompt-start) (insert "\n"))
        (insert draft)))
    (when (buffer-live-p composer)
      (with-current-buffer composer
        (setq agentpane--composer-transcript buffer))
      (unless (buffer-live-p agentpane--composer)
        (setq agentpane--composer composer)
        (let ((name (agentpane--composer-name)))
          (with-current-buffer composer
            (rename-buffer name t)))))
    (dolist (window (get-buffer-window-list other nil t))
      (set-window-buffer window buffer))
    (with-current-buffer other
      (remove-hook 'kill-buffer-hook #'agentpane--detach t))
    (kill-buffer other)))

(defun agentpane--set-status (params)
  "Show the streaming, compaction and model fields of PARAMS in the mode line,
and keep the streaming field in `agentpane--streaming'.
When streaming ends, the last node is redrawn, since it was drawn as the
pending turn, a tool call with no result on it as running, and the helper
re-sends no node for the change; and reading view's tail status goes."
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
                    (plist-get params :model))))
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
`session/snapshot' that redraws the buffer.

One attach at a time per buffer: while one is in flight nothing is sent,
and THEN or FAILED waits on that one's answer instead.  Two in flight
answered separately, and the first to fail ended the wait while the other
was still out, so a refetch then sent a preview that could draw the
stored transcript over the live one the other's snapshot drew (OW-yibimi)."
  (if agentpane--attaching
      (setq agentpane--attaching
            (append agentpane--attaching (list (cons then failed))))
    (setq agentpane--attaching (list (cons then failed)))
    (agentpane--request 'sessions/attach
                        (list :session (agentpane--ref agentpane--session))
                        (lambda (summary)
                          (setq agentpane--attached agentpane--connection)
                          ;; The route's ref is authoritative and may differ.
                          (agentpane--rekey (agentpane--ref summary))
                          (agentpane--attach-answered t))
                        t
                        (lambda () (agentpane--attach-answered nil))
                        agentpane--spawn-timeout)))

(defun agentpane--attach-answered (ok)
  "End the wait on this buffer's attach, calling each waiter's THEN if OK,
else its FAILED.  Should one exit non-locally, every waiter not yet called
has its FAILED called on the way out, so a flag a FAILED clears, such as
`agentpane--sending', never outlives the attach."
  (let ((waiters agentpane--attaching))
    (setq agentpane--attaching nil)
    (unwind-protect
        (while waiters
          (let ((fn (funcall (if ok #'car #'cdr) (pop waiters))))
            (when fn (funcall fn))))
      (dolist (waiter waiters)
        (when (cdr waiter) (funcall (cdr waiter)))))))

(defun agentpane--attach-now ()
  "Attach this buffer's session through `sessions/attach', and return only
once the attach has answered, for a command that must then read from the
session's live adapter; see `agentpane-new-session'.  It blocks Emacs for
up to `agentpane--spawn-timeout', and a timeout, an error or a quit
signals, leaving the buffer unattached.

While an asynchronous attach is in flight it refuses, and sends nothing:
a second attach beside that one is what `agentpane--attach' exists to
prevent, and waiting for it here would block Emacs on a reply that may
take the whole timeout.  `agentpane-set-model' reaches this with a first
prompt's attach out; asked again once that has answered, it finds the
session attached and needs no attach at all."
  (when agentpane--attaching
    (user-error "This session is still attaching; try again once it has"))
  (let ((attached (jsonrpc-request (agentpane--connection) 'sessions/attach
                                   (list :session (agentpane--ref agentpane--session))
                                   :timeout agentpane--spawn-timeout)))
    (setq agentpane--attached agentpane--connection)
    ;; The route's ref is authoritative: attaching is where a new session
    ;; takes its backend's own id.
    (agentpane--rekey (agentpane--ref attached))))

(defun agentpane--attached-then (fn &optional failed)
  "Call FN in this buffer once its session is attached, attaching it first
if it is only a preview; call FAILED instead if that attach fails."
  (if (agentpane--attached-p)
      (funcall fn)
    (agentpane--attach fn failed)))

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

Sent whenever a helper is running, whatever this buffer believes: an
attach that failed here -- timed out, or quit in `agentpane-new-session'
-- may still have succeeded in the helper, which then holds the session,
and a detach of a session it does not hold changes nothing.  Never sent
without one, so a kill never starts a helper, as `agentpane--connection'
would.  An error sending it, such as a pipe that has just broken, is
reported and goes no further, since an error in `kill-buffer-hook' stops
the kill; not through `with-demoted-errors', which lets it through under
`debug-on-error'."
  (when (and agentpane--connection (jsonrpc-running-p agentpane--connection))
    (condition-case err
        (agentpane--request 'sessions/detach
                            (list :session (agentpane--ref agentpane--session))
                            #'ignore t)
      (error (message "agentpane: sessions/detach failed: %s" (error-message-string err))))))

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
  "Non-nil while a prompt this transcript buffer sent, or the attach before
it, has not answered.")

(defun agentpane--send-prompt (text sent)
  "Send TEXT as a prompt to the session of the current buffer's transcript,
then call SENT.  A prompt the server refuses, such as one sent mid-turn
\(DESIGN D16), shows the server's text in the echo area and SENT is not
called, so the draft stays where it was.

One send at a time per session, as the browser allows (OW-nasofa): until
the prompt has answered, which it does once the turn is accepted, a second
send says so and sends nothing.  The draft stays visible until that answer,
so pressing again while a backend spawns is the natural move, and without
this each press attached and prompted with the same text, which the Codex
adapter makes a steer of the turn the first began (D16)."
  (when (string-blank-p text)
    (user-error "Nothing to send"))
  (with-current-buffer (agentpane--transcript)
    (when agentpane--sending
      (user-error "A prompt to this session is already being sent"))
    (setq agentpane--sending t)
    (let ((failed (lambda () (setq agentpane--sending nil))))
      (agentpane--attached-then
       (lambda ()
         (agentpane--request 'sessions/prompt
                             (list :session (agentpane--ref agentpane--session) :text text)
                             (lambda (_)
                               (setq agentpane--sending nil)
                               (funcall sent))
                             t failed agentpane--spawn-timeout))
       failed))))

(defun agentpane--clear-sent (buffer beg text)
  "Delete TEXT from BEG to the end of BUFFER, if it is still exactly there."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (when (equal (buffer-substring-no-properties beg (point-max)) text)
        (delete-region beg (point-max))))))

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
  "Abort the running turn of this buffer's session through `sessions/abort'."
  (interactive)
  (with-current-buffer (agentpane--transcript)
    (agentpane--request 'sessions/abort
                        (list :session (agentpane--ref agentpane--session))
                        #'ignore t)))

(defun agentpane-compact ()
  "Compact this buffer's session through `sessions/compact'."
  (interactive)
  (with-current-buffer (agentpane--transcript)
    (agentpane--attached-then
     (lambda ()
       (agentpane--request 'sessions/compact
                           (list :session (agentpane--ref agentpane--session))
                           #'ignore t)))))

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

(defun agentpane--check-model-gate ()
  "Signal a user error unless this buffer's session has no nodes yet.
The model is chosen at conversation start, never switched later (owner,
2026-09-13); the browser enforces the same in `loadModelsForSelected'
\(src/client/controller.ts), and neither the server nor the helper does."
  (with-current-buffer (agentpane--transcript)
    (when (and agentpane--ewoc
               (ewoc-collect agentpane--ewoc (lambda (data) (plist-get data :index))))
      (user-error "The model is chosen before the first prompt"))))

(defun agentpane-set-model (model)
  "Set this buffer's session's MODEL through `sessions/setModel'.
Allowed only before the first prompt, while the buffer has no nodes.
An empty MODEL, which `completing-read' returns for an empty `RET' even
when it requires a match, sets nothing, and the session keeps the model
it has.  Sent, \"\" was stored by the Codex adapter and reported as the
model while its turns ran on the default, refused by the Pi adapter, and
handed to Claude Code as it was (OW-kisemu, read from the adapters in
src/server/adapters/ at daf5f52, not run live).

Interactively a session not yet attached is attached before the models
are read, and synchronously, as `agentpane-new-session' does and for its
reason: the server answers `models/list' from a live adapter of the
backend, or else from an unstarted one, which for Codex or Pi fails.
Read first, they were unreadable for a created session never prompted
whenever no other session of its backend was live, as after a server
restart (OW-kisemu, read from `listModels' in src/server/http/app.ts at
daf5f52, not run live)."
  (interactive
   (progn
     (agentpane--check-model-gate)
     (with-current-buffer (agentpane--transcript)
       (unless (agentpane--attached-p)
         (agentpane--attach-now))
       (list (agentpane--read-model (plist-get (agentpane--ref agentpane--session)
                                               :backend))))))
  (unless (string-empty-p model)
    (agentpane--check-model-gate)
    (with-current-buffer (agentpane--transcript)
      (agentpane--attached-then
       (lambda ()
         (agentpane--request 'sessions/setModel
                             (list :session (agentpane--ref agentpane--session) :model model)
                             #'ignore t))))))

(defvar-local agentpane--forking nil
  "Non-nil while a fork this buffer began is in flight.")

(defun agentpane-fork ()
  "Fork this buffer's session at the user message at point, and open the fork
in a transcript buffer of its own, attached.  The fork holds the history
before that message, without the message itself: every backend's fork point
excludes the user message it names.  This buffer stays as it was.

The points are fetched through `sessions/forkPoints' each time and matched
by the transcript index each names, never counted or kept: a Codex steer
puts two user messages in one turn, which is one point, so the set moves
under the transcript (OW-roveze).  A message no point names is not
forkable, and nothing is forked, as the browser offers no Edit there.

A Pi fork of a streaming session stops the turn whether or not anything
aborts it, so the turn is aborted first, the loss made deliberate, as the
browser's `forkAndSubmit' does; that abort is the client's under D15, and
the server's fork route aborts nothing.  It goes after the points are
matched, so a message that is not forkable costs the turn nothing.  Codex
and Claude Code keep a parent turn running through a fork, and are not
aborted.  A Pi fork also moves the parent's live process onto the fork and
leaves the parent detached, with no `session/renamed' (`SessionManager.fork'
in src/server/http/session-manager.ts), so this buffer then counts itself
detached too, detaches the parent from the helper, and its next command
that needs the session attaches it again.  Codex and Claude Code leave
the parent attached.

The parent buffer keeps the live transcript it was showing, unredrawn: the
server drops what `PiAdapter.fork' emits of the fork's shortened
transcript before `SessionManager.fork' re-keys the session, rather than
send it under the parent's ref (OW-zovaye).  A detached buffer usually
shows the store's projection instead, which for Pi can omit messages the
live one keeps, but nothing here trusts an index from it: a fork attaches
first, and a send attaches and redraws.  While the fork is in flight
`agentpane-refetch' sends nothing: on the attached parent it would attach
again, and a reply to that landing after the fork's would count the
parent attached, the server having detached it.

One fork at a time per buffer, as the browser allows one send at a time
\(OW-kelede): a second press while one is in flight sends nothing.  The fork
is shown in the window that showed this buffer when the fork began, if it
is still live, rather than in whichever window is selected when the reply
lands.

A buffer not attached, only previewed, is attached and forks nothing: once
the attach answers, the echo area says the transcript now shows the live
session and to press `f' again at the message to fork.  Its indices are the
stored projection's, and the fork points are the live adapter's, since the
route attaches first, and the two can name different messages: a Pi
preview drops the `custom_message' entries and roles such as
`bashExecution' that `get_messages' keeps (read from `pi 0.87.1''s
source), and nothing makes the Claude Code store and live projections
agree (OW-gekiki).  So trusting the index could fork at another message.
Refusing, as the browser does by offering no Edit on a preview, would
leave no way to fork a session only previewed short of sending it a
prompt, since there is no command that only attaches.  Attaching redraws
the buffer from the live transcript through the attach's snapshot, so the
index at point becomes a live one, and the second press lets the user
confirm the message after that redraw, which may have moved it.  The
attach's reply and its snapshot are unordered (D2), so the message can
precede the redraw by that snapshot's transit.  This covers the parent of
a Pi fork too, which is left detached.  While that attach is in flight a
second press says so and sends nothing."
  (interactive)
  (when agentpane--forking
    (user-error "A fork of this session is already in flight"))
  (unless (agentpane-index-at-point)
    (user-error "No message at point"))
  (cond
   ((agentpane--attached-p) (agentpane--fork-points))
   (agentpane--attaching
    (user-error "This session is still attaching; press f once it has"))
   (t (agentpane--attach
       (lambda ()
         (message "agentpane: the transcript now shows the live session; \
press f again at the message to fork"))))))

(defun agentpane--fork-points ()
  "Fetch this attached buffer's fork points, and fork at the one naming the
index at point.  See `agentpane-fork'."
  (let* ((index (agentpane-index-at-point))
         (parent (agentpane--ref agentpane--session))
         (pi-backend (equal (plist-get parent :backend) "pi"))
         (window (get-buffer-window))
         (failed (lambda () (setq agentpane--forking nil))))
    (setq agentpane--forking t)
    (agentpane--request
     'sessions/forkPoints (list :session parent)
     (lambda (points)
       (let ((point (seq-find (lambda (point) (eql (plist-get point :index) index)) points)))
         (cond
          ((not point)
           (setq agentpane--forking nil)
           (message "agentpane: the message at point is not forkable"))
          ((and pi-backend agentpane--streaming)
           (agentpane--request 'sessions/abort (list :session parent)
                               (lambda (_) (agentpane--fork-at parent point window failed))
                               t failed))
          (t (agentpane--fork-at parent point window failed)))))
     t failed agentpane--spawn-timeout)))

(defun agentpane--fork-at (parent point window failed)
  "Fork the session PARENT at the fork POINT, and open the fork attached in a
buffer of its own, shown in WINDOW if it is still live; FAILED runs if the
fork fails.  See `agentpane-fork'."
  (agentpane--request
   'sessions/fork (list :session parent :entryId (plist-get point :id))
   (lambda (forked)
     (setq agentpane--forking nil)
     (when (equal (plist-get parent :backend) "pi")
       (agentpane--detach)
       (setq agentpane--attached nil))
     (let* ((summary (list :ref forked :cwd (plist-get agentpane--session :cwd)))
            (buffer (agentpane--transcript-buffer summary)))
       (with-current-buffer buffer
         (agentpane--draw [] (agentpane--transcript-header summary))
         (agentpane--attach))
       (if (window-live-p window)
           (set-window-buffer window buffer)
         (pop-to-buffer buffer '(display-buffer-same-window)))))
   t failed agentpane--spawn-timeout))

;;;###autoload
(defun agentpane-new-session (backend)
  "Create a session on BACKEND in the current buffer's project, open its
buffer attached, and read its model from `models/list' with completion.
The model is read after the attach, as the browser reads it: at 118a46a
`sessions/create' records the session without spawning anything, and the
server answers `models/list' for Codex or Pi only from a live adapter,
failing with \"codex adapter not started\" before one exists (measured
2026-09-22).  The attach is synchronous for the same reason the model
list is; see `agentpane--read-model'.

The buffer is shown before the attach, so one that fails or is quit
leaves the new session in view, unattached, where a send attaches it
again and `M-x agentpane-set-model' still applies; shown only after, it
stayed hidden, holding the session."
  (interactive (list (completing-read "Backend: " '("codex" "claude" "pi") nil t)))
  (let* ((cwd (agentpane--current-cwd))
         (ref (jsonrpc-request (agentpane--connection) 'sessions/create
                               (list :cwd cwd :backend backend)))
         (summary (list :ref ref :cwd cwd))
         (buffer (agentpane--transcript-buffer summary)))
    (pop-to-buffer buffer '(display-buffer-same-window))
    (with-current-buffer buffer
      (agentpane--draw [] (agentpane--transcript-header summary))
      (agentpane--attach-now))
    (agentpane-set-model (agentpane--read-model backend))))

;;;; The composer

(defvar agentpane-composer-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "C-c C-c") #'agentpane-composer-send)
    (define-key map (kbd "C-<return>") #'agentpane-composer-send)
    (define-key map (kbd "C-c C-k") #'agentpane-composer-discard)
    (define-key map (kbd "C-c C-a") #'agentpane-abort)
    map)
  "Keymap for `agentpane-composer-mode'.")

(define-derived-mode agentpane-composer-mode text-mode "agentpane-composer"
  "Major mode for drafting a prompt to an agentpane session, as for a commit
message: `C-c C-c' or `C-RET' sends, `C-c C-k' discards, `C-c C-a' aborts
the running turn.
\\{agentpane-composer-mode-map}")

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
  "Send the composer's text as a prompt, and clear the composer once sent."
  (interactive)
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

;;;; The session picker

(defvar-local agentpane--cwd nil
  "The workspace this picker is filtered to, or nil for every session.")

(defvar agentpane-sessions-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "RET") #'agentpane-sessions-open)
    map)
  "Keymap for `agentpane-sessions-mode'.")

(defun agentpane--format-time (iso)
  "ISO, an ISO-8601 timestamp or nil, as a local date and time, or empty."
  (if iso
      (format-time-string "%Y-%m-%d %H:%M" (encode-time (iso8601-parse iso)))
    ""))

(defun agentpane--session-entry (summary)
  "The `tabulated-list-entries' row for SUMMARY."
  (let ((ref (agentpane--ref summary)))
    (list summary
          (vector (plist-get ref :backend)
                  (plist-get summary :status)
                  (if (eq (plist-get summary :isStreaming) t) "●" "")
                  (agentpane--format-time (plist-get summary :updatedAt))
                  (or (plist-get summary :preview) "")))))

(defun agentpane--refetch-sessions (&rest _)
  "Refetch the listing through `sessions/list' under this buffer's filter,
and redraw it when the reply lands.  The picker's `revert-buffer-function'."
  (agentpane--request 'sessions/list
                      (and agentpane--cwd (list :cwd agentpane--cwd))
                      (lambda (summaries)
                        (setq tabulated-list-entries
                              (mapcar #'agentpane--session-entry (append summaries nil)))
                        (tabulated-list-print t))))

(define-derived-mode agentpane-sessions-mode tabulated-list-mode "agentpane-sessions"
  "Major mode listing agentpane sessions.
\\{agentpane-sessions-mode-map}"
  (setq tabulated-list-format
        [("Backend" 8 t)
         ("Status" 9 t)
         ("" 2 nil)
         ("Updated" 17 t)
         ("Preview" 0 nil)])
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
      (setq agentpane--cwd cwd)
      (when cwd
        (setq default-directory (file-name-as-directory cwd)))
      (setq mode-line-process (and cwd (format " [%s]" (file-name-nondirectory cwd))))
      (revert-buffer))
    (pop-to-buffer buffer '(display-buffer-same-window))))

(provide 'agentpane)

;;; agentpane.el ends here
