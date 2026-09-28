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
of wide characters, of right-to-left text, and holding a tab or a
newline, with the meta beside them and without, at widths from a few
columns to the window's, and with the window scrolled horizontally."
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
                                              'face 'agentpane-thinking)
                                  (concat "abc\ndef " words))))
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
       (list :session ref :node (agentpane-test--assistant 1 "<p>Done now.</p>")))
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
       (list :session ref :node (agentpane-test--assistant 3 "<p>Appended.</p>")))
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
         nil 'session/node (list :session ref :node (agentpane-test--assistant 1 html))))
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
        (agentpane--on-notification nil 'session/node (list :session ref :node node)))
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
       nil 'session/node (list :session ref :node (agentpane-test--assistant 1 "<p>Done now.</p>")))
      (let ((set-status (symbol-function 'agentpane--set-status)))
        (cl-letf (((symbol-function 'agentpane--set-status)
                   (lambda (params)
                     (setq seen (string-search "Done now." (buffer-string)))
                     (funcall set-status params))))
          (agentpane--on-notification
           nil 'session/status (list :session ref :isStreaming :json-false))))
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
       nil 'session/node (list :session ref :node (agentpane-test--assistant 3 "<p>Three.</p>")))
      (agentpane--on-notification
       nil 'session/notice
       (list :session ref
             :notice '(:kind "warning" :message "Fallback metadata" :details nil :path nil)))
      (agentpane-test--redraw buffer)
      (should (equal (agentpane-test--indices) '(0 1 3 nil)))
      (should (< (agentpane-test--position "Three.")
                 (agentpane-test--position "ℹ Fallback metadata"))))))

(ert-deftest agentpane-test-snapshot-discards-the-recorded-node ()
  "A `session/snapshot' after a `session/node' not yet drawn supersedes it:
the snapshot's nodes are drawn and the recorded one never is."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/node (list :session ref :node (agentpane-test--assistant 3 "<p>Stale.</p>")))
      (agentpane--on-notification
       nil 'session/snapshot
       (list :session ref :isStreaming :json-false :nodes agentpane-test--nodes))
      (agentpane-test--redraw buffer)
      (should (equal drawn '(1 0)))
      (should-not (string-search "Stale." (buffer-string))))))

(ert-deftest agentpane-test-recorded-node-dies-with-its-buffer ()
  "A `session/node' recorded for a buffer killed before its redraw runs is
never drawn, and the redraw raises nothing."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/node (list :session ref :node (agentpane-test--assistant 1 "<p>Done now.</p>")))
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
       (list :session ref
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
      (agentpane--on-notification nil 'session/notice (list :session ref :notice notice))
      (agentpane--on-notification
       nil 'session/snapshot
       (list :session ref :isStreaming :json-false :nodes agentpane-test--nodes
             :notices (vector notice)))
      (should (equal (agentpane-test--indices) '(0 1 nil)))
      (should (equal (ewoc-data (ewoc-nth agentpane--ewoc -1)) (list :notice notice)))
      (should (< (agentpane-test--position "Looking.")
                 (agentpane-test--position "ℹ Fallback metadata")
                 (agentpane-test--position "── prompt"))))))

(ert-deftest agentpane-test-snapshot-restores-error-requests-and-notices ()
  "A `session/snapshot' carrying the session's turn error, pending requests
and notices, as the one an attach made after they were raised does, draws
all three after its nodes, the error and each request as a warning line
naming what it is (OW-bipume)."
  (let ((ref '(:backend "codex" :id "t1"))
        (request '(:requestId "r1" :session (:backend "codex" :id "t1")
                   :kind "item/fileChange/requestApproval" :payload nil))
        (notice '(:kind "configWarning" :message "Unknown key" :details nil :path nil)))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/snapshot
       (list :session ref :isStreaming :json-false :nodes agentpane-test--nodes
             :error "Turn failed upstream" :requests (vector request)
             :notices (vector notice)))
      (should (equal (agentpane-test--indices) '(0 1 nil nil nil)))
      (let ((error-at (agentpane-test--position "⚠ Turn failed upstream"))
            (request-at (agentpane-test--position "item/fileChange/requestApproval")))
        (should (eq (get-text-property error-at 'face) 'agentpane-warning))
        (should (eq (get-text-property request-at 'face) 'agentpane-warning))
        (should (< (agentpane-test--position "Looking.")
                   error-at
                   (agentpane-test--position "ℹ Unknown key")
                   request-at
                   (agentpane-test--position "── prompt"))))
      ;; A snapshot holding none of them, as after the next prompt is admitted,
      ;; draws none.
      (agentpane--on-notification
       nil 'session/snapshot
       (list :session ref :isStreaming :json-false :nodes agentpane-test--nodes
             :error nil :requests [] :notices []))
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
       nil 'session/error (list :session ref :message "Turn failed upstream"))
      (agentpane--on-notification
       nil 'session/error (list :session ref :message "Turn failed again"))
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
        (agentpane--on-notification
         nil 'session/error (list :session ref :message "Turn failed upstream" :errorId "e3"))
        (agentpane--on-notification
         nil 'session/error (list :session ref :message "Turn failed upstream" :errorId "e4"))
        (goto-char (point-max))
        (call-interactively (key-binding (kbd "C-c C-d")))
        (should (equal sent `((sessions/dismissError :session ,ref :errorId "e4"))))
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
         (list :session ref :isStreaming :json-false :nodes agentpane-test--nodes
               :error "Turn failed upstream" :errorId "e6" :requests [] :notices []))
        (goto-char (point-max))
        (call-interactively (key-binding (kbd "C-c C-d")))
        (should (equal sent `((sessions/dismissError :session ,ref :errorId "e6"))))))))

(ert-deftest agentpane-test-error-cleared-drops-its-line ()
  "A `session/errorCleared' drops the turn error's line, as the server says
it no longer holds it, leaving the draft in the prompt region alone
\(OW-jopifu)."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/error (list :session ref :message "Turn failed upstream"))
      (goto-char (point-max))
      (insert "draft")
      (agentpane--on-notification nil 'session/errorCleared (list :session ref))
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
        (agentpane--on-notification
         nil 'session/error (list :session ref :message "Turn failed upstream"))
        (goto-char (point-max))
        (call-interactively (key-binding (kbd "C-c C-d")))
        (should-not (agentpane-test--warnings))
        (agentpane--on-notification
         nil 'session/snapshot
         (list :session ref :isStreaming :json-false :nodes agentpane-test--nodes
               :error "Turn failed upstream" :requests [] :notices []))
        (should (equal (agentpane-test--warnings) '("Turn failed upstream")))
        (agentpane--on-notification nil 'session/errorCleared (list :session ref))
        (should-not (string-search "⚠" (buffer-string)))))))

(ert-deftest agentpane-test-request-is-drawn-where-it-arrives ()
  "A `session/request' appends the same warning line a snapshot draws for it."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/request
       (list :session ref
             :request '(:requestId "r1" :session (:backend "codex" :id "t1")
                        :kind "item/fileChange/requestApproval" :payload nil)))
      (should (plist-member (ewoc-data (ewoc-nth agentpane--ewoc -1)) :request))
      (let ((at (agentpane-test--position "item/fileChange/requestApproval")))
        (should (eq (get-text-property at 'face) 'agentpane-warning))
        (should (< (agentpane-test--position "Looking.") at
                   (agentpane-test--position "── prompt")))))))

(ert-deftest agentpane-test-request-resolved-drops-its-line ()
  "A `session/requestResolved' drops the line drawn for the request it
names and no other, leaving the draft in the prompt region alone
(OW-gusifo)."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (dolist (id '("r1" "r2"))
        (agentpane--on-notification
         nil 'session/request
         (list :session ref
               :request `(:requestId ,id :session (:backend "codex" :id "t1")
                          :kind ,(concat "kind/" id) :payload nil))))
      (goto-char (point-max))
      (insert "draft")
      (agentpane--on-notification
       nil 'session/requestResolved (list :session ref :requestId "r1"))
      (should-not (string-search "kind/r1" (buffer-string)))
      (should (string-search "kind/r2" (buffer-string)))
      (should (equal (agentpane-test--indices) '(0 1 nil)))
      (should (string-suffix-p "draft" (buffer-string))))))

(ert-deftest agentpane-test-meta-waits-for-the-streaming-turn-to-end ()
  "While the session streams, the last node draws no meta line and an
earlier one does, and the last one's appears once a status says the
streaming ended, though no node is re-sent."
  (let ((ref '(:backend "pi" :id "s1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification
       nil 'session/snapshot
       (list :session ref :isStreaming t
             :nodes (vector (agentpane-test--assistant 1 "<p>One.</p>")
                            (agentpane-test--assistant 2 "<p>Two.</p>"))))
      (should (= 1 (count-matches "^— luna" (point-min) (point-max))))
      (should (< (agentpane-test--position "— luna") (agentpane-test--position "Two.")))
      (agentpane--on-notification
       nil 'session/status (list :session ref :isStreaming :json-false))
      (should (= 2 (count-matches "^— luna" (point-min) (point-max)))))))

(ert-deftest agentpane-test-appended-node-releases-the-previous-tail ()
  "A node appended while the session streams is drawn without its meta line,
and the node it follows, no longer the last, is redrawn with its own."
  (let ((ref '(:backend "pi" :id "s1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification nil 'session/status (list :session ref :isStreaming t))
      (agentpane--on-notification
       nil 'session/node (list :session ref :node (agentpane-test--assistant 3 "<p>Three.</p>")))
      (agentpane-test--redraw buffer)
      (should (string-search "· haiku" (buffer-string)))
      (should-not (string-search "— luna" (buffer-string)))
      (agentpane--on-notification
       nil 'session/node (list :session ref :node (agentpane-test--assistant 5 "<p>Five.</p>")))
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
       (list :session ref :isStreaming t
             :nodes (vector (agentpane-test--running-tool 1 "sleep 60"))))
      (should (string-search "◔ Bash" (agentpane-test--line-at "sleep 60")))
      (agentpane--on-notification
       nil 'session/status (list :session ref :isStreaming :json-false))
      (should-not (string-search "◔" (agentpane-test--line-at "sleep 60")))
      (should (string-search "✓ Bash" (agentpane-test--line-at "sleep 60"))))))

(ert-deftest agentpane-test-appended-node-settles-the-previous-running-tool ()
  "A node appended while the session streams draws the tool call with no
result on the node it follows as `ok', since that is no longer the last."
  (let ((ref '(:backend "pi" :id "s1")))
    (agentpane-test--with-session ref
      (agentpane--on-notification nil 'session/status (list :session ref :isStreaming t))
      (agentpane--on-notification
       nil 'session/node (list :session ref :node (agentpane-test--running-tool 3 "sleep 60")))
      (agentpane-test--redraw buffer)
      (should (string-search "◔ Bash" (agentpane-test--line-at "sleep 60")))
      (agentpane--on-notification
       nil 'session/node (list :session ref :node (agentpane-test--assistant 5 "<p>Five.</p>")))
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
               (list :session to :handle "h1"
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
ref, deliberately, since only the live one holds the handle, and the
preview, which never sent an attach, sends no `sessions/detach' when
killed, which by that ref alone would stop the helper feeding the live
one.  The snapshot under the ref both hold, sent before the reply, is not
the preview's to take: it names the ref the live one asked for.  The live
one draws it, stays attached, and hears the session under its handle."
  (let ((alias '(:backend "claude" :id "pending-1"))
        (canonical '(:backend "claude" :id "real-2")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (setq hold '(sessions/attach)
              attached (list :ref canonical :handle "h1"))
        (let ((live (agentpane--transcript-buffer (list :ref alias)))
              (preview (agentpane--transcript-buffer (list :ref canonical))))
          (with-current-buffer live (agentpane--attach))
          (agentpane--on-notification nil 'session/snapshot
                                      (list :session canonical :handle "h1" :askedFor alias
                                            :nodes []))
          (funcall (cdr (pop held)) t)
          (should (buffer-live-p preview))
          (should-not (buffer-local-value 'agentpane--handle preview))
          (setq sent nil)
          (kill-buffer preview)
          (should-not sent)
          (agentpane--on-notification
           nil 'session/node (list :session canonical :handle "h1"
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
      (agentpane--on-notification nil 'session/status (list :session to :handle "h1" :isStreaming t))
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

(defun agentpane-test--attach-answered-under-a-new-ref (snapshot-first)
  "Attach a buffer whose reply names another ref and a handle than the one
it asked for, with the snapshot under that ref and handle, which the
helper tags with the ref the attach asked for, handled before the reply's
callback if SNAPSHOT-FIRST, else after it, and check that the buffer that
asked drew it and holds the reply's handle and ref."
  (let ((asked '(:backend "claude" :id "pending-1"))
        (ref '(:backend "claude" :id "real-2")))
    (agentpane-test--forking nil nil
      (setq hold '(sessions/attach)
            attached (list :ref ref :handle "h1"))
      (let ((buffer (agentpane--transcript-buffer (list :ref asked)))
            (snapshot (list :session ref :handle "h1" :askedFor asked
                            :nodes (vector (agentpane-test--assistant 3 "<p>Live.</p>")))))
        (with-current-buffer buffer (agentpane--attach))
        (if snapshot-first
            (progn
              (agentpane--on-notification nil 'session/snapshot snapshot)
              (funcall (cdr (pop held)) t))
          (funcall (cdr (pop held)) t)
          (agentpane--on-notification nil 'session/snapshot snapshot))
        (with-current-buffer buffer
          (should (equal (agentpane-test--indices) '(3)))
          (should (equal agentpane--handle "h1"))
          (should (agentpane--same-ref-p (agentpane--ref agentpane--session) ref)))
        (should (equal (agentpane-test--holders ref) (list buffer)))))))

(ert-deftest agentpane-test-attach-answered-under-a-new-ref-draws-a-snapshot-handled-before-its-reply ()
  "An attach whose reply names another ref than the one asked for draws the
snapshot under the new ref that was handled before the reply's callback,
which the helper sends before the reply (`sessions/attach' in
src/emacs/helper.ts), and which jsonrpc.el may also run first after a
reply it held back as an anxious continuation: the snapshot's `askedFor'
finds the buffer that asked, which takes the handle from it."
  (agentpane-test--attach-answered-under-a-new-ref t))

(ert-deftest agentpane-test-attach-answered-under-a-new-ref-draws-a-snapshot-handled-after-its-reply ()
  "An attach whose reply names another ref than the one asked for draws the
snapshot under the new ref handled after the reply's callback, which finds
the buffer by the handle the reply gave it."
  (agentpane-test--attach-answered-under-a-new-ref nil))

(ert-deftest agentpane-test-attach-under-a-new-ref-holds-the-handle-its-snapshot-gave-when-the-reply-fails ()
  "An attach answered under another ref whose reply fails in Emacs -- a
timeout, or a quit in `agentpane-new-session' -- after the helper took the
attach still holds the handle and ref its tagged snapshot gave it: it is
drawn, hears what follows under the handle, and its detach names the
handle, which is what stops the helper sending for it."
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
           (list :session ref :handle "h1" :askedFor asked
                 :nodes (vector (agentpane-test--assistant 3 "<p>Live.</p>"))))
          (funcall (cdr (pop held)) nil)
          (agentpane--on-notification nil 'session/status
                                      (list :session ref :handle "h1" :isStreaming t))
          (with-current-buffer buffer
            (should (equal agentpane--handle "h1"))
            (should (agentpane--same-ref-p (agentpane--ref agentpane--session) ref))
            (should (equal (agentpane-test--indices) '(3)))
            (should agentpane--streaming))
          (setq sent nil)
          (kill-buffer buffer)
          (should (equal sent `((sessions/detach :session ,ref :handle "h1")))))))))

(ert-deftest agentpane-test-attach-under-a-new-ref-hears-what-follows-its-snapshot-before-its-reply ()
  "What follows the tagged snapshot of an attach answered under another
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
         (list :session ref :handle "h1" :askedFor asked :isStreaming t
               :nodes (vector (agentpane-test--assistant 3 "<p>Live.</p>"))))
        (agentpane--on-notification nil 'session/status
                                    (list :session ref :handle "h1" :isStreaming :json-false))
        (funcall (cdr (pop held)) t)
        (with-current-buffer buffer
          (should (equal agentpane--handle "h1"))
          (should-not agentpane--streaming)
          (should (equal (agentpane-test--indices) '(3))))))))

(ert-deftest agentpane-test-snapshot-under-a-new-handle-moves-the-attached-buffer ()
  "A `session/snapshot' under a handle no buffer holds, for the ref an
attached buffer holds under another -- the one answering that buffer's
own attach, sent from a handle the server no longer has -- moves that
buffer onto the new handle, not a buffer only previewing the same ref,
and what follows under the new handle reaches it."
  (let ((ref '(:backend "claude" :id "real-2")))
    (agentpane-test--forking nil nil
      (let ((live (agentpane--transcript-buffer
                   (list :ref '(:backend "claude" :id "pending-1"))))
            (preview (agentpane--transcript-buffer (list :ref ref))))
        (with-current-buffer live (setq agentpane--handle "h1"))
        ;; The live one renamed onto the ref the other previews.
        (agentpane--on-notification nil 'session/snapshot
                                    (list :session ref :handle "h1" :nodes []))
        (agentpane--on-notification
         nil 'session/snapshot
         (list :session ref :handle "h2"
               :nodes (vector (agentpane-test--assistant 3 "<p>Restarted.</p>"))))
        (agentpane--on-notification
         nil 'session/node (list :session ref :handle "h2"
                                 :node (agentpane-test--assistant 5 "<p>Next.</p>")))
        (agentpane-test--redraw live)
        (with-current-buffer live
          (should (equal agentpane--handle "h2"))
          (should (equal (agentpane-test--indices) '(3 5))))
        (with-current-buffer preview
          (should-not agentpane--handle)
          (should-not agentpane--ewoc))))))

(defmacro agentpane-test--detached (&rest body)
  "Run BODY in a transcript buffer `buffer' attached to the session `ref'
under the handle \"h1\" through a helper that counts as running, its
transcript drawn by a snapshot under that handle, streaming on the model
\"luna\", as the node at index 3, a tool call running \"sleep 60\",
after the helper has said `session/detached' for that handle: its
reopened stream's listing lacked it (OW-yibijo).  Every request is
answered as `agentpane-test--forking' answers it, and the model's
`models/list' is never answered."
  (declare (indent 0))
  `(let ((ref '(:backend "claude" :id "real-1")))
     (agentpane-test--with-helper
       (agentpane-test--forking nil nil
         (cl-letf (((symbol-function 'jsonrpc-async-request) #'ignore))
           (setq attached (list :ref ref :handle "h1"))
           (let ((buffer (agentpane--transcript-buffer (list :ref ref))))
             (with-current-buffer buffer (agentpane--attach))
             (agentpane--on-notification
              nil 'session/snapshot
              (list :session ref :handle "h1" :isStreaming t :model "luna"
                    :nodes (vector (agentpane-test--running-tool 3 "sleep 60"))))
             (agentpane--on-notification nil 'session/detached
                                         (list :session ref :handle "h1"))
             (setq sent nil)
             ,@body))))))

(ert-deftest agentpane-test-detached-lets-go-of-the-handle-and-g-attaches-again ()
  "A `session/detached' for the handle a buffer holds leaves it holding no
handle and not attached, with its ref and the transcript it drew, and
reading as not streaming, as the status that ends a turn leaves it: the
mode line names the model and no streaming, and the tail's running tool
call is drawn `ok'.  A `g' then attaches its ref again rather than
previewing the stored transcript over the live one it drew."
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
      (should (equal sent `((sessions/attach :session ,ref)))))))

(ert-deftest agentpane-test-detached-buffer-takes-the-handle-its-reattach-answers-under-a-new-ref ()
  "The attach a `g' sends from a buffer told its handle is gone, answered
under a new handle and a ref the buffer never heard -- a rename it missed
-- binds that buffer to the new handle by the snapshot's `askedFor', and
the snapshot redraws it, before the reply lands and after."
  (agentpane-test--detached
    (let ((renamed '(:backend "claude" :id "real-2")))
      (setq hold '(sessions/attach)
            attached (list :ref renamed :handle "h2"))
      (with-current-buffer buffer (agentpane-refetch))
      (agentpane--on-notification
       nil 'session/snapshot
       (list :session renamed :handle "h2" :askedFor ref
             :nodes (vector (agentpane-test--assistant 5 "<p>Back.</p>"))))
      (with-current-buffer buffer
        (should (equal agentpane--handle "h2"))
        (should (agentpane--same-ref-p (agentpane--ref agentpane--session) renamed))
        (should (equal (agentpane-test--indices) '(5))))
      (funcall (cdr (pop held)) t)
      (with-current-buffer buffer
        (should (equal agentpane--handle "h2"))
        (should (agentpane--attached-p))))))

(ert-deftest agentpane-test-detached-for-a-handle-no-buffer-holds-touches-no-buffer ()
  "A `session/detached' goes only to the buffer holding its handle: one
for a handle no buffer holds leaves a buffer only previewing its ref, and
one awaiting an attach of its ref, as they were, so the preview's `g'
still previews."
  (let ((previewed '(:backend "claude" :id "real-1"))
        (awaited '(:backend "claude" :id "real-2")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (setq hold '(sessions/attach))
        (let ((preview (agentpane--transcript-buffer (list :ref previewed)))
              (attaching (agentpane--transcript-buffer (list :ref awaited))))
          (with-current-buffer attaching (agentpane--attach))
          (agentpane--on-notification nil 'session/detached
                                      (list :session previewed :handle "h8"))
          (agentpane--on-notification nil 'session/detached
                                      (list :session awaited :handle "h9"))
          (with-current-buffer attaching
            (should-not agentpane--dropped)
            (should agentpane--attaching))
          (with-current-buffer preview
            (should-not agentpane--dropped)
            (setq sent nil)
            (agentpane-refetch)
            (should (equal (mapcar #'car sent) '(sessions/preview)))))))))

(defmacro agentpane-test--merging (&rest body)
  "Run BODY with a transcript buffer `holder' holding the session under the
handle \"h1\" at a ref it has since left for `canonical', and a buffer
`previewing' holding it at the ref `alias' and no handle, whose attach the
helper answers with the session's summary, and every request answered as
`agentpane-test--forking' answers it.  BODY sends the attach.
The reply naming `canonical' has overtaken the notification under the
handle that would move `holder' there, which it may, the two being
unordered (D2), so only the handle joins the two buffers."
  (declare (indent 0))
  `(let ((canonical '(:backend "claude" :id "real-2"))
         (alias '(:backend "claude" :id "pending-1")))
     (agentpane-test--forking nil nil
       (setq attached (list :ref canonical :handle "h1"))
       (let ((holder (agentpane--transcript-buffer
                      (list :ref '(:backend "claude" :id "real-1") :cwd "/tmp/x/sandbox")))
             (previewing (agentpane--transcript-buffer
                          (list :ref alias :cwd "/tmp/x/sandbox"))))
         (with-current-buffer holder (setq agentpane--handle "h1"))
         ,@body))))

(ert-deftest agentpane-test-attach-onto-a-held-handle-leaves-one-buffer ()
  "An attach whose reply names the handle another transcript buffer holds
leaves exactly one buffer holding it: the one that attached, which hears
the session from then on.  The other is killed without detaching the
session, a window that showed it shows the survivor, and the survivor
attaches again, since the attach's snapshot may have been drawn in the
other."
  (agentpane-test--with-helper
    (agentpane-test--merging
      (delete-other-windows)
      (switch-to-buffer holder)
      (with-current-buffer previewing (agentpane--attach))
      (should-not (buffer-live-p holder))
      (should (equal (agentpane-test--holders canonical) (list previewing)))
      (should (eq (agentpane--buffer-holding "h1") previewing))
      (should (equal (reverse sent)
                     `((sessions/attach :session ,alias)
                       (sessions/attach :session ,canonical))))
      (should (eq (window-buffer (selected-window)) previewing))
      (agentpane--on-notification
       nil 'session/snapshot
       (list :session canonical :handle "h1"
             :nodes (vector (agentpane-test--assistant 3 "<p>Live.</p>"))))
      (with-current-buffer previewing
        (should (equal (agentpane-test--indices) '(3)))))))

(ert-deftest agentpane-test-attach-now-onto-a-held-handle-attaches-again ()
  "A synchronous attach whose reply names the handle another buffer holds
merges that one into this one, which then attaches again, as the
asynchronous attach does, for a snapshot of its own."
  (agentpane-test--merging
    (cl-letf (((symbol-function 'agentpane--connection) (lambda () 'connection))
              ((symbol-function 'jsonrpc-request) (lambda (&rest _) attached)))
      (with-current-buffer previewing (agentpane--attach-now))
      (should-not (buffer-live-p holder))
      (should (equal sent `((sessions/attach :session ,canonical)))))))

(ert-deftest agentpane-test-attach-onto-a-held-handle-keeps-drafts ()
  "When an attach reply merges the buffer holding its handle into the one
that attached, the other's prompt-region draft follows the survivor's own,
and the other's composer, text and all, sends to the survivor."
  (agentpane-test--merging
    (let (composer)
      (with-current-buffer previewing
        (goto-char (point-max))
        (insert "mine"))
      (with-current-buffer holder
        (goto-char (point-max))
        (insert "theirs")
        (save-current-buffer (agentpane-prompt))
        (setq composer agentpane--composer))
      (with-current-buffer composer (insert "composed"))
      (with-current-buffer previewing (agentpane--attach))
      (should-not (buffer-live-p holder))
      (with-current-buffer previewing
        (should (equal (buffer-substring-no-properties agentpane--prompt-start (point-max))
                       "mine\ntheirs"))
        (should (eq agentpane--composer composer)))
      (with-current-buffer composer
        (should (eq (agentpane--transcript) previewing))
        (should (equal (buffer-string) "composed"))))))

(ert-deftest agentpane-test-attach-onto-a-held-handle-names-the-adopted-composer ()
  "When an attach reply's merge hands the buffer that attached, which has
no composer, the other's, that composer is named after the survivor."
  (agentpane-test--merging
    (let (composer)
      (with-current-buffer holder
        (save-current-buffer (agentpane-prompt))
        (setq composer agentpane--composer))
      (should (equal (buffer-name composer) "*agentpane/claude: sandbox prompt*"))
      (with-current-buffer previewing (agentpane--attach))
      (should (eq (buffer-local-value 'agentpane--composer previewing) composer))
      (should (equal (buffer-name composer) "*agentpane/claude: sandbox<2> prompt*")))))

(ert-deftest agentpane-test-snapshot-keeps-window-start ()
  "A `session/snapshot' leaves the start of a window following the tail the
same distance from the end, and that of any other window where it was."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-session ref
      (save-window-excursion
        (let ((window (selected-window))
              (snapshot (lambda (nodes)
                          (agentpane--on-notification
                           nil 'session/snapshot (list :session ref :nodes nodes)))))
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

(ert-deftest agentpane-test-set-model-only-before-the-first-prompt ()
  "`agentpane-set-model' on a buffer with nodes signals the gate's error and
sends nothing; on a buffer with none it attaches and sends `sessions/setModel'."
  (let ((ref '(:backend "codex" :id "t1"))
        (sent nil))
    (cl-letf (((symbol-function 'agentpane--request)
               (lambda (method _params callback &rest _)
                 (push method sent)
                 (funcall callback (list :ref ref))))
              ((symbol-function 'jsonrpc-async-request)
               (lambda (&rest _) (push 'jsonrpc-async-request sent)))
              ((symbol-function 'jsonrpc-request)
               (lambda (&rest _) (push 'jsonrpc-request sent))))
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
               (lambda (method _params callback &rest _)
                 (push method sent)
                 (funcall callback (list :ref ref))))
              ((symbol-function 'jsonrpc-request)
               (lambda (_connection method &rest _)
                 (push method sent)
                 (pcase method
                   ('sessions/attach (list :ref ref))
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
with none it attaches and sends `sessions/setEffort'."
  (let ((ref '(:backend "codex" :id "t1"))
        (sent nil))
    (cl-letf (((symbol-function 'agentpane--request)
               (lambda (method _params callback &rest _)
                 (push method sent)
                 (funcall callback (list :ref ref))))
              ((symbol-function 'jsonrpc-async-request)
               (lambda (&rest _) (push 'jsonrpc-async-request sent)))
              ((symbol-function 'jsonrpc-request)
               (lambda (&rest _) (push 'jsonrpc-request sent))))
      (agentpane-test--with-session ref
        (dolist (call (list (lambda () (agentpane-set-effort "high"))
                            (lambda () (call-interactively #'agentpane-set-effort))))
          (should (equal (cadr (should-error (funcall call) :type 'user-error))
                         "The effort is chosen before the first prompt")))
        (should-not sent)
        (agentpane--draw [])
        (agentpane-set-effort "high")
        (should (equal (reverse sent) '(sessions/attach sessions/setEffort)))))))

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
               (lambda (method _params callback &rest _)
                 (push method sent)
                 (funcall callback (list :ref ref))))
              ((symbol-function 'jsonrpc-request)
               (lambda (_connection method &rest _)
                 (push method sent)
                 (pcase method
                   ('sessions/attach (list :ref ref))
                   ('models/list agentpane-test--models))))
              ;; The mode line's own listing, which these tests do not measure.
              ((symbol-function 'jsonrpc-async-request) #'ignore)
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
turn; one whose effort is null names none while no `models/list' has
answered."
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
  "A status whose effort is null names the model's `defaultEffort' from
`models/list' in the mode line once the listing answers, as the browser's
effort select does, and one that reports an effort names that instead.
The listing is asked for once per model named, not once per status."
  (let ((ref '(:backend "codex" :id "t1"))
        (agentpane--connection 'connection)
        (sent nil))
    (cl-letf (((symbol-function 'jsonrpc-running-p) (lambda (_) t))
              ((symbol-function 'jsonrpc-async-request)
               (lambda (_connection method params &rest args)
                 (push (list method params (plist-get args :success-fn)) sent))))
      (agentpane-test--with-session ref
        (agentpane--draw [])
        (agentpane--set-status
         (list :session ref :isStreaming :json-false :model "gpt-5.6-luna" :effort nil))
        (should (equal mode-line-process " [gpt-5.6-luna]"))
        (let ((listed (assq 'models/list sent)))
          (should listed)
          (should (equal (nth 1 listed) '(:backend "codex")))
          (funcall (nth 2 listed) agentpane-test--models))
        (should (equal mode-line-process " [gpt-5.6-luna · low]"))
        (agentpane--set-status
         (list :session ref :isStreaming :json-false :model "gpt-5.6-luna" :effort "high"))
        (should (equal mode-line-process " [gpt-5.6-luna · high]"))
        (agentpane--set-status
         (list :session ref :isStreaming t :model "gpt-5.6-luna" :effort nil))
        (should (equal mode-line-process " [streaming · gpt-5.6-luna · low]"))
        (should (= (seq-count (lambda (request) (eq (car request) 'models/list)) sent) 1))))))

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
       (list :session ref :node (agentpane-test--assistant 1 "<p>Streaming more.</p>")))
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
                 (list :session '(:backend "codex" :id "t1")
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
         (list :session ref
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
             (list :session ref :node (agentpane-test--assistant 1 "<p>Redrawn.</p>")))
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

(defun agentpane-test--above-prompt ()
  "The overlay string shown in the current buffer, without properties, or nil."
  (let ((shown (seq-some (lambda (overlay) (overlay-get overlay 'before-string))
                         (overlays-in (point-min) (point-max)))))
    (and shown (substring-no-properties shown))))

(defun agentpane-test--tail-status ()
  "The reading-view tail status line shown in the current buffer, or nil.
Not `agentpane-test--hiding-line', which the same overlay may carry."
  (let ((shown (agentpane-test--above-prompt)))
    (and (not (equal shown agentpane-test--hiding-line)) shown)))

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
       (list :session ref :isStreaming t
             :nodes (vector (aref agentpane-test--nodes 0) (funcall running "Bash" "bun test"))))
      (should (equal (agentpane-test--tail-status) "Bash bun test … running\n"))
      (agentpane--on-notification
       nil 'session/node (list :session ref :node (funcall running "Read" "app.ts")))
      (agentpane-test--redraw buffer)
      (should (equal (agentpane-test--tail-status) "Read app.ts … running\n"))
      (agentpane--on-notification
       nil 'session/status (list :session ref :isStreaming :json-false))
      (should-not (agentpane-test--tail-status))
      (agentpane--on-notification nil 'session/status (list :session ref :isStreaming t))
      (should (agentpane-test--tail-status))
      (agentpane--on-notification
       nil 'session/node (list :session ref :node (agentpane-test--assistant 2 "<p>Done.</p>")))
      (agentpane-test--redraw buffer)
      (should-not (agentpane-test--tail-status))
      (agentpane--on-notification
       nil 'session/node (list :session ref :node (plist-put (funcall running "Bash" "again")
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
       (list :session ref :isStreaming :json-false :nodes agentpane-test--all-chrome-nodes))
      (should (agentpane-test--hiding-p))
      (agentpane--on-notification
       nil 'session/node (list :session ref :node (agentpane-test--assistant 4 "<p>Done.</p>")))
      (agentpane-test--redraw buffer)
      (should-not (agentpane-test--hiding-p))
      (agentpane--on-notification
       nil 'session/snapshot
       (list :session ref :isStreaming t
             :nodes (vector (list :index 1 :role "assistant"
                                  :parts (vector (list :type "tool" :name "Bash"
                                                       :summary "bun test" :args ""
                                                       :result "" :state "running"))))))
      (should (equal (agentpane-test--above-prompt) "Bash bun test … running\n"))
      (agentpane--on-notification
       nil 'session/status (list :session ref :isStreaming :json-false))
      (should (agentpane-test--hiding-p))
      (agentpane--on-notification
       nil 'session/snapshot (list :session ref :isStreaming :json-false :nodes []))
      (should-not (agentpane-test--above-prompt)))))

;;;; Forking, against a stub connection

(defmacro agentpane-test--forking (points forked &rest body)
  "Run BODY with every request answered as the helper would: POINTS for
`sessions/forkPoints', FORKED for `sessions/fork', a summary of the ref
asked for for `sessions/attach', unless BODY has put a summary of its own
in `attached', and the fixed nodes for `sessions/preview'.
Each request is pushed onto `sent' as (METHOD . PARAMS), and each `message'
onto `said'.  A request whose method BODY has put in `hold' is not answered
at once: (METHOD . ANSWER) is appended to `held' instead, and BODY calls
ANSWER with t to deliver the reply, or with nil to fail the request as
`agentpane--request' reports an error.  Either way the answer runs in the
buffer that sent the request.  Every buffer BODY made is killed afterwards."
  (declare (indent 2))
  `(let ((sent nil)
         (said nil)
         (hold nil)
         (held nil)
         (attached nil)
         (buffers (buffer-list)))
     (cl-letf (((symbol-function 'agentpane--request)
                (lambda (method params callback &optional _always failed &rest _)
                  (push (cons method params) sent)
                  (let* ((from (current-buffer))
                         (reply (pcase method
                                  ('sessions/forkPoints ,points)
                                  ('sessions/fork ,forked)
                                  ('sessions/attach (or attached (list :ref (plist-get params :session))))
                                  ('sessions/preview agentpane-test--nodes)))
                         (answer (lambda (ok)
                                   (with-current-buffer from
                                     (if ok
                                         (funcall callback reply)
                                       (when failed (funcall failed)))))))
                    (if (memq method hold)
                        (setq held (append held (list (cons method answer))))
                      (funcall answer t)))))
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
          (setq agentpane--attached 'connection)
          (agentpane-test--goto-index 0)
          (agentpane-fork)
          (should (equal (assq 'sessions/fork sent)
                         `(sessions/fork :session ,ref :entryId "turn-0")))
          (should (equal (assq 'sessions/attach sent)
                         `(sessions/attach :session ,forked)))
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
          (setq agentpane--attached agentpane--connection)
          (agentpane-test--goto-index 1)
          (agentpane-fork)
          (should (equal (mapcar #'car sent) '(sessions/forkPoints)))
          (should (seq-some (lambda (text) (string-search "not forkable" text)) said)))))))

(ert-deftest agentpane-test-pi-fork-detaches-the-parent ()
  "A Pi fork, which leaves its parent detached on the server, detaches the
parent from the helper, so the helper stops feeding a buffer that counts
itself detached; and the parent buffer attaches again before compacting,
since the compact route answers only for an attached session."
  (let ((ref '(:backend "pi" :id "/s/parent.jsonl"))
        (forked '(:backend "pi" :id "/s/fork.jsonl"))
        (agentpane--connection 'connection))
    (cl-letf (((symbol-function 'jsonrpc-running-p) (lambda (_) t)))
      (agentpane-test--forking
          [(:id "entry-0" :text "Fix the bug" :index 0)]
          forked
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection
                agentpane--attach-sent t)
          (agentpane-test--goto-index 0)
          (agentpane-fork)
          (should (equal (mapcar #'car (reverse sent))
                         '(sessions/forkPoints sessions/fork sessions/detach
                           sessions/attach)))
          (should (equal (assq 'sessions/detach sent) `(sessions/detach :session ,ref)))
          (setq sent nil)
          (with-current-buffer buffer (agentpane-compact))
          (should (equal (reverse sent)
                         `((sessions/attach :session ,ref)
                           (sessions/compact :session ,ref)))))))))

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
          (setq agentpane--attached agentpane--connection)
          (agentpane-test--goto-index 0)
          (agentpane-fork)
          (should (agentpane--buffer-for forked))
          (should-not (assq 'sessions/preview sent))
          (with-current-buffer buffer
            (should-not (agentpane--attached-p))
            (should (equal (agentpane-test--indices) '(0 1)))))))))

(ert-deftest agentpane-test-pi-fork-detaches-the-parent-by-its-handle ()
  "A Pi fork detaches its parent from the helper by the handle the parent
holds, and the fork's buffer holds the handle its own attach answered."
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
                         `(sessions/detach :session ,ref :handle "h1")))
          (should (equal (buffer-local-value 'agentpane--handle (agentpane--buffer-for forked))
                         "h2")))))))

(ert-deftest agentpane-test-fork-in-flight-refuses-a-second ()
  "A second `agentpane-fork' while one is in flight says so and sends
nothing; a fork that failed, or finished, frees the buffer for another."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "turn-0" :text "Fix the bug" :index 0)]
          '(:backend "codex" :id "t2")
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection)
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
          (setq agentpane--attached agentpane--connection)
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
                agentpane--attach-sent t)
          (setq hold '(sessions/abort))
          (agentpane--on-notification
           nil 'session/status (list :session ref :isStreaming t :compaction nil :model nil))
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
           nil 'session/snapshot
           (list :session ref
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
                         `(sessions/fork :session ,ref :entryId "entry-fix"))))))))

(ert-deftest agentpane-test-fork-while-attaching-sends-nothing ()
  "A second `agentpane-fork' on a previewed buffer while the first one's
attach is in flight says so and sends nothing; an attach that failed frees
the buffer to attach again."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "turn-0" :text "Fix the bug" :index 0)]
          '(:backend "codex" :id "t2")
        (agentpane-test--with-session ref
          (setq hold '(sessions/attach))
          (agentpane-test--goto-index 0)
          (agentpane-fork)
          (should-error (agentpane-fork) :type 'user-error)
          (should (equal (mapcar #'car sent) '(sessions/attach)))
          (funcall (cdr (pop held)) nil)
          (should-not (seq-some (lambda (text) (string-search "press f again" text)) said))
          (agentpane-fork)
          (should (equal (mapcar #'car sent) '(sessions/attach sessions/attach))))))))

(ert-deftest agentpane-test-refetch-during-a-fork-sends-nothing ()
  "A refetch while a Pi fork is in flight says so and sends nothing, so no
re-attach of the parent can answer after the fork's reply has counted the
parent detached."
  (let ((ref '(:backend "pi" :id "/s/parent.jsonl"))
        (forked '(:backend "pi" :id "/s/fork.jsonl")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "entry-0" :text "Fix the bug" :index 0)]
          forked
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection
                agentpane--attach-sent t)
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

;;;; Sending, against a stub connection

(ert-deftest agentpane-test-one-send-at-a-time ()
  "A second `agentpane-send' while the first is in flight -- its attach or
its prompt unanswered -- says so and sends nothing, so the prompt goes out
once; a send whose attach or prompt failed frees the buffer for another."
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
            ;; A previewed buffer: the first send's attach has not answered.
            (insert "hello")
            (should-not (funcall send))
            (let ((second (funcall send)))
              (funcall release)
              (should (equal (funcall methods) '(sessions/attach sessions/prompt)))
              (should second))
            ;; Attached: the first send's prompt has not answered.
            (insert "more")
            (funcall send)
            (should (funcall send))
            (funcall release)
            (should (equal (funcall methods) '(sessions/prompt)))
            ;; A failed attach, then a failed prompt, each free the buffer.
            (setq agentpane--attached nil)
            (insert "again")
            (funcall send)
            (funcall (cdr (pop held)) nil)
            (should-not (funcall send))
            (funcall release)
            (should (equal (funcall methods) '(sessions/attach sessions/attach sessions/prompt)))
            (insert "last")
            (funcall send)
            (funcall (cdr (pop held)) nil)
            (should-not (funcall send))
            (funcall release)
            (should (equal (funcall methods) '(sessions/prompt sessions/prompt)))))))))

(ert-deftest agentpane-test-prompt-answer-keeps-the-drawn-error ()
  "A prompt's answer leaves the turn error drawn when it was sent, through
the attach and the snapshots that redraw it meanwhile, and the
`session/errorCleared' the server broadcasts at the prompt's admission is
what drops it: the server owns the error (OW-lohubo)."
  (let ((ref '(:backend "claude" :id "c1"))
        (snapshot (lambda (ref)
                    (agentpane--on-notification
                     nil 'session/snapshot
                     (list :session ref :isStreaming :json-false :nodes agentpane-test--nodes
                           :error (copy-sequence "Turn failed upstream")
                           :requests [] :notices [])))))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          (funcall snapshot ref)
          (setq hold '(sessions/attach sessions/prompt))
          (goto-char (point-max))
          (insert "hello")
          (agentpane-send)
          (funcall snapshot ref)
          (funcall (cdr (pop held)) t)
          (funcall snapshot ref)
          (funcall (cdr (pop held)) t)
          (should (equal (mapcar #'car (reverse sent)) '(sessions/attach sessions/prompt)))
          (should (equal (agentpane-test--warnings) '("Turn failed upstream")))
          (agentpane--on-notification nil 'session/errorCleared (list :session ref))
          (should (equal (agentpane-test--indices) '(0 1)))
          (should-not (agentpane-test--warnings)))))))

(ert-deftest agentpane-test-prompt-names-the-error-held-at-the-send ()
  "A prompt carries the `errorId' of the turn error the buffer held when it
was sent, so admitting it clears that one and no newer one (OW-jokoto)."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection
                agentpane--attach-sent t)
          (agentpane--on-notification
           nil 'session/error (list :session ref :message "Turn failed upstream" :errorId "e5"))
          (goto-char (point-max))
          (insert "hello")
          (agentpane-send)
          (should (equal sent `((sessions/prompt :session ,ref :text "hello"
                                                 :priorErrorId "e5")))))))))

(ert-deftest agentpane-test-prompt-names-no-error-its-own-attach-drew ()
  "The first prompt on a previewed transcript names the error the buffer
held at the send, none, and not one the attach it sends first drew from
its snapshot: an error the session's start raised is newer than the
prompt, so admitting it must not clear it (OW-jokoto, OW-bomolu)."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          (setq hold '(sessions/attach))
          (goto-char (point-max))
          (insert "hello")
          (agentpane-send)
          (agentpane--on-notification
           nil 'session/snapshot
           (list :session ref :isStreaming :json-false :nodes agentpane-test--nodes
                 :error "extension failed to load" :errorId "e9" :requests [] :notices []))
          (funcall (cdr (pop held)) t)
          (should (equal (car sent) `(sessions/prompt :session ,ref :text "hello"
                                                      :priorErrorId nil)))
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
                agentpane--attach-sent t)
          (agentpane--on-notification
           nil 'session/snapshot
           (list :session ref :isStreaming :json-false :nodes agentpane-test--nodes
                 :error "Turn failed upstream" :requests [] :notices []))
          (setq hold '(sessions/prompt))
          (goto-char (point-max))
          (insert "hello")
          (agentpane-send)
          (agentpane--on-notification nil 'session/errorCleared (list :session ref))
          (agentpane--on-notification
           nil 'session/error (list :session ref :message "Turn failed upstream"))
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
                agentpane--attach-sent t)
          (agentpane--on-notification
           nil 'session/error (list :session ref :message "Turn failed upstream"))
          (agentpane--on-notification
           nil 'session/error (list :session ref :message "Turn failed again"))
          (setq hold '(sessions/prompt))
          (goto-char (point-max))
          (insert "hello")
          (agentpane-send)
          (agentpane--on-notification
           nil 'session/error (list :session ref :message "Turn failed upstream"))
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
                     nil 'session/snapshot
                     (list :session ref :isStreaming :json-false :nodes agentpane-test--nodes
                           :error error :requests [] :notices [])))))
    (agentpane-test--with-helper
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection
                agentpane--attach-sent t)
          (funcall snapshot ref "Turn failed upstream")
          (setq hold '(sessions/prompt))
          (goto-char (point-max))
          (insert "hello")
          (agentpane-send)
          (funcall (cdr (pop held)) t)
          (should (equal (agentpane-test--warnings) '("Turn failed upstream")))
          (funcall snapshot ref "Turn failed upstream")
          (should (equal (agentpane-test--warnings) '("Turn failed upstream")))
          (agentpane--on-notification nil 'session/errorCleared (list :session ref))
          (should-not (agentpane-test--warnings)))))))

(ert-deftest agentpane-test-refetch-while-attaching-keeps-the-live-transcript ()
  "A refetch while the first prompt's attach is in flight does not draw the
stored transcript over the live one the attach's snapshot drew, when the
replies land in the order that would: the snapshot, the preview's reply,
then the attach's, before whose prompt the preview is still the latest
request.  Once an attach has failed, a refetch reads the stored transcript
again."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--forking nil nil
      (agentpane-test--with-session ref
        (setq hold '(sessions/attach sessions/preview))
        (goto-char (point-max))
        (insert "hello")
        (agentpane-send)
        (agentpane-refetch)
        (agentpane--on-notification
         nil 'session/snapshot
         (list :session ref :nodes (vector (agentpane-test--assistant 5 "<p>Live.</p>"))
               :isStreaming :json-false :compaction nil :model nil))
        ;; Held in the order sent, attach then any preview: release in reverse.
        (dolist (entry (reverse held)) (funcall (cdr entry) t))
        (setq held nil)
        (should (equal (agentpane-test--indices) '(5)))
        (insert "again")
        (agentpane-send)
        (funcall (cdr (pop held)) nil)
        (setq sent nil)
        (agentpane-refetch)
        (should (equal (mapcar #'car sent) '(sessions/preview)))))))

(ert-deftest agentpane-test-one-attach-at-a-time ()
  "`agentpane-set-model' and `agentpane-compact' while a send's attach is
held wait on that attach, and run once it answers, so exactly one
`sessions/attach' goes out.  `M-x agentpane-set-model', whose attach is
synchronous, refuses meanwhile and sends nothing."
  (let ((ref '(:backend "codex" :id "t1"))
        (agentpane--connection 'connection))
    (cl-letf (((symbol-function 'jsonrpc-running-p) (lambda (_) t)))
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          (cl-letf (((symbol-function 'jsonrpc-request)
                     (lambda (_connection method &rest _)
                       (push (list method) sent)
                       (pcase method
                         ('sessions/attach (list :ref ref))
                         ('models/list [(:id "gpt-5.6-luna")]))))
                    ((symbol-function 'completing-read) (lambda (&rest _) "gpt-5.6-luna")))
            (agentpane--draw [])
            (setq hold '(sessions/attach))
            (goto-char (point-max))
            (insert "hello")
            (agentpane-send)
            (agentpane-set-model "gpt-5.6-luna")
            (agentpane-compact)
            (let ((refused (condition-case nil
                               (progn (call-interactively #'agentpane-set-model) nil)
                             (user-error t))))
              (should (equal (mapcar #'car sent) '(sessions/attach)))
              (should refused))
            (funcall (cdr (pop held)) t)
            (should-not held)
            (should (equal (mapcar #'car (reverse sent))
                           '(sessions/attach sessions/prompt sessions/setModel
                             sessions/compact)))))))))

(ert-deftest agentpane-test-failed-attach-fails-every-waiter ()
  "A send that waits on an attach `agentpane-compact' began is freed when
that attach fails, as it is when its own does; a refetch while the attach
is held says so and sends nothing, and once the failure has left nothing
in flight, a refetch reads the stored transcript."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--forking nil nil
      (agentpane-test--with-session ref
        (setq hold '(sessions/attach))
        (agentpane-compact)
        (goto-char (point-max))
        (insert "hello")
        (agentpane-send)
        (agentpane-refetch)
        (let ((explained (seq-some (lambda (text) (string-search "still attaching" text))
                                   said)))
          (funcall (cdr (pop held)) nil)
          (should-not agentpane--sending)
          (setq sent nil)
          (agentpane-refetch)
          ;; A preview goes out only once no attach is held whose snapshot it
          ;; could draw over.
          (should (equal (list (mapcar #'car held) (mapcar #'car sent))
                         '(nil (sessions/preview))))
          (should explained))))))

(ert-deftest agentpane-test-waiter-that-signals-frees-the-rest ()
  "When a caller waiting on an attach signals as the attach answers, as
`agentpane-compact' does when its request cannot go out, a send waiting
behind it is freed rather than left refusing every later send."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--forking nil nil
      (agentpane-test--with-session ref
        (let ((request (symbol-function 'agentpane--request)))
          (cl-letf (((symbol-function 'agentpane--request)
                     (lambda (method &rest args)
                       (when (eq method 'sessions/compact)
                         (error "Process agentpane helper not running"))
                       (apply request method args))))
            (setq hold '(sessions/attach))
            (agentpane-compact)
            (goto-char (point-max))
            (insert "hello")
            (agentpane-send)
            (should-error (funcall (cdr (pop held)) t))
            (should-not agentpane--sending)))))))

;;;; Killing a transcript buffer, against a stub connection

(ert-deftest agentpane-test-kill-detaches-the-session ()
  "Killing a transcript buffer while a helper is running sends
`sessions/detach' for its session and nothing else, so the helper stops its
notifications and the session keeps running: whether the session is
attached, attaching, or its attach failed on this side, as a timeout does
while the helper's attach goes on to succeed.  With no helper running a
kill sends nothing, even in the moment before a dead helper's error
handlers clear a buffer's attaching flag."
  (let ((ref '(:backend "codex" :id "t1"))
        (agentpane--connection 'connection))
    (cl-letf (((symbol-function 'jsonrpc-running-p) (lambda (_) t)))
      (agentpane-test--forking nil nil
        (agentpane-test--with-session ref
          (agentpane--attach)
          (setq sent nil)
          (kill-buffer buffer)
          (should (equal sent `((sessions/detach :session ,ref)))))
        (agentpane-test--with-session ref
          (setq hold '(sessions/attach))
          (agentpane--attach)
          (setq sent nil)
          (kill-buffer buffer)
          (should (equal sent `((sessions/detach :session ,ref)))))
        (setq held nil)
        (agentpane-test--with-session ref
          (setq hold '(sessions/attach))
          (agentpane--attach)
          (funcall (cdr (pop held)) nil)
          (setq sent nil)
          (kill-buffer buffer)
          (should (equal sent `((sessions/detach :session ,ref)))))
        (agentpane-test--with-session ref
          (setq agentpane--attaching t)
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
        (setq agentpane--attached agentpane--connection)
        (kill-buffer buffer)
        (should-not (buffer-live-p buffer))))))

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
delivers a `sessions/changed'.  The finished-turn marks start empty, and
every buffer BODY made is killed afterwards."
  (declare (indent 0))
  `(let* ((listing nil)
          (buffers (buffer-list))
          (agentpane--listed-streaming (make-hash-table :test #'equal))
          (agentpane--finished-turns (make-hash-table :test #'equal))
          (relist (lambda (&rest summaries)
                    (setq listing summaries)
                    (agentpane--on-notification nil 'sessions/changed nil))))
     (cl-letf (((symbol-function 'agentpane--request)
                (lambda (method params callback &rest _)
                  (when (eq method 'sessions/list)
                    (let ((cwd (plist-get params :cwd)))
                      (funcall callback
                               (vconcat (seq-filter (lambda (summary)
                                                      (or (null cwd)
                                                          (equal (plist-get summary :cwd) cwd)))
                                                    listing))))))))
       (unwind-protect
           (save-window-excursion ,@body)
         (dolist (buffer (buffer-list))
           (unless (memq buffer buffers) (kill-buffer buffer)))))))

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
  "A session whose turn ends while no window shows its transcript keeps a
finished-turn mark through later listings, until a window shows it; one
whose transcript is shown when its turn ends, and one never seen
streaming, are not marked."
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
      (funcall relist (agentpane-test--summary "a" t) (agentpane-test--summary "b" t)
               (agentpane-test--summary "c" nil))
      (funcall relist (agentpane-test--summary "a" nil) (agentpane-test--summary "b" nil)
               (agentpane-test--summary "c" nil))
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
  "The Preview cell of PICKER's row for the session holding HANDLE."
  (with-current-buffer picker
    (let ((column (seq-position (mapcar #'car tabulated-list-format) "Preview"))
          (entry (seq-find (lambda (entry) (equal (plist-get (car entry) :handle) handle))
                           tabulated-list-entries)))
      (should column)
      (should entry)
      (aref (cadr entry) column))))

(ert-deftest agentpane-test-picker-previews-a-just-prompted-session-by-its-transcript ()
  "A listed session whose stored preview is still null shows, as its Preview,
the first user node with text in the transcript buffer holding it, its text
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
             (list :handle "h-a" :session ref
                   :node '(:index 0 :role "user"
                           :parts [(:type "text" :text "Fix the bug")])))
            (agentpane-test--redraw buffer)
            (should (equal (agentpane-test--preview picker "h-a") "Fix the bug"))
            (should (string-search "Fix the bug"
                                   (with-current-buffer picker (buffer-string))))
            (should (= prints 1))
            (agentpane--on-notification
             nil 'session/node
             (list :handle "h-a" :session ref :node (agentpane-test--assistant 1 "<p>Sure.</p>")))
            (agentpane--on-notification
             nil 'session/node
             (list :handle "h-a" :session ref
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
        (funcall relist (agentpane-test--summary "a" t one) (agentpane-test--summary "b" nil two))
        (funcall relist (agentpane-test--summary "a" nil one) (agentpane-test--summary "b" nil two))
        (should (agentpane-test--finished-p picker "h-a"))
        (agentpane-test--pick two)
        (agentpane-test--show a)
        (agentpane-test--show picker)
        (agentpane-test--pick one)
        (should-not (agentpane-test--finished-p picker "h-a"))))))

(ert-deftest agentpane-test-picker-does-not-mark-a-turn-watched-while-filtered-out ()
  "A session listed streaming whose turn ends, while the picker lists another
project, with its transcript on screen is not marked when its own project is
listed again after the user looked away (OW-yufahi)."
  (agentpane-test--with-directories (one two)
    (agentpane-test--listing
      (let ((a (agentpane-test--holding (agentpane-test--summary "a" nil one)))
            (picker (agentpane-test--pick one)))
        (funcall relist (agentpane-test--summary "a" nil one) (agentpane-test--summary "b" nil two))
        (funcall relist (agentpane-test--summary "a" t one) (agentpane-test--summary "b" nil two))
        (agentpane-test--pick two)
        (agentpane-test--show a)
        (funcall relist (agentpane-test--summary "a" nil one) (agentpane-test--summary "b" nil two))
        (agentpane-test--show picker)
        (agentpane-test--pick one)
        (should-not (agentpane-test--finished-p picker "h-a"))))))

(ert-deftest agentpane-test-picker-mark-cleared-when-a-shown-buffer-becomes-its-session ()
  "A transcript already on screen that becomes a marked session, by its
attach's reply or by a snapshot's `askedFor', drops the mark at the next
redisplay, with no window changing buffer (OW-yufahi, OW-piweyi): the
binding itself sets the flag that makes redisplay run the hook."
  (agentpane-test--listing
    (let ((picker (save-window-excursion (agentpane-sessions t) (current-buffer)))
          (x (agentpane--transcript-buffer (list :ref '(:backend "pi" :id "x"))))
          (y (agentpane--transcript-buffer (list :ref '(:backend "pi" :id "y")))))
      (agentpane-test--show x)
      (funcall relist (agentpane-test--summary "a" nil))
      (funcall relist (agentpane-test--summary "a" t))
      (funcall relist (agentpane-test--summary "a" nil))
      (should (agentpane-test--finished-p picker "h-a"))
      (with-current-buffer x
        (agentpane--attached-as (agentpane-test--summary "a" nil)))
      (agentpane-test--redisplay)
      (should-not (agentpane-test--finished-p picker "h-a"))
      (agentpane-test--show y)
      (with-current-buffer y (setq agentpane--attach-sent t))
      (funcall relist (agentpane-test--summary "a" nil) (agentpane-test--summary "c" t))
      (funcall relist (agentpane-test--summary "a" nil) (agentpane-test--summary "c" nil))
      (should (agentpane-test--finished-p picker "h-c"))
      (agentpane--on-notification
       nil 'session/snapshot
       (list :session '(:backend "pi" :id "c") :handle "h-c" :askedFor '(:backend "pi" :id "y")
             :nodes [] :isStreaming :json-false))
      (should (equal (buffer-local-value 'agentpane--handle y) "h-c"))
      (agentpane-test--redisplay)
      (should-not (agentpane-test--finished-p picker "h-c")))))

(ert-deftest agentpane-test-new-picker-does-not-mark-a-turn-that-ended-with-no-picker ()
  "A session listed streaming by a picker since killed, or since turned to
another major mode, whose turn ended while there was none, is not marked by
a new picker's listing: nothing observed the end, watched or not
\(OW-yufahi, OW-wazipa)."
  (dolist (gone (list #'kill-buffer
                      (lambda (buffer) (with-current-buffer buffer (fundamental-mode)))))
    (agentpane-test--listing
      (let ((a (agentpane-test--holding (agentpane-test--summary "a" nil))))
        (save-window-excursion (agentpane-sessions t))
        (funcall relist (agentpane-test--summary "a" t))
        (funcall gone (get-buffer "*agentpane sessions*"))
        (setq listing (list (agentpane-test--summary "a" nil)))
        (let ((picker (save-window-excursion (agentpane-sessions t) (current-buffer))))
          (should-not (eq (window-buffer (selected-window)) a))
          (should-not (agentpane-test--finished-p picker "h-a")))))))

(ert-deftest agentpane-test-new-picker-keeps-the-levels-a-live-picker-reads ()
  "A second picker, made while the first still lists, does not wipe the
streaming level the first read: a turn that ends before the second's
first listing is marked (OW-wazipa)."
  (agentpane-test--listing
    (let ((first (save-window-excursion (agentpane-sessions t) (current-buffer))))
      (with-current-buffer first (rename-buffer "*agentpane sessions: first*"))
      (funcall relist (agentpane-test--summary "a" nil))
      (funcall relist (agentpane-test--summary "a" t))
      (setq listing (list (agentpane-test--summary "a" nil)))
      (let ((second (save-window-excursion (agentpane-sessions t) (current-buffer))))
        (should-not (eq second first))
        (funcall relist (agentpane-test--summary "a" nil))
        (should (agentpane-test--finished-p first "h-a"))
        (should (agentpane-test--finished-p second "h-a"))))))

(ert-deftest agentpane-test-picker-gone-keeps-the-levels-another-picker-reads ()
  "A picker killed, or turned to another major mode, while a second still
lists, does not wipe the streaming level the second read: a turn that ends
after is marked (OW-wazipa)."
  (dolist (gone (list #'kill-buffer
                      (lambda (buffer) (with-current-buffer buffer (fundamental-mode)))))
    (agentpane-test--listing
      (let ((first (save-window-excursion (agentpane-sessions t) (current-buffer))))
        (with-current-buffer first (rename-buffer "*agentpane sessions: first*"))
        (let ((second (save-window-excursion (agentpane-sessions t) (current-buffer))))
          (funcall relist (agentpane-test--summary "a" nil))
          (funcall relist (agentpane-test--summary "a" t))
          (funcall gone first)
          (funcall relist (agentpane-test--summary "a" nil))
          (should (agentpane-test--finished-p second "h-a")))))))

(ert-deftest agentpane-test-picker-forgets-a-handle-the-server-let-go ()
  "A handle the listing no longer carries, which the server never mints
again, leaves both the streaming levels and the marks (OW-wazipa)."
  (agentpane-test--listing
    (save-window-excursion (agentpane-sessions t))
    (funcall relist (agentpane-test--summary "a" nil) (agentpane-test--summary "b" nil))
    (funcall relist (agentpane-test--summary "a" t) (agentpane-test--summary "b" t))
    (funcall relist (agentpane-test--summary "a" nil) (agentpane-test--summary "b" t))
    (should (gethash "h-a" agentpane--finished-turns))
    (funcall relist (agentpane-test--summary "c" nil))
    (should (equal (list (hash-table-keys agentpane--listed-streaming)
                         (hash-table-keys agentpane--finished-turns))
                   '(("h-c") nil)))))

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
        (funcall relist (agentpane-test--summary "a" t))
        (funcall relist (agentpane-test--summary "a" nil))
        (should (agentpane-test--finished-p picker "h-a"))
        (setq top (selected-frame))
        (funcall relist (agentpane-test--summary "a" t))
        (funcall relist (agentpane-test--summary "a" nil))
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
        (funcall relist (agentpane-test--summary "a" t))
        (funcall relist (agentpane-test--summary "a" nil))
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
        (funcall relist (agentpane-test--summary "a" t))
        (funcall relist (agentpane-test--summary "a" nil))
        (should-not (agentpane-test--finished-p picker "h-a"))
        (setq top 'another-frame)
        (funcall relist (agentpane-test--summary "a" t))
        (funcall relist (agentpane-test--summary "a" nil))
        (should (agentpane-test--finished-p picker "h-a"))))))

;;;; The turn-done indicator, against a stub connection

(defmacro agentpane-test--submitting (&rest body)
  "Run BODY in an attached transcript buffer, not shown in any window, with
every request answered as `agentpane-test--forking' answers it and no turn
marked done.  `status' is bound to a function that delivers a
`session/status' reading streaming when its argument is non-nil, and
`submit' to one that types a prompt and sends it."
  (declare (indent 0))
  `(let ((ref '(:backend "codex" :id "t1"))
         (agentpane--turns-done nil))
     (agentpane-test--with-helper
       (agentpane-test--forking nil nil
         (agentpane-test--with-session ref
           (setq agentpane--attached agentpane--connection)
           (let ((status (lambda (streaming)
                           (agentpane--on-notification
                            nil 'session/status
                            (list :session ref :isStreaming (if streaming t :json-false)))))
                 (submit (lambda ()
                           (goto-char (point-max))
                           (insert "hello")
                           (agentpane-send))))
             (ignore status submit)
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
  "A turn this Emacs submitted that ends while no window shows its buffer
raises the indicator, and showing the buffer clears it (OW-lohavi)."
  (agentpane-test--submitting
    (funcall submit)
    (funcall status t)
    (funcall status nil)
    (should (agentpane-test--turn-done-p))
    (agentpane-test--show buffer)
    (should-not (agentpane-test--turn-done-p))))

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
        (should-not (member "streaming" agentpane--status-fields))
        (should (agentpane-test--turn-done-p))
        (should (member own global-mode-string))))))

(ert-deftest agentpane-test-turn-done-not-raised-for-a-turn-not-submitted-here ()
  "A turn this Emacs did not submit, one prompted from elsewhere, raises
nothing when it ends unseen (OW-lohavi)."
  (agentpane-test--submitting
    (funcall status t)
    (funcall status nil)
    (should-not (agentpane-test--turn-done-p))))

(ert-deftest agentpane-test-turn-done-not-raised-by-the-idle-status-after-submit ()
  "The not-streaming status that still stands just after a submit raises
nothing, and the watch stays armed for the turn's real end (OW-lohavi)."
  (agentpane-test--submitting
    (funcall submit)
    (funcall status nil)
    (funcall status nil)
    (should-not (agentpane-test--turn-done-p))
    (funcall status t)
    (funcall status nil)
    (should (agentpane-test--turn-done-p))))

(ert-deftest agentpane-test-turn-done-not-raised-for-a-turn-that-ended-in-view ()
  "A submitted turn that ends while a window shows its buffer raises
nothing, and ends the watch, so a later turn from elsewhere that ends
unseen raises nothing either (OW-lohavi)."
  (agentpane-test--submitting
    (funcall submit)
    (funcall status t)
    (agentpane-test--show buffer)
    (funcall status nil)
    (should-not (agentpane-test--turn-done-p))
    (agentpane-test--show (get-buffer-create "*scratch*"))
    (funcall status t)
    (funcall status nil)
    (should-not (agentpane-test--turn-done-p))))

(ert-deftest agentpane-test-turn-done-not-raised-after-a-refused-prompt ()
  "A prompt the server refused arms nothing, so a turn from elsewhere that
then ends unseen raises nothing (OW-lohavi)."
  (agentpane-test--submitting
    (setq hold '(sessions/prompt))
    (funcall submit)
    (funcall (cdr (pop held)) nil)
    (funcall status t)
    (funcall status nil)
    (should-not (agentpane-test--turn-done-p))))

(ert-deftest agentpane-test-turn-done-kept-armed-by-a-prompt-refused-mid-turn ()
  "A prompt the server refuses mid-turn leaves the watch the turn's own
prompt armed, so the turn's end still raises the indicator (OW-lohavi)."
  (agentpane-test--submitting
    (funcall submit)
    (funcall status t)
    (setq hold '(sessions/prompt))
    (funcall submit)
    (funcall (cdr (pop held)) nil)
    (funcall status nil)
    (should (agentpane-test--turn-done-p))))

(ert-deftest agentpane-test-turn-done-raised-for-a-running-turn-a-prompt-joins ()
  "A prompt sent while a turn from elsewhere streams, which the server takes
into that turn with no fresh streaming status, makes that turn this Emacs's:
its end raises the indicator, and the watch ends with it, so a later turn
from elsewhere raises nothing (OW-lohavi)."
  (agentpane-test--submitting
    (funcall status t)
    (funcall submit)
    (funcall status nil)
    (should (agentpane-test--turn-done-p))
    (agentpane-test--show buffer)
    (agentpane-test--show (get-buffer-create "*scratch*"))
    (should-not (agentpane-test--turn-done-p))
    (funcall status t)
    (funcall status nil)
    (should-not (agentpane-test--turn-done-p))))

(defun agentpane-test--attach-to-a-running-turn (snapshot-first)
  "Send from a previewed buffer whose attach finds a turn from elsewhere
streaming, its snapshot handled before the attach's reply when
SNAPSHOT-FIRST and after it otherwise (D2), then end that turn unseen, and
return whether the indicator is raised."
  (agentpane-test--submitting
    (setq agentpane--attached nil
          hold '(sessions/attach))
    (let ((snapshot (lambda ()
                      (agentpane--on-notification
                       nil 'session/snapshot
                       (list :session ref :nodes agentpane-test--nodes :isStreaming t)))))
      (funcall submit)
      (when snapshot-first (funcall snapshot))
      (funcall (cdr (pop held)) t)
      (unless snapshot-first (funcall snapshot))
      (should (equal (mapcar #'car sent) '(sessions/prompt sessions/attach)))
      (funcall status nil)
      (agentpane-test--turn-done-p))))

(ert-deftest agentpane-test-turn-done-raised-for-a-running-turn-found-by-the-attach ()
  "A send from a previewed buffer whose attach finds a turn streaming joins
it, and that turn's end raises the indicator, whichever of the attach's
snapshot and its reply is handled first (OW-lohavi)."
  (should (agentpane-test--attach-to-a-running-turn t))
  (should (agentpane-test--attach-to-a-running-turn nil)))

(ert-deftest agentpane-test-turn-done-cleared-when-its-buffer-is-killed ()
  "Killing a buffer whose turn ended unseen drops it from the indicator
(OW-lohavi)."
  (agentpane-test--submitting
    (funcall submit)
    (funcall status t)
    (funcall status nil)
    (should (agentpane-test--turn-done-p))
    (kill-buffer buffer)
    (should-not (agentpane-test--turn-done-p))))

;;;; A new session whose attach fails, against a stub jsonrpc

(ert-deftest agentpane-test-new-session-shown-when-its-attach-fails ()
  "A new session whose attach signals, or is quit, is left in the selected
window, where a send attaches it again, rather than in a buffer never shown."
  (let ((ref '(:backend "codex" :id "virtual-1"))
        (buffers (buffer-list)))
    (dolist (failure '((error "attach failed") (quit)))
      (cl-letf (((symbol-function 'agentpane--connection) (lambda () 'connection))
                ((symbol-function 'jsonrpc-request)
                 (lambda (_connection method &rest _)
                   (pcase method
                     ('sessions/create ref)
                     ('sessions/attach (signal (car failure) (cdr failure)))))))
        (unwind-protect
            (save-window-excursion
              ;; `should-error' catches only `error' and its children.
              (should (eq (condition-case err (progn (agentpane-new-session "codex") nil)
                            ((error quit) (car err)))
                          (car failure)))
              (should (agentpane--buffer-for ref))
              (should (eq (window-buffer (selected-window)) (agentpane--buffer-for ref))))
          (dolist (buffer (buffer-list))
            (unless (memq buffer buffers) (kill-buffer buffer))))))))

;;;; A new session's model and effort, against a stub jsonrpc

(defun agentpane-test--new-session (choices &optional current held)
  "Run `agentpane-new-session' on Codex against a stub jsonrpc whose
`models/list' answers `agentpane-test--models' and whose prompts answer
CHOICES in turn, the attach delivering a status naming CURRENT when it is
non-nil.  Return the requests sent, in order, each as its method or, for
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
                     (funcall answer)))))
              ((symbol-function 'jsonrpc-request)
               (lambda (_connection method &rest _)
                 (push method sent)
                 (pcase method
                   ('sessions/create ref)
                   ('sessions/attach
                    (when current
                      (agentpane--set-status
                       (list :session ref :isStreaming :json-false :model current)))
                    (list :ref ref))
                   ('models/list agentpane-test--models))))
              ;; The mode line's own listing, which these tests do not measure.
              ((symbol-function 'jsonrpc-async-request) #'ignore)
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
                 '((sessions/create sessions/attach models/list
                    (sessions/setModel "gpt-5.6-sol") models/list
                    answered (sessions/setEffort "medium"))
                   (("gpt-5.6-luna" "gpt-5.6-sol" "plain") ("medium"))))))

(ert-deftest agentpane-test-new-session-reads-an-effort-after-the-model ()
  "`agentpane-new-session' reads an effort after the model, offering the
efforts of the model just chosen, and sets it after the model."
  (should (equal (agentpane-test--new-session '("gpt-5.6-sol" "medium") "gpt-5.6-luna")
                 '((sessions/create sessions/attach models/list
                    (sessions/setModel "gpt-5.6-sol") models/list
                    (sessions/setEffort "medium"))
                   (("gpt-5.6-luna" "gpt-5.6-sol" "plain") ("medium"))))))

(ert-deftest agentpane-test-new-session-reads-no-effort-without-options ()
  "`agentpane-new-session' prompts for no effort when the model chosen
offers none."
  (should (equal (agentpane-test--new-session '("plain" "low"))
                 '((sessions/create sessions/attach models/list
                    (sessions/setModel "plain") models/list)
                   (("gpt-5.6-luna" "gpt-5.6-sol" "plain"))))))

(ert-deftest agentpane-test-new-session-empty-model-reads-the-current-ones-effort ()
  "With an empty model choice, `agentpane-new-session' offers the efforts of
the model the session already has, and none when that is not known."
  (should (equal (agentpane-test--new-session '("" "high") "gpt-5.6-luna")
                 '((sessions/create sessions/attach models/list models/list
                    (sessions/setEffort "high"))
                   (("gpt-5.6-luna" "gpt-5.6-sol" "plain") ("low" "high")))))
  (should (equal (agentpane-test--new-session '("" "high"))
                 '((sessions/create sessions/attach models/list)
                   (("gpt-5.6-luna" "gpt-5.6-sol" "plain"))))))

;;;; A send that signals, against a stub jsonrpc

(ert-deftest agentpane-test-send-that-signals-frees-the-buffer ()
  "A send whose request signals before it goes out, as when the helper
cannot start, leaves the buffer free to refetch and send again; so does one
whose attach reply signals while it is handled."
  (let ((ref '(:backend "codex" :id "t1"))
        (sent nil)
        (success nil)
        (starts 0))
    (cl-letf (((symbol-function 'agentpane--connection)
               (lambda ()
                 (when (= (cl-incf starts) 1)
                   (error "Searching for program: No such file or directory, bun"))
                 'connection))
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
        (should (equal (reverse sent) '(sessions/preview sessions/attach)))
        (setq sent nil)
        (cl-letf (((symbol-function 'agentpane--attached-as)
                   (lambda (_) (error "Taking the reply failed"))))
          (should-error (funcall success (list :ref ref))))
        (agentpane-send)
        (should (equal sent '(sessions/attach)))))))

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
input is one it answers itself."
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
