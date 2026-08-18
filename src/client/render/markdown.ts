/**
 * Markdown -> HTML, sanitized.
 *
 * The one rule here (D5, HANDOFF finding 13): **sanitize the parsed output.**
 * mini-lit's `MarkdownBlock` ran regexes over the markdown *source* and then
 * handed the result to `unsafeHTML` with nothing on the output side; that is
 * the mistake this module exists not to repeat. The primary use case is
 * rendering the contents of repositories we do not control into a page that
 * holds a channel to an API that spawns processes, so everything that reaches
 * `{@html}` in this package goes through `sanitize()` first -- markdown,
 * highlighted code, and diffs alike.
 *
 * Pure functions, no DOM components: this file is the unit-testable half of
 * the renderer.
 */

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";

// ---------------------------------------------------------------------------
// Escaping (of *output*, not of source -- see the note above)
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

// ---------------------------------------------------------------------------
// Syntax highlighting
// ---------------------------------------------------------------------------

/**
 * `highlight.js/lib/common` rather than the full bundle: common carries ~40
 * languages instead of ~190, and the rest are what an agent transcript never
 * shows. D5 notes `shiki` is the nicer output but is async, which fights
 * token-by-token rendering; revisit once streaming is settled.
 */
const EXT_LANGUAGE: Record<string, string> = {
	bash: "bash",
	c: "c",
	cc: "cpp",
	cjs: "javascript",
	cpp: "cpp",
	cs: "csharp",
	css: "css",
	diff: "diff",
	go: "go",
	h: "c",
	hpp: "cpp",
	htm: "xml",
	html: "xml",
	java: "java",
	js: "javascript",
	json: "json",
	jsonc: "json",
	jsx: "javascript",
	kt: "kotlin",
	less: "less",
	lua: "lua",
	md: "markdown",
	mjs: "javascript",
	mts: "typescript",
	patch: "diff",
	php: "php",
	pl: "perl",
	py: "python",
	rb: "ruby",
	rs: "rust",
	scss: "scss",
	sh: "bash",
	sql: "sql",
	svelte: "xml",
	swift: "swift",
	toml: "ini",
	ts: "typescript",
	tsx: "typescript",
	xml: "xml",
	yaml: "yaml",
	yml: "yaml",
	zsh: "bash",
};

/** Best-effort language id for a file path, for tool cards that show file bodies. */
export function languageFromPath(path: string): string | undefined {
	const name = path.split("/").pop() ?? "";
	if (name === "Dockerfile") return "dockerfile";
	if (name === "Makefile") return "makefile";
	const ext = name.includes(".") ? (name.split(".").pop() ?? "") : "";
	return EXT_LANGUAGE[ext.toLowerCase()];
}

/**
 * Highlighted HTML for a code body. Falls back to escaped plain text for an
 * unknown language or a highlighter failure -- never to raw text.
 */
export function highlightCode(code: string, language?: string | undefined): string {
	if (language && hljs.getLanguage(language)) {
		try {
			return hljs.highlight(code, { language, ignoreIllegals: true }).value;
		} catch {
			// fall through to escaped plain text
		}
	}
	return escapeHtml(code);
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/**
 * The location a local file reference points at, or `undefined` if the href is
 * not one (OW-62).
 *
 * Deliberately narrow: only an href with **no URI scheme at all** (a relative
 * or absolute path -- `src/api.ts:35` has no valid scheme, since a scheme
 * cannot contain `/` or `.`) or a `file:` url. Everything else keeps the
 * anchor path exactly as before, which matters most for the schemes we do not
 * want to own: `javascript:` and `data:` stay DOMPurify's business, and `#`
 * fragments are working in-document links.
 */
function fileReference(href: string): string | undefined {
	if (!href || href.startsWith("#")) return undefined;
	const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(href)?.[0];
	if (scheme && scheme.toLowerCase() !== "file:") return undefined;
	return href;
}

/**
 * Raw source of each fence in the parse that is running right now, in document
 * order, indexed by the `data-fence` attribute the code renderer writes (OW-63).
 *
 * Module state is safe here only because `parser.parse` is synchronous
 * (`async: false`) and this is a single-threaded renderer: one parse runs to
 * completion before the next begins, and `renderMarkdownWithFences` owns the
 * reset. Nothing outside that function may read it.
 */
let fenceSources: Fence[] = [];

/**
 * A private `Marked` instance: `marked.use()` on the module singleton is
 * global mutable state, and this package should not change how anything else
 * in the process parses markdown.
 */
const parser = new Marked({
	gfm: true,
	// Agents emit single newlines meaningfully (lists of paths, short lines).
	breaks: true,
	async: false,
	renderer: {
		code({ text, lang }) {
			const language = (lang ?? "").trim().split(/\s+/)[0] ?? "";
			const known = language && hljs.getLanguage(language) ? language : undefined;
			const body = highlightCode(text, known);
			const cls = known ? `hljs language-${escapeHtml(known)}` : "hljs";
			// The index is the only way back to the raw source: what lands in the
			// DOM is highlighted HTML, and a copy button must send the bytes the
			// model wrote. `sanitize()` forbids <button>, and rightly so, so the
			// control itself cannot ride along inside this string -- the caller
			// pairs it up with the source through this attribute (OW-63).
			const index = fenceSources.push({ code: text, language: known }) - 1;
			return `<pre class="ap-code" data-fence="${index}"><code class="${cls}">${body}</code></pre>\n`;
		},
		/**
		 * A local file reference is not a link: agentpane has nowhere to send
		 * it, and the href would fall into the SPA fallback and reload the app.
		 * A `<span>` instead of an `<a>` removes the false affordance while
		 * leaving ordinary text selection intact.
		 *
		 * The visible text is the location, not the author's label, unless the
		 * label already contains it -- that is what stops `[api.ts](a/b.ts:35)`
		 * from hiding the line number the reader came for.
		 *
		 * Returning `false` hands the token back to marked's own `link`
		 * renderer, so http(s), `mailto:`, `#` fragments and hostile schemes
		 * all reach the sanitizer exactly as they did before.
		 */
		link(token) {
			const location = fileReference(token.href);
			if (location === undefined) return false;
			const body = token.text.includes(location) ? this.parser.parseInline(token.tokens) : escapeHtml(location);
			return `<span class="ap-file-ref">${body}</span>`;
		},
	},
});

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

let hooksInstalled = false;

function installHooks(): void {
	if (hooksInstalled) return;
	hooksInstalled = true;
	DOMPurify.addHook("afterSanitizeAttributes", (node) => {
		if (!("getAttribute" in node)) return;
		if (node.nodeName !== "A") return;
		const href = node.getAttribute("href") ?? "";
		// Same-document anchors stay in place; anything else leaves the app,
		// and must not be able to reach back through `window.opener`.
		if (href && !href.startsWith("#")) {
			node.setAttribute("target", "_blank");
			node.setAttribute("rel", "noopener noreferrer nofollow");
		}
	});
}

/**
 * The single choke point for every string this package hands to `{@html}`.
 *
 * `USE_PROFILES: { html: true }` drops SVG and MathML wholesale -- neither is
 * something an agent transcript needs, and both widen the attack surface a lot.
 * `style` is forbidden as an attribute *and* a tag so page-controlled CSS
 * cannot reposition our chrome.
 */
export function sanitize(html: string): string {
	installHooks();
	return DOMPurify.sanitize(html, {
		USE_PROFILES: { html: true },
		ADD_ATTR: ["target", "rel"],
		FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed"],
		FORBID_ATTR: ["style"],
	});
}

/** One fenced (or indented) code block, as the author wrote it. */
export interface Fence {
	/** The raw code -- not the highlighted HTML, and not the language tag. */
	code: string;
	/** The info string, if it names a language the highlighter knows. */
	language?: string | undefined;
}

/** Sanitized HTML plus the source of every fence it contains. */
export interface RenderedMarkdown {
	html: string;
	/** Indexed by the `data-fence` attribute on `pre.ap-code`. */
	fences: Fence[];
}

/**
 * Markdown source -> sanitized HTML *and* the fence sources behind it, so a
 * caller can offer a per-fence copy without re-parsing or scraping the DOM
 * (OW-63).
 */
export function renderMarkdownWithFences(source: string): RenderedMarkdown {
	if (!source) return { html: "", fences: [] };
	fenceSources = [];
	const parsed = parser.parse(source, { async: false });
	const fences = fenceSources;
	fenceSources = [];
	return { html: sanitize(typeof parsed === "string" ? parsed : ""), fences };
}

/** Markdown source -> sanitized HTML, ready for `{@html}`. */
export function renderMarkdown(source: string): string {
	return renderMarkdownWithFences(source).html;
}

/** A standalone code body -> sanitized, highlighted HTML. */
export function renderCode(code: string, language?: string | undefined): string {
	return sanitize(highlightCode(code, language));
}
