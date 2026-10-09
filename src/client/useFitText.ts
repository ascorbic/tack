import { useMemo, useSyncExternalStore } from "react";
import type { ShapeFont } from "../shared/shapes.ts";
import { FitCache, fitFontSize, fitsBox } from "./textFit.ts";

// Measures text in a hidden copy outside the board (see `.fit-mirror` in
// styles.css), so fitting a sticky never forces layout on the canvas, and
// the size is known during render: the first paint is already the right
// size, with no flash of overflowing text.

export interface Fit {
	size: number;
	/** The text overflows even at the smallest size. */
	overflows: boolean;
}

const cache = new FitCache();
let host: HTMLDivElement | null = null;
let probe: HTMLDivElement | null = null;

function measurer(): HTMLDivElement {
	if (probe && host?.isConnected) return probe;
	host = document.createElement("div");
	host.className = "fit-mirror";
	host.setAttribute("aria-hidden", "true");
	probe = document.createElement("div");
	host.append(probe);
	document.body.append(host);
	return probe;
}

// Web fonts load lazily, and text measured in a fallback font is the wrong
// size. When a font finishes loading, forget every measurement and refit.
let fontsVersion = 0;
const fontListeners = new Set<() => void>();

function subscribeFonts(listener: () => void): () => void {
	if (fontListeners.size === 0) document.fonts?.addEventListener("loadingdone", onFontsLoaded);
	fontListeners.add(listener);
	return () => {
		fontListeners.delete(listener);
		if (fontListeners.size === 0) {
			document.fonts?.removeEventListener("loadingdone", onFontsLoaded);
		}
	};
}

function onFontsLoaded() {
	cache.clear();
	fontsVersion++;
	for (const listener of fontListeners) listener();
}

/**
 * Fit text into a box by stepping down through `sizes` (largest first).
 * `className` gives the probe the same typography as the real text.
 */
export function measureFit(
	text: string,
	font: ShapeFont,
	box: { width: number; height: number },
	sizes: readonly number[],
	className: string,
): Fit {
	const key = `${className}|${font}|${box.width}x${box.height}|${text}`;
	const smallest = sizes.at(-1) ?? 0;
	const cached = cache.get(key);
	if (cached !== undefined) return { size: Math.abs(cached), overflows: cached < 0 };

	const el = measurer();
	el.className = className;
	el.dataset.font = font;
	el.style.width = `${box.width}px`;
	// A trailing newline makes a new (empty) line in a textarea, but not in
	// a div, so give the div something to put on it.
	el.textContent = text === "" || text.endsWith("\n") ? `${text}​` : text;
	const fits = (size: number) => {
		el.style.fontSize = `${size}px`;
		return fitsBox({ width: el.scrollWidth, height: el.scrollHeight }, box);
	};
	const size = fitFontSize(fits, sizes);
	const overflows = size === smallest && !fits(size);
	// Negative sizes mark overflow, to keep the cache a plain number.
	cache.set(key, overflows ? -size : size);
	return { size, overflows };
}

/** The font size that fits `text` in the box, refitting as fonts load. */
export function useFitText(
	text: string,
	font: ShapeFont,
	box: { width: number; height: number },
	sizes: readonly number[],
	className: string,
): Fit {
	const version = useSyncExternalStore(subscribeFonts, () => fontsVersion);
	const { width, height } = box;
	return useMemo(() => {
		// A new version means a font loaded: measure again.
		void version;
		return measureFit(text, font, { width, height }, sizes, className);
	}, [text, font, width, height, sizes, className, version]);
}
