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
	// A modal dialog takes focus as it opens, whatever's asked: give it back
	// to whatever had it on the page around, unless it was here already.
	const showModal = Reflect.get(
		HTMLDialogElement.prototype,
		"showModal",
	) as HTMLDialogElement["showModal"];
	HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
		const here = document.hasFocus();
		const host = here ? null : frameElement;
		const before = host?.ownerDocument.activeElement ?? null;
		showModal.call(this);
		if (!host || !before) return;
		if (before === host || before === host.ownerDocument.body) {
			(host as HTMLElement).blur();
		} else if ("focus" in before) {
			(before as HTMLElement).focus({ preventScroll: true });
		}
	};
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
