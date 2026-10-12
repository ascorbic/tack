// An embed in someone else's page mustn't move that page. Focusing an
// element in a frame, or scrolling one into view, scrolls every page around
// it to show it, and focusing takes the reader's keyboard away from the
// page they're reading. The board does both as its panels and dialogs open
// (a field that's ready to type in, a change scrolled to), and the director
// opens them while nobody's using the board. So, in a frame: nothing takes
// focus unless the frame has it already (someone's clicked or tabbed in),
// and then without scrolling anything outside it; and scrolling something
// into view only scrolls what's inside the frame.

/** The nearest box inside the frame that scrolls `element`'s way. */
function scroller(element: Element): HTMLElement | null {
	for (let parent = element.parentElement; parent; parent = parent.parentElement) {
		const { overflowY, overflowX } = getComputedStyle(parent);
		const scrolls = (overflow: string) => overflow === "auto" || overflow === "scroll";
		if (
			(scrolls(overflowY) && parent.scrollHeight > parent.clientHeight) ||
			(scrolls(overflowX) && parent.scrollWidth > parent.clientWidth)
		) {
			return parent;
		}
	}
	return null;
}

/** Bring `element` into view in the box that scrolls it, and nowhere else. */
export function scrollWithin(element: Element): void {
	const box = scroller(element);
	if (!box) return;
	const inner = element.getBoundingClientRect();
	const outer = box.getBoundingClientRect();
	if (inner.top < outer.top) box.scrollTop -= outer.top - inner.top;
	else if (inner.bottom > outer.bottom) box.scrollTop += inner.bottom - outer.bottom;
	if (inner.left < outer.left) box.scrollLeft -= outer.left - inner.left;
	else if (inner.right > outer.right) box.scrollLeft += inner.right - outer.right;
}

/**
 * Focus came into this frame without anyone coming in: give it back to
 * what had it on the page around (`before`, read just before), or to that
 * page itself.
 */
function giveFocusBack(host: Element | null, before: Element | null): void {
	(document.activeElement as HTMLElement | null)?.blur();
	const page = host?.ownerDocument;
	if (before && page && before !== host && before !== page.body && "focus" in before) {
		(before as HTMLElement).focus({ preventScroll: true });
		return;
	}
	// Blurring the frame's element is enough for Chromium; Safari only lets
	// go of a frame when another one's focused, and focusing a window
	// doesn't scroll it (and works across origins).
	(host as HTMLElement | null)?.blur();
	if (document.hasFocus()) window.parent.focus();
}

/** Keep the page around this frame where its reader left it. Only in a frame. */
export function keepThePageStill(): void {
	if (window.parent === window) return;
	const focus = Reflect.get(HTMLElement.prototype, "focus") as HTMLElement["focus"];
	HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
		if (!document.hasFocus()) return;
		focus.call(this, { ...options, preventScroll: true });
	};
	const focusSvg = Reflect.get(SVGElement.prototype, "focus") as SVGElement["focus"];
	SVGElement.prototype.focus = function (this: SVGElement, options?: FocusOptions) {
		if (!document.hasFocus()) return;
		focusSvg.call(this, { ...options, preventScroll: true });
	};
	// A dialog takes focus as it opens (its focusing steps, run by the browser
	// rather than through `focus()`), and in Safari that focuses the frame
	// itself, after which `hasFocus()` says yes and everything else may too.
	// So while one opens in a frame nobody's in, nothing in it can take focus;
	// and should focus get in anyway, it goes back to the page around.
	for (const name of ["showModal", "show"] as const) {
		const open = Reflect.get(HTMLDialogElement.prototype, name) as HTMLDialogElement["show"];
		HTMLDialogElement.prototype[name] = function (this: HTMLDialogElement) {
			if (document.hasFocus()) return open.call(this);
			const host = frameElement;
			const before = host?.ownerDocument.activeElement ?? null;
			const inert = this.inert;
			this.inert = true;
			try {
				open.call(this);
			} finally {
				this.inert = inert;
			}
			if (document.hasFocus()) giveFocusBack(host, before);
		};
	}
	// Hidden overflow still scrolls for focus and dialogs: the frame's page
	// stays where it is, whatever asks it to move.
	addEventListener("scroll", () => {
		if (scrollX !== 0 || scrollY !== 0) scrollTo(0, 0);
	});
	Element.prototype.scrollIntoView = function (this: Element) {
		scrollWithin(this);
	};
	// Not with the browser's own: React's and the board's ask for it by name.
	(Element.prototype as Element & { scrollIntoViewIfNeeded?: () => void }).scrollIntoViewIfNeeded =
		function (this: Element) {
			scrollWithin(this);
		};
}
