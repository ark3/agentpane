/**
 * Markdown parsing and -- mostly -- sanitization.
 *
 * D5 makes DOMPurify non-optional: the primary use case is rendering the
 * contents of repositories we do not control into a page that holds a channel
 * to an API that spawns processes. These are the cases that must never regress.
 */

import { describe, expect, it } from "vitest";
import { highlightCode, languageFromPath, renderCode, renderMarkdown, sanitize } from "./markdown.ts";

/**
 * Sanitization has to be asserted against the *parsed* result, not against the
 * string. `onerror` appearing in a string is not an event handler -- inside a
 * highlighted code block it is escaped source text, correctly displayed. The
 * question is only ever what the browser builds, so every check below parses
 * the html and interrogates the DOM.
 */
function parse(html: string): HTMLElement {
	const host = document.createElement("div");
	host.innerHTML = html;
	return host;
}

/** Everything about a parsed fragment that would mean sanitization failed. */
function liveThreats(html: string): string[] {
	const found: string[] = [];
	const banned = new Set([
		"SCRIPT",
		"IFRAME",
		"OBJECT",
		"EMBED",
		"FORM",
		"INPUT",
		"BUTTON",
		"TEXTAREA",
		"SELECT",
		"STYLE",
		"BASE",
		"META",
		"LINK",
		"SVG",
		"MATH",
	]);
	for (const el of parse(html).querySelectorAll("*")) {
		if (banned.has(el.tagName)) found.push(`<${el.tagName.toLowerCase()}>`);
		for (const attr of el.attributes) {
			if (/^on/i.test(attr.name)) found.push(`${el.tagName.toLowerCase()}[${attr.name}]`);
			if (attr.name === "style") found.push(`${el.tagName.toLowerCase()}[style]`);
			const scheme = /^\s*([a-z-]+):/i.exec(attr.value)?.[1]?.toLowerCase();
			// `data:` on a media `src` is DOMPurify's documented safe default (an
			// <img> never executes its payload); anywhere else it is a threat.
			const mediaSrc = attr.name === "src" && ["IMG", "VIDEO", "AUDIO", "SOURCE", "TRACK"].includes(el.tagName);
			if (scheme === "javascript" || scheme === "vbscript" || (scheme === "data" && !mediaSrc)) {
				found.push(`${el.tagName.toLowerCase()}[${attr.name}]=${scheme}:`);
			}
		}
	}
	return found;
}

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

/**
 * The hostile corpus. Every one of these is fed through the *real* pipeline
 * (markdown parse, then sanitize) and the result is parsed as HTML; the
 * assertion is that the browser builds nothing live from any of them.
 *
 * Ordinary XSS, protocol smuggling, mXSS (the namespace-confusion payloads
 * that broke sanitizers which only ran regexes over source), and the chrome
 * attacks that matter here specifically: a page-controlled <style>, <base> or
 * <form> can reposition or hijack our own UI, which is a channel to an API
 * that spawns processes (D5).
 */
const HOSTILE: [string, string][] = [
	["script tag", "<script>alert(1)</script>"],
	["script after prose", "before\n\n<script>alert(1)</script>\n\nafter"],
	["img onerror", '<img src="x" onerror="alert(1)">'],
	["img onerror, unquoted", "<img src=x onerror=alert(1)>"],
	["body onload via svg", "<svg/onload=alert(1)>"],
	["markdown javascript: link", "[click](javascript:alert(1))"],
	["markdown javascript: link, mixed case", "[click](JaVaScRiPt:alert(1))"],
	["entity-encoded javascript:", "[click](&#106;avascript:alert(1))"],
	["html-entity colon", '<a href="javascript&colon;alert(1)">x</a>'],
	["data: document in an href", '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>'],
	["onclick handler", '<p onclick="alert(1)">x</p>'],
	["onmouseover on an anchor", '<a href="#" onmouseover="alert(1)">x</a>'],
	["details ontoggle", '<details open ontoggle="alert(1)">x</details>'],
	["iframe srcdoc", '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
	["object with a javascript: data url", '<object data="javascript:alert(1)"></object>'],
	["embed", '<embed src="https://example.invalid/x">'],
	["form and input", '<form action="/api/x"><input name="a"></form>'],
	["style element", "<style>body{display:none}</style>"],
	["style attribute", '<div style="position:fixed;top:0">x</div>'],
	["base tag", '<base href="https://example.invalid/">'],
	["meta refresh", '<meta http-equiv="refresh" content="0;url=https://example.invalid">'],
	["link stylesheet", '<link rel="stylesheet" href="https://example.invalid/x.css">'],
	[
		"mXSS via mglyph namespace confusion",
		'<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img src=1 onerror=alert(1)&gt;">',
	],
	["mXSS via noscript", '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>'],
	["svg animate", "<svg><animate onbegin=alert(1) attributeName=x dur=1s></animate></svg>"],
	["template-wrapped script", "<template><script>alert(1)</script></template>"],
	["source onerror inside video", '<video><source onerror="alert(1)"></video>'],
	["srcset-style handler", '<img src="x" onload=alert(1)>'],
	["markup inside a fenced code block", "```html\n<img src=x onerror=alert(1)>\n```"],
	["markup inside inline code", "`<img src=x onerror=alert(1)>`"],
	["fenced block claiming a bogus language", "```<script>\n<img src=x onerror=alert(1)>\n```"],
	["image with a javascript: source", "![x](javascript:alert(1))"],
	["reference-style javascript: link", "[x][a]\n\n[a]: javascript:alert(1)"],
];

describe("sanitization", () => {
	it.each(HOSTILE)("neutralises %s", (_name, source) => {
		expect(liveThreats(renderMarkdown(source))).toEqual([]);
	});

	it.each(HOSTILE)("neutralises %s when it arrives as tool output", (_name, source) => {
		// The same corpus through the other entry point: `renderCode` is what
		// every tool card runs command output and file bodies through.
		expect(liveThreats(renderCode(source, "xml"))).toEqual([]);
	});

	it("drops script tags in raw HTML", () => {
		const html = renderMarkdown("before\n\n<script>alert(1)</script>\n\nafter");
		expect(parse(html).querySelector("script")).toBeNull();
		expect(parse(html).textContent).not.toContain("alert(1)");
	});

	it("drops event handler attributes but keeps the element", () => {
		const img = parse(renderMarkdown('<img src="x" onerror="alert(1)">')).querySelector("img");
		expect(img).not.toBeNull();
		expect(img?.getAttribute("onerror")).toBeNull();
	});

	it("drops javascript: hrefs but keeps the link text", () => {
		const anchor = parse(renderMarkdown("[click](javascript:alert(1))")).querySelector("a");
		expect(anchor?.getAttribute("href")).toBeNull();
		expect(anchor?.textContent).toBe("click");
	});

	it("drops svg, which the html profile excludes", () => {
		expect(parse(sanitize('<svg><use href="#x" /></svg>')).querySelector("svg")).toBeNull();
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

/**
 * OW-62: a markdown link whose href is a local path has nowhere to go --
 * agentpane is not a file viewer, and the SPA fallback would just reload the
 * app -- so it renders as an inline reference instead of an anchor. Both
 * directions are the contract: local paths must not be links, real web URLs
 * must still be, and no other scheme changes hands.
 */
describe("file references", () => {
	it.each([
		["a relative path with a line suffix", "[src/client/api.ts:35](src/client/api.ts:35)", "src/client/api.ts:35"],
		["a label collapsed to the file name", "[api.ts](src/client/api.ts:35)", "src/client/api.ts:35"],
		[
			"an absolute path with an #Lnn fragment",
			"[api.ts](/home/u/agentpane/src/client/api.ts#L35)",
			"/home/u/agentpane/src/client/api.ts#L35",
		],
		["a file: url", "[a](file:///home/u/a.ts)", "file:///home/u/a.ts"],
	])("renders %s as a non-link reference that keeps the location visible", (_name, source, shown) => {
		const host = parse(renderMarkdown(source));
		expect(host.querySelector("a")).toBeNull();
		const ref = host.querySelector(".ap-file-ref");
		expect(ref?.textContent).toBe(shown);
		expect(ref?.getAttribute("href")).toBeNull();
	});

	it("leaves a real web url a hardened link", () => {
		const host = parse(renderMarkdown("[docs](https://example.invalid/x)"));
		expect(host.querySelector(".ap-file-ref")).toBeNull();
		const anchor = host.querySelector("a");
		expect(anchor?.getAttribute("href")).toBe("https://example.invalid/x");
		expect(anchor?.getAttribute("target")).toBe("_blank");
	});

	it("claims neither in-document nor hostile hrefs", () => {
		// `#section` is a working link; `javascript:` must stay DOMPurify's
		// problem rather than becoming a reference span behind its back.
		const inDoc = parse(renderMarkdown("[here](#section)"));
		expect(inDoc.querySelector(".ap-file-ref")).toBeNull();
		expect(inDoc.querySelector("a")?.getAttribute("href")).toBe("#section");

		const hostile = parse(renderMarkdown("[click](javascript:alert(1))"));
		expect(hostile.querySelector(".ap-file-ref")).toBeNull();
		expect(hostile.querySelector("a")).not.toBeNull();
	});
});

/**
 * OW-holabo: remote media must not fetch itself.
 *
 * DOMPurify is not the control here -- it strips `onerror` and every script
 * vector, and none of these are XSS. The problem is the *automatic outbound
 * request*: a transcript from a repository we do not control could name a host
 * of its author's choosing and learn the reader's IP address and the moment
 * they opened it, with nothing clicked. D5 answers that by refusing to load
 * remote media at all: it renders as a link instead.
 */

/** Every attribute in a fragment that would make the browser fetch a remote URL. */
function remoteFetches(html: string): string[] {
	const found: string[] = [];
	for (const el of parse(html).querySelectorAll("img, video, audio, source, track, picture")) {
		for (const attr of el.attributes) {
			if (!["src", "srcset", "poster"].includes(attr.name)) continue;
			for (const candidate of attr.value.split(",")) {
				const url = candidate.trim().split(/\s+/)[0] ?? "";
				if (/^\/\//.test(url) || /^[a-z][a-z0-9+.-]*:/i.test(url.replace(/^data:.*/i, ""))) {
					found.push(`${el.tagName.toLowerCase()}[${attr.name}]=${url}`);
				}
			}
		}
	}
	return found;
}

describe("remote media", () => {
	it.each([
		["a markdown image", "![](https://example.invalid/x.png)"],
		["a markdown image with alt text", "![a chart](https://example.invalid/x.png)"],
		["raw html img", '<img src="https://example.invalid/z.png">'],
		["an img srcset", '<img srcset="https://example.invalid/a.png 1x, https://example.invalid/b.png 2x">'],
		["a video with a poster", '<video src="https://example.invalid/v.mp4" poster="https://example.invalid/p.png">'],
		["an audio element", '<audio src="https://example.invalid/a.mp3">'],
		["a picture source", '<picture><source srcset="https://example.invalid/s.png"></picture>'],
		["a protocol-relative image", '<img src="//example.invalid/x.png">'],
		["an http image", "![](http://example.invalid/x.png)"],
	])("makes no outbound request for %s", (_name, source) => {
		expect(remoteFetches(renderMarkdown(source))).toEqual([]);
	});

	it("renders a remote image as a link to it", () => {
		const host = parse(renderMarkdown("![](https://example.invalid/x.png)"));
		expect(host.querySelector("img")).toBeNull();
		const anchor = host.querySelector("a");
		expect(anchor?.getAttribute("href")).toBe("https://example.invalid/x.png");
		// No alt text to stand in for the image, so the destination is the label.
		expect(anchor?.textContent).toBe("https://example.invalid/x.png");
	});

	it("uses the alt text as the link text, keeping the url reachable", () => {
		const anchor = parse(renderMarkdown("![a chart](https://example.invalid/x.png)")).querySelector("a");
		expect(anchor?.textContent).toBe("a chart");
		expect(anchor?.getAttribute("title")).toBe("https://example.invalid/x.png");
	});

	it("says what the media was, so an unlabelled image does not read as a bare link", () => {
		const kinds = (source: string) =>
			[...parse(renderMarkdown(source)).querySelectorAll(".ap-remote-media")].map((e) =>
				e.getAttribute("data-media"),
			);
		expect(kinds("![](https://example.invalid/x.png)")).toEqual(["image"]);
		expect(kinds('<video src="https://example.invalid/v.mp4">')).toEqual(["video"]);
		expect(kinds('<audio src="https://example.invalid/a.mp3">')).toEqual(["audio"]);
	});

	it("keeps every url a video would have fetched, poster included", () => {
		const hrefs = [
			...parse(
				renderMarkdown('<video src="https://example.invalid/v.mp4" poster="https://example.invalid/p.png">'),
			).querySelectorAll("a"),
		].map((a) => a.getAttribute("href"));
		expect(hrefs).toEqual(["https://example.invalid/v.mp4", "https://example.invalid/p.png"]);
	});

	it("keeps every srcset candidate", () => {
		const hrefs = [
			...parse(
				renderMarkdown('<img srcset="https://example.invalid/a.png 1x, https://example.invalid/b.png 2x">'),
			).querySelectorAll("a"),
		].map((a) => a.getAttribute("href"));
		expect(hrefs).toEqual(["https://example.invalid/a.png", "https://example.invalid/b.png"]);
	});

	it("keeps the fallback content the author wrote inside the element", () => {
		const host = parse(renderMarkdown('<video src="https://example.invalid/v.mp4">no video <b>here</b></video>'));
		expect(host.querySelector(".ap-remote-media b")?.textContent).toBe("here");
		expect(host.textContent).toContain("no video");
	});

	it("keeps a data: sibling an image while linking the remote one", () => {
		const host = parse(
			renderMarkdown(
				'<picture><source srcset="https://example.invalid/s.png"><img src="data:image/gif;base64,R0lGODlh" alt="d"></picture>',
			),
		);
		expect(host.querySelector("a")?.getAttribute("href")).toBe("https://example.invalid/s.png");
		expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/gif;base64,R0lGODlh");
	});

	it("hardens the links it creates like any other outbound link", () => {
		const anchor = parse(renderMarkdown("![](https://example.invalid/x.png)")).querySelector("a");
		expect(anchor?.getAttribute("target")).toBe("_blank");
		expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
	});

	it("keeps a data: image an image -- it has no network side", () => {
		const src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
		const img = parse(renderMarkdown(`![dot](${src})`)).querySelector("img");
		expect(img?.getAttribute("src")).toBe(src);
	});

	it("keeps a same-origin image an image", () => {
		const img = parse(renderMarkdown("![logo](/assets/logo.png)")).querySelector("img");
		expect(img?.getAttribute("src")).toBe("/assets/logo.png");
		expect(parse(renderMarkdown('<img src="assets/logo.png">')).querySelector("img")).not.toBeNull();
	});

	it("leaves ordinary links exactly as they were", () => {
		const host = parse(renderMarkdown("[docs](https://example.invalid/x)"));
		expect(host.querySelector(".ap-remote-media")).toBeNull();
		const anchor = host.querySelector("a");
		expect(anchor?.getAttribute("href")).toBe("https://example.invalid/x");
		expect(anchor?.getAttribute("target")).toBe("_blank");
		expect(anchor?.textContent).toBe("docs");
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
	/**
	 * Round-tripping the text is the actual contract: highlighting must be
	 * purely additive. An escaped `onerror=` shown as source is *correct*
	 * output, so the check is that nothing but `<span>` survives and the
	 * displayed characters are exactly the ones the agent produced.
	 */
	it.each([
		['</code></pre><img src=x onerror="alert(1)">', "javascript"],
		["<!-- a comment -->", "javascript"],
		["</span></span>", "xml"],
		["const s = '</script>';", "javascript"],
		["#!/bin/bash\necho '<img src=x onerror=alert(1)>'", "bash"],
		['{"a": "<script>"}', "json"],
		["a & b < c > d \" e ' f", "typescript"],
		["  indented\n\ttabbed", undefined],
		["line1\n\n\nline4", "python"],
		["\n", "javascript"],
	] as [string, string | undefined][])("displays %j verbatim and adds only spans", (source, lang) => {
		const host = parse(renderCode(source, lang));
		expect(host.textContent).toBe(source);
		expect([...host.querySelectorAll("*")].map((e) => e.tagName)).toEqual(
			[...host.querySelectorAll("*")].map(() => "SPAN"),
		);
		expect(liveThreats(renderCode(source, lang))).toEqual([]);
	});

	it("escapes markup even when the highlighter is not involved", () => {
		expect(parse(renderCode("<img src=x onerror=alert(1)>")).querySelector("img")).toBeNull();
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
