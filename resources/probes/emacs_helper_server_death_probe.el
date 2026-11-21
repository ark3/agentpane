;;; emacs_helper_server_death_probe.el --- A server killed with a prompt in flight -*- lexical-binding: t; -*-

;; Proves (OW-hiliti): the real helper, `bun run src/emacs/main.ts', over
;; a stand-in server (`emacs_helper_server_death_server.ts') that is
;; SIGKILLed 0.3 s after this Emacs's prompt goes out, and that meets
;; the prompt with the session's status streaming, so the helper's
;; turn-done watch sees the turn: at its socket's close the helper sends
;; that watch as `session/turnEnded', watched, before it exits, and
;; agentpane-mode raises the indicator from it (D32 point 6).  The
;; prompt itself is answered with the helper's own -32001 and no `data'
;; before the exit (D32 point 7), which must reach the prompt and not read
;; as a refusal.  Both rest on jsonrpc.el handling the dead helper's last
;; messages after its sentinel (D32 point 7).  Until D31 the prompt's own
;; HTTP request could fail first and be written back as a -32603 carrying
;; no `data'.
;;
;; Run from the repository root; PROBE_RUNS sets the runs (8):
;;
;;   emacs --batch -L emacs -l ert -l agentpane -l agentpane-test \
;;     -l resources/probes/emacs_helper_server_death_probe.el \
;;     --eval '(ert-run-tests-batch-and-exit "agentpane-probe-")'
;;
;; It prints `RAISED k of n' and `ANSWERED k of n', with each run's
;; result and the prompt's failure message, and passes only when every
;; run raised and every prompt's failure was reported.

(require 'agentpane-test)

(defconst agentpane-probe--death-dir
  (file-name-directory (or load-file-name buffer-file-name))
  "This probe's directory.")

(defun agentpane-probe--death-once ()
  "Start the stand-in server and the helper against it, send a prompt whose
turn the server reports streaming, kill the server, and return whether the
helper's `session/turnEnded' raised the indicator and the prompt's failure
message, as a list."
  (agentpane-test--watching
    (let* ((agentpane--connection nil)
           (ref '(:backend "codex" :id "t1"))
           (root (expand-file-name "../../" agentpane-probe--death-dir))
           (output (generate-new-buffer " *agentpane probe server*"))
           (server (make-process :name "agentpane probe server" :noquery t
                                 :connection-type 'pipe :buffer output
                                 :command (list "bun" "run"
                                                (expand-file-name "emacs_helper_server_death_server.ts"
                                                                  agentpane-probe--death-dir))))
           port)
      (unwind-protect
          (progn
            (agentpane-test--wait-for
             (lambda ()
               (with-current-buffer output
                 (when (string-match "ready \\([0-9]+\\)" (buffer-string))
                   (setq port (string-to-number (match-string 1 (buffer-string)))))))
             (+ (float-time) 10))
            (should port)
            (agentpane-test--with-session ref
              (agentpane-test--noting
                (cl-letf (((symbol-function 'agentpane--start-helper)
                           (lambda ()
                             (let ((default-directory root))
                               (make-process :name "agentpane probe helper" :noquery t
                                             :connection-type 'pipe
                                             :stderr (get-buffer-create "*agentpane probe stderr*")
                                             :command (list "bun" "run" "src/emacs/main.ts"
                                                            (format "http://127.0.0.1:%d" port)))))))
                  ;; A real attach, so the helper binds this buffer's view
                  ;; to the handle the prompt then goes under (D32 point 1).
                  (agentpane--attach)
                  (should (agentpane-test--wait-for #'agentpane--attached-p (+ (float-time) 10)))
                  (let ((connection agentpane--connection))
                    (goto-char (point-max))
                    (insert "hello")
                    (agentpane-send)
                    (sleep-for 0.3)
                    (signal-process server 'SIGKILL)
                    (agentpane-test--heard-out connection)
                    (list (and (agentpane-test--turn-done-p) t)
                          (agentpane-test--said-p "sessions/prompt failed" said)))))))
        (delete-process server)
        (kill-buffer output)))))

(ert-deftest agentpane-probe-server-death ()
  "See the file's commentary."
  (let ((runs (string-to-number (or (getenv "PROBE_RUNS") "8")))
        (raised 0)
        (answered 0)
        (log nil))
    (dotimes (_ runs)
      (let ((result (agentpane-probe--death-once)))
        (when (car result) (cl-incf raised))
        (when (cadr result) (cl-incf answered))
        (push result log)))
    (princ (format "\nRAISED %d of %d\nANSWERED %d of %d\n%s\n" raised runs answered runs
                   (mapconcat (lambda (entry) (format "%S" entry)) (reverse log) "\n")))
    (should (= raised runs))
    (should (= answered runs))))

;;; emacs_helper_server_death_probe.el ends here
