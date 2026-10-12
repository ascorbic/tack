import type { ReactFlowInstance } from "@xyflow/react";
import { useEffect } from "react";
import { scaledDuration } from "./motion.ts";

// Something drawn on the board (a widget's popover, say) asking the board to
// pan by so much, so it's wholly on screen: an event, as it may be drawn
// where there's no board to ask (a gallery), and then nothing answers.

const PAN_BY = "tack:pan-by";

/** Ask the board around `from` to pan by `dx`, `dy` screen pixels. */
export function requestPanBy(from: Element, dx: number, dy: number): void {
	if (dx === 0 && dy === 0) return;
	from.dispatchEvent(new CustomEvent(PAN_BY, { bubbles: true, detail: { dx, dy } }));
}

/** The board's side: pan when asked, gently. */
export function usePanRequests(flow: ReactFlowInstance): void {
	useEffect(() => {
		const onPan = (event: Event) => {
			const { dx, dy } = (event as CustomEvent<{ dx: number; dy: number }>).detail;
			const { x, y, zoom } = flow.getViewport();
			void flow.setViewport({ x: x + dx, y: y + dy, zoom }, { duration: scaledDuration(320) });
		};
		document.addEventListener(PAN_BY, onPan);
		return () => document.removeEventListener(PAN_BY, onPan);
	}, [flow]);
}
