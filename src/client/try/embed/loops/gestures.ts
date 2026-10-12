import type { Stage } from "../stage.ts";

/**
 * While `drag` carries something over `target`, ring the target as the
 * board rings a sticky your own drag would stack onto (the board only
 * shows that for your drags, not someone else's). Only the class on its
 * node, which the board leaves alone while the target itself doesn't change.
 */
export async function hoverAsTarget(
	stage: Stage,
	target: string,
	drag: () => Promise<void>,
): Promise<void> {
	const node = () =>
		document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(target)}"]`);
	const box = stage.box(target);
	let ringed = false;
	const watch = setInterval(() => {
		const el = node();
		if (!el || !box) return;
		// Ring it once whatever's dragged is most of the way there.
		const states = stage.sim.awareness.getStates();
		for (const state of states.values()) {
			const drags = (state as { drags?: Record<string, { x: number; y: number }> }).drags;
			for (const at of Object.values(drags ?? {})) {
				const near = Math.hypot(at.x - box.x, at.y - box.y) < 90;
				if (near !== ringed) {
					ringed = near;
					el.classList.toggle("stack-target", near);
				}
			}
		}
	}, 30);
	try {
		await drag();
	} finally {
		clearInterval(watch);
		node()?.classList.remove("stack-target");
	}
}
