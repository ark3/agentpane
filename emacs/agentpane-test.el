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

(ert-deftest agentpane-test-renamed-renames-the-composer ()
  "A `session/renamed' renames the transcript's composer after it."
  (let ((from '(:backend "claude" :id "pending-1"))
        (to '(:backend "claude" :id "real-2")))
    (agentpane-test--with-session from
      (save-current-buffer (save-window-excursion (agentpane-prompt)))
      (let ((composer agentpane--composer))
        (unwind-protect
            (progn
              (agentpane--on-notification nil 'session/renamed (list :from from :to to))
              (should (equal (buffer-name composer)
                             (format "*agentpane composer: %s*" (buffer-name)))))
          (kill-buffer composer))))))

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

;;;; Forking, against a stub connection

(defmacro agentpane-test--forking (points forked &rest body)
  "Run BODY with every request answered as the helper would: POINTS for
`sessions/forkPoints', FORKED for `sessions/fork', a summary of the ref
asked for for `sessions/attach', and the fixed nodes for `sessions/preview'.
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
         (buffers (buffer-list)))
     (cl-letf (((symbol-function 'agentpane--request)
                (lambda (method params callback &optional _always failed &rest _)
                  (push (cons method params) sent)
                  (let* ((from (current-buffer))
                         (reply (pcase method
                                  ('sessions/forkPoints ,points)
                                  ('sessions/fork ,forked)
                                  ('sessions/attach (list :ref (plist-get params :session)))
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
parent from the helper before redrawing it from the store, so the helper
stops feeding a buffer that counts itself detached; and the parent buffer
attaches again before compacting, since the compact route answers only for
an attached session."
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
          (should (equal (mapcar #'car (reverse sent))
                         '(sessions/forkPoints sessions/fork sessions/detach
                           sessions/preview sessions/attach)))
          (should (equal (assq 'sessions/detach sent) `(sessions/detach :session ,ref)))
          (setq sent nil)
          (with-current-buffer buffer (agentpane-compact))
          (should (equal (reverse sent)
                         `((sessions/attach :session ,ref)
                           (sessions/compact :session ,ref)))))))))

(ert-deftest agentpane-test-pi-fork-redraws-the-parent-from-the-store ()
  "A snapshot of the fork's shortened transcript that reaches the parent
during a Pi fork is replaced, once the fork's reply lands, by the parent's
stored transcript."
  (let ((ref '(:backend "pi" :id "/s/parent.jsonl"))
        (forked '(:backend "pi" :id "/s/fork.jsonl")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "entry-0" :text "Fix the bug" :index 0)]
          forked
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection)
          (setq hold '(sessions/fork))
          (agentpane-test--goto-index 0)
          (agentpane-fork)
          (agentpane--on-notification
           nil 'session/snapshot
           (list :session ref :nodes [] :isStreaming :json-false :compaction nil :model nil))
          (with-current-buffer buffer
            (should (equal (agentpane-test--indices) nil)))
          (funcall (cdr (assq 'sessions/fork held)) t)
          (should (equal (assq 'sessions/preview sent) `(sessions/preview :session ,ref)))
          (with-current-buffer buffer
            (should (equal (agentpane-test--indices) '(0 1)))))))))

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
          (setq agentpane--attached agentpane--connection)
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
                   (sessions/fork sessions/detach sessions/preview sessions/attach))))
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
parent detached; that reply then redraws the parent from the store."
  (let ((ref '(:backend "pi" :id "/s/parent.jsonl"))
        (forked '(:backend "pi" :id "/s/fork.jsonl")))
    (agentpane-test--with-helper
      (agentpane-test--forking
          [(:id "entry-0" :text "Fix the bug" :index 0)]
          forked
        (agentpane-test--with-session ref
          (setq agentpane--attached agentpane--connection)
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
                           sessions/preview sessions/attach))))))))

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
        (cl-letf (((symbol-function 'agentpane--rekey)
                   (lambda (_) (error "Rekey failed"))))
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
