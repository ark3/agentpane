;;; emacs_helper_drop_probe.el --- A prompt in flight at a socket's close -*- lexical-binding: t; -*-

;; Proves (OW-hiliti): when the helper's socket closes with a prompt in
;; flight whose turn the server reported streaming, the helper sends its
;; turn-done watch as `session/turnEnded', watched, before it exits, and
;; agentpane-mode raises the indicator from it (D32 point 6).  Drives the
;; real `runHelper' through `emacs_helper_drop_stand_in.ts', which meets
;; the prompt with the session's status streaming over the socket and
;; closes the socket 500 ms after it opens; until D31 it was an event
;; stream that dropped, and until ark3/agentpane#72 agentpane-mode kept
;; the watch itself and raised it at its own teardown.  `busy' waits
;; without yielding until the helper has exited, so its last messages, its
;; sentinel and its teardown are all handled after it; `idle' lets Emacs
;; handle each as it comes.
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
  "Send a prompt through the stand-in helper, whose server reports its turn
streaming, let the socket close, and return whether the helper's
`session/turnEnded' raised the indicator, and what the echo area said, as
a cons.  BUSY as in the file's commentary."
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
            ;; A real attach, so the helper binds this buffer's view to
            ;; the handle the prompt then goes under (D32 point 1).
            (agentpane--attach)
            (should (agentpane-test--wait-for #'agentpane--attached-p (+ (float-time) 10)))
            (let ((connection agentpane--connection))
              (goto-char (point-max))
              (insert "hello")
              (agentpane-send)
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
  "The socket closes while Emacs is busy; see the file's commentary."
  (should (= (agentpane-probe--drop t) (agentpane-probe--runs))))

(ert-deftest agentpane-probe-drop-idle ()
  "The socket closes while Emacs is idle; see the file's commentary."
  (should (= (agentpane-probe--drop nil) (agentpane-probe--runs))))

;;; emacs_helper_drop_probe.el ends here
