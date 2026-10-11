import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { AA_TEXT, composite, contrastRatio, parseColor } from "../src/client/contrast.ts";
import { parsePreference, resolveTheme, toggledPreference } from "../src/client/theme.ts";

// Both themes' text colours, checked against WCAG AA using the real tokens
// from styles.css.

// Tests run from the repository root.
const css = readFileSync("src/client/styles.css", "utf8");

function block(selector: string): Record<string, string> {
	const start = css.indexOf(`${selector} {`);
	if (start === -1) throw new Error(`No ${selector} block in styles.css`);
	const body = css.slice(start, css.indexOf("\n}", start));
	const tokens: Record<string, string> = {};
	for (const [, name, value] of body.matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)) {
		if (name && value) tokens[name] = value.trim();
	}
	return tokens;
}

const light = block(':root,\n[data-theme="light"]');
// The dark block overrides the light one; anything it leaves out (sticky
// ink, for one) comes from the light block.
const dark = { ...light, ...block('[data-theme="dark"]') };

/** An opaque colour: translucent ones are painted over what's beneath. */
function solid(tokens: Record<string, string>, name: string, over = "ground"): string {
	const value = tokens[name];
	if (!value) throw new Error(`No --${name} token`);
	const colour = parseColor(value);
	if (colour.a === 1) return value;
	const { r, g, b } = composite(colour, parseColor(solid(tokens, over)));
	return `rgb(${r} ${g} ${b})`;
}

// [text, background, what it is]
const PAIRS: [string, string, string][] = [
	["ink", "ground", "board text"],
	["ink", "surface", "card titles"],
	["ink-soft", "surface", "secondary text"],
	["muted", "surface", "card metadata"],
	["muted", "surface-muted", "unavailable cards"],
	["muted", "ground", "hints on the board"],
	["muted", "well", "unchosen theme options"],
	["ink-soft", "chip", "chips"],
	["accent", "surface", "links and selected tools"],
	["on-accent", "accent", "primary buttons"],
	["on-tooltip", "tooltip", "tooltips"],
	["open", "open-bg", "open state chip"],
	["merged", "merged-bg", "merged state chip"],
	["closed", "closed-bg", "draft state chip"],
	["fail-ink", "surface", "failing checks summary"],
	["fail-ink", "fail-bg", "failing check names, conflicts, changes requested"],
	["pending-ink", "surface", "running checks summary"],
	["pending-ink", "pending-bg", "review required chip"],
	["open", "surface", "passing checks summary"],
	["on-status", "fail", "newly failing check, as it lands"],
	["sticky-ink", "sticky-yellow", "yellow sticky"],
	["sticky-ink", "sticky-pink", "pink sticky"],
	["sticky-ink", "sticky-blue", "blue sticky"],
	["sticky-ink", "sticky-green", "green sticky"],
	["sticky-ink", "sticky-purple", "purple sticky"],
	["sticky-ink-soft", "sticky-yellow", "author on a yellow sticky"],
	["sticky-ink-soft", "sticky-pink", "author on a pink sticky"],
	["sticky-ink-soft", "sticky-blue", "author on a blue sticky"],
	["sticky-ink-soft", "sticky-green", "author on a green sticky"],
	["sticky-ink-soft", "sticky-purple", "author on a purple sticky"],
	...["grey", "red", "orange", "yellow", "green", "blue", "purple"].map(
		(color): [string, string, string] => [
			`section-${color}-ink`,
			`section-${color}-title`,
			`${color} section title`,
		],
	),
	...["ink", "red", "orange", "green", "blue", "purple"].map((color): [string, string, string] => [
		`connector-${color}`,
		"surface",
		`${color} connector label`,
	]),
];

describe.each([
	["light", light],
	["dark", dark],
] as const)("%s theme", (_, tokens) => {
	it.each(PAIRS)("--%s on --%s (%s) passes AA", (text, background) => {
		expect(contrastRatio(tokens[text] ?? "", solid(tokens, background))).toBeGreaterThanOrEqual(
			AA_TEXT,
		);
	});

	it("passes AA for text on the floating chrome", () => {
		const chrome = solid(tokens, "chrome-strong");
		expect(contrastRatio(tokens.ink ?? "", chrome)).toBeGreaterThanOrEqual(AA_TEXT);
		expect(contrastRatio(tokens.muted ?? "", chrome)).toBeGreaterThanOrEqual(AA_TEXT);
	});

	it("passes AA for the accent on its own tint", () => {
		const tint = composite(
			parseColor(tokens["accent-soft"] ?? ""),
			parseColor(solid(tokens, "chrome-strong")),
		);
		const background = `rgb(${tint.r} ${tint.g} ${tint.b})`;
		expect(contrastRatio(tokens.accent ?? "", background)).toBeGreaterThanOrEqual(AA_TEXT);
	});
});

// Label chips take any colour a repository gives a label, mixed towards
// black (light) or white (dark) for their text: GitHub's defaults and the
// extremes must all read.
describe("label chips", () => {
	const LABELS = [
		"#ffffff",
		"#000000",
		"#fbca04",
		"#a2eeef",
		"#e4e669",
		"#f9d0c4",
		"#c5def5",
		"#d4c5f9",
		"#cfd3d7",
		"#fef2c0",
		"#0e8a16",
		"#d73a4a",
		"#7057ff",
		"#008672",
		"#0075ca",
		"#b60205",
		"#5319e7",
	];
	const rule = (selector: string) => {
		const start = css.indexOf(`${selector} {`);
		return css.slice(start, css.indexOf("}", start));
	};
	const percent = (body: string, property: string) => {
		const match = new RegExp(
			`\\n\\t${property}: color-mix\\(in srgb, var\\(--label\\) (\\d+)%`,
		).exec(body);
		if (!match) throw new Error(`No ${property} mix`);
		return Number(match[1]) / 100;
	};
	const mix = (label: string, amount: number, other: string) => {
		const { r, g, b } = composite({ ...parseColor(label), a: amount }, parseColor(other));
		return `rgb(${r} ${g} ${b})`;
	};

	it.each(LABELS)("%s passes AA in the light theme", (label) => {
		const body = rule("\n.chip.label");
		const text = mix(label, percent(body, "color"), "#000000");
		const ground = mix(label, percent(body, "background"), "#ffffff");
		expect(contrastRatio(text, ground)).toBeGreaterThanOrEqual(AA_TEXT);
	});

	it.each(LABELS)("%s passes AA in the dark theme", (label) => {
		const body = rule('[data-theme="dark"] .chip.label');
		const text = mix(label, percent(body, "color"), "#ffffff");
		const ground = mix(label, percent(body, "background"), solid(dark, "surface"));
		expect(contrastRatio(text, ground)).toBeGreaterThanOrEqual(AA_TEXT);
	});
});

describe("contrastRatio", () => {
	it("is 21 for black on white and 1 for a colour on itself", () => {
		expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 5);
		expect(contrastRatio("#3b4cca", "#3b4cca")).toBeCloseTo(1, 5);
	});

	it("composites translucent text over the background", () => {
		expect(contrastRatio("rgb(0 0 0 / 0%)", "#ffffff")).toBeCloseTo(1, 5);
		expect(contrastRatio("rgb(0 0 0 / 50%)", "#ffffff")).toBeCloseTo(
			contrastRatio("#808080", "#ffffff"),
			1,
		);
	});

	it("parses the colour forms the tokens use", () => {
		expect(parseColor("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
		expect(parseColor("rgb(23 25 28 / 9%)")).toEqual({ r: 23, g: 25, b: 28, a: 0.09 });
		expect(parseColor("rgba(255, 255, 255, 0.5)")).toEqual({ r: 255, g: 255, b: 255, a: 0.5 });
		expect(() => parseColor("color-mix(in srgb, red, blue)")).toThrow();
	});
});

describe("theme", () => {
	it("follows the system unless told otherwise", () => {
		expect(resolveTheme("system", true)).toBe("dark");
		expect(resolveTheme("system", false)).toBe("light");
		expect(resolveTheme("light", true)).toBe("light");
		expect(resolveTheme("dark", false)).toBe("dark");
	});

	it("treats anything unrecognised in storage as system", () => {
		expect(parsePreference("dark")).toBe("dark");
		expect(parsePreference(null)).toBe("system");
		expect(parsePreference("sepia")).toBe("system");
	});
});

describe("the two-state theme switch", () => {
	it("flips to the opposite of what's shown", () => {
		expect(toggledPreference("light", false)).toBe("dark");
		expect(toggledPreference("dark", true)).toBe("light");
	});

	it("goes back to following the system rather than pinning a matching theme", () => {
		// Pinned dark on a light system: switching back means "follow the system".
		expect(toggledPreference("dark", false)).toBe("system");
		expect(toggledPreference("light", true)).toBe("system");
	});
});
