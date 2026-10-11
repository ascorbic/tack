import { type RefCallback, type RefObject, useCallback, useRef } from "react";

// Small accessibility helpers shared across the client (see
// docs/accessibility.md).

const FOCUSABLE =
	"a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

/**
 * A ref for a region that scrolls: while its content overflows and nothing in
 * it can take focus, it takes focus itself (tabindex 0), so keyboard users
 * can scroll it with the arrow keys. Regions with buttons or links in them
 * are left alone, as those already reach every part. Pass `forward` to keep
 * a ref of your own.
 */
export function useScrollFocusable<T extends HTMLElement>(
	forward?: RefObject<T | null>,
): RefCallback<T> {
	const cleanup = useRef<(() => void) | null>(null);
	return useCallback(
		(el: T | null) => {
			cleanup.current?.();
			cleanup.current = null;
			if (forward) forward.current = el;
			if (!el) return;
			const update = () => {
				const scrolls =
					el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
				const needs = scrolls && !el.querySelector(FOCUSABLE);
				if (needs) el.tabIndex = 0;
				else el.removeAttribute("tabindex");
			};
			// The region's own size, and its contents' (which grow inside it as
			// fonts load and data arrives, without it changing size).
			const resize = new ResizeObserver(update);
			const observe = () => {
				resize.disconnect();
				resize.observe(el);
				for (const child of el.children) resize.observe(child);
			};
			observe();
			update();
			const mutations = new MutationObserver(() => {
				observe();
				update();
			});
			mutations.observe(el, { childList: true, subtree: true });
			cleanup.current = () => {
				resize.disconnect();
				mutations.disconnect();
			};
		},
		[forward],
	);
}
