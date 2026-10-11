import { useReactFlow, useViewport } from "@xyflow/react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { type EmbedRegion, roundRect } from "../../shared/embed.ts";
import type { Point, Rect } from "../../shared/geometry.ts";
import { boxOf } from "../../shared/sections.ts";
import { readShapes } from "../../shared/structure.ts";
import { DocContext } from "../DocContext.ts";

/** Drags shorter than this (screen pixels) are clicks. */
const DRAG_PX = 6;

/**
 * Picking what to embed, on the board itself: drag across an area, or click
 * a section (the image then follows the section wherever it goes). The
 * board dims around what would be picked; the wheel still pans and zooms.
 * Escape goes back to the dialog as it was.
 */
export function RegionPicker({
	onPicked,
	onCancel,
}: {
	onPicked: (region: EmbedRegion, sectionTitle: string | null) => void;
	onCancel: () => void;
}) {
	const flow = useReactFlow();
	// Redraw as the view moves.
	useViewport();
	const doc = useContext(DocContext);
	const root = useRef<HTMLDivElement>(null);
	const [pointer, setPointer] = useState<Point | null>(null);
	const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);

	const sections = useMemo(() => {
		if (!doc) return [];
		const out: { id: string; title: string; box: Rect }[] = [];
		for (const [id, shape] of readShapes(doc)) {
			if (shape.type !== "section") continue;
			out.push({ id, title: shape.title ?? "", box: boxOf(id, shape) });
		}
		// Smallest first: the innermost section under the pointer wins.
		return out.sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h);
	}, [doc]);

	const origin = () => root.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
	const toFlow = (client: Point) => flow.screenToFlowPosition(client);
	/** A board rectangle on screen, relative to the canvas. */
	const onScreen = (rect: Rect) => {
		const at = origin();
		const a = flow.flowToScreenPosition({ x: rect.x, y: rect.y });
		const b = flow.flowToScreenPosition({ x: rect.x + rect.w, y: rect.y + rect.h });
		return { left: a.x - at.left, top: a.y - at.top, width: b.x - a.x, height: b.y - a.y };
	};

	const dragging =
		drag !== null && Math.hypot(drag.to.x - drag.from.x, drag.to.y - drag.from.y) >= DRAG_PX;
	const hovered = useMemo(() => {
		if (!pointer || dragging) return null;
		const at = flow.screenToFlowPosition(pointer);
		return (
			sections.find(
				({ box }) =>
					at.x >= box.x && at.x <= box.x + box.w && at.y >= box.y && at.y <= box.y + box.h,
			) ?? null
		);
	}, [pointer, dragging, sections, flow]);

	const area = (() => {
		if (!drag || !dragging) return null;
		const a = toFlow(drag.from);
		const b = toFlow(drag.to);
		return roundRect({
			x: Math.min(a.x, b.x),
			y: Math.min(a.y, b.y),
			w: Math.abs(b.x - a.x),
			h: Math.abs(b.y - a.y),
		});
	})();

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				onCancel();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onCancel]);

	// Pan with the wheel, zoom with ⌘/Ctrl and the wheel (or a pinch), as on the board.
	useEffect(() => {
		const el = root.current;
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const view = flow.getViewport();
			if (event.ctrlKey || event.metaKey) {
				const zoom = Math.min(4, Math.max(0.05, view.zoom * Math.exp(-event.deltaY * 0.01)));
				const bounds = el.getBoundingClientRect();
				const px = event.clientX - bounds.left;
				const py = event.clientY - bounds.top;
				void flow.setViewport({
					zoom,
					x: px - ((px - view.x) * zoom) / view.zoom,
					y: py - ((py - view.y) * zoom) / view.zoom,
				});
			} else {
				void flow.setViewport({ ...view, x: view.x - event.deltaX, y: view.y - event.deltaY });
			}
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [flow]);

	const hole = area ?? hovered?.box ?? null;
	const holeStyle = hole ? onScreen(hole) : null;
	return (
		<div
			ref={root}
			className="region-picker"
			data-chrome
			data-state={area ? "area" : hovered ? "section" : "idle"}
			role="application"
			aria-label="Pick a part of the board to embed"
			onPointerMove={(event) => {
				const at = { x: event.clientX, y: event.clientY };
				setPointer(at);
				if (drag) setDrag({ ...drag, to: at });
			}}
			onPointerLeave={() => setPointer(null)}
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.currentTarget.setPointerCapture(event.pointerId);
				const at = { x: event.clientX, y: event.clientY };
				setDrag({ from: at, to: at });
			}}
			onPointerUp={() => {
				const picked = area;
				setDrag(null);
				if (picked) onPicked({ kind: "rect", rect: picked }, null);
				else if (hovered) onPicked({ kind: "section", id: hovered.id }, hovered.title || null);
			}}
		>
			{holeStyle ? (
				<div className="region-picker-hole" style={holeStyle}>
					<span className="region-picker-label">
						{area
							? `${area.w} × ${area.h}`
							: hovered?.title
								? `Embed “${hovered.title}”`
								: "Embed this section"}
					</span>
				</div>
			) : (
				<div className="region-picker-scrim" />
			)}
			<div
				className="region-picker-hint"
				role="status"
				// Not the start of a drag, nor a pick.
				onPointerDown={(event) => event.stopPropagation()}
				onPointerUp={(event) => event.stopPropagation()}
			>
				Drag across what to embed, or click a section
				<button type="button" onClick={onCancel}>
					Cancel <kbd>Esc</kbd>
				</button>
			</div>
		</div>
	);
}
