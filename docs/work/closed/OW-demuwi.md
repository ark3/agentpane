---
kind: change
where: '`resources/fixtures/`, and a new test beside `src/import-boundaries.test.ts`'
---

# The fixture scrub is enforced only by a README asking you to grep, so nothing catches the next leak.

`eaa5152` added the rule to both `resources/fixtures/README.md` ("Scrubbed
values") and `resources/probes/README.md`: a scrub keyed on JSON field names
protects only the fields you named, so grep a generated fixture for the
operator's identifiers before committing it. The rule exists because a Codex
fork capture carried the operator's home path and private `SKILL.md` list in
message text and in the `host_skills` block, past `SCRUB_KEYS` and into a
commit — caught in review, not by anything automatic (OW-mewiga's close note).

A rule that only a README asks for is enforced by whoever remembers to read it.
`AGENTS.md` names the alternative this repo already uses: `import-boundaries`
"fails the build and names your file". Make this the same — a test in the same
slot, `src/*.{test,spec}.ts`, which `vite.config.ts` puts in the `server`
project with a node environment and so can read `resources/` at runtime
(`tsconfig.json` excludes `resources` from typechecking only, which does not
affect a runtime read).

## What is already true

Verified 2026-08-18: the committed fixtures are clean. `/home/` and the
operator's username both return zero hits across `resources/fixtures/*/`, and
`fork.jsonl` carries the `[operator skills manifest scrubbed ...]` placeholder,
so `fork_probe.py`'s `scrub_content` did its job. This lands green and stays
green, which is exactly why it has to be shown to fail first.

## The trap that decides the design

Do not scan for bare identifier tokens taken from the environment. This
machine's hostname is `may`: it matches 55 times inside
`resources/fixtures/codex/fork.jsonl`, all of them the English modal verb in
`payload.base_instructions.text` — Codex's own 14.7k-character vendor system
prompt, which is legitimately captured and must stay. Word boundaries do not
separate the two. `$USER` has the same hazard on a machine whose username is a
word.

So prefer shapes that cannot occur in prose. An absolute `/home/` path is the
high-value one: unambiguous, zero hits today, and precisely what leaked.
Whether username and hostname are worth including at all given the false
positives, and whether identifiers come from the running environment (which
differs on the work laptop) or from a fixed list of shapes, is the executor's
call — say which was chosen and why in the docblock.

Scan the data files only: `*.jsonl` and `*.meta.json`. The README beside them
legitimately contains `SKILL.md` and quotes the leak it is warning about, and a
scan over the whole directory flags it.

## Done looks like

`bun run check` goes red, naming the offending fixture, when a line containing
a `/home/<user>/.../SKILL.md` path is planted in one — then green when it is
removed. Show that transition; a guard that has only ever been green has not
been shown to guard anything.

**Fixed** in 2504889: `src/fixture-scrub.test.ts` sits in the same slot as
`import-boundaries.test.ts`, so `bun run check` fails and names file, line and
column when any committed `.jsonl` or `.meta.json` under `resources/fixtures/`
carries a `/home/`, `/Users/` or `/root/` path. Shown red twice, by two people
and in two different fixtures: the executor planted a `SKILL.md` path in
`codex/fork.jsonl:53:91`, and the session agent independently planted one in
`pi/text.jsonl:15:80` — each named its own file, and each went green on restore.
The shapes are a fixed list, not identifiers read from the environment: the
item's `may` trap is real and worse than recorded, 113 matches across the
fixtures, all of them the English modal verb in Codex's captured vendor prompt.
Fixed shapes also keep the guard meaning the same on both clones. Username and
hostname are deliberately **not** scanned, and both READMEs now say so, so the
human grep for those is still asked for rather than silently assumed covered.
