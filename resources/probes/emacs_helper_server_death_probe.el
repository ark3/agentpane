;;; emacs_helper_server_death_probe.el --- A server killed with a prompt in flight -*- lexical-binding: t; -*-

;; Proves (OW-hiliti): the real helper, `bun run src/emacs/main.ts', over
;; a stand-in server (`emacs_helper_server_death_server.ts') that is
;; SIGKILLed 0.3 s after this Emacs's prompt goes out, whose turn this
;; Emacs saw streaming: the prompt keeps its turn-done watch for the
;; helper's teardown, which ends the turn and raises the indicator
;; (OW-zedawo).  The socket's error can reach the helper before the
;; stream's drop, and the helper then writes it back as a -32603 error
;; reply carrying no `data', which must not read as a refusal.
;;
;; Run from the repository root; PROBE_RUNS sets the runs (8):
;;
;;   emacs --batch -L emacs -l ert -l agentpane -l agentpane-test \
;;     -l resources/probes/emacs_helper_server_death_probe.el \
;;     --eval '(ert-run-tests-batch-and-exit "agentpane-probe-")'
;;
;; It prints `RAISED k of n', with each run's result and the prompt's
;; failure message, and passes only when every run raised.

(require 'agentpane-test)

(defconst agentpane-probe--death-dir
  (file-name-directory (or load-file-name buffer-file-name))
  "This probe's directory.")

(defun agentpane-probe--death-once ()
  "Start the stand-in server and the helper against it, send a prompt, see
its turn stream, kill the server, and return whether the teardown raised
the indicator and the prompt's failure message, as a list."
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
                  (let ((listed nil))
                    (agentpane--request 'sessions/list nil (lambda (_) (setq listed t)))
                    (should (agentpane-test--wait-for (lambda () listed) (+ (float-time) 10))))
                  (let ((connection agentpane--connection))
                    (setq agentpane--attached connection
                          agentpane--handle "h1")
                    (goto-char (point-max))
                    (insert "hello")
                    (agentpane-send)
                    (agentpane--on-notification connection 'session/status
                                                (list :session ref :handle "h1" :isStreaming t))
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
        (log nil))
    (dotimes (_ runs)
      (let ((result (agentpane-probe--death-once)))
        (when (car result) (cl-incf raised))
        (push result log)))
    (princ (format "\nRAISED %d of %d\n%s\n" raised runs
                   (mapconcat (lambda (entry) (format "%S" entry)) (reverse log) "\n")))
    (should (= raised runs))))

;;; emacs_helper_server_death_probe.el ends here
