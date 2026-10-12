import { NodeToolbar, type ReactFlowState, useStore } from "@xyflow/react";
import {
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import { previewStore } from "../display/Preview.tsx";
import { scaledDuration } from "../motion.ts";
import { type BarAnchor, BarAnchorContext, chromeWithin } from "./Popover.tsx";
import { type BarSide, type Box, panelSide, placeBar } from "./popoverPlacement.ts";

// Where the selection's action bar sits (placeBar in popoverPlacement.ts):
// under the selection, or over it, always wholly on the visible canvas and
// clear of the chrome over it, pinned to the edge of the view when the
// selection fills it. Drawn by React Flow's NodeToolbar (above every shape,
// following the board), at a position of our own. Its panels open away from
// the edge it's pinned to (`BarAnchorContext`). Only this re-renders as the
// board pans: what's inside is the same elements, so it's left alone.
//
// A row or mini card selected on its own pops its full card out beside it
// (display/Preview.tsx): the bar goes with that, under it or over it, rather
// than with the little thing it's the card of.

/** Where the pinned pop-out sits: right of its row or mini card (Preview.tsx's offset). */
const POP_OUT_GAP = 14;

/** The selection's box on the canvas, in screen pixels from its corner. */
function selectionOn(state: ReactFlowState, ids: readonly string[]): Box | null {
	let box: Box | null = null;
	for (const id of ids) {
		const node = state.nodeLookup.get(id);
		if (!node) continue;
		const { x, y } = node.internals.positionAbsolute;
		const right = x + (node.measured.width ?? node.width ?? 0);
		const bottom = y + (node.measured.height ?? node.height ?? 0);
		box = box
			? {
					left: Math.min(box.left, x),
					top: Math.min(box.top, y),
					right: Math.max(box.right, right),
					bottom: Math.max(box.bottom, bottom),
				}
			: { left: x, top: y, right, bottom };
	}
	if (!box) return null;
	const [tx, ty, zoom] = state.transform;
	return {
		left: box.left * zoom + tx,
		top: box.top * zoom + ty,
		right: box.right * zoom + tx,
		bottom: box.bottom * zoom + ty,
	};
}

const sameBox = (a: Box | null, b: Box | null) =>
	a === b ||
	(a !== null &&
		b !== null &&
		a.left === b.left &&
		a.top === b.top &&
		a.right === b.right &&
		a.bottom === b.bottom);

interface Frame {
	/** Where the canvas is on screen. */
	origin: { x: number; y: number };
	bounds: Box;
	obstacles: Box[];
}

/** The visible canvas and the chrome over it, in the canvas's own pixels. */
function measureFrame(canvas: HTMLElement, bar: HTMLElement | null): Frame {
	const rect = canvas.getBoundingClientRect();
	const visible = {
		left: Math.max(0, rect.left),
		top: Math.max(0, rect.top),
		right: Math.min(window.innerWidth, rect.right),
		bottom: Math.min(window.innerHeight, rect.bottom),
	};
	const local = (box: Box): Box => ({
		left: box.left - rect.left,
		top: box.top - rect.top,
		right: box.right - rect.left,
		bottom: box.bottom - rect.top,
	});
	return {
		origin: { x: rect.left, y: rect.top },
		bounds: local(visible),
		obstacles: chromeWithin(visible, bar ? [bar] : []).map(local),
	};
}

/** Glides between sides, for this long; following the board is instant. */
const GLIDE_MS = 240;

export function SelectionBar({
	ids,
	visible,
	below,
	above,
	zIndex,
	bar,
	children,
}: {
	ids: readonly string[];
	visible: boolean;
	/** Between the selection's bottom and the bar. */
	below: number;
	/** Between the selection's top and the bar, over what's drawn above it. */
	above: number;
	zIndex: number;
	/** The bar itself, to measure. */
	bar: RefObject<HTMLElement | null>;
	children: ReactNode;
}) {
	const key = ids.join(",");
	const list = useMemo(() => key.split(","), [key]);
	const selection = useStore(
		useCallback((state: ReactFlowState) => selectionOn(state, list), [list]),
		sameBox,
	);
	const canvas = useStore((state) => state.domNode);
	const [size, setSize] = useState<{ width: number; height: number } | null>(null);
	const [frame, setFrame] = useState<Frame | null>(null);
	// The pinned pop-out's size, while there is one for this selection.
	const hovered = useSyncExternalStore(previewStore.subscribe, previewStore.get);
	const [popOut, setPopOut] = useState<{ width: number; height: number } | null>(null);
	useLayoutEffect(() => {
		if (!visible || list.length !== 1 || !canvas) {
			setPopOut(null);
			return;
		}
		let observer: ResizeObserver | null = null;
		// Drawn in the same commit as the selection, or the next frame.
		const frame = requestAnimationFrame(() => {
			const el = canvas.ownerDocument.querySelector<HTMLElement>(".display-preview[data-pinned]");
			if (!el) return setPopOut(null);
			const measure = () =>
				setPopOut((was) =>
					was?.width === el.offsetWidth && was.height === el.offsetHeight
						? was
						: { width: el.offsetWidth, height: el.offsetHeight },
				);
			measure();
			observer = new ResizeObserver(measure);
			observer.observe(el);
		});
		return () => {
			cancelAnimationFrame(frame);
			observer?.disconnect();
		};
	}, [visible, list, canvas, hovered]);
	const anchorBox = useMemo<Box | null>(
		() =>
			selection && popOut
				? {
						left: selection.right + POP_OUT_GAP,
						top: selection.top,
						right: selection.right + POP_OUT_GAP + popOut.width,
						bottom: selection.top + popOut.height,
					}
				: selection,
		[selection, popOut],
	);
	const shown = visible && selection !== null;

	// The bar's size, and the canvas and its chrome: measured as the bar
	// arrives and when any of them change size, not on every frame of a pan.
	useLayoutEffect(() => {
		const el = bar.current;
		if (!shown || !el || !canvas) return;
		const measure = () => {
			setSize((was) =>
				was?.width === el.offsetWidth && was.height === el.offsetHeight
					? was
					: { width: el.offsetWidth, height: el.offsetHeight },
			);
			setFrame(measureFrame(canvas, el));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		observer.observe(canvas);
		for (const chrome of canvas.querySelectorAll(".facilitation-dock, .toolbar-dock")) {
			observer.observe(chrome);
		}
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [shown, canvas, bar, list]);

	const placement = useMemo(
		() =>
			anchorBox && size && frame
				? placeBar({
						selection: anchorBox,
						size,
						bounds: frame.bounds,
						obstacles: frame.obstacles,
						below,
						above,
					})
				: null,
		[anchorBox, size, frame, below, above],
	);

	// Glide when it changes sides (the board moving under it never does): on
	// in the same render as the move, so the move is what glides. A new
	// selection's bar is just there, as it always was, never sliding over
	// what's about to be clicked.
	const side = placement?.side;
	const [last, setLast] = useState<{ key: string; side?: BarSide }>({ key, side });
	const [glide, setGlide] = useState(0);
	const [glided, setGlided] = useState(0);
	if (last.key !== key || last.side !== side) {
		setLast({ key, side });
		if (last.key !== key) setGlided(glide);
		else if (last.side && side && scaledDuration(GLIDE_MS) > 0) setGlide(glide + 1);
	}
	useEffect(() => {
		if (glide === 0) return;
		const timer = window.setTimeout(() => setGlided(glide), scaledDuration(GLIDE_MS));
		return () => window.clearTimeout(timer);
	}, [glide]);
	const gliding = glide !== glided;

	const anchor = useMemo<BarAnchor | null>(
		() =>
			placement && size && frame
				? {
						side: panelSide(placement.side),
						edge: placement.side,
						rect: {
							left: frame.origin.x + placement.left,
							top: frame.origin.y + placement.top,
							right: frame.origin.x + placement.left + size.width,
							bottom: frame.origin.y + placement.top + size.height,
						},
					}
				: null,
		[placement, size, frame],
	);

	const style: CSSProperties = {
		zIndex,
		// Unmeasured, it's laid out out of sight, then placed before it's painted.
		transform: placement
			? `translate(${placement.left}px, ${placement.top}px)`
			: "translate(-200vw, -200vh)",
	};
	return (
		<NodeToolbar
			nodeId={list}
			isVisible={visible}
			className="selection-bar"
			data-side={placement?.side}
			data-gliding={gliding || undefined}
			style={style}
		>
			<BarAnchorContext.Provider value={anchor}>{children}</BarAnchorContext.Provider>
		</NodeToolbar>
	);
}
