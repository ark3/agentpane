---
labels: [defect]
---

# A generated image renders as `[image: image/png]` -- its mime type and nothing else -- because an assistant message cannot hold an image block, though the same data URL renders as a picture when a user sends it.

`src/server/adapters/codex/mapping.ts` (`blockAsAssistant` `:499`, the `imageGeneration` arm `:457-464`), against `@earendil-works/pi-ai`'s `AssistantMessage` (`types.d.ts:295-297`)

`imageGeneration` carries its image in `result`, usually a `data:` URL.
`imageFromUrl` decodes it into a real `ImageContent` with `data` and
`mimeType`, and then `blockAsAssistant` throws the data away:

```
return block.type === "text" ? block : { type: "text", text: `[image: ${block.mimeType}]` };
```

The constraint behind that is real and type-level. `UserMessage.content` is
`(TextContent | ImageContent)[]`; `AssistantMessage.content` is `(TextContent |
ThinkingContent | ToolCall)[]`. So the identical data URL is a picture in the
transcript when the user pastes it and the string `[image: image/png]` when the
model produces it. The bytes were decoded and are discarded at the last step.

This is not a mapping bug to be fixed in `mapping.ts` alone, which is why it is
its own item. `pi-ai` is types-only and vendored (D10), so the assistant
content union is not ours to widen. Whatever carries the image to the client is
a protocol question: a shape `src/shared/protocol.ts` defines, or an existing
message role that already admits an image.

Note the non-`data:` branch is a different and lesser problem: a path or http
result becomes `[image: /tmp/x.png]`, which at least names the thing. Only the
inline case loses everything, and it is the common one.

## Before building anything

**No capture exists.** Nothing in `resources/probes/capture_fixtures.py` drives
image generation, and `rg imageGeneration resources/fixtures/` is empty --
`result` being a `data:` URL is read off the vendored `ImageGenerationItem`,
not observed. The current behaviour is pinned by hand-built input in
`reducer.test.ts` ("maps imageGeneration's result through the image
reference", OW-sumevi), which asserts both branches. Deciding to render the
image for real means a capture first, per OW-72 -- a real one will settle
whether `result` is inline or a path in practice, and that changes which branch
matters.

## Done when

A generated image is visible in the transcript rather than described by its
mime type, or the decision not to do that is recorded in `docs/DESIGN.md` with
its reason and this item closes against that decision. The OW-sumevi assertion
changes with it -- it pins today's behaviour deliberately, so a change here
should make it fail and then be rewritten, not deleted.

Filed from OW-sumevi's close, which pinned the behaviour and flagged it.
