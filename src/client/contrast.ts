// WCAG contrast, for checking the theme tokens in styles.css (see
// test/theme.test.ts). Understands the colour forms the tokens use:
// #rgb, #rrggbb, and rgb(r g b / a%) with optional alpha.

export interface Rgba {
	r: number;
	g: number;
	b: number;
	/** 0–1 */
	a: number;
}

export function parseColor(value: string): Rgba {
	const text = value.trim().toLowerCase();
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text)?.[1];
	if (hex) {
		const full = hex.length === 3 ? hex.replace(/./g, "$&$&") : hex;
		return {
			r: Number.parseInt(full.slice(0, 2), 16),
			g: Number.parseInt(full.slice(2, 4), 16),
			b: Number.parseInt(full.slice(4, 6), 16),
			a: 1,
		};
	}
	const rgb =
		/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+)(%?))?\s*\)$/.exec(text);
	if (rgb) {
		const [, r, g, b, alpha, percent] = rgb;
		const a = alpha === undefined ? 1 : Number(alpha) / (percent ? 100 : 1);
		return { r: Number(r), g: Number(g), b: Number(b), a };
	}
	throw new Error(`Can't parse colour: ${value}`);
}

/** Paint a translucent colour over an opaque one. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
	const mix = (t: number, b: number) => t * top.a + b * (1 - top.a);
	return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

function channel(value: number): number {
	const c = value / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance({ r, g, b }: Rgba): number {
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * The contrast ratio of text over a background, from 1 to 21. Translucent
 * text is composited over the background first; the background must be
 * opaque.
 */
export function contrastRatio(text: string, background: string): number {
	const bg = parseColor(background);
	if (bg.a < 1) throw new Error(`Background must be opaque: ${background}`);
	const fg = composite(parseColor(text), bg);
	const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA: 4.5:1 for body text, 3:1 for large text (24px, or 18.66px bold). */
export const AA_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;
