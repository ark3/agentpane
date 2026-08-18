---
kind: defect
where: '`src/client/app.css` (`.tools-menu`, `.tools-menu-list`, `.tools-menu-list button` — lines 234, 236, 238; the token block, lines 18-40)'
---

# The tools menu asks for `--ap-radius-1` and `--ap-shadow-1`, neither of which is defined, so its corners have been square since OW-72.

Found while landing OW-80 and left untouched there — the swap from `<details>`
to a popover preserved the declarations verbatim rather than "fixing" adjacent
code. Audited across the whole stylesheet, not just the block that was being
edited: of 29 custom properties used, exactly two are never defined, and all
four of their uses are in the tools-menu rules.

- `--ap-radius-1`, used at lines 234, 236 and 238, **with no fallback**. The
  radius tokens are `--ap-radius-sm` (4px), `-md` (7px) and `-lg` (11px), so
  `border-radius: var(--ap-radius-1)` resolves to the initial value and the
  trigger, the list and the entries all render square. Visible today.
- `--ap-shadow-1`, used once at line 236, **with a literal fallback**
  (`0 4px 12px rgba(0,0,0,0.3)`), so the list does have a drop shadow — but the
  shadow is a hardcoded value that no other rule shares and no token controls.

The spacing tokens the same rules use (`--ap-space-1`, `-2`) *are* defined; this
is not a general token-naming drift, it is these two names.

Incidental: which radius the menu should take (`-sm` matches the buttons at
line 146, `-md` matches `.conversation`). Load-bearing: no rule references a
token that does not exist, and if the shadow is meant to be a token it is
defined next to the other tokens rather than inlined at one call site.

## Done when

`rg 'var\(--ap-' src/client/app.css` names only properties the token block
defines — the audit is a five-line script over the file, not a reading — and the
menu's corners are visibly rounded in the browser. `bun run check` green; no new
test, since this is a value that no test asserts and `svelte-check` does not
resolve custom properties.
