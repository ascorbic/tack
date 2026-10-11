import { useStore } from "@xyflow/react";
import { type RefObject, useLayoutEffect } from "react";

/** How close to the canvas's edge a floating toolbar may come. */
const PAD = 8;

/**
 * Keep a toolbar floating over the canvas inside it (canvas review 25, 29):
 * one anchored above a shape near the top or the side would otherwise be
 * cut off, or slide under the top bar. It's nudged in by `--clamp-x` and
 * `--clamp-y`, which its styles add to its `translate`, so whatever places
 * it (and its entrance) is left alone.
 */
export function useInsideCanvas(
	ref: RefObject<HTMLElement | null>,
	{
		top = PAD,
	}: {
		/** Space to keep clear at the top, e.g. for a toolbar stacked above. */
		top?: number;
	} = {},
): void {
	const domNode = useStore((state) => state.domNode);
	// Panning and zooming move what it's anchored to, so check again.
	useStore((state) => state.transform);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || !domNode) return;
		const apply = () => {
			const box = el.getBoundingClientRect();
			if (box.width === 0) return;
			// Where it'd be without the nudge it has now.
			const was = {
				x: Number.parseFloat(el.style.getPropertyValue("--clamp-x")) || 0,
				y: Number.parseFloat(el.style.getPropertyValue("--clamp-y")) || 0,
			};
			const left = box.left - was.x;
			const right = box.right - was.x;
			const upper = box.top - was.y;
			const lower = box.bottom - was.y;
			const canvas = domNode.getBoundingClientRect();
			let dx = 0;
			let dy = 0;
			if (left < canvas.left + PAD) dx = canvas.left + PAD - left;
			else if (right > canvas.right - PAD) dx = canvas.right - PAD - right;
			if (upper < canvas.top + top) dy = canvas.top + top - upper;
			else if (lower > canvas.bottom - PAD) dy = canvas.bottom - PAD - lower;
			dx = Math.round(dx);
			dy = Math.round(dy);
			if (dx === was.x && dy === was.y) return;
			el.style.setProperty("--clamp-x", `${dx}px`);
			el.style.setProperty("--clamp-y", `${dy}px`);
		};
		apply();
		const observer = new ResizeObserver(apply);
		observer.observe(el);
		// Measured mid-entrance it's smaller than it ends up: check again after.
		el.addEventListener("animationend", apply);
		return () => {
			observer.disconnect();
			el.removeEventListener("animationend", apply);
		};
	});
}
