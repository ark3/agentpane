;;; agentpane-test.el --- Tests for agentpane.el  -*- lexical-binding: t; -*-

;; Copyright (C) 2026 Abhay Saxena

;; This file is not part of GNU Emacs.

;;; Commentary:

;; `ert' tests for agentpane.el: drawing a fixed list of nodes into a
;; buffer, with no helper process, and the helper connection, against
;; emacs/fake-helper.ts in place of the real helper, so no agentpane server
;; is needed.  Run from the repository root with
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
  "The user text, assistant text, tool summaries and meta line appear in order."
  (with-current-buffer (agentpane-test--render)
    (let ((positions (mapcar #'agentpane-test--position
                             '("Fix the bug" "Looking." "Read app.ts"
                               "Edit app.ts (+1 -1)" "— #1 · haiku · 12 tokens"))))
      (should (equal positions (sort (copy-sequence positions) #'<))))
    (kill-buffer)))

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
