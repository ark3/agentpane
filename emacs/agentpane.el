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
;; own, and `q' buries.
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
;; which on Emacs 31.1 (measured 2026-09-22) ends, after one "passed" line
;; per test, with a line beginning
;;
;;     Ran 21 tests, 21 results as expected, 0 unexpected
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
  '((t :inherit font-lock-builtin-face))
  "Face for a tool part's summary line.")

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
the helper is reading its input, it exited within 0.1s of the close, event
stream open or not (Emacs 31.1, bun 1.4.0, measured 2026-09-22) -- unless
an HTTP request of its own was still unanswered, which held it alive, so
that it went only by that kill (docs/MANUAL_TESTING.md, OW-bonode)."
  (interactive)
  (when (and agentpane--connection (jsonrpc-running-p agentpane--connection))
    (process-send-eof (jsonrpc--process agentpane--connection))
    (jsonrpc-shutdown agentpane--connection)))

(defvar-local agentpane--latest-request nil
  "The id of this buffer's most recent request to the helper.")

(defvar-local agentpane--session nil
  "The summary plist of the session this transcript buffer shows.")

(defun agentpane--request (method params callback &optional always)
  "Send METHOD with PARAMS, a plist, to the helper for the current buffer.
Return at once; CALLBACK runs later with the result, in this buffer, unless
the buffer has been killed or has sent a later request since, whose reply
is the one it wants.  An error or a timeout is reported in the echo area.
With no PARAMS the request carries no `params' at all: a null one would
reach the helper as a JSON null, which is not the absence it tests for.

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
    (setq id (car (jsonrpc-async-request
                   (agentpane--connection) method (or params :jsonrpc-omit)
                   :success-fn
                   (lambda (result)
                     (when (buffer-live-p buffer)
                       (with-current-buffer buffer
                         (when (or always (eql id agentpane--latest-request))
                           (funcall callback result)))))
                   :error-fn
                   (lambda (error)
                     (message "agentpane: %s failed: %s" method (plist-get error :message)))
                   :timeout-fn
                   (lambda () (message "agentpane: %s timed out" method)))))
    (setq agentpane--latest-request id)))

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

(defun agentpane--insert-fold (key summary body)
  "Insert SUMMARY as one line, then BODY folded beneath it under fold KEY.
SUMMARY is a propertized line without its newline; BODY is a string, possibly
multi-line, without a trailing newline, or nil when there is nothing to fold.
Both carry the `agentpane-fold' property so `TAB' finds the fold from
either, and BODY is invisible unless KEY is expanded."
  (let* ((expanded (agentpane--expanded-p key))
         (marker (if body (if expanded "▾ " "▸ ") "  ")))
    (insert (propertize marker 'face 'agentpane-dim 'agentpane-fold key)
            (propertize summary 'agentpane-fold key)
            (propertize "\n" 'agentpane-fold key))
    (when body
      (let ((start (point)))
        (insert body "\n")
        (add-text-properties start (point) (list 'agentpane-fold key))
        (unless expanded
          ;; Hide from the summary's newline through the body's last
          ;; character, so the ellipsis lands at the end of the summary
          ;; line and the line after the body starts fresh.
          (put-text-property (1- start) (1- (point)) 'invisible 'agentpane))))))

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

(defun agentpane--tool-body (part)
  "The folded body of a tool PART: its diff, args and result, or nil."
  (let ((diff (plist-get part :diff))
        (args (plist-get part :args))
        (result (plist-get part :result))
        (chunks nil))
    ;; A `write' of empty content arrives as an empty vector, which is not nil.
    (when (and diff (> (length diff) 0))
      (push (agentpane--diff-text diff) chunks))
    (when (and args (not (string-empty-p args)))
      (push (concat (propertize "args:" 'face 'agentpane-dim) "\n" args) chunks))
    (push (concat (propertize "result:" 'face 'agentpane-dim) "\n"
                  (if (and result (not (string-empty-p result)))
                      result
                    (propertize "(none)" 'face 'agentpane-dim)))
          chunks)
    (let ((body (mapconcat #'identity (nreverse chunks) "\n")))
      ;; Arguments, results and diffs are column-aligned text: keep them
      ;; monospace under the buffer's proportional default. Appended, so the
      ;; diff faces already on the text keep every attribute but the family.
      (add-face-text-property 0 (length body) 'fixed-pitch t body)
      body)))

(defun agentpane--insert-tool (key part)
  "Insert a tool PART under fold KEY."
  (let* ((name (plist-get part :name))
         (summary (plist-get part :summary))
         (state (plist-get part :state))
         (marker (pcase state
                   ("ok" "")
                   ("error" (propertize " ✗ error" 'face 'agentpane-warning))
                   ("running" (propertize " … running" 'face 'agentpane-dim))
                   (_ (propertize (format " ?%s" state) 'face 'agentpane-warning)))))
    (agentpane--insert-fold
     key
     (concat (propertize name 'face 'agentpane-tool)
             (if (string-empty-p summary) "" (concat " " summary))
             marker)
     (agentpane--tool-body part))))

(defun agentpane--insert-thinking (key part)
  "Insert a thinking PART under fold KEY: its first line shown, the rest folded."
  (let ((text (or (plist-get part :text) ""))
        (redacted (eq (plist-get part :redacted) t)))
    (cond
     (redacted
      (agentpane--insert-fold
       key (propertize "thinking (redacted)" 'face 'agentpane-thinking) nil))
     ;; A signature-only block, which is every thinking part a Claude Code
     ;; store carried on 2026-09-21: the browser's `Thinking.svelte' renders
     ;; nothing for it, so neither does this.
     ((string-empty-p text) nil)
     (t
      (let* ((split (string-search "\n" text))
             (head (if split (substring text 0 split) text))
             (rest (and split (string-trim-right (substring text (1+ split))))))
        (agentpane--insert-fold
         key
         (propertize (concat "thinking: " head) 'face 'agentpane-thinking)
         (and rest (not (string-empty-p rest))
              (propertize rest 'face 'agentpane-thinking))))))))

(defun agentpane--insert-part (index ordinal part)
  "Insert PART, part number ORDINAL of the node at INDEX."
  (let ((key (cons index ordinal))
        (type (plist-get part :type)))
    (pcase type
      ("text"
       (let ((html (plist-get part :html)))
         (unless (or (null html) (string-empty-p html))
           (agentpane--insert-html html))))
      ("thinking" (agentpane--insert-thinking key part))
      ("tool" (agentpane--insert-tool key part))
      ("image"
       (insert (propertize (format "[image %s]" (plist-get part :mimeType))
                           'face 'agentpane-dim)
               "\n"))
      (_
       (insert (propertize (format "[unknown part type %S]" type)
                           'face 'agentpane-warning)
               "\n")))))

(defun agentpane--insert-meta (index meta)
  "Insert the meta line for the assistant node at INDEX from META."
  (let* ((usage (plist-get meta :usage))
         (stop (plist-get meta :stopReason))
         (error-message (plist-get meta :errorMessage))
         (effort (plist-get meta :effort))
         (face (if stop 'agentpane-warning 'agentpane-meta))
         (fields
          (delq nil
                (list (format "#%s" index)
                      (let ((model (plist-get meta :model)))
                        (if (or (null model) (string-empty-p model)) "model ?" model))
                      (and effort (format "effort %s" effort))
                      (format "%s tokens" (or (plist-get usage :totalTokens) 0))
                      (format "$%.4f" (or (plist-get usage :cost) 0))
                      stop
                      error-message))))
    (insert (propertize (concat "— " (mapconcat #'identity fields " · ")) 'face face)
            "\n")))

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
warning line where it arrived.  Everything drawn is read-only, so only the
prompt region below the nodes takes typing."
  (let ((start (point)))
    (if (plist-member node :error)
        (insert (propertize (concat "⚠ " (plist-get node :error)) 'face 'agentpane-warning)
                "\n")
      (agentpane--pp-node node))
    (add-text-properties start (point) '(read-only t front-sticky (read-only)))))

(defun agentpane--pp-node (node)
  "Pretty-print NODE, one transcript node plist, at point; see `agentpane--pp'."
  (let* ((index (plist-get node :index))
         (role (plist-get node :role))
         (userp (equal role "user"))
         (ordinal 0))
    (when userp (insert "\n"))
    (unless (or userp (equal role "assistant"))
      (insert (propertize role 'face 'agentpane-role-other) "\n"))
    (let ((body-start (point)))
      (seq-doseq (part (plist-get node :parts))
        (agentpane--insert-part index ordinal part)
        (setq ordinal (1+ ordinal)))
      (let ((meta (plist-get node :meta)))
        (when meta (agentpane--insert-meta index meta)))
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
     (seq-doseq (node nodes)
       (ewoc-enter-last agentpane--ewoc node))
     (goto-char (point-min))
     (when (ewoc-nth agentpane--ewoc 0)
       (ewoc-goto-node agentpane--ewoc (ewoc-nth agentpane--ewoc 0))))))

(defun agentpane--upsert (node)
  "Redraw the drawn node whose index is NODE's in place, or append NODE.
A node's `index' is its place in the session's flat message array, so the
match is by that and never by position; an `(:error MESSAGE)' has no index
and always appends.  Text after the redrawn node, the prompt region
included, moves with it, and so does a point there: at the end of the
buffer before, at the end after."
  (let* ((index (plist-get node :index))
         (drawn (and index
                     (let ((at (ewoc-nth agentpane--ewoc -1)))
                       (while (and at (not (eql index (plist-get (ewoc-data at) :index))))
                         (setq at (ewoc-prev agentpane--ewoc at)))
                       at))))
    (agentpane--above-prompt
     (lambda ()
       (if drawn
           (progn
             (ewoc-set-data drawn node)
             (ewoc-invalidate agentpane--ewoc drawn))
         (ewoc-enter-last agentpane--ewoc node))))))

(defun agentpane--above-prompt (redraw)
  "Call REDRAW, which changes only the read-only text above the prompt region.
The change is kept out of `buffer-undo-list', whose entries are then all the
draft's and are shifted by the change in size, since they record absolute
positions: otherwise undo in the prompt region would reverse a node redraw,
or a node that grew would leave the draft's entries pointing into it.  The
shift is in place, since undo tracks the list by its cells: `undo-equiv-table'
and `pending-undo-list' hold them, and a fresh list breaks consecutive undo
and `undo-redo' across a redraw."
  (let ((size (buffer-size)))
    (let ((buffer-undo-list t)
          (inhibit-read-only t))
      (funcall redraw))
    (let ((delta (- (buffer-size) size)))
      (unless (or (zerop delta) (eq buffer-undo-list t))
        (let ((cell buffer-undo-list))
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
            (setq cell (cdr cell))))))))

(defun agentpane--keeping-points (redraw)
  "Call REDRAW, which replaces every node, keeping point and each window's point.
A point in the prompt region, the end of the buffer included, stays the same
distance from the end, and any other stays at its position.  That is the
whole of follow mode, deliberately less than the browser's."
  (let* ((separator (marker-position agentpane--prompt-separator))
         (saved (mapcar (lambda (window)
                          (let ((pos (if window (window-point window) (point))))
                            (list window pos (and (>= pos separator) (- (point-max) pos)))))
                        (cons nil (get-buffer-window-list nil nil t)))))
    (funcall redraw)
    (pcase-dolist (`(,window ,pos ,from-end) saved)
      (let ((target (if from-end
                        (- (point-max) from-end)
                      (min pos agentpane--prompt-separator))))
        (if window (set-window-point window target) (goto-char target))))))

;;;; The transcript buffer

(defvar-local agentpane--attached nil
  "The helper connection this buffer attached its session through, or nil.
Attached only while that is still the running connection: a fresh helper
has attached nothing.")

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
  (add-to-invisibility-spec '(agentpane . t))
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
  "Move point to the start of the next node, or the N-th next."
  (interactive "p")
  (ewoc-goto-next (agentpane--ewoc) (or n 1)))

(defun agentpane-prev (&optional n)
  "Move point to the start of the previous node, or the N-th previous."
  (interactive "p")
  (ewoc-goto-prev (agentpane--ewoc) (or n 1)))

(defun agentpane-index-at-point ()
  "The transcript index of the node at point, or nil when the buffer has no nodes.
`ewoc-locate' answers the nearest node, so the header and the end of the
buffer resolve to the first and last."
  (let* ((ewoc (agentpane--ewoc))
         (node (ewoc-locate ewoc)))
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

(defun agentpane--ref (summary)
  "The session ref plist of SUMMARY."
  (plist-get summary :ref))

(defun agentpane--transcript-header (summary)
  "The line above the nodes of SUMMARY's transcript."
  (let ((ref (agentpane--ref summary)))
    (format "%s %s\n%s"
            (plist-get ref :backend) (plist-get ref :id)
            (or (plist-get summary :cwd) ""))))

(defun agentpane-refetch ()
  "Refetch this buffer's transcript and redraw it.
A stored transcript is read through `sessions/preview'; an attached one is
attached again, which answers with a fresh `session/snapshot', since a
preview would draw the stored transcript over the live one."
  (interactive)
  (unless agentpane--session
    (user-error "Not an agentpane transcript buffer"))
  (if (agentpane--attached-p)
      (agentpane--attach)
    (agentpane--request 'sessions/preview
                        (list :session (agentpane--ref agentpane--session))
                        (lambda (nodes)
                          (agentpane--draw nodes (agentpane--transcript-header agentpane--session))))))

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
  "The transcript buffer name for SUMMARY: the backend and the preview, or
the session id where there is no preview yet."
  (let ((ref (agentpane--ref summary))
        (preview (plist-get summary :preview)))
    (format "*agentpane %s: %s*"
            (plist-get ref :backend)
            (truncate-string-to-width
             (if (or (null preview) (string-empty-p preview))
                 (plist-get ref :id)
               preview)
             60 nil nil "…"))))

(defun agentpane--transcript-buffer (summary)
  "The transcript buffer for SUMMARY's session, created if there is none.
One buffer per session ref, named after the backend and the summary's preview."
  (or (agentpane--buffer-for (agentpane--ref summary))
      (let ((buffer (generate-new-buffer (agentpane--buffer-name summary))))
        (with-current-buffer buffer
          (agentpane-transcript-mode)
          (setq agentpane--session summary))
        buffer)))

(defun agentpane--rekey (ref)
  "Make this buffer hold the session REF, renaming it to match.
For a `session/renamed', and for an attach whose reply names another ref."
  (unless (agentpane--same-ref-p ref (agentpane--ref agentpane--session))
    (setq agentpane--session (plist-put (copy-sequence agentpane--session) :ref ref))
    (rename-buffer (agentpane--buffer-name agentpane--session) t)))

(defvar-local agentpane--streaming nil
  "Non-nil while the last status this buffer heard said a turn is streaming.")

(defun agentpane--set-status (params)
  "Show the streaming, compaction and model fields of PARAMS in the mode line,
and keep the streaming field in `agentpane--streaming'."
  (setq agentpane--streaming (eq (plist-get params :isStreaming) t))
  (let ((fields (delq nil
                      (list (and (eq (plist-get params :isStreaming) t) "streaming")
                            (let ((compaction (plist-get params :compaction)))
                              (and compaction (concat "compaction " compaction)))
                            (plist-get params :model)))))
    (setq mode-line-process
          (and fields (concat " [" (mapconcat #'identity fields " · ") "]")))
    (force-mode-line-update)))

;;;; Driving the session

(defun agentpane--attached-p ()
  "Non-nil when this buffer's session is attached through the running helper."
  (and agentpane--attached (eq agentpane--attached agentpane--connection)
       (jsonrpc-running-p agentpane--attached)))

(defun agentpane--attach (&optional then)
  "Attach this buffer's session through `sessions/attach', then call THEN.
From here on the helper sends this session's notifications, starting with a
`session/snapshot' that redraws the buffer."
  (agentpane--request 'sessions/attach
                      (list :session (agentpane--ref agentpane--session))
                      (lambda (summary)
                        (setq agentpane--attached agentpane--connection)
                        ;; The route's ref is authoritative and may differ.
                        (agentpane--rekey (agentpane--ref summary))
                        (when then (funcall then)))
                      t))

(defun agentpane--attached-then (fn)
  "Call FN in this buffer once its session is attached, attaching it first
if it is only a preview."
  (if (agentpane--attached-p)
      (funcall fn)
    (agentpane--attach fn)))

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

(defun agentpane--send-prompt (text sent)
  "Send TEXT as a prompt to the session of the current buffer's transcript,
then call SENT.  A prompt the server refuses, such as one sent mid-turn
\(DESIGN D16), shows the server's text in the echo area and SENT is not
called, so the draft stays where it was."
  (when (string-blank-p text)
    (user-error "Nothing to send"))
  (with-current-buffer (agentpane--transcript)
    (agentpane--attached-then
     (lambda ()
       (agentpane--request 'sessions/prompt
                           (list :session (agentpane--ref agentpane--session) :text text)
                           (lambda (_) (funcall sent))
                           t)))))

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
Allowed only before the first prompt, while the buffer has no nodes."
  (interactive
   (progn
     (agentpane--check-model-gate)
     (list (agentpane--read-model
            (plist-get (agentpane--ref (buffer-local-value 'agentpane--session
                                                           (agentpane--transcript)))
                       :backend)))))
  (agentpane--check-model-gate)
  (with-current-buffer (agentpane--transcript)
    (agentpane--attached-then
     (lambda ()
       (agentpane--request 'sessions/setModel
                           (list :session (agentpane--ref agentpane--session) :model model)
                           #'ignore t)))))

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
detached too, and its next command that needs the session attaches it
again.  Codex and Claude Code leave the parent attached.

The parent buffer is then redrawn from the store, as `agentpane-refetch'
draws a detached session.  That is there because of the server's ordering:
`PiAdapter.fork' (src/server/adapters/pi/process.ts) moves its ref to the
fork and re-reads the fork's shortened transcript before
`SessionManager.fork' re-keys the session, so that transcript goes out as a
snapshot under the parent's ref and the parent buffer draws it.  Once the
server keys that snapshot to the fork, the redraw is redundant."
  (interactive)
  (let* ((index (agentpane-index-at-point))
         (parent (agentpane--ref agentpane--session))
         (pi-backend (equal (plist-get parent :backend) "pi")))
    (unless index
      (user-error "No message at point"))
    (agentpane--request
     'sessions/forkPoints (list :session parent)
     (lambda (points)
       (let ((point (seq-find (lambda (point) (eql (plist-get point :index) index)) points)))
         (cond
          ((not point)
           (message "agentpane: the message at point is not forkable"))
          ((and pi-backend agentpane--streaming)
           (agentpane--request 'sessions/abort (list :session parent)
                               (lambda (_) (agentpane--fork-at parent point))
                               t))
          (t (agentpane--fork-at parent point)))))
     t)))

(defun agentpane--fork-at (parent point)
  "Fork the session PARENT at the fork POINT, and open the fork attached in a
buffer of its own; see `agentpane-fork'."
  (agentpane--request
   'sessions/fork (list :session parent :entryId (plist-get point :id))
   (lambda (forked)
     (when (equal (plist-get parent :backend) "pi")
       (setq agentpane--attached nil)
       (agentpane-refetch))
     (let* ((summary (list :ref forked :cwd (plist-get agentpane--session :cwd)))
            (buffer (agentpane--transcript-buffer summary)))
       (with-current-buffer buffer
         (agentpane--draw [] (agentpane--transcript-header summary))
         (agentpane--attach))
       (pop-to-buffer buffer '(display-buffer-same-window))))
   t))

;;;###autoload
(defun agentpane-new-session (backend)
  "Create a session on BACKEND in the current buffer's project, open its
buffer attached, and read its model from `models/list' with completion.
The model is read after the attach, as the browser reads it: at 118a46a
`sessions/create' records the session without spawning anything, and the
server answers `models/list' for Codex or Pi only from a live adapter,
failing with \"codex adapter not started\" before one exists (measured
2026-09-22).  The attach is synchronous for the same reason the model
list is; see `agentpane--read-model'."
  (interactive (list (completing-read "Backend: " '("codex" "claude" "pi") nil t)))
  (let* ((cwd (agentpane--current-cwd))
         (ref (jsonrpc-request (agentpane--connection) 'sessions/create
                               (list :cwd cwd :backend backend)))
         (summary (list :ref ref :cwd cwd))
         (buffer (agentpane--transcript-buffer summary)))
    (with-current-buffer buffer
      (agentpane--draw [] (agentpane--transcript-header summary))
      (let ((attached (jsonrpc-request (agentpane--connection) 'sessions/attach
                                       (list :session ref) :timeout 60)))
        (setq agentpane--attached agentpane--connection)
        ;; The route's ref is authoritative: attaching is where a new session
        ;; takes its backend's own id.
        (agentpane--rekey (agentpane--ref attached))))
    (pop-to-buffer buffer '(display-buffer-same-window))
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

(defun agentpane-prompt ()
  "Open this transcript's composer in a small window below it."
  (interactive)
  (let* ((transcript (agentpane--transcript))
         (composer
          (with-current-buffer transcript
            (unless (buffer-live-p agentpane--composer)
              (setq agentpane--composer
                    (generate-new-buffer (format "*agentpane composer: %s*" (buffer-name))))
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
  "List agentpane sessions in the current buffer's project.
With a prefix argument ALL, list every session instead."
  (interactive "P")
  (let ((cwd (and (not all) (agentpane--current-cwd)))
        (buffer (get-buffer-create "*agentpane sessions*")))
    (with-current-buffer buffer
      (unless (eq major-mode 'agentpane-sessions-mode)
        (agentpane-sessions-mode))
      (setq agentpane--cwd cwd)
      (setq mode-line-process (and cwd (format " [%s]" (file-name-nondirectory cwd))))
      (revert-buffer))
    (pop-to-buffer buffer '(display-buffer-same-window))))

(provide 'agentpane)

;;; agentpane.el ends here
