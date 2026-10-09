// Shrink-to-fit text for stickies, like FigJam: a short note is set large,
// and the type steps down as the text grows. Sizes are discrete steps, so
// typing a character rarely changes the size, and when it does the text
// jumps a whole step rather than creeping.

/** Font sizes a sticky's text can take, largest first. */
export const STICKY_FONT_SIZES = [28, 24, 21, 18, 16, 14.5, 13, 12, 11] as const;

/**
 * The largest size that fits. `fits` must be monotonic: if a size fits,
 * every smaller size fits too. When nothing fits, the smallest size is used
 * and the text scrolls (while editing) or fades out at the bottom.
 */
export function fitFontSize(fits: (size: number) => boolean, sizes: readonly number[]): number {
	const smallest = sizes.at(-1);
	if (smallest === undefined) throw new Error("No font sizes to fit");
	// Binary search for the first (largest) size that fits.
	let lo = 0;
	let hi = sizes.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (fits(sizes[mid] as number)) {
			found = mid;
			hi = mid - 1;
		} else {
			lo = mid + 1;
		}
	}
	return found === -1 ? smallest : (sizes[found] as number);
}

/** Whether text measured at some size fits its box, to the pixel. */
export function fitsBox(
	measured: { width: number; height: number },
	box: { width: number; height: number },
): boolean {
	// Sub-pixel rounding in scroll sizes shouldn't push text down a size.
	return measured.width <= box.width + 0.5 && measured.height <= box.height + 0.5;
}

/**
 * A small least-recently-used cache. Fitting is pure in (text, font, box),
 * so a board full of stickies only measures each distinct note once.
 */
export class FitCache {
	private entries = new Map<string, number>();

	constructor(private limit = 1000) {}

	get(key: string): number | undefined {
		const value = this.entries.get(key);
		if (value !== undefined) {
			this.entries.delete(key);
			this.entries.set(key, value);
		}
		return value;
	}

	set(key: string, value: number): void {
		this.entries.delete(key);
		this.entries.set(key, value);
		if (this.entries.size > this.limit) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
	}

	clear(): void {
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}
}
