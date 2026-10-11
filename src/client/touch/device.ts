import { useSyncExternalStore } from "react";
import "./touch.css";

// What kind of screen the board is on (#67). A phone gets a board to look
// around, vote, comment and add stickies on, with shapes opening in a sheet
// from the bottom; everything bigger edits, and with a touch screen (a
// tablet, with a finger or a pencil) gets touch-sized controls, long-press
// to select several, and the pencil for drawing a selection box.

/**
 * A phone: narrow, or a touch screen too short to edit on (a phone on its
 * side). Keep the width in step with the `599px` breakpoints in styles.css.
 */
export const PHONE_QUERY = "(max-width: 600px), (pointer: coarse) and (max-height: 500px)";
/** A touch screen is the main way of pointing. */
export const TOUCH_QUERY = "(pointer: coarse)";

export interface Device {
	/** Look, vote, comment and add stickies, with shapes opening in a sheet. */
	phone: boolean;
	/** Pointing with a finger (or a pencil): bigger targets, long-press. */
	touch: boolean;
}

function query(text: string): MediaQueryList | null {
	return typeof window !== "undefined" && window.matchMedia ? window.matchMedia(text) : null;
}

let current: Device = read();

function read(): Device {
	return {
		phone: query(PHONE_QUERY)?.matches ?? false,
		touch: query(TOUCH_QUERY)?.matches ?? false,
	};
}

function subscribe(listener: () => void): () => void {
	const lists = [query(PHONE_QUERY), query(TOUCH_QUERY)].filter((list) => list !== null);
	const onChange = () => {
		const next = read();
		if (next.phone === current.phone && next.touch === current.touch) return;
		current = next;
		listener();
	};
	for (const list of lists) list.addEventListener("change", onChange);
	// Rotating, or a window resized past the line.
	onChange();
	return () => {
		for (const list of lists) list.removeEventListener("change", onChange);
	};
}

/** The device the board's on, re-rendering when that changes (rotating a phone, say). */
export function useDevice(): Device {
	return useSyncExternalStore(
		subscribe,
		() => current,
		() => current,
	);
}
