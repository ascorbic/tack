import type * as Y from "yjs";
import { shapesMap } from "../shared/shapes.ts";

export interface WatchOptions {
	/** Quiet time after the last relevant change before calling back. */
	wait: number;
	/** Longest delay after the first change, however busy the board is. */
	maxWait: number;
}

/** Shape properties that decide which cards a board shows. */
const CARD_PROPS = ["ref", "type"];

/**
 * Call `onChange` after card shapes are added, removed or pointed at another
 * item, debounced. Moving shapes, typing in stickies and other edits don't
 * count, so a busy board doesn't rescan every shape on every update.
 * Returns a function that stops watching.
 */
export function watchCardRefs(
	doc: Y.Doc,
	onChange: () => void,
	{ wait, maxWait }: WatchOptions,
): () => void {
	const shapes = shapesMap(doc);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let first: number | null = null;

	const fire = () => {
		timer = undefined;
		first = null;
		onChange();
	};

	const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
		const relevant = events.some(
			(event) =>
				event.target === shapes ||
				("keysChanged" in event &&
					CARD_PROPS.some((prop) => (event.keysChanged as Set<string>).has(prop))),
		);
		if (!relevant) return;
		const now = Date.now();
		first ??= now;
		clearTimeout(timer);
		timer = setTimeout(fire, Math.max(0, Math.min(wait, first + maxWait - now)));
	};

	shapes.observeDeep(observer);
	return () => {
		shapes.unobserveDeep(observer);
		clearTimeout(timer);
	};
}
