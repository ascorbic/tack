import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

// Reduced motion everywhere (#61): every animation and transition in the
// client's styles is scaled by --motion (directly, or through the --t-*
// tokens), so slow motion and reduced motion reach all of it. A duration
// written out on its own would play at full length with motion reduced.

function cssFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) cssFiles(path, out);
		else if (name.endsWith(".css")) out.push(path);
	}
	return out;
}

/** Split a value at its top-level commas: one entry per animation or transition. */
function layers(value: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		else if (ch === "," && depth === 0) {
			out.push(value.slice(start, i));
			start = i + 1;
		}
	}
	out.push(value.slice(start));
	return out.map((layer) => layer.trim());
}

/**
 * Durations that are meant to be real time, whatever the motion setting:
 * not motion, but how long something lasts.
 */
const REAL_TIME = [
	// A raised hand fades in its last two seconds of six: a countdown.
	"hand-lowering 2000ms ease-in 4000ms forwards",
	// Hover intent before a query's preview opens, not an animation.
	"transition-delay: 280ms, 280ms, 0s",
];

// Tests run from the repository root.
const files = cssFiles("src/client");

describe("motion", () => {
	it("finds the client's styles", () => {
		expect(files.length).toBeGreaterThan(10);
	});

	it.each(files)("%s scales every duration by --motion", (file) => {
		const css = readFileSync(file, "utf8");
		const unscaled: string[] = [];
		for (const match of css.matchAll(
			/(?:animation|transition)(?:-duration|-delay)?\s*:([^;{}]*);/g,
		)) {
			const declaration = match[0].replace(/\s+/g, " ");
			if (REAL_TIME.some((allowed) => declaration.includes(allowed))) continue;
			for (const layer of layers(match[1] ?? "")) {
				const durations = layer.match(/(?<![\w-])\d*\.?\d+m?s\b/g) ?? [];
				const nonZero = durations.filter((d) => Number.parseFloat(d) !== 0);
				if (nonZero.length === 0) continue;
				if (/var\(--motion\)|var\(--t-[a-z]+\)/.test(layer)) continue;
				unscaled.push(`${layer} (line ${css.slice(0, match.index).split("\n").length})`);
			}
		}
		expect(unscaled).toEqual([]);
	});

	it("stops looping animations with motion reduced, rather than looping them faster", () => {
		const css = readFileSync("src/client/styles.css", "utf8");
		expect(css).toMatch(
			/@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*::before,\s*::after \{\s*animation-iteration-count: 1 !important;/,
		);
		expect(css).toContain(':root[data-motion="reduced"] *');
	});
});
