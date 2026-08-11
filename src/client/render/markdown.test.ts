/**
 * Markdown parsing and -- mostly -- sanitization.
 *
 * D5 makes DOMPurify non-optional: the primary use case is rendering the
 * contents of repositories we do not control into a page that holds a channel
 * to an API that spawns processes. These are the cases that must never regress.
 */

import { describe, expect, it } from "vitest";
import { highlightCode, languageFromPath, renderCode, renderMarkdown, sanitize } from "./markdown.ts";

describe("renderMarkdown", () => {
	it("renders common markdown", () => {
		const html = renderMarkdown("## Title\n\n- one\n- two\n\n**bold** and `code`");
		expect(html).toContain("<h2");
		expect(html).toContain("<li>one</li>");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<code>code</code>");
	});

	it("renders tables (gfm)", () => {
		const html = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
		expect(html).toContain("<table>");
		expect(html).toContain("<th>a</th>");
	});

	it("highlights fenced code with a known language", () => {
		const html = renderMarkdown("```ts\nconst x: number = 1;\n```");
		expect(html).toContain('class="hljs language-ts"');
		expect(html).toContain("hljs-keyword");
	});

	it("falls back to escaped text for an unknown language", () => {
		const html = renderMarkdown("```wat\n<not-a-tag>\n```");
		expect(html).toContain("&lt;not-a-tag&gt;");
		expect(html).not.toContain("<not-a-tag>");
	});

	it("returns empty string for empty input", () => {
		expect(renderMarkdown("")).toBe("");
	});
});

describe("sanitization", () => {
	it("drops script tags in raw HTML", () => {
		const html = renderMarkdown("before\n\n<script>alert(1)</script>\n\nafter");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("alert(1)");
	});

	it("drops event handler attributes", () => {
		const html = renderMarkdown('<img src="x" onerror="alert(1)">');
		expect(html).not.toContain("onerror");
	});

	it("drops javascript: hrefs", () => {
		const html = renderMarkdown("[click](javascript:alert(1))");
		expect(html).not.toContain("javascript:");
	});

	it("drops iframes, forms and inline styles", () => {
		const html = renderMarkdown(
			'<iframe src="https://example.invalid"></iframe>\n\n<form><input name="p"></form>\n\n<p style="position:fixed">x</p>',
		);
		expect(html).not.toContain("<iframe");
		expect(html).not.toContain("<form");
		expect(html).not.toContain("<input");
		expect(html).not.toContain("style=");
	});

	it("drops svg, which the html profile excludes", () => {
		const html = sanitize('<svg><use href="#x" /></svg>');
		expect(html).not.toContain("<svg");
	});

	it("hardens outbound links", () => {
		const html = renderMarkdown("[docs](https://example.invalid/x)");
		expect(html).toContain('target="_blank"');
		expect(html).toContain("noopener");
		expect(html).toContain("noreferrer");
	});

	it("leaves in-document anchors alone", () => {
		expect(renderMarkdown("[here](#section)")).not.toContain("target=");
	});

	it("keeps benign formatting", () => {
		const html = sanitize("<p><em>fine</em></p>");
		expect(html).toBe("<p><em>fine</em></p>");
	});
});

describe("highlightCode", () => {
	it("escapes when no language is given", () => {
		expect(highlightCode("<script>", undefined)).toBe("&lt;script&gt;");
	});

	it("escapes when the language is unknown", () => {
		expect(highlightCode("<script>", "not-a-language")).toBe("&lt;script&gt;");
	});

	it("highlights a known language", () => {
		expect(highlightCode("def f(): pass", "python")).toContain("hljs-keyword");
	});
});

describe("renderCode", () => {
	it("never emits live markup from hostile source text", () => {
		const html = renderCode('</code></pre><img src=x onerror="alert(1)">', "javascript");
		expect(html).not.toContain("onerror");
	});
});

describe("languageFromPath", () => {
	it("maps common extensions", () => {
		expect(languageFromPath("src/a/b.ts")).toBe("typescript");
		expect(languageFromPath("run.sh")).toBe("bash");
		expect(languageFromPath("data.yml")).toBe("yaml");
	});

	it("handles extensionless well-known names", () => {
		expect(languageFromPath("build/Dockerfile")).toBe("dockerfile");
	});

	it("returns undefined for anything else", () => {
		expect(languageFromPath("notes.unknownext")).toBeUndefined();
		expect(languageFromPath("LICENSE")).toBeUndefined();
	});
});
