// Turning a drawn board (draw.ts) into SVG with Satori and PNG with resvg,
// both as WebAssembly. Workers can't compile WebAssembly from bytes at run
// time, so both modules are imported as compiled modules (the Cloudflare
// Vite plugin bundles `.wasm` imports that way), and the fonts as data
// (`.bin`). Everything's set up once per isolate, on the first image.

import { Resvg, initWasm } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import satori, { init as initSatori } from "satori/standalone";
import yogaWasm from "satori/yoga.wasm";
import bricolage700 from "./fonts/bricolage-700.woff.bin";
import geist400 from "./fonts/geist-400.woff.bin";
import geist600 from "./fonts/geist-600.woff.bin";
import geistExt400 from "./fonts/geist-ext-400.woff.bin";
import geistExt600 from "./fonts/geist-ext-600.woff.bin";
import shantell400 from "./fonts/shantell-400.woff.bin";
import type { El } from "./draw.ts";

let ready: Promise<void> | null = null;

function setUp(): Promise<void> {
	ready ??= Promise.all([initSatori(yogaWasm), initWasm(resvgWasm)]).then(
		() => undefined,
		(error: unknown) => {
			// Try again next time rather than failing every image from now on.
			ready = null;
			throw error;
		},
	);
	return ready;
}

const FONTS = [
	{ name: "Geist", data: geist400, weight: 400 as const, style: "normal" as const },
	{ name: "Geist", data: geist600, weight: 600 as const, style: "normal" as const },
	{ name: "GeistExt", data: geistExt400, weight: 400 as const, style: "normal" as const },
	{ name: "GeistExt", data: geistExt600, weight: 600 as const, style: "normal" as const },
	{ name: "Shantell", data: shantell400, weight: 400 as const, style: "normal" as const },
	{ name: "Bricolage", data: bricolage700, weight: 700 as const, style: "normal" as const },
];

/** An image as SVG: text drawn as paths, so it looks the same everywhere (GitHub's image proxy included). */
export async function toSvg(element: El, width: number, height: number): Promise<string> {
	await setUp();
	// Satori's types want React elements; it takes plain `{ type, props }` objects as well.
	return satori(element as unknown as Parameters<typeof satori>[0], {
		width,
		height,
		fonts: FONTS,
	});
}

/** An SVG as PNG, at its own size. */
export async function toPng(svg: string): Promise<Uint8Array> {
	await setUp();
	const resvg = new Resvg(svg, { font: { loadSystemFonts: false } });
	const image = resvg.render();
	try {
		return image.asPng();
	} finally {
		image.free();
		resvg.free();
	}
}
