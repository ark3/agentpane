;;; emacs_helper_drop_probe.el --- A prompt in flight at a stream drop -*- lexical-binding: t; -*-

;; Proves (OW-hiliti): a prompt in flight when the helper's event stream
;; drops, whose turn this Emacs saw streaming, keeps its turn-done watch
;; for the helper's teardown, which ends the turn and raises the
;; indicator (OW-zedawo).  Drives the real `runHelper' through
;; `emacs_helper_drop_stand_in.ts', whose stream drops 500 ms after it
;; opens.  `busy' waits without yielding until the helper has exited, so
;; its last messages, its sentinel and its teardown are all handled after
;; it; `idle' lets Emacs handle each as it comes.
;;
;; Run from the repository root; PROBE_RUNS sets the runs per case (3):
;;
;;   emacs --batch -L emacs -l ert -l agentpane -l agentpane-test \
;;     -l resources/probes/emacs_helper_drop_probe.el \
;;     --eval '(ert-run-tests-batch-and-exit "agentpane-probe-")'
;;
;; Each case prints `RAISED k of n' and passes only when every run raised.

(require 'agentpane-test)

(defconst agentpane-probe--drop-stand-in
  (expand-file-name "emacs_helper_drop_stand_in.ts"
                    (file-name-directory (or load-file-name buffer-file-name)))
  "The stand-in helper this probe starts.")

(defun agentpane-probe--runs ()
  "The runs per case, from PROBE_RUNS, 3 by default."
  (string-to-number (or (getenv "PROBE_RUNS") "3")))

(defun agentpane-probe--drop-once (busy)
  "Send a prompt through the stand-in helper, see its turn stream, let the
stream drop, and return whether the teardown raised the indicator, and
what the echo area said, as a cons.  BUSY as in the file's commentary."
  (agentpane-test--watching
    (let ((agentpane--connection nil)
          (ref '(:backend "codex" :id "t1")))
      (agentpane-test--with-session ref
        (agentpane-test--noting
          (cl-letf (((symbol-function 'agentpane--start-helper)
                     (lambda ()
                       (make-process :name "agentpane probe helper"
                                     :command (list "bun" "run" agentpane-probe--drop-stand-in)
                                     :connection-type 'pipe :noquery t
                                     :stderr (get-buffer-create "*agentpane probe stderr*")))))
            (agentpane--request 'sessions/list nil #'ignore)
            (let ((connection agentpane--connection))
              (setq agentpane--attached connection
                    agentpane--handle "h1")
              (goto-char (point-max))
              (insert "hello")
              (agentpane-send)
              ;; The server admitted the prompt and broadcast its turn
              ;; streaming; the POST's own response has not come.
              (agentpane--on-notification connection 'session/status
                                          (list :session ref :handle "h1" :isStreaming t))
              (when busy
                (agentpane-test--dead-unheard (jsonrpc--process connection)))
              (agentpane-test--heard-out connection)
              (cons (and (agentpane-test--turn-done-p) t) (reverse said)))))))))

(defun agentpane-probe--drop (busy)
  "Run `agentpane-probe--drop-once' with BUSY PROBE_RUNS times, print the
count raised and each run's messages, and return the count."
  (let ((runs (agentpane-probe--runs))
        (raised 0)
        (log nil))
    (dotimes (_ runs)
      (let ((result (agentpane-probe--drop-once busy)))
        (when (car result) (cl-incf raised))
        (push result log)))
    (princ (format "\n%s: RAISED %d of %d\n%s\n" (if busy "busy" "idle") raised runs
                   (mapconcat (lambda (entry) (format "%S" entry)) (reverse log) "\n")))
    raised))

(ert-deftest agentpane-probe-drop-busy ()
  "The stream drops while Emacs is busy; see the file's commentary."
  (should (= (agentpane-probe--drop t) (agentpane-probe--runs))))

(ert-deftest agentpane-probe-drop-idle ()
  "The stream drops while Emacs is idle; see the file's commentary."
  (should (= (agentpane-probe--drop nil) (agentpane-probe--runs))))

;;; emacs_helper_drop_probe.el ends here
