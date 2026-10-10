import type { StepMeta } from "../../shared/history.ts";

/**
 * Where `position` falls among `steps`: its index, or for a step that isn't
 * among them (filtered out), the last one before it; `steps.length` for now.
 */
export function indexOf(steps: readonly StepMeta[], position: number | null): number {
	if (position === null) return steps.length;
	let before = 0;
	for (let i = 0; i < steps.length; i++) {
		const id = steps[i]!.id;
		if (id === position) return i;
		if (id < position) before = i;
	}
	return before;
}
