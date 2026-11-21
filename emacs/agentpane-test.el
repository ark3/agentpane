;;; agentpane-test.el --- Tests for agentpane.el  -*- lexical-binding: t; -*-

;; Copyright (C) 2026 Abhay Saxena

;; This file is not part of GNU Emacs.

;;; Commentary:

;; `ert' tests for agentpane.el: drawing a fixed list of nodes into a
;; buffer and driving it with notifications, with no helper process, and
;; the helper connection, against emacs/fake-helper.ts in place of the real
;; helper, so no agentpane server is needed.  Run from the repository root
;; with
;;
;;     emacs --batch -L emacs -l ert -l agentpane -l agentpane-test \
;;       -f ert-run-tests-batch-and-exit
;;
;; The nodes below are in the shape `jsonrpc.el' delivers -- plists with
;; keyword keys, arrays as vectors -- and their HTML is what `renderMarkdown'
;; emits for the markdown beside it.

;;; Code:

(require 'ert)
(require 'agentpane)

;;;; The server's refusal, shared by every stub that answers a request

(defconst agentpane-test--live-methods
  '(sessions/abort sessions/compact sessions/dismissError sessions/setModel
    sessions/setEffort sessions/setName sessions/forkPoints sessions/fork
    sessions/forkAndPrompt)
  "The helper's methods on a live session, each of which it sends the
server under the handle the request's view is bound to (`ViewParams' in
src/emacs/protocol.ts).")

(defun agentpane-test--refusal (method params)
  "The `data' of the error the helper answers METHOD with PARAMS with where
it or the server refuses it before running it, or nil where it would run
it.  A request on a session that names no integer `view', or still sends
a `handle', is refused `bad_request', as a request the helper cannot
read would be (D32 point 1).  A command on a live
session from a view whose buffer holds no handle is refused
`not_attached', as the helper refuses one from a view bound to nothing
\(`liveHandle' in src/emacs/helper.ts), the buffer holding a handle
exactly while the helper binds its view.  Every stub that answers a
request asks this first, so a test that sends what the helper would
refuse cannot pass on an answer it would not give."
  (cond
   ((and (plist-member params :session)
         (not (eq method 'sessions/preview))
         (or (not (integerp (plist-get params :view)))
             (plist-member params :handle)))
    (list :error "bad_request" :detail "a request on a session names its view and nothing else"))
   ((and (memq method agentpane-test--live-methods)
         (not (let ((buffer (agentpane--view-buffer (plist-get params :view))))
                (and buffer (buffer-local-value 'agentpane--handle buffer)))))
    (list :error "not_attached" :detail "no live session is attached to this buffer"))))

(defun agentpane-test--view (buffer)
  "BUFFER's view id, which the helper sends its notifications under (D32
point 1)."
  (buffer-local-value 'agentpane--view buffer))

(defun agentpane-test--refusing (request)
  "REQUEST, a function in place of `agentpane--request', made to answer
first what the server refuses (`agentpane-test--refusal') as
`agentpane--request' answers a refusal: saying so, then running FAILED
and ERRED with the refusal in the buffer that sent it."
  (lambda (method params callback &optional always failed timeout erred)
    (let ((refusal (agentpane-test--refusal method params)))
      (if (not refusal)
          (funcall request method params callback always failed timeout erred)
        (message "agentpane: %s failed: %s" method (plist-get refusal :detail))
        (when failed (funcall failed))
        (when erred (funcall erred refusal))
        nil))))

(defconst agentpane-test--nodes
  [(:index 0 :role "user"
    :parts [(:type "text" :text "Fix the bug" :html "<p>Fix the bug</p>\n")])
   (:index 1 :role "assistant"
    :parts [(:type "text" :text "Looking." :html "<p>Looking.</p>\n")
            (:type "tool" :name "Read" :summary "app.ts" :args "{\"path\": \"app.ts\"}"
             :result "const x = 1;" :state "ok")
            (:type "tool" :name "Edit" :summary "app.ts (+1 -1)" :args ""
             :result "ok" :state "ok"
             :diff [(:type "ctx" :text "before")
                    (:type "del" :text "old line")
                    (:type "add" :text "new line")
                    (:type "gap" :text "3 unchanged lines")])]
    :meta (:model "haiku" :usage (:totalTokens 12 :cost 0.001)))]
  "A fixed transcript: a user turn, then an assistant turn with two tools.")

(defun agentpane-test--render ()
  "Draw the fixed nodes into a fresh transcript buffer and return it."
  (let ((buffer (generate-new-buffer " *agentpane-test*")))
    (with-current-buffer buffer
      (agentpane-transcript-mode)
      (agentpane--draw agentpane-test--nodes))
    buffer))

(defun agentpane-test--position (text)
  "The position of the first TEXT in the current buffer, or signal."
  (save-excursion
    (goto-char (point-min))
    (search-forward text)
    (match-beginning 0)))

(ert-deftest agentpane-test-lines-in-order ()
  "The user text, assistant text, tool summaries and meta appear in order, the
meta on the header of the tool call that ends the step."
  (with-current-buffer (agentpane-test--render)
    (let ((positions (mapcar #'agentpane-test--position
                             '("Fix the bug" "Looking." "Read app.ts"
                               "Edit app.ts (+1 -1)" "· haiku · 12 tok"))))
      (should (equal positions (sort (copy-sequence positions) #'<))))
    (kill-buffer)))

(defun agentpane-test--meta-line (meta &optional timestamp)
  "The meta line drawn for an assistant node carrying META and TIMESTAMP, or
nil when none is drawn."
  (with-temp-buffer
    (agentpane-transcript-mode)
    (agentpane--draw (vector (list :index 1 :role "assistant" :parts [] :meta meta
                                   :timestamp timestamp)))
    (goto-char (point-min))
    (and (re-search-forward "^— .*$" nil t)
         (match-string-no-properties 0))))

(defmacro agentpane-test--in-kolkata (&rest body)
  "Run BODY with Emacs's local zone pinned to Asia/Kolkata, as the vitest
run's is: a half-hour offset makes both the clock and the offset arithmetic
visible in a time assertion, whatever zone the run itself is in."
  (declare (indent 0))
  `(let ((zone (getenv "TZ")))
     (unwind-protect
         (progn (set-time-zone-rule "Asia/Kolkata") ,@body)
       (set-time-zone-rule zone))))

(defconst agentpane-test--ms 1790103630500
  "2026-09-22T19:00:30.500Z as epoch milliseconds: in Asia/Kolkata, the
next day's 00:30:30, the half second dropped as the browser drops it.")

(ert-deftest agentpane-test-meta-leads-with-the-timestamp ()
  "An assistant turn's timestamp is its meta line's first field, in the local
zone and to the second, as the browser's footer shows it."
  (agentpane-test--in-kolkata
    (should (equal (agentpane-test--meta-line
                    '(:model "claude-opus-5" :usage (:totalTokens 136013 :cost 0))
                    agentpane-test--ms)
                   "— 2026-09-23 00:30:30 · claude-opus-5 · 136K tok"))))

(ert-deftest agentpane-test-meta-needs-a-model-or-tokens ()
  "A turn with neither a model nor tokens draws no meta line, as the
browser's `showsMeta' draws none, but one that ended badly still says so."
  (should-not (agentpane-test--meta-line '(:model "" :usage (:totalTokens 0 :cost 0))
                                         agentpane-test--ms))
  (should (equal (agentpane-test--meta-line
                  '(:model "" :usage (:totalTokens 0 :cost 0) :stopReason "aborted")
                  agentpane-test--ms)
                 "— aborted")))

(ert-deftest agentpane-test-user-turn-shows-its-timestamp ()
  "A user turn's timestamp is drawn inside its box, below its text."
  (agentpane-test--in-kolkata
    (with-temp-buffer
      (agentpane-transcript-mode)
      (agentpane--draw (vector (list :index 0 :role "user" :timestamp agentpane-test--ms
                                     :parts (plist-get (aref agentpane-test--nodes 0) :parts))))
      (let ((time (agentpane-test--position "2026-09-23 00:30:30")))
        (should (< (agentpane-test--position "Fix the bug") time))
        (should (memq 'agentpane-user-box (agentpane-test--faces-at "2026-09-23 00:30:30")))))))

(ert-deftest agentpane-test-compaction-marker-reads-as-the-browser ()
  "A compaction marker carries the browser's words, not its raw role: it
reads Context compacted, names the context size it folded in compact tokens,
and a marker whose size is 0 names none."
  (with-temp-buffer
    (agentpane-transcript-mode)
    (agentpane--draw [(:index 0 :role "compactionSummary" :tokensBefore 28000 :parts [])
                      (:index 1 :role "compactionSummary" :tokensBefore 0 :parts [])])
    (should (= 2 (count-matches "Context compacted" (point-min) (point-max))))
    (should (string-search "from 28K tok" (buffer-string)))
    (should (= 1 (count-matches "tok" (point-min) (point-max))))
    (should-not (string-search "compactionSummary" (buffer-string)))))

(ert-deftest agentpane-test-system-node-is-a-folded-marker ()
  "A system node draws as its summary on one header line with no role label,
its body folded beneath it until TAB, as the browser's disclosure is."
  (with-temp-buffer
    (agentpane-transcript-mode)
    (agentpane--draw
     [(:index 0 :role "system"
       :parts [(:type "system" :summary "System prompt · 5 sections · 4 tools"
                :body "preamble:\n<preamble>\nYou are an expert.\n</preamble>\n\ntools added:\nread — Read a file.")])
      (:index 1 :role "user"
       :parts [(:type "text" :text "Fix the bug" :html "<p>Fix the bug</p>\n")])])
    (should-not (string-match-p "^system$" (buffer-string)))
    (should-not (string-search "[unknown part type" (buffer-string)))
    (should (string-search "System prompt" (agentpane-test--line-at "System prompt")))
    (should (invisible-p (agentpane-test--position "You are an expert.")))
    (should (invisible-p (agentpane-test--position "read — Read a file.")))
    (should-not (invisible-p (agentpane-test--position "Fix the bug")))
    (goto-char (agentpane-test--position "System prompt"))
    (agentpane-toggle)
    (should-not (invisible-p (agentpane-test--position "You are an expert.")))))

(ert-deftest agentpane-test-tool-result-images-in-the-fold ()
  "A tool result's image parts are drawn in its folded body, where its text
is, and a result that is only images is not drawn as none."
  (with-temp-buffer
    (agentpane-transcript-mode)
    (agentpane--draw
     [(:index 1 :role "assistant"
       :parts [(:type "tool" :name "read" :summary "shot.png" :args "" :result ""
                :state "ok" :images [(:type "image" :mimeType "image/png" :data "AAAA")])]
       :meta (:model "haiku" :usage (:totalTokens 1 :cost 0)))])
    (should (invisible-p (agentpane-test--position "[image image/png]")))
    (should-not (string-search "(none)" (buffer-string)))
    (goto-char (agentpane-test--position "read shot.png"))
    (agentpane-toggle)
    (should-not (invisible-p (agentpane-test--position "[image image/png]")))))

(ert-deftest agentpane-test-meta-compact-tokens-no-zero-cost ()
  "The meta line shows tokens as the browser's footer does, and no index or zero cost."
  (let ((line (agentpane-test--meta-line
               '(:model "claude-opus-5" :usage (:totalTokens 136013 :cost 0)))))
    (should (string-search "136K tok" line))
    (should-not (string-search "#" line))
    (should-not (string-search "$" line))))

(ert-deftest agentpane-test-meta-nonzero-cost ()
  "A non-zero cost follows the tokens at four decimals, and effort is bare."
  (should (equal (agentpane-test--meta-line
                  '(:model "haiku" :effort "high"
                    :usage (:totalTokens 1234 :cost 0.00123)))
                 "— haiku · high · 1.2K tok · $0.0012")))

(ert-deftest agentpane-test-compact-number-matches-intl ()
  "Token counts round as en-US `Intl.NumberFormat' compact notation does.
The expected strings are what `bun 1.4.0' printed for each value."
  (dolist (case '((1 . "1") (12 . "12") (999 . "999") (1000 . "1K")
                  (1049 . "1K") (1050 . "1.1K") (1234 . "1.2K") (1949 . "1.9K")
                  (1950 . "2K") (9949 . "9.9K") (9950 . "10K") (12345 . "12K")
                  (99499 . "99K") (99500 . "100K") (136013 . "136K")
                  (999499 . "999K") (999500 . "1M") (999999 . "1M")
                  (1049999 . "1M") (1050000 . "1.1M") (1500000 . "1.5M")
                  (9950000 . "10M") (999999999 . "1B") (1234567890 . "1.2B")
                  (1500000000000 . "1.5T") (1000000000000000 . "1000T")))
    (should (equal (agentpane--compact-number (car case)) (cdr case)))))

(ert-deftest agentpane-test-no-role-label ()
  "Neither a user nor an assistant turn carries a role label."
  (with-current-buffer (agentpane-test--render)
    (should-not (string-match-p "^user$\\|^assistant$" (buffer-string)))
    (kill-buffer)))

(ert-deftest agentpane-test-tool-result-folded-until-toggled ()
  "A tool part's result is invisible until TAB on its summary line, then visible."
  (with-current-buffer (agentpane-test--render)
    (let ((result (agentpane-test--position "const x = 1;")))
      ;; `invisible-p' asks the display, through the buffer's invisibility
      ;; spec; the property alone would read the same with the spec gone.
      (should (invisible-p result))
      (goto-char (agentpane-test--position "Read app.ts"))
      (agentpane-toggle)
      (should-not (invisible-p (agentpane-test--position "const x = 1;")))
      ;; `agentpane-toggle' leaves point on the summary line, so a second TAB
      ;; folds it again.
      (agentpane-toggle)
      (should (invisible-p (agentpane-test--position "const x = 1;"))))
    (kill-buffer)))

(defun agentpane-test--faces-at (text)
  "The faces on the first character of TEXT in the current buffer, as a list."
  (let ((face (get-text-property (agentpane-test--position text) 'face)))
    (if (listp face) face (list face))))

(ert-deftest agentpane-test-diff-lines-carry-diff-faces ()
  "A diff part's added and removed lines carry `diff-added' and `diff-removed'."
  (with-current-buffer (agentpane-test--render)
    (should (memq 'diff-added (agentpane-test--faces-at "+new line")))
    (should (memq 'diff-removed (agentpane-test--faces-at "-old line")))
    (should (memq 'diff-context (agentpane-test--faces-at " before")))
    (should-not (memq 'diff-added (agentpane-test--faces-at "-old line")))
    (kill-buffer)))

;;;; Fold headers: one screen line each, the meta on the last tool's

(defun agentpane-test--line-at (text)
  "The buffer line holding the first TEXT, with its properties, less its newline."
  (save-excursion
    (goto-char (agentpane-test--position text))
    (buffer-substring (line-beginning-position) (line-end-position))))

(defun agentpane-test--tool (summary result)
  "A finished `Bash' tool part running SUMMARY and answering RESULT."
  (list :type "tool" :name "Bash" :summary summary :args "" :result result :state "ok"))

(defconst agentpane-test--step-meta
  '(:model "claude-opus-5" :usage (:totalTokens 49000 :cost 0))
  "The meta of one model step, whose model is drawn nowhere else.")

(ert-deftest agentpane-test-meta-rides-the-last-tool-header ()
  "A step whose last part is a tool call draws its meta on that call's header
line and on no line of its own, and an earlier call's header carries none;
while the step is the streaming tail, the header carries no meta at all."
  (with-temp-buffer
    (agentpane-transcript-mode)
    (let ((node (list :index 1 :role "assistant" :meta agentpane-test--step-meta
                      :parts (vector (agentpane-test--tool "rg -n one" "a")
                                     (agentpane-test--tool "rg -n two" "b")))))
      (agentpane--draw (vector node))
      (should (string-search "claude-opus-5" (agentpane-test--line-at "rg -n two")))
      (should-not (string-search "claude-opus-5" (agentpane-test--line-at "rg -n one")))
      (should (= 1 (count-matches "claude-opus-5" (point-min) (point-max))))
      (goto-char (point-min))
      (should-not (re-search-forward "^— " nil t))
      (setq agentpane--streaming t)
      (agentpane--draw (vector node))
      (should-not (string-search "claude-opus-5" (buffer-string)))
      (goto-char (point-min))
      (should-not (re-search-forward "^— " nil t)))))

(ert-deftest agentpane-test-long-summary-cut-to-one-line ()
  "A tool whose summary is far wider than the window draws a header that fits
one line of it, its summary ending in `…', and unfolding it shows the whole
summary."
  (let ((summary (mapconcat #'number-to-string (number-sequence 1 60) " ")))
    (with-temp-buffer
      (agentpane-transcript-mode)
      (cl-letf (((symbol-function 'agentpane--window-width) (lambda () 40)))
        (agentpane--draw
         (vector (list :index 1 :role "assistant" :meta agentpane-test--step-meta
                       :parts (vector (agentpane-test--tool summary "done")))))
        (let ((header (agentpane-test--line-at "Bash")))
          ;; The drawn text is read-only, which `string-pixel-width' trips
          ;; on when it empties its work buffer.
          (should (<= (let ((inhibit-read-only t))
                        (string-pixel-width header (current-buffer)))
                      40))
          (should (string-search "…" header))
          (should-not (string-search summary header)))
        (goto-char (agentpane-test--position "Bash"))
        (agentpane-toggle)
        (should-not (invisible-p (agentpane-test--position summary)))))))

(ert-deftest agentpane-test-headers-refit-at-a-new-width ()
  "A window narrowing under a drawn header schedules a redraw, which fits the
header to the new width."
  (let ((summary (mapconcat #'number-to-string (number-sequence 1 20) " "))
        (width 80))
    (with-temp-buffer
      (agentpane-transcript-mode)
      (cl-letf (((symbol-function 'agentpane--window-width) (lambda () width)))
        (agentpane--draw
         (vector (list :index 1 :role "assistant"
                       :parts (vector (agentpane-test--tool summary "done")))))
        (should (string-search summary (agentpane-test--line-at "Bash")))
        (setq width 30)
        (agentpane--refit-on-resize nil)
        (should (timerp agentpane--refit-timer))
        (cancel-timer agentpane--refit-timer)
        (agentpane--refit (current-buffer))
        (should-not (string-search summary (agentpane-test--line-at "Bash")))
        (should (string-search "…" (agentpane-test--line-at "Bash")))))))

(ert-deftest agentpane-test-meta-after-closing-text-keeps-its-line ()
  "A step that ends in text draws its meta on a line of its own after that
text, and the tool call before the text carries none on its header."
  (with-temp-buffer
    (agentpane-transcript-mode)
    (agentpane--draw
     (vector (list :index 1 :role "assistant" :meta agentpane-test--step-meta
                   :parts (vector (agentpane-test--tool "rg -n one" "a")
                                  '(:type "text" :text "Found it." :html "<p>Found it.</p>\n")))))
    (should-not (string-search "claude-opus-5" (agentpane-test--line-at "rg -n one")))
    (let ((meta (agentpane-test--line-at "claude-opus-5")))
      (should (string-prefix-p "— " meta)))
    (should (< (agentpane-test--position "Found it.")
               (agentpane-test--position "claude-opus-5")))))

(ert-deftest agentpane-test-long-summary-keeps-its-start-and-the-meta ()
  "A tool whose summary runs far past the window draws the summary's start,
cut short, and the step's meta on its header."
  (let ((summary (mapconcat #'number-to-string (number-sequence 1 300) " ")))
    (with-temp-buffer
      (agentpane-transcript-mode)
      (cl-letf (((symbol-function 'agentpane--window-width) (lambda () 60)))
        (agentpane--draw
         (vector (list :index 1 :role "assistant" :meta agentpane-test--step-meta
                       :parts (vector (agentpane-test--tool summary "done")))))
        (let ((header (agentpane-test--line-at "Bash")))
          (should (string-search "Bash 1 2 3 4 5" header))
          (should (string-search "…" header))
          (should (string-search "claude-opus-5" header)))))))

;;;; Hanging indents of a text part

(defconst agentpane-test--wrap-html
  "<p>A plain paragraph.</p>\n<ul>\n<li>one</li>\n<li>two<ul>\n<li>nested<ul>\n<li>deeper</li>\n</ul>\n</li>\n</ul>\n</li>\n<li>three</li>\n</ul>\n<ol>\n<li>first</li>\n<li>second</li>\n</ol>\n<blockquote>\n<p>quoted</p>\n</blockquote>\n<p>2024 was a year.</p>\n<pre class=\"ap-code\" data-fence=\"0\"><code class=\"hljs\">- dash\n  indented</code></pre>\n"
  "The HTML `renderMarkdown' emits for a paragraph, a bulleted list nested
three deep, a numbered list, a quote, a paragraph opening with a number,
and a fenced block whose lines open with a dash and with spaces.")

(defun agentpane-test--wrap-layout ()
  "Each non-empty line above the prompt as (TEXT WRAP-PREFIX DISPLAYS).
WRAP-PREFIX is the line's `wrap-prefix', a string given as its
`object-intervals'; DISPLAYS are the line's `display' runs, as (FROM TO
DISPLAY) from the line's start."
  (let (lines)
    (goto-char (point-min))
    (while (< (point) agentpane--prompt-separator)
      (let ((line (buffer-substring (point) (pos-eol)))
            (prefix (get-text-property (point) 'wrap-prefix)))
        (unless (string-empty-p line)
          (push (list (substring-no-properties line)
                      (if (stringp prefix) (object-intervals prefix) prefix)
                      (seq-keep (pcase-lambda (`(,from ,to ,props))
                                  (when-let* ((display (plist-get props 'display)))
                                    (list from to display)))
                                (object-intervals line)))
                lines)))
      (forward-line 1))
    (nreverse lines)))

(ert-deftest agentpane-test-text-part-hanging-indents ()
  "A drawn text part's list rows carry visual-wrap's hanging indent, a
`wrap-prefix' aligned past the marker and a `min-width' on the marker; an
indented line's prefix is its own indentation, and a plain line has none,
even one that opens with a number or a dash as a marker would.  Batch Emacs
measures in columns, so the widths here are the marker's column counts."
  (with-temp-buffer
    (agentpane-transcript-mode)
    (agentpane--draw
     (vector (list :index 1 :role "assistant"
                   :parts (vector (list :type "text" :text "" :html agentpane-test--wrap-html)))))
    (should
     (equal
      (agentpane-test--wrap-layout)
      '(("A plain paragraph." nil nil)
        ("* one" (space :align-to (2 . width))
         ((0 1 (min-width ((2 . width)))) (1 2 (min-width ((2 . width))))))
        ("* two" (space :align-to (2 . width))
         ((0 1 (min-width ((2 . width)))) (1 2 (min-width ((2 . width))))))
        (" * nested" (space :align-to (4 . width))
         ((0 1 ((min-width ((4 . width))) (space :width (2.0 . width))))
          (1 2 (min-width ((4 . width)))) (2 3 (min-width ((4 . width))))))
        (" * deeper" (space :align-to (6 . width))
         ((0 1 ((min-width ((6 . width))) (space :width (4.0 . width))))
          (1 2 (min-width ((6 . width)))) (2 3 (min-width ((6 . width))))))
        ("* three" (space :align-to (2 . width))
         ((0 1 (min-width ((2 . width)))) (1 2 (min-width ((2 . width))))))
        ("1. first" (space :align-to (3 . width))
         ((0 1 (min-width ((3 . width)))) (1 3 (min-width ((3 . width))))))
        ("2. second" (space :align-to (3 . width))
         ((0 1 (min-width ((3 . width)))) (1 3 (min-width ((3 . width))))))
        (" quoted"
         ((0 1 (face nil shr-prefix-length 1 display (space :width (4.0 . width)))))
         ((0 1 (space :width (4.0 . width)))))
        ("2024 was a year." nil nil)
        ("- dash" nil nil)
        ("  indented" ((0 2 (face (agentpane-code agentpane-code-block)))) nil))))))

(ert-deftest agentpane-test-ordered-list-markers-read-like-the-browser ()
  "An ordered list's markers read `1.' and `2.', as the browser draws them,
where shr's own are bare numbers; a list given a start counts from it, and
a wrapped row hangs past the whole `1. ' marker."
  (with-temp-buffer
    (agentpane-transcript-mode)
    (agentpane--draw
     (vector (list :index 1 :role "assistant"
                   :parts (vector (list :type "text" :text ""
                                        :html "<ol>\n<li>first</li>\n<li>second</li>\n</ol>\n<ol start=\"7\">\n<li>seventh</li>\n</ol>\n")))))
    (let ((layout (agentpane-test--wrap-layout)))
      (should (equal (mapcar #'car layout) '("1. first" "2. second" "7. seventh")))
      (should (equal (nth 1 (assoc "1. first" layout)) '(space :align-to (3 . width)))))))

(ert-deftest agentpane-test-list-rows-measure-once-per-text-part ()
  "A text part of forty plain paragraphs and twelve bulleted rows, in four
lists, measures the rows' marker and its average-width space once each,
where visual-wrap alone measures both on every row, 24 in all.  The plain
lines cost nothing either way: their adaptive prefix is empty, and
visual-wrap measures only a prefix that is not.  The other two measures
are shr's own, of its bullet and its table separator, once per document."
  (let* ((html (mapconcat
                (lambda (group)
                  (concat (mapconcat (lambda (n) (format "<p>Line %d.%d</p>\n" group n))
                                     (number-sequence 1 10) "")
                          "<ul>\n"
                          (mapconcat (lambda (n) (format "<li>item %d.%d</li>\n" group n))
                                     (number-sequence 1 3) "")
                          "</ul>\n"))
                (number-sequence 1 4) ""))
         (calls 0)
         (count (lambda (&rest _) (setq calls (1+ calls)))))
    (with-temp-buffer
      (agentpane-transcript-mode)
      (advice-add 'string-pixel-width :before count)
      (unwind-protect
          (agentpane--draw
           (vector (list :index 1 :role "assistant"
                         :parts (vector (list :type "text" :text "" :html html)))))
        (advice-remove 'string-pixel-width count))
      (should (equal (nth 1 (assoc "* item 4.3" (agentpane-test--wrap-layout)))
                     '(space :align-to (2 . width))))
      (should (<= calls 4)))))

;;;; Fold headers in a frame that lays out text, run in a tty Emacs

;; `vertical-motion' does not move in batch Emacs, as measured on Emacs 31.1
;; on 2026-09-25, so these tests are tagged `tty', skip in batch, and run
;; in `emacs -nw' by `agentpane-test-run-tty'; the Commentary of
;; agentpane.el gives the command.

(defun agentpane-test-run-tty ()
  "Run the tests tagged `tty' with ERT's batch report, and exit: 0 when all
ran as expected, 1 when one did not, 2 when the run itself signalled.
For `emacs -nw', where `message' reaches only the echo area: the report
goes to standard error instead, which the command sends to the terminal."
  (kill-emacs
   (condition-case err
       (cl-letf (((symbol-function 'message)
                  (lambda (format &rest args)
                    (when format
                      (princ (concat (apply #'format-message format args) "\n")
                             #'external-debugging-output)))))
         (if (zerop (ert-stats-completed-unexpected (ert-run-tests-batch '(tag tty))))
             0
           1))
     (error (princ (format "%S\n" err) #'external-debugging-output)
            2))))

(ert-deftest agentpane-test-cut-header-measures-at-most-three-times ()
  "A tool whose summary is ten times the fitted width costs at most three
layouts to cut, where a binary search over the summary's length costs one
per step; and so does one whose summary is right-to-left text."
  :tags '(tty)
  (skip-unless (not noninteractive))
  (let* ((width (agentpane--window-width))
         (numbers (mapconcat #'number-to-string (number-sequence 1 (* 3 width)) " "))
         (hebrew (apply #'concat (make-list (* 2 width) "שלום עולם "))))
    (dolist (summary (list numbers hebrew))
      (let* ((summary (substring summary 0 (* 10 width)))
             (layouts 0)
             (count (lambda (&rest _) (setq layouts (1+ layouts)))))
        (with-temp-buffer
          (agentpane-transcript-mode)
          (advice-add 'string-pixel-width :before count)
          (advice-add 'vertical-motion :before count)
          (unwind-protect
              (agentpane--draw
               (vector (list :index 1 :role "assistant" :meta agentpane-test--step-meta
                             :parts (vector (agentpane-test--tool summary "done")))))
            (advice-remove 'string-pixel-width count)
            (advice-remove 'vertical-motion count))
          (let ((header (agentpane-test--line-at "Bash")))
            (should (string-search "…" header))
            (should (string-search "claude-opus-5" header)))
          (should (<= layouts 3)))))))

(ert-deftest agentpane-test-motion-cuts-where-the-search-does ()
  "A header cut by `vertical-motion' is the one the binary search cuts, for
summaries that fit, that just miss and that run to many lines, of words,
of wide characters, of right-to-left text, and holding a tab, with the
meta beside them and without, at widths from a few columns to the
window's, and with the window scrolled horizontally."
  :tags '(tty)
  (skip-unless (not noninteractive))
  (should (agentpane--motion-window))
  (let* ((words (mapconcat #'number-to-string (number-sequence 1 400) " "))
         (wide (apply #'concat (make-list 100 "中文字 ")))
         (hebrew (apply #'concat (make-list 60 "שלום עולם ")))
         (summaries (append (mapcar (lambda (length) (substring words 0 length))
                                    '(1 10 30 60 70 75 76 77 78 79 80 200 1000))
                            (list wide (concat "rg -n " wide) hebrew (concat "echo " hebrew)
                                  (propertize (concat "Thinking about\t" words)
                                              'face 'agentpane-thinking))))
         (head (concat (propertize "✓" 'face 'agentpane-tool-ok) " "
                       (propertize "Bash" 'face 'agentpane-tool) " "))
         (tail (propertize " · claude-opus-5 · 49k tok" 'face 'agentpane-dim))
         (full (window-body-width nil t))
         mismatches)
    (with-temp-buffer
      (agentpane-transcript-mode)
      (unwind-protect
          (dolist (hscroll '(0 5))
            (set-window-hscroll nil hscroll)
            (should (agentpane--motion-window))
            (dolist (width (list 12 30 (min 40 full) full))
              (cl-letf (((symbol-function 'agentpane--window-width) (lambda () width)))
                (dolist (summary summaries)
                  (dolist (tail (list nil tail))
                    (let ((motion (agentpane--fit-header head summary tail))
                          (search (cl-letf (((symbol-function 'agentpane--motion-window) #'ignore))
                                    (agentpane--fit-header head summary tail))))
                      (unless (equal-including-properties motion search)
                        (push (list hscroll width summary tail motion search) mismatches))))))))
        (set-window-hscroll nil 0)))
    (should-not mismatches)))

(ert-deftest agentpane-test-motion-only-on-the-selected-frame ()
  "A transcript shown only on a frame other than the selected one is cut by
the search, since its headers are measured in the selected frame."
  :tags '(tty)
  (skip-unless (not noninteractive))
  (let ((frame (make-frame)))
    (unwind-protect
        (with-temp-buffer
          (agentpane-transcript-mode)
          (set-window-buffer (frame-root-window frame) (current-buffer))
          (should (eq (agentpane--fit-window) (frame-root-window frame)))
          (should-not (eq frame (selected-frame)))
          (should-not (agentpane--motion-window)))
      (delete-frame frame))))

;;;; Notifications driving an attached buffer, with no process

(defmacro agentpane-test--with-session (ref &rest body)
  "Run BODY in a fresh transcript buffer holding the session REF, drawn with
the fixed nodes, and kill the buffer afterwards.  Every pretty-printed node
index is pushed onto `drawn', which BODY sees."
  (declare (indent 1))
  `(let ((buffer (agentpane--transcript-buffer (list :ref ,ref)))
         (drawn nil))
     (unwind-protect
         (with-current-buffer buffer
           (agentpane--draw agentpane-test--nodes)
           (let ((pp (symbol-function 'agentpane--pp)))
             (cl-letf (((symbol-function 'agentpane--pp)
                        (lambda (node)
                          (push (plist-get node :index) drawn)
                          (funcall pp node))))
               ,@body)))
       (kill-buffer buffer))))

(defun agentpane-test--indices ()
  "The indices of the nodes drawn in the current buffer, in order."
  (mapcar (lambda (data) (plist-get data :index))
          (ewoc-collect agentpane--ewoc (lambda (_) t))))

(defun agentpane-test--redraw (buffer)
  "Run, in order, the pending timers that draw the nodes BUFFER recorded,
as the command loop runs them once the notifications before them are
handled; see `agentpane--record'."
  (dolist (timer (seq-filter (lambda (timer)
                               (and (eq (timer--function timer) #'agentpane--draw-recorded)
                                    (equal (timer--args timer) (list buffer))))
                             timer-list))
    (cancel-timer timer)
    (apply (timer--function timer) (timer--args timer))))

(defun agentpane-test--assistant (index html)
  "An assistant node at INDEX whose one text part renders as HTML."
  (list :index index :role "assistant"
        :parts (vector (list :type "text" :text html :html html))
        :meta '(:model "luna" :usage (:totalTokens 1 :cost 0))))

(ert-deftest agentpane-test-node-redraws-in-place ()
  "A `session/node' for a drawn index redraws that node where it is, and no other."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/node
       (list :view agentpane--view :session ref :handle "h1" :node (agentpane-test--assistant 1 "<p>Done now.</p>")))
      (agentpane-test--redraw buffer)
      (should (equal drawn '(1)))
      (should (equal (agentpane-test--indices) '(0 1)))
      (should (string-search "Done now." (buffer-string)))
      (should-not (string-search "Looking." (buffer-string)))
      (should (< (agentpane-test--position "Fix the bug")
                 (agentpane-test--position "Done now.")
                 (agentpane-test--position "── prompt"))))))

(ert-deftest agentpane-test-node-for-new-index-appends ()
  "A `session/node' for an index no drawn node carries appends a node after
the last, above the prompt region."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/node
       (list :view agentpane--view :session ref :handle "h1" :node (agentpane-test--assistant 3 "<p>Appended.</p>")))
      (agentpane-test--redraw buffer)
      (should (equal drawn '(3)))
      (should (equal (agentpane-test--indices) '(0 1 3)))
      (should (< (agentpane-test--position "Looking.")
                 (agentpane-test--position "Appended.")
                 (agentpane-test--position "── prompt"))))))

(ert-deftest agentpane-test-node-backlog-redraws-once ()
  "Several `session/node's for one index, handled before any timer runs, as
a backlog's are, draw that node once, with the last one's content
\(OW-tujezi)."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (dolist (html '("<p>Draft one.</p>" "<p>Draft two.</p>" "<p>Done now.</p>"))
        (agentpane--on-notification
         nil 'session/node (list :view agentpane--view :session ref :handle "h1" :node (agentpane-test--assistant 1 html))))
      (agentpane-test--redraw buffer)
      (should (equal drawn '(1)))
      (should (string-search "Done now." (buffer-string)))
      (should-not (string-search "Draft" (buffer-string))))))

(ert-deftest agentpane-test-node-backlog-appends-in-arrival-order ()
  "Nodes at new indices in a backlog are appended in the order each index
first arrived, each drawn once however often it came."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (dolist (node (list (agentpane-test--assistant 4 "<p>Four.</p>")
                          (agentpane-test--assistant 3 "<p>Three.</p>")
                          (agentpane-test--assistant 4 "<p>Four again.</p>")))
        (agentpane--on-notification nil 'session/node (list :view agentpane--view :session ref :handle "h1" :node node)))
      (agentpane-test--redraw buffer)
      (should (equal drawn '(3 4)))
      (should (equal (agentpane-test--indices) '(0 1 4 3)))
      (should (string-search "Four again." (buffer-string))))))

(ert-deftest agentpane-test-status-finds-the-recorded-node-drawn ()
  "A `session/status' arriving after a `session/node' not yet drawn draws it
before the status is applied, so the order `agentpane--set-status' relies
on is kept, and the redraw scheduled for it then draws nothing more."
  (let ((ref '(:backend "codex" :id "t1"))
        (seen nil))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/node (list :view agentpane--view :session ref :handle "h1" :node (agentpane-test--assistant 1 "<p>Done now.</p>")))
      (let ((set-status (symbol-function 'agentpane--set-status)))
        (cl-letf (((symbol-function 'agentpane--set-status)
                   (lambda (params)
                     (setq seen (string-search "Done now." (buffer-string)))
                     (funcall set-status params))))
          (agentpane--on-notification
           nil 'session/status (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false))))
      (should seen)
      (agentpane-test--redraw buffer)
      (should (equal drawn '(1))))))

(ert-deftest agentpane-test-notice-lands-after-the-recorded-node ()
  "A `session/notice' arriving after a `session/node' not yet drawn, at an
index no drawn node carries, draws that node first, so the notice is
appended after it, in the order the two arrived."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/node (list :view agentpane--view :session ref :handle "h1" :node (agentpane-test--assistant 3 "<p>Three.</p>")))
      (agentpane--on-notification
       nil 'session/notice
       (list :view agentpane--view :session ref :handle "h1"
             :notice '(:kind "warning" :message "Fallback metadata" :details nil :path nil)))
      (agentpane-test--redraw buffer)
      (should (equal (agentpane-test--indices) '(0 1 3 nil)))
      (should (< (agentpane-test--position "Three.")
                 (agentpane-test--position "ℹ Fallback metadata"))))))

(ert-deftest agentpane-test-notice-message-lines-are-drawn-as-lines ()
  "A `session/notice' whose message spans lines, as a Pi command's `notify'
does, draws each of them on a line of its own, the blank one included."
  (let ((ref '(:backend "pi" :id "/tmp/s.jsonl")))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/notice
       (list :view agentpane--view :session ref :handle "h1"
             :notice '(:kind "notify" :message "Discovered @references:\n\n✓ @a.md\n✓ @b.md"
                       :details nil :path nil)))
      (agentpane-test--redraw buffer)
      (let ((first (line-number-at-pos (agentpane-test--position "ℹ Discovered @references:"))))
        (should (equal (mapcar (lambda (text)
                                 (let ((at (agentpane-test--position text)))
                                   (list (- (line-number-at-pos at) first)
                                         (= at (save-excursion (goto-char at) (line-beginning-position))))))
                               '("✓ @a.md" "✓ @b.md"))
                       '((2 t) (3 t))))))))

(ert-deftest agentpane-test-snapshot-discards-the-recorded-node ()
  "A `session/snapshot' after a `session/node' not yet drawn supersedes it:
the snapshot's nodes are drawn and the recorded one never is."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/node (list :view agentpane--view :session ref :handle "h1" :node (agentpane-test--assistant 3 "<p>Stale.</p>")))
      (agentpane--on-notification
       nil 'session/snapshot
       (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false :nodes agentpane-test--nodes))
      (agentpane-test--redraw buffer)
      (should (equal drawn '(1 0)))
      (should-not (string-search "Stale." (buffer-string))))))

(ert-deftest agentpane-test-recorded-node-dies-with-its-buffer ()
  "A `session/node' recorded for a buffer killed before its redraw runs is
never drawn, and the redraw raises nothing."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/node (list :view agentpane--view :session ref :handle "h1" :node (agentpane-test--assistant 1 "<p>Done now.</p>")))
      (kill-buffer buffer)
      (agentpane-test--redraw buffer)
      (should-not drawn))))

(ert-deftest agentpane-test-notice-is-its-own-node ()
  "A `session/notice' appends a notice node above the prompt region, drawn
with its details and path and in its own face, and not as an `(:error ...)'."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/notice
       (list :view agentpane--view :session ref :handle "h1"
             :notice '(:kind "configWarning" :message "Unknown key"
                       :details "Remove it" :path "/c.toml:3:5")))
      (let ((data (ewoc-data (ewoc-nth agentpane--ewoc -1))))
        (should (plist-member data :notice))
        (should-not (plist-member data :error)))
      (should-not (string-search "⚠" (buffer-string)))
      (let ((at (agentpane-test--position "ℹ Unknown key")))
        (should (eq (get-text-property at 'face) 'agentpane-notice))
        (should (< (agentpane-test--position "Looking.")
                   at
                   (agentpane-test--position "Remove it")
                   (agentpane-test--position "/c.toml:3:5")
                   (agentpane-test--position "── prompt")))))))

(ert-deftest agentpane-test-notice-survives-a-snapshot ()
  "A `session/snapshot' carrying the session's notices, as the one a Codex
turn's end sends does, redraws them as notice nodes after its nodes."
  (let ((ref '(:backend "codex" :id "t1"))
        (notice '(:kind "warning" :message "Fallback metadata" :details nil :path nil)))
    (agentpane-test--with-session ref
      (agentpane--on-notification nil 'session/notice (list :view agentpane--view :session ref :handle "h1" :notice notice))
      (agentpane--on-notification
       nil 'session/snapshot
       (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false :nodes agentpane-test--nodes
             :notices (vector notice)))
      (should (equal (agentpane-test--indices) '(0 1 nil)))
      (should (equal (ewoc-data (ewoc-nth agentpane--ewoc -1)) (list :notice notice)))
      (should (< (agentpane-test--position "Looking.")
                 (agentpane-test--position "ℹ Fallback metadata")
                 (agentpane-test--position "── prompt"))))))

(ert-deftest agentpane-test-snapshot-restores-error-and-notices ()
  "A `session/snapshot' carrying the session's turn error and notices, as
the one an attach made after they were raised does, draws both after its
nodes, the error as a warning line (OW-bipume)."
  (let ((ref '(:backend "codex" :id "t1"))
        (notice '(:kind "configWarning" :message "Unknown key" :details nil :path nil)))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/snapshot
       (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false :nodes agentpane-test--nodes
             :error "Turn failed upstream" :notices (vector notice)))
      (should (equal (agentpane-test--indices) '(0 1 nil nil)))
      (let ((error-at (agentpane-test--position "⚠ Turn failed upstream")))
        (should (eq (get-text-property error-at 'face) 'agentpane-warning))
        (should (< (agentpane-test--position "Looking.")
                   error-at
                   (agentpane-test--position "ℹ Unknown key")
                   (agentpane-test--position "── prompt"))))
      ;; A snapshot holding neither, as after the next prompt is admitted,
      ;; draws neither.
      (agentpane--on-notification
       nil 'session/snapshot
       (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false :nodes agentpane-test--nodes
             :error nil :notices []))
      (should (equal (agentpane-test--indices) '(0 1)))
      (should-not (string-search "⚠" (buffer-string))))))

(defun agentpane-test--warnings ()
  "The warning lines drawn in the current buffer, each without its `⚠ '."
  (let (lines)
    (save-excursion
      (goto-char (point-min))
      (while (re-search-forward "^⚠ \\(.*\\)$" nil t)
        (push (match-string-no-properties 1) lines)))
    (nreverse lines)))

(ert-deftest agentpane-test-error-replaces-the-held-one ()
  "A `session/error' replaces the turn error the buffer holds rather than
drawing a second line beside it, as the server and the browser each hold
one per session (OW-sedosu)."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/error (list :view agentpane--view :session ref :handle "h1" :message "Turn failed upstream"))
      (agentpane--on-notification
       nil 'session/error (list :view agentpane--view :session ref :handle "h1" :message "Turn failed again"))
      (should (equal (agentpane-test--warnings) '("Turn failed again"))))))

(ert-deftest agentpane-test-dismiss-error-names-it-to-the-server ()
  "`C-c C-d', pressed in the prompt region, dismisses the held turn error
through `sessions/dismissError', naming it by its `errorId', which is the
one the server holds after two `session/error's, the second, though both
have the same text (OW-jokoto); the buffer draws no error once it is
pressed, as the browser's banner goes (OW-desufa)."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--forking nil nil
      (agentpane-test--with-session ref
        (setq agentpane--handle "h1")
        (agentpane--on-notification
         nil 'session/error (list :view agentpane--view :session ref :handle "h1" :message "Turn failed upstream" :errorId "e3"))
        (agentpane--on-notification
         nil 'session/error (list :view agentpane--view :session ref :handle "h1" :message "Turn failed upstream" :errorId "e4"))
        (goto-char (point-max))
        (call-interactively (key-binding (kbd "C-c C-d")))
        (should (equal sent `((sessions/dismissError :session ,ref :view ,agentpane--view :errorId "e4"))))
        (should (equal (agentpane-test--indices) '(0 1)))
        (should-not (agentpane-test--warnings))))))

(ert-deftest agentpane-test-dismiss-error-names-the-one-a-snapshot-drew ()
  "`C-c C-d' names an error a snapshot drew by the `errorId' the snapshot
carried beside it (OW-jokoto)."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--forking nil nil
      (agentpane-test--with-session ref
        (agentpane--on-notification
         nil 'session/snapshot
         (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false :nodes agentpane-test--nodes
               :error "Turn failed upstream" :errorId "e6" :notices []))
        (goto-char (point-max))
        (call-interactively (key-binding (kbd "C-c C-d")))
        (should (equal sent `((sessions/dismissError :session ,ref :view ,agentpane--view :errorId "e6"))))))))

(ert-deftest agentpane-test-error-cleared-drops-its-line ()
  "A `session/errorCleared' drops the turn error's line, as the server says
it no longer holds it, leaving the draft in the prompt region alone
\(OW-jopifu)."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/error (list :view agentpane--view :session ref :handle "h1" :message "Turn failed upstream"))
      (goto-char (point-max))
      (insert "draft")
      (agentpane--on-notification nil 'session/errorCleared (list :view agentpane--view :session ref :handle "h1"))
      (should-not (agentpane-test--warnings))
      (should-not agentpane--error)
      (should (equal (agentpane-test--indices) '(0 1)))
      (should (string-suffix-p "draft" (buffer-string))))))

(ert-deftest agentpane-test-dismissed-error-redrawn-by-a-stale-snapshot-goes-at-the-clear ()
  "A snapshot the server sent before `C-c C-d''s dismissal reached it draws
the dismissed error again, and the `session/errorCleared' the dismissal
broadcasts, which follows that snapshot on the one ordered stream, takes
it down (OW-jopifu)."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--forking nil nil
      (agentpane-test--with-session ref
        (setq agentpane--handle "h1")
        (agentpane--on-notification
         nil 'session/error (list :view agentpane--view :session ref :handle "h1" :message "Turn failed upstream"))
        (goto-char (point-max))
        (call-interactively (key-binding (kbd "C-c C-d")))
        (should-not (agentpane-test--warnings))
        (agentpane--on-notification
         nil 'session/snapshot
         (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false :nodes agentpane-test--nodes
               :error "Turn failed upstream" :notices []))
        (should (equal (agentpane-test--warnings) '("Turn failed upstream")))
        (agentpane--on-notification nil 'session/errorCleared (list :view agentpane--view :session ref :handle "h1"))
        (should-not (string-search "⚠" (buffer-string)))))))

(ert-deftest agentpane-test-meta-waits-for-the-streaming-turn-to-end ()
  "While the session streams, the last node draws no meta line and an
earlier one does, and the last one's appears once a status says the
streaming ended, though no node is re-sent."
  (let ((ref '(:backend "pi" :id "s1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/snapshot
       (list :view agentpane--view :session ref :handle "h1" :isStreaming t
             :nodes (vector (agentpane-test--assistant 1 "<p>One.</p>")
                            (agentpane-test--assistant 2 "<p>Two.</p>"))))
      (should (= 1 (count-matches "^— luna" (point-min) (point-max))))
      (should (< (agentpane-test--position "— luna") (agentpane-test--position "Two.")))
      (agentpane--on-notification
       nil 'session/status (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false))
      (should (= 2 (count-matches "^— luna" (point-min) (point-max)))))))

(ert-deftest agentpane-test-appended-node-releases-the-previous-tail ()
  "A node appended while the session streams is drawn without its meta line,
and the node it follows, no longer the last, is redrawn with its own."
  (let ((ref '(:backend "pi" :id "s1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification nil 'session/status (list :view agentpane--view :session ref :handle "h1" :isStreaming t))
      (agentpane--on-notification
       nil 'session/node (list :view agentpane--view :session ref :handle "h1" :node (agentpane-test--assistant 3 "<p>Three.</p>")))
      (agentpane-test--redraw buffer)
      (should (string-search "· haiku" (buffer-string)))
      (should-not (string-search "— luna" (buffer-string)))
      (agentpane--on-notification
       nil 'session/node (list :view agentpane--view :session ref :handle "h1" :node (agentpane-test--assistant 5 "<p>Five.</p>")))
      (agentpane-test--redraw buffer)
      (should (= 1 (count-matches "^— luna" (point-min) (point-max))))
      (should (< (agentpane-test--position "Three.")
                 (agentpane-test--position "— luna")
                 (agentpane-test--position "Five."))))))

(defun agentpane-test--running-tool (index summary)
  "An assistant node at INDEX whose one part is a `Bash' call running SUMMARY
with no result yet, as the helper projects it for the streaming tail."
  (list :index index :role "assistant"
        :parts (vector (list :type "tool" :name "Bash" :summary summary
                             :args "" :result "" :state "running"))
        :meta '(:model "luna" :usage (:totalTokens 1 :cost 0))))

(ert-deftest agentpane-test-running-tool-settles-when-streaming-ends ()
  "The streaming tail's tool call with no result is drawn running, and once a
status says the streaming ended it is drawn `ok', though no node is re-sent."
  (let ((ref '(:backend "pi" :id "s1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/snapshot
       (list :view agentpane--view :session ref :handle "h1" :isStreaming t
             :nodes (vector (agentpane-test--running-tool 1 "sleep 60"))))
      (should (string-search "◔ Bash" (agentpane-test--line-at "sleep 60")))
      (agentpane--on-notification
       nil 'session/status (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false))
      (should-not (string-search "◔" (agentpane-test--line-at "sleep 60")))
      (should (string-search "✓ Bash" (agentpane-test--line-at "sleep 60"))))))

(ert-deftest agentpane-test-appended-node-settles-the-previous-running-tool ()
  "A node appended while the session streams draws the tool call with no
result on the node it follows as `ok', since that is no longer the last."
  (let ((ref '(:backend "pi" :id "s1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification nil 'session/status (list :view agentpane--view :session ref :handle "h1" :isStreaming t))
      (agentpane--on-notification
       nil 'session/node (list :view agentpane--view :session ref :handle "h1" :node (agentpane-test--running-tool 3 "sleep 60")))
      (agentpane-test--redraw buffer)
      (should (string-search "◔ Bash" (agentpane-test--line-at "sleep 60")))
      (agentpane--on-notification
       nil 'session/node (list :view agentpane--view :session ref :handle "h1" :node (agentpane-test--assistant 5 "<p>Five.</p>")))
      (agentpane-test--redraw buffer)
      (should (string-search "✓ Bash" (agentpane-test--line-at "sleep 60"))))))

(ert-deftest agentpane-test-pending-turn-keeps-its-warning ()
  "The last node of a streaming session still says it ended badly, while
the facts `showsMeta' governs stay hidden."
  (with-temp-buffer
    (agentpane-transcript-mode)
    (setq agentpane--streaming t)
    (agentpane--draw (vector (list :index 1 :role "assistant" :parts [] :timestamp agentpane-test--ms
                                   :meta '(:model "haiku" :usage (:totalTokens 5 :cost 0)
                                           :stopReason "error" :errorMessage "boom"))))
    (should (string-search "— error · boom" (buffer-string)))
    (should-not (string-search "haiku" (buffer-string)))))

(ert-deftest agentpane-test-pi-stop-during-a-tool-reads-as-aborted ()
  "A Pi Stop reads as aborted whether Pi was mid-tool or mid-reply (OW-kibabi).
As of pi 1.2.0 an abort during a `bash' call ends the call with an error
result reading Command aborted, then an empty turn with stopReason error
and errorMessage This operation was aborted, which the server sends as a
stop, stopReason aborted without the message, so the helper sends these
nodes; an abort mid-reply ends with stopReason aborted, whose message the
helper drops (docs/MANUAL_TESTING.md, OW-yewiku)."
  (agentpane-test--in-kolkata
    (with-temp-buffer
      (agentpane-transcript-mode)
      (agentpane--draw
       (vector
        (list :index 1 :role "assistant" :timestamp agentpane-test--ms
              :parts [(:type "tool" :name "bash" :summary "sleep 20; echo done" :args ""
                       :result "Command aborted" :state "error")]
              :meta '(:model "example-model" :usage (:totalTokens 52 :cost 0)))
        (list :index 3 :role "assistant" :parts [] :timestamp agentpane-test--ms
              :meta '(:model "example-model" :usage (:totalTokens 0 :cost 0)
                      :stopReason "aborted"))))
      (should (equal (substring-no-properties (agentpane-test--line-at "sleep 20"))
                     "▸ ✗ bash sleep 20; echo done · 2026-09-23 00:30:30 · example-model · 52 tok"))
      (should (memq 'agentpane-warning (agentpane-test--faces-at "✗")))
      (should (invisible-p (agentpane-test--position "Command aborted")))
      (should (equal (substring-no-properties (agentpane-test--line-at "example-model · aborted"))
                     "— 2026-09-23 00:30:30 · example-model · aborted"))
      (should (memq 'agentpane-warning (agentpane-test--faces-at "example-model · aborted")))))
  (agentpane-test--in-kolkata
    (should (equal (agentpane-test--meta-line
                    '(:model "example-model" :usage (:totalTokens 52 :cost 0) :stopReason "aborted")
                    agentpane-test--ms)
                   "— 2026-09-23 00:30:30 · example-model · 52 tok · aborted"))))

(ert-deftest agentpane-test-snapshot-under-the-handle-moves-the-ref ()
  "A `session/snapshot' under the handle a buffer holds, naming another ref,
is drawn there and moves the buffer to that ref, leaving the names of the
transcript and its composer as they were."
  (let ((from '(:backend "claude" :id "pending-1"))
        (to '(:backend "claude" :id "real-2")))
    (agentpane-test--with-session from
      (setq agentpane--handle "h1")
      (save-current-buffer (save-window-excursion (agentpane-prompt)))
      (let ((composer agentpane--composer)
            (name (buffer-name)))
        (unwind-protect
            (let ((composer-name (buffer-name composer)))
              (agentpane--on-notification
               nil 'session/snapshot
               (list :view agentpane--view :session to :handle "h1"
                     :nodes (vector (agentpane-test--assistant 4 "<p>Moved.</p>"))))
              (should (equal (agentpane-test--indices) '(4)))
              (should (agentpane--same-ref-p (agentpane--ref agentpane--session) to))
              (should (equal (buffer-name) name))
              (should (equal (buffer-name composer) composer-name)))
          (kill-buffer composer))))))

(defun agentpane-test--holders (ref)
  "The live buffers holding the session REF."
  (seq-filter (lambda (buffer)
                (let ((held (buffer-local-value 'agentpane--session buffer)))
                  (and held (agentpane--same-ref-p (agentpane--ref held) ref))))
              (buffer-list)))

(ert-deftest agentpane-test-renamed-onto-a-previewed-ref-leaves-the-live-buffer-attached ()
  "A buffer whose attach of an alias is renamed onto the ref another buffer
only previews is left beside that preview, not merged: two buffers on one
ref, deliberately, since only the live one holds the handle.  The
snapshot under the live one's view, sent before the reply, names the ref
both hold and is the live one's alone; the preview's kill detaches only
the preview's own view, and the live one stays attached and hears the
session.  Until D32 the snapshot carried the live one's attach token, and
the rest went by handle and then by ref."
  (let ((alias '(:backend "claude" :id "pending-1"))
        (canonical '(:backend "claude" :id "real-2")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (setq hold '(sessions/attach)
              attached (list :ref canonical :handle "h1"))
        (let ((live (agentpane--transcript-buffer (list :ref alias)))
              (preview (agentpane--transcript-buffer (list :ref canonical))))
          (with-current-buffer live (agentpane--attach))
          (agentpane--on-notification agentpane--connection 'session/snapshot
                                      (list :view (agentpane-test--view live)
                                            :session canonical :handle "h1" :nodes []))
          (funcall (cdr (pop held)) t)
          (should (buffer-live-p preview))
          (should-not (buffer-local-value 'agentpane--handle preview))
          (should-not (buffer-local-value 'agentpane--ewoc preview))
          (setq sent nil)
          (let ((view (agentpane-test--view preview)))
            (kill-buffer preview)
            (should (equal sent `((sessions/detach :session ,canonical :view ,view)))))
          (agentpane--on-notification
           nil 'session/node (list :view (agentpane-test--view live) :session canonical :handle "h1"
                                   :node (agentpane-test--assistant 4 "<p>Live.</p>")))
          (agentpane-test--redraw live)
          (with-current-buffer live
            (should (agentpane--attached-p))
            (should (equal (agentpane-test--indices) '(4)))))))))

(ert-deftest agentpane-test-status-under-the-handle-moves-the-ref ()
  "A notification under the handle a buffer holds that is not a snapshot,
naming another ref, moves the buffer's ref there too: the ref the helper
names the session by from then on."
  (let ((from '(:backend "claude" :id "pending-1"))
        (to '(:backend "claude" :id "real-2")))
    (agentpane-test--with-session from
      (setq agentpane--handle "h1")
      (agentpane--on-notification nil 'session/status (list :view agentpane--view :session to :handle "h1" :isStreaming t))
      (should (agentpane--same-ref-p (agentpane--ref agentpane--session) to)))))

(ert-deftest agentpane-test-listed-handle-finds-its-buffer ()
  "A listing's summary carrying the handle a buffer holds finds that buffer,
whatever ref the summary names, so no second buffer opens on the session."
  (agentpane-test--forking nil nil
    (let ((holder (agentpane--transcript-buffer
                   (list :ref '(:backend "claude" :id "real-2")))))
      (with-current-buffer holder (setq agentpane--handle "h1"))
      (should (eq (agentpane--transcript-buffer
                   (list :ref '(:backend "claude" :id "pending-1") :handle "h1"))
                  holder)))))

(ert-deftest agentpane-test-attach-answered-under-a-new-ref-draws-a-snapshot-handled-before-its-reply ()
  "An attach whose reply names another ref than the one asked for draws the
snapshot under the new ref that was handled before the reply's callback,
which the helper sends before the reply (`sessions/attach' in
src/emacs/helper.ts), and which jsonrpc.el may also run first after a
reply it held back as an anxious continuation: the snapshot under the
view of the buffer that asked finds it, and it takes the handle from it."
  (let ((asked '(:backend "claude" :id "pending-1"))
        (ref '(:backend "claude" :id "real-2")))
    (agentpane-test--forking nil nil
      (setq hold '(sessions/attach)
            attached (list :ref ref :handle "h1"))
      (let ((buffer (agentpane--transcript-buffer (list :ref asked))))
        (with-current-buffer buffer (agentpane--attach))
        (agentpane--on-notification
         nil 'session/snapshot
         (list :view (agentpane-test--view buffer) :session ref :handle "h1"
               :nodes (vector (agentpane-test--assistant 3 "<p>Live.</p>"))))
        (funcall (cdr (pop held)) t)
        (with-current-buffer buffer
          (should (equal (agentpane-test--indices) '(3)))
          (should (equal agentpane--handle "h1"))
          (should (agentpane--same-ref-p (agentpane--ref agentpane--session) ref)))
        (should (equal (agentpane-test--holders ref) (list buffer)))))))

(ert-deftest agentpane-test-attach-under-a-new-ref-holds-the-handle-its-snapshot-gave-when-the-reply-fails ()
  "An attach answered under another ref whose reply fails in Emacs -- a
timeout, or a quit in `agentpane-new-session' -- after the helper took the
attach still holds the handle and ref its snapshot gave it: it is drawn,
hears what follows under the handle, and its detach names its view,
which is what stops the helper sending for it (OW-nowihu, D32 point 1)."
  (let ((asked '(:backend "claude" :id "virtual:1"))
        (ref '(:backend "claude" :id "real-2"))
        (agentpane--connection 'connection))
    (cl-letf (((symbol-function 'jsonrpc-running-p) (lambda (_) t)))
      (agentpane-test--forking nil nil
        (setq hold '(sessions/attach)
              attached (list :ref ref :handle "h1"))
        (let ((buffer (agentpane--transcript-buffer (list :ref asked))))
          (with-current-buffer buffer (agentpane--attach))
          (agentpane--on-notification
           nil 'session/snapshot
           (list :view (agentpane-test--view buffer) :session ref :handle "h1"
                 :nodes (vector (agentpane-test--assistant 3 "<p>Live.</p>"))))
          (funcall (cdr (pop held)) nil)
          (agentpane--on-notification nil 'session/status
                                      (list :view (agentpane-test--view buffer) :session ref :handle "h1" :isStreaming t))
          (with-current-buffer buffer
            (should (equal agentpane--handle "h1"))
            (should (agentpane--same-ref-p (agentpane--ref agentpane--session) ref))
            (should (equal (agentpane-test--indices) '(3)))
            (should agentpane--streaming))
          (setq sent nil)
          (let ((view (agentpane-test--view buffer)))
            (kill-buffer buffer)
            (should (equal sent `((sessions/detach :session ,ref :view ,view))))))))))

(ert-deftest agentpane-test-attach-under-a-new-ref-hears-what-follows-its-snapshot-before-its-reply ()
  "What follows the snapshot of an attach answered under another
ref, handled before the attach's reply -- a turn ending, here -- reaches
the buffer by the handle the snapshot gave it, and the reply undoes none
of it."
  (let ((asked '(:backend "claude" :id "virtual:1"))
        (ref '(:backend "claude" :id "real-2")))
    (agentpane-test--forking nil nil
      (setq hold '(sessions/attach)
            attached (list :ref ref :handle "h1"))
      (let ((buffer (agentpane--transcript-buffer (list :ref asked))))
        (with-current-buffer buffer (agentpane--attach))
        (agentpane--on-notification
         nil 'session/snapshot
         (list :view (agentpane-test--view buffer) :session ref :handle "h1" :isStreaming t
               :nodes (vector (agentpane-test--assistant 3 "<p>Live.</p>"))))
        (agentpane--on-notification nil 'session/status
                                    (list :view (agentpane-test--view buffer) :session ref :handle "h1" :isStreaming :json-false))
        (funcall (cdr (pop held)) t)
        (with-current-buffer buffer
          (should (equal agentpane--handle "h1"))
          (should-not agentpane--streaming)
          (should (equal (agentpane-test--indices) '(3))))))))

(defmacro agentpane-test--detached (&rest body)
  "Run BODY in a transcript buffer `buffer' attached to the session `ref'
under the handle \"h1\" through a helper that counts as running, its
transcript drawn by a snapshot under that handle, streaming on the model
\"luna\", as the node at index 3, a tool call running \"sleep 60\",
after the helper has said `session/detached' for that handle: the
server's `ended' under it said it let go of it (D26).  Every request is
answered as `agentpane-test--forking' answers it."
  (declare (indent 0))
  `(let ((ref '(:backend "claude" :id "real-1")))
     (agentpane-test--with-helper
       (agentpane-test--forking nil nil
         (setq attached (list :ref ref :handle "h1"))
         (let ((buffer (agentpane--transcript-buffer (list :ref ref))))
           (with-current-buffer buffer (agentpane--attach))
           (agentpane--on-notification
            agentpane--connection 'session/snapshot
            (list :view (agentpane-test--view buffer) :session ref :handle "h1" :isStreaming t :model "luna"
                  :nodes (vector (agentpane-test--running-tool 3 "sleep 60"))))
           (agentpane--on-notification nil 'session/detached
                                       (list :view (agentpane-test--view buffer) :session ref :handle "h1"))
           (setq sent nil)
           ,@body)))))

(ert-deftest agentpane-test-detached-lets-go-of-the-handle-and-g-previews ()
  "A `session/detached' for the handle a buffer holds leaves it holding no
handle and not attached, with its ref and the transcript it drew, and
reading as not streaming, as the status that ends a turn leaves it: the
mode line names the model and no streaming, and the tail's running tool
call is drawn `ok'.  Not attached, it is a preview (D26), so a `g' then
sends `sessions/preview' for its ref, where until OW-vugefa it attached
again."
  (agentpane-test--detached
    (with-current-buffer buffer
      (should-not agentpane--handle)
      (should-not (agentpane--attached-p))
      (should (agentpane--same-ref-p (agentpane--ref agentpane--session) ref))
      (should (equal (agentpane-test--indices) '(3)))
      (should-not agentpane--streaming)
      (should (equal mode-line-process " [luna]"))
      (should (string-search "✓ Bash" (agentpane-test--line-at "sleep 60")))
      (agentpane-refetch)
      (should (equal sent `((sessions/preview :session ,ref)))))))

(ert-deftest agentpane-test-detached-buffer-takes-the-handle-its-reattach-answers-under-a-new-ref ()
  "The attach `a' sends from a buffer told its handle is gone, answered
under a new handle and a ref the buffer never heard -- a rename it missed
-- binds that buffer to the new handle by the snapshot under its view,
and the snapshot redraws it, before the reply lands and after."
  (agentpane-test--detached
    (let ((renamed '(:backend "claude" :id "real-2")))
      (setq hold '(sessions/attach)
            attached (list :ref renamed :handle "h2"))
      (with-current-buffer buffer (agentpane-attach))
      (agentpane--on-notification
       agentpane--connection 'session/snapshot
       (list :view (agentpane-test--view buffer) :session renamed :handle "h2"
             :nodes (vector (agentpane-test--assistant 5 "<p>Back.</p>"))))
      (with-current-buffer buffer
        (should (equal agentpane--handle "h2"))
        (should (agentpane--same-ref-p (agentpane--ref agentpane--session) renamed))
        (should (equal (agentpane-test--indices) '(5))))
      (funcall (cdr (pop held)) t)
      (with-current-buffer buffer
        (should (equal agentpane--handle "h2"))
        (should (agentpane--attached-p))))))

(ert-deftest agentpane-test-notification-for-a-view-no-buffer-holds-reaches-no-buffer ()
  "A notification for a view no buffer holds, one killed since the helper
sent it, reaches no buffer and makes none (D32 point 1): not one live on
the notification's ref holding no handle, nor one holding its handle
under another view, which neither draws it nor lets go, so the preview's
`g' still previews.  Until D32 a notification went by handle and then by
ref, and either buffer could take it."
  (let ((ref '(:backend "claude" :id "real-1")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (let ((live (agentpane--transcript-buffer (list :ref ref)))
              (holder (agentpane--new-transcript (list :ref ref)))
              (buffers (buffer-list))
              (gone 9999))
          (with-current-buffer live (agentpane--draw []))
          (with-current-buffer holder
            (agentpane--draw [])
            (setq agentpane--handle "h1"
                  agentpane--attached agentpane--connection))
          (should-not (agentpane--view-buffer gone))
          (dolist (notification
                   `((session/snapshot :nodes ,(vector (agentpane-test--assistant 3 "<p>Stray.</p>"))
                                       :isStreaming t)
                     (session/node :node ,(agentpane-test--assistant 4 "<p>Stray.</p>"))
                     (session/status :isStreaming t)
                     (session/error :message "Stray" :errorId "e1")
                     (session/detached)))
            (agentpane--on-notification
             agentpane--connection (car notification)
             (append (list :view gone :session ref :handle "h1") (cdr notification))))
          (agentpane-test--redraw live)
          (agentpane-test--redraw holder)
          (should-not (seq-filter (lambda (buffer) (buffer-local-value 'agentpane--session buffer))
                                  (seq-difference (buffer-list) buffers)))
          (dolist (buffer (list live holder))
            (with-current-buffer buffer
              (should-not (agentpane-test--indices))
              (should-not agentpane--status)
              (should-not agentpane--error)))
          (with-current-buffer holder
            (should (equal agentpane--handle "h1"))
            (should (agentpane--attached-p)))
          (with-current-buffer live
            (should-not agentpane--handle)
            (setq sent nil)
            (agentpane-refetch)
            (should (equal (mapcar #'car sent) '(sessions/preview)))))))))

(ert-deftest agentpane-test-attach-reply-after-its-detached-attaches-nothing ()
  "An attach whose snapshot the helper sent and then detached, a `seq' gap
having landed between that snapshot and the reply, ends with the reply
handled last, in wire order, as the helper writes them: the buffer is
not attached and holds no handle, so a `g' previews it (D26), and a
prompt sent while the attach was in flight, not marked `live', which the
helper waits to send on that attach and refuses `not_attached', leaves
the buffer free (OW-tifiva, D32 point 4).  Bound by
the reply, the buffer counted itself attached to a handle the helper
said nothing more under."
  (let ((ref '(:backend "claude" :id "real-1")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (setq hold '(sessions/attach sessions/prompt)
              attached (list :ref ref :handle "h1"))
        (let ((buffer (agentpane--transcript-buffer (list :ref ref))))
          (with-current-buffer buffer
            (agentpane--draw [])
            (agentpane-attach)
            (goto-char (point-max))
            (insert "hello")
            (agentpane-send))
          (agentpane--on-notification agentpane--connection 'session/snapshot
                                      (list :view (agentpane-test--view buffer) :session ref :handle "h1" :nodes []))
          (agentpane--on-notification agentpane--connection 'session/detached
                                      (list :view (agentpane-test--view buffer) :session ref :handle "h1"))
          (should (equal (cdr (assq 'sessions/prompt sent))
                         `(:session ,ref :view ,(agentpane-test--view buffer) :text "hello" :priorErrorId nil)))
          (funcall (cdr (pop held)) 'reply)
          (funcall (cdr (pop held)) '(:error "not_attached"))
          (with-current-buffer buffer
            (should-not (agentpane--attached-p))
            (should-not agentpane--handle)
            (should-not agentpane--sending)
            (should (equal (agentpane-test--draft) "hello")))
          (with-current-buffer buffer
            (setq sent nil)
            (agentpane-refetch)
            (should (equal (mapcar #'car sent) '(sessions/preview)))))))))

(ert-deftest agentpane-test-attach-reply-with-no-snapshot-attaches-nothing ()
  "An attach whose reply comes with no snapshot having attached the buffer
-- the helper writes one so only once no snapshot will answer the attach,
the session having gone before it came (`sessions/attach' in
src/emacs/helper.ts) -- attaches nothing: the prompt sent while it was in
flight, which the helper waits to send on it and refuses `not_attached'
\(D32 point 4), leaves the buffer free to send again, the echo area says
why, and a preview stays a preview, so `g' previews it (OW-rebawa).
Bound by the reply, the buffer counted itself attached to a session the
helper sent it nothing for."
  (let ((ref '(:backend "claude" :id "real-1")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (setq hold '(sessions/attach sessions/prompt)
              attached (list :ref ref :handle "h1"))
        (let ((buffer (agentpane--transcript-buffer (list :ref ref))))
          (with-current-buffer buffer
            (agentpane--draw [])
            (agentpane-attach)
            (goto-char (point-max))
            (insert "hello")
            (agentpane-send))
          (funcall (cdr (pop held)) 'reply)
          (funcall (cdr (pop held)) '(:error "not_attached"))
          (with-current-buffer buffer
            (should-not (agentpane--attached-p))
            (should-not agentpane--handle)
            (should-not agentpane--sending)
            (setq sent nil)
            (agentpane-refetch)
            (should (equal (mapcar #'car sent) '(sessions/preview))))
          (should (seq-some (lambda (line) (string-search "did not attach" line)) said)))))))

(ert-deftest agentpane-test-attach-refused-at-capacity-says-why ()
  "An attach the server refuses `at_capacity', D12's cap reached with
every live session busy, says the server's text in the echo area and
leaves the buffer the preview it was, attaching nothing, so it can
attach again once one is detached (ark3/agentpane#31).  Through
`agentpane--request' over a stub jsonrpc, the refusal built as
`toRpcError' in src/emacs/helper.ts builds one."
  (let ((ref '(:backend "pi" :id "/s/a.jsonl"))
        (detail (concat "at capacity: all 16 live sessions are busy (streaming, "
                        "compacting, starting, or not yet prompted); detach one and try again"))
        (calls nil)
        (buffer nil))
    (agentpane-test--with-helper
      (agentpane-test--noting
        (cl-letf (((symbol-function 'jsonrpc-async-request)
                   (lambda (_conn method _params &rest args)
                     (push (cons method args) calls)
                     (list 1 nil))))
          (unwind-protect
              (progn
                (setq buffer (agentpane--transcript-buffer (list :ref ref)))
                (with-current-buffer buffer
                  (agentpane--draw [])
                  (agentpane-attach))
                (funcall (plist-get (cdr (assq 'sessions/attach calls)) :error-fn)
                         `(:code -32000 :message ,detail
                           :data (:error "at_capacity" :detail ,detail)))
                (should (member (format "agentpane: sessions/attach failed: %s" detail) said))
                (with-current-buffer buffer
                  (should-not (agentpane--attached-p))
                  (should-not agentpane--handle)))
            (when (buffer-live-p buffer) (kill-buffer buffer))))))))

(ert-deftest agentpane-test-kill-of-a-buffer-holding-the-handle-leaves-anothers-attach-of-its-ref ()
  "A buffer holding a handle, killed while another buffer's attach of the
same ref is in flight, detaches its own view, never the other's, so the
helper gives up only its own attaches (OW-jofodu); and the snapshot
answering the other's attach, under that buffer's view, binds that
buffer, not a third only previewing the ref.  Until OW-wukako the helper
gave up every attach of the ref, the other's included, whose reply then
came with no snapshot."
  (let ((ref '(:backend "claude" :id "real-2")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (setq attached (list :ref ref :handle "h1"))
        (let ((preview (agentpane--transcript-buffer (list :ref '(:backend "claude" :id "z"))))
              (attaching (agentpane--transcript-buffer (list :ref '(:backend "claude" :id "y"))))
              (holder (agentpane--transcript-buffer (list :ref '(:backend "claude" :id "x")))))
          (with-current-buffer holder (agentpane--attach))
          (with-current-buffer preview (agentpane--hold-ref ref))
          (with-current-buffer attaching
            (agentpane--hold-ref ref)
            (setq hold '(sessions/attach))
            (agentpane--attach))
          (let ((view (agentpane-test--view holder)))
            (setq sent nil)
            (kill-buffer holder)
            (should (equal sent `((sessions/detach :session ,ref :view ,view)))))
          (funcall (cdr (pop held)) t)
          (with-current-buffer attaching
            (should (agentpane--attached-p))
            (should (equal agentpane--handle "h1")))
          (should-not (buffer-local-value 'agentpane--handle preview))
          (agentpane--on-notification
           nil 'session/node (list :view (agentpane-test--view attaching) :session ref :handle "h1"
                                   :node (agentpane-test--assistant 4 "<p>Live.</p>")))
          (agentpane-test--redraw attaching)
          (with-current-buffer attaching
            (should (memq 4 (agentpane-test--indices)))))))))

(defmacro agentpane-test--held-elsewhere (&rest body)
  "Run BODY with a transcript buffer `holder' holding the session under the
handle \"h1\" at a ref it has since left for `canonical', and a buffer
`previewing' holding it at the ref `alias' and no handle, whose attach the
helper answers with the session's summary under that handle, and every
request answered as `agentpane-test--forking' answers it.  BODY sends
the attach.  The helper binds no handle to two views (D32 point 2), so
the attach binds nothing for `previewing', and its reply names
`holder''s view."
  (declare (indent 0))
  `(let ((canonical '(:backend "claude" :id "real-2"))
         (alias '(:backend "claude" :id "pending-1")))
     (agentpane-test--forking nil nil
       (setq attached (list :ref canonical :handle "h1"))
       (let ((holder (agentpane--transcript-buffer
                      (list :ref '(:backend "claude" :id "real-1") :cwd "/tmp/x/sandbox")))
             (previewing (agentpane--transcript-buffer
                          (list :ref alias :cwd "/tmp/x/sandbox"))))
         (with-current-buffer holder
           (setq agentpane--handle "h1"
                 agentpane--attached agentpane--connection))
         ,@body))))

(ert-deftest agentpane-test-attach-onto-a-held-handle-shows-its-holder ()
  "An attach from a buffer that lands on the handle another buffer holds
binds nothing for it, and its reply names the other's view (D32 point
2): the other buffer, which hears the session under the handle, is shown
in this one's window, the echo area naming it, and this one stays a
preview, its draft in place, its waiters failing.  No buffer is killed,
none merges, and nothing more is sent."
  (agentpane-test--with-helper
    (agentpane-test--held-elsewhere
      (delete-other-windows)
      (switch-to-buffer previewing)
      (with-current-buffer previewing
        (agentpane--set-draft "my draft"))
      (let ((failed nil))
        (with-current-buffer previewing
          (agentpane--attach nil (lambda () (setq failed t))))
        (should failed))
      (should (buffer-live-p holder))
      (should (buffer-live-p previewing))
      (should (equal sent `((sessions/attach :session ,alias
                                             :view ,(buffer-local-value 'agentpane--view previewing)))))
      (should (eq (window-buffer (selected-window)) holder))
      (should (member (format "agentpane: this session is open in %s; %s stays a preview"
                              (buffer-name holder) (buffer-name previewing))
                      said))
      (with-current-buffer previewing
        (should-not (agentpane--attached-p))
        (should-not agentpane--handle)
        (should (equal (agentpane-test--draft) "my draft")))
      (with-current-buffer holder
        (should (agentpane--attached-p))
        (should (equal (agentpane-test--indices) '(0 1)))))))

(ert-deftest agentpane-test-attach-onto-a-held-handle-whose-holder-died-says-so ()
  "An attach whose reply names a view whose buffer has been killed since
leaves this buffer a preview, shown where it was, and says so (D32
point 2)."
  (agentpane-test--with-helper
    (agentpane-test--held-elsewhere
      (delete-other-windows)
      (switch-to-buffer previewing)
      ;; The reply alone, carrying the view, as the helper sends it.
      (setq hold '(sessions/attach)
            attached (list :view (buffer-local-value 'agentpane--view holder)
                           :ref canonical :handle "h1"))
      (with-current-buffer previewing (agentpane--attach))
      (kill-buffer holder)
      (funcall (cdr (pop held)) 'reply)
      (should (eq (window-buffer (selected-window)) previewing))
      (should (member (format "agentpane: this session is open in a buffer killed since; %s stays a preview"
                              (buffer-name previewing))
                      said))
      (with-current-buffer previewing
        (should-not (agentpane--attached-p))))))

(ert-deftest agentpane-test-detached-send-onto-a-held-handle-shows-its-holder ()
  "A prompt from a buffer only previewing its session, sent by ref, that
lands on the handle another buffer holds binds nothing for this one, and
its reply names the other's view (D32 point 2): the text counts as sent
here, clearing it, and the other buffer is shown in this one's window;
the helper arms the turn-done watch on the handle the other holds (D32
point 6).  This one stays a preview, free to send again."
  (progn
    (agentpane-test--with-helper
      (agentpane-test--held-elsewhere
        (delete-other-windows)
        (switch-to-buffer previewing)
        (with-current-buffer previewing
          (agentpane--draw [])
          (goto-char (point-max))
          (insert "hello")
          (agentpane-send))
        (should (equal sent `((sessions/prompt :session ,alias
                                               :view ,(agentpane-test--view previewing)
                                               :text "hello" :priorErrorId nil))))
        (should (eq (window-buffer (selected-window)) holder))
        (should (member (format "agentpane: this session is open in %s; %s stays a preview"
                                (buffer-name holder) (buffer-name previewing))
                        said))
        (with-current-buffer previewing
          (should-not (agentpane--attached-p))
          (should-not agentpane--handle)
          (should-not agentpane--sending)
          (should (equal (agentpane-test--draft) "")))))))

(ert-deftest agentpane-test-attach-now-onto-a-held-handle-shows-its-holder-and-signals ()
  "A synchronous attach whose reply names another view shows that view's
buffer in this one's window and signals, naming it, running nothing in
it and sending nothing more (D32 point 2)."
  (agentpane-test--with-helper
    (agentpane-test--held-elsewhere
      (delete-other-windows)
      (switch-to-buffer previewing)
      (cl-letf (((symbol-function 'jsonrpc-request)
                 (lambda (&rest _)
                   (append (list :view (buffer-local-value 'agentpane--view holder)) attached))))
        (with-current-buffer previewing
          (should (equal (cadr (should-error (agentpane--attach-now) :type 'user-error))
                         (format "This session is open in %s" (buffer-name holder))))
          (should-not (agentpane--attached-p))))
      (should (eq (window-buffer (selected-window)) holder))
      (should-not sent))))

(ert-deftest agentpane-test-attach-now-with-no-snapshot-signals ()
  "A synchronous attach whose reply comes with no snapshot having attached
the buffer -- which the helper sends only once it expects none
\(`sessions/attach' in src/emacs/helper.ts) -- signals, and leaves the
buffer unattached, so `agentpane-new-session' and the model and effort
pickers read nothing from a session this buffer does not hold (OW-rebawa)."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (cl-letf (((symbol-function 'jsonrpc-request)
                 (lambda (&rest _) (list :ref ref :handle "h1"))))
        (agentpane-test--with-session ref
          (should (equal (cadr (should-error (agentpane--attach-now) :type 'user-error))
                         "The attach answered, but the session did not attach"))
          (should-not (agentpane--attached-p))
          (should-not agentpane--handle))))))

(ert-deftest agentpane-test-snapshot-keeps-window-start ()
  "A `session/snapshot' leaves the start of a window following the tail the
same distance from the end, and that of any other window where it was."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (save-window-excursion
        (let ((window (selected-window))
              (snapshot (lambda (nodes)
                          (agentpane--on-notification
                           nil 'session/snapshot (list :view agentpane--view :session ref :handle "h1" :nodes nodes)))))
          (set-window-buffer window (current-buffer))
          (set-window-point window (point-max))
          (set-window-start window (agentpane-test--position "Edit app.ts") t)
          (let ((from-end (- (point-max) (window-start window))))
            ;; One node more, so its start keeping its position would differ.
            (funcall snapshot (vconcat agentpane-test--nodes
                                       (list (agentpane-test--assistant 2 "<p>More.</p>"))))
            (should (= (window-point window) (point-max)))
            (should (= (window-start window) (- (point-max) from-end))))
          (let ((start (agentpane-test--position "Looking.")))
            (set-window-point window (agentpane-test--position "Read app.ts"))
            (set-window-start window start t)
            (funcall snapshot agentpane-test--nodes)
            (should (= (window-start window) start))))))))

(defun agentpane-test--attach-snapshot (ref &rest fields)
  "Deliver, through `agentpane--connection', the `session/snapshot' under
the current buffer's view and the handle \"h1\" that attaches it while it
waits on an attach of REF, drawing no nodes, with FIELDS ahead of its
params, so that a `:view' among them names another buffer's: what the
helper sends before the attach's reply."
  (agentpane--on-notification
   agentpane--connection 'session/snapshot
   (append fields (list :view agentpane--view :session ref :handle "h1" :nodes []))))

(ert-deftest agentpane-test-set-model-only-before-the-first-prompt ()
  "`agentpane-set-model' on a buffer with nodes signals the gate's error and
sends nothing; on a buffer with none it attaches, synchronously, and sends
`sessions/setModel'."
  (let ((ref '(:backend "codex" :id "t1"))
        (agentpane--connection 'connection)
        (sent nil))
    (cl-letf (((symbol-function 'jsonrpc-running-p) (lambda (_) t))
              ((symbol-function 'agentpane--request)
               (agentpane-test--refusing
               (lambda (method _params callback &rest _)
                 (push method sent)
                 (funcall callback (list :ref ref)))))
              ((symbol-function 'jsonrpc-async-request)
               (lambda (&rest _) (push 'jsonrpc-async-request sent)))
              ((symbol-function 'jsonrpc-request)
               (lambda (_connection method &rest _)
                 (push method sent)
                 (when (eq method 'sessions/attach) (agentpane-test--attach-snapshot ref))
                 (list :ref ref))))
      (agentpane-test--with-session ref
        (should (equal (cadr (should-error (agentpane-set-model "gpt-5.6-luna")
                                           :type 'user-error))
                       "The model is chosen before the first prompt"))
        (should-not sent)
        (agentpane--draw [])
        (agentpane-set-model "gpt-5.6-luna")
        (should (equal (reverse sent) '(sessions/attach sessions/setModel)))))))

(defun agentpane-test--set-model-interactively (choice)
  "Call `agentpane-set-model' interactively on an empty, unattached buffer
whose model prompt answers CHOICE, and return the methods sent, in order."
  (let ((ref '(:backend "codex" :id "t1"))
        (agentpane--connection 'connection)
        (sent nil))
    (cl-letf (((symbol-function 'agentpane--connection) (lambda () 'connection))
              ((symbol-function 'jsonrpc-running-p) (lambda (_) t))
              ((symbol-function 'agentpane--request)
               (agentpane-test--refusing
               (lambda (method _params callback &rest _)
                 (push method sent)
                 (funcall callback (list :ref ref)))))
              ((symbol-function 'jsonrpc-request)
               (lambda (_connection method &rest _)
                 (push method sent)
                 (pcase method
                   ('sessions/attach (agentpane-test--attach-snapshot ref) (list :ref ref))
                   ('models/list [(:id "gpt-5.6-luna")]))))
              ((symbol-function 'completing-read) (lambda (&rest _) choice)))
      (agentpane-test--with-session ref
        (agentpane--draw [])
        (call-interactively #'agentpane-set-model)
        ;; Before the kill, whose detach would join them.
        (reverse sent)))))

(ert-deftest agentpane-test-set-model-attaches-before-listing-models ()
  "`M-x agentpane-set-model' on an unattached session attaches it before it
reads `models/list', which the server answers for Codex or Pi only from a
live adapter, and then sets the model without attaching again."
  (should (equal (agentpane-test--set-model-interactively "gpt-5.6-luna")
                 '(sessions/attach models/list sessions/setModel))))

(ert-deftest agentpane-test-set-model-empty-choice-sets-nothing ()
  "An empty `RET' at the model prompt, which `completing-read' returns as
\"\" even when it requires a match, sends no `sessions/setModel'."
  (should (equal (agentpane-test--set-model-interactively "")
                 '(sessions/attach models/list))))

(defconst agentpane-test--models
  [(:id "gpt-5.6-luna" :efforts [(:id "low" :description "Fast") (:id "high" :description "Deep")]
    :defaultEffort "low")
   (:id "gpt-5.6-sol" :efforts [(:id "medium" :description "Even")] :defaultEffort "medium")
   (:id "plain" :efforts [] :defaultEffort nil)]
  "A `models/list' answer: two models offering different efforts, and one
offering none.")

(ert-deftest agentpane-test-set-effort-only-before-the-first-prompt ()
  "`agentpane-set-effort' on a buffer with nodes, called or interactively,
signals the gate's error, naming the effort, and sends nothing; on a buffer
with none it attaches, synchronously, and sends `sessions/setEffort'."
  (let ((ref '(:backend "codex" :id "t1"))
        (agentpane--connection 'connection)
        (sent nil))
    (cl-letf (((symbol-function 'jsonrpc-running-p) (lambda (_) t))
              ((symbol-function 'agentpane--request)
               (agentpane-test--refusing
               (lambda (method _params callback &rest _)
                 (push method sent)
                 (funcall callback (list :ref ref)))))
              ((symbol-function 'jsonrpc-async-request)
               (lambda (&rest _) (push 'jsonrpc-async-request sent)))
              ((symbol-function 'jsonrpc-request)
               (lambda (_connection method &rest _)
                 (push method sent)
                 (when (eq method 'sessions/attach) (agentpane-test--attach-snapshot ref))
                 (list :ref ref))))
      (agentpane-test--with-session ref
        (dolist (call (list (lambda () (agentpane-set-effort "high"))
                            (lambda () (call-interactively #'agentpane-set-effort))))
          (should (equal (cadr (should-error (funcall call) :type 'user-error))
                         "The effort is chosen before the first prompt")))
        (should-not sent)
        (agentpane--draw [])
        (agentpane-set-effort "high")
        (should (equal (reverse sent) '(sessions/attach sessions/setEffort)))))))

(ert-deftest agentpane-test-gate-reads-system-nodes-alone-as-unprompted ()
  "A buffer holding only a system node, as a Pi fork at the first user
message does (OW-widozi), is not yet prompted: `agentpane--check-gate'
refuses neither the model nor the effort.  Once any other node is drawn
beside it, both are refused."
  (let ((system '(:index 0 :role "system"
                  :parts [(:type "system" :summary "System prompt · 5 sections · 4 tools" :body "")])))
    (agentpane-test--with-session '(:backend "pi" :id "p1")
      (agentpane--draw (vector system))
      (agentpane--check-gate "model")
      (agentpane--check-gate "effort")
      (agentpane--draw
       (vector system '(:index 1 :role "user"
                        :parts [(:type "text" :text "Fix the bug" :html "<p>Fix the bug</p>\n")])))
      (should-error (agentpane--check-gate "model") :type 'user-error)
      (should-error (agentpane--check-gate "effort") :type 'user-error))))

(defun agentpane-test--set-effort-interactively (model choice)
  "Call `agentpane-set-effort' interactively on an empty, unattached buffer
whose last status named MODEL, of `agentpane-test--models', and whose
effort prompt answers CHOICE.  Return the methods sent, in order, then the
collections offered, then the user error signalled, if any."
  (let ((ref '(:backend "codex" :id "t1"))
        (agentpane--connection 'connection)
        (sent nil)
        (offered nil)
        (refused nil))
    (cl-letf (((symbol-function 'agentpane--connection) (lambda () 'connection))
              ((symbol-function 'jsonrpc-running-p) (lambda (_) t))
              ((symbol-function 'agentpane--request)
               (agentpane-test--refusing
               (lambda (method _params callback &rest _)
                 (push method sent)
                 (funcall callback (list :ref ref)))))
              ((symbol-function 'jsonrpc-request)
               (lambda (_connection method &rest _)
                 (push method sent)
                 (pcase method
                   ('sessions/attach
                    (agentpane-test--attach-snapshot ref :isStreaming :json-false :model model)
                    (list :ref ref))
                   ('models/list agentpane-test--models))))
              ((symbol-function 'completing-read)
               (lambda (_prompt collection &rest _)
                 (push collection offered)
                 choice)))
      (agentpane-test--with-session ref
        (agentpane--draw [])
        (agentpane--set-status (list :session ref :isStreaming :json-false :model model))
        (condition-case err
            (call-interactively #'agentpane-set-effort)
          (user-error (setq refused (cadr err))))
        ;; Before the kill, whose detach would join them.
        (list (reverse sent) (reverse offered) refused)))))

(ert-deftest agentpane-test-set-effort-offers-the-models-efforts ()
  "`M-x agentpane-set-effort' attaches, reads `models/list', offers the
efforts of the model the session's last status named and no other's, and
sets the one chosen."
  (should (equal (agentpane-test--set-effort-interactively "gpt-5.6-luna" "high")
                 '((sessions/attach models/list sessions/setEffort) (("low" "high")) nil))))

(ert-deftest agentpane-test-set-effort-empty-choice-sets-nothing ()
  "An empty `RET' at the effort prompt sends no `sessions/setEffort', for
the reason an empty model choice sends no `sessions/setModel'."
  (should (equal (agentpane-test--set-effort-interactively "gpt-5.6-luna" "")
                 '((sessions/attach models/list) (("low" "high")) nil))))

(ert-deftest agentpane-test-set-effort-without-options-prompts-for-nothing ()
  "`M-x agentpane-set-effort' on a session whose model offers no effort, or
whose model is not known, prompts for nothing, sends no
`sessions/setEffort', and says why."
  (should (equal (agentpane-test--set-effort-interactively "plain" "low")
                 '((sessions/attach models/list) nil
                   "The model offers no effort to choose")))
  (should (equal (agentpane-test--set-effort-interactively nil "low")
                 '((sessions/attach) nil
                   "No model is known yet for this session; try again once one is"))))

(ert-deftest agentpane-test-mode-line-names-the-reported-effort ()
  "A status that reports an effort names it in the mode line right after the
model, so a choice made with `agentpane-set-effort' shows before the first
turn; one whose effort and `defaultEffort' are both null names none."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (agentpane--draw [])
      (agentpane--set-status
       (list :session ref :isStreaming :json-false :model "gpt-5.6-luna" :effort "high"))
      (should (equal mode-line-process " [gpt-5.6-luna · high]"))
      (agentpane--set-status
       (list :session ref :isStreaming :json-false :model "gpt-5.6-luna" :effort nil))
      (should (equal mode-line-process " [gpt-5.6-luna]")))))

(ert-deftest agentpane-test-mode-line-names-the-unrestored-model ()
  "A status whose `unrestoredModel' names a model says beside the model in
force that the recorded one was not restored, before any turn; one whose
`unrestoredModel' is null shows nothing new (OW-firaja)."
  (let ((ref '(:backend "pi" :id "s1")))
    (agentpane-test--with-session ref
      (agentpane--draw [])
      (agentpane--set-status
       (list :session ref :isStreaming :json-false :model "deepseek-v4.1-flash"
             :effort "high" :unrestoredModel "claude-sonnet"))
      (should (equal mode-line-process
                     " [deepseek-v4.1-flash (claude-sonnet not restored) · high]"))
      (agentpane--set-status
       (list :session ref :isStreaming :json-false :model "deepseek-v4.1-flash"
             :effort "high" :unrestoredModel nil))
      (should (equal mode-line-process " [deepseek-v4.1-flash · high]")))))

(ert-deftest agentpane-test-mode-line-falls-back-to-the-default-effort ()
  "A status whose effort is null names its `defaultEffort', the model's
from the helper's `models/list', in the mode line, as the browser's
effort select does, and one that reports an effort names that instead
\(D32 point 8)."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (agentpane--draw [])
      (agentpane--set-status
       (list :session ref :isStreaming :json-false :model "gpt-5.6-luna"
             :effort nil :defaultEffort "low"))
      (should (equal mode-line-process " [gpt-5.6-luna · low]"))
      (agentpane--set-status
       (list :session ref :isStreaming :json-false :model "gpt-5.6-luna"
             :effort "high" :defaultEffort "low"))
      (should (equal mode-line-process " [gpt-5.6-luna · high]"))
      (agentpane--set-status
       (list :session ref :isStreaming t :model "gpt-5.6-luna"
             :effort nil :defaultEffort "low"))
      (should (equal mode-line-process " [streaming · gpt-5.6-luna · low]")))))

(ert-deftest agentpane-test-undo-in-prompt-leaves-nodes-alone ()
  "Undo in the prompt region undoes the draft, never a node redraw that
arrived while it was being typed."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (buffer-enable-undo)
      (goto-char (point-max))
      (insert "hello")
      (undo-boundary)
      (agentpane--on-notification
       nil 'session/node
       (list :view agentpane--view :session ref :handle "h1" :node (agentpane-test--assistant 1 "<p>Streaming more.</p>")))
      (agentpane-test--redraw buffer)
      (undo-boundary)
      (let ((last-command nil)) (undo))
      (should (string-search "Streaming more." (buffer-string)))
      (should-not (string-search "Looking." (buffer-string)))
      (should-not (string-search "hello" (buffer-string))))))

(defun agentpane-test--command (command)
  "Run COMMAND as the command loop would, after an undo boundary."
  (let ((this-command command))
    (undo-boundary)
    (call-interactively command)
    (setq last-command this-command)))

(ert-deftest agentpane-test-undo-chain-survives-a-redraw ()
  "Consecutive undo keeps walking back, and `undo-redo' still redoes, across
a node redraw that changed the buffer's size between the presses."
  (let ((ref '(:backend "codex" :id "t1"))
        (grow (lambda (text)
                (agentpane--on-notification
                 nil 'session/node
                 (list :view agentpane--view :session '(:backend "codex" :id "t1") :handle "h1"
                       :node (agentpane-test--assistant 1 text)))
                (agentpane-test--redraw (current-buffer)))))
    (agentpane-test--with-session ref
      (buffer-enable-undo)
      (setq last-command nil)
      (goto-char (point-max))
      (insert "hello ")
      (undo-boundary)
      (insert "world")
      (agentpane-test--command 'undo)
      (funcall grow "<p>Streaming a good deal more text than before.</p>")
      (agentpane-test--command 'undo)
      (should (equal (buffer-substring-no-properties agentpane--prompt-start (point-max)) ""))
      (funcall grow "<p>Shorter.</p>")
      (setq last-command 'ignore)
      (agentpane-test--command 'undo-redo)
      (should (equal (buffer-substring-no-properties agentpane--prompt-start (point-max))
                     "hello ")))))

(ert-deftest agentpane-test-undo-in-region-survives-a-redraw ()
  "A run of undo in region in the prompt region keeps undoing the draft, and
leaves the nodes alone, across a node redraw that grew between the presses.
Undo inhibits read-only, so a stale position edits a node's text."
  (let ((ref '(:backend "codex" :id "t1"))
        (transient-mark-mode t))
    (agentpane-test--with-session ref
      (save-window-excursion
        (set-window-buffer (selected-window) (current-buffer))
        (buffer-enable-undo)
        (setq last-command nil)
        (goto-char (point-max))
        (let ((draft (point)))
          (insert "aa ")
          (undo-boundary)
          (insert "bb ")
          (undo-boundary)
          (insert "cc")
          (push-mark draft t t))
        (agentpane-test--command 'undo)
        (agentpane--on-notification
         nil 'session/node
         (list :view agentpane--view :session ref :handle "h1"
               :node (agentpane-test--assistant
                      1 (concat "<p>" (string-join (make-list 40 "streaming") " ") "</p>"))))
        (agentpane-test--redraw buffer)
        (let ((nodes (buffer-substring-no-properties (point-min) agentpane--prompt-start)))
          (agentpane-test--command 'undo)
          (should (equal (buffer-substring-no-properties (point-min) agentpane--prompt-start)
                         nodes))
          (should (equal (buffer-substring-no-properties agentpane--prompt-start (point-max))
                         "aa ")))))))

(ert-deftest agentpane-test-redraw-leaves-another-buffers-undo-alone ()
  "A node redraw that changes size leaves alone a run of undo in region in
another buffer, since `pending-undo-list' is global."
  (let ((ref '(:backend "codex" :id "t1"))
        (transient-mark-mode t)
        (notes (generate-new-buffer " *agentpane-test notes*")))
    (unwind-protect
        (agentpane-test--with-session ref
          (save-window-excursion
            (set-window-buffer (selected-window) notes)
            (with-current-buffer notes
              (buffer-enable-undo)
              (setq last-command nil)
              (insert "aa ")
              (undo-boundary)
              (insert "bb ")
              (undo-boundary)
              (insert "cc")
              (push-mark (point-min) t t)
              (agentpane-test--command 'undo))
            (agentpane--on-notification
             nil 'session/node
             (list :view agentpane--view :session ref :handle "h1" :node (agentpane-test--assistant 1 "<p>Redrawn.</p>")))
            (agentpane-test--redraw buffer)
            (with-current-buffer notes
              (agentpane-test--command 'undo)
              (should (equal (buffer-string) "aa ")))))
      (kill-buffer notes))))

(ert-deftest agentpane-test-undo-past-the-draft-keeps-the-prompt ()
  "Undo past everything typed leaves the separator, and the prompt region
still takes typing."
  (agentpane-test--with-session '(:backend "codex" :id "t1")
    (setq last-command nil)
    (goto-char (point-max))
    (insert "a")
    (agentpane-test--command 'undo)
    (ignore-errors (agentpane-test--command 'undo))
    (should (string-search "── prompt" (buffer-string)))
    (goto-char (point-max))
    (insert "b")
    (should (equal (buffer-substring-no-properties agentpane--prompt-start (point-max)) "b"))))

(ert-deftest agentpane-test-typed-prompt-is-not-dim ()
  "Text typed into the prompt region does not inherit the separator's face."
  (agentpane-test--with-session '(:backend "codex" :id "t1")
    (goto-char (point-max))
    (let ((last-command-event ?h)) (self-insert-command 1))
    (should-not (get-text-property (1- (point-max)) 'face))))

;;;; Reading view

(defconst agentpane-test--chrome-nodes
  [(:index 0 :role "user"
    :parts [(:type "text" :text "Fix the bug" :html "<p>Fix the bug</p>\n")])
   (:index 1 :role "assistant"
    :parts [(:type "text" :text "Looking." :html "<p>Looking.</p>\n")
            (:type "thinking" :text "Weighing it\nand more besides" :redacted :json-false)
            (:type "tool" :name "Read" :summary "app.ts" :args "" :result "const x = 1;"
             :state "ok")]
    :meta (:model "haiku" :usage (:totalTokens 12 :cost 0)))
   (:index 2 :role "tool-result"
    :parts [(:type "tool" :name "Grep" :summary "orphan" :args "" :result "hit" :state "ok")])
   (:index 3 :role "assistant"
    :parts [(:type "tool" :name "Bash" :summary "ls -la" :args "" :result "." :state "ok")]
    :meta (:model "luna" :usage (:totalTokens 3 :cost 0)))
   (:index 4 :role "assistant" :parts []
    :meta (:model "" :usage (:totalTokens 0 :cost 0) :stopReason "aborted"))
   (:index 5 :role "assistant"
    :parts [(:type "text" :text "All done." :html "<p>All done.</p>\n")]
    :meta (:model "haiku" :usage (:totalTokens 7 :cost 0)))
   (:index 6 :role "assistant"
    :parts [(:type "thinking" :text "Tail thought" :redacted :json-false)]
    :meta (:model "luna" :usage (:totalTokens 2 :cost 0)))]
  "A transcript with tool chrome to elide: a turn mixing text, thinking and
a tool; an orphan tool result; a turn that is only a tool call; an aborted
turn with no parts; a turn of text; and a last turn that is only thinking.")

(defmacro agentpane-test--with-chrome (&rest body)
  "Run BODY in a fresh transcript buffer drawn with the chrome nodes."
  (declare (indent 0))
  `(with-temp-buffer
     (agentpane-transcript-mode)
     (agentpane--draw agentpane-test--chrome-nodes)
     ,@body))

(defun agentpane-test--press-r ()
  "Run whatever `r' is bound to in the transcript keymap, as a command."
  (call-interactively (lookup-key agentpane-transcript-mode-map "r")))

(defconst agentpane-test--chrome-lines
  '("Read app.ts" "Thinking Weighing it" "Grep orphan" "Bash ls -la" "Thinking Tail thought")
  "The summary lines of every tool call, tool result and thinking part in the
chrome nodes.")

(ert-deftest agentpane-test-reading-view-is-per-buffer ()
  "`r' turns reading view on in its own transcript buffer and in no other,
and the mode line says so there."
  (let ((one (generate-new-buffer " *agentpane-test one*"))
        (two (generate-new-buffer " *agentpane-test two*")))
    (unwind-protect
        (progn
          (dolist (buffer (list one two))
            (with-current-buffer buffer
              (agentpane-transcript-mode)
              (agentpane--draw agentpane-test--chrome-nodes)))
          (with-current-buffer one (agentpane-test--press-r))
          (with-current-buffer one
            (should agentpane--reading)
            (should (string-search "reading" (or mode-line-process ""))))
          (with-current-buffer two
            (should-not agentpane--reading)
            (should-not (string-search "reading" (or mode-line-process "")))
            (should (string-search "Read app.ts" (buffer-string)))))
      (kill-buffer one)
      (kill-buffer two))))

(ert-deftest agentpane-test-reading-view-elides-tool-chrome ()
  "With reading view on, no tool call, tool result or thinking part is drawn
while the user and assistant text remain; toggled off, they are back."
  (agentpane-test--with-chrome
    (agentpane-test--press-r)
    (dolist (line agentpane-test--chrome-lines)
      (should-not (string-search line (buffer-string))))
    (dolist (text '("Fix the bug" "Looking." "All done." "— haiku · 12 tok"))
      (should (string-search text (buffer-string))))
    (agentpane-test--press-r)
    (dolist (line agentpane-test--chrome-lines)
      (should (string-search line (buffer-string))))))

(ert-deftest agentpane-test-reading-view-drops-empty-turns-but-not-banners ()
  "With reading view on, a turn that was only a tool call or only thinking
draws nothing, its meta line included, while an aborted turn with no parts
keeps its warning."
  (agentpane-test--with-chrome
    (agentpane-test--press-r)
    (should-not (string-search "luna" (buffer-string)))
    (should (string-search "— aborted" (buffer-string)))))

(ert-deftest agentpane-test-reading-view-keeps-indices-and-navigation ()
  "With reading view on, the node at point after an elided one answers its
own index, `n' and `p' step over elided nodes both ways, and a point below
an elided last node answers the last one drawn."
  (agentpane-test--with-chrome
    (agentpane-test--press-r)
    (goto-char (agentpane-test--position "— aborted"))
    (should (eql (agentpane-index-at-point) 4))
    (agentpane-test--goto-index 1)
    (agentpane-next)
    (should (eql (agentpane-index-at-point) 4))
    (agentpane-prev)
    (should (eql (agentpane-index-at-point) 1))
    (goto-char (point-max))
    (should (eql (agentpane-index-at-point) 5))
    (agentpane-prev)
    (should (eql (agentpane-index-at-point) 5))
    (agentpane-prev)
    (should (eql (agentpane-index-at-point) 4))))

(ert-deftest agentpane-test-reading-view-keeps-folds ()
  "A fold expanded before reading view is toggled on and off again is still
expanded, on the same part, and its neighbour still folded."
  (agentpane-test--with-chrome
    (goto-char (agentpane-test--position "Read app.ts"))
    (agentpane-toggle)
    (should-not (invisible-p (agentpane-test--position "const x = 1;")))
    (agentpane-test--press-r)
    (agentpane-test--press-r)
    (should-not (invisible-p (agentpane-test--position "const x = 1;")))
    (should (invisible-p (agentpane-test--position "and more besides")))))

(ert-deftest agentpane-test-reading-view-meta-after-surviving-text ()
  "With reading view on, a step whose last part is a tool call draws its
surviving text, then its meta on a line of its own after that text, since
the tool header that would carry it is not drawn."
  (with-temp-buffer
    (agentpane-transcript-mode)
    (agentpane--draw
     (vector (list :index 1 :role "assistant" :meta agentpane-test--step-meta
                   :parts (vector '(:type "text" :text "Checking." :html "<p>Checking.</p>\n")
                                  (agentpane-test--tool "rg -n one" "a")))))
    (agentpane-test--press-r)
    (should-not (string-search "rg -n one" (buffer-string)))
    (should (string-prefix-p "— " (agentpane-test--line-at "claude-opus-5")))
    (should (< (agentpane-test--position "Checking.")
               (agentpane-test--position "claude-opus-5")))))

(defconst agentpane-test--hiding-line
  "Reading view is hiding this session's tool activity and thinking.\n"
  "The line reading view shows in place of a session whose every node it elides.")

(defconst agentpane-test--handled-line
  "The agent handled that prompt itself; no turn was started for it.\n"
  "The line a transcript shows once the backend handled its last prompt.")

(defun agentpane-test--above-prompt ()
  "The overlay string shown in the current buffer, without properties, or nil."
  (let ((shown (seq-some (lambda (overlay) (overlay-get overlay 'before-string))
                         (overlays-in (point-min) (point-max)))))
    (and shown (substring-no-properties shown))))

(defun agentpane-test--tail-status ()
  "The reading-view tail status line shown in the current buffer, or nil.
Not `agentpane-test--hiding-line', nor `agentpane-test--handled-line',
which the same overlay may carry after it."
  (let ((shown (string-remove-suffix agentpane-test--handled-line
                                     (or (agentpane-test--above-prompt) ""))))
    (and (not (member shown (list "" agentpane-test--hiding-line))) shown)))

(defun agentpane-test--hiding-p ()
  "Non-nil when the current buffer shows `agentpane-test--hiding-line'."
  (equal (agentpane-test--above-prompt) agentpane-test--hiding-line))

(ert-deftest agentpane-test-reading-view-names-the-running-tool ()
  "With reading view on and the session streaming, a line above the prompt
names the last turn's running tool; it follows the node updates, and goes
once the turn's text arrives or the streaming ends."
  (let ((ref '(:backend "claude" :id "c1"))
        (running (lambda (name summary)
                   (list :index 1 :role "assistant"
                         :parts (vector '(:type "text" :text "Checking." :html "<p>Checking.</p>")
                                        (list :type "tool" :name name :summary summary
                                              :args "" :result "" :state "running"))
                         :meta '(:model "haiku" :usage (:totalTokens 0 :cost 0))))))
    (agentpane-test--with-session ref
      (agentpane-test--press-r)
      (agentpane--on-notification
       nil 'session/snapshot
       (list :view agentpane--view :session ref :handle "h1" :isStreaming t
             :nodes (vector (aref agentpane-test--nodes 0) (funcall running "Bash" "bun test"))))
      (should (equal (agentpane-test--tail-status) "Bash bun test … running\n"))
      ;; The line a handled prompt holds follows the tail, nearest the
      ;; prompt, and takes nothing from it (OW-taviju).
      (agentpane--hold-handled t)
      (should (equal (agentpane-test--above-prompt)
                     (concat "Bash bun test … running\n" agentpane-test--handled-line)))
      (should (equal (agentpane-test--tail-status) "Bash bun test … running\n"))
      (agentpane--hold-handled nil)
      (agentpane--on-notification
       nil 'session/node (list :view agentpane--view :session ref :handle "h1" :node (funcall running "Read" "app.ts")))
      (agentpane-test--redraw buffer)
      (should (equal (agentpane-test--tail-status) "Read app.ts … running\n"))
      (agentpane--on-notification
       nil 'session/status (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false))
      (should-not (agentpane-test--tail-status))
      (agentpane--on-notification nil 'session/status (list :view agentpane--view :session ref :handle "h1" :isStreaming t))
      (should (agentpane-test--tail-status))
      (agentpane--on-notification
       nil 'session/node (list :view agentpane--view :session ref :handle "h1" :node (agentpane-test--assistant 2 "<p>Done.</p>")))
      (agentpane-test--redraw buffer)
      (should-not (agentpane-test--tail-status))
      (agentpane--on-notification
       nil 'session/node (list :view agentpane--view :session ref :handle "h1" :node (plist-put (funcall running "Bash" "again")
                                                             :index 3)))
      (agentpane-test--redraw buffer)
      (should (equal (agentpane-test--tail-status) "Bash again … running\n"))
      (agentpane-test--press-r)
      (should-not (agentpane-test--tail-status)))))

(defconst agentpane-test--all-chrome-nodes
  [(:index 1 :role "tool-result"
    :parts [(:type "tool" :name "Grep" :summary "orphan" :args "" :result "hit" :state "ok")])
   (:index 2 :role "assistant"
    :parts [(:type "tool" :name "Bash" :summary "ls -la" :args "" :result "." :state "ok")]
    :meta (:model "luna" :usage (:totalTokens 3 :cost 0)))
   (:index 3 :role "assistant"
    :parts [(:type "thinking" :text "Tail thought" :redacted :json-false)]
    :meta (:model "luna" :usage (:totalTokens 2 :cost 0)))]
  "A transcript that so far holds only tool calls and thinking.")

(ert-deftest agentpane-test-reading-view-says-it-hides-everything ()
  "With reading view on and every node elided, a line above the prompt says
so, where the buffer would otherwise show only its header; it is no buffer
text, and goes when reading view does.  With one node drawn it never shows."
  (with-temp-buffer
    (agentpane-transcript-mode)
    (agentpane--draw agentpane-test--all-chrome-nodes)
    (should-not (agentpane-test--hiding-p))
    (agentpane-test--press-r)
    (should (agentpane-test--hiding-p))
    (should-not (string-search "Reading view" (buffer-string)))
    (agentpane-test--press-r)
    (should-not (agentpane-test--hiding-p))
    (agentpane--draw (vconcat agentpane-test--all-chrome-nodes
                              (vector (agentpane-test--assistant 4 "<p>Done.</p>"))))
    (agentpane-test--press-r)
    (should-not (agentpane-test--hiding-p))))

(ert-deftest agentpane-test-reading-view-hiding-line-follows-the-nodes ()
  "The line saying reading view hides every node follows the notifications
that change the nodes: a snapshot of chrome alone brings it, a drawn node
arriving takes it away, and it gives way to the tail status while that
shows.  A session with no nodes never shows it."
  (let ((ref '(:backend "claude" :id "c1")))
    (agentpane-test--with-session ref
      (agentpane-test--press-r)
      (should-not (agentpane-test--hiding-p))
      (agentpane--on-notification
       nil 'session/snapshot
       (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false :nodes agentpane-test--all-chrome-nodes))
      (should (agentpane-test--hiding-p))
      (agentpane--on-notification
       nil 'session/node (list :view agentpane--view :session ref :handle "h1" :node (agentpane-test--assistant 4 "<p>Done.</p>")))
      (agentpane-test--redraw buffer)
      (should-not (agentpane-test--hiding-p))
      (agentpane--on-notification
       nil 'session/snapshot
       (list :view agentpane--view :session ref :handle "h1" :isStreaming t
             :nodes (vector (list :index 1 :role "assistant"
                                  :parts (vector (list :type "tool" :name "Bash"
                                                       :summary "bun test" :args ""
                                                       :result "" :state "running"))))))
      (should (equal (agentpane-test--above-prompt) "Bash bun test … running\n"))
      (agentpane--on-notification
       nil 'session/status (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false))
      (should (agentpane-test--hiding-p))
      (agentpane--on-notification
       nil 'session/snapshot (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false :nodes []))
      (should-not (agentpane-test--above-prompt)))))

;;;; Forking, against a stub connection

(defmacro agentpane-test--forking (points forked &rest body)
  "Run BODY with every request answered as the helper would: POINTS for
`sessions/forkPoints', saying a fork stops a running turn where BODY has
set `fork-stops', FORKED for `sessions/fork', for
`sessions/forkAndPrompt' whatever BODY has put in `fork-prompted', else
FORKED's summary under the handle \"h-fork\" and a started prompt, a summary of the ref
asked for for `sessions/attach', under the handle \"h-ID\" for the ref's
ID, unless BODY has put a summary of its own in `attached', the fixed nodes for `sessions/preview', and for
`sessions/list' nil, for `sessions/prompt' whatever BODY has put in
`prompted', nil, a started turn's answer, unless it has, and for
`sessions/abort' whatever BODY has put in `aborted', nil, an abort that
cleared nothing from Pi's queue, unless it has (OW-seleri).
Each request is pushed onto `sent' as (METHOD . PARAMS), and each `message'
onto `said'.  The reply to an attach is preceded, as the helper precedes
it, by the `session/snapshot' under the attach's view that attaches the
buffer, through `agentpane--connection', drawing the fixed nodes under
the summary's handle (`sessions/attach' in src/emacs/helper.ts), and
before that, where a buffer already holds the handle, by the snapshot
the server's attach of a live session sends that buffer's view
\(`introduce' there, D31), unless a snapshot has reached the buffer since
the attach went out: the helper writes an attach's reply only after the
snapshot that answers it, or once none will.  Where that buffer is
another, the attach binds nothing, and its reply, or its refusal's
`attached', names the holder's view instead (D32 point 2).  So is the
reply to a `sessions/prompt' not marked `live', which the helper sends by
ref and which attaches its session as an attach does, under the same
summary, and its refusal where the error's `data' names the session
`attached' (D30).  So is the reply to `sessions/forkAndPrompt', and its refusal
where the error's `data' names a fork with a handle, by a snapshot under
the fork's handle and the request's `forkView', drawing nothing and
streaming where BODY has set `fork-streaming', unless BODY has set
`fork-unbound', for a snapshot a gap took (`sessions/forkAndPrompt' in
src/emacs/helper.ts).
A request whose method BODY has put in `hold' is not answered
at once: (METHOD . ANSWER) is appended to `held' instead, and BODY calls
ANSWER with t to deliver the reply, with `reply' to deliver the reply
alone, as the helper does for an attach no snapshot will answer, with
nil to fail the request as `agentpane--request' fails one on an error
that carries no `data', running its FAILED alone, or with a plist, the
error's `data', to fail it so and then run its ERRED with that plist, as
`agentpane--request' does for an error the helper answered with that
`data' (OW-hiliti).  ERRED runs with nil for a failure by nil.  Either
way the answer runs in the buffer that sent the request, and to a buffer
since killed it runs nothing, as `agentpane--request' does.  A request the helper refuses before
running it, one on a live session from a buffer holding no handle among
them, is refused so at once and recorded nowhere
\(`agentpane-test--refusing').  Every buffer BODY made is killed afterwards."
  (declare (indent 2))
  `(let ((sent nil)
         (said nil)
         (hold nil)
         (held nil)
         (attached nil)
         (prompted nil)
         (aborted nil)
         (snapshotted nil)
         (fork-stops nil)
         (fork-prompted nil)
         (fork-streaming nil)
         (fork-unbound nil)
         (attach-by (symbol-function 'agentpane--attach-by))
         (buffers (buffer-list)))
     (cl-letf (((symbol-function 'agentpane--attach-by)
                (lambda (&rest args)
                  (cl-pushnew (current-buffer) snapshotted)
                  (apply attach-by args)))
               ((symbol-function 'agentpane--request)
                (agentpane-test--refusing
                (lambda (method params callback &optional always failed _timeout erred)
                  (push (cons method params) sent)
                  (when (or (eq method 'sessions/attach)
                            (and (eq method 'sessions/prompt) (not (plist-get params :live))))
                    (setq snapshotted (delq (current-buffer) snapshotted)))
                  (let* ((from (current-buffer))
                         (bound (or attached
                                    (let ((ref (plist-get params :session)))
                                      (list :ref ref :handle (format "h-%s" (plist-get ref :id))))))
                         (holder nil)
                         (reply (pcase method
                                  ('sessions/forkPoints (list :points ,points
                                                              :forkStopsTurn (if fork-stops t :json-false)))
                                  ('sessions/fork ,forked)
                                  ('sessions/forkAndPrompt
                                   (or fork-prompted
                                       (list :session (list :ref ,forked :handle "h-fork")
                                             :disposition "started")))
                                  ('sessions/attach bound)
                                  ('sessions/preview agentpane-test--nodes)
                                  ('sessions/prompt prompted)
                                  ('sessions/abort aborted)))
                         (answer (lambda (ok)
                                   (when (eq method 'sessions/forkAndPrompt)
                                     (let ((fork (if (eq ok t)
                                                     (plist-get reply :session)
                                                   (and (listp ok) (plist-get ok :fork)))))
                                       (when (and fork (plist-get fork :handle) (not fork-unbound))
                                         (agentpane--on-notification
                                          agentpane--connection 'session/snapshot
                                          (list :view (plist-get params :forkView)
                                                :session (plist-get fork :ref)
                                                :handle (plist-get fork :handle)
                                                :isStreaming (if fork-streaming t :json-false)
                                                :nodes [])))))
                                   (when (and (not (memq from snapshotted))
                                              (or (and (eq ok t) (eq method 'sessions/attach))
                                                  (and (eq method 'sessions/prompt) (not (plist-get params :live))
                                                       (or (eq ok t) (and (listp ok) (plist-get ok :attached))))))
                                     (let ((held-by (agentpane--buffer-holding (plist-get bound :handle))))
                                       (when held-by
                                         (agentpane--on-notification
                                          agentpane--connection 'session/snapshot
                                          (list :view (buffer-local-value 'agentpane--view held-by)
                                                :session (plist-get bound :ref)
                                                :handle (plist-get bound :handle)
                                                :nodes agentpane-test--nodes)))
                                       (if (and held-by (not (eq held-by from)))
                                           (setq holder (buffer-local-value 'agentpane--view held-by))
                                         (agentpane--on-notification
                                          agentpane--connection 'session/snapshot
                                          (list :view (plist-get params :view)
                                                :session (plist-get bound :ref)
                                                :handle (plist-get bound :handle)
                                                :nodes agentpane-test--nodes)))))
                                   (when holder
                                     (if (and ok (atom ok))
                                         (setq reply (append (list :view holder) reply))
                                       (setq ok (plist-put (copy-sequence ok) :attached
                                                           (append (list :view holder)
                                                                   (plist-get ok :attached))))))
                                   (if (and ok (atom ok))
                                       (when (buffer-live-p from)
                                         (with-current-buffer from
                                           (funcall callback reply)))
                                     (when (buffer-live-p from)
                                       (with-current-buffer from
                                         (when failed (funcall failed))
                                         (when erred (funcall erred ok))))))))
                    (if (memq method hold)
                        (setq held (append held (list (cons method answer))))
                      (funcall answer t))))))
               ((symbol-function 'message)
                (lambda (format-string &rest args)
                  (push (apply #'format format-string args) said))))
       (unwind-protect (save-window-excursion ,@body)
         (dolist (buffer (buffer-list))
           (unless (memq buffer buffers) (kill-buffer buffer)))))))

(defmacro agentpane-test--with-helper (&rest body)
  "Run BODY with a helper connection that counts as running, so a buffer
whose `agentpane--attached' is `agentpane--connection' is attached, and
`agentpane-fork' forks there rather than attaching first."
  (declare (indent 0))
  `(let ((agentpane--connection 'connection))
     (cl-letf (((symbol-function 'jsonrpc-running-p) (lambda (_) t)))
       ,@body)))

(defun agentpane-test--goto-index (index)
  "Move point to the drawn node whose index is INDEX."
  (ewoc-goto-node agentpane--ewoc
                  (seq-find (lambda (node) (eql (plist-get (ewoc-data node) :index) index))
                            (let (nodes (node (ewoc-nth agentpane--ewoc 0)))
                              (while node
                                (push node nodes)
                                (setq node (ewoc-next agentpane--ewoc node)))
                              nodes))))

(ert-deftest agentpane-test-fork-at-a-fork-point ()
  "`agentpane-fork' on the node a fork point names sends `sessions/fork'
with that point's id, and opens the fork in a buffer of its own, attached,
leaving this one holding its session, and on Codex still attached."
  (let ((ref '(:backend "codex" :id "t1"))
        (forked '(:backend "codex" :id "t2")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "turn-0" :text "Fix the bug" :index 0) (:id "turn-2" :text "More" :index 2)]
          forked
        (agentpane-test--with-session ref
          (setq agentpane--attached 'connection
                agentpane--handle "h1")
          (agentpane-test--goto-index 0)
          (agentpane-fork)
          (should (equal (assq 'sessions/fork sent)
                         `(sessions/fork :session ,ref :view ,(agentpane-test--view buffer) :entryId "turn-0")))
          (should (equal (assq 'sessions/attach sent)
                         `(sessions/attach :session ,forked :view ,(agentpane-test--view (agentpane--buffer-for forked)))))
          (let ((fork-buffer (agentpane--buffer-for forked)))
            (should fork-buffer)
            (should-not (eq fork-buffer buffer))
            (should (agentpane--same-ref-p
                     (agentpane--ref (buffer-local-value 'agentpane--session buffer)) ref))
            (should (eq (buffer-local-value 'agentpane--attached buffer) 'connection))))))))

(ert-deftest agentpane-test-fork-at-no-fork-point ()
  "`agentpane-fork' on a node no fork point names sends no `sessions/fork'
and says the message is not forkable."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "turn-0" :text "Fix the bug" :index 0)]
          '(:backend "codex" :id "t2")
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection
                agentpane--handle "h1")
          (agentpane-test--goto-index 1)
          (agentpane-fork)
          (should (equal (mapcar #'car sent) '(sessions/forkPoints)))
          (should (seq-some (lambda (text) (string-search "not forkable" text)) said)))))))

(ert-deftest agentpane-test-pi-fork-detaches-the-parent ()
  "A Pi fork, which leaves its parent detached on the server, detaches the
parent from the helper, so the helper stops feeding a buffer that counts
itself detached; and the parent buffer, not attached, refuses to compact
and sends nothing, as it refuses to stop a turn, since `sessions/compact'
answers only for an attached session.  Until ark3/agentpane#71 it
attached first."
  (let ((ref '(:backend "pi" :id "/s/parent.jsonl"))
        (forked '(:backend "pi" :id "/s/fork.jsonl"))
        (agentpane--connection 'connection))
    (cl-letf (((symbol-function 'jsonrpc-running-p) (lambda (_) t)))
      (agentpane-test--forking
          [(:id "entry-0" :text "Fix the bug" :index 0)]
          forked
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection
                agentpane--handle "h1")
          (agentpane-test--goto-index 0)
          (agentpane-fork)
          (should (equal (mapcar #'car (reverse sent))
                         '(sessions/forkPoints sessions/fork sessions/detach
                           sessions/attach)))
          (should (equal (assq 'sessions/detach sent)
                         `(sessions/detach :session ,ref :view ,(agentpane-test--view buffer))))
          (setq sent nil)
          (with-current-buffer buffer
            (should-error (agentpane-compact) :type 'user-error))
          (should-not sent))))))

(ert-deftest agentpane-test-pi-fork-leaves-the-parent-as-it-was ()
  "A Pi fork leaves the parent buffer showing the transcript it showed, and
fetches nothing to redraw it: the server sends the fork's shortened
transcript under the fork's ref, never the parent's (OW-zovaye)."
  (let ((ref '(:backend "pi" :id "/s/parent.jsonl"))
        (forked '(:backend "pi" :id "/s/fork.jsonl")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "entry-0" :text "Fix the bug" :index 0)]
          forked
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection
                agentpane--handle "h1")
          (agentpane-test--goto-index 0)
          (agentpane-fork)
          (should (agentpane--buffer-for forked))
          (should-not (assq 'sessions/preview sent))
          (with-current-buffer buffer
            (should-not (agentpane--attached-p))
            (should (equal (agentpane-test--indices) '(0 1)))))))))

(ert-deftest agentpane-test-pi-fork-detaches-the-parent-by-its-view ()
  "A Pi fork detaches its parent from the helper by the parent's view
alone, sending no handle (D32 point 1); and the fork's buffer holds the
handle its own attach answered.  Until D32 the detach carried the token
of every attach the parent sent (OW-nowihu)."
  (let ((ref '(:backend "pi" :id "/s/parent.jsonl"))
        (forked '(:backend "pi" :id "/s/fork.jsonl")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "entry-0" :text "Fix the bug" :index 0)]
          forked
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection
                agentpane--handle "h1"
                attached (list :ref forked :handle "h2"))
          (agentpane-test--goto-index 0)
          (agentpane-fork)
          (should (equal (assq 'sessions/detach sent)
                         `(sessions/detach :session ,ref :view ,(agentpane-test--view buffer))))
          (should (equal (buffer-local-value 'agentpane--handle (agentpane--buffer-for forked))
                         "h2")))))))

(ert-deftest agentpane-test-pi-fork-parent-detached-before-the-reply-previews ()
  "A `session/detached' for a Pi fork's parent that lands before the
`sessions/fork' reply -- the server's `ended' for the parent's handle
goes out inside the fork, ahead of its answer (D26) -- leaves the parent
not attached once the reply lands, so `g' previews it rather than
attaching its old branch again, the edge OW-wabiju found when a flag
marked such a buffer to attach at `g'.  The reply sends no detach: the
buffer no longer holds the handle the fork went from, and the helper
unbound its view at the `ended' (`agentpane--forked-away').  Until
ark3/agentpane#71 the reply detached it anyway."
  (let ((ref '(:backend "pi" :id "/s/parent.jsonl"))
        (forked '(:backend "pi" :id "/s/fork.jsonl")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "entry-0" :text "Fix the bug" :index 0)]
          forked
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection
                agentpane--handle "h1"
                attached (list :ref forked :handle "h2")
                hold '(sessions/fork))
          (agentpane-test--goto-index 0)
          (agentpane-fork)
          (agentpane--on-notification nil 'session/detached (list :view (agentpane-test--view buffer) :session ref :handle "h1"))
          (funcall (cdr (pop held)) t)
          (should-not (assq 'sessions/detach sent))
          (with-current-buffer buffer
            (should-not (agentpane--attached-p))
            (setq sent nil)
            (agentpane-refetch)
            (should (equal sent `((sessions/preview :session ,ref))))))))))

(ert-deftest agentpane-test-fork-in-flight-refuses-a-second ()
  "A second `agentpane-fork' while one is in flight says so and sends
nothing; a fork that failed, or finished, frees the buffer for another."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "turn-0" :text "Fix the bug" :index 0)]
          '(:backend "codex" :id "t2")
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection
                agentpane--handle "h1")
          (setq hold '(sessions/forkPoints))
          (agentpane-test--goto-index 0)
          (agentpane-fork)
          (should-error (agentpane-fork) :type 'user-error)
          (should (equal (mapcar #'car sent) '(sessions/forkPoints)))
          (funcall (cdr (pop held)) nil)
          (agentpane-fork)
          (should (equal (mapcar #'car sent) '(sessions/forkPoints sessions/forkPoints)))
          (setq hold nil)
          (funcall (cdr (pop held)) t)
          (with-current-buffer buffer
            (agentpane-test--goto-index 0)
            (agentpane-fork))
          (should (equal (car (car sent)) 'sessions/attach))
          (should (= 3 (seq-count (lambda (s) (eq (car s) 'sessions/forkPoints)) sent))))))))

(ert-deftest agentpane-test-fork-shows-in-the-parents-window ()
  "The fork is shown in the window that showed the parent when the fork
began, not in whichever window is selected when its reply lands."
  (let ((ref '(:backend "codex" :id "t1"))
        (forked '(:backend "codex" :id "t2")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "turn-0" :text "Fix the bug" :index 0)]
          forked
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection
                agentpane--handle "h1")
          (delete-other-windows)
          (switch-to-buffer buffer)
          (let ((parent-window (selected-window))
                (notes (get-buffer-create " *agentpane-test notes*")))
            (setq hold '(sessions/fork))
            (agentpane-test--goto-index 0)
            (agentpane-fork)
            (select-window (split-window))
            (switch-to-buffer notes)
            (funcall (cdr (assq 'sessions/fork held)) t)
            (should (eq (window-buffer parent-window) (agentpane--buffer-for forked)))
            (should (eq (window-buffer (selected-window)) notes))))))))

(defun agentpane-test--fork-streaming (backend)
  "Fork a BACKEND session at index 0 while a `session/status' says it is
streaming, holding any abort's reply.  Return the methods sent before that
reply is released, and those sent after, in order."
  (let ((ref (list :backend backend :id "parent")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "entry-0" :text "Fix the bug" :index 0)]
          (list :backend backend :id "fork")
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection
                agentpane--handle "h1")
          (setq hold '(sessions/abort))
          (agentpane--on-notification
           nil 'session/status (list :view agentpane--view :session ref :handle "h1" :isStreaming t :compaction nil :model nil))
          (agentpane-test--goto-index 0)
          (agentpane-fork)
          (let ((before (mapcar #'car (reverse sent))))
            (setq sent nil)
            (dolist (entry held) (funcall (cdr entry) t))
            (list before (mapcar #'car (reverse sent)))))))))

(ert-deftest agentpane-test-fork-aborts-a-streaming-pi-turn ()
  "A fork of a streaming Pi session aborts the turn and forks only once the
abort has answered, as the browser does (D15); a streaming Codex session is
forked with no abort."
  (should (equal (agentpane-test--fork-streaming "pi")
                 '((sessions/forkPoints sessions/abort)
                   (sessions/fork sessions/detach sessions/attach))))
  (should (equal (agentpane-test--fork-streaming "codex")
                 '((sessions/forkPoints sessions/fork sessions/attach) nil))))

(ert-deftest agentpane-test-fork-on-a-preview-attaches-first ()
  "`agentpane-fork' on a previewed buffer, whose stored index names another
message among the live fork points, as a Pi preview that drops a
`custom_message' does, forks nothing: it attaches, and says to press again.
Pressed again once the live snapshot has redrawn the buffer, it forks at
the message it is on."
  (let ((ref '(:backend "pi" :id "/s/parent.jsonl")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "entry-custom" :text "A custom message" :index 0)
           (:id "entry-fix" :text "Fix the bug" :index 1)]
          '(:backend "pi" :id "/s/fork.jsonl")
        (agentpane-test--with-session ref
          (agentpane-test--goto-index 0)
          (agentpane-fork)
          (should (equal (mapcar #'car sent) '(sessions/attach)))
          (should (seq-some (lambda (text) (string-search "press f again" text)) said))
          (agentpane--on-notification
           agentpane--connection 'session/snapshot
           (list :view agentpane--view :session ref :handle "h-/s/parent.jsonl"
                 :nodes (vector '(:index 0 :role "custom"
                                  :parts [(:type "text" :text "A custom message"
                                           :html "<p>A custom message</p>\n")])
                                (plist-put (copy-sequence (aref agentpane-test--nodes 0))
                                           :index 1))
                 :isStreaming :json-false :compaction nil :model nil))
          (agentpane-test--goto-index 1)
          (setq sent nil)
          (agentpane-fork)
          (should (equal (assq 'sessions/fork sent)
                         `(sessions/fork :session ,ref :view ,(agentpane-test--view buffer) :entryId "entry-fix"
                                         :unwatch t))))))))

(ert-deftest agentpane-test-fork-while-attaching-attaches-again ()
  "A second `agentpane-fork' on a previewed buffer while the first one's
attach is in flight sends an attach of its own, which the helper joins to
the first (D32 point 4), and forks nothing; attaches that fail say
nothing of pressing again.  Until ark3/agentpane#71 the second press was
refused, saying the session was still attaching."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "turn-0" :text "Fix the bug" :index 0)]
          '(:backend "codex" :id "t2")
        (agentpane-test--with-session ref
          (setq hold '(sessions/attach))
          (agentpane-test--goto-index 0)
          (agentpane-fork)
          (agentpane-fork)
          (should (equal (mapcar #'car sent) '(sessions/attach sessions/attach)))
          (funcall (cdr (pop held)) nil)
          (funcall (cdr (pop held)) nil)
          (should-not (seq-some (lambda (text) (string-search "press f again" text)) said))
          (should-not (assq 'sessions/fork sent)))))))

(ert-deftest agentpane-test-attach-on-a-preview-attaches-and-goes-to-the-prompt ()
  "`agentpane-attach' on a previewed buffer holding a draft sends
`sessions/attach' and nothing else, and moves nothing until the buffer is
attached, nor at all when the attach fails.  Once attached, point goes to
the end of the prompt region, past the draft, in the buffer and in the
window the press came from, even when another window is selected by
then, while a second window showing the buffer keeps its point.  Pressed
again on the attached buffer it sends nothing and moves point there."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          (save-excursion (goto-char (point-max)) (insert "A draft"))
          (let ((pressed (selected-window)))
            (set-window-buffer pressed buffer)
            (let ((other (split-window pressed))
                  (before (progn (agentpane-test--goto-index 0) (point))))
              (set-window-buffer other buffer)
              (set-window-point other (point-min))
              (setq hold '(sessions/attach))
              (agentpane-attach)
              (should (equal sent `((sessions/attach :session ,ref :view ,agentpane--view))))
              (should (= (point) before))
              (funcall (cdr (pop held)) nil)
              (should-not (agentpane--attached-p))
              (should (= (point) before))
              (should (= (window-point other) (point-min)))
              (agentpane-attach)
              (should (= (point) before))
              (let ((elsewhere (split-window pressed)))
                (set-window-buffer elsewhere (get-buffer-create " *agentpane-test elsewhere*"))
                (with-selected-window elsewhere
                  (funcall (cdr (pop held)) t)
                  (with-current-buffer buffer
                    (should (agentpane--attached-p))
                    (should (= (point) (point-max))))))
              (should (= (window-point pressed) (point-max)))
              (should (= (window-point other) (point-min)))
              (setq sent nil)
              (agentpane-test--goto-index 0)
              (agentpane-attach)
              (should-not sent)
              (should (= (point) (point-max))))))))))

(ert-deftest agentpane-test-attach-during-a-fork-sends-nothing ()
  "`agentpane-attach' on a buffer let go of while a fork of it is in
flight, as a Pi fork's parent is once the server's `ended' has come and
before the fork's reply, is refused and sends nothing: its attach would
spawn the parent's old branch again."
  (agentpane-test--detached
    (with-current-buffer buffer
      (setq agentpane--forking t)
      (should-error (agentpane-attach) :type 'user-error)
      (should-not sent))))

(ert-deftest agentpane-test-refetch-during-a-fork-sends-nothing ()
  "A refetch while a Pi fork is in flight says so and sends nothing, so no
re-attach of the parent can reach the server after it has let go of the
parent and respawn the parent's old branch, which the fork's reply leaves
running with nothing listening; see `agentpane-fork'."
  (let ((ref '(:backend "pi" :id "/s/parent.jsonl"))
        (forked '(:backend "pi" :id "/s/fork.jsonl")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "entry-0" :text "Fix the bug" :index 0)]
          forked
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection
                agentpane--handle "h1")
          (setq hold '(sessions/fork sessions/attach))
          (agentpane-test--goto-index 0)
          (agentpane-fork)
          (agentpane-refetch)
          (funcall (cdr (assq 'sessions/fork held)) t)
          (dolist (entry held)
            (when (eq (car entry) 'sessions/attach) (funcall (cdr entry) t)))
          (with-current-buffer buffer
            (should-not (agentpane--attached-p)))
          (should (seq-some (lambda (text) (string-search "fork of this session" text)) said))
          (should (equal (mapcar #'car (reverse sent))
                         '(sessions/forkPoints sessions/fork sessions/detach
                           sessions/attach))))))))

(ert-deftest agentpane-test-send-and-compact-during-a-pi-fork-send-nothing ()
  "`agentpane-send' and `agentpane-compact' on a Pi fork's parent the
helper has let go of while the fork is in flight -- the server's `ended'
for the parent's handle goes out inside the fork, ahead of its reply
\(D26) -- are refused and send nothing, the draft and the status left as
they were and the buffer not left sending.  Each would attach the
parent's ref, respawning its old branch, which the fork's reply then
detaches, leaving that process running with nothing listening (OW-nuhayu).
The fork's reply then sends only the fork's attach, the parent holding no
handle to detach (`agentpane--forked-away')."
  (let ((ref '(:backend "pi" :id "/s/parent.jsonl"))
        (forked '(:backend "pi" :id "/s/fork.jsonl")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "entry-0" :text "Fix the bug" :index 0)]
          forked
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection
                agentpane--handle "h1"
                hold '(sessions/fork))
          (agentpane-test--goto-index 0)
          (agentpane-fork)
          (agentpane--on-notification nil 'session/detached (list :view (agentpane-test--view buffer) :session ref :handle "h1"))
          (setq sent nil)
          (with-current-buffer buffer
            (should-not (agentpane--attached-p))
            (goto-char (point-max))
            (insert "Carry on")
            (should-error (agentpane-send) :type 'user-error)
            (should-error (agentpane-compact) :type 'user-error)
            (should-not sent)
            (should-not agentpane--sending)
            (should-not (plist-get agentpane--status :compaction))
            (should (equal (buffer-substring-no-properties agentpane--prompt-start (point-max))
                           "Carry on")))
          (funcall (cdr (pop held)) t)
          (should (equal (reverse sent)
                         `((sessions/attach :session ,forked
                                            :view ,(agentpane-test--view (agentpane--buffer-for forked)))))))))))

;;;; Editing an earlier message, against a stub connection

(defconst agentpane-test--image-nodes
  [(:index 0 :role "user"
    :parts [(:type "text" :text "Fix the bug" :html "<p>Fix the bug</p>\n")
            (:type "image" :mimeType "image/png" :data "AAAA")])
   (:index 1 :role "assistant"
    :parts [(:type "text" :text "Looking." :html "<p>Looking.</p>\n")]
    :meta (:model "haiku" :usage (:totalTokens 12 :cost 0.001)))]
  "A user message holding an image, then an assistant turn.")

(defun agentpane-test--draft ()
  "The prompt region's text in the current buffer."
  (buffer-substring-no-properties agentpane--prompt-start (point-max)))

(ert-deftest agentpane-test-edit-forks-with-the-edited-text-and-images ()
  "`agentpane-edit' on a user message holding an image fills the prompt
region with its text, and the send is one `sessions/forkAndPrompt' at
that message's index, carrying the edited text and the message's image,
in the shape `sessions/prompt''s `images' take, and the view of the
fork's buffer, made before the request (D32 point 3), whose snapshot
attaches that buffer, shown where the parent was (D30)."
  (let ((ref '(:backend "codex" :id "t1"))
        (forked '(:backend "codex" :id "t2")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "turn-0" :text "Fix the bug" :index 0)]
          forked
        (agentpane-test--with-session ref
          (agentpane--draw agentpane-test--image-nodes)
          (setq agentpane--attached 'connection
                agentpane--handle "h1")
          (agentpane-test--goto-index 0)
          (agentpane-edit)
          (should (equal (mapcar #'car sent) '(sessions/forkPoints)))
          (should (equal (agentpane-test--draft) "Fix the bug"))
          (goto-char (point-max))
          (insert " properly")
          (let ((window (selected-window))
                (parent (current-buffer)))
            (set-window-buffer window parent)
            (agentpane-send)
            (should (equal (mapcar #'car (reverse sent)) '(sessions/forkPoints sessions/forkAndPrompt)))
            (let ((params (cdr (assq 'sessions/forkAndPrompt sent))))
              (should (equal params `(:session ,ref :view ,(agentpane-test--view parent)
                                               :forkView ,(agentpane-test--view (agentpane--buffer-for forked))
                                               :index 0 :text "Fix the bug properly"
                                               :images [(:mimeType "image/png" :base64 "AAAA")]))))
            (should (equal (agentpane-test--draft) ""))
            (should-not agentpane--editing)
            (should-not agentpane--sending)
            ;; Codex leaves the parent attached.
            (should (agentpane--attached-p))
            (let ((fork (agentpane--buffer-for forked)))
              (should (eq (window-buffer window) fork))
              (with-current-buffer fork
                (should (agentpane--attached-p))
                (should (equal agentpane--handle "h-fork"))))))))))

(ert-deftest agentpane-test-edit-abandoned-forks-nothing ()
  "An edit abandoned with `agentpane-cancel-edit' puts back the draft it
displaced and forks nothing: the next send prompts the session itself."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "turn-0" :text "Fix the bug" :index 0)]
          '(:backend "codex" :id "t2")
        (agentpane-test--with-session ref
          (agentpane--draw agentpane-test--image-nodes)
          (setq agentpane--attached 'connection
                agentpane--handle "h1")
          (goto-char (point-max))
          (insert "a draft")
          (agentpane-test--goto-index 0)
          (agentpane-edit)
          (should (equal (agentpane-test--draft) "Fix the bug"))
          (agentpane-cancel-edit)
          (should (equal (agentpane-test--draft) "a draft"))
          (agentpane-send)
          (should-not (assq 'sessions/fork sent))
          (let ((prompt (assq 'sessions/prompt sent)))
            (should (equal (plist-get (cdr prompt) :session) ref))
            (should (equal (plist-get (cdr prompt) :text) "a draft"))
            (should-not (plist-get (cdr prompt) :images))))))))

(ert-deftest agentpane-test-edit-fork-gives-the-displaced-draft-back ()
  "An edit sent with `C-RET' forks, and once its request has answered
the prompt region holds the draft the edit displaced, as Cancel would have
left it, never sent into the fork: the edit's whole lifetime owns that
draft, not Cancel alone, as in the browser (OW-kijuju, OW-hakeno).  Until
the request answers the region holds the text being sent."
  (let ((ref '(:backend "codex" :id "t1"))
        (forked '(:backend "codex" :id "t2")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "turn-0" :text "Fix the bug" :index 0)]
          forked
        (agentpane-test--with-session ref
          (agentpane--draw agentpane-test--image-nodes)
          (setq agentpane--attached 'connection
                agentpane--handle "h1"
                hold '(sessions/forkAndPrompt))
          (goto-char (point-max))
          (insert "a draft")
          (agentpane-test--goto-index 0)
          (agentpane-edit)
          (goto-char (point-max))
          (insert " properly")
          (call-interactively (key-binding (kbd "C-<return>") t nil (point)))
          (should (equal (agentpane-test--draft) "Fix the bug properly"))
          (funcall (cdr (pop held)) t)
          (should (equal (plist-get (cdr (assq 'sessions/forkAndPrompt sent)) :text)
                         "Fix the bug properly"))
          (should-not agentpane--editing)
          (should (equal (agentpane-test--draft) "a draft"))
          (with-current-buffer (agentpane--buffer-for forked)
            (should (equal (agentpane-test--draft) ""))))))))

(ert-deftest agentpane-test-edit-refused-at-the-press ()
  "`agentpane-edit' on a message no fork point names fills nothing and says
it is not forkable; on a previewed buffer it attaches, fills nothing, and
says to press again, as `agentpane-fork' does."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "turn-2" :text "More" :index 2)]
          '(:backend "codex" :id "t2")
        (agentpane-test--with-session ref
          (agentpane--draw agentpane-test--image-nodes)
          (agentpane-test--goto-index 0)
          (agentpane-edit)
          (should (equal (mapcar #'car sent) '(sessions/attach)))
          (should (seq-some (lambda (text) (string-search "press e again" text)) said))
          (setq sent nil)
          (agentpane-test--goto-index 0)
          (agentpane-edit)
          (should (equal (mapcar #'car sent) '(sessions/forkPoints)))
          (should (seq-some (lambda (text) (string-search "not forkable" text)) said))
          (should (equal (agentpane-test--draft) ""))
          (should-not agentpane--editing))))))

(defmacro agentpane-test--editing (backend &rest body)
  "Run BODY in a buffer attached to a session on BACKEND, drawn with
`agentpane-test--image-nodes', with an edit of the message at index 0 open,
under `agentpane-test--forking'.  The fork points answered are `points',
which BODY may set; `sent' starts empty once the edit is open."
  (declare (indent 1))
  `(let ((points [(:id "entry-0" :text "Fix the bug" :index 0)]))
     (agentpane-test--with-helper
       (agentpane-test--forking
           points
           (list :backend ,backend :id "fork")
         (agentpane-test--with-session (list :backend ,backend :id "parent")
           (agentpane--draw agentpane-test--image-nodes)
           (setq agentpane--attached 'connection
                 agentpane--handle "h-parent")
           (agentpane-test--goto-index 0)
           (agentpane-edit)
           (should agentpane--editing)
           (setq sent nil)
           ,@body)))))

(defun agentpane-test--count (method sent)
  "How many of the requests SENT went out as METHOD."
  (seq-count (lambda (entry) (eq (car entry) method)) sent))

(ert-deftest agentpane-test-edit-send-in-flight-refuses-a-second ()
  "A second send while an edit's send is in flight says so and sends
nothing, so one edit forks once (OW-kelede).  Nothing here refuses an
attach meanwhile: the helper refuses one of the session forked, from any
view (D32 point 4)."
  (agentpane-test--editing "codex"
    (setq hold '(sessions/forkAndPrompt))
    (agentpane-send)
    (should (equal (mapcar #'car sent) '(sessions/forkAndPrompt)))
    (should-error (agentpane-send) :type 'user-error)
    (should (equal (mapcar #'car sent) '(sessions/forkAndPrompt)))
    (funcall (cdr (pop held)) t)
    (should-not agentpane--sending)
    (should-not agentpane--fork-sent)))

(ert-deftest agentpane-test-edit-send-parent-killed-gives-up-the-fork ()
  "Killing the buffer whose edit's `sessions/forkAndPrompt' is out kills
the buffer made for the fork with it (D32 point 3), whose own detach
gives up the fork's attach, so the helper binds nothing for a buffer no
one will see (ark3/agentpane#63), and none is made when the answer
comes; whether or not the fork's snapshot had filled that buffer first."
  (dolist (snapshot-first '(nil t))
    (agentpane-test--editing "codex"
      (setq hold '(sessions/forkAndPrompt))
      (agentpane-send)
      (let ((fork agentpane--fork-sent)
            (view agentpane--view)
            (forked '(:backend "codex" :id "fork")))
        (should (buffer-live-p fork))
        (when snapshot-first
          (agentpane--on-notification
           agentpane--connection 'session/snapshot
           (list :view (agentpane-test--view fork) :session forked :handle "h-fork" :nodes []))
          (should (eq (agentpane--buffer-for forked) fork)))
        (let ((fork-view (agentpane-test--view fork)))
          (setq sent nil)
          (kill-buffer (current-buffer))
          (should-not (buffer-live-p fork))
          (should (equal (reverse sent)
                         `((sessions/detach :session ,(if snapshot-first forked '(:backend "codex"))
                                            :view ,fork-view)
                           (sessions/detach :session (:backend "codex" :id "parent") :view ,view)))))
        (funcall (cdr (pop held)) t)
        (should-not (agentpane--buffer-for forked))))))

(ert-deftest agentpane-test-edit-opens-nothing-while-a-send-is-in-flight ()
  "No edit opens while a send from the buffer is in flight, whether pressed
then or pressed before and its fork points answering then: the region
holds the text that send is taking, which an edit would displace for
Cancel or a fork to put back already sent (OW-kijuju, OW-hakeno).  Nor
does `agentpane-edit-last' stop a streaming Pi turn when its edit does not
open, the stop being the edit's.  Pressed during an edit's own send it
moves that edit nowhere, and the send ends it."
  (dolist (how '(pressed-before pressed-during edit-sending))
    ;; Codex for an edit's send, whose fork leaves the parent attached.
    (let* ((backend (if (eq how 'edit-sending) "codex" "pi"))
           (ref (list :backend backend :id "parent"))
           (forked (list :backend backend :id "fork")))
      (agentpane-test--with-helper
        (agentpane-test--forking
            agentpane-test--two-asks-points
            forked
          (agentpane-test--with-session ref
            (agentpane--draw agentpane-test--two-asks)
            (setq agentpane--attached agentpane--connection
                  agentpane--handle "h1")
            (goto-char (point-max))
            (insert "hello")
            (pcase how
              ('pressed-before
               (agentpane--on-notification
                nil 'session/status (list :view agentpane--view :session ref :handle "h1" :isStreaming t :compaction nil :model nil))
               (setq hold '(sessions/forkPoints sessions/prompt))
               (agentpane-edit-last)
               (agentpane-send)
               (funcall (cdr (pop held)) t))
              ('pressed-during
               (agentpane--on-notification
                nil 'session/status (list :view agentpane--view :session ref :handle "h1" :isStreaming t :compaction nil :model nil))
               (setq hold '(sessions/prompt))
               (agentpane-send)
               (agentpane-edit-last)
               (agentpane-test--goto-index 0)
               (agentpane-edit))
              ('edit-sending
               (agentpane-test--goto-index 0)
               (agentpane-edit)
               (setq hold '(sessions/forkAndPrompt))
               (agentpane-send)
               (agentpane-test--goto-index 2)
               (agentpane-edit)
               (should (eql (plist-get agentpane--editing :index) 0))))
            (unless (eq how 'edit-sending)
              (should-not agentpane--editing)
              (should (equal (agentpane-test--draft) "hello"))
              (should-not (assq 'sessions/abort sent)))
            (should (seq-some (lambda (text) (string-search "being sent" text)) said))
            (funcall (cdr (pop held)) t)
            (should-not held)
            (should-not agentpane--editing)
            (should (equal (agentpane-test--draft) (if (eq how 'edit-sending) "hello" "")))))))))

(ert-deftest agentpane-test-edit-send-failed-frees-the-next-send ()
  "An edit's send that fails naming no fork -- the helper's own error, the
message no longer a fork point, or any refusal before the fork -- frees
the buffer, kills the buffer made for the fork (D32 point 3), and leaves
the edit open, so the next send goes out (D30)."
  (dolist (how (list nil '(:error "not_a_fork_point") '(:error "not_attached")))
    (agentpane-test--editing "codex"
      (setq hold '(sessions/forkAndPrompt))
      (agentpane-send)
      (let ((fork agentpane--fork-sent))
        (should (buffer-live-p fork))
        (funcall (cdr (pop held)) how)
        (should-not (buffer-live-p fork)))
      (should-not agentpane--sending)
      (should-not agentpane--fork-sent)
      (should agentpane--editing)
      (setq hold nil sent nil)
      (agentpane-send)
      (should (assq 'sessions/forkAndPrompt sent)))))

(ert-deftest agentpane-test-edit-send-failed-keeps-the-displaced-draft ()
  "An edit's send that fails naming no fork leaves the edit open, the
edited text in the prompt region and the draft it displaced still the
edit's, so Cancel puts back exactly that draft, once (OW-hakeno)."
  (dolist (how (list nil '(:error "not_a_fork_point")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "turn-0" :text "Fix the bug" :index 0)]
          '(:backend "codex" :id "t2")
        (agentpane-test--with-session '(:backend "codex" :id "t1")
          (agentpane--draw agentpane-test--image-nodes)
          (setq agentpane--attached 'connection
                agentpane--handle "h1")
          (goto-char (point-max))
          (insert "a draft")
          (agentpane-test--goto-index 0)
          (agentpane-edit)
          (setq hold '(sessions/forkAndPrompt))
          (agentpane-send)
          (funcall (cdr (pop held)) how)
          (should agentpane--editing)
          (should (equal (agentpane-test--draft) "Fix the bug"))
          (agentpane-cancel-edit)
          (should (equal (agentpane-test--draft) "a draft")))))))


(ert-deftest agentpane-test-edit-send-refused-naming-a-fork-moves-there ()
  "An edit's send refused after the server created the fork, which the
refusal names, ends the edit and moves to the fork, so sending again
prompts the fork rather than forking the parent a second time (D30,
ark3/agentpane#17): the parent's region gets the draft the edit
displaced back, and the fork's buffer, shown where the parent was, holds
the edited text.  A fork named with a handle is attached, the helper
having bound the view of the buffer made for it (D32 point 3); one whose
own start failed is not.  A Pi parent detaches, as after a fork that lands."
  (dolist (case '(("codex" "h-fork") ("codex" nil) ("pi" "h-fork")))
    (let* ((backend (car case))
           (handle (cadr case))
           (forked (list :backend backend :id "fork")))
      (agentpane-test--with-helper
        (agentpane-test--forking
            [(:id "turn-0" :text "Fix the bug" :index 0)]
            forked
          (agentpane-test--with-session (list :backend backend :id "parent")
            (agentpane--draw agentpane-test--image-nodes)
            (setq agentpane--attached 'connection
                  agentpane--handle "h-parent"
                  hold '(sessions/forkAndPrompt))
            (goto-char (point-max))
            (insert "a draft")
            (agentpane-test--goto-index 0)
            (agentpane-edit)
            (goto-char (point-max))
            (insert " properly")
            (let ((window (selected-window))
                  (parent (current-buffer)))
              (set-window-buffer window parent)
              (agentpane-send)
              (funcall (cdr (pop held))
                       (list :error "backend_refused"
                             :fork (list :ref forked :handle handle)))
              (should-not agentpane--editing)
              (should-not agentpane--sending)
              (should-not agentpane--fork-sent)
              (should (equal (agentpane-test--draft) "a draft"))
              (should (eq (and (agentpane--attached-p) t) (not (equal backend "pi"))))
              (let ((fork (agentpane--buffer-for forked)))
                (should (eq (window-buffer window) fork))
                (with-current-buffer fork
                  (should (equal (agentpane-test--draft) "Fix the bug properly"))
                  (should (eq (and (agentpane--attached-p) t) (and handle t)))
                  (setq sent nil)
                  (agentpane-send)
                  (should-not (assq 'sessions/forkAndPrompt sent))
                  (should (equal (plist-get (cdr (assq 'sessions/prompt sent)) :session) forked)))))))))))

(ert-deftest agentpane-test-edit-send-from-a-detached-parent-refuses ()
  "An edit's send from a buffer no longer attached, as a helper's death or
a gap leaves one, holding no handle, is refused here in agentpane-mode's
own words, sending nothing and attaching nothing, with the edit and its
text left open: the request names the handle, and with none the server
refused it as \"handle is required and must be a string\" (D31 point 9,
ark3/agentpane#63)."
  (agentpane-test--editing "pi"
    (setq agentpane--attached nil
          agentpane--handle nil)
    (goto-char (point-max))
    (insert " properly")
    (should (equal (cadr (should-error (agentpane-send) :type 'user-error))
                   "This session is not attached; attach it to send the edit"))
    (should-not sent)
    (should agentpane--editing)
    (should-not agentpane--sending)
    (should-not agentpane--fork-sent)
    (should (equal (agentpane-test--draft) "Fix the bug properly"))))

(ert-deftest agentpane-test-live-requests-from-a-detached-buffer-refuse ()
  "A stop or an error's dismissal from a buffer holding no handle, as a
helper's death, a gap or an `ended' leaves one, is refused here in
agentpane-mode's own words and sends nothing; with a null handle the
server refused each as \"handle is required and must be a string\" (D31
point 9, ark3/agentpane#63).  The dismissal keeps the error drawn."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          (agentpane--hold-error "Turn failed upstream" "e3")
          (should (equal (cadr (should-error (agentpane-abort) :type 'user-error))
                         "This session is not attached; attach it to stop its turn"))
          (should (equal (cadr (should-error (agentpane-dismiss-error) :type 'user-error))
                         "This session is not attached; attach it to dismiss its error"))
          (should-not sent)
          (should (equal (list agentpane--error agentpane--error-id) '("Turn failed upstream" "e3"))))))))

(ert-deftest agentpane-test-composer-send-refused-while-editing ()
  "A composer send while its transcript holds an edit says so and sends
nothing, leaving the edit, the prompt region's text and the composer's."
  (agentpane-test--editing "codex"
    (let ((transcript (current-buffer)))
      (agentpane-prompt)
      (with-current-buffer (buffer-local-value 'agentpane--composer transcript)
        (insert "from the composer")
        (should-error (agentpane-composer-send) :type 'user-error)
        (should (equal (buffer-string) "from the composer")))
      (with-current-buffer transcript
        (should agentpane--editing)
        (should (equal (agentpane-test--draft) "Fix the bug")))
      (should-not sent))))

;;;; Editing the last message, against a stub connection

(defconst agentpane-test--two-asks
  [(:index 0 :role "user"
    :parts [(:type "text" :text "first draft" :html "<p>first draft</p>\n")])
   (:index 1 :role "assistant"
    :parts [(:type "text" :text "an answer" :html "<p>an answer</p>\n")]
    :meta (:model "haiku" :usage (:totalTokens 12 :cost 0.001)))
   (:index 2 :role "user"
    :parts [(:type "text" :text "second draft" :html "<p>second draft</p>\n")
            (:type "image" :mimeType "image/png" :data "AAAA")])
   (:index 3 :role "assistant"
    :parts [(:type "text" :text "another answer" :html "<p>another answer</p>\n")]
    :meta (:model "haiku" :usage (:totalTokens 12 :cost 0.001)))]
  "Two user messages, the last holding an image, each answered.")

(defconst agentpane-test--two-asks-points
  [(:id "entry-0" :text "first draft" :index 0) (:id "entry-2" :text "second draft" :index 2)]
  "Fork points naming both user messages of `agentpane-test--two-asks'.")

(defun agentpane-test--edit-snapshot ()
  "Everything this buffer's edit is observable as: the prompt region's text,
the edit's index, images and displaced draft, and what the separator says."
  (list :draft (agentpane-test--draft)
        :index (plist-get agentpane--editing :index)
        :images (plist-get agentpane--editing :images)
        :displaced (plist-get agentpane--editing :draft)
        :separator (and agentpane--editing
                        (substring-no-properties
                         (overlay-get (plist-get agentpane--editing :overlay) 'display)))))

(defun agentpane-test--edit-last-streaming (backend &optional streaming compaction)
  "Edit the last message of a BACKEND session whose status says it is
STREAMING, streaming when omitted, in the COMPACTION phase, holding any
abort's reply, the fork-points answer saying a fork stops a running turn
on Pi alone, as the server's does (D30).  Return the methods sent, in
order, and the edit's snapshot, taken while the abort, if any, is still
unanswered."
  (let ((ref (list :backend backend :id "parent"))
        (streaming (if (eq streaming 'idle) :json-false t)))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "entry-0" :text "first draft" :index 0)]
          (list :backend backend :id "fork")
        (agentpane-test--with-session ref
          (agentpane--draw (seq-take agentpane-test--two-asks 2))
          (setq agentpane--attached agentpane--connection
                agentpane--handle "h1")
          (setq hold '(sessions/abort)
                fork-stops (equal backend "pi"))
          (agentpane--on-notification
           nil 'session/status
           (list :view agentpane--view :session ref :handle "h1" :isStreaming streaming :compaction compaction :model nil))
          (goto-char (point-max))
          (agentpane-edit-last)
          (list (mapcar #'car (reverse sent))
                (agentpane-test--edit-snapshot)))))))

(ert-deftest agentpane-test-edit-last-stops-a-streaming-pi-turn ()
  "`agentpane-edit-last' on a streaming Pi session takes the last message
back into the prompt region and aborts the turn at the press, as the
browser's Stop and edit does, after the points are matched and without
waiting on the abort to fill; a streaming Codex session is not aborted
(OW-relehi, D15).  Either way it reads the server's fork-points answer,
which the hint follows: until the turn's end it says a send stops it
(D30, ark3/agentpane#17)."
  (let ((filled (lambda (hint)
                  (list :draft "first draft" :index 0 :images nil :displaced ""
                        :separator (format "── editing “first draft” · C-RET %s · C-c C-k cancels ──" hint)))))
    (should (equal (agentpane-test--edit-last-streaming "pi")
                   (list '(sessions/forkPoints sessions/abort)
                         (funcall filled "stops the turn and forks there"))))
    (should (equal (agentpane-test--edit-last-streaming "codex")
                   (list '(sessions/forkPoints) (funcall filled "forks there"))))))

(ert-deftest agentpane-test-edit-hint-follows-the-turn-and-the-answer ()
  "An open edit's hint says a send stops the running turn only while the
fork-points answer said a fork of the session stops one, one is running,
and it is no compaction, and says so again at every status, as the
browser's primary button reads \"Stop and fork\" (D30,
ark3/agentpane#17).  Whatever the backend: the answer decides."
  (dolist (stops '(t nil))
    (let ((ref '(:backend "codex" :id "parent")))
      (agentpane-test--with-helper
        (agentpane-test--forking
            [(:id "entry-0" :text "first draft" :index 0)]
            '(:backend "codex" :id "fork")
          (agentpane-test--with-session ref
            (agentpane--draw (seq-take agentpane-test--two-asks 2))
            (setq agentpane--attached agentpane--connection
                  agentpane--handle "h1"
                  fork-stops stops)
            (agentpane-test--goto-index 0)
            (agentpane-edit)
            (let ((hint (lambda () (plist-get (agentpane-test--edit-snapshot) :separator)))
                  (status (lambda (streaming compaction)
                            (agentpane--on-notification
                             nil 'session/status
                             (list :view agentpane--view :session ref :handle "h1" :isStreaming (if streaming t :json-false)
                                   :compaction compaction :model nil)))))
              (should (string-search "C-RET forks there" (funcall hint)))
              (funcall status t nil)
              (should (string-search (if stops "C-RET stops the turn and forks there" "C-RET forks there")
                                     (funcall hint)))
              (funcall status t "running")
              (should (string-search "C-RET forks there" (funcall hint)))
              (funcall status nil nil)
              (should (string-search "C-RET forks there" (funcall hint))))))))))

(ert-deftest agentpane-test-edit-last-stops-nothing-idle-or-compacting ()
  "`agentpane-edit-last' on a Pi session that is not streaming, or that is
streaming through a compaction, aborts nothing, as the browser's Edit last
message, which it shows then in place of Stop and edit, does not
(`streamingAction' in src/client/App.svelte)."
  (dolist (compaction '("requesting" "running"))
    (should (equal (car (agentpane-test--edit-last-streaming "pi" t compaction))
                   '(sessions/forkPoints))))
  (should (equal (car (agentpane-test--edit-last-streaming "pi" 'idle))
                 '(sessions/forkPoints))))

(ert-deftest agentpane-test-edit-last-edits-a-recorded-node-not-yet-drawn ()
  "`agentpane-edit-last' pressed while a `session/node' for a newer user
message is recorded but not yet drawn edits that message, not the last one
drawn (`agentpane--record', OW-roveze)."
  (let ((ref '(:backend "codex" :id "parent")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          (vconcat agentpane-test--two-asks-points
                   [(:id "entry-4" :text "third draft" :index 4)])
          '(:backend "codex" :id "fork")
        (agentpane-test--with-session ref
          (agentpane--draw agentpane-test--two-asks)
          (setq agentpane--attached 'connection
                agentpane--handle "h1")
          (agentpane--on-notification
           nil 'session/node
           (list :view agentpane--view :session ref :handle "h1"
                 :node '(:index 4 :role "user"
                         :parts [(:type "text" :text "third draft"
                                  :html "<p>third draft</p>\n")])))
          (should (equal (agentpane-test--indices) '(0 1 2 3)))
          (agentpane-edit-last)
          (should (eql (plist-get agentpane--editing :index) 4))
          (should (equal (agentpane-test--draft) "third draft"))
          (agentpane-test--redraw buffer))))))

(ert-deftest agentpane-test-edit-last-leaves-the-state-edit-does ()
  "`agentpane-edit-last', from the transcript or from its composer, leaves
exactly the edit `agentpane-edit' on the last user message leaves, and
sends no more than it does (OW-relehi).  From the composer the edit opens
in the transcript's prompt region, and the transcript is shown."
  (let (snapshots requests)
    (dolist (how '(at-point last from-composer))
      (agentpane-test--with-helper
        (agentpane-test--forking
            agentpane-test--two-asks-points
            '(:backend "codex" :id "fork")
          (agentpane-test--with-session '(:backend "codex" :id "parent")
            (agentpane--draw agentpane-test--two-asks)
            (setq agentpane--attached 'connection
                  agentpane--handle "h1")
            (goto-char (point-max))
            (insert "a draft")
            (pcase how
              ('at-point (agentpane-test--goto-index 2) (agentpane-edit))
              ('last (agentpane-test--goto-index 0) (agentpane-edit-last))
              ('from-composer
               (let ((transcript (current-buffer)))
                 (agentpane-prompt)
                 (with-current-buffer (buffer-local-value 'agentpane--composer transcript)
                   (insert "composed")
                   (setq hold '(sessions/forkPoints))
                   (agentpane-edit-last)
                   ;; Shown at the press, not once the points answer.
                   (should (eq (window-buffer (selected-window)) transcript))
                   (select-window (get-buffer-window (current-buffer)))
                   (setq hold nil)
                   (funcall (cdr (pop held)) t)
                   (should (eq (window-buffer (selected-window)) (current-buffer)))
                   (should (equal (buffer-string) "composed")))
                 (set-buffer transcript))))
            (push (agentpane-test--edit-snapshot) snapshots)
            (push (mapcar #'car (reverse sent)) requests)))))
    (should (equal (car (last snapshots))
                   (list :draft "second draft" :index 2
                         :images '((:mimeType "image/png" :base64 "AAAA"))
                         :displaced "a draft"
                         :separator "── editing “second draft” · C-RET forks there · C-c C-k cancels ──")))
    (should (equal (delete-dups snapshots) (last snapshots)))
    (should (equal requests '((sessions/forkPoints) (sessions/forkPoints) (sessions/forkPoints))))))

(ert-deftest agentpane-test-edit-last-refused-when-the-last-is-not-a-fork-point ()
  "`agentpane-edit-last' whose last user message no fork point names edits
nothing, never an older message a point does name, says it is not
forkable, and stops no streaming Pi turn (OW-roveze); on a transcript
holding no user message it refuses and sends nothing."
  (let ((ref '(:backend "pi" :id "parent")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "entry-0" :text "first draft" :index 0)]
          '(:backend "pi" :id "fork")
        (agentpane-test--with-session ref
          (agentpane--draw agentpane-test--two-asks)
          (setq agentpane--attached 'connection
                agentpane--handle "h1")
          (agentpane--on-notification
           nil 'session/status (list :view agentpane--view :session ref :handle "h1" :isStreaming t :compaction nil :model nil))
          (agentpane-edit-last)
          (should (equal (mapcar #'car sent) '(sessions/forkPoints)))
          (should (seq-some (lambda (text) (string-search "not forkable" text)) said))
          (should-not agentpane--editing)
          (should (equal (agentpane-test--draft) ""))
          (setq sent nil)
          (agentpane--draw (seq-drop agentpane-test--two-asks 3))
          (should-error (agentpane-edit-last) :type 'user-error)
          (should-not sent))))))

(ert-deftest agentpane-test-edit-last-bound-where-a-prompt-is-typed ()
  "`agentpane-edit-last' is on `C-c C-e' in the transcript, the prompt region
included, whose map leaves it to fall through, and in the composer."
  (agentpane-test--with-session '(:backend "codex" :id "t1")
    (goto-char (point-max))
    (should (eq (key-binding (kbd "C-c C-e") t nil (point)) #'agentpane-edit-last))
    (agentpane-test--goto-index 0)
    (should (eq (key-binding (kbd "C-c C-e") t nil (point)) #'agentpane-edit-last)))
  (should (eq (lookup-key agentpane-composer-mode-map (kbd "C-c C-e")) #'agentpane-edit-last)))

;;;; Stopping a turn, against a stub connection

(ert-deftest agentpane-test-abort-puts-pis-queue-back-ahead-of-the-draft ()
  "`agentpane-abort' whose answer carries the prompts it took out of Pi's
queue (D16) puts them back in the prompt region, in order and ahead of the
text already there, blank lines between, as the browser's `withQueued'
joins them; a blank region takes them alone, and an answer of nil leaves
the region as it was (OW-seleri)."
  (dolist (case '(("my draft" (:queued ["first steer" "second steer"])
                   "first steer\n\nsecond steer\n\nmy draft")
                  ("  " (:queued ["first steer" "second steer"])
                   "first steer\n\nsecond steer")
                  ("my draft" nil "my draft")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (agentpane-test--with-session '(:backend "pi" :id "/s/parent.jsonl")
          (setq agentpane--attached 'connection
                agentpane--handle "h1"
                aborted (nth 1 case))
          (goto-char (point-max))
          (insert (nth 0 case))
          (agentpane-abort)
          (should (equal (mapcar #'car sent) '(sessions/abort)))
          (should (equal (agentpane-test--draft) (nth 2 case))))))))

(ert-deftest agentpane-test-edit-last-holds-pis-queue-out-of-the-edit ()
  "`agentpane-edit-last' on a streaming Pi session whose abort answers with
a prompt it took out of Pi's queue leaves the prompt region holding only
the edited message, the prompt waiting in this buffer until the edit ends
\(OW-seleri).  Cancelled, it lands ahead of the draft the edit displaced;
sent, the edit sends no stop of its own, the server's fork dropping what
its stop takes out, and the prompt lands in the region the edit's request
leaves here, ahead of the displaced draft as Cancel leaves them
\(OW-hakeno), the fork's own region left empty."
  (dolist (how '(cancel send))
    (let ((ref '(:backend "pi" :id "/s/parent.jsonl"))
          (forked '(:backend "pi" :id "/s/fork.jsonl")))
      (agentpane-test--with-helper
        (agentpane-test--forking
            [(:id "entry-0" :text "first draft" :index 0)]
            forked
          (agentpane-test--with-session ref
            (agentpane--draw (seq-take agentpane-test--two-asks 2))
            (setq agentpane--attached agentpane--connection
                  agentpane--handle "h1"
                  fork-stops t
                  aborted '(:queued ["steered"]))
            (agentpane--on-notification
             nil 'session/status (list :view agentpane--view :session ref :handle "h1" :isStreaming t :compaction nil :model nil))
            (goto-char (point-max))
            (insert "a draft")
            (agentpane-edit-last)
            (should (equal (mapcar #'car (reverse sent)) '(sessions/forkPoints sessions/abort)))
            (should (equal (agentpane-test--draft) "first draft"))
            (pcase how
              ('cancel
               (agentpane-cancel-edit)
               (should (equal (agentpane-test--draft) "steered\n\na draft")))
              ('send
               (agentpane-send)
               (should (= (agentpane-test--count 'sessions/abort sent) 1))
               (should (equal (plist-get (cdr (assq 'sessions/forkAndPrompt sent)) :text) "first draft"))
               (should-not agentpane--editing)
               (should (equal (agentpane-test--draft) "steered\n\na draft"))
               (with-current-buffer (agentpane--buffer-for forked)
                 (should (equal (agentpane-test--draft) "")))))))))))

(ert-deftest agentpane-test-stop-then-edit-keeps-pis-queue-through-the-fork ()
  "A stop, then `agentpane-edit-last' pressed before the stop answers, the
stop answering before the edit's fork points: what it took out of Pi's
queue lands in the prompt region ahead of the draft, the edit then
displaces both, and once the edit's send has forked and the fork's prompt
answered both come back, the stopped prompt ahead of the draft, as Cancel
would leave them (OW-kijuju, OW-hakeno)."
  (let ((ref '(:backend "pi" :id "/s/parent.jsonl"))
        (forked '(:backend "pi" :id "/s/fork.jsonl")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "entry-0" :text "first draft" :index 0)]
          forked
        (agentpane-test--with-session ref
          (agentpane--draw (seq-take agentpane-test--two-asks 2))
          (setq agentpane--attached agentpane--connection
                agentpane--handle "h1"
                hold '(sessions/abort sessions/forkPoints)
                fork-stops t
                aborted '(:queued ["steered"]))
          (agentpane--on-notification
           nil 'session/status (list :view agentpane--view :session ref :handle "h1" :isStreaming t :compaction nil :model nil))
          (goto-char (point-max))
          (insert "a draft")
          (agentpane-abort)
          (agentpane-edit-last)
          (should (equal (mapcar #'car held) '(sessions/abort sessions/forkPoints)))
          (funcall (cdr (pop held)) t)
          (should (equal (agentpane-test--draft) "steered\n\na draft"))
          (setq aborted nil)
          (funcall (cdr (pop held)) t)
          (should agentpane--editing)
          (should (equal (agentpane-test--draft) "first draft"))
          ;; The press's own abort, which finds the queue emptied.
          (setq hold nil)
          (while held (funcall (cdr (pop held)) t))
          (goto-char (point-max))
          (call-interactively (key-binding (kbd "C-<return>") t nil (point)))
          (should (equal (plist-get (cdr (assq 'sessions/forkAndPrompt sent)) :text) "first draft"))
          (should-not agentpane--editing)
          (should (equal (agentpane-test--draft) "steered\n\na draft")))))))

(ert-deftest agentpane-test-abort-during-an-edit-holds-pis-queue-out-of-it ()
  "`agentpane-abort' while the prompt region holds an edit, its answer
carrying a prompt it took out of Pi's queue, leaves the region holding
only the edited message, so the fork never sends that prompt as part of
the edit and Cancel never overwrites it; the prompt lands once the edit
ends, ahead of the draft the edit displaced, however the edit ends, as
after `agentpane-edit-last' (OW-seleri, OW-hakeno).  Two stops answering
while the edit is open land in the order they answered."
  (dolist (how '(cancel send))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "entry-0" :text "Fix the bug" :index 0)]
          '(:backend "pi" :id "/s/fork.jsonl")
        (agentpane-test--with-session '(:backend "pi" :id "/s/parent.jsonl")
          (agentpane--draw agentpane-test--image-nodes)
          (setq agentpane--attached 'connection
                agentpane--handle "h1")
          (goto-char (point-max))
          (insert "a draft")
          (agentpane-test--goto-index 0)
          (agentpane-edit)
          (setq aborted '(:queued ["steered"]))
          (agentpane-abort)
          (setq aborted '(:queued ["steered again"]))
          (agentpane-abort)
          (should (equal (agentpane-test--draft) "Fix the bug"))
          (pcase how
            ('cancel
             (agentpane-cancel-edit)
             (should (equal (agentpane-test--draft) "steered\n\nsteered again\n\na draft")))
            ('send
             (agentpane-send)
             (should (equal (plist-get (cdr (assq 'sessions/forkAndPrompt sent)) :text) "Fix the bug"))
             (should-not agentpane--editing)
             (should (equal (agentpane-test--draft) "steered\n\nsteered again\n\na draft")))))))))

(ert-deftest agentpane-test-edit-cancelled-mid-send-releases-pis-queue ()
  "What a stop took out of Pi's queue while an edit's send is in flight,
the edit then cancelled, lands once the send ends, whether its request
failed or answered: the cancel cannot release it while the buffer still
counts as sending (OW-seleri)."
  (dolist (ok '(nil t))
    (agentpane-test--editing "pi"
      (setq hold '(sessions/forkAndPrompt)
            aborted '(:queued ["steered"]))
      (agentpane-send)
      (agentpane-abort)
      (agentpane-cancel-edit)
      (should (equal (agentpane-test--draft) ""))
      (funcall (cdr (pop held)) ok)
      (should-not agentpane--sending)
      (should (equal (agentpane-test--draft) "steered")))))

(ert-deftest agentpane-test-abort-holds-pis-queue-behind-a-prompt-in-flight ()
  "`agentpane-abort' answering while a prompt from this buffer is still in
flight holds what it took out of Pi's queue until that prompt answers:
admitted, the sent text clears and the held prompt takes the region;
failed, the text stays and the held prompt lands ahead of it (OW-seleri)."
  (dolist (ok '(t nil))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (agentpane-test--with-session '(:backend "pi" :id "/s/parent.jsonl")
          (setq agentpane--attached 'connection
                agentpane--handle "h1"
                hold '(sessions/prompt)
                aborted '(:queued ["steered"]))
          (goto-char (point-max))
          (insert "hello")
          (agentpane-send)
          (agentpane-abort)
          (should (equal (agentpane-test--draft) "hello"))
          (funcall (cdr (pop held)) ok)
          (should (equal (agentpane-test--draft) (if ok "steered" "steered\n\nhello"))))))))

;;;; Sending, against a stub connection

(ert-deftest agentpane-test-one-send-at-a-time ()
  "A second `agentpane-send' while the first is in flight -- its prompt
unanswered, one attaching its session or one to the session attached --
says so and sends nothing, so the prompt goes out once; a send whose
prompt failed frees the buffer for another.  A detached buffer's send is
the one request (D30)."
  (let ((ref '(:backend "codex" :id "t1"))
        (agentpane--connection 'connection))
    (cl-letf (((symbol-function 'jsonrpc-running-p) (lambda (_) t)))
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          (let ((send (lambda ()
                        (condition-case err (progn (agentpane-send) nil)
                          (user-error err))))
                (release (lambda () (while held (funcall (cdr (pop held)) t))))
                (methods (lambda () (prog1 (mapcar #'car (reverse sent)) (setq sent nil)))))
            (setq hold '(sessions/attach sessions/prompt))
            (goto-char (point-max))
            ;; A previewed buffer: the first send, which attaches, has not answered.
            (insert "hello")
            (should-not (funcall send))
            (let ((second (funcall send)))
              (funcall release)
              (should (equal (funcall methods) '(sessions/prompt)))
              (should second))
            ;; Attached: the first send's prompt has not answered.
            (insert "more")
            (funcall send)
            (should (funcall send))
            (funcall release)
            (should (equal (funcall methods) '(sessions/prompt)))
            ;; A failed prompt that attaches, then a failed one to the
            ;; attached session, each free the buffer.
            (setq agentpane--attached nil)
            (insert "again")
            (funcall send)
            (funcall (cdr (pop held)) nil)
            (should-not (funcall send))
            (funcall release)
            (should (equal (funcall methods) '(sessions/prompt sessions/prompt)))
            (insert "last")
            (funcall send)
            (funcall (cdr (pop held)) nil)
            (should-not (funcall send))
            (funcall release)
            (should (equal (funcall methods) '(sessions/prompt sessions/prompt)))))))))

(defmacro agentpane-test--sending-detached (&rest body)
  "Run BODY in a transcript buffer for the session `ref', not attached and
holding no handle, typed \"hello\" into, with every request answered as
`agentpane-test--forking' answers it, an attach or a prompt naming no
handle under the handle \"h1\", and no turn watched or marked done."
  (declare (indent 0))
  `(let ((ref '(:backend "codex" :id "t1")))
     (agentpane-test--watching
       (agentpane-test--with-helper
         (agentpane-test--forking nil nil
           (agentpane-test--with-session ref
             (setq attached (list :ref ref :handle "h1"))
             (goto-char (point-max))
             (insert "hello")
             ,@body))))))

(ert-deftest agentpane-test-detached-send-is-one-prompt ()
  "A send from a buffer not attached is one `sessions/prompt' not marked
`live' (D30), which the helper sends by ref: the snapshot under the
buffer's view attaches it, and the reply frees the buffer."
  (agentpane-test--sending-detached
    (setq hold '(sessions/prompt))
    (agentpane-send)
    (should (equal sent `((sessions/prompt :session ,ref :view ,agentpane--view :text "hello" :priorErrorId nil))))
    (should agentpane--sending)
    (agentpane--on-notification
     agentpane--connection 'session/snapshot
     (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false :nodes []))
    (should (agentpane--attached-p))
    (should (equal agentpane--handle "h1"))
    (should agentpane--sending)
    (funcall (cdr (pop held)) t)
    (should-not agentpane--sending)
    (should (equal (agentpane-test--draft) ""))))

(ert-deftest agentpane-test-detached-send-handled-says-so ()
  "A detached buffer's prompt the backend handled attaches the buffer and
says no turn was started, as an attached buffer's does (OW-yobayi, D30)."
  (agentpane-test--sending-detached
    (setq prompted '(:disposition "handled"))
    (agentpane-send)
    (should (agentpane--attached-p))
    (should agentpane--handled)
    (should (equal (agentpane-test--draft) ""))))

(ert-deftest agentpane-test-detached-send-refused-keeps-its-text ()
  "A detached buffer's prompt the server refused after attaching its
session keeps its text, frees the buffer, and leaves it attached by the
snapshot under its view, the refusal naming that session.  One refused
with nothing attached leaves the buffer not attached (D30)."
  (agentpane-test--sending-detached
    (setq hold '(sessions/prompt))
    (agentpane-send)
    (funcall (cdr (pop held))
             (list :error "backend_refused" :detail "not now"
                   :attached (list :ref ref :handle "h1")))
    (should (agentpane--attached-p))
    (should (equal agentpane--handle "h1"))
    (should-not agentpane--sending)
    (should (equal (agentpane-test--draft) "hello")))
  (agentpane-test--sending-detached
    (setq hold '(sessions/prompt))
    (agentpane-send)
    (funcall (cdr (pop held)) (list :error "internal_error" :detail "would not start"))
    (should-not (agentpane--attached-p))
    (should-not agentpane--sending)
    (should (equal (agentpane-test--draft) "hello"))))

(ert-deftest agentpane-test-detached-send-refused-while-a-plain-fork-is-out ()
  "A detached buffer's send attaches its session, so it is refused, sending
nothing and leaving the buffer free, while a plain fork is in flight, as
an attach is (`agentpane--refuse-forking').  Neither a close nor an
edit's fork in flight refuses it here since ark3/agentpane#71: the
server waits a close's disposal out (D32 point 5), and the helper
refuses an attach of a session an edit forks (D32 point 4)."
  (agentpane-test--sending-detached
    (setq agentpane--forking t)
    (should-error (agentpane-send) :type 'user-error)
    (should-not sent)
    (should-not agentpane--sending)))

(ert-deftest agentpane-test-send-while-attaching-goes-out-at-once ()
  "A send while the buffer's own attach is in flight goes out at once, one
prompt not marked `live', which the helper waits to send on that attach
and then sends under the handle it bound (D32 point 4).  Until
ark3/agentpane#71 the buffer waited on its attach itself, and sent a
prompt marked `live' once it had answered."
  (agentpane-test--sending-detached
    (setq hold '(sessions/attach sessions/prompt))
    (agentpane-attach)
    (agentpane-send)
    (should (equal (reverse sent)
                   `((sessions/attach :session ,ref :view ,agentpane--view)
                     (sessions/prompt :session ,ref :view ,agentpane--view :text "hello"
                                      :priorErrorId nil))))
    (funcall (cdr (pop held)) t)
    (should (equal agentpane--handle "h1"))
    (should agentpane--sending)
    (funcall (cdr (pop held)) t)
    (should-not agentpane--sending)
    (should (equal (agentpane-test--draft) ""))))

(ert-deftest agentpane-test-prompt-answer-keeps-the-drawn-error ()
  "A prompt's answer leaves the turn error drawn when it was sent, through
the attach a detached buffer's prompt makes and the snapshots that redraw
it meanwhile, and the
`session/errorCleared' the server broadcasts at the prompt's admission is
what drops it: the server owns the error (OW-lohubo)."
  (let ((ref '(:backend "claude" :id "c1"))
        (snapshot (lambda (ref)
                    (agentpane--on-notification
                     agentpane--connection 'session/snapshot
                     (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false
                           :nodes agentpane-test--nodes
                           :error (copy-sequence "Turn failed upstream")
                           :notices [])))))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          ;; Drawn while attached, and let go of since, so the send attaches.
          (funcall snapshot ref)
          (agentpane--on-notification agentpane--connection 'session/detached
                                      (list :view agentpane--view :session ref :handle "h1"))
          (setq hold '(sessions/prompt))
          (goto-char (point-max))
          (insert "hello")
          (agentpane-send)
          (funcall snapshot ref)
          (funcall snapshot ref)
          (funcall (cdr (pop held)) t)
          (should (equal (mapcar #'car (reverse sent)) '(sessions/prompt)))
          (should (equal (agentpane-test--warnings) '("Turn failed upstream")))
          (agentpane--on-notification nil 'session/errorCleared (list :view agentpane--view :session ref :handle "h1"))
          (should (equal (agentpane-test--indices) '(0 1)))
          (should-not (agentpane-test--warnings)))))))

(ert-deftest agentpane-test-prompt-names-the-error-held-at-the-send ()
  "A prompt carries the `errorId' of the turn error the buffer held when it
was sent, so admitting it clears that one and no newer one (OW-jokoto),
and from an attached buffer the handle it holds, so it goes only to the
live session under it (D30)."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection
                agentpane--handle "h1")
          (agentpane--on-notification
           nil 'session/error (list :view agentpane--view :session ref :handle "h1" :message "Turn failed upstream" :errorId "e5"))
          (goto-char (point-max))
          (insert "hello")
          (agentpane-send)
          (should (equal sent `((sessions/prompt :session ,ref :view ,agentpane--view :live t :text "hello"
                                                 :priorErrorId "e5")))))))))

(ert-deftest agentpane-test-prompt-names-no-error-its-own-attach-drew ()
  "The first prompt on a previewed transcript names the error the buffer
held at the send, none, and not one the attach it makes drew from its
snapshot: an error the session's start raised is newer than the prompt,
so admitting it must not clear it (OW-jokoto, OW-bomolu).  It is not
marked `live', so the helper sends it by ref, attaching as it goes (D30)."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          (setq hold '(sessions/prompt))
          (goto-char (point-max))
          (insert "hello")
          (agentpane-send)
          (agentpane--on-notification
           agentpane--connection 'session/snapshot
           (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false :nodes agentpane-test--nodes
                 :error "extension failed to load" :errorId "e9" :notices []))
          (funcall (cdr (pop held)) t)
          (should (equal sent `((sessions/prompt :session ,ref :view ,agentpane--view :text "hello"
                                                 :priorErrorId nil))))
          (should (equal (agentpane-test--warnings) '("extension failed to load"))))))))

(ert-deftest agentpane-test-prompt-answer-keeps-an-error-with-the-held-text ()
  "A turn error the new turn raised before its prompt's answer survives
that answer though its text is the one held when the prompt was sent: the
server cleared the old one and holds the new one, so every other client
shows it, and so does this buffer (OW-lohubo)."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection
                agentpane--handle "h1")
          (agentpane--on-notification
           agentpane--connection 'session/snapshot
           (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false :nodes agentpane-test--nodes
                 :error "Turn failed upstream" :notices []))
          (setq hold '(sessions/prompt))
          (goto-char (point-max))
          (insert "hello")
          (agentpane-send)
          (agentpane--on-notification nil 'session/errorCleared (list :view agentpane--view :session ref :handle "h1"))
          (agentpane--on-notification
           nil 'session/error (list :view agentpane--view :session ref :handle "h1" :message "Turn failed upstream"))
          (funcall (cdr (pop held)) t)
          (should (equal (agentpane-test--indices) '(0 1 nil)))
          (should (equal (agentpane-test--warnings) '("Turn failed upstream"))))))))

(ert-deftest agentpane-test-error-resent-in-flight-survives-the-answer ()
  "An error held when the prompt was sent, and replaced before it, that
arrives again while the prompt is in flight is the one the server holds,
and survives the answer: `submit' in src/server/http/session-manager.ts
clears the held error only if it is still the one that stood at the send,
and here it is not (OW-sedosu)."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection
                agentpane--handle "h1")
          (agentpane--on-notification
           nil 'session/error (list :view agentpane--view :session ref :handle "h1" :message "Turn failed upstream"))
          (agentpane--on-notification
           nil 'session/error (list :view agentpane--view :session ref :handle "h1" :message "Turn failed again"))
          (setq hold '(sessions/prompt))
          (goto-char (point-max))
          (insert "hello")
          (agentpane-send)
          (agentpane--on-notification
           nil 'session/error (list :view agentpane--view :session ref :handle "h1" :message "Turn failed upstream"))
          (funcall (cdr (pop held)) t)
          (should (equal (agentpane-test--warnings) '("Turn failed upstream"))))))))

(ert-deftest agentpane-test-stale-snapshot-redraws-the-cleared-error ()
  "A snapshot handled after the prompt's answer, broadcast before the
server cleared the error, draws that error, which the answer left standing
\(OW-lohubo), and the `session/errorCleared' the clearing broadcast,
handled after it, takes it down: the buffer keeps no send-time state to
second-guess a snapshot (OW-sedosu, OW-jopifu)."
  (let ((ref '(:backend "codex" :id "t1"))
        (snapshot (lambda (ref error)
                    (agentpane--on-notification
                     agentpane--connection 'session/snapshot
                     (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false :nodes agentpane-test--nodes
                           :error error :notices [])))))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection
                agentpane--handle "h1")
          (funcall snapshot ref "Turn failed upstream")
          (setq hold '(sessions/prompt))
          (goto-char (point-max))
          (insert "hello")
          (agentpane-send)
          (funcall (cdr (pop held)) t)
          (should (equal (agentpane-test--warnings) '("Turn failed upstream")))
          (funcall snapshot ref "Turn failed upstream")
          (should (equal (agentpane-test--warnings) '("Turn failed upstream")))
          (agentpane--on-notification nil 'session/errorCleared (list :view agentpane--view :session ref :handle "h1"))
          (should-not (agentpane-test--warnings)))))))

(ert-deftest agentpane-test-refetch-while-attaching-keeps-the-live-transcript ()
  "A refetch while a previewed buffer's first prompt, which attaches its
session (D30), is in flight sends a preview, whose answer draws nothing
once the attach's snapshot has attached the buffer, as the browser's
`landPreview' ignores a pane gone live, so the stored transcript is never
drawn over the live one (OW-yibimi); nor does a `gone' from it kill the
buffer.  Until ark3/agentpane#71 the refetch said the buffer was still
attaching and sent nothing.  Once that prompt has failed, a refetch
reads the stored transcript again."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          (setq hold '(sessions/prompt sessions/preview))
          (goto-char (point-max))
          (insert "hello")
          (agentpane-send)
          (agentpane-refetch)
          (agentpane-refetch)
          (should (equal (mapcar #'car (reverse sent))
                         '(sessions/prompt sessions/preview sessions/preview)))
          (agentpane--on-notification
           agentpane--connection 'session/snapshot
           (list :view agentpane--view :session ref :handle "h1" :nodes (vector (agentpane-test--assistant 5 "<p>Live.</p>"))
                 :isStreaming :json-false :compaction nil :model nil))
          ;; Held in the order sent, the prompt then the previews: the last
          ;; preview answers, then the other is `gone', then the prompt.
          (funcall (cdr (nth 2 held)) t)
          (funcall (cdr (nth 1 held)) '(:error "gone"))
          (funcall (cdr (nth 0 held)) t)
          (setq held nil)
          (should (buffer-live-p buffer))
          (should (equal (agentpane-test--indices) '(5)))
          ;; Let go of, as a gap leaves it.
          (agentpane--let-go)
          (insert "again")
          (agentpane-send)
          (funcall (cdr (pop held)) nil)
          (setq sent nil)
          (agentpane-refetch)
          (should (equal (mapcar #'car sent) '(sessions/preview))))))))

;;;; Killing a transcript buffer, against a stub connection

(ert-deftest agentpane-test-kill-detaches-the-session ()
  "Killing a transcript buffer while a helper is running sends
`sessions/detach' naming its view and nothing else, so the helper stops its
notifications and the session keeps running: whether the session is
attached, attaching, or its attach failed on this side, as a timeout does
while the helper's attach goes on to succeed.  With no helper running a
kill sends nothing."
  (let ((ref '(:backend "codex" :id "t1"))
        (agentpane--connection 'connection))
    (cl-letf (((symbol-function 'jsonrpc-running-p) (lambda (_) t)))
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          (agentpane--attach)
          (setq sent nil)
          (let ((view agentpane--view))
            (kill-buffer buffer)
            (should (equal sent `((sessions/detach :session ,ref :view ,view))))))
        (agentpane-test--with-session ref
          (setq hold '(sessions/attach))
          (agentpane--attach)
          (setq sent nil)
          (let ((view agentpane--view))
            (kill-buffer buffer)
            (should (equal sent `((sessions/detach :session ,ref :view ,view))))))
        (setq held nil)
        (agentpane-test--with-session ref
          (setq hold '(sessions/attach))
          (agentpane--attach)
          (funcall (cdr (pop held)) nil)
          (setq sent nil)
          (let ((view agentpane--view))
            (kill-buffer buffer)
            (should (equal sent `((sessions/detach :session ,ref :view ,view))))))
        (agentpane-test--with-session ref
          (setq sent nil)
          (let ((agentpane--connection nil))
            (kill-buffer buffer))
          (should-not sent))))))

(ert-deftest agentpane-test-kill-completes-when-the-detach-signals ()
  "A detach that signals, as a send to a pipe that has just broken does,
does not stop the transcript buffer from being killed."
  (let ((agentpane--connection 'connection))
    (cl-letf (((symbol-function 'jsonrpc-running-p) (lambda (_) t))
              ((symbol-function 'agentpane--request)
               (lambda (&rest _) (error "Process agentpane helper not running")))
              ((symbol-function 'message) #'ignore))
      (agentpane-test--with-session '(:backend "codex" :id "t1")
        (setq agentpane--attached agentpane--connection
              agentpane--handle "h1")
        (kill-buffer buffer)
        (should-not (buffer-live-p buffer))))))

;;;; A preview answered `gone'

(ert-deftest agentpane-test-preview-gone-kills-the-buffer-keeping-its-text ()
  "A `sessions/preview' answered with an error whose `data' carries
`error: \"gone\"' (D26) kills the buffer it previews into, whichever path
sent it -- `g' in a buffer not attached, or opening the session's row
from the picker, into a buffer not yet drawn -- the prompt region's text
going to the head of the kill ring first, as a close's preview does.
One answered with any other error leaves the buffer and its text."
  (let ((ref '(:backend "codex" :id "t1"))
        (kill-ring nil)
        (kill-ring-yank-pointer nil)
        (interprogram-cut-function nil)
        (interprogram-paste-function nil))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (setq hold '(sessions/preview))
        (let ((buffer (agentpane--transcript-buffer (list :ref ref))))
          (with-current-buffer buffer
            (agentpane--draw agentpane-test--nodes)
            (goto-char (point-max))
            (insert "half a thought")
            (agentpane-refetch))
          (should (equal sent `((sessions/preview :session ,ref))))
          (funcall (cdr (pop held)) '(:error "internal"))
          (should (buffer-live-p buffer))
          (should-not kill-ring)
          (with-current-buffer buffer (agentpane-refetch))
          (funcall (cdr (pop held)) '(:error "gone"))
          (should-not (buffer-live-p buffer))
          (should (equal (car kill-ring) "half a thought")))
        (setq sent nil)
        (save-window-excursion (agentpane-show-transcript (list :ref ref)))
        (let ((buffer (agentpane--buffer-for ref)))
          (should buffer)
          (should (equal sent `((sessions/preview :session ,ref))))
          (funcall (cdr (pop held)) '(:error "gone"))
          (should-not (buffer-live-p buffer))
          (should (equal (car kill-ring) "half a thought")))))))

(ert-deftest agentpane-test-preview-gone-kills-only-as-the-latest-request ()
  "Through `agentpane--request' itself: a preview the helper answers with
an error other than `gone' leaves the buffer, the echo area saying the
preview failed; one answered `gone' after the buffer has sent a later
request kills nothing, the later request's answer being the one it
wants, as a superseded preview's nodes are not drawn; and the latest
one's `gone', carried in the error's `data', kills it."
  (let ((ref '(:backend "codex" :id "t1"))
        (agentpane--connection 'connection)
        (sent nil)
        (ids 0)
        (said nil)
        (gone '(:code -32000 :message "No such session" :data (:error "gone"))))
    (cl-letf (((symbol-function 'jsonrpc-running-p) (lambda (_) t))
              ((symbol-function 'jsonrpc-async-request)
               (lambda (_connection method _params &rest args)
                 (push (cons method (plist-get args :error-fn)) sent)
                 (list (cl-incf ids))))
              ((symbol-function 'message)
               (lambda (format-string &rest args)
                 (push (apply #'format format-string args) said))))
      (agentpane-test--with-session ref
        (agentpane-refetch)
        (funcall (cdr (pop sent))
                 '(:code -32000 :message "Boom" :data (:error "internal_error")))
        (should (buffer-live-p buffer))
        (should (seq-some (lambda (text) (string-search "sessions/preview failed" text)) said))
        (agentpane-refetch)
        (let ((superseded (cdr (pop sent))))
          (agentpane-refetch)
          (funcall superseded gone)
          (should (buffer-live-p buffer))
          (funcall (cdr (pop sent)) gone)
          (should-not (buffer-live-p buffer)))))))

;;;; Opening a subagent's child thread, against a stub connection

(defun agentpane-test--subagent (index &rest ids)
  "An assistant node at INDEX whose one part is a Codex `subagent' call
naming the child threads IDS, as the helper projects it (OW-gakide)."
  (list :index index :role "assistant"
        :parts (vector (append (list :type "tool" :name "subagent" :summary "wait"
                                     :args "" :result "" :state "ok")
                               (and ids (list :threadIds (vconcat ids)))))
        :meta '(:model "luna" :usage (:totalTokens 1 :cost 0))))

(ert-deftest agentpane-test-open-thread-from-a-live-buffer ()
  "`agentpane-open-thread' on an attached buffer's subagent call naming one
child thread asks nothing, and opens the child as the picker opens a
session: `sessions/preview' for the child's Codex ref, into a buffer of
its own, leaving the parent attached (OW-gakide)."
  (let ((ref '(:backend "codex" :id "t1"))
        (child '(:backend "codex" :id "child-1")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (cl-letf (((symbol-function 'jsonrpc-async-request) #'ignore)
                  ((symbol-function 'completing-read)
                   (lambda (&rest _) (error "Asked with one thread to open"))))
          (setq attached (list :ref ref :handle "h1"))
          (let ((buffer (agentpane--transcript-buffer (list :ref ref))))
            (with-current-buffer buffer (agentpane--attach))
            (agentpane--on-notification
             agentpane--connection 'session/snapshot
             (list :view (agentpane-test--view buffer) :session ref :handle "h1" :isStreaming :json-false
                   :nodes (vector (agentpane-test--subagent 1 "child-1"))))
            (setq sent nil)
            (with-current-buffer buffer
              (should (agentpane--attached-p))
              (agentpane-test--goto-index 1)
              (agentpane-open-thread))
            (should (equal sent `((sessions/preview :session ,child))))
            (let ((opened (agentpane--buffer-for child)))
              (should opened)
              (should-not (eq opened buffer))
              (should (eq (window-buffer) opened)))
            (with-current-buffer buffer
              (should (agentpane--attached-p)))))))))

(ert-deftest agentpane-test-open-thread-from-a-preview-buffer ()
  "`agentpane-open-thread' works in a previewed transcript as in a live one:
on a subagent call naming two child threads it reads one with completion,
offering both, and sends `sessions/preview' for that child's Codex ref.
On a node naming none it refuses, sending nothing (OW-gakide)."
  (let ((ref '(:backend "codex" :id "t1"))
        (offered nil))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (cl-letf (((symbol-function 'completing-read)
                   (lambda (_prompt collection &rest _)
                     (setq offered collection)
                     "child-2")))
          (let ((buffer (agentpane--transcript-buffer (list :ref ref))))
            (with-current-buffer buffer
              (agentpane--draw (vector (agentpane-test--assistant 0 "<p>Spawning.</p>")
                                       (agentpane-test--subagent 1 "child-1" "child-2")
                                       (agentpane-test--subagent 2)))
              (should-not (agentpane--attached-p))
              (agentpane-test--goto-index 0)
              (should-error (agentpane-open-thread) :type 'user-error)
              (agentpane-test--goto-index 2)
              (should-error (agentpane-open-thread) :type 'user-error)
              (should-not sent)
              (agentpane-test--goto-index 1)
              (agentpane-open-thread))
            (should (equal offered '("child-1" "child-2")))
            (should (equal sent '((sessions/preview :session (:backend "codex" :id "child-2")))))
            (should (agentpane--buffer-for '(:backend "codex" :id "child-2")))))))))

;;;; Closing a session, against a stub connection

(defmacro agentpane-test--closing (&rest body)
  "Run BODY in a transcript buffer `buffer' attached to the Codex session
`ref' under the handle \"h1\" through a helper that counts as running,
drawn by a snapshot under that handle as the node at index 5 alone, idle
on the model \"luna\".  Every request is answered as
`agentpane-test--forking' answers it, and `sent' starts empty."
  (declare (indent 0))
  `(let ((ref '(:backend "codex" :id "t1")))
     (agentpane-test--with-helper
       (agentpane-test--forking nil nil
         (setq attached (list :ref ref :handle "h1"))
         (let ((buffer (agentpane--transcript-buffer (list :ref ref))))
           (with-current-buffer buffer (agentpane--attach))
           (agentpane--on-notification
            agentpane--connection 'session/snapshot
            (list :view (agentpane-test--view buffer) :session ref :handle "h1" :isStreaming :json-false :model "luna"
                  :nodes (vector (agentpane-test--assistant 5 "<p>Live.</p>"))))
           (setq sent nil)
           ,@body)))))

(ert-deftest agentpane-test-close-session-closes-it-onto-its-preview ()
  "`agentpane-close-session' on an idle attached session sends
`sessions/close' under the buffer's handle, as the browser's Tools Detach
sends its DELETE, and once it answers leaves the buffer holding no handle
and unattached, and redrawn from
its `sessions/preview', as the browser lands on the read-only preview,
asking no `sessions/list' first (D26).  A kill after that detaches its
view alone, which the helper holds no binding for since the `ended'."
  (agentpane-test--closing
    (with-current-buffer buffer
      (agentpane-close-session)
      (should (equal (reverse sent)
                     `((sessions/close :session ,ref :view ,agentpane--view)
                       (sessions/preview :session ,ref))))
      (should-not agentpane--handle)
      (should-not (agentpane--attached-p))
      (should (equal (agentpane-test--indices)
                     (mapcar (lambda (node) (plist-get node :index)) agentpane-test--nodes)))
      (setq sent nil)
      (let ((view agentpane--view))
        (kill-buffer buffer)
        (should (equal sent `((sessions/detach :session ,ref :view ,view))))))))

(ert-deftest agentpane-test-close-session-detached-meanwhile-previews ()
  "A `session/detached' for the handle while the close is out -- the
server has let go of the session before its subprocess is disposed of,
and its `ended' reached the helper ahead of the close's answer --
still leaves the buffer previewing the stored transcript once the close
answers, rather than attaching again the session just closed."
  (agentpane-test--closing
    (setq hold '(sessions/close))
    (with-current-buffer buffer
      (agentpane-close-session)
      (agentpane--on-notification nil 'session/detached (list :view agentpane--view :session ref :handle "h1"))
      (funcall (cdr (pop held)) t)
      (should (equal (reverse sent)
                     `((sessions/close :session ,ref :view ,agentpane--view)
                       (sessions/preview :session ,ref)))))))

(ert-deftest agentpane-test-close-session-whose-preview-is-gone-kills-the-buffer ()
  "A session with nothing on disk after the close -- one created or forked
and never prompted -- has nothing to preview, and the preview after the
close answers `gone' (D26), which kills the buffer, as the browser lands
on its startup view, where until OW-vugefa a listing asked after the
close said so, and a listing that failed left the buffer holding a ref
it could only attach in vain (OW-vetebu).  The kill detaches its view
alone."
  (agentpane-test--closing
    (let ((view (agentpane-test--view buffer)))
      (setq hold '(sessions/preview))
      (with-current-buffer buffer
        (agentpane-close-session))
      (funcall (cdr (pop held)) '(:error "gone"))
      (should-not (buffer-live-p buffer))
      (should (equal (reverse sent)
                     `((sessions/close :session ,ref :view ,view)
                       (sessions/preview :session ,ref)
                       (sessions/detach :session ,ref :view ,view)))))))

(ert-deftest agentpane-test-close-session-whose-preview-is-gone-keeps-the-draft ()
  "The kill of a buffer whose preview after the close answers `gone' puts
what the user typed in its prompt region on the kill ring, the echo area
saying so, as the browser's draft survives its Detach (OW-watawe).  An
empty region puts nothing there."
  (let ((kill-ring nil)
        (kill-ring-yank-pointer nil)
        (interprogram-cut-function nil)
        (interprogram-paste-function nil))
    (agentpane-test--closing
      (setq hold '(sessions/preview))
      (with-current-buffer buffer
        (agentpane-close-session))
      (funcall (cdr (pop held)) '(:error "gone"))
      (should-not (buffer-live-p buffer))
      (should-not kill-ring))
    (agentpane-test--closing
      (setq hold '(sessions/preview))
      (with-current-buffer buffer
        (goto-char (point-max))
        (insert "half a thought")
        (agentpane-close-session))
      (funcall (cdr (pop held)) '(:error "gone"))
      (should-not (buffer-live-p buffer))
      (should (equal kill-ring '("half a thought")))
      (should (seq-some (lambda (text) (string-search "kill ring" text)) said)))))

(ert-deftest agentpane-test-close-session-whose-preview-is-gone-keeps-an-edit ()
  "With an edit open (`agentpane-edit'), as on a fork closed before its
first turn, the kill puts both the edit's text, the user's changes and
all, and the draft the edit displaced on the kill ring, the draft last,
so that `yank' brings back what the user was writing (OW-watawe)."
  (let ((kill-ring nil)
        (kill-ring-yank-pointer nil)
        (interprogram-cut-function nil)
        (interprogram-paste-function nil))
    (agentpane-test--closing
      (setq hold '(sessions/preview))
      (with-current-buffer buffer
        (goto-char (point-max))
        (insert "my draft")
        (agentpane--start-edit (aref agentpane-test--nodes 0))
        (goto-char (point-max))
        (insert " now")
        (agentpane-close-session))
      (funcall (cdr (pop held)) '(:error "gone"))
      (should-not (buffer-live-p buffer))
      (should (equal kill-ring '("my draft" "Fix the bug now"))))))

(ert-deftest agentpane-test-close-session-whose-preview-is-gone-kills-the-composer-keeping-its-text ()
  "The kill of a buffer whose preview after the close answers `gone' kills
its composer too, the composer's text going on the kill ring before the
prompt region's, so that `yank' brings back the region's and `yank-pop'
the composer's, the echo area saying why the buffer went and that its
text is on the kill ring, as it does when only the composer held any
(OW-sihoma)."
  (let ((kill-ring nil)
        (kill-ring-yank-pointer nil)
        (interprogram-cut-function nil)
        (interprogram-paste-function nil))
    (agentpane-test--closing
      (setq hold '(sessions/preview))
      (let ((composer (with-current-buffer buffer
                        (save-current-buffer (agentpane-prompt))
                        agentpane--composer)))
        (with-current-buffer composer (insert "composed"))
        (with-current-buffer buffer
          (goto-char (point-max))
          (insert "half a thought")
          (agentpane-close-session))
        (funcall (cdr (pop held)) '(:error "gone"))
        (should-not (buffer-live-p buffer))
        (should-not (buffer-live-p composer))
        (should (equal kill-ring '("half a thought" "composed")))
        (should (string-search "is gone" (car said)))
        (should (string-search "kill ring" (car said)))))
    (setq kill-ring nil)
    (agentpane-test--closing
      (setq hold '(sessions/preview))
      (let ((composer (with-current-buffer buffer
                        (save-current-buffer (agentpane-prompt))
                        agentpane--composer)))
        (with-current-buffer composer (insert "composed"))
        (with-current-buffer buffer (agentpane-close-session))
        (funcall (cdr (pop held)) '(:error "gone"))
        (should-not (buffer-live-p composer))
        (should (equal kill-ring '("composed")))
        (should (string-search "is gone" (car said)))
        (should (string-search "kill ring" (car said)))))))

(ert-deftest agentpane-test-close-session-whose-preview-fails-keeps-the-buffer ()
  "A preview after the close that fails other than `gone' leaves the
buffer as it is, holding no handle, so it previews its session again at
`g'; its prompt region keeps its text."
  (agentpane-test--closing
    (setq hold '(sessions/preview))
    (with-current-buffer buffer
      (goto-char (point-max))
      (insert "hello")
      (agentpane-close-session)
      (funcall (cdr (pop held)) '(:error "internal")))
    (should (buffer-live-p buffer))
    (with-current-buffer buffer
      (should (equal (buffer-substring-no-properties agentpane--prompt-start (point-max))
                     "hello"))
      (setq sent nil)
      (agentpane-refetch)
      (should (equal sent `((sessions/preview :session ,ref)))))))

(ert-deftest agentpane-test-close-session-that-fails-leaves-the-buffer-attached ()
  "A `sessions/close' that fails leaves the buffer attached under its handle,
previewing nothing, as the browser's Detach leaves its live view."
  (agentpane-test--closing
    (setq hold '(sessions/close))
    (with-current-buffer buffer
      (agentpane-close-session)
      (funcall (cdr (pop held)) nil)
      (should (equal agentpane--handle "h1"))
      (should (agentpane--attached-p))
      (should (equal (mapcar #'car sent) '(sessions/close))))))

(ert-deftest agentpane-test-close-session-that-fails-frees-the-buffer ()
  "A `sessions/close' that fails ends the close in flight, so the buffer,
left as it was, attaches again at `g' and can be closed again."
  (agentpane-test--closing
    (setq hold '(sessions/close))
    (with-current-buffer buffer
      (agentpane-close-session)
      (funcall (cdr (pop held)) nil)
      (setq sent nil)
      (agentpane-refetch)
      (agentpane-close-session)
      (should (equal (mapcar #'car (reverse sent))
                     '(sessions/attach sessions/close))))))

(ert-deftest agentpane-test-close-session-sent-while-an-attach-is-out ()
  "A close pressed on an attached buffer whose `g' has an attach out is
sent, as the browser's Detach is with a request still out: the attach,
reaching the server while the close disposes of the session, waits that
out and starts a fresh agent (D32 point 5).  Until ark3/agentpane#71 it
was refused."
  (agentpane-test--closing
    (setq hold '(sessions/attach sessions/close))
    (with-current-buffer buffer
      (agentpane-refetch)
      (should (equal (mapcar #'car sent) '(sessions/attach)))
      (agentpane-close-session)
      (should (equal (mapcar #'car (reverse sent)) '(sessions/attach sessions/close))))))

(ert-deftest agentpane-test-close-session-sent-again-while-the-first-is-out ()
  "A second close pressed while the first is out, before the
`session/detached' its `ended' brings, is sent too, as nothing in the
browser refuses one (D32 point 5); and once that has come, the buffer is
not attached, and a send goes out by ref, the user asking for the
session back.  Until ark3/agentpane#71 the buffer refused both while its
close was in flight."
  (agentpane-test--closing
    (setq hold '(sessions/close))
    (with-current-buffer buffer
      (agentpane-close-session)
      (agentpane-close-session)
      (should (equal (mapcar #'car sent) '(sessions/close sessions/close)))
      (agentpane--on-notification nil 'session/detached (list :view agentpane--view :session ref :handle "h1"))
      (setq sent nil)
      (goto-char (point-max))
      (insert "hello")
      (agentpane-send)
      (should (equal sent `((sessions/prompt :session ,ref :view ,agentpane--view
                                             :text "hello" :priorErrorId nil)))))))

(ert-deftest agentpane-test-close-session-answer-keeps-a-buffer-attached-since ()
  "A close's answer lets go of the handle it closed only where the
`session/detached' has not, and never of one the buffer attached since
under another handle, which it neither unbinds nor previews over."
  (agentpane-test--closing
    (setq hold '(sessions/close))
    (with-current-buffer buffer
      (agentpane-close-session)
      (agentpane--on-notification nil 'session/detached (list :view agentpane--view :session ref :handle "h1"))
      (setq attached (list :ref ref :handle "h2"))
      (agentpane-attach)
      (should (equal agentpane--handle "h2"))
      (setq sent nil)
      (funcall (cdr (pop held)) t)
      (should (equal agentpane--handle "h2"))
      (should (agentpane--attached-p))
      (should-not sent))))

(ert-deftest agentpane-test-send-refused-during-a-compaction ()
  "A send, plain or an edit's, while the status reports a compaction,
`requesting' or `running', is refused and sends nothing, keeping its
text, as the browser holds Send and Fork until it ends (`send' in
src/client/App.svelte, OW-natiha); once a status says it has ended, the
send goes out.  Until ark3/agentpane#71 agentpane-mode sent it."
  (dolist (compaction '("requesting" "running"))
    (agentpane-test--closing
      (with-current-buffer buffer
        (agentpane--on-notification
         nil 'session/status
         (list :view agentpane--view :session ref :handle "h1" :isStreaming t
               :compaction compaction :model "luna"))
        (goto-char (point-max))
        (insert "hello")
        (should-error (agentpane-send) :type 'user-error)
        (should-not agentpane--sending)
        (should (equal (agentpane-test--draft) "hello"))
        (setq agentpane--editing (list :index 5 :overlay (make-overlay 1 1)))
        (should-error (agentpane-send) :type 'user-error)
        (setq agentpane--editing nil)
        (should-not sent)
        (agentpane--on-notification
         nil 'session/status
         (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false
               :compaction nil :model "luna"))
        (agentpane-send)
        (should (equal (mapcar #'car sent) '(sessions/prompt)))))))

(ert-deftest agentpane-test-send-refused-busy-keeps-its-text ()
  "A send the helper refuses `busy', as it refuses one from a view whose
compact has not answered (D32 point 4), says the helper's text in the
echo area as any refusal does, keeps the text, and frees the buffer to
send again.  A second send while the first is
out never reaches the helper, so a `busy' never answers it and never
clears the first's `agentpane--sending'.  Through `agentpane--request'
over a stub jsonrpc, the refusal built as `toRpcError' in
src/emacs/helper.ts builds one."
  (let ((ref '(:backend "codex" :id "t1"))
        (detail "a compaction requested from this buffer has not answered")
        (calls nil))
    (agentpane-test--with-helper
      (agentpane-test--noting
        (cl-letf (((symbol-function 'jsonrpc-async-request)
                   (lambda (_conn method _params &rest args)
                     (push (cons method args) calls)
                     (list (length calls) nil))))
          (agentpane-test--with-session ref
            (setq agentpane--attached agentpane--connection
                  agentpane--handle "h1")
            (goto-char (point-max))
            (insert "hello")
            (agentpane-send)
            (should agentpane--sending)
            (funcall (plist-get (cdr (assq 'sessions/prompt calls)) :error-fn)
                     `(:code -32000 :message ,detail :data (:error "busy" :detail ,detail)))
            (should (member (format "agentpane: sessions/prompt failed: %s" detail) said))
            (should-not agentpane--sending)
            (should (equal (agentpane-test--draft) "hello"))
            (agentpane-send)
            (should (= 2 (length calls)))
            (should-error (agentpane-send) :type 'user-error)
            (should (= 2 (length calls)))
            (should agentpane--sending)))))))

(ert-deftest agentpane-test-compact-only-an-attached-session-not-compacting ()
  "`agentpane-compact' sends `sessions/compact' for an attached session,
writing no mark of its own into the status, and is refused, sending
nothing, for one not attached, as `agentpane-abort' is, and while the
status reports a compaction, as the browser's Compact is disabled then.
Until ark3/agentpane#71 it attached first, and marked the status
`requesting' at the press."
  (agentpane-test--closing
    (with-current-buffer buffer
      (agentpane-compact)
      (should (equal sent `((sessions/compact :session ,ref :view ,agentpane--view))))
      (should-not (plist-get agentpane--status :compaction))
      (setq sent nil)
      (agentpane--on-notification
       nil 'session/status
       (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false
             :compaction "requesting" :model "luna"))
      (should-error (agentpane-compact) :type 'user-error)
      (agentpane--let-go)
      (should-error (agentpane-compact) :type 'user-error)
      (should-not sent))))

(ert-deftest agentpane-test-close-session-refused-where-the-browser-offers-no-detach ()
  "`agentpane-close-session' signals a user error and sends nothing in each
case the browser's `detachable' refuses (src/client/App.svelte): a
session only previewed; one streaming or compacting, since a kill
mid-turn loses the reply; and one with a prompt or a fork in flight, as
the browser's `sending' covers both.  An attach in flight refuses
nothing (`agentpane-test-close-session-sent-while-an-attach-is-out')."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          (agentpane-refetch)
          (setq sent nil)
          (should-error (agentpane-close-session) :type 'user-error)
          (should-not sent)))))
  (dolist (setup (list (lambda (ref)
                         (agentpane--on-notification
                          nil 'session/status
                          (list :view agentpane--view :session ref :handle "h1" :isStreaming t :model "luna")))
                       (lambda (ref)
                         (agentpane--on-notification
                          nil 'session/status
                          (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false
                                :compaction "running" :model "luna")))
                       (lambda (_) (setq agentpane--sending t))
                       (lambda (_) (setq agentpane--forking t))))
    (agentpane-test--closing
      (with-current-buffer buffer
        (funcall setup ref)
        (should (agentpane--attached-p))
        (should-error (agentpane-close-session) :type 'user-error)
        (should-not sent)))))

;;;; Renaming a session, against a stub connection

(ert-deftest agentpane-test-rename-session-sends-the-name-read ()
  "`M-x agentpane-rename-session' on an idle attached session sends
`sessions/setName' with the session's ref and the name read, and a name
blank once trimmed sends nothing, as the browser's Rename sends nothing
for one (`renameSession' in src/client/App.svelte)."
  (agentpane-test--closing
    (with-current-buffer buffer
      (cl-letf (((symbol-function 'read-string) (lambda (&rest _) "Bug hunt")))
        (call-interactively #'agentpane-rename-session))
      (should (equal sent `((sessions/setName :session ,ref :view ,agentpane--view :name "Bug hunt"))))
      (setq sent nil)
      (cl-letf (((symbol-function 'read-string) (lambda (&rest _) "  \t")))
        (call-interactively #'agentpane-rename-session))
      (should-not sent))))

(ert-deftest agentpane-test-rename-session-refused-where-the-browser-offers-no-rename ()
  "`M-x agentpane-rename-session' signals a user error, reads no name and
sends nothing in each case the browser's `renamable' refuses
\(src/client/App.svelte): a session only previewed, which it does not
attach, as `agentpane-set-model' would, since D13 names only an attached
session; one streaming or compacting; one with a prompt or a fork in
flight; and a Codex session with no indexed node, which stands in for one not yet prompted and which the
server refuses (OW-kametu), even with a notice drawn."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          (agentpane-refetch)
          (setq sent nil)
          (cl-letf (((symbol-function 'read-string) (lambda (&rest _) "Bug hunt")))
            (should-error (call-interactively #'agentpane-rename-session) :type 'user-error)
            (should-error (agentpane-rename-session "Bug hunt") :type 'user-error))
          (should-not (agentpane--attached-p))
          (should-not sent)))))
  (dolist (setup (list (lambda (ref)
                         (agentpane--on-notification
                          nil 'session/status
                          (list :view agentpane--view :session ref :handle "h1" :isStreaming t :model "luna")))
                       (lambda (ref)
                         (agentpane--on-notification
                          nil 'session/status
                          (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false
                                :compaction "running" :model "luna")))
                       (lambda (_) (setq agentpane--sending t))
                       (lambda (_) (setq agentpane--forking t))
                       (lambda (ref)
                         (agentpane--on-notification
                          agentpane--connection 'session/snapshot
                          (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false
                                :model "luna" :nodes [])))
                       (lambda (ref)
                         (agentpane--on-notification
                          agentpane--connection 'session/snapshot
                          (list :view agentpane--view :session ref :handle "h1" :isStreaming :json-false
                                :model "luna" :nodes []
                                :notices (vector '(:kind "warning" :message "Fallback metadata"
                                                   :details nil :path nil)))))))
    (agentpane-test--closing
      (with-current-buffer buffer
        (funcall setup ref)
        (should (agentpane--attached-p))
        (let ((read nil))
          (cl-letf (((symbol-function 'read-string)
                     (lambda (&rest _) (setq read t) "Bug hunt")))
            (should-error (call-interactively #'agentpane-rename-session) :type 'user-error)
            (should-error (agentpane-rename-session "Bug hunt") :type 'user-error))
          (should-not read))
        (should-not sent)))))

;;;; Each buffer's default-directory, against a stub connection

(defmacro agentpane-test--with-directories (names &rest body)
  "Run BODY with each of NAMES bound to a fresh temporary directory, without
the trailing slash, as the server stores a session's cwd, and delete them
afterwards."
  (declare (indent 1))
  `(let ,(mapcar (lambda (name) `(,name (make-temp-file "agentpane-test-" t))) names)
     (unwind-protect (progn ,@body)
       ,@(mapcar (lambda (name) `(delete-directory ,name t)) names))))

(ert-deftest agentpane-test-transcript-takes-its-sessions-cwd ()
  "A transcript opened from a buffer in one directory takes its session's
cwd as its `default-directory', not the directory of the buffer it was
opened from."
  (agentpane-test--with-directories (cwd elsewhere)
    (agentpane-test--forking nil nil
      (let* ((default-directory (file-name-as-directory elsewhere))
             (buffer (agentpane--transcript-buffer
                      (list :ref '(:backend "codex" :id "t1") :cwd cwd))))
        (should (equal (buffer-local-value 'default-directory buffer)
                       (file-name-as-directory cwd)))))))

(ert-deftest agentpane-test-transcripts-keep-their-own-cwd ()
  "Two transcripts for sessions in two directories each take their own, the
second though opened from the first."
  (agentpane-test--with-directories (one two)
    (agentpane-test--forking nil nil
      (let* ((first (agentpane--transcript-buffer
                     (list :ref '(:backend "codex" :id "t1") :cwd one)))
             (second (with-current-buffer first
                       (agentpane--transcript-buffer
                        (list :ref '(:backend "pi" :id "s2") :cwd two)))))
        (should (equal (buffer-local-value 'default-directory first)
                       (file-name-as-directory one)))
        (should (equal (buffer-local-value 'default-directory second)
                       (file-name-as-directory two)))))))

;;;; Buffer names

(ert-deftest agentpane-test-transcript-named-for-backend-and-project ()
  "A transcript is named for its backend and the last component of its
session's cwd, or its session id where there is no cwd."
  (agentpane-test--forking nil nil
    (should (equal (buffer-name (agentpane--transcript-buffer
                                 (list :ref '(:backend "claude" :id "c1")
                                       :cwd "/tmp/x/sandbox")))
                   "*agentpane/claude: sandbox*"))
    (should (equal (buffer-name (agentpane--transcript-buffer
                                 (list :ref '(:backend "codex" :id "t1"))))
                   "*agentpane/codex: t1*"))))

(ert-deftest agentpane-test-second-session-in-a-project-takes-a-suffix ()
  "A second session in the same project takes its name with the `<2>' Emacs
adds, a trailing slash on its cwd notwithstanding."
  (agentpane-test--forking nil nil
    (agentpane--transcript-buffer
     (list :ref '(:backend "claude" :id "c1") :cwd "/tmp/x/sandbox"))
    (should (equal (buffer-name (agentpane--transcript-buffer
                                 (list :ref '(:backend "claude" :id "c2")
                                       :cwd "/tmp/x/sandbox/")))
                   "*agentpane/claude: sandbox*<2>"))))

(ert-deftest agentpane-test-composer-named-for-its-transcript ()
  "A composer takes its transcript's name, with the transcript's `<N>'
moved inside the stars and ` prompt' before the closing one."
  (agentpane-test--forking nil nil
    (let ((first (agentpane--transcript-buffer
                  (list :ref '(:backend "claude" :id "c1") :cwd "/tmp/x/sandbox")))
          (second (agentpane--transcript-buffer
                   (list :ref '(:backend "claude" :id "c2") :cwd "/tmp/x/sandbox"))))
      (should (equal (buffer-name second) "*agentpane/claude: sandbox*<2>"))
      (dolist (transcript (list first second))
        (with-current-buffer transcript
          (save-current-buffer (save-window-excursion (agentpane-prompt)))))
      (should (equal (buffer-name (buffer-local-value 'agentpane--composer first))
                     "*agentpane/claude: sandbox prompt*"))
      (should (equal (buffer-name (buffer-local-value 'agentpane--composer second))
                     "*agentpane/claude: sandbox<2> prompt*")))))

(ert-deftest agentpane-test-transcript-kill-takes-its-composer ()
  "Killing a transcript kills its composer, which could send nowhere, the
composer's text going on the kill ring first, the echo area saying so,
and the window `agentpane-prompt' made for it goes too.  An empty
composer goes and puts nothing there (OW-sihoma)."
  (let ((kill-ring nil)
        (kill-ring-yank-pointer nil)
        (interprogram-cut-function nil)
        (interprogram-paste-function nil))
    (agentpane-test--forking nil nil
      (dolist (text '("" "half a thought"))
        (let* ((windows (length (window-list)))
               (transcript (agentpane--transcript-buffer
                            (list :ref '(:backend "claude" :id "c1") :cwd "/tmp/x/sandbox")))
               (composer (with-current-buffer transcript
                           (save-current-buffer (agentpane-prompt))
                           agentpane--composer)))
          (with-current-buffer composer (insert text))
          (setq said nil)
          (should (= (length (window-list)) (1+ windows)))
          (kill-buffer transcript)
          (should-not (buffer-live-p composer))
          (should (= (length (window-list)) windows))
          (if (string-empty-p text)
              (should-not kill-ring)
            (should (equal (current-kill 0) text))
            (should (seq-some (lambda (said) (string-search "kill ring" said)) said))))))))

(ert-deftest agentpane-test-composer-name-free-after-its-transcript-dies ()
  "A transcript killed with its composer open leaves that composer's name
free, so the next transcript in the project gets a composer named with no
`<N>' of its own (OW-sihoma)."
  (agentpane-test--forking nil nil
    (let ((summary (list :ref '(:backend "claude" :id "c1") :cwd "/tmp/x/sandbox")))
      (with-current-buffer (agentpane--transcript-buffer summary)
        (save-current-buffer (agentpane-prompt))
        (kill-buffer))
      (with-current-buffer (agentpane--transcript-buffer
                            (plist-put (copy-sequence summary)
                                       :ref '(:backend "claude" :id "c2")))
        (save-current-buffer (agentpane-prompt))
        (should (equal (buffer-name agentpane--composer)
                       "*agentpane/claude: sandbox prompt*"))))))

(ert-deftest agentpane-test-picker-takes-the-projects-root ()
  "`agentpane-sessions' run from a buffer below a project's root sets the
picker's `default-directory' to that root, though the picker was first
opened, listing every session, from a buffer elsewhere."
  (agentpane-test--with-directories (root elsewhere)
    (let ((project-vc-extra-root-markers '(".agentpane-test-root"))
          (below (expand-file-name "src/" root)))
      (make-directory below)
      (write-region "" nil (expand-file-name ".agentpane-test-root" root))
      (agentpane-test--forking nil nil
        (save-window-excursion
          (with-temp-buffer
            (setq default-directory (file-name-as-directory elsewhere))
            (agentpane-sessions t))
          (with-temp-buffer
            (setq default-directory below)
            (agentpane-sessions))
          (should (equal (buffer-local-value 'agentpane--cwd (get-buffer "*agentpane sessions*"))
                         root))
          (should (equal (buffer-local-value 'default-directory
                                             (get-buffer "*agentpane sessions*"))
                         (file-name-as-directory root))))))))

;;;; The picker's finished-turn mark, against a stub connection

(defun agentpane-test--summary (id streaming &optional cwd)
  "A listed Pi session, ID its id and `h-ID' its handle, STREAMING or not,
in CWD, else in /tmp."
  (list :ref (list :backend "pi" :id id) :handle (concat "h-" id) :cwd (or cwd "/tmp")
        :status "attached" :isStreaming (if streaming t :json-false)
        :updatedAt nil :preview id))

(defmacro agentpane-test--listing (&rest body)
  "Run BODY with `sessions/list' answered from `listing', a list of
summaries, filtered by the request's `cwd' as the server filters it, and
`relist' bound to a function that makes its arguments the listing and
delivers a `sessions/changed'.  `agentpane--connection' is a stand-in
that counts as running, unless BODY binds it.  The finished-turn marks
start empty, and every buffer BODY made is killed afterwards."
  (declare (indent 0))
  `(let* ((listing nil)
          (agentpane--connection 'connection)
          (running (symbol-function 'jsonrpc-running-p))
          (buffers (buffer-list))
          (agentpane--finished-turns (make-hash-table :test #'equal))
          (relist (lambda (&rest summaries)
                    (setq listing summaries)
                    (agentpane--on-notification nil 'sessions/changed nil))))
     (cl-letf (((symbol-function 'jsonrpc-running-p)
                (lambda (connection)
                  (or (eq connection 'connection) (funcall running connection))))
               ((symbol-function 'agentpane--request)
                (lambda (method params callback &rest _)
                  (when (eq method 'sessions/list)
                    (let ((cwd (plist-get params :cwd)))
                      (funcall callback
                               (vconcat (seq-filter
                                         (lambda (summary)
                                           (or (null cwd)
                                               (equal (plist-get summary :cwd) cwd)))
                                         listing))))))))
       (unwind-protect
           (save-window-excursion ,@body)
         (dolist (buffer (buffer-list))
           (unless (memq buffer buffers) (kill-buffer buffer)))))))

(defun agentpane-test--turn-ended (id &optional watched view)
  "Deliver the helper's `session/turnEnded' for the Pi session ID under the
handle `h-ID', as `agentpane-test--summary' lists it, WATCHED or not, and
naming VIEW where given (D32 point 6)."
  (agentpane--on-notification
   nil 'session/turnEnded
   (append (list :session (list :backend "pi" :id id) :handle (concat "h-" id)
                 :watched (if watched t :json-false))
           (and view (list :view view)))))

(defun agentpane-test--show (buffer)
  "Show BUFFER in the selected window, and run the hook redisplay runs for a
frame where a window newly shows a buffer, and reset the frame's window
state change flag, as batch Emacs, which never redisplays, does not."
  (set-window-buffer (selected-window) buffer)
  (set-frame-window-state-change nil nil)
  (with-temp-buffer
    (run-hook-with-args 'window-state-change-functions (selected-frame))))

(defun agentpane-test--redisplay ()
  "Run the hook redisplay runs for each frame whose window state change
flag is set, and reset the flag, as batch Emacs, which never redisplays,
does not.  A frame whose flag nothing set runs nothing."
  (dolist (frame (frame-list))
    (when (frame-window-state-change frame)
      (set-frame-window-state-change frame nil)
      (with-temp-buffer
        (run-hook-with-args 'window-state-change-functions frame)))))

(defun agentpane-test--pick (cwd)
  "Run `agentpane-sessions' from a buffer in CWD, and return the picker."
  (with-temp-buffer
    (setq default-directory (file-name-as-directory cwd))
    (agentpane-sessions))
  (get-buffer "*agentpane sessions*"))

(defun agentpane-test--holding (summary)
  "SUMMARY's transcript buffer, holding its handle as an attached one does."
  (let ((buffer (agentpane--transcript-buffer summary)))
    (with-current-buffer buffer
      (setq agentpane--handle (plist-get summary :handle)))
    buffer))

(defun agentpane-test--finished-p (picker handle)
  "Non-nil when PICKER's row for the session holding HANDLE carries the
finished-turn mark."
  (with-current-buffer picker
    (save-excursion
      (goto-char (point-min))
      (let (found)
        (while (and (not found) (not (eobp)))
          (when (equal (plist-get (tabulated-list-get-id) :handle) handle)
            (setq found (or (text-property-any (line-beginning-position) (line-end-position)
                                               'face 'agentpane-turn-finished)
                            'unmarked)))
          (forward-line 1))
        (should found)
        (not (eq found 'unmarked))))))

(ert-deftest agentpane-test-picker-marks-a-turn-that-finished-unseen ()
  "A session whose turn ends, as the helper's `session/turnEnded' says,
while no window shows its transcript is marked at once, watched or not,
and keeps the mark through later listings, until a window shows it; one
whose transcript is shown when its turn ends, and one whose turn did not
end, are not marked (D32 point 6)."
  (agentpane-test--listing
    (let ((unseen (agentpane--transcript-buffer (agentpane-test--summary "a" nil)))
          (seen (agentpane--transcript-buffer (agentpane-test--summary "b" nil)))
          (picker (save-window-excursion
                    (agentpane-sessions t)
                    (current-buffer))))
      (with-current-buffer unseen (setq agentpane--handle "h-a"))
      (with-current-buffer seen (setq agentpane--handle "h-b"))
      (set-window-buffer (selected-window) seen)
      (funcall relist (agentpane-test--summary "a" nil) (agentpane-test--summary "b" nil)
               (agentpane-test--summary "c" nil))
      (agentpane-test--turn-ended "a")
      (agentpane-test--turn-ended "b" t)
      (should (agentpane-test--finished-p picker "h-a"))
      (should-not (agentpane-test--finished-p picker "h-b"))
      (should-not (agentpane-test--finished-p picker "h-c"))
      ;; Rows are rebuilt from each listing, and the mark with them.
      (funcall relist (agentpane-test--summary "a" nil) (agentpane-test--summary "b" nil)
               (agentpane-test--summary "c" nil))
      (should (agentpane-test--finished-p picker "h-a"))
      (agentpane-test--show unseen)
      (should-not (agentpane-test--finished-p picker "h-a")))))

(ert-deftest agentpane-test-picker-lists-only-its-projects-sessions ()
  "A picker filtered to a project draws no row for a session in another,
though its listing, asked for every session, carries one (OW-yufahi)."
  (agentpane-test--with-directories (one two)
    (agentpane-test--listing
      (setq listing (list (agentpane-test--summary "a" nil one)
                          (agentpane-test--summary "b" nil two)))
      (let ((picker (agentpane-test--pick one)))
        (should (equal (mapcar (lambda (entry) (plist-get (car entry) :handle))
                               (buffer-local-value 'tabulated-list-entries picker))
                       '("h-a")))))))

(ert-deftest agentpane-test-picker-chooses-another-workspace ()
  "A picker filtered to the calling buffer's project offers every workspace
its listing carries, most recently updated first to the millisecond as
`Date.parse' orders them, and choosing another narrows its rows to that
one's sessions, as the browser's Workspace select does, while
`sessions/list' is still asked for every session (OW-fenina)."
  (agentpane-test--with-directories (one two)
    (agentpane-test--listing
      (let ((stub (symbol-function 'agentpane--request))
            (asked nil))
        (cl-letf (((symbol-function 'agentpane--request)
                   (lambda (method params &rest rest)
                     (when (eq method 'sessions/list)
                       (push params asked))
                     (apply stub method params rest))))
          (setq listing (list (plist-put (agentpane-test--summary "a" nil one)
                                         :updatedAt "2026-08-01T00:00:00.000Z")
                              (plist-put (agentpane-test--summary "b" nil one)
                                         :updatedAt "2026-09-02T00:00:00.100Z")
                              (plist-put (agentpane-test--summary "c" nil two)
                                         :updatedAt "2026-09-02T00:00:00.900Z")))
          (let ((picker (agentpane-test--pick one)))
            (with-current-buffer picker
              (should (equal (agentpane--workspaces) (list two one)))
              (agentpane-sessions-workspace two))
            (should (equal (sort (mapcar (lambda (entry) (plist-get (car entry) :handle))
                                         (buffer-local-value 'tabulated-list-entries picker))
                                 #'string<)
                           '("h-c")))
            (should (equal (buffer-local-value 'default-directory picker)
                           (file-name-as-directory two)))
            (should (= (length asked) 2))
            (should (seq-every-p #'null asked))))))))

(ert-deftest agentpane-test-picker-shows-each-sessions-workspace ()
  "The picker listing every session draws each row with its workspace's
basename, the full path as its help echo, and nothing for a session with
no cwd, as the browser's `.session-cwd' does (OW-bisadi)."
  (agentpane-test--listing
    (setq listing (list (agentpane-test--summary "a" nil "/tmp/one/alpha")
                        (agentpane-test--summary "b" nil "/tmp/two/beta")
                        (plist-put (agentpane-test--summary "c" nil) :cwd nil)))
    (let ((picker (save-window-excursion
                    (agentpane-sessions t)
                    (current-buffer)))
          (rows nil))
      (with-current-buffer picker
        (goto-char (point-min))
        (while (not (eobp))
          (when-let* ((summary (tabulated-list-get-id)))
            (push (cons (plist-get summary :handle)
                        (buffer-substring (line-beginning-position) (line-end-position)))
                  rows))
          (forward-line 1)))
      (let ((a (cdr (assoc "h-a" rows)))
            (b (cdr (assoc "h-b" rows)))
            (c (cdr (assoc "h-c" rows))))
        (should (string-match-p "\\_<alpha\\_>" a))
        (should-not (string-match-p "beta\\|/tmp" a))
        (should (equal (get-text-property (string-match "alpha" a) 'help-echo a)
                       "/tmp/one/alpha"))
        (should (string-match-p "\\_<beta\\_>" b))
        (should-not (string-match-p "alpha\\|/tmp" b))
        (should (equal (get-text-property (string-match "beta" b) 'help-echo b)
                       "/tmp/two/beta"))
        (with-current-buffer picker
          (let ((column (seq-position (mapcar #'car tabulated-list-format) "Workspace")))
            (should column)
            (should (equal (aref (cadr (seq-find (lambda (entry)
                                                   (equal (plist-get (car entry) :handle) "h-c"))
                                                 tabulated-list-entries))
                                 column)
                           ""))))))))

(defun agentpane-test--preview (picker handle)
  "The Session cell of PICKER's row for the session holding HANDLE."
  (with-current-buffer picker
    (let ((column (seq-position (mapcar #'car tabulated-list-format) "Session"))
          (entry (seq-find (lambda (entry) (equal (plist-get (car entry) :handle) handle))
                           tabulated-list-entries)))
      (should column)
      (should entry)
      (aref (cadr entry) column))))

(ert-deftest agentpane-test-picker-previews-a-just-prompted-session-by-its-transcript ()
  "A listed session whose stored preview is still null shows, in its Session
column, the first user node with text in the transcript buffer holding it, its text
parts joined, each run of whitespace one space, and trimmed, as the
server's `trimPreview' makes the stored one and the browser's
`firstUserText' labels its row, on one line; a stored preview wins over
it, and a session with no buffer shows nothing (OW-sowume)."
  (agentpane-test--listing
    (let ((prompted (plist-put (agentpane-test--summary "a" nil) :preview nil))
          (stored (plist-put (agentpane-test--summary "b" nil) :preview "Stored one"))
          (unheld (plist-put (agentpane-test--summary "c" nil) :preview nil)))
      (with-current-buffer (agentpane-test--holding prompted)
        (agentpane--draw [(:index 0 :role "user" :parts [(:type "text" :text "  ")])
                          (:index 1 :role "user"
                           :parts [(:type "text" :text " Fix the\n")
                                   (:type "text" :text "  bug\n\tnow ")])]))
      (with-current-buffer (agentpane-test--holding stored)
        (agentpane--draw agentpane-test--nodes))
      (setq listing (list prompted stored unheld))
      (let ((picker (save-window-excursion
                      (agentpane-sessions t)
                      (current-buffer))))
        (should (equal (mapcar (lambda (handle) (agentpane-test--preview picker handle))
                               '("h-a" "h-b" "h-c"))
                       '("Fix the bug now" "Stored one" "")))))))

(ert-deftest agentpane-test-picker-labels-a-named-session-by-its-name ()
  "A listed session whose summary carries a name shows the name in its
Session column, ahead of its stored preview and its transcript's first
user text, as the browser's `sessionLabel' labels its row (D27); one whose
name is null shows its preview."
  (agentpane-test--listing
    (let ((named (plist-put (agentpane-test--summary "a" nil) :name "Bug hunt"))
          (unnamed (plist-put (agentpane-test--summary "b" nil) :name nil)))
      (with-current-buffer (agentpane-test--holding named)
        (agentpane--draw agentpane-test--nodes))
      (setq listing (list named unnamed))
      (let ((picker (save-window-excursion
                      (agentpane-sessions t)
                      (current-buffer))))
        (should (equal (mapcar (lambda (handle) (agentpane-test--preview picker handle))
                               '("h-a" "h-b"))
                       '("Bug hunt" "b")))))))

(ert-deftest agentpane-test-picker-previews-a-user-node-drawn-after-its-listing ()
  "A picker already listing a session whose stored preview is null, while
its transcript buffer holds no node, shows the text of the user node that
buffer then draws from a `session/node', with no new listing; later nodes
redraw no picker (OW-sowume)."
  (agentpane-test--listing
    (let* ((summary (plist-put (agentpane-test--summary "a" nil) :preview nil))
           (ref (plist-get summary :ref))
           (buffer (agentpane-test--holding summary))
           (prints 0))
      (with-current-buffer buffer
        (agentpane--draw []))
      (setq listing (list summary))
      (let ((picker (save-window-excursion
                      (agentpane-sessions t)
                      (current-buffer))))
        (should (equal (agentpane-test--preview picker "h-a") ""))
        ;; A listing from here on would list nothing, and the row would go.
        (setq listing nil)
        (let ((print (symbol-function 'tabulated-list-print)))
          (cl-letf (((symbol-function 'tabulated-list-print)
                     (lambda (&rest args)
                       (setq prints (1+ prints))
                       (apply print args))))
            (agentpane--on-notification
             nil 'session/node
             (list :view (agentpane-test--view buffer) :handle "h-a" :session ref
                   :node '(:index 0 :role "user"
                           :parts [(:type "text" :text "Fix the bug")])))
            (agentpane-test--redraw buffer)
            (should (equal (agentpane-test--preview picker "h-a") "Fix the bug"))
            (should (string-search "Fix the bug"
                                   (with-current-buffer picker (buffer-string))))
            (should (= prints 1))
            (agentpane--on-notification
             nil 'session/node
             (list :view (agentpane-test--view buffer) :handle "h-a" :session ref :node (agentpane-test--assistant 1 "<p>Sure.</p>")))
            (agentpane--on-notification
             nil 'session/node
             (list :view (agentpane-test--view buffer) :handle "h-a" :session ref
                   :node '(:index 2 :role "user"
                           :parts [(:type "text" :text "And the other")])))
            (agentpane-test--redraw buffer)
            (should (= prints 1))
            (should (equal (agentpane-test--preview picker "h-a") "Fix the bug"))))))))

(ert-deftest agentpane-test-picker-mark-cleared-while-its-session-is-filtered-out ()
  "A marked session whose transcript is viewed while the picker lists
another project has no mark when its own project is listed again (OW-yufahi)."
  (agentpane-test--with-directories (one two)
    (agentpane-test--listing
      (let ((a (agentpane-test--holding (agentpane-test--summary "a" nil one)))
            (picker (agentpane-test--pick one)))
        (funcall relist (agentpane-test--summary "a" nil one) (agentpane-test--summary "b" nil two))
        (agentpane-test--turn-ended "a")
        (should (agentpane-test--finished-p picker "h-a"))
        (agentpane-test--pick two)
        (agentpane-test--show a)
        (agentpane-test--show picker)
        (agentpane-test--pick one)
        (should-not (agentpane-test--finished-p picker "h-a"))))))

(ert-deftest agentpane-test-picker-mark-cleared-when-a-shown-buffer-becomes-its-session ()
  "A transcript already on screen that becomes a marked session, by a
snapshot under its view, drops the mark
at the next redisplay, with no window changing buffer (OW-yufahi,
OW-piweyi): the binding itself sets the flag that makes redisplay run the
hook, which the mark's `session/turnEnded' installed."
  (agentpane-test--listing
    (let ((picker (save-window-excursion (agentpane-sessions t) (current-buffer)))
          (x (agentpane--transcript-buffer (list :ref '(:backend "pi" :id "x"))))
          (y (agentpane--transcript-buffer (list :ref '(:backend "pi" :id "y")))))
      (agentpane-test--show x)
      (funcall relist (agentpane-test--summary "a" nil))
      (agentpane-test--turn-ended "a")
      (should (agentpane-test--finished-p picker "h-a"))
      (agentpane--on-notification
       agentpane--connection 'session/snapshot
       (list :view (agentpane-test--view x) :session '(:backend "pi" :id "x") :handle "h-a" :nodes [] :isStreaming :json-false))
      (should (equal (buffer-local-value 'agentpane--handle x) "h-a"))
      (agentpane-test--redisplay)
      (should-not (agentpane-test--finished-p picker "h-a"))
      (agentpane-test--show y)
      (funcall relist (agentpane-test--summary "a" nil) (agentpane-test--summary "c" nil))
      (agentpane-test--turn-ended "c")
      (should (agentpane-test--finished-p picker "h-c"))
      (agentpane--on-notification
       nil 'session/snapshot
       (list :view (agentpane-test--view y) :session '(:backend "pi" :id "c") :handle "h-c"
             :nodes [] :isStreaming :json-false))
      (should (equal (buffer-local-value 'agentpane--handle y) "h-c"))
      (agentpane-test--redisplay)
      (should-not (agentpane-test--finished-p picker "h-c")))))

(ert-deftest agentpane-test-turn-ended-marks-a-row-with-no-picker-open ()
  "A turn that ends unseen while no picker is open, or before any listing
has read the session streaming, is marked by its `session/turnEnded', and
the first picker opened after draws the mark, as the browser's sidebar
marks it (D32 point 6, D26).  Until D32 only a picker's listings made the
mark, and a new picker marked nothing that ended before it."
  (agentpane-test--listing
    (setq listing (list (agentpane-test--summary "a" nil)))
    (let ((a (agentpane-test--holding (agentpane-test--summary "a" nil))))
      (should-not (get-buffer "*agentpane sessions*"))
      (agentpane-test--turn-ended "a")
      (should (memq #'agentpane--clear-seen-turns
                    (default-value 'window-state-change-functions)))
      (let ((picker (save-window-excursion (agentpane-sessions t) (current-buffer))))
        (should-not (eq (window-buffer (selected-window)) a))
        (should (agentpane-test--finished-p picker "h-a"))))))

(ert-deftest agentpane-test-picker-keeps-a-mark-through-the-helpers-death-until-opened ()
  "A session whose turn ended unseen keeps its finished-turn mark through
the death of the helper its transcript was attached through, and through
the first listing by the next, until it is opened from the picker, which
drops the mark (owner, 2026-11-20, ark3/agentpane#64): the browser's
\"keeps a finished-turn marker through a socket drop until its row is
selected\".  The mark is made by `session/turnEnded' (D32 point 6).  The
death leaves the buffer holding no handle, so only its ref finds it as
seen."
  (agentpane-test--listing
    (let ((agentpane--connection nil)
          (replacement nil))
      (cl-letf (((symbol-function 'agentpane--start-helper) #'agentpane-test--mute-helper))
        (unwind-protect
            (let* ((dead (agentpane--connection))
                   (a (agentpane-test--holding (agentpane-test--summary "a" nil)))
                   (picker (save-window-excursion (agentpane-sessions t) (current-buffer))))
              (with-current-buffer a (setq agentpane--attached dead))
              (funcall relist (agentpane-test--summary "a" nil))
              (agentpane-test--turn-ended "a")
              (should (agentpane-test--finished-p picker "h-a"))
              (kill-process (jsonrpc--process dead))
              (agentpane-test--heard-out dead)
              (should-not (buffer-local-value 'agentpane--handle a))
              (should (agentpane-test--finished-p picker "h-a"))
              (setq replacement (agentpane--connection))
              (funcall relist (agentpane-test--summary "a" nil))
              (should (agentpane-test--finished-p picker "h-a"))
              (with-current-buffer picker
                (goto-char (point-min))
                (agentpane-sessions-open))
              (should (eq (window-buffer (selected-window)) a))
              (agentpane-test--show a)
              (should-not (agentpane-test--finished-p picker "h-a")))
          (agentpane-test--end-helper replacement))))))

(ert-deftest agentpane-test-picker-forgets-a-handle-the-server-let-go ()
  "A handle the listing no longer carries, which the server never mints
again, leaves the marks (OW-wazipa)."
  (agentpane-test--listing
    (save-window-excursion (agentpane-sessions t))
    (funcall relist (agentpane-test--summary "a" nil) (agentpane-test--summary "b" nil))
    (agentpane-test--turn-ended "a")
    (agentpane-test--turn-ended "b")
    (should (gethash "h-a" agentpane--finished-turns))
    (funcall relist (agentpane-test--summary "b" nil) (agentpane-test--summary "c" nil))
    (should (equal (hash-table-keys agentpane--finished-turns) '("h-b")))))

(ert-deftest agentpane-test-picker-marks-a-turn-shown-only-in-a-background-tty-frame ()
  "A transcript shown only in a text terminal's frame that is not the one
on top is not seen, though `frame-visible-p' answers t for it, and its
turn's end is marked; shown in the top frame, it is seen (OW-yufahi).
Batch Emacs has no text terminal, so `tty-top-frame' answers as one would."
  (agentpane-test--listing
    (let ((picker (save-window-excursion (agentpane-sessions t) (current-buffer)))
          (a (agentpane-test--holding (agentpane-test--summary "a" nil)))
          (top nil))
      (cl-letf (((symbol-function 'tty-top-frame) (lambda (&optional _) top)))
        (agentpane-test--show a)
        (setq top 'another-frame)
        (funcall relist (agentpane-test--summary "a" nil))
        (agentpane-test--turn-ended "a")
        (should (agentpane-test--finished-p picker "h-a"))
        (setq top (selected-frame))
        ;; The listing drops the mark of a session now seen, and its next
        ;; turn's end marks nothing.
        (funcall relist (agentpane-test--summary "a" nil))
        (agentpane-test--turn-ended "a")
        (should-not (agentpane-test--finished-p picker "h-a"))))))

(ert-deftest agentpane-test-picker-mark-cleared-when-its-tty-frame-is-raised ()
  "A transcript shown only in a text terminal's frame that is not on top
drops its session's mark as soon as that frame is raised, though the raise
changes no window's buffer (OW-piweyi).
The raise runs what one ran in `emacs -nw' (Emacs 31.1, measured
2026-09-27): the default values of `window-selection-change-functions' and
`window-state-change-functions', for the frame it selected and the one it
deselected, and not `window-buffer-change-functions'.  Batch Emacs has no
text terminal, so `tty-top-frame' answers as one would."
  (agentpane-test--listing
    (let ((picker (save-window-excursion (agentpane-sessions t) (current-buffer)))
          (a (agentpane-test--holding (agentpane-test--summary "a" nil)))
          (top nil))
      (cl-letf (((symbol-function 'tty-top-frame) (lambda (&optional _) top)))
        (agentpane-test--show a)
        (setq top 'another-frame)
        (funcall relist (agentpane-test--summary "a" nil))
        (agentpane-test--turn-ended "a")
        (should (agentpane-test--finished-p picker "h-a"))
        (setq top (selected-frame))
        (with-temp-buffer
          (run-hook-with-args 'window-selection-change-functions (selected-frame))
          (run-hook-with-args 'window-state-change-functions (selected-frame)))
        (should-not (agentpane-test--finished-p picker "h-a"))))))

(ert-deftest agentpane-test-picker-does-not-mark-a-turn-shown-in-a-tty-child-frame ()
  "A transcript shown in a child frame of a text terminal's top frame is
seen, though `tty-top-frame' names the root frame and not the child, and
its turn's end is not marked; shown in a child of a frame not on top, it
is not seen (OW-piweyi).
Batch Emacs has no text terminal and makes no child frame, so
`tty-top-frame' and `frame-root-frame' answer as they did in `emacs -nw'
\(Emacs 31.1, measured 2026-09-27) for a child of the top frame."
  (agentpane-test--listing
    (let ((picker (save-window-excursion (agentpane-sessions t) (current-buffer)))
          (a (agentpane-test--holding (agentpane-test--summary "a" nil)))
          (top 'root-frame))
      (cl-letf (((symbol-function 'tty-top-frame) (lambda (&optional _) top))
                ((symbol-function 'frame-root-frame)
                 (lambda (&optional frame)
                   (if (eq (or frame (selected-frame)) (selected-frame)) 'root-frame frame))))
        (agentpane-test--show a)
        (funcall relist (agentpane-test--summary "a" nil))
        (agentpane-test--turn-ended "a")
        (should-not (agentpane-test--finished-p picker "h-a"))
        (setq top 'another-frame)
        (agentpane-test--turn-ended "a")
        (should (agentpane-test--finished-p picker "h-a"))))))

;;;; The turn-done indicator, against a stub connection

(defmacro agentpane-test--submitting (&rest body)
  "Run BODY in a transcript buffer attached under the handle \"h1\", not
shown in any window, with every request answered as
`agentpane-test--forking' answers it, an attach naming that handle, and no
turn marked done.  `status' is bound to a function that
delivers a `session/status' under the handle the buffer holds, reading
streaming when its argument is non-nil, and `submit' to one that types a
prompt and sends it, and `ended' to one that delivers the helper's
`session/turnEnded' for that handle under the buffer's view, watched
when its argument is non-nil."
  (declare (indent 0))
  `(let ((ref '(:backend "codex" :id "t1"))
         (agentpane--turns-done nil)
         (agentpane--finished-turns (make-hash-table :test #'equal)))
     (agentpane-test--with-helper
       (agentpane-test--forking nil nil
         (agentpane-test--with-session ref
           (setq agentpane--attached agentpane--connection
                 agentpane--handle "h1"
                 attached (list :ref ref :handle "h1"))
           (let ((status (lambda (streaming)
                           (agentpane--on-notification
                            nil 'session/status
                            (list :view agentpane--view :session ref :handle (buffer-local-value 'agentpane--handle buffer)
                                  :isStreaming (if streaming t :json-false)))))
                 (submit (lambda ()
                           (goto-char (point-max))
                           (insert "hello")
                           (agentpane-send)))
                 (ended (lambda (watched)
                          (agentpane--on-notification
                           nil 'session/turnEnded
                           (list :session ref :handle "h1" :view (buffer-local-value 'agentpane--view buffer)
                                 :watched (if watched t :json-false))))))
             (ignore status submit ended)
             ,@body))))))

(defun agentpane-test--turn-done-p ()
  "Non-nil when an `:eval' entry of `global-mode-string', which every mode
line draws by default, draws the turn-done indicator.
The entries are evaluated here rather than through `format-mode-line',
which in batch Emacs answers \"\" for every format, a plain string
included (Emacs 31.1, measured 2026-09-27).  Only a list whose first
element is a string or a list is a list of elements; any other is one
construct, an `:eval' form or a conditional, whose tail is not drawn as
entries."
  (seq-some (lambda (entry)
              (let ((drawn (and (eq (car-safe entry) :eval) (eval (cadr entry) t))))
                (and (stringp drawn)
                     (text-property-any 0 (length drawn) 'face 'agentpane-turn-finished drawn))))
            (and (or (stringp (car-safe global-mode-string))
                     (consp (car-safe global-mode-string)))
                 global-mode-string)))

(ert-deftest agentpane-test-turn-done-raised-unseen-and-cleared-on-show ()
  "A `session/turnEnded' for a turn this Emacs watched, ended in a buffer
no window shows, raises the indicator and marks the session's row, and
showing the buffer clears both (OW-lohavi, D32 point 6)."
  (agentpane-test--submitting
    (funcall submit)
    (funcall status t)
    (funcall status nil)
    (should-not (agentpane-test--turn-done-p))
    (funcall ended t)
    (should (agentpane-test--turn-done-p))
    (should (gethash "h1" agentpane--finished-turns))
    (agentpane-test--show buffer)
    (should-not (agentpane-test--turn-done-p))
    (should-not (gethash "h1" agentpane--finished-turns))))

(ert-deftest agentpane-test-turn-done-raised-beside-a-users-own-construct ()
  "A `global-mode-string' the user set to a single mode-line construct, a
string or an `:eval' form, keeps drawing it, and the indicator beside it,
and the status that ends the turn still reaches the mode line (OW-ratati)."
  (dolist (own '("USER" (:eval (format "X"))))
    (let ((global-mode-string own))
      (agentpane-test--submitting
        (funcall submit)
        (funcall status t)
        (funcall status nil)
        (funcall ended t)
        (should-not (member "streaming" agentpane--status-fields))
        (should (agentpane-test--turn-done-p))
        (should (member own global-mode-string))))))

(ert-deftest agentpane-test-turn-done-not-raised-for-a-turn-not-submitted-here ()
  "A `session/turnEnded' not watched, a turn this Emacs did not submit,
raises nothing when it ends unseen, though it marks the session's row
\(OW-lohavi, D32 point 6)."
  (agentpane-test--submitting
    (funcall ended nil)
    (should-not (agentpane-test--turn-done-p))
    (should (gethash "h1" agentpane--finished-turns))))

(ert-deftest agentpane-test-turn-done-not-raised-for-a-turn-that-ended-in-view ()
  "A watched turn that ends while a window shows its buffer raises
nothing and marks nothing (OW-lohavi)."
  (agentpane-test--submitting
    (agentpane-test--show buffer)
    (funcall ended t)
    (should-not (agentpane-test--turn-done-p))
    (should-not (gethash "h1" agentpane--finished-turns))))

(ert-deftest agentpane-test-handled-prompt-says-so-until-the-next-send ()
  "A prompt the backend answered as handled, a Pi extension command such
as `/mcp' that starts no turn for it, clears the draft as a sent prompt
does, and has the buffer say no turn was started for it, until the next
send (OW-taviju).  The helper drops the turn-done watch it armed (D32
point 6)."
  (agentpane-test--submitting
    (setq prompted '(:disposition "handled"))
    (funcall submit)
    (should (equal (agentpane-test--draft) ""))
    (should (equal (agentpane-test--above-prompt) agentpane-test--handled-line))
    (setq prompted nil)
    (funcall submit)
    (should-not (agentpane-test--above-prompt))))

(defconst agentpane-test--slash-warning
  "Agentpane does not run slash commands — depending on the agent, this may run as a command or be read as plain text."
  "The browser's warning by a draft that starts with `/' (OW-73, OW-sidese).")

(ert-deftest agentpane-test-slash-draft-warns-and-still-sends ()
  "A draft that starts with `/' shows the browser's slash-command warning
next to it -- above the prompt separator for the prompt region, in the
header line for a composer -- following the draft as it is edited, while
an ordinary draft shows none.  The warning never blocks: the send goes
out with the text unchanged and the warning goes with the draft
\(OW-73, OW-sidese)."
  (agentpane-test--submitting
    (goto-char (point-max))
    (insert "Summarize the diff")
    (should-not (agentpane-test--above-prompt))
    (goto-char agentpane--prompt-start)
    (insert "/")
    (should (equal (agentpane-test--above-prompt)
                   (concat agentpane-test--slash-warning "\n")))
    (delete-char -1)
    (should-not (agentpane-test--above-prompt))
    (delete-region agentpane--prompt-start (point-max))
    (insert "/compact")
    (should (equal (agentpane-test--above-prompt)
                   (concat agentpane-test--slash-warning "\n")))
    (agentpane-send)
    (should (equal (plist-get (alist-get 'sessions/prompt sent) :text) "/compact"))
    (should (equal (agentpane-test--draft) ""))
    (should-not (agentpane-test--above-prompt))
    (let ((composer (progn (save-current-buffer (agentpane-prompt)) agentpane--composer)))
      (with-current-buffer composer
        (insert "Summarize the diff")
        (should-not header-line-format)
        (goto-char (point-min))
        (insert "/")
        (should (equal (and header-line-format (substring-no-properties header-line-format))
                       agentpane-test--slash-warning))
        (delete-char -1)
        (should-not header-line-format)
        (erase-buffer)
        (insert "/mcp")
        (should (equal (and header-line-format (substring-no-properties header-line-format))
                       agentpane-test--slash-warning))
        (agentpane-composer-send)
        (should (equal (buffer-string) ""))
        (should-not header-line-format))
      (should (equal (plist-get (alist-get 'sessions/prompt sent) :text) "/mcp"))
      (should-not (agentpane-test--above-prompt)))))

(ert-deftest agentpane-test-slash-warning-keeps-the-composers-own-header-line ()
  "A composer whose header line the user's config set keeps it through an
ordinary draft, gives it up to the slash-command warning only while the
draft starts with `/', and gets it back once it stops (OW-sidese)."
  (let ((text-mode-hook (list (lambda () (setq header-line-format "USER-HEADER")))))
    (agentpane-test--submitting
      (let ((composer (progn (save-current-buffer (agentpane-prompt)) agentpane--composer)))
        (with-current-buffer composer
          (should (equal header-line-format "USER-HEADER"))
          (insert "Summarize the diff")
          (should (equal header-line-format "USER-HEADER"))
          (goto-char (point-min))
          (insert "/")
          (should (equal (and (stringp header-line-format)
                              (substring-no-properties header-line-format))
                         agentpane-test--slash-warning))
          (delete-char -1)
          (should (equal header-line-format "USER-HEADER")))))))

(ert-deftest agentpane-test-edit-send-handled-says-so-in-the-fork ()
  "An edit's send whose prompt the fork's backend handled ends the edit,
and says no turn was started in the fork's buffer, where the prompt went, taking down the line a handled prompt left
in the parent (OW-taviju)."
  (agentpane-test--watching
    (agentpane-test--editing "pi"
      (setq fork-prompted '(:session (:ref (:backend "pi" :id "fork") :handle "h2")
                            :disposition "handled"))
      ;; A line an earlier handled prompt left here comes down at the send.
      (agentpane--hold-handled t)
      (should (equal (agentpane-test--above-prompt) agentpane-test--handled-line))
      (agentpane-send)
      (should-not agentpane--editing)
      (should-not (agentpane-test--above-prompt))
      (with-current-buffer (agentpane--buffer-for '(:backend "pi" :id "fork"))
        (should (equal agentpane--handle "h2"))
        (should (equal (agentpane-test--above-prompt) agentpane-test--handled-line))))))

(ert-deftest agentpane-test-turn-done-cleared-when-its-buffer-is-killed ()
  "Killing a buffer whose watched turn ended unseen drops it from the
indicator (OW-lohavi)."
  (agentpane-test--submitting
    (funcall ended t)
    (should (agentpane-test--turn-done-p))
    (kill-buffer buffer)
    (should-not (agentpane-test--turn-done-p))))

(defmacro agentpane-test--watching (&rest body)
  "Run BODY with no turn marked done, and the indicator's
`global-mode-string' put back as it was afterwards."
  (declare (indent 0))
  `(let ((agentpane--turns-done nil)
         (global-mode-string global-mode-string))
     ,@body))

(ert-deftest agentpane-test-turn-done-not-raised-by-a-helpers-exit ()
  "A helper that exits, by `agentpane-shutdown' or killed, with a turn this
Emacs watched seen streaming, raises nothing in its teardown, which
leaves the buffer detached and idle: only the helper raises, as
`session/turnEnded' at its socket's close, and nothing at the end of its
input or at a crash (D32 point 6, D25 point 4).  Until D32 the teardown
raised that turn at a death and dropped it after a shutdown, which
marked the process to say so (OW-nuzoto)."
  (dolist (exit (list #'agentpane-shutdown
                      (lambda () (kill-process (jsonrpc--process agentpane--connection)))))
    (agentpane-test--submitting
      (let ((global-mode-string global-mode-string))
        (funcall submit)
        (funcall status t)
        (setq agentpane--connection nil)
        (let ((connection (cl-letf (((symbol-function 'agentpane--start-helper)
                                     (lambda ()
                                       (make-process :name "agentpane-test helper"
                                                     :command '("cat")
                                                     :connection-type 'pipe
                                                     :noquery t))))
                            (agentpane--connection))))
          (setq agentpane--attached connection)
          (funcall exit)
          (should (agentpane-test--wait-for (lambda () (null agentpane--connection))
                                            (+ (float-time) 10))))
        (should-not agentpane--handle)
        (should-not agentpane--streaming)
        (should-not (agentpane-test--turn-done-p))))))

(ert-deftest agentpane-test-helper-death-detaches-every-buffer-it-served ()
  "A helper that exits leaves each buffer attached through it as a
`session/detached' for its handle leaves it: holding no handle, not
attached, with its ref and the transcript it drew, and reading as not
streaming, the tail's running tool call drawn `ok' (D25).  So
`agentpane-close-session' refuses it and a `g' previews its ref, as each
does for a buffer told its handle is gone (D26)."
  (let ((agentpane--connection nil)
        (refs '((:backend "claude" :id "real-1") (:backend "codex" :id "t1"))))
    (agentpane-test--forking nil nil
      (cl-letf (((symbol-function 'agentpane--start-helper)
                 (lambda ()
                   (make-process :name "agentpane-test helper"
                                 :command '("cat")
                                 :connection-type 'pipe
                                 :noquery t))))
        (let* ((connection (agentpane--connection))
               (buffers
                (seq-map-indexed
                 (lambda (ref index)
                   (let ((buffer (agentpane--transcript-buffer (list :ref ref)))
                         (handle (format "h%d" (1+ index))))
                     (setq attached (list :ref ref :handle handle))
                     (with-current-buffer buffer (agentpane--attach))
                     (agentpane--on-notification
                      agentpane--connection 'session/snapshot
                      (list :view (agentpane-test--view buffer) :session ref :handle handle :isStreaming t :model "luna"
                            :nodes (vector (agentpane-test--running-tool 3 "sleep 60"))))
                     (with-current-buffer buffer
                       (should (agentpane--attached-p))
                       (should agentpane--streaming))
                     buffer))
                 refs)))
          (kill-process (jsonrpc--process connection))
          (should (agentpane-test--wait-for (lambda () (null agentpane--connection))
                                            (+ (float-time) 10)))
          (seq-mapn
           (lambda (buffer ref)
             (with-current-buffer buffer
               (should-not agentpane--handle)
               (should-not agentpane--attached)
               (should (agentpane--same-ref-p (agentpane--ref agentpane--session) ref))
               (should (equal (agentpane-test--indices) '(3)))
               (should-not agentpane--streaming)
               (should (equal mode-line-process " [luna]"))
               (should (string-search "✓ Bash" (agentpane-test--line-at "sleep 60")))
               (setq sent nil)
               (should-error (agentpane-close-session) :type 'user-error)
               (should-not sent)
               (agentpane-refetch)
               (should (equal sent `((sessions/preview :session ,ref))))))
           buffers refs))))))

(defun agentpane-test--last-words (messages &optional prompted linger)
  "Start a process standing in for a helper that writes MESSAGES, each a
JSON-RPC message as a plist, framed as the helper frames them: at once,
or, when PROMPTED, once it has read the first byte Emacs sends it.  It
then exits, or, when LINGER, waits to be killed."
  (make-process
   :name "agentpane-test dying helper"
   :command (list "sh" "-c"
                  (concat (and prompted "head -c 1 >/dev/null; ")
                          "printf %s \"$1\""
                          (and linger "; exec sleep 60"))
                  "sh"
                  (mapconcat (lambda (message)
                               (let ((json (json-serialize message)))
                                 (format "Content-Length: %d\r\n\r\n%s" (string-bytes json) json)))
                             messages))
   :connection-type 'pipe
   :noquery t))

(defun agentpane-test--mute-helper ()
  "Start a process standing in for a helper that reads nothing and writes
nothing until it is killed."
  (make-process :name "agentpane-test mute helper"
                :command '("sleep" "60")
                :connection-type 'pipe
                :noquery t))

(defun agentpane-test--dead-unheard (process)
  "Wait without yielding until PROCESS reads as not live, so that its
sentinel, and anything it wrote that Emacs has not read, are still to be
handled: the gap `agentpane-test-late-sentinel-keeps-the-replacement-helper'
drives."
  (let ((deadline (+ (float-time) 10)))
    (while (and (process-live-p process) (< (float-time) deadline))))
  (should-not (process-live-p process))
  (should-not (process-get process 'jsonrpc-sentinel-cleanup-started)))

(defun agentpane-test--heard-out (connection)
  "Let Emacs handle what CONNECTION's dead process left: wait until its
sentinel has run and it has been torn down, which is after the messages
it wrote last (`agentpane--helper-exited', `agentpane--helper-gone')."
  (should (agentpane-test--wait-for
           (lambda ()
             (and (process-get (jsonrpc--process connection) 'jsonrpc-sentinel-cleanup-started)
                  (not (eq connection agentpane--connection))))
           (+ (float-time) 10))))

(defun agentpane-test--end-helper (connection)
  "Kill CONNECTION's process, when CONNECTION is non-nil and its process
is live, and wait until it has left the process table and been torn
down, so that no teardown of it runs in a later test."
  (when (and connection (process-live-p (jsonrpc--process connection)))
    (kill-process (jsonrpc--process connection)))
  (when connection
    (agentpane-test--wait-for
     (lambda () (not (or (memq (jsonrpc--process connection) (process-list))
                         (eq connection agentpane--connection))))
     (+ (float-time) 10))))

(defmacro agentpane-test--outliving (last-words &rest body)
  "Run BODY in a fresh transcript buffer for the session `ref', with no
helper started, where the first helper started writes LAST-WORDS, as
`agentpane-test--last-words' does, once the first request is sent to it
unless `prompted' is nil, and then exits, or waits to be killed when
`linger' is non-nil, each as BODY has set it when the helper starts;
every later helper is mute.  Nothing is said in the echo area.
LAST-WORDS is read in that buffer, so a notification among them names
its view by `agentpane--view', as the helper does.
Whichever helper is current when BODY ends is killed."
  (declare (indent 1))
  `(let ((agentpane--connection nil)
         (ref '(:backend "codex" :id "t1"))
         (prompted t)
         (linger nil)
         (started nil))
     (agentpane-test--with-session ref
       (cl-letf (((symbol-function 'agentpane--start-helper)
                  (lambda ()
                    (if started
                        (agentpane-test--mute-helper)
                      (setq started t)
                      (agentpane-test--last-words ,last-words prompted linger))))
                 ((symbol-function 'message) #'ignore))
         (unwind-protect (progn ,@body)
           (agentpane-test--end-helper agentpane--connection))))))

(defmacro agentpane-test--noting (&rest body)
  "Run BODY with every echo-area message, `Error running timer' among
them, noted in `said', newest first, which BODY sees, and shown nowhere."
  (declare (indent 0))
  `(let ((said nil))
     (cl-letf (((symbol-function 'message)
                (lambda (format &rest args)
                  (when format (push (apply #'format-message format args) said))
                  nil)))
       ,@body)))

(defun agentpane-test--said-p (text said)
  "Non-nil when a message in SAID contains TEXT."
  (seq-find (lambda (message) (string-search text message)) said))

(ert-deftest agentpane-test-no-replacement-before-the-teardown ()
  "A helper that has exited but whose teardown has not yet run is not
replaced: a use of the connection in that gap signals and starts
nothing, and once the sentinel and the teardown behind it have run, the
next use starts a new helper (OW-bukupu).  Until OW-bukupu that use
started the replacement, and OW-toyupa kept the late sentinel from
forgetting it; but every late message of the dead helper's then reached
state the replacement had since taken, so no helper starts before the
last one's teardown."
  (let ((agentpane--connection nil)
        replacement)
    (cl-letf (((symbol-function 'agentpane--start-helper) #'agentpane-test--mute-helper))
      (let* ((dead (agentpane--connection))
             (process (jsonrpc--process dead)))
        (unwind-protect
            (progn
              (signal-process process 'SIGKILL)
              (agentpane-test--dead-unheard process)
              (should-error (agentpane--connection))
              (should (eq agentpane--connection dead))
              (agentpane-test--heard-out dead)
              (should-not agentpane--connection)
              (setq replacement (agentpane--connection))
              (should (jsonrpc-running-p replacement)))
          (agentpane-test--end-helper replacement))))))

(ert-deftest agentpane-test-no-re-attach-before-the-teardown ()
  "A buffer whose helper has exited, attached again before that helper's
sentinel has run, sends nothing, rather than attach through a replacement
the teardown would then miss, and the teardown lets go of it, reading
idle the turn seen streaming through the dead helper, and raising
nothing for it (OW-bukupu, D32 point 6).  The attach fails at once, and
once, signalling nothing, since a signal here reaches a callback running
in jsonrpc.el's timer (OW-hiliti).  Until D32 the teardown answered it as
the death (OW-mopuyi)."
  (agentpane-test--watching
    (agentpane-test--outliving nil
      (setq prompted nil)
      (let* ((dead (agentpane--connection))
             (process (jsonrpc--process dead)))
        (setq agentpane--attached dead
              agentpane--handle "h1")
        (agentpane--on-notification
         agentpane--connection 'session/status
         (list :view agentpane--view :session ref :handle "h1" :isStreaming t))
        (should agentpane--streaming)
        (agentpane-test--dead-unheard process)
        (let ((failures 0))
          (agentpane--attach nil (lambda () (cl-incf failures)))
          (should (eq agentpane--connection dead))
          (should (= failures 1))
          (agentpane-test--heard-out dead)
          (should (= failures 1)))
        (should-not agentpane--streaming)
        (should-not (agentpane-test--turn-done-p))
        (should-not agentpane--handle)))))

(defun agentpane-test--late-attach-reply (before-sentinel)
  "Attach a buffer through a helper that sends the attach's snapshot,
answers the attach and dies while Emacs is busy, use the connection in
that gap, then let Emacs handle the dead helper's sentinel, its reply and
its teardown: the reply first when BEFORE-SENTINEL, as when Emacs had
read it before the helper died, and after the sentinel otherwise, as
jsonrpc.el hands on what a dead process wrote last (Emacs 31.1,
jsonrpc.el 1.0.29).  The use in the gap must be refused, and the buffer
end let go of, attached to nothing (OW-bukupu)."
  (agentpane-test--outliving
      (list (list :jsonrpc "2.0" :method "session/snapshot"
                  :params (list :view agentpane--view :session ref :handle "h1" :isStreaming :false
                                :nodes (vector)))
            (list :jsonrpc "2.0" :id 1 :result (list :ref ref :handle "h1")))
    (setq linger before-sentinel)
    (agentpane--attach)
    (let* ((dead agentpane--connection)
           (process (jsonrpc--process dead)))
      (when before-sentinel
        ;; Read the snapshot and the reply and queue their delivery,
        ;; running no timer.
        (should (accept-process-output process 10 nil 1))
        (signal-process process 'SIGKILL))
      (agentpane-test--dead-unheard process)
      (should-error (agentpane--connection))
      (agentpane-test--heard-out dead)
      (should-not agentpane--connection)
      (should-not agentpane--attached)
      (should-not agentpane--handle))))

(ert-deftest agentpane-test-late-attach-reply-attaches-nothing ()
  "An attach reply a dead helper wrote binds the buffer to no replacement,
since none starts before the dead helper's teardown, which then lets go
of the buffer, whether the reply is handled before or after its sentinel
\(OW-bukupu)."
  (agentpane-test--late-attach-reply nil)
  (agentpane-test--late-attach-reply t))

(ert-deftest agentpane-test-no-request-before-the-teardown ()
  "A request sent after the helper has exited, before its teardown, sends
nothing and signals nothing, and runs its FAILED at once, and once; it
leaves the buffer's latest request the one
sent through the dead helper, whose reply is then the one the callback
takes: no request goes through a replacement, whose ids would count from
1 again and could match a late reply's (OW-bukupu).  Until OW-hiliti it
signalled, which from a callback running in jsonrpc.el's timer Emacs
reported as `Error running timer'; until D32 the teardown answered it
as the death (OW-mopuyi)."
  (let ((got nil)
        (failures 0)
        (calls nil)
        (async (symbol-function 'jsonrpc-async-request)))
    (cl-letf (((symbol-function 'jsonrpc-async-request)
               (lambda (conn method &rest args)
                 (push method calls)
                 (apply async conn method args))))
      (agentpane-test--outliving
          (list (list :jsonrpc "2.0" :id 1 :result "the dead helper's"))
        (agentpane--request 'sessions/preview nil (lambda (result) (push result got)))
        (let* ((dead agentpane--connection)
               (process (jsonrpc--process dead)))
          (agentpane-test--dead-unheard process)
          (agentpane--request 'sessions/list nil
                              (lambda (result) (push (cons 'second result) got))
                              nil (lambda () (cl-incf failures)))
          (should (= failures 1))
          (should (equal calls '(sessions/preview)))
          (should (eq agentpane--connection dead))
          (should (eql agentpane--latest-request 1))
          (agentpane-test--heard-out dead)
          (should (= failures 1))
          (should (equal got '("the dead helper's"))))))))

(ert-deftest agentpane-test-late-status-leaves-the-buffer-idle ()
  "A `session/status' reading streaming that a helper wrote as it exited,
while Emacs was busy, is read before the teardown, which then leaves the
buffer let go of, idle and holding no handle.  Handled after a teardown
run at the sentinel, it found the buffer by its ref and bound the dead
helper's handle to it again, reading streaming (OW-bukupu)."
  (let* ((heard nil)
         (dispatch (symbol-function 'agentpane--on-notification)))
    (cl-letf (((symbol-function 'agentpane--on-notification)
               (lambda (&rest args)
                 (apply dispatch args)
                 (setq heard t))))
      (agentpane-test--outliving
          (list (list :jsonrpc "2.0" :method "session/status"
                      :params (list :view agentpane--view :session ref :handle "h1" :isStreaming t)))
        (setq prompted nil)
        (let* ((dead (agentpane--connection))
               (process (jsonrpc--process dead)))
          (setq agentpane--attached dead
                agentpane--handle "h1")
          (agentpane-test--dead-unheard process)
          (should (agentpane-test--wait-for (lambda () heard) (+ (float-time) 10)))
          (agentpane-test--heard-out dead)
          (should-not agentpane--attached)
          (should-not agentpane--handle)
          (should-not agentpane--streaming))))))

(ert-deftest agentpane-test-last-node-is-drawn-before-the-teardown ()
  "A `session/node' a helper wrote just before it exited, while Emacs was
busy, is drawn, as the helper flushes its last node before it exits at a
drop so that it reaches the buffer (OW-mepufi), and the buffer is let go
of after it, holding no handle (OW-bukupu)."
  (agentpane-test--outliving
      (list (list :jsonrpc "2.0" :method "session/node"
                  :params (list :view agentpane--view :session ref :handle "h1"
                                :node (agentpane-test--assistant 3 "<p>Final words.</p>"))))
    (setq prompted nil)
    (let* ((dead (agentpane--connection))
           (process (jsonrpc--process dead)))
      (setq agentpane--attached dead
            agentpane--handle "h1")
      (agentpane-test--dead-unheard process)
      (agentpane-test--heard-out dead)
      (should (agentpane-test--wait-for (lambda () (null agentpane--recorded))
                                        (+ (float-time) 10)))
      (should (string-search "Final words." (buffer-string)))
      (should-not agentpane--attached)
      (should-not agentpane--handle))))

(ert-deftest agentpane-test-last-node-drawn-past-a-refused-refetch ()
  "The node a dying helper flushed after a `sessions/changed' is drawn,
and the buffer then let go of, though the picker refetch that
notification runs, handled first, finds the helper exited: the refetch
sends nothing, rather than tearing the helper down, or replacing it,
under the messages still to come (OW-bukupu), and fails at once.
Nothing signals from jsonrpc.el's timer, as the
refetch refused by `agentpane--connection' did until OW-hiliti, and
nothing refetches the picker after, which waits for a `g'.  The helper's
`write' flushes a held node before any other message it writes
\(src/emacs/helper.ts), so a node after a `sessions/changed' is its
order at a drop."
  (let ((picker (generate-new-buffer "*agentpane-test picker*"))
        (calls nil)
        (async (symbol-function 'jsonrpc-async-request)))
    (unwind-protect
        (cl-letf (((symbol-function 'jsonrpc-async-request)
                   (lambda (conn method &rest args)
                     (push method calls)
                     (apply async conn method args))))
          (with-current-buffer picker (agentpane-sessions-mode))
          (agentpane-test--outliving
              (list (list :jsonrpc "2.0" :method "sessions/changed")
                    (list :jsonrpc "2.0" :method "session/node"
                          :params (list :view agentpane--view :session ref :handle "h1"
                                        :node (agentpane-test--assistant 3 "<p>Final words.</p>"))))
            (setq prompted nil)
            (agentpane-test--noting
              (let* ((dead (agentpane--connection))
                     (process (jsonrpc--process dead)))
                (setq agentpane--attached dead
                      agentpane--handle "h1")
                (agentpane-test--dead-unheard process)
                (agentpane-test--heard-out dead)
                (should (agentpane-test--wait-for (lambda () (null agentpane--recorded))
                                                  (+ (float-time) 10)))
                (should (string-search "Final words." (buffer-string)))
                (should-not agentpane--connection)
                (should-not agentpane--handle)
                (should-not calls)
                (should-not (agentpane-test--said-p "Error running timer" said))))))
      (kill-buffer picker))))

(defun agentpane-test--prompt-waiting-as-its-helper-dies (streaming)
  "Send a prompt while the buffer's attach is in flight, which goes out at
once for the helper to send once that attach has bound the buffer (D32
point 4); the helper answers the attach, after its snapshot, which reads
STREAMING, and then exits with the prompt unanswered, as a crash would.
The teardown must free the buffer to send again, keeping its draft;
return whether the indicator is raised once the teardown has run."
  (let ((calls nil)
        (async (symbol-function 'jsonrpc-async-request)))
    (agentpane-test--watching
      (cl-letf (((symbol-function 'jsonrpc-async-request)
                 (lambda (conn method &rest args)
                   (push method calls)
                   (apply async conn method args))))
        (agentpane-test--outliving
            (list (list :jsonrpc "2.0" :method "session/snapshot"
                        :params (list :view agentpane--view :session ref :handle "h1"
                                      :isStreaming (if streaming t :false)
                                      :nodes (vector)))
                  (list :jsonrpc "2.0" :id 1 :result (list :ref ref :handle "h1")))
          (setq linger t)
          (agentpane-attach)
          (goto-char (point-max))
          (insert "hello")
          (agentpane-send)
          (let* ((dead agentpane--connection)
                 (process (jsonrpc--process dead)))
            (should (agentpane-test--wait-for (lambda () agentpane--handle) (+ (float-time) 10)))
            (signal-process process 'SIGKILL)
            (agentpane-test--dead-unheard process)
            (agentpane-test--heard-out dead))
          (should (equal calls '(sessions/prompt sessions/attach)))
          (should-not agentpane--connection)
          (should-not agentpane--sending)
          (should-not agentpane--attached)
          (should-not agentpane--handle)
          (should (equal (buffer-substring-no-properties agentpane--prompt-start (point-max))
                         "hello"))
          (and (agentpane-test--turn-done-p) t))))))

(ert-deftest agentpane-test-prompt-waiting-as-its-helper-dies-is-refused ()
  "A prompt sent while the buffer's attach was in flight, which the helper
holds until that attach has bound the buffer, and whose helper sends the
attach's snapshot, answers the attach and then exits without answering
the prompt, as a crash would, leaves the buffer free to send again once
the teardown has run, keeping its draft, and no turn-done watch outlives
it (OW-bukupu, D32 point 7).  Until ark3/agentpane#71 the
buffer held the prompt itself and sent it once the attach answered, so
the hazard was its going through a replacement helper."
  (should-not (agentpane-test--prompt-waiting-as-its-helper-dies nil)))

(ert-deftest agentpane-test-prompt-waiting-as-its-helper-dies-raises-nothing ()
  "A prompt left unanswered as in
`agentpane-test-prompt-waiting-as-its-helper-dies-is-refused', into a
session the attach's snapshot read streaming a turn from elsewhere,
raises nothing at the teardown, which reads that turn idle: the helper
alone raises a turn, as `session/turnEnded', and a dead one raises
nothing (D32 point 6)."
  (should-not (agentpane-test--prompt-waiting-as-its-helper-dies t)))

(ert-deftest agentpane-test-attach-answered-by-an-exited-helper-fails ()
  "An attach reply handled after the helper that wrote it has exited, but
before its sentinel has run, attaches nothing, and the prompt sent while
it was in flight, which went out at once for the helper to hold (D32
point 4) and which that helper never answered, is freed by the teardown,
keeping its draft, and nothing goes out through a replacement
\(OW-bukupu, D32 point 7)."
  (let ((calls nil)
        (async (symbol-function 'jsonrpc-async-request)))
    (agentpane-test--watching
      (cl-letf (((symbol-function 'jsonrpc-async-request)
                 (lambda (conn method &rest args)
                   (push method calls)
                   (apply async conn method args))))
        (agentpane-test--outliving
            (list (list :jsonrpc "2.0" :id 1 :result (list :ref ref :handle "h1")))
          (setq linger t)
          (agentpane-attach)
          (goto-char (point-max))
          (insert "hello")
          (agentpane-send)
          (let* ((dead agentpane--connection)
                 (process (jsonrpc--process dead)))
            ;; Read the reply and queue its delivery, running no timer:
            ;; the next wait runs it before it runs the sentinel.
            (should (accept-process-output process 10 nil 1))
            (signal-process process 'SIGKILL)
            (agentpane-test--dead-unheard process)
            (agentpane-test--heard-out dead)
            (should (equal calls '(sessions/prompt sessions/attach)))
            (should-not agentpane--sending)
            (should-not agentpane--connection)
            (should-not agentpane--attached)
            (should (equal (buffer-substring-no-properties agentpane--prompt-start (point-max))
                           "hello"))))))))

(defun agentpane-test--snapshot-then-death (reply)
  "Attach a buffer through a helper that writes the attach's snapshot,
under the buffer's view and the handle \"h1\", streaming, then the
attach reply when REPLY,
and exits while Emacs is busy, and let Emacs handle what it left.  The
buffer must end let go of, holding no handle and idle (OW-bukupu)."
  (agentpane-test--watching
    (agentpane-test--outliving
        (append
         (list (list :jsonrpc "2.0" :method "session/snapshot"
                     :params (list :view agentpane--view :session ref :handle "h1" :isStreaming t :model "luna"
                                   :nodes (vector))))
         (and reply
              (list (list :jsonrpc "2.0" :id 1 :result (list :ref ref :handle "h1")))))
      (agentpane--attach)
      (let* ((dead agentpane--connection)
             (process (jsonrpc--process dead)))
        (agentpane-test--dead-unheard process)
        (agentpane-test--heard-out dead)
        (should-not agentpane--handle)
        (should-not agentpane--attached)
        (should-not agentpane--streaming)))))

(ert-deftest agentpane-test-snapshot-before-a-death-is-let-go ()
  "A buffer the dying helper gave a handle, by the snapshot of an attach
it answered or never answered, is let go of by that helper's teardown as
one attached through it is: the helper writes an attach's
snapshot ahead of its reply (D31 point 3), and can be killed between
the two (OW-bukupu)."
  (agentpane-test--snapshot-then-death t)
  (agentpane-test--snapshot-then-death nil))

(ert-deftest agentpane-test-late-error-reply-fails-once ()
  "An error reply a dead helper wrote, the server's refusal as `toRpcError' in
src/emacs/helper.ts builds one, handled once the helper reads as dead,
is the request's one answer, as one from a live helper is: FAILED runs
once, and the echo area shows the helper's own
message, not its exit; jsonrpc.el's \"Server died\" does not answer it
again (OW-bukupu, OW-hiliti).  Until OW-hiliti the
teardown answered it as the death, running FAILED alone, and the
helper's message was never shown; until OW-mopuyi \"Server died\"
answered it.  `agentpane-test-close-answer-reaches-its-request' is the
same for the helper's own answer at its socket's close."
  (let ((failures 0))
    (agentpane-test--outliving
        (list (list :jsonrpc "2.0" :id 1
                    :error (list :code -32000 :message "no such session"
                                 :data (list :error "gone"
                                             :detail "no such session"))))
      (agentpane-test--noting
        (agentpane--request 'sessions/preview nil #'ignore nil
                            (lambda () (cl-incf failures)))
        (let* ((dead agentpane--connection)
               (process (jsonrpc--process dead)))
          (agentpane-test--dead-unheard process)
          (agentpane-test--heard-out dead)
          (should (= failures 1))
          (should (member "agentpane: sessions/preview failed: no such session" said))
          (should-not (agentpane-test--said-p "the helper exited" said)))))))

(ert-deftest agentpane-test-fork-answered-as-its-helper-dies-is-shown ()
  "A fork whose reply is among the last messages a dying helper wrote
opens the fork's buffer and shows it, not attached, so a `g' can bring it
back: the fork's attach, made in the gap before the teardown, sends
nothing and fails at once, said once, and nothing signals from jsonrpc.el's timer.  Refused by
`agentpane--connection' there, as until OW-hiliti, the attach signalled
out of the reply's callback, Emacs reported `Error running timer', and
the fork's buffer, made, was never shown."
  (let ((forked '(:backend "codex" :id "t2"))
        (window (selected-window))
        fork-buffer)
    (unwind-protect
        (agentpane-test--outliving
            (list (list :jsonrpc "2.0" :id 1 :result forked))
          (agentpane-test--noting
            (setq agentpane--forking t)
            (agentpane--fork-at ref '(:id "turn-0") window nil)
            (agentpane-test--heard-out agentpane--connection)
            (setq fork-buffer (agentpane--buffer-for forked))
            (should fork-buffer)
            (should (eq (window-buffer window) fork-buffer))
            (with-current-buffer fork-buffer
              (should-not agentpane--attached))
            (should-not agentpane--forking)
            (should-not (agentpane-test--said-p "Error running timer" said))
            (should (= 1 (seq-count (lambda (message) (string-search "sessions/attach failed" message))
                                    said)))))
      (when (buffer-live-p fork-buffer)
        (kill-buffer fork-buffer)))))

(ert-deftest agentpane-test-late-success-reply-answers-once ()
  "A prompt's answer a helper wrote as it exited, while Emacs was busy, is
the prompt's one answer: the backend admitted the prompt, so its callback
runs, clearing a draft, and nothing reports it failed, though the
helper's death reached the request first (OW-bukupu)."
  (let ((answers 0)
        (failures 0))
    (agentpane-test--outliving
        (list (list :jsonrpc "2.0" :id 1 :result nil))
      (agentpane--request 'sessions/prompt nil (lambda (_) (cl-incf answers)) t
                          (lambda () (cl-incf failures)))
      (let* ((dead agentpane--connection)
             (process (jsonrpc--process dead)))
        (agentpane-test--dead-unheard process)
        (agentpane-test--heard-out dead)
        (should (equal (list answers failures) '(1 0)))))))

(defun agentpane-test--writes-then-dies (messages)
  "Start a process standing in for a helper that, after 0.3s, writes
MESSAGES, each a JSON-RPC message as a plist, framed as the helper frames
them, then exits 0.3s later."
  (make-process
   :name "agentpane-test dying helper"
   :command (list "sh" "-c" "sleep 0.3; printf %s \"$1\"; sleep 0.3" "sh"
                  (mapconcat (lambda (message)
                               (let ((json (json-serialize message)))
                                 (format "Content-Length: %d\r\n\r\n%s" (string-bytes json) json)))
                             messages))
   :connection-type 'pipe
   :noquery t))

(defun agentpane-test--answers-then-dies ()
  "Start a process standing in for a helper that, after 0.3s, answers the
request with id 1 with a null result, then exits 0.3s later."
  (agentpane-test--writes-then-dies (list (list :jsonrpc "2.0" :id 1 :result nil))))

(ert-deftest agentpane-test-held-back-reply-answers-once ()
  "A prompt's answer that jsonrpc.el held back behind a synchronous request,
as an \"anxious continuation\", while the helper died is the prompt's one
answer, though it runs after the helper's teardown: the sentinel fails
only the requests it still waits on, and the synchronous one's end hands
on the held answer from a timer queued after the teardown's (Emacs 31.1,
jsonrpc.el 1.0.29, measured 2026-09-28; OW-bukupu)."
  (let ((agentpane--connection nil)
        (answers 0)
        (failures 0))
    (agentpane-test--with-session '(:backend "codex" :id "t1")
      (cl-letf (((symbol-function 'agentpane--start-helper) #'agentpane-test--answers-then-dies)
                ((symbol-function 'message) #'ignore))
        (agentpane--request 'sessions/prompt nil (lambda (_) (cl-incf answers)) t
                            (lambda () (cl-incf failures)))
        (let ((dead agentpane--connection))
          (should-error (jsonrpc-request dead 'models/list nil :timeout 5))
          (agentpane-test--heard-out dead)
          (with-current-buffer (jsonrpc-events-buffer dead)
            (should (string-search "anxious continuation to 1 running now" (buffer-string))))
          ;; Let the held answer, handed on from a timer, run.
          (accept-process-output nil 0.1)
          (should (equal (list answers failures) '(1 0))))))))

(defun agentpane-test--lost (id)
  "The helper's answer to the request ID still out at its socket's close:
an error with its own code and no `data' (`LOST' in src/emacs/helper.ts,
D32 point 7)."
  (list :jsonrpc "2.0" :id id
        :error (list :code -32001
                     :message "the connection to the agentpane server closed before it answered")))

(defun agentpane-test--behind-a-synchronous-request (send)
  "Call SEND in a transcript buffer for the session `ref', attached under
the handle \"h1\" through a helper that, 0.3s after it starts, answers
both requests still out as at its socket's close and exits, then send a
synchronous request through that helper, and let Emacs handle the death.
SEND's request is the older of the two outstanding at the death: the
order OW-laluso found jsonrpc.el's sentinel thrown out of its walk in,
newest first, by the synchronous one's error handler before it reached
the older request's \(Emacs 31.1, jsonrpc.el 1.0.29).  SEND is called
with a function that counts a failure, and this returns the failures
counted once the teardown has run and Emacs has waited a beat more."
  (let ((agentpane--connection nil)
        (failures 0))
    (agentpane-test--watching
      (agentpane-test--with-session '(:backend "codex" :id "t1")
        (cl-letf (((symbol-function 'agentpane--start-helper)
                   (lambda ()
                     (make-process
                      :name "agentpane-test dying helper"
                      :command (list "sh" "-c" "sleep 0.3; printf %s \"$1\"" "sh"
                                     (mapconcat (lambda (message)
                                                  (let ((json (json-serialize message)))
                                                    (format "Content-Length: %d\r\n\r\n%s" (string-bytes json) json)))
                                                (list (agentpane-test--lost 1) (agentpane-test--lost 2))))
                      :connection-type 'pipe
                      :noquery t)))
                  ((symbol-function 'message) #'ignore))
          (let ((dead (agentpane--connection)))
            (funcall send (lambda () (cl-incf failures)))
            (should-error (jsonrpc-request dead 'models/list nil :timeout 5))
            (agentpane-test--heard-out dead)
            (accept-process-output nil 0.1)
            (should-not agentpane--sending)
            failures))))))

(ert-deftest agentpane-test-close-answers-a-prompt-behind-a-synchronous-request ()
  "A prompt still out when its helper's socket closes, with a synchronous
request sent after it, fails exactly once, by the answer the helper
writes before it exits, and frees the buffer to send again, though
jsonrpc.el's sentinel never reaches it (D32 point 7, OW-laluso).  Until
D32 the teardown answered it as the death (OW-mopuyi)."
  (should (= 1 (agentpane-test--behind-a-synchronous-request
                (lambda (failed)
                  (setq agentpane--attached agentpane--connection
                        agentpane--handle "h1")
                  (agentpane--send-prompt "hello" #'ignore nil failed)
                  (should agentpane--sending))))))

(ert-deftest agentpane-test-close-answers-an-attach-behind-a-synchronous-request ()
  "An attach still out when its helper's socket closes, with a synchronous
request sent after it, fails exactly once, by the answer the helper
writes before it exits, though jsonrpc.el's sentinel never reaches it
\(D32 point 7, OW-laluso)."
  (should (= 1 (agentpane-test--behind-a-synchronous-request
                (lambda (failed)
                  (agentpane--attach nil failed))))))

(ert-deftest agentpane-test-close-answer-reaches-its-request ()
  "The answer a helper writes, as it exits at its socket's close, to a
request still out is that request's one answer, though jsonrpc.el
handles it after the helper reads as dead: FAILED runs once, ERRED with
no `data', since the outcome is unknown and no refusal, and the echo
area shows the helper's message, not its exit (D32 point 7)."
  (let ((failures 0)
        (erred nil))
    (agentpane-test--outliving
        (list (agentpane-test--lost 1))
      (agentpane-test--noting
        (agentpane--request 'sessions/prompt nil #'ignore t
                            (lambda () (cl-incf failures)) nil
                            (lambda (data) (push (list data) erred)))
        (let* ((dead agentpane--connection)
               (process (jsonrpc--process dead)))
          (agentpane-test--dead-unheard process)
          (agentpane-test--heard-out dead)
          (should (= failures 1))
          (should (equal erred '((nil))))
          (should (agentpane-test--said-p "sessions/prompt failed: the connection" said))
          (should-not (agentpane-test--said-p "the helper exited" said)))))))

(ert-deftest agentpane-test-teardown-frees-a-send-the-helper-never-answered ()
  "A send still in flight when its helper crashes, which answers nothing,
is freed by the teardown: the buffer no longer counts a send in flight,
and the prompts a stop took out of Pi's queue, held behind it, come back
ahead of the draft (D32 point 7).  Until D32 the teardown answered the
send as the death, running its FAILED (OW-mopuyi)."
  (agentpane-test--outliving nil
    (agentpane--draw [])
    (let ((dead (agentpane--connection)))
      (setq agentpane--attached dead
            agentpane--handle "h1")
      (agentpane--set-draft "draft")
      (agentpane--send-prompt "hello" #'ignore)
      (should agentpane--sending)
      (setq agentpane--held-queued '("queued"))
      (agentpane-test--dead-unheard (jsonrpc--process dead))
      (agentpane-test--heard-out dead))
    (should-not agentpane--sending)
    (should-not agentpane--held-queued)
    (should (equal (buffer-substring-no-properties agentpane--prompt-start (point-max))
                   "queued\n\ndraft"))))

(defun agentpane-test--held-attach-replies (count)
  "Attach each of COUNT unattached transcript buffers, whose attaches the
helper answers, each after its snapshot, as the helper writes them,
while a synchronous request is out, and then dies without answering
that request.  Each buffer must end not attached and holding no handle,
each attach answered once, and nothing may go out through a helper
started after it (OW-kifuhi).  Until ark3/agentpane#71 each buffer also
sent a prompt the buffer held back until its attach answered, which was
not to go out either; it now goes out at once, for the helper to hold."
  (let* ((agentpane--connection nil)
         (refs (seq-take '((:backend "codex" :id "t1") (:backend "codex" :id "t2")) count))
         (handles (seq-map-indexed (lambda (_ index) (format "h%d" (1+ index))) refs))
         (started 0)
         (calls nil)
         (answered 0)
         (async (symbol-function 'jsonrpc-async-request))
         ;; Made first, so the helper's snapshots can name their views.
         (buffers (mapcar (lambda (ref) (agentpane--transcript-buffer (list :ref ref))) refs)))
    (agentpane-test--watching
      (cl-letf (((symbol-function 'agentpane--start-helper)
                 (lambda ()
                   (if (> (cl-incf started) 1)
                       (agentpane-test--mute-helper)
                     (agentpane-test--writes-then-dies
                      (append
                       (seq-mapn (lambda (ref handle buffer)
                                   (list :jsonrpc "2.0" :method "session/snapshot"
                                         :params (list :view (agentpane-test--view buffer)
                                                       :session ref :handle handle
                                                       :isStreaming :false :nodes (vector))))
                                 refs handles buffers)
                       (seq-map-indexed (lambda (ref index)
                                          (list :jsonrpc "2.0" :id (1+ index)
                                                :result (list :ref ref :handle (nth index handles))))
                                        refs))))))
                ((symbol-function 'jsonrpc-async-request)
                 (lambda (conn method &rest args)
                   (push method calls)
                   (apply async conn method args)))
                ((symbol-function 'message) #'ignore))
        (unwind-protect
            (let (dead)
              (dolist (buffer buffers)
                (with-current-buffer buffer
                  (agentpane--draw [])
                  (agentpane--attach (lambda () (cl-incf answered))
                                     (lambda () (cl-incf answered)))))
              (setq dead agentpane--connection)
              (should-error (jsonrpc-request dead 'models/list nil :timeout 5))
              (agentpane-test--heard-out dead)
              (should (agentpane-test--wait-for (lambda () (>= answered count))
                                                (+ (float-time) 5)))
              (with-current-buffer (jsonrpc-events-buffer dead)
                (should (string-search "anxious continuation" (buffer-string))))
              ;; Whatever a prompt sent would have gone out by now.
              (accept-process-output nil 0.1)
              (should (= answered count))
              (dolist (buffer buffers)
                (with-current-buffer buffer
                  (should-not (agentpane--attached-p))
                  (should-not agentpane--handle)))
              (should (= (length calls) count)))
          (agentpane-test--end-helper agentpane--connection)
          (mapc #'kill-buffer buffers))))))

(ert-deftest agentpane-test-held-attach-reply-after-a-death-attaches-nothing ()
  "One attach reply held back behind a synchronous request as its helper
dies binds nothing when it is handed on after the teardown (OW-kifuhi)."
  (agentpane-test--held-attach-replies 1))

(ert-deftest agentpane-test-held-attach-replies-after-a-death-attach-nothing ()
  "Two attach replies held back behind a synchronous request as their
helper dies bind nothing when they are handed on after the teardown,
the second to no helper the first one's waiter started (OW-kifuhi)."
  (agentpane-test--held-attach-replies 2))

(ert-deftest agentpane-test-attach-reply-held-after-its-detached-attaches-nothing ()
  "An attach whose snapshot the helper sent and then detached, the reply
coming last and held back as an anxious continuation behind a synchronous
request, leaves the buffer not attached and holding no handle once the
reply is handed on (OW-tifiva), as in wire order
\(`agentpane-test-attach-reply-after-its-detached-attaches-nothing')."
  (agentpane-test--outliving
      (list (list :jsonrpc "2.0" :method "session/snapshot"
                  :params (list :view agentpane--view :session ref :handle "h1" :isStreaming :false
                                :nodes (vector)))
            (list :jsonrpc "2.0" :method "session/detached"
                  :params (list :view agentpane--view :session ref :handle "h1"))
            (list :jsonrpc "2.0" :id 1 :result (list :ref ref :handle "h1"))
            (list :jsonrpc "2.0" :id 2 :result (vector)))
    (setq linger t)
    (let ((answered nil))
      (agentpane--attach nil (lambda () (setq answered t)))
      (should (equal (jsonrpc-request agentpane--connection 'models/list nil :timeout 5) []))
      (should (agentpane-test--wait-for (lambda () answered) (+ (float-time) 5))))
    (with-current-buffer (jsonrpc-events-buffer agentpane--connection)
      (should (string-search "anxious continuation" (buffer-string))))
    (should-not (agentpane--attached-p))
    (should-not agentpane--handle)))

(ert-deftest agentpane-test-turn-done-not-raised-by-a-pi-fork ()
  "A plain fork of a streaming Pi session sends its abort with `unwatch',
and every plain Pi fork sends its fork with it too, since the fork stops
a turn not yet read streaming as well, so the helper drops the parent's
turn-done watch before the stop, and
neither that turn's not-streaming status nor the parent's ended handle
raises the indicator for a turn the user stopped on purpose (OW-dunahe,
D32 point 6); ark3/agentpane#17 retires both with this fork.  A Codex
fork aborts nothing and keeps the parent's turn running, and so
unwatches nothing."
  (dolist (backend '("pi" "codex"))
    (let ((ref (list :backend backend :id "parent")))
      (agentpane-test--with-helper
        (agentpane-test--forking
            [(:id "entry-0" :text "Fix the bug" :index 0)]
            (list :backend backend :id "fork")
          (agentpane-test--with-session ref
            (setq agentpane--attached agentpane--connection
                  agentpane--handle "h1")
            (agentpane--on-notification
             nil 'session/status (list :view agentpane--view :session ref :handle "h1" :isStreaming t))
            (agentpane-test--goto-index 0)
            (agentpane-fork)
            (should (equal (alist-get 'sessions/abort sent)
                           (and (equal backend "pi")
                                (list :session ref :view agentpane--view :unwatch t))))
            (should (eq (plist-get (alist-get 'sessions/fork sent) :unwatch)
                        (equal backend "pi")))))))))

(ert-deftest agentpane-test-turn-done-across-an-edit-send ()
  "An edit sent where the fork stops the parent's running turn carries
`stops', so the helper drops the parent's turn-done watch as it goes
out, and the stop's not-streaming status and a Pi parent's ended handle
raise nothing, as `f' raises nothing for the turn it stops (OW-dunahe,
D32 point 6); where the fork leaves the turn running, or none runs, it
carries none, and the turn's end still raises the indicator.  The helper
arms the fork's own watch at the reply (D30)."
  (pcase-dolist (`(,backend ,stops ,streaming ,carried)
                 '(("pi" t t t) ("codex" nil t nil) ("pi" t nil nil)))
    (let ((ref (list :backend backend :id "parent")))
      (agentpane-test--with-helper
        (agentpane-test--forking
            [(:id "entry-0" :text "Fix the bug" :index 0)]
            (list :backend backend :id "fork")
          (agentpane-test--with-session ref
            (setq agentpane--attached agentpane--connection
                  agentpane--handle "h1"
                  fork-stops stops)
            (agentpane--draw agentpane-test--image-nodes)
            (agentpane--on-notification
             nil 'session/status (list :view agentpane--view :session ref :handle "h1"
                                       :isStreaming (if streaming t :json-false)))
            (agentpane-test--goto-index 0)
            (agentpane-edit)
            (agentpane-send)
            (should (eq (plist-get (alist-get 'sessions/forkAndPrompt sent) :stops) carried))))))))

;;;; A new session whose create does not attach, against a stub jsonrpc

(defmacro agentpane-test--with-create-stub (create &rest body)
  "Run BODY with `sessions/create' answered by CREATE, a function of the
request's params, against a stub connection, then kill every buffer BODY
made.  BODY sees `buffers', the buffers there were before it."
  (declare (indent 1))
  `(let ((agentpane--connection 'connection)
         (buffers (buffer-list)))
     (cl-letf (((symbol-function 'agentpane--connection) (lambda () 'connection))
               ((symbol-function 'jsonrpc-running-p) (lambda (_) t))
               ((symbol-function 'jsonrpc-async-request) #'ignore)
               ((symbol-function 'jsonrpc-request)
                (lambda (_connection method params &rest _)
                  (pcase method
                    ('sessions/create (funcall ,create params))))))
       (unwind-protect
           (save-window-excursion ,@body)
         (dolist (buffer (buffer-list))
           (unless (memq buffer buffers) (kill-buffer buffer)))))))

(ert-deftest agentpane-test-new-session-refused-kills-its-buffer ()
  "A create the helper answered with an error kills the buffer made for
it before the request (D32 point 3), and the error reaches the caller:
the server's refusal leaves no session behind, here the `internal_error'
of a start that failed (D30), and so does, for the buffer, a failure
carrying no server code, the helper's own -32603."
  (dolist (data '((:error "internal_error" :detail "sbox: Could not detect workspace") nil))
    (agentpane-test--with-create-stub
        (lambda (_)
          (signal 'jsonrpc-error
                  `("request id=1 failed:"
                    (jsonrpc-error-code . ,(if data -32000 -32603))
                    (jsonrpc-error-message . "sbox: Could not detect workspace")
                    (jsonrpc-error-data . ,data))))
      (should-error (agentpane-new-session "codex") :type 'jsonrpc-error)
      (should (equal (buffer-list) buffers)))))

(ert-deftest agentpane-test-new-session-quit-fills-its-buffer-at-its-snapshot ()
  "A create quit before its snapshot came keeps the buffer made for it
\(D32 point 3), not shown and holding no session id, so no lookup by ref
finds it: the snapshot under its view, arriving later, gives it the
session's ref and attaches it, still not shown, and the echo area names
it (ark3/agentpane#48)."
  (let ((ref '(:backend "codex" :id "virtual:1"))
        (view nil))
    (agentpane-test--with-create-stub
        (lambda (params)
          (setq view (plist-get params :view))
          (signal 'quit nil))
      (let ((shown (window-buffer (selected-window)))
            (messages nil))
        (should (eq (condition-case err (progn (agentpane-new-session "codex") nil)
                      (quit (car err)))
                    'quit))
        (should-not (agentpane--buffer-for ref))
        (let ((buffer (agentpane--view-buffer view)))
          (should buffer)
          (with-current-buffer buffer
            (should-not (agentpane--made-p))
            (goto-char (point-max))
            (insert "hello")
            (should (equal (cadr (should-error (agentpane-send) :type 'user-error))
                           "This session is not made yet; send once it is")))
          (cl-letf (((symbol-function 'message)
                     (lambda (format &rest args) (push (apply #'format-message format args) messages))))
            (agentpane-test--attach-snapshot ref :view view))
          (should (eq (agentpane--buffer-for ref) buffer))
          (with-current-buffer buffer
            (should (agentpane--attached-p))
            (should (agentpane--made-p)))
          (should (eq (window-buffer (selected-window)) shown))
          (should (equal (car messages)
                         (format "agentpane: the new session is ready in %s" (buffer-name buffer)))))))))

(ert-deftest agentpane-test-new-session-with-no-snapshot-shows-it-and-signals ()
  "A create answered with no snapshot having attached a buffer -- which the
helper sends only once it expects none -- shows the buffer made for it,
not attached, holding the ref the reply names, and signals, reading no
model."
  (let ((ref '(:backend "codex" :id "virtual:1"))
        (view nil))
    (agentpane-test--with-create-stub
        (lambda (params)
          (setq view (plist-get params :view))
          (list :ref ref :cwd default-directory :handle "h1"))
      (cl-letf (((symbol-function 'completing-read)
                 (lambda (&rest _) (error "Read a model"))))
        (should-error (agentpane-new-session "codex") :type 'user-error))
      (let ((buffer (agentpane--buffer-for ref)))
        (should (eq buffer (agentpane--view-buffer view)))
        (should (eq (window-buffer (selected-window)) buffer))
        (with-current-buffer buffer
          (should-not (agentpane--attached-p)))))))

;;;; A new session's model and effort, against a stub jsonrpc

(defun agentpane-test--new-session (choices &optional current held)
  "Run `agentpane-new-session' on Codex against a stub jsonrpc whose
`models/list' answers `agentpane-test--models' and whose prompts answer
CHOICES in turn, the create's snapshot naming CURRENT as the model when
it is non-nil.  Return the requests sent, in order, each as its method or, for
`sessions/setModel' and `sessions/setEffort', as the method and the value
set, then the collections offered.
`sessions/setModel' is answered as it is sent, unless HELD is non-nil: then
its answer waits until `agentpane-new-session' has returned, and the symbol
`answered' marks, among the requests, the moment it arrives."
  (let ((ref '(:backend "codex" :id "virtual-1"))
        (agentpane--connection 'connection)
        (buffers (buffer-list))
        (sent nil)
        (offered nil)
        (answer nil))
    (cl-letf (((symbol-function 'agentpane--connection) (lambda () 'connection))
              ((symbol-function 'jsonrpc-running-p) (lambda (_) t))
              ((symbol-function 'agentpane--request)
               (agentpane-test--refusing
               (lambda (method params callback &rest _)
                 (push (pcase method
                         ('sessions/setModel (list method (plist-get params :model)))
                         ('sessions/setEffort (list method (plist-get params :effort)))
                         (_ method))
                       sent)
                 (when (eq method 'sessions/setModel)
                   (let ((buffer (current-buffer)))
                     (setq answer (lambda ()
                                    (with-current-buffer buffer
                                      (funcall callback nil)))))
                   (unless held
                     (funcall answer))))))
              ((symbol-function 'jsonrpc-request)
               (lambda (_connection method params &rest _)
                 (push method sent)
                 (pcase method
                   ('sessions/create
                    (apply #'agentpane-test--attach-snapshot ref :view (plist-get params :view)
                           (and current (list :isStreaming :json-false :model current)))
                    (list :ref ref :handle "h1"))
                   ('models/list agentpane-test--models))))
              ((symbol-function 'completing-read)
               (lambda (prompt collection &rest _)
                 (unless (equal prompt "Backend: ")
                   (push collection offered))
                 (pop choices))))
      (unwind-protect
          (save-window-excursion
            (agentpane-new-session "codex")
            (when held
              (push 'answered sent)
              (funcall answer))
            (list (reverse sent) (reverse offered)))
        (dolist (buffer (buffer-list))
          (unless (memq buffer buffers) (kill-buffer buffer)))))))

(ert-deftest agentpane-test-new-session-sends-the-effort-once-the-model-answers ()
  "`agentpane-new-session' sends the effort only once `sessions/setModel' has
answered, so the server checks it against the model just chosen, not the
one the session had (OW-zayefe)."
  (should (equal (agentpane-test--new-session '("gpt-5.6-sol" "medium") "gpt-5.6-luna" t)
                 '((sessions/create models/list
                    (sessions/setModel "gpt-5.6-sol") models/list
                    answered (sessions/setEffort "medium"))
                   (("gpt-5.6-luna" "gpt-5.6-sol" "plain") ("medium"))))))

(ert-deftest agentpane-test-new-session-reads-an-effort-after-the-model ()
  "`agentpane-new-session' reads an effort after the model, offering the
efforts of the model just chosen, and sets it after the model."
  (should (equal (agentpane-test--new-session '("gpt-5.6-sol" "medium") "gpt-5.6-luna")
                 '((sessions/create models/list
                    (sessions/setModel "gpt-5.6-sol") models/list
                    (sessions/setEffort "medium"))
                   (("gpt-5.6-luna" "gpt-5.6-sol" "plain") ("medium"))))))

(ert-deftest agentpane-test-new-session-reads-no-effort-without-options ()
  "`agentpane-new-session' prompts for no effort when the model chosen
offers none."
  (should (equal (agentpane-test--new-session '("plain" "low"))
                 '((sessions/create models/list
                    (sessions/setModel "plain") models/list)
                   (("gpt-5.6-luna" "gpt-5.6-sol" "plain"))))))

(ert-deftest agentpane-test-new-session-empty-model-reads-the-current-ones-effort ()
  "With an empty model choice, `agentpane-new-session' offers the efforts of
the model the session already has, and none when that is not known."
  (should (equal (agentpane-test--new-session '("" "high") "gpt-5.6-luna")
                 '((sessions/create models/list models/list
                    (sessions/setEffort "high"))
                   (("gpt-5.6-luna" "gpt-5.6-sol" "plain") ("low" "high")))))
  (should (equal (agentpane-test--new-session '("" "high"))
                 '((sessions/create models/list)
                   (("gpt-5.6-luna" "gpt-5.6-sol" "plain"))))))

;;;; A send that signals, against a stub jsonrpc

(ert-deftest agentpane-test-send-that-signals-frees-the-buffer ()
  "A send whose request signals before it goes out, as when the helper
cannot start, leaves the buffer free to refetch and send again; so does one
whose reply signals while it is handled."
  (let ((ref '(:backend "codex" :id "t1"))
        (sent nil)
        (success nil)
        (starts 0))
    (cl-letf (((symbol-function 'agentpane--connection)
               (lambda (&optional _dead)
                 (when (= (cl-incf starts) 1)
                   (error "Searching for program: No such file or directory, bun"))
                 'connection))
              ((symbol-function 'jsonrpc-running-p) (lambda (_) t))
              ((symbol-function 'jsonrpc-async-request)
               (lambda (_connection method _params &rest args)
                 (push method sent)
                 (setq success (plist-get args :success-fn))
                 (list (length sent)))))
      (agentpane-test--with-session ref
        (goto-char (point-max))
        (insert "hello")
        (should-error (agentpane-send))
        (agentpane-refetch)
        (agentpane-send)
        (should (equal (reverse sent) '(sessions/preview sessions/prompt)))
        (setq sent nil)
        (cl-letf (((symbol-function 'agentpane--attached-p)
                   (lambda () (error "Taking the reply failed"))))
          (should-error (funcall success nil)))
        (agentpane-send)
        (should (equal sent '(sessions/prompt)))))))

;;;; The helper connection, against a fake helper

(defconst agentpane-test--root
  (file-name-directory
   (directory-file-name (file-name-directory (or load-file-name buffer-file-name))))
  "The repository root, where the fake helper's relative imports resolve.")

(defun agentpane-test--wait-for (predicate deadline)
  "Accept process output until PREDICATE answers non-nil or DEADLINE, a
`float-time', passes.  Return PREDICATE's last answer."
  (let (answer)
    (while (and (not (setq answer (funcall predicate)))
                (< (float-time) deadline))
      (accept-process-output nil 0.05))
    answer))

(defmacro agentpane-test--with-fake-helper (order &rest body)
  "Run BODY with the mode's helper replaced by emacs/fake-helper.ts ORDER.
The connection is torn down afterwards, and every buffer BODY made with it."
  (declare (indent 1))
  `(let ((agentpane--connection nil)
         (buffers (buffer-list)))
     (cl-letf (((symbol-function 'agentpane--start-helper)
                (lambda ()
                  (let ((default-directory agentpane-test--root))
                    (make-process :name "agentpane fake helper"
                                  :command (list "bun" "run" "emacs/fake-helper.ts" ,order)
                                  :connection-type 'pipe
                                  :noquery t
                                  :stderr (get-buffer-create "*agentpane stderr*"))))))
       (unwind-protect (progn ,@body)
         (agentpane-shutdown)
         (dolist (buffer (buffer-list))
           (unless (memq buffer buffers) (kill-buffer buffer)))))))

(defun agentpane-test--nested-refetch (order)
  "Refetch a transcript while the helper's `sessions/changed' refetches the
picker, the two replies arriving in ORDER, and check both land promptly.
The fake answers both within 200ms of the refetch, so two seconds is ample.
When every request was a synchronous `jsonrpc-request', the picker's nested
inside the transcript's, both landed but only after about 10 seconds,
`jsonrpc-default-request-timeout' (OW-bonode)."
  (agentpane-test--with-fake-helper order
    (let ((picker (save-window-excursion
                    (agentpane-sessions t)
                    (current-buffer))))
      (should (agentpane-test--wait-for
               (lambda () (with-current-buffer picker (string-search "list 1" (buffer-string))))
               (+ (float-time) 10)))
      (let* ((summary (list :ref (list :backend "pi" :id "session-1")))
             (start (float-time))
             (deadline (+ start 2)))
        (save-window-excursion (agentpane-show-transcript summary))
        (let ((transcript (agentpane--transcript-buffer summary)))
          (should (agentpane-test--wait-for
                   (lambda () (with-current-buffer transcript (string-search "hello" (buffer-string))))
                   deadline)))
        (should (agentpane-test--wait-for
                 (lambda () (with-current-buffer picker (string-search "list 2" (buffer-string))))
                 deadline))
        ;; A wait that began past the deadline still answers true, so the
        ;; clock is asked outright.
        (should (< (- (float-time) start) 2))))))

(ert-deftest agentpane-test-nested-refetch-outer-reply-first ()
  "A picker refetch started during a transcript refetch lands promptly, the
transcript's reply arriving first."
  (agentpane-test--nested-refetch "outer-first"))

(ert-deftest agentpane-test-nested-refetch-inner-reply-first ()
  "A picker refetch started during a transcript refetch lands promptly, the
picker's reply arriving first."
  (agentpane-test--nested-refetch "inner-first"))

(ert-deftest agentpane-test-stale-reply-does-not-overwrite ()
  "Of two refetches from one picker answered in reverse order, the later
request's listing is the one left drawn, not the reply that landed last."
  (agentpane-test--with-fake-helper "lists-reversed"
    (let ((picker (save-window-excursion
                    (agentpane-sessions t)
                    (current-buffer))))
      (with-current-buffer picker (revert-buffer))
      ;; The helper answers `list 2' and then `list 1'; wait until neither
      ;; reply is outstanding before looking.
      (should (agentpane-test--wait-for
               (lambda () (zerop (jsonrpc-continuation-count agentpane--connection)))
               (+ (float-time) 10)))
      (with-current-buffer picker
        (should (string-search "list 2" (buffer-string)))
        (should-not (string-search "list 1" (buffer-string)))))))

(ert-deftest agentpane-test-shutdown-ends-the-helper ()
  "The real helper the mode starts exits cleanly on `agentpane-shutdown' and
is gone from the process table.  Needs `bun install' in the checkout, and
no agentpane server: the request that shows the helper is reading its
input is one it answers itself, opening no socket, so no failed open
ends the helper ahead of the shutdown (`respond' in src/emacs/helper.ts)."
  (let ((agentpane--connection nil)
        (agentpane-project-directory agentpane-test--root))
    (let* ((connection (agentpane--connection))
           (process (jsonrpc--process connection))
           (pid (process-id process)))
      ;; Until the helper has loaded its renderer, about a second, it is not
      ;; reading stdin, and its exit would miss `jsonrpc-shutdown''s grace.
      (should (eq 'jsonrpc-error
                  (car (should-error (jsonrpc-request connection 'agentpane-test/unknown
                                                      :jsonrpc-omit :timeout 10)))))
      (should (process-attributes pid))
      (agentpane-shutdown)
      (should-not agentpane--connection)
      (should (eq (process-status process) 'exit))
      (should (eql (process-exit-status process) 0))
      (should-not (process-attributes pid)))))

(provide 'agentpane-test)

;;; agentpane-test.el ends here
