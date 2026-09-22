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
      (should (equal drawn '(3)))
      (should (equal (agentpane-test--indices) '(0 1 3)))
      (should (< (agentpane-test--position "Looking.")
                 (agentpane-test--position "Appended.")
                 (agentpane-test--position "── prompt"))))))

(ert-deftest agentpane-test-renamed-rekeys-the-buffer ()
  "A `session/renamed' moves the buffer to the new ref and renames it."
  (let ((from '(:backend "claude" :id "pending-1"))
        (to '(:backend "claude" :id "real-2")))
    (agentpane-test--with-session from
      (agentpane--on-notification nil 'session/renamed (list :from from :to to))
      (should (eq (agentpane--buffer-for to) (current-buffer)))
      (should-not (agentpane--buffer-for from))
      (should (string-search "real-2" (buffer-name))))))

(ert-deftest agentpane-test-set-model-only-before-the-first-prompt ()
  "`agentpane-set-model' on a buffer with nodes signals the gate's error and
sends nothing; on a buffer with none it attaches and sends `sessions/setModel'."
  (let ((ref '(:backend "codex" :id "t1"))
        (sent nil))
    (cl-letf (((symbol-function 'agentpane--request)
               (lambda (method _params callback &optional _always)
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
                       :node (agentpane-test--assistant 1 text))))))
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

;;;; Forking, against a stub connection

(defmacro agentpane-test--forking (points forked &rest body)
  "Run BODY with every request answered at once, as the helper would: POINTS
for `sessions/forkPoints', FORKED for `sessions/fork', and a summary of the
ref asked for for `sessions/attach'.  Each request is pushed onto `sent' as
\(METHOD . PARAMS), and each `message' onto `said'; BODY sees both.  Every
buffer BODY made is killed afterwards."
  (declare (indent 2))
  `(let ((sent nil)
         (said nil)
         (buffers (buffer-list)))
     (cl-letf (((symbol-function 'agentpane--request)
                (lambda (method params callback &optional _always)
                  (push (cons method params) sent)
                  (funcall callback
                           (pcase method
                             ('sessions/forkPoints ,points)
                             ('sessions/fork ,forked)
                             ('sessions/attach (list :ref (plist-get params :session)))))))
               ((symbol-function 'message)
                (lambda (format-string &rest args)
                  (push (apply #'format format-string args) said))))
       (unwind-protect (save-window-excursion ,@body)
         (dolist (buffer (buffer-list))
           (unless (memq buffer buffers) (kill-buffer buffer)))))))

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
leaving this one holding its session."
  (let ((ref '(:backend "codex" :id "t1"))
        (forked '(:backend "codex" :id "t2")))
    (agentpane-test--forking
        [(:id "turn-0" :text "Fix the bug" :index 0) (:id "turn-2" :text "More" :index 2)]
        forked
      (agentpane-test--with-session ref
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
                   (agentpane--ref (buffer-local-value 'agentpane--session buffer)) ref)))))))

(ert-deftest agentpane-test-fork-at-no-fork-point ()
  "`agentpane-fork' on a node no fork point names sends no `sessions/fork'
and says the message is not forkable."
  (let ((ref '(:backend "codex" :id "t1")))
    (agentpane-test--forking
        [(:id "turn-0" :text "Fix the bug" :index 0)]
        '(:backend "codex" :id "t2")
      (agentpane-test--with-session ref
        (agentpane-test--goto-index 1)
        (agentpane-fork)
        (should (equal (mapcar #'car sent) '(sessions/forkPoints)))
        (should (seq-some (lambda (text) (string-search "not forkable" text)) said))))))

(ert-deftest agentpane-test-pi-fork-detaches-the-parent ()
  "After a Pi fork, which leaves its parent detached on the server, the
parent buffer attaches again before compacting, since the compact route
answers only for an attached session."
  (let ((ref '(:backend "pi" :id "/s/parent.jsonl"))
        (forked '(:backend "pi" :id "/s/fork.jsonl"))
        (agentpane--connection 'connection))
    (cl-letf (((symbol-function 'jsonrpc-running-p) (lambda (_) t)))
      (agentpane-test--forking
          [(:id "entry-0" :text "Fix the bug" :index 0)]
          forked
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection)
          (agentpane-test--goto-index 0)
          (agentpane-fork)
          (setq sent nil)
          (with-current-buffer buffer (agentpane-compact))
          (should (equal (reverse sent)
                         `((sessions/attach :session ,ref)
                           (sessions/compact :session ,ref)))))))))

(defun agentpane-test--fork-streaming (backend)
  "Fork a BACKEND session at index 0 while a `session/status' says it is
streaming, and return the methods sent, in order."
  (let ((ref (list :backend backend :id "parent")))
    (agentpane-test--forking
        [(:id "entry-0" :text "Fix the bug" :index 0)]
        (list :backend backend :id "fork")
      (agentpane-test--with-session ref
        (agentpane--on-notification
         nil 'session/status (list :session ref :isStreaming t :compaction nil :model nil))
        (agentpane-test--goto-index 0)
        (agentpane-fork)
        (mapcar #'car (reverse sent))))))

(ert-deftest agentpane-test-fork-aborts-a-streaming-pi-turn ()
  "A fork of a streaming Pi session aborts the turn before forking, as the
browser does (D15); a streaming Codex session is forked with no abort."
  (should (equal (agentpane-test--fork-streaming "pi")
                 '(sessions/forkPoints sessions/abort sessions/fork sessions/attach)))
  (should (equal (agentpane-test--fork-streaming "codex")
                 '(sessions/forkPoints sessions/fork sessions/attach))))

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
