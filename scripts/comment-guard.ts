/**
 * Checks that a change touched only comments and docstrings: each file is
 * compared with its state at a base revision after both are stripped of them.
 *
 *   bun run comment-guard <base> [file...]
 *
 * With no files it checks every tracked file that differs between <base> and
 * the working tree. Exits 1 on any difference beyond comments, and on a file it
 * cannot read.
 *
 * - TypeScript: TypeScript's printer with `removeComments`, so formatting
 *   is ignored along with comments, and string and template contents count.
 * - Svelte: the `<script>` blocks as TypeScript; markup and `<style>` with
 *   `<!-- -->` and `/* *\/` removed, trailing space and blank lines ignored.
 *   A regex split, not a parse: enough for this repo's components.
 * - Elisp: Emacs reads every top-level form of both files and compares them
 *   with docstrings dropped from the definition forms listed in `ELISP`. A
 *   string elsewhere counts, and so does the header line, which holds the
 *   `lexical-binding` cookie. Needs `emacs` on PATH.
 *
 * In every language, lines holding a directive comment (`DIRECTIVE`) must
 * match exactly, since removing one changes what the tools do.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const DIRECTIVE =
	/@ts-|eslint-|svelte-ignore|vitest-environment|prettier-ignore|biome-ignore|istanbul|c8 ignore|###autoload|lexical-binding|Local Variables/;

export function directiveLines(src: string): string {
	return src
		.split("\n")
		.filter((l) => DIRECTIVE.test(l))
		.map((l) => l.trim())
		.join("\n");
}

export function normalizeTs(src: string, tsx = false): string {
	const kind = tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sf = ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, false, kind);
	return ts.createPrinter({ removeComments: true }).printFile(sf);
}

const lines = (s: string): string =>
	s
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l.trim() !== "")
		.join("\n");

export function normalizeSvelte(src: string): string {
	const block = /(<script[^>]*>)([\s\S]*?)(<\/script>)|(<style[^>]*>)([\s\S]*?)(<\/style>)/;
	let out = "";
	let rest = src;
	for (let m = block.exec(rest); m; m = block.exec(rest)) {
		out += lines(rest.slice(0, m.index).replace(/<!--[\s\S]*?-->/g, ""));
		out += m[1] ? `${m[1]}\n${normalizeTs(m[2] ?? "")}\n${m[3]}` : `${m[4]}${lines((m[5] ?? "").replace(/\/\*[\s\S]*?\*\//g, ""))}${m[6]}`;
		rest = rest.slice(m.index + m[0].length);
	}
	return out + lines(rest.replace(/<!--[\s\S]*?-->/g, ""));
}

/**
 * The docstring's index in each definition form. `defvar`-like forms take
 * their docstring last; for the rest a string in that place is the docstring
 * only when a body follows it, else it is the return value.
 */
const ELISP = String.raw`;;; comment-guard.el  -*- lexical-binding: t; -*-
(require 'cl-lib)
(defconst cg-doc-pos
  '((defun . 3) (defmacro . 3) (defsubst . 3) (cl-defun . 3) (cl-defmacro . 3)
    (define-inline . 3) (cl-defsubst . 3) (defvar . 3) (defconst . 3) (defcustom . 3)
    (defface . 3) (defvar-local . 3) (defgroup . 3) (ert-deftest . 3)
    (define-derived-mode . 4) (define-minor-mode . 2) (cl-defstruct . 2)
    (lambda . 2) (cl-defgeneric . 3)))
(defconst cg-doc-last '(defvar defconst defcustom defface defvar-local defgroup))
(defun cg-strip (form)
  (cond
   ((and (consp form) (proper-list-p form))
    (let* ((head (car form))
           (pos (cdr (assq head cg-doc-pos)))
           (lst (copy-sequence form)))
      (when (and pos (> (length lst) pos) (stringp (nth pos lst))
                 (or (memq head cg-doc-last) (> (length lst) (1+ pos))))
        (setq lst (append (cl-subseq lst 0 pos) (nthcdr (1+ pos) lst))))
      (when (eq head 'cl-defmethod)
        (let ((tail (cdr (cl-member-if #'listp (cddr lst)))))
          (when (and (stringp (car tail)) (cdr tail))
            (setq lst (cl-remove (car tail) lst :count 1 :test #'eq)))))
      (when (eq head 'defvar-keymap)
        (let ((i (cl-position :doc lst)))
          (when i (setq lst (append (cl-subseq lst 0 i) (nthcdr (+ i 2) lst))))))
      (mapcar #'cg-strip lst)))
   ((consp form) (cons (cg-strip (car form)) (cg-strip (cdr form))))
   (t form)))
(defun cg-read-all (file)
  (with-temp-buffer
    (insert-file-contents file)
    (goto-char (point-min))
    (let (forms)
      (condition-case nil
          (while t (push (cg-strip (read (current-buffer))) forms))
        (end-of-file nil))
      (nreverse forms))))
(let* ((a (cg-read-all (nth 0 command-line-args-left)))
       (b (cg-read-all (nth 1 command-line-args-left)))
       (i 0) (bad 0))
  (setq command-line-args-left nil)
  (unless (= (length a) (length b))
    (princ (format "top-level form count differs: %d vs %d\n" (length a) (length b)))
    (setq bad 1))
  (while (and a b (< bad 5))
    (unless (equal (car a) (car b))
      (setq bad (1+ bad))
      (let ((print-length 8) (print-level 3))
        (princ (format "form %d differs:\n  base: %S\n  new:  %S\n" i (car a) (car b)))))
    (setq a (cdr a) b (cdr b) i (1+ i)))
  (kill-emacs (if (> bad 0) 1 0)))
`;

/** Null when the two read the same with docstrings dropped, else what differs. */
export function elispDifference(before: string, after: string): string | null {
	const dir = mkdtempSync(join(tmpdir(), "comment-guard-"));
	try {
		const script = join(dir, "guard.el");
		const a = join(dir, "before.el");
		const b = join(dir, "after.el");
		writeFileSync(script, ELISP);
		writeFileSync(a, before);
		writeFileSync(b, after);
		const r = spawnSync("emacs", ["--batch", "-Q", "-l", script, a, b], { encoding: "utf8" });
		if (r.error) throw new Error(`cannot run emacs: ${r.error.message}`);
		return r.status === 0 ? null : `${r.stdout}${r.stderr}`.trim() || `emacs exited ${r.status}`;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function firstDifference(x: string, y: string): string {
	const xl = x.split("\n");
	const yl = y.split("\n");
	let i = 0;
	while (i < xl.length && xl[i] === yl[i]) i++;
	return `near normalized line ${i + 1}\n  base: ${xl[i] ?? "<end>"}\n  new:  ${yl[i] ?? "<end>"}`;
}

export const CHECKED = [".ts", ".tsx", ".svelte", ".el"];

/** Each way `after` differs from `before` beyond comments; empty when none. */
export function problems(path: string, before: string, after: string): string[] {
	const found: string[] = [];
	if (directiveLines(before) !== directiveLines(after)) found.push("directive comments changed");
	if (path.endsWith(".el")) {
		if (before.split("\n")[0] !== after.split("\n")[0]) found.push("header line changed");
		const d = elispDifference(before, after);
		if (d) found.push(`code differs beyond comments and docstrings\n${d}`);
		return found;
	}
	const norm = path.endsWith(".svelte") ? normalizeSvelte : (s: string) => normalizeTs(s, path.endsWith(".tsx"));
	const x = norm(before);
	const y = norm(after);
	if (x !== y) found.push(`code differs beyond comments, ${firstDifference(x, y)}`);
	return found;
}

function main(argv: string[]): number {
	const [base, ...named] = argv;
	if (!base) {
		console.error("usage: bun run comment-guard <base> [file...]");
		return 2;
	}
	const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
	const files = named.length > 0 ? named : git("diff", "--name-only", base).split("\n").filter(Boolean);
	let failed = false;
	for (const file of files) {
		if (file.endsWith(".md")) {
			console.log(`skip ${file}`);
			continue;
		}
		if (!CHECKED.some((ext) => file.endsWith(ext))) {
			console.error(`FAIL ${file}: not a file type the guard reads`);
			failed = true;
			continue;
		}
		let before: string;
		let after: string;
		try {
			before = git("show", `${base}:${file}`);
			after = readFileSync(file, "utf8");
		} catch {
			console.error(`FAIL ${file}: missing at ${base} or in the working tree`);
			failed = true;
			continue;
		}
		const found = problems(file, before, after);
		if (found.length === 0) console.log(`ok   ${file}`);
		else {
			failed = true;
			for (const p of found) console.error(`FAIL ${file}: ${p}`);
		}
	}
	return failed ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
