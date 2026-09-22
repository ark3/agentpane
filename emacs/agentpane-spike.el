;;; agentpane-spike.el --- ewoc rendering spike for agentpane transcript nodes  -*- lexical-binding: t; -*-

;; Copyright (C) 2026 Abhay Saxena

;; This file is not part of GNU Emacs.

;;; Commentary:

;; A one-transcript rendering spike (OW-dekate).  It reads a JSON array of
;; transcript nodes -- the shape `projectTranscript' in src/emacs/nodes.ts
;; emits, declared in src/emacs/protocol.ts -- and draws one ewoc entry per
;; node in a read-only buffer: a role line, then each part (markdown text
;; fontified by `markdown-mode', tool calls and thinking folded behind a
;; summary line, edit diffs in `diff-mode' faces), then the turn's meta line.
;;
;; Invoke it with
;;
;;     M-x agentpane-spike-render RET /tmp/claude-nodes.json RET
;;
;; and in the buffer that opens: `n' / `p' step between nodes, `TAB' toggles
;; the fold at point, `q' buries the buffer.  In batch:
;;
;;     emacs --batch -L ~/.emacs.d/straight/build/markdown-mode -L emacs \
;;       -l agentpane-spike \
;;       --eval '(agentpane-spike-render "/tmp/claude-nodes.json")'
;;
;; This is a spike: no helper process, no session list, no streaming, no
;; tests.  OW-wavone will absorb it into the native mode or delete it.

;;; Code:

(require 'ewoc)
(require 'diff-mode)
(require 'markdown-mode)
(require 'text-property-search)
(require 'visual-wrap)
(require 'shr)
(require 'dom)

;;;; Faces

(defgroup agentpane-spike nil
  "Rendering spike for agentpane transcript nodes."
  :group 'applications)

(defface agentpane-spike-role-other
  '((t :inherit font-lock-type-face :weight bold))
  "Face for the role line of a node whose role is neither user nor assistant.")

(defface agentpane-spike-tool
  '((t :inherit font-lock-builtin-face))
  "Face for a tool part's summary line.")

(defface agentpane-spike-thinking
  '((t :inherit shadow :slant italic))
  "Face for a thinking part.")

(defface agentpane-spike-dim
  '((t :inherit shadow))
  "Face for the meta line and other secondary text.")

(defface agentpane-spike-warning
  '((t :inherit warning))
  "Face for an aborted or errored turn and an errored tool call.")

(defface agentpane-spike-prose
  '((t :inherit variable-pitch))
  "Face the buffer's `default' is remapped to: proportional prose at the same
size as the owner's markdown buffers.  Code, tables and diffs stay monospace
by inheriting `fixed-pitch'.")

(defface agentpane-spike-user-box
  '((((background dark)) :background "#21252c" :extend t)
    (((background light)) :background "#f1f3f6" :extend t))
  "Face tinting a user turn, the browser's one raised surface in the transcript:
its `--ap-surface-raised' for each theme (`src/client/app.css').
Appended under the markdown faces, so it supplies only the background.")

(defface agentpane-spike-user-bar
  '((((background dark)) :foreground "#7f9dff")
    (((background light)) :foreground "#3959d9"))
  "Face for the accent bar down the left edge of a user turn, after the
browser's `border-left' on `.msg.user', in its `--ap-accent' for each theme.")

(defface agentpane-spike-meta
  '((t :inherit shadow :height 0.8))
  "Face for an assistant turn's meta line: the browser's `.meta', small and subtle.")

(defface agentpane-spike-code-block
  '((((background dark)) :background "#161b22" :extend t)
    (((background light)) :background "#f4f6f8" :extend t))
  "Background behind a fenced code block drawn through shr, after the
browser's tinted `pre.ap-code'.")

;; The shr backend's typography copies `Markdown.svelte''s stylesheet, each
;; number a ratio to the browser's body size (`--ap-text-md', 0.9375rem):
;; headings at 1.25rem, 1.0625rem and the body size, all weight 600; tables
;; at 0.8125rem; code at 0.9em, inline code on the raised surface; table
;; headers on the raised surface.  Emacs `:height' floats compose the same
;; way `em' does, so each face states its ratio and inherits the rest.

(defface agentpane-spike-h1
  '((t :weight bold :height 1.333))
  "Face for a level-one heading drawn through shr: the browser's `h1'.")

(defface agentpane-spike-h2
  '((t :weight bold :height 1.133))
  "Face for a level-two heading drawn through shr: the browser's `h2'.")

(defface agentpane-spike-h3
  '((t :weight bold))
  "Face for a heading of level three or below drawn through shr: the browser
gives those the body size and only the weight.")

(defface agentpane-spike-table
  '((t :height 0.95))
  "Face for a table's cells drawn through shr, a little under the prose size,
after the browser's `table' at `--ap-text-sm'.  The stylesheet's exact ratio,
0.867, gave 14px under 18px prose and read too small to the owner on
2026-09-22, and 0.9 of the 10pt prose is 9pt, the code size, 15px; 0.95 is
the step between, 16px.  Bound as shr's current font while the table is laid
out, so the column widths are measured at this size.")

(defface agentpane-spike-th
  '((t :inherit bold))
  "Face for a table header cell drawn through shr: bold, and nothing else.
The browser's raised surface behind it was tried on 2026-09-22 and the
owner found it did not fit the look.")

(defface agentpane-spike-code
  '((t :inherit fixed-pitch))
  "Face for code drawn through shr, inline or fenced.
Its size comes from the buffer-local remap of `fixed-pitch' that
`agentpane-spike-mode' installs; see there.")

(defface agentpane-spike-inline-code
  '((((background dark)) :inherit agentpane-spike-code :background "#1f2733")
    (((background light)) :inherit agentpane-spike-code :background "#eef2f8"))
  "Face for inline code drawn through shr: `agentpane-spike-code' on the
raised surface, after the browser's `:not(pre) > code'.")

(defvar agentpane-spike--in-pre nil
  "Non-nil while shr draws the inside of a pre block, so the `code' handler
leaves a fenced block on the block's own face rather than the inline one.")

(defvar agentpane-spike-text-backend 'markdown
  "How a text part is drawn.
`markdown' fontifies the markdown source with `markdown-mode'; `shr' renders
the HTML the browser shows for it, the dump's `html' field, through `shr',
and falls back to `markdown' on a part that carries no `html'.
`b' in a rendered buffer flips this and redraws.")

(defconst agentpane-spike--hljs-faces
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

(defconst agentpane-spike--bar "▌ "
  "The accent bar and the gap after it, carried as `line-prefix' and
`wrap-prefix' on every line of a user turn so wrapped rows keep it.")

;;;; State

(defvar-local agentpane-spike--ewoc nil
  "The ewoc drawing this buffer's nodes.")

(defvar-local agentpane-spike--folds nil
  "Hash table of fold keys (INDEX . ORDINAL) that are currently expanded.
A key absent from the table is folded; that is every fold's initial state.")

(defvar-local agentpane-spike--file nil
  "The file this buffer was rendered from.")

;;;; Reading

(defun agentpane-spike--read-nodes (file)
  "Parse FILE, a JSON array of transcript nodes, into a list of alists."
  (with-temp-buffer
    (insert-file-contents file)
    (goto-char (point-min))
    (json-parse-buffer :object-type 'alist
                       :array-type 'list
                       :null-object nil
                       :false-object nil)))

(defun agentpane-spike--get (key object)
  "Return KEY's value in OBJECT, an alist parsed from JSON."
  (alist-get key object))

;;;; Fontifying

(defun agentpane-spike--freeze-faces (beg end)
  "Copy every `face' property between BEG and END onto `font-lock-face'.
The ewoc buffer never runs font-lock itself, so `face' is what draws; the
copy is insurance for an Emacs where font-lock does get switched on there."
  (let ((pos beg))
    (while (< pos end)
      (let ((next (or (next-single-property-change pos 'face nil end) end))
            (face (get-text-property pos 'face)))
        (when face
          (put-text-property pos next 'font-lock-face face))
        (setq pos next)))))

(defun agentpane-spike--fontify-markdown (text)
  "Return TEXT, markdown source, fontified with `markdown-mode's keywords."
  (with-temp-buffer
    (insert text)
    ;; Bound around the mode call, since the mode reads both when it starts:
    ;; hidden markup (`**', backticks, `#') is how the browser reads, where
    ;; the source characters never show, and native fences are what the
    ;; owner's init sets globally but batch runs do not.
    (let ((markdown-hide-markup t)
          (markdown-fontify-code-blocks-natively t))
      (delay-mode-hooks (markdown-mode)))
    (font-lock-ensure)
    ;; Hanging indents for list items and block quotes, as the owner's
    ;; markdown buffers get from `visual-wrap-prefix-mode'. Run here, over
    ;; markdown-mode's adaptive-fill settings, rather than in the ewoc
    ;; buffer: there the mode would also rewrite the user turn's bar prefix.
    ;; The `wrap-prefix' and `min-width' properties it leaves are plain text
    ;; properties and travel with the string.
    (visual-wrap-prefix-function (point-min) (point-max))
    (agentpane-spike--freeze-faces (point-min) (point-max))
    (buffer-string)))

;;;; Rendering HTML through shr

(defun agentpane-spike--hljs-face (classes)
  "The face for the first highlight.js class in CLASSES, a class attribute, or nil."
  (seq-some (lambda (class) (cdr (assoc class agentpane-spike--hljs-faces)))
            (split-string (or classes ""))))

(defun agentpane-spike--shr-span (dom)
  "Draw DOM, a span, as shr does, then colour it by its highlight.js class."
  (let ((start (point))
        (face (agentpane-spike--hljs-face (dom-attr dom 'class))))
    (shr-tag-span dom)
    (when face
      (add-face-text-property start (point) face))))

(defun agentpane-spike--shr-pre (dom)
  "Draw DOM, a pre block, as shr does, in code on the code-block background."
  (shr-ensure-newline)
  (let ((start (point))
        (agentpane-spike--in-pre t))
    (shr-tag-pre dom)
    ;; `shr-tag-pre' binds the current font to `default', so the text of a
    ;; block comes out without `shr-code' even inside `<code>' (Emacs
    ;; 31.1.50, measured 2026-09-21); an inline `<code>' does get it.
    (add-face-text-property start (point) 'agentpane-spike-code t)
    (add-face-text-property start (point) 'agentpane-spike-code-block t)))

(defun agentpane-spike--shr-code (dom)
  "Draw DOM, a code element: inline code on its raised surface, unless inside a
pre block, where the block's own face already applies."
  (let ((start (point)))
    (shr-tag-code dom)
    (unless agentpane-spike--in-pre
      (add-face-text-property start (point) 'agentpane-spike-inline-code))))

(defun agentpane-spike--shr-heading (dom face)
  "Draw DOM, a heading, as its own paragraph in FACE."
  (shr-ensure-paragraph)
  (let ((start (point)))
    (shr-generic dom)
    (add-face-text-property start (point) face))
  (shr-ensure-paragraph))

(defun agentpane-spike--shr-h1 (dom)
  "Draw DOM, an h1, in `agentpane-spike-h1'."
  (agentpane-spike--shr-heading dom 'agentpane-spike-h1))

(defun agentpane-spike--shr-h2 (dom)
  "Draw DOM, an h2, in `agentpane-spike-h2'."
  (agentpane-spike--shr-heading dom 'agentpane-spike-h2))

(defun agentpane-spike--shr-h3 (dom)
  "Draw DOM, a heading of level three or below, in `agentpane-spike-h3'."
  (agentpane-spike--shr-heading dom 'agentpane-spike-h3))

(defun agentpane-spike--shr-table (dom)
  "Draw DOM, a table, as shr does, with its cells measured and drawn at
`agentpane-spike-table' size."
  ;; Filling is off for prose, which wraps live; a table needs it on, so each
  ;; cell folds inside its own column instead of the row wrapping as one long
  ;; line at the window edge and the last cell landing under the first.
  (let ((shr-current-font 'agentpane-spike-table)
        (shr-fill-text t))
    (shr-tag-table dom)))

(defun agentpane-spike--shr-th (dom)
  "Draw DOM, a header cell, on `agentpane-spike-th'.
shr has no `shr-tag-th' and renders the cell generically; this is the same
with the face on top."
  (let ((start (point)))
    (shr-generic dom)
    (add-face-text-property start (point) 'agentpane-spike-th)))

(defun agentpane-spike--lift-emphasis (beg end)
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

(defun agentpane-spike--insert-html (html)
  "Draw HTML, the browser's rendering of one text part, through shr at point.
Filling is left to `visual-line-mode', as the markdown backend does, and
the same visual-wrap pass gives wrapped list rows their hanging indent."
  (let ((dom (with-temp-buffer
               (insert html)
               (libxml-parse-html-region (point-min) (point-max))))
        (shr-fill-text nil)
        (shr-inhibit-images t)
        (shr-external-rendering-functions
         '((span . agentpane-spike--shr-span)
           (pre . agentpane-spike--shr-pre)
           (code . agentpane-spike--shr-code)
           (h1 . agentpane-spike--shr-h1)
           (h2 . agentpane-spike--shr-h2)
           (h3 . agentpane-spike--shr-h3)
           (h4 . agentpane-spike--shr-h3)
           (h5 . agentpane-spike--shr-h3)
           (h6 . agentpane-spike--shr-h3)
           (table . agentpane-spike--shr-table)
           (th . agentpane-spike--shr-th)))
        (start (point)))
    (shr-insert-document dom)
    (agentpane-spike--lift-emphasis start (point))
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

;;;; Drawing

(defun agentpane-spike--expanded-p (key)
  "Non-nil when the fold KEY is expanded."
  (gethash key agentpane-spike--folds))

(defun agentpane-spike--insert-fold (key summary body)
  "Insert SUMMARY as one line, then BODY folded beneath it under fold KEY.
SUMMARY is a propertized line without its newline; BODY is a string, possibly
multi-line, without a trailing newline, or nil when there is nothing to fold.
Both carry the `agentpane-spike-fold' property so `TAB' finds the fold from
either, and BODY is invisible unless KEY is expanded."
  (let* ((expanded (agentpane-spike--expanded-p key))
         (marker (if body (if expanded "▾ " "▸ ") "  ")))
    (insert (propertize marker 'face 'agentpane-spike-dim 'agentpane-spike-fold key)
            (propertize summary 'agentpane-spike-fold key)
            (propertize "\n" 'agentpane-spike-fold key))
    (when body
      (let ((start (point)))
        (insert body "\n")
        (add-text-properties start (point) (list 'agentpane-spike-fold key))
        (unless expanded
          ;; Hide from the summary's newline through the body's last
          ;; character, so the ellipsis lands at the end of the summary
          ;; line and the line after the body starts fresh.
          (put-text-property (1- start) (1- (point)) 'invisible 'agentpane-spike))))))

(defun agentpane-spike--diff-text (lines)
  "Render LINES, a list of diff-line alists, as a propertized string."
  (mapconcat
   (lambda (line)
     (let ((type (agentpane-spike--get 'type line))
           (text (agentpane-spike--get 'text line)))
       (pcase type
         ("add" (propertize (concat "+" text) 'face 'diff-added))
         ("del" (propertize (concat "-" text) 'face 'diff-removed))
         ("ctx" (propertize (concat " " text) 'face 'diff-context))
         ("gap" (propertize text 'face 'diff-hunk-header))
         (_ (propertize (format "?%s %s" type text) 'face 'agentpane-spike-warning)))))
   lines "\n"))

(defun agentpane-spike--tool-body (part)
  "The folded body of a tool PART: its diff, args and result, or nil."
  (let ((diff (agentpane-spike--get 'diff part))
        (args (agentpane-spike--get 'args part))
        (result (agentpane-spike--get 'result part))
        (chunks nil))
    (when diff
      (push (agentpane-spike--diff-text diff) chunks))
    (when (and args (not (string-empty-p args)))
      (push (concat (propertize "args:" 'face 'agentpane-spike-dim) "\n" args) chunks))
    (push (concat (propertize "result:" 'face 'agentpane-spike-dim) "\n"
                  (if (and result (not (string-empty-p result)))
                      result
                    (propertize "(none)" 'face 'agentpane-spike-dim)))
          chunks)
    (let ((body (mapconcat #'identity (nreverse chunks) "\n")))
      ;; Arguments, results and diffs are column-aligned text: keep them
      ;; monospace under the buffer's proportional default. Appended, so the
      ;; diff faces already on the text keep every attribute but the family.
      (add-face-text-property 0 (length body) 'fixed-pitch t body)
      body)))

(defun agentpane-spike--insert-tool (key part)
  "Insert a tool PART under fold KEY."
  (let* ((name (agentpane-spike--get 'name part))
         (summary (agentpane-spike--get 'summary part))
         (state (agentpane-spike--get 'state part))
         (marker (pcase state
                   ("ok" "")
                   ("error" (propertize " ✗ error" 'face 'agentpane-spike-warning))
                   ("running" (propertize " … running" 'face 'agentpane-spike-dim))
                   (_ (propertize (format " ?%s" state) 'face 'agentpane-spike-warning)))))
    (agentpane-spike--insert-fold
     key
     (concat (propertize name 'face 'agentpane-spike-tool)
             (if (string-empty-p summary) "" (concat " " summary))
             marker)
     (agentpane-spike--tool-body part))))

(defun agentpane-spike--insert-thinking (key part)
  "Insert a thinking PART under fold KEY: its first line shown, the rest folded."
  (let ((text (or (agentpane-spike--get 'text part) ""))
        (redacted (agentpane-spike--get 'redacted part)))
    (cond
     (redacted
      (agentpane-spike--insert-fold
       key (propertize "thinking (redacted)" 'face 'agentpane-spike-thinking) nil))
     ;; A signature-only block, which is every thinking part a Claude Code
     ;; store carried on 2026-09-21: the browser's `Thinking.svelte' renders
     ;; nothing for it, so neither does this.
     ((string-empty-p text) nil)
     (t
      (let* ((split (string-search "\n" text))
             (head (if split (substring text 0 split) text))
             (rest (and split (string-trim-right (substring text (1+ split))))))
        (agentpane-spike--insert-fold
         key
         (propertize (concat "thinking: " head) 'face 'agentpane-spike-thinking)
         (and rest (not (string-empty-p rest))
              (propertize rest 'face 'agentpane-spike-thinking))))))))

(defun agentpane-spike--insert-part (index ordinal part)
  "Insert PART, the ORDINAL-th part of the node at INDEX."
  (let ((key (cons index ordinal))
        (type (agentpane-spike--get 'type part)))
    (pcase type
      ("text"
       (let ((html (agentpane-spike--get 'html part)))
         (if (and (eq agentpane-spike-text-backend 'shr)
                  html (not (string-empty-p html)))
             (agentpane-spike--insert-html html)
           (insert (agentpane-spike--fontify-markdown (agentpane-spike--get 'text part)))
           (unless (bolp) (insert "\n")))))
      ("thinking" (agentpane-spike--insert-thinking key part))
      ("tool" (agentpane-spike--insert-tool key part))
      ("image"
       (insert (propertize (format "[image %s]" (agentpane-spike--get 'mimeType part))
                           'face 'agentpane-spike-dim)
               "\n"))
      (_
       (insert (propertize (format "[unknown part type %S]" type)
                           'face 'agentpane-spike-warning)
               "\n")))))

(defun agentpane-spike--insert-meta (index meta)
  "Insert the meta line for the assistant node at INDEX from META."
  (let* ((usage (agentpane-spike--get 'usage meta))
         (stop (agentpane-spike--get 'stopReason meta))
         (error-message (agentpane-spike--get 'errorMessage meta))
         (effort (agentpane-spike--get 'effort meta))
         (face (if stop 'agentpane-spike-warning 'agentpane-spike-meta))
         (fields
          (delq nil
                (list (format "#%s" index)
                      (let ((model (agentpane-spike--get 'model meta)))
                        (if (or (null model) (string-empty-p model)) "model ?" model))
                      (and effort (format "effort %s" effort))
                      (format "%s tokens" (or (agentpane-spike--get 'totalTokens usage) 0))
                      (format "$%.4f" (or (agentpane-spike--get 'cost usage) 0))
                      stop
                      error-message))))
    (insert (propertize (concat "— " (mapconcat #'identity fields " · ")) 'face face)
            "\n")))

(defun agentpane-spike--bar-wrap-prefixes (beg end bar)
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

(defun agentpane-spike--pp (node)
  "Pretty-print NODE, one transcript node alist, at point.
The layout follows the browser's `Message.svelte': an assistant turn is plain
text on the page, closed by its small meta line and nothing else, so
consecutive assistant turns run together the way they do there; a user turn
is the one raised surface, a tinted box with an accent bar down its left
edge, with a blank line on either side.  Neither carries a role label."
  (let* ((index (agentpane-spike--get 'index node))
         (role (agentpane-spike--get 'role node))
         (userp (equal role "user"))
         (ordinal 0))
    (when userp (insert "\n"))
    (unless (or userp (equal role "assistant"))
      (insert (propertize role 'face 'agentpane-spike-role-other) "\n"))
    (let ((body-start (point)))
      (dolist (part (agentpane-spike--get 'parts node))
        (agentpane-spike--insert-part index ordinal part)
        (setq ordinal (1+ ordinal)))
      (let ((meta (agentpane-spike--get 'meta node)))
        (when meta (agentpane-spike--insert-meta index meta)))
      (when userp
        ;; The bar runs down the box's left edge, and `wrap-prefix' carries it
        ;; onto the rows `visual-line-mode' wraps. Nothing here uses
        ;; `visual-wrap-prefix-mode', which would write its own `wrap-prefix'
        ;; over this one; hanging indents for wrapped list items are the price.
        (let ((bar (propertize agentpane-spike--bar 'face 'agentpane-spike-user-bar)))
          (put-text-property body-start (point) 'line-prefix bar)
          (agentpane-spike--bar-wrap-prefixes body-start (point) bar)
          (add-face-text-property body-start (point) 'agentpane-spike-user-box t))))
    (when userp (insert "\n"))))

;;;; Mode and commands

(defvar agentpane-spike-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "n") #'agentpane-spike-next)
    (define-key map (kbd "p") #'agentpane-spike-prev)
    (define-key map (kbd "TAB") #'agentpane-spike-toggle)
    (define-key map (kbd "<tab>") #'agentpane-spike-toggle)
    (define-key map (kbd "q") #'quit-window)
    (define-key map (kbd "b") #'agentpane-spike-toggle-backend)
    map)
  "Keymap for `agentpane-spike-mode'.")

(define-derived-mode agentpane-spike-mode special-mode "agentpane-spike"
  "Major mode for a rendered agentpane transcript.
\\{agentpane-spike-mode-map}"
  (setq-local agentpane-spike--folds (make-hash-table :test #'equal))
  (add-to-invisibility-spec '(agentpane-spike . t))
  ;; The markup markdown-mode hid when it fontified each text part stays
  ;; hidden here only if this buffer's spec names the same symbol.
  (add-to-invisibility-spec 'markdown-markup)
  ;; Proportional prose and word wrap at the window edge; markdown-mode's
  ;; code and table faces inherit `fixed-pitch', so they stay monospace
  ;; under the remapped default.
  (buffer-face-set 'agentpane-spike-prose)
  ;; A little more leading than Emacs's default, toward the browser's 1.55
  ;; line height; the owner asked for "slightly" on 2026-09-22, and 0.15 is
  ;; the value their agent-shell setup already uses.
  (setq-local line-spacing 0.15)
  ;; `fixed-pitch' carries a family and no height, so under the proportional
  ;; default above it would take the prose face's size, larger than the
  ;; default face's (measured 2026-09-22: 19px against 15px in an ordinary
  ;; buffer). Pin it to the default face's absolute height, and everything
  ;; monospace here -- code through either backend, tool bodies, diffs --
  ;; is the size monospace text has elsewhere, and smaller than the prose
  ;; beside it as the browser's 0.9em code is.
  (face-remap-add-relative 'fixed-pitch
                           `(:height ,(face-attribute 'default :height nil t)))
  (setq truncate-lines nil)
  (visual-line-mode 1)
  ;; The owner's init hooks `visual-wrap-prefix-mode' onto `visual-line-mode',
  ;; and that mode rewrites `wrap-prefix' with its own hanging indent, which
  ;; erased the gutter bar from every wrapped row (measured 2026-09-21).
  (when (bound-and-true-p visual-wrap-prefix-mode)
    (visual-wrap-prefix-mode -1)))

(defun agentpane-spike--ewoc ()
  "This buffer's ewoc, or signal an error outside a rendered buffer."
  (or agentpane-spike--ewoc
      (user-error "Not an agentpane-spike buffer")))

(defun agentpane-spike-next (&optional n)
  "Move point to the start of the N-th next node."
  (interactive "p")
  (ewoc-goto-next (agentpane-spike--ewoc) (or n 1)))

(defun agentpane-spike-prev (&optional n)
  "Move point to the start of the N-th previous node."
  (interactive "p")
  (ewoc-goto-prev (agentpane-spike--ewoc) (or n 1)))

(defun agentpane-spike-index-at-point ()
  "The transcript index of the node at point, or nil between nodes."
  (let* ((ewoc (agentpane-spike--ewoc))
         (node (ewoc-locate ewoc)))
    (and node (agentpane-spike--get 'index (ewoc-data node)))))

(defun agentpane-spike--goto-fold (key)
  "Move point to the summary line carrying fold KEY within the node at point."
  (let ((ewoc (agentpane-spike--ewoc)))
    (goto-char (ewoc-location (ewoc-locate ewoc)))
    (let ((match (text-property-search-forward 'agentpane-spike-fold key t)))
      (when match
        (goto-char (prop-match-beginning match))
        (skip-chars-forward "▸▾ ")))))

(defun agentpane-spike-toggle ()
  "Toggle the fold at point: a tool or thinking part's folded body."
  (interactive)
  (let* ((ewoc (agentpane-spike--ewoc))
         (key (or (get-text-property (point) 'agentpane-spike-fold)
                  (save-excursion
                    (beginning-of-line)
                    (get-text-property (point) 'agentpane-spike-fold))))
         (node (ewoc-locate ewoc)))
    (unless (and key node)
      (user-error "No fold at point"))
    (if (agentpane-spike--expanded-p key)
        (remhash key agentpane-spike--folds)
      (puthash key t agentpane-spike--folds))
    (let ((inhibit-read-only t))
      (ewoc-invalidate ewoc node))
    (agentpane-spike--goto-fold key)))

(defun agentpane-spike-toggle-backend ()
  "Flip `agentpane-spike-text-backend' and redraw this buffer from its file."
  (interactive)
  (unless agentpane-spike--file
    (user-error "Not an agentpane-spike buffer"))
  (setq agentpane-spike-text-backend
        (if (eq agentpane-spike-text-backend 'shr) 'markdown 'shr))
  (let ((file agentpane-spike--file))
    (agentpane-spike-render file)
    (message "Text parts drawn by %s" agentpane-spike-text-backend)))

;;;###autoload
(defun agentpane-spike-render (file)
  "Render FILE, a JSON array of agentpane transcript nodes, in a new buffer."
  (interactive "fNode dump: ")
  (let* ((nodes (agentpane-spike--read-nodes file))
         (name (format "*agentpane-spike: %s*" (file-name-nondirectory file)))
         (buffer (get-buffer-create name)))
    (with-current-buffer buffer
      (let ((inhibit-read-only t))
        (erase-buffer)
        (agentpane-spike-mode)
        (setq agentpane-spike--file file)
        (setq agentpane-spike--ewoc
              (ewoc-create #'agentpane-spike--pp
                           (propertize (format "%s — %d nodes — text by %s\n"
                                               file (length nodes)
                                               agentpane-spike-text-backend)
                                       'face 'agentpane-spike-dim)
                           nil
                           t))
        (dolist (node nodes)
          (ewoc-enter-last agentpane-spike--ewoc node))
        (goto-char (point-min))
        (when nodes
          (ewoc-goto-node agentpane-spike--ewoc
                          (ewoc-nth agentpane-spike--ewoc 0)))))
    ;; In the selected window, not another one: driven over `emacsclient'
    ;; during the live session, the default `display-buffer' kept taking the
    ;; owner's other window, the one holding the buffer being compared against.
    (pop-to-buffer buffer '(display-buffer-same-window))
    buffer))

(provide 'agentpane-spike)

;;; agentpane-spike.el ends here
