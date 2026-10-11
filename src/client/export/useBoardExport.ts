import { useReactFlow } from "@xyflow/react";
import { type RefObject, useCallback, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { readShapes } from "../../shared/structure.ts";
import type { Rect } from "../snapping.ts";
import { type ImageFormat, renderImage } from "./image.ts";
import { exportRegion, imageSize, selectionScope } from "./scope.ts";

// Drawing the board for an export (#59). What's on screen isn't enough to
// copy: React Flow only draws the shapes in view, and below some zooms
// cards and lists draw in less detail. So for a moment the board draws
// everything, at 100%, behind the export dialog (faded out, and nobody
// following you sees it move: `drawing` pauses publishing your view), then
// goes back exactly where it was.

export type ExportScope = "selection" | "board";

export interface DrawRequest {
	scope: ExportScope;
	format: ImageFormat;
	/** Pixels per board unit, or the longest side to fit (a preview). */
	scale: number | { fit: number };
	background: boolean;
}

export interface Drawn {
	blob: Blob;
	region: Rect;
	width: number;
	height: number;
	/** The scale it was drawn at, which may be less than asked for (`imageSize`). */
	scale: number;
}

export interface BoardExporter {
	/** Whether the board's being drawn right now (culling off, at 100%). */
	drawing: boolean;
	draw: (request: DrawRequest) => Promise<Drawn>;
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Wait until every node is in the DOM and measured, for at most `ms`. */
async function settled(flow: HTMLElement, ids: readonly string[], ms = 4000): Promise<void> {
	const until = performance.now() + ms;
	while (performance.now() < until) {
		const missing = ids.some((id) => {
			const node = flow.querySelector<HTMLElement>(
				`.react-flow__node[data-id="${CSS.escape(id)}"]`,
			);
			return !node || getComputedStyle(node).visibility === "hidden";
		});
		if (!missing) return;
		await frame();
	}
}

export function useBoardExport({
	doc,
	canvas,
	selected,
}: {
	doc: Y.Doc;
	canvas: RefObject<HTMLElement | null>;
	selected: ReadonlySet<string>;
}): BoardExporter {
	const flow = useReactFlow();
	const [drawing, setDrawing] = useState(false);
	// One drawing at a time: a preview and a download mustn't fight over the view.
	const queue = useRef<Promise<unknown>>(Promise.resolve());
	const selectedRef = useRef(selected);
	selectedRef.current = selected;

	const drawNow = useCallback(
		async (request: DrawRequest): Promise<Drawn> => {
			const element = canvas.current?.querySelector<HTMLElement>(".react-flow");
			if (!element) throw new Error("The board isn’t showing");
			const shapes = readShapes(doc);
			const scope =
				request.scope === "selection"
					? selectionScope(shapes, selectedRef.current)
					: new Set(shapes.keys());
			const nodeIds = [...scope].filter((id) => shapes.get(id)?.type !== "connector");
			const saved = flow.getViewport();
			setDrawing(true);
			try {
				await frame();
				await flow.setViewport({ x: saved.x, y: saved.y, zoom: 1 });
				await frame();
				await frame();
				await settled(element, nodeIds);
				await document.fonts?.ready;

				const boxes: Rect[] = [];
				for (const id of nodeIds) {
					const node = flow.getInternalNode(id);
					if (!node) continue;
					const { x, y } = node.internals.positionAbsolute;
					const width = node.measured.width ?? node.width ?? 0;
					const height = node.measured.height ?? node.height ?? 0;
					boxes.push({ x, y, width, height });
				}
				for (const id of scope) {
					const shape = shapes.get(id);
					if (shape?.type !== "connector") continue;
					for (const end of [shape.from, shape.to]) {
						if (end) boxes.push({ x: end.x, y: end.y, width: 0, height: 0 });
					}
				}
				const region = exportRegion(boxes);
				if (!region) throw new Error("There’s nothing to export");
				const scale =
					typeof request.scale === "number"
						? request.scale
						: Math.min(2, request.scale.fit / Math.max(region.width, region.height));
				const size = imageSize(region, scale);
				const blob = await renderImage({
					flow: element,
					region,
					only: request.scope === "board" ? null : scope,
					format: request.format,
					scale: size.scale,
					background: request.background,
				});
				return { blob, region, width: size.width, height: size.height, scale: size.scale };
			} finally {
				await flow.setViewport(saved);
				setDrawing(false);
			}
		},
		[canvas, doc, flow],
	);

	const draw = useCallback(
		(request: DrawRequest) => {
			const next = queue.current.catch(() => undefined).then(() => drawNow(request));
			queue.current = next;
			return next;
		},
		[drawNow],
	);

	return useMemo(() => ({ drawing, draw }), [drawing, draw]);
}
