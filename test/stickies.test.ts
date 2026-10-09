import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { FitCache, STICKY_FONT_SIZES, fitFontSize, fitsBox } from "../src/client/textFit.ts";
import { addShape, nextZ, shapesMap, updateShapes } from "../src/shared/shapes.ts";

describe("fitFontSize", () => {
	// A stand-in for measuring: text of `chars` characters fits when the
	// size is at most `limit`.
	const fitsBelow = (limit: number) => {
		const tried: number[] = [];
		const fits = (size: number) => {
			tried.push(size);
			return size <= limit;
		};
		return { fits, tried };
	};

	it("picks the largest size that fits", () => {
		expect(fitFontSize(fitsBelow(100).fits, STICKY_FONT_SIZES)).toBe(28);
		expect(fitFontSize(fitsBelow(20).fits, STICKY_FONT_SIZES)).toBe(18);
		expect(fitFontSize(fitsBelow(14.5).fits, STICKY_FONT_SIZES)).toBe(14.5);
	});

	it("falls back to the smallest size when nothing fits", () => {
		expect(fitFontSize(fitsBelow(5).fits, STICKY_FONT_SIZES)).toBe(11);
	});

	it("measures only a few sizes", () => {
		const { fits, tried } = fitsBelow(16);
		fitFontSize(fits, STICKY_FONT_SIZES);
		expect(tried.length).toBeLessThanOrEqual(Math.ceil(Math.log2(STICKY_FONT_SIZES.length)) + 1);
	});

	it("only ever shrinks as text grows", () => {
		// Pretend each character needs a little more room.
		let previous = Number.POSITIVE_INFINITY;
		for (let chars = 1; chars < 400; chars += 7) {
			const size = fitFontSize((s) => s * Math.sqrt(chars) < 120, STICKY_FONT_SIZES);
			expect(size).toBeLessThanOrEqual(previous);
			previous = size;
		}
	});

	it("needs sizes to choose from", () => {
		expect(() => fitFontSize(() => true, [])).toThrow();
	});
});

describe("fitsBox", () => {
	it("allows half a pixel of rounding", () => {
		const box = { width: 144, height: 124 };
		expect(fitsBox({ width: 144, height: 124.4 }, box)).toBe(true);
		expect(fitsBox({ width: 145, height: 100 }, box)).toBe(false);
		expect(fitsBox({ width: 100, height: 126 }, box)).toBe(false);
	});
});

describe("FitCache", () => {
	it("evicts the least recently used entry", () => {
		const cache = new FitCache(2);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.get("a");
		cache.set("c", 3);
		expect(cache.get("a")).toBe(1);
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("c")).toBe(3);
		expect(cache.size).toBe(2);
	});
});

describe("updateShapes", () => {
	function board() {
		const doc = new Y.Doc();
		for (const id of ["a", "b", "c"]) {
			addShape(doc, id, { type: "sticky", text: id, color: "yellow", x: 0, y: 0, z: nextZ(doc) });
		}
		return doc;
	}

	it("changes every shape in one transaction", () => {
		const doc = board();
		let transactions = 0;
		doc.on("afterTransaction", () => transactions++);
		updateShapes(doc, ["a", "b"], { color: "pink", font: "hand" });
		expect(transactions).toBe(1);
		const shapes = shapesMap(doc);
		expect(shapes.get("a")?.get("color")).toBe("pink");
		expect(shapes.get("b")?.get("font")).toBe("hand");
		expect(shapes.get("c")?.get("color")).toBe("yellow");
	});

	it("tags the change as local, for undo", () => {
		const doc = board();
		const origins: unknown[] = [];
		doc.on("afterTransaction", (transaction: Y.Transaction) => origins.push(transaction.origin));
		updateShapes(doc, ["a"], { color: "blue" });
		expect(origins).toEqual(["local"]);
	});

	it("leaves keys that already hold the value alone", () => {
		const doc = board();
		const before = Y.encodeStateVector(doc);
		updateShapes(doc, ["a", "b", "c"], { color: "yellow" });
		expect(Y.encodeStateVector(doc)).toEqual(before);
	});

	it("removes keys set to undefined, and skips missing shapes", () => {
		const doc = board();
		updateShapes(doc, ["a", "gone"], { color: undefined });
		expect(shapesMap(doc).get("a")?.has("color")).toBe(false);
		expect(shapesMap(doc).has("gone")).toBe(false);
	});
});
