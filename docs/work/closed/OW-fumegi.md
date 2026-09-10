---
labels: [defect, now]
closed: done
---

# A cross-site page can attach and spawn agents through GET routes, because the origin check trusts a missing `Origin` and a Pi id is opened wherever it points

Two halves of one exposure, found by a cold read on 2026-09-09 and reproduced the same day in headless Chromium.

## The origin half

`src/server/http/app.ts`, `isLoopbackOrigin`: the docblock says a request with no `Origin` is "not something a page can forge, since browsers always attach it cross-origin", and the function returns true for `null`.
That premise is false.
Browsers attach `Origin` to CORS-mode requests and to non-GET methods; a cross-site `<img src>`, `<iframe src>`, `<link>`, `window.open`, or `fetch(..., {mode: "no-cors"})` GET arrives with no `Origin` at all.
Reproduced with Playwright's bundled Chromium, a page served from `http://localhost:4798` and a logging target on `http://127.0.0.1:4799`:

    GET /api/sessions/pi/img          origin=null  sec-fetch-site=cross-site  sec-fetch-mode=no-cors  sec-fetch-dest=image
    GET /api/sessions/pi/fetch-nocors origin=null  sec-fetch-site=cross-site  sec-fetch-mode=no-cors
    POST /api/sessions/pi/post        origin=http://localhost:4798  sec-fetch-site=cross-site
    GET typed into the address bar    origin=null  sec-fetch-site=none        sec-fetch-mode=navigate

So the check holds for POST and for CORS fetches, which is what its test suite exercises, and does not hold for the simple GETs.
The GETs that matter are `sessionRoute` ("GET is 'open this session': spawn if needed") and the `fork-points` case in the same file, both of which call `sessions.attach`.
Any web page the user has open can therefore make this server spawn a sandboxed agent, blind: it cannot read the reply, and it does not need to.
The test that pins the wrong invariant is `src/server/http/app.test.ts`, "allows a request with no Origin, which no page can produce".

`Sec-Fetch-Site` is the discriminator the reproduction shows: every current browser sends it, curl does not, and the legitimate client is `same-origin` both in production and through the Vite proxy in dev, which forwards the browser's headers.
Reject an `/api` request whose `Sec-Fetch-Site` is present and is neither `same-origin` nor `none`, keeping the `Origin` rule as it is for the requests that carry one.
Making attach a POST would also close the spawn path but leaves `/preview` and every other GET open to the same driving; the header check covers them all.

## The Pi id half

D9 makes a Pi session's id its JSONL path, and nothing confines that path to the Pi store.
`src/server/sessions/index.ts`, `getSession`, the `pi` branch: `loadOne(ref.id, parsePiSession)` on the id exactly as the URL carried it.
`src/server/sessions/preview.ts`, the `pi` branch of the preview reader: `readPiTurns(ref.id)`, likewise.
`parsePiSession` in `sessions/pi.ts` takes `cwd` from a top-level field on the first line and tolerates any file, so any readable JSONL with a `cwd` header passes; a Claude Code store file qualifies.
The manager then spawns `direnv exec <that cwd> sbox -- pi --mode rpc --session <that file>` (`src/server/adapters/pi/spawn.ts`, `buildPiSpawnCommand`).
`SESSION_ROOTS.pi` in `sessions/index.ts` is the root the id must live under; resolve the id with `realpath` and reject anything outside it, in the index rather than in each caller, so the preview route and the attach route agree.
Whether Pi itself does anything useful with a non-Pi file was not verified and does not matter: the spawn with an attacker-chosen `cwd` is the defect.

## Done when

- A test in `app.test.ts` sends a GET to the attach route with no `Origin` and `Sec-Fetch-Site: cross-site`, and asserts a rejection with no attach; it must fail before the change.
  A sibling asserts `Sec-Fetch-Site: same-origin` and the header's absence both still pass.
- The "no page can produce" test is rewritten to say what is now true.
- A test in `src/server/sessions/index.test.ts` asks `getSession` for a `pi` ref pointing at a file outside `SESSION_ROOTS.pi` and gets `null`; it must fail before the change.
- The `isLoopbackOrigin` docblock and D8 in `docs/DESIGN.md` no longer say a page cannot omit `Origin`; the reproduction above is the evidence to cite.

Closed OW-2 mentions the origin check only in passing; D8's own text is the prior art.

## Close note

The API now rejects browser requests whose `Sec-Fetch-Site` is present and is neither `same-origin` nor `none`, while preserving loopback-Origin checks, headerless non-browser clients, and static routes.
Pi session attach and preview now resolve requested files beneath the configured Pi store, reject traversal and symlink escapes, and pass the canonical path through adapter creation and resume.
SessionManager arbitrates canonical aliases across concurrent startup and disposal windows so alternate path spellings cannot duplicate or orphan an adapter.
The 2026-09-09 Chromium reproduction is recorded in `docs/MANUAL_TESTING.md`, and D8 no longer claims that cross-site pages cannot omit `Origin`.
Both original security regressions and the canonical startup/disposal races were observed red before their fixes.
Verified with `bun run check`: zero TypeScript or Svelte diagnostics, 48 test files passed, and 982 tests passed.
