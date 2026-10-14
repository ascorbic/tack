import {
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { LONG_PRESS_MS, movedTooFar } from "../touch/gestures.ts";
import { placeTip } from "./placement.ts";
import "./reactions.css";

// The tooltip naming who reacted, for stamps on shapes and the reaction
// count on cards: Tack's tooltip (dark on light, light on dark, 12px), but
// drawn over everything in a portal, so a neighbouring shape never covers it
// and it keeps its size whatever the zoom. It follows its pill as the board
// pans.
//
// - A mouse or pen: hover, after a short beat.
// - The keyboard: focus. Pills name the people in their accessible name too.
// - A finger: long-press (a tap toggles a stamp). Where a tap does nothing
//   else (a card's count), a tap opens it. It stays until you tap elsewhere.

type Opened = "hover" | "focus" | "pinned" | null;

export interface Tip {
	open: boolean;
	ref: RefObject<HTMLElement | null>;
	/** For the pill: spread onto it. */
	handlers: {
		onPointerEnter: (event: ReactPointerEvent) => void;
		onPointerLeave: (event: ReactPointerEvent) => void;
		onPointerDown: (event: ReactPointerEvent) => void;
		onPointerMove: (event: ReactPointerEvent) => void;
		onPointerUp: () => void;
		onPointerCancel: () => void;
		onFocus: (event: React.FocusEvent) => void;
		onBlur: () => void;
		onKeyDown: (event: React.KeyboardEvent) => void;
		onContextMenu: (event: React.MouseEvent) => void;
	};
	/**
	 * Call first in the pill's click handler: true when the click was a
	 * long-press's (or a tap that opened the tip), and is spent.
	 */
	tookClick: (event: React.MouseEvent) => boolean;
	id: string;
}

/**
 * Hover, focus and touch for a pill with a tooltip. With `tapOpens`, a
 * finger's tap opens it (for pills a tap does nothing else on).
 */
export function useTip({ tapOpens = false }: { tapOpens?: boolean } = {}): Tip {
	const [opened, setOpened] = useState<Opened>(null);
	const ref = useRef<HTMLElement | null>(null);
	const press = useRef<{ timer: number; x: number; y: number } | null>(null);
	const swallow = useRef(false);
	const pointer = useRef("mouse");
	const id = useId();

	const cancelPress = useCallback(() => {
		if (press.current) clearTimeout(press.current.timer);
		press.current = null;
	}, []);
	useEffect(() => cancelPress, [cancelPress]);

	// Pinned by a finger: a tap anywhere else, or Escape, puts it away.
	useEffect(() => {
		if (opened !== "pinned") return;
		const away = (event: PointerEvent) => {
			if (!ref.current?.contains(event.target as Node)) setOpened(null);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpened(null);
		};
		document.addEventListener("pointerdown", away, true);
		document.addEventListener("keydown", escape, true);
		return () => {
			document.removeEventListener("pointerdown", away, true);
			document.removeEventListener("keydown", escape, true);
		};
	}, [opened]);

	const handlers: Tip["handlers"] = {
		onPointerEnter(event) {
			pointer.current = event.pointerType;
			if (event.pointerType !== "touch") setOpened((now) => now ?? "hover");
		},
		onPointerLeave(event) {
			if (event.pointerType !== "touch") setOpened((now) => (now === "hover" ? null : now));
		},
		onPointerDown(event) {
			pointer.current = event.pointerType;
			if (event.pointerType !== "touch") return;
			cancelPress();
			const { clientX: x, clientY: y } = event;
			press.current = {
				x,
				y,
				timer: window.setTimeout(() => {
					press.current = null;
					swallow.current = true;
					setOpened("pinned");
				}, LONG_PRESS_MS),
			};
		},
		onPointerMove(event) {
			const start = press.current;
			if (start && movedTooFar(start, { x: event.clientX, y: event.clientY })) cancelPress();
		},
		onPointerUp: cancelPress,
		onPointerCancel: cancelPress,
		onFocus(event) {
			// The keyboard's focus, not a click's.
			if ((event.currentTarget as HTMLElement).matches(":focus-visible")) {
				setOpened((now) => now ?? "focus");
			}
		},
		onBlur() {
			setOpened((now) => (now === "pinned" ? now : null));
		},
		onKeyDown(event) {
			if (event.key === "Escape" && opened) {
				event.stopPropagation();
				setOpened(null);
			}
		},
		onContextMenu(event) {
			// A long-press is ours, not the browser's menu.
			if (pointer.current === "touch") event.preventDefault();
		},
	};

	const tookClick = (event: React.MouseEvent) => {
		if (swallow.current) {
			swallow.current = false;
			event.preventDefault();
			event.stopPropagation();
			return true;
		}
		if (tapOpens && pointer.current === "touch") {
			event.stopPropagation();
			setOpened((now) => (now === "pinned" ? null : "pinned"));
			return true;
		}
		return false;
	};

	return { open: opened !== null, ref, handlers, tookClick, id };
}

/**
 * The tooltip itself, centred on its pill on the side it prefers, within
 * the board (or the window, off the board), drawn over everything. `force`
 * shows it without hovering, for the gallery and screenshots.
 */
export function ReactionTip({
	tip,
	children,
	force = false,
	prefer = "above",
}: {
	tip: Tip;
	children: ReactNode;
	force?: boolean;
	prefer?: "above" | "below";
}) {
	const box = useRef<HTMLDivElement>(null);
	const open = tip.open || force;
	useLayoutEffect(() => {
		if (!open) return;
		let frame = 0;
		const place = () => {
			const anchor = tip.ref.current;
			const el = box.current;
			if (anchor && el) {
				const at = anchor.getBoundingClientRect();
				// Within the board, so it never covers the top bar; off it, the window.
				const board = anchor.closest(".react-flow")?.getBoundingClientRect();
				const bounds = {
					left: Math.max(0, board?.left ?? 0),
					top: Math.max(0, board?.top ?? 0),
					right: Math.min(window.innerWidth, board?.right ?? window.innerWidth),
					bottom: Math.min(window.innerHeight, board?.bottom ?? window.innerHeight),
				};
				const { left, top, side } = placeTip(
					at,
					{ width: el.offsetWidth, height: el.offsetHeight },
					bounds,
					prefer,
				);
				el.style.transform = `translate(${left}px, ${top}px)`;
				el.dataset.side = side;
				// Gone with its pill (scrolled away, or the shape deleted).
				el.style.visibility = anchor.isConnected && at.width > 0 ? "" : "hidden";
			}
			frame = requestAnimationFrame(place);
		};
		place();
		return () => cancelAnimationFrame(frame);
	}, [open, tip.ref, prefer]);
	if (!open || typeof document === "undefined") return null;
	return createPortal(
		<div ref={box} className="reaction-tip" role="tooltip" id={tip.id} data-side="above">
			<div className="reaction-tip-body" data-instant={force || undefined}>
				{children}
			</div>
		</div>,
		document.body,
	);
}

/** One line of a tip: an emoji, then who. */
export function TipLine({
	emoji,
	children,
	oneLine = false,
}: {
	emoji: string;
	children: ReactNode;
	/** Keep to one line (the phrase was shortened to fit). */
	oneLine?: boolean;
}) {
	return (
		<span className="reaction-tip-line" data-one-line={oneLine || undefined}>
			<span className="reaction-tip-emoji" aria-hidden="true">
				{emoji}
			</span>
			<span className="reaction-tip-names">{children}</span>
		</span>
	);
}
