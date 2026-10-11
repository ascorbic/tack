import { useReactFlow, useStoreApi } from "@xyflow/react";
import { useCallback } from "react";
import type { Rect } from "../shared/geometry.ts";
import { scaledDuration } from "./motion.ts";

/**
 * Bring shapes just added into view, if they aren't, without zooming in:
 * Expand related's neighbourhood, or what the AI drafted, placed beside the
 * selection. Boxes are in board units.
 */
export function useReveal(): (boxes: readonly Rect[]) => void {
	const flow = useReactFlow();
	const store = useStoreApi();
	return useCallback(
		(boxes: readonly Rect[]) => {
			if (boxes.length === 0) return;
			const { transform, width, height } = store.getState();
			const [tx, ty, zoom] = transform;
			const bounds = boxes.reduce(
				(acc, b) => ({
					x1: Math.min(acc.x1, b.x),
					y1: Math.min(acc.y1, b.y),
					x2: Math.max(acc.x2, b.x + b.w),
					y2: Math.max(acc.y2, b.y + b.h),
				}),
				{ x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity },
			);
			const view = {
				x1: -tx / zoom,
				y1: -ty / zoom,
				x2: (width - tx) / zoom,
				y2: (height - ty) / zoom,
			};
			const inside =
				bounds.x1 >= view.x1 &&
				bounds.y1 >= view.y1 &&
				bounds.x2 <= view.x2 &&
				bounds.y2 <= view.y2;
			if (inside || width === 0) return;
			const pad = 80;
			const fit = Math.min(
				zoom,
				width / (bounds.x2 - bounds.x1 + pad * 2),
				height / (bounds.y2 - bounds.y1 + pad * 2),
			);
			const next = Math.max(0.1, fit);
			void flow.setViewport(
				{
					x: width / 2 - ((bounds.x1 + bounds.x2) / 2) * next,
					y: height / 2 - ((bounds.y1 + bounds.y2) / 2) * next,
					zoom: next,
				},
				{ duration: scaledDuration(520) },
			);
		},
		[flow, store],
	);
}
