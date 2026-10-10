import { type ReactFlowState, useStore } from "@xyflow/react";
import {
	type CSSProperties,
	type ReactNode,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { chromeWithin } from "../actions/Popover.tsx";
import { type Box, type BesidePlacement, placeBeside } from "../actions/popoverPlacement.ts";

// A panel beside a widget (its settings, drop to match's confirmation),
// drawn at screen size above the board like React Flow's NodeToolbar, but
// placed so it's always wholly on the visible canvas: to the widget's right,
// or its left when there's no room, slid up or down to stay on screen and
// clear of the chrome over the canvas (the dock, the minimap, the zoom
// controls), pinned to the top and scrolling when it's taller than the room.
// It follows the widget as the board pans, zooms or the widget moves.

/** The tallest a panel grows before it scrolls, however much room there is. */
const MAX_HEIGHT = 560;
/** Above the shapes, below the selection's toolbars (3000). */
const PANEL_Z = 2800;

const rendererOf = (state: ReactFlowState) =>
	state.domNode?.querySelector<HTMLElement>(".react-flow__renderer") ?? null;

const sameBox = (a: Box | null, b: Box | null) =>
	a === b ||
	(a !== null &&
		b !== null &&
		a.left === b.left &&
		a.top === b.top &&
		a.right === b.right &&
		a.bottom === b.bottom);

export function WidgetPanel({
	nodeId,
	open,
	children,
}: {
	nodeId: string;
	open: boolean;
	children: ReactNode;
}) {
	const renderer = useStore(rendererOf);
	// The widget on screen, relative to the canvas.
	const anchor = useStore(
		useCallback(
			(state: ReactFlowState): Box | null => {
				const node = state.nodeLookup.get(nodeId);
				if (!node) return null;
				const [tx, ty, zoom] = state.transform;
				const { x, y } = node.internals.positionAbsolute;
				const width = node.measured.width ?? node.width ?? 0;
				const height = node.measured.height ?? node.height ?? 0;
				return {
					left: x * zoom + tx,
					top: y * zoom + ty,
					right: (x + width) * zoom + tx,
					bottom: (y + height) * zoom + ty,
				};
			},
			[nodeId],
		),
		sameBox,
	);
	const canvas = useStore((state) => `${state.width}x${state.height}`);
	const ref = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState<{ width: number; height: number } | null>(null);
	const [placement, setPlacement] = useState<BesidePlacement | null>(null);

	// Its natural size, again whenever its contents change.
	useLayoutEffect(() => {
		const el = ref.current;
		if (!open || !el) return;
		const measure = () => {
			const panel = el.firstElementChild as HTMLElement | null;
			if (!panel) return;
			const borders = panel.offsetHeight - panel.clientHeight;
			const height = Math.min(MAX_HEIGHT, panel.scrollHeight + borders);
			const width = panel.offsetWidth;
			setSize((size) =>
				size && size.width === width && size.height === height ? size : { width, height },
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		const panel = el.firstElementChild;
		if (panel) {
			observer.observe(panel);
			for (const child of panel.children) observer.observe(child);
		}
		return () => observer.disconnect();
	}, [open, renderer]);

	useLayoutEffect(() => {
		const el = ref.current;
		const flow = renderer?.parentElement;
		if (!open || !el || !flow || !anchor || !size) return;
		const screen = flow.getBoundingClientRect();
		const bounds = { left: 0, top: 0, right: screen.width, bottom: screen.height };
		// The chrome over the canvas, relative to it.
		const obstacles = chromeWithin(
			{ left: screen.left, top: screen.top, right: screen.right, bottom: screen.bottom },
			[el],
		).map((box) => ({
			left: box.left - screen.left,
			top: box.top - screen.top,
			right: box.right - screen.left,
			bottom: box.bottom - screen.top,
		}));
		const next = placeBeside({ anchor, size, bounds, obstacles });
		setPlacement((current) =>
			current &&
			current.side === next.side &&
			current.left === next.left &&
			current.top === next.top &&
			current.room === next.room
				? current
				: next,
		);
	}, [open, renderer, anchor, size, canvas]);

	if (!open || !renderer || !anchor) return null;
	return createPortal(
		<div
			ref={ref}
			className="widget-panel nodrag nopan nowheel"
			data-side={placement?.side ?? "right"}
			style={
				{
					zIndex: PANEL_Z,
					transform: placement ? `translate(${placement.left}px, ${placement.top}px)` : undefined,
					// Measured where it can't be seen (but can take focus), then placed.
					opacity: placement ? undefined : 0,
					"--room": placement ? `${Math.min(MAX_HEIGHT, placement.room)}px` : undefined,
				} as CSSProperties
			}
		>
			{children}
		</div>,
		renderer,
	);
}
