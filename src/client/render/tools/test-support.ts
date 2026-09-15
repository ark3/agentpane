import { flushSync } from "svelte";

/**
 * Open every tool card in a rendered tree, the way a reader does.
 *
 * A collapsed card no longer builds its body (OW-lisaye), so a test that
 * asserts on body content has to open the card first. jsdom fires no `toggle`
 * of its own when `open` is set from script, so the event is dispatched here --
 * it is what `ToolCard` listens to, and a native disclosure would fire it.
 */
export function openToolCards(scope: ParentNode): void {
	flushSync(() => {
		for (const card of scope.querySelectorAll("details.tool")) {
			(card as HTMLDetailsElement).open = true;
			card.dispatchEvent(new Event("toggle"));
		}
	});
}
