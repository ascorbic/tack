import {
	type ReactNode,
	createContext,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import { isApplePlatform } from "../shortcuts.ts";
import { type Box, type Side, placePopover } from "./popoverPlacement.ts";
import "./actions.css";

// A small panel that opens from the action bar (or a connector's toolbar)
// and stays attached to it as the board moves. It's a dialog, so board
// shortcuts leave its keys alone (see keys.ts); Escape and clicking away
// close it. It opens below its bar, or above when there's no room, within
// the visible canvas and clear of the chrome fixed over it (the minimap, the
// zoom controls, the tool dock: `CHROME`), shifting sideways or flipping to
// get clear (popoverPlacement.ts). It keeps clear as its contents grow, and
// as its bar moves on its own (the selection's bar, which follows the board
// and is pinned to the edge of the view when it must be: `BarAnchor`).

const DOCK = 84;
const HEADER = 56;

/** Chrome fixed over the canvas that popovers (and the selection's bar) keep clear of. */
export const CHROME =
	".react-flow__panel, .toolbar-dock, [data-chrome], .facilitation-dock > *, .follow-pill, .spotlight-pill";

/**
 * The bar a popover opens from, when it moves on its own (SelectionBar.tsx):
 * which side of it to open on, where it is (or is gliding to) on screen, and
 * which edge it's at (its side of the selection, or the view's edge it's
 * pinned to), whose changing lets the popover change sides too.
 */
export interface BarAnchor {
	side: Side;
	rect: Box;
	edge: string;
}

export const BarAnchorContext = createContext<BarAnchor | null>(null);

const boxOf = (rect: DOMRect | Box): Box => ({
	left: rect.left,
	top: rect.top,
	right: rect.right,
	bottom: rect.bottom,
});

/** Where a popover can go on screen, and what's fixed over that area. */
function surroundings(el: HTMLElement, bar: HTMLElement): { bounds: Box; obstacles: Box[] } {
	const screen = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
	const flow = bar.closest<HTMLElement>(".react-flow");
	// Not on a board (the gallery): leave room for a board's header and dock.
	if (!flow)
		return { bounds: { ...screen, top: HEADER, bottom: screen.bottom - DOCK }, obstacles: [] };
	const canvas = flow.getBoundingClientRect();
	const bounds = {
		left: Math.max(screen.left, canvas.left),
		top: Math.max(screen.top, canvas.top),
		right: Math.min(screen.right, canvas.right),
		bottom: Math.min(screen.bottom, canvas.bottom),
	};
	return { bounds, obstacles: chromeWithin(bounds, [el, bar]) };
}

/**
 * The chrome fixed over a stretch of the screen, on screen, leaving out
 * whatever holds or is held by `own` (the panel asking, and what it opens from).
 */
export function chromeWithin(bounds: Box, own: readonly HTMLElement[]): Box[] {
	return [...document.querySelectorAll<HTMLElement>(CHROME)]
		.filter((chrome) => own.every((el) => !chrome.contains(el) && !el.contains(chrome)))
		.map((chrome) => boxOf(chrome.getBoundingClientRect()))
		.filter(
			(box) =>
				box.right > box.left &&
				box.bottom > box.top &&
				box.left < bounds.right &&
				box.right > bounds.left &&
				box.top < bounds.bottom &&
				box.bottom > bounds.top,
		);
}

/** The keys that stage from a panel with a list or text in it. */
export const SUBMIT_HINT = isApplePlatform() ? "⌘↵" : "Ctrl ↵";

export function Popover({
	label,
	onClose,
	children,
	className,
	wide = false,
	prefer = "below",
}: {
	label: string;
	onClose: () => void;
	children: ReactNode;
	className?: string;
	wide?: boolean;
	/** Which side of the bar to open on, room allowing. */
	prefer?: "below" | "above";
}) {
	const ref = useRef<HTMLDivElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	const barAnchor = useContext(BarAnchorContext);
	const want = barAnchor?.side ?? prefer;
	const wanted = useRef(want);
	const edge = useRef(barAnchor?.edge);
	const barRect = useRef(barAnchor?.rect);
	barRect.current = barAnchor?.rect;
	const replace = useRef<((why: "moved" | "edge") => void) | null>(null);

	// Room below? Otherwise above. On the canvas sideways, and clear of its
	// chrome. Placed when it opens; after that it keeps its side as its
	// contents change (so it never jumps across its bar), but shifts and sizes
	// again. As its bar moves it keeps its side while there's room there, and
	// starts again from the side its bar wants when the bar changes sides.
	// Written to the element directly, as it can happen on every frame of a pan.
	useLayoutEffect(() => {
		const el = ref.current;
		const bar = el?.parentElement;
		if (!el || !bar) return;
		let placed: Side | null = null;
		const place = (why: "opened" | "grew" | "moved" | "edge") => {
			// Where the bar is going, if it's gliding there.
			const anchor = barRect.current ?? bar.getBoundingClientRect();
			// Off screen (in a scrolling gallery, say): leave it be.
			if (anchor.top > window.innerHeight || anchor.bottom < 0) return;
			const { bounds, obstacles } = surroundings(el, bar);
			const keep = placed !== null && (why === "grew" || why === "moved");
			const placement = placePopover({
				anchor: boxOf(anchor),
				// Its natural size: taller than the room it has, it scrolls.
				size: { width: el.offsetWidth, height: el.scrollHeight },
				bounds,
				obstacles,
				prefer: keep && placed ? placed : wanted.current,
				stay: keep && why === "grew",
			});
			placed = placement.side;
			el.dataset.side = placement.side;
			el.style.setProperty("--nudge", `${placement.nudge}px`);
			el.style.setProperty("--room", `${placement.room}px`);
		};
		place("opened");
		replace.current = place;
		let frame = 0;
		const observer = new ResizeObserver(() => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => place("grew"));
		});
		for (const child of el.children) observer.observe(child);
		return () => {
			replace.current = null;
			cancelAnimationFrame(frame);
			observer.disconnect();
		};
	}, []);

	// Its bar moved, or changed sides.
	const at = barAnchor
		? `${barAnchor.rect.left} ${barAnchor.rect.top} ${barAnchor.rect.right}`
		: "";
	const barEdge = barAnchor?.edge;
	useLayoutEffect(() => {
		if (!at && wanted.current === want) return;
		const changed = wanted.current !== want || edge.current !== barEdge;
		wanted.current = want;
		edge.current = barEdge;
		replace.current?.(changed ? "edge" : "moved");
	}, [want, at, barEdge]);

	useEffect(() => {
		const el = ref.current;
		const focusable =
			el?.querySelector<HTMLElement>("[data-autofocus]") ??
			el?.querySelector<HTMLElement>("input, button");
		focusable?.focus({ preventScroll: true });
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			// Clicks on the bar that opened it toggle it there instead.
			if (target && (el?.contains(target) || el?.parentElement?.contains(target))) return;
			close.current();
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		return () => window.removeEventListener("pointerdown", onPointerDown, true);
	}, []);

	return (
		<div
			ref={ref}
			role="dialog"
			aria-label={label}
			className={`action-popover nodrag nopan nowheel${className ? ` ${className}` : ""}`}
			// Until it's placed (which happens before it's painted, on screen).
			data-side={want}
			data-wide={wide || undefined}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.stopPropagation();
					event.preventDefault();
					close.current();
					return;
				}
				// ⌘↵ stages from any panel, whatever has focus in it.
				if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.defaultPrevented) {
					const primary = ref.current?.querySelector<HTMLButtonElement>(
						".action-primary:not(:disabled)",
					);
					if (!primary) return;
					event.preventDefault();
					event.stopPropagation();
					primary.click();
				}
			}}
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => event.stopPropagation()}
			onWheel={(event) => event.stopPropagation()}
		>
			{children}
		</div>
	);
}

/** The popover's header: what it does, and a quiet line of context. */
export function PopoverHead({ title, detail }: { title: ReactNode; detail?: ReactNode }) {
	return (
		<header className="action-popover-head">
			<h3>{title}</h3>
			{detail && <p>{detail}</p>}
		</header>
	);
}

/** A status line in a popover: a note, a warning, or an error. */
export function Notice({
	tone = "note",
	icon,
	children,
}: {
	tone?: "note" | "warn" | "error";
	icon?: ReactNode;
	children: ReactNode;
}) {
	return (
		<p className="action-notice" data-tone={tone} role={tone === "error" ? "alert" : undefined}>
			{icon}
			<span>{children}</span>
		</p>
	);
}
