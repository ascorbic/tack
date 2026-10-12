// Images on boards, the pure parts: what a file is, from its bytes; whether
// the server keeps it; where dropped images go; resizing that keeps their
// proportions; how an image shape draws; and copies leaving uploads behind.

import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	IMAGE_LIMITS,
	IMAGE_UPLOAD_STALE_MS,
	addImageShape,
	checkImageFile,
	cleanAlt,
	finishImage,
	hashImage,
	imageRefs,
	imageState,
	keepAspect,
	layoutImages,
	looksLikeSvg,
	placedSize,
	readImageSize,
	sniffImage,
} from "../src/shared/images.ts";
import { boxOf } from "../src/shared/sections.ts";
import { readShape, shapesMap } from "../src/shared/shapes.ts";
import { copyShapes, pasteShapes } from "../src/client/clipboard.ts";

// A real 1×1 PNG.
const PNG = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	),
	(c) => c.charCodeAt(0),
);

const ascii = (text: string) => new TextEncoder().encode(text);

function bytes(...parts: (number[] | Uint8Array)[]): Uint8Array {
	const out: number[] = [];
	for (const part of parts) out.push(...part);
	return Uint8Array.from(out);
}

const u16 = (n: number) => [n >> 8, n & 0xff];
const u16le = (n: number) => [n & 0xff, n >> 8];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, n >> 16];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

/** A JPEG's start, an APP0 segment, then a baseline frame of this size. */
function jpeg(width: number, height: number): Uint8Array {
	return bytes(
		[0xff, 0xd8],
		[0xff, 0xe0, ...u16(16)],
		ascii("JFIF\0"),
		Array.from({ length: 9 }, () => 0),
		[0xff, 0xc0, ...u16(17), 8, ...u16(height), ...u16(width), 3],
		Array.from({ length: 12 }, () => 0),
	);
}

function gif(width: number, height: number): Uint8Array {
	return bytes(
		ascii("GIF89a"),
		u16le(width),
		u16le(height),
		Array.from({ length: 8 }, () => 0),
	);
}

function webp(kind: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Uint8Array {
	const head = bytes(ascii("RIFF"), [0, 0, 0, 0], ascii("WEBP"), ascii(kind), [0, 0, 0, 0]);
	if (kind === "VP8X") return bytes(head, [0, 0, 0, 0], u24le(width - 1), u24le(height - 1));
	if (kind === "VP8 ") return bytes(head, [0, 0, 0, 0x9d, 0x01, 0x2a], u16le(width), u16le(height));
	const w = width - 1;
	const h = height - 1;
	return bytes(head, [
		0x2f,
		w & 0xff,
		((w >> 8) & 0x3f) | ((h & 0x3) << 6),
		(h >> 2) & 0xff,
		(h >> 10) & 0xf,
		0,
		0,
		0,
		0,
		0,
	]);
}

function avif(width: number, height: number): Uint8Array {
	return bytes(
		u32(24),
		ascii("ftypavif"),
		[0, 0, 0, 0],
		ascii("mif1avif"),
		Array.from({ length: 20 }, () => 0),
		u32(20),
		ascii("ispe"),
		[0, 0, 0, 0],
		u32(width),
		u32(height),
	);
}

describe("what a file is", () => {
	it("goes by its bytes, never its name or what it claims", () => {
		expect(sniffImage(PNG)).toBe("image/png");
		expect(sniffImage(jpeg(10, 10))).toBe("image/jpeg");
		expect(sniffImage(gif(3, 2))).toBe("image/gif");
		expect(sniffImage(webp("VP8X", 3, 2))).toBe("image/webp");
		expect(sniffImage(avif(3, 2))).toBe("image/avif");
		expect(sniffImage(ascii("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
		expect(sniffImage(ascii("%PDF-1.7"))).toBeNull();
		expect(sniffImage(new Uint8Array())).toBeNull();
	});

	it("knows SVG when it sees it, XML prologue and all", () => {
		expect(looksLikeSvg(ascii("  <svg width='1'></svg>"))).toBe(true);
		expect(looksLikeSvg(ascii("<?xml version='1.0'?>\n<svg/>"))).toBe(true);
		expect(looksLikeSvg(ascii("<html></html>"))).toBe(false);
	});

	it("reads every kind's size from its header", () => {
		expect(readImageSize(PNG, "image/png")).toEqual({ width: 1, height: 1 });
		expect(readImageSize(jpeg(640, 480), "image/jpeg")).toEqual({ width: 640, height: 480 });
		expect(readImageSize(gif(300, 200), "image/gif")).toEqual({ width: 300, height: 200 });
		for (const kind of ["VP8 ", "VP8L", "VP8X"] as const) {
			expect(readImageSize(webp(kind, 1234, 567), "image/webp")).toEqual({
				width: 1234,
				height: 567,
			});
		}
		expect(readImageSize(avif(2000, 1000), "image/avif")).toEqual({ width: 2000, height: 1000 });
		// Cut short, or nonsense: unreadable.
		expect(readImageSize(PNG.slice(0, 12), "image/png")).toBeNull();
		expect(readImageSize(bytes([0xff, 0xd8, 0x12, 0x34]), "image/jpeg")).toBeNull();
	});
});

describe("what the server keeps", () => {
	it("takes raster files with sizes it can read", () => {
		expect(checkImageFile(PNG)).toEqual({ type: "image/png", width: 1, height: 1 });
		expect(checkImageFile(gif(4096, 4096))).toMatchObject({ type: "image/gif" });
	});

	it("refuses SVG, other files, and pictures too big to keep or decode", () => {
		expect(checkImageFile(ascii("<svg/>"))).toMatchObject({ reason: "type" });
		expect(checkImageFile(ascii("hello"))).toMatchObject({ reason: "type" });
		expect(checkImageFile(bytes(PNG.slice(0, 16)))).toMatchObject({ reason: "unreadable" });
		expect(checkImageFile(gif(4097, 10))).toMatchObject({ reason: "dimensions" });
		const big = new Uint8Array(IMAGE_LIMITS.bytes + 1);
		big.set(PNG);
		const refused = checkImageFile(big);
		expect(refused).toMatchObject({ reason: "size" });
		expect("message" in refused && refused.message).toMatch(/10 MB/);
	});

	it("names a file by the SHA-256 of its bytes, so the same file is one file", async () => {
		const hash = await hashImage(PNG);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(await hashImage(PNG.slice())).toBe(hash);
		expect(await hashImage(gif(1, 1))).not.toBe(hash);
	});
});

describe("placing images", () => {
	it("places one at its own size, shrunk to fit, never too small to grab", () => {
		expect(placedSize({ w: 300, h: 200 })).toEqual({ w: 300, h: 200 });
		expect(placedSize({ w: 2560, h: 1600 })).toEqual({ w: 480, h: 300 });
		expect(placedSize({ w: 1000, h: 4000 })).toEqual({ w: 100, h: 400 });
		const banner = placedSize({ w: 4000, h: 20 });
		expect(Math.min(banner.w, banner.h)).toBeGreaterThanOrEqual(24);
		// A retina screenshot lands at the size it was on screen.
		expect(placedSize({ w: 800, h: 600 }, { w: 1000, h: 1000 }, 2)).toEqual({ w: 400, h: 300 });
	});

	it("lays several out in rows about as many as columns, centred where they were dropped", () => {
		const sizes = [
			{ w: 100, h: 80 },
			{ w: 100, h: 120 },
			{ w: 100, h: 100 },
			{ w: 100, h: 100 },
			{ w: 100, h: 100 },
		];
		const spots = layoutImages(sizes, { x: 0, y: 0 });
		expect(spots).toHaveLength(5);
		// Three to a row: the second row starts below the first's tallest.
		expect(spots.slice(0, 3).map((s) => s.y)).toEqual([spots[0]?.y, spots[0]?.y, spots[0]?.y]);
		expect(spots[3]?.y).toBe((spots[0]?.y ?? 0) + 120 + 24);
		// Nothing overlaps.
		for (let i = 0; i < 5; i++) {
			for (let j = i + 1; j < 5; j++) {
				const a = { ...spots[i], ...sizes[i] } as { x: number; y: number; w: number; h: number };
				const b = { ...spots[j], ...sizes[j] } as { x: number; y: number; w: number; h: number };
				expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(
					true,
				);
			}
		}
		// The whole block is centred.
		const left = Math.min(...spots.map((s) => s.x));
		const right = Math.max(...spots.map((s, i) => s.x + (sizes[i]?.w ?? 0)));
		expect(left + right).toBeCloseTo(0, 0);
		expect(layoutImages([], { x: 0, y: 0 })).toEqual([]);
	});
});

describe("resizing", () => {
	const start = { x: 0, y: 0, w: 200, h: 100 };

	it("keeps proportions from a corner, whichever way it's pulled further", () => {
		expect(keepAspect(start, { x: 0, y: 0, w: 300, h: 110 }, "se")).toEqual({
			x: 0,
			y: 0,
			w: 300,
			h: 150,
		});
		// From the top left, the bottom right stays put.
		expect(keepAspect(start, { x: -100, y: 0, w: 300, h: 100 }, "nw")).toEqual({
			x: -100,
			y: -50,
			w: 300,
			h: 150,
		});
	});

	it("scales the other way about the middle from an edge", () => {
		expect(keepAspect(start, { x: 0, y: 0, w: 200, h: 200 }, "s")).toEqual({
			x: -100,
			y: 0,
			w: 400,
			h: 200,
		});
		expect(keepAspect(start, { x: 0, y: 0, w: 100, h: 100 }, "e")).toEqual({
			x: 0,
			y: 25,
			w: 100,
			h: 50,
		});
	});

	it("never goes below the smallest an image may be", () => {
		const tiny = keepAspect(start, { x: 0, y: 0, w: 10, h: 5 }, "se");
		expect(Math.min(tiny.w, tiny.h)).toBe(24);
		expect(tiny.w / tiny.h).toBeCloseTo(2);
	});
});

describe("an image shape", () => {
	const now = Date.parse("2026-10-12T12:00:00Z");
	const upload = (ago: number) => ({
		by: "Ada",
		client: 1,
		at: new Date(now - ago).toISOString(),
	});
	const hash = "a".repeat(64);

	it("draws ready, arriving, abandoned or missing", () => {
		expect(imageState({ image: hash }, now)).toBe("ready");
		expect(imageState({ upload: upload(1000) }, now)).toBe("uploading");
		// A copy from another board is arriving though it has its hash.
		expect(imageState({ image: hash, upload: upload(1000) }, now)).toBe("uploading");
		expect(imageState({ upload: upload(IMAGE_UPLOAD_STALE_MS + 1) }, now)).toBe("interrupted");
		expect(imageState({ image: hash, upload: upload(IMAGE_UPLOAD_STALE_MS + 1) }, now)).toBe(
			"ready",
		);
		expect(imageState({}, now)).toBe("missing");
		expect(imageState({ image: "not a hash" }, now)).toBe("missing");
	});

	it("is its own box, sized like a widget", () => {
		const doc = new Y.Doc();
		addImageShape(doc, "i", {
			x: 10.4,
			y: 20.6,
			w: 300,
			h: 200,
			iw: 1200,
			ih: 800,
			mime: "image/png",
			upload: upload(0),
			blur: "data:image/webp;base64,AAAA",
			alt: "  A   chart\nof sizes ",
		});
		const shape = readShape(shapesMap(doc).get("i") as Y.Map<unknown>);
		expect(boxOf("i", shape)).toEqual({ x: 10, y: 21, w: 300, h: 200 });
		expect(shape.alt).toBe("A chart of sizes");
		expect(imageRefs(doc).size).toBe(0);

		// Its file arrives: it shows it, and stops saying it's uploading.
		expect(finishImage(doc, "i", hash)).toBe(true);
		const done = readShape(shapesMap(doc).get("i") as Y.Map<unknown>);
		expect(done.image).toBe(hash);
		expect(done.upload).toBeUndefined();
		expect(done.blur).toBeUndefined();
		expect([...imageRefs(doc)]).toEqual([hash]);
		expect(finishImage(doc, "gone", hash)).toBe(false);
	});

	it("keeps alt text to a paragraph, within its limit", () => {
		expect(cleanAlt(" one\n\ntwo ")).toBe("one two");
		expect(cleanAlt("x".repeat(5000))).toHaveLength(IMAGE_LIMITS.alt);
	});

	it("travels by copy and paste with its file, but never someone's upload", () => {
		const doc = new Y.Doc();
		addImageShape(doc, "ready", {
			x: 0,
			y: 0,
			w: 10,
			h: 10,
			iw: 1,
			ih: 1,
			mime: "image/png",
			image: hash,
		});
		addImageShape(doc, "going", {
			x: 0,
			y: 0,
			w: 10,
			h: 10,
			iw: 1,
			ih: 1,
			mime: "image/png",
			upload: upload(0),
			blur: "data:image/webp;base64,AAAA",
		});
		const other = new Y.Doc();
		const pasted = pasteShapes(other, copyShapes(doc, ["ready", "going"]), { x: 0, y: 0 });
		const [first, second] = pasted.map((id) =>
			readShape(shapesMap(other).get(id) as Y.Map<unknown>),
		);
		expect(first?.image).toBe(hash);
		expect(second?.upload).toBeUndefined();
		expect(second?.blur).toBeUndefined();
	});
});
