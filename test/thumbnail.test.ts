// Thumbnails' sketches of link cards (each a card tinted with its site's hue,
// neutral for a page that couldn't be read, and taller with a picture), and
// of sections shown as lists and mini cards.

import { describe, expect, it } from "vite-plus/test";
import { linkHue } from "../src/shared/linkPreview.ts";
import { sketch } from "../src/shared/thumbnail.ts";

const READ_AT = "2026-10-01T00:00:00Z";

describe("thumbnails of link cards", () => {
	it("sketch each as a link, tinted by its site, taller with a picture", () => {
		const thumbnail = sketch([
			{
				id: "a",
				type: "link",
				x: 0,
				y: 0,
				url: "https://unpic.pics/img",
				preview: {
					status: "ok",
					title: "Unpic",
					image: "https://unpic.pics/og.png",
					fetchedAt: READ_AT,
				},
			},
			{
				id: "b",
				type: "link",
				x: 300,
				y: 0,
				url: "https://github.com/ascorbic/cirrus/wiki",
				preview: { status: "failed", fetchedAt: READ_AT },
			},
			{ id: "c", type: "link", x: 600, y: 0, url: "https://tack.social/" },
		]);
		const shapes = thumbnail?.shapes ?? [];
		expect(shapes.map((shape) => shape[0])).toEqual(["link", "link", "link"]);
		const [read, failed, unread] = [...shapes].sort((a, b) => a[1] - b[1]);
		expect(read?.[5]).toBe(String(linkHue("https://unpic.pics/img")));
		expect(failed?.[5]).toBe("");
		expect(unread?.[5]).toBe(String(linkHue("https://tack.social/")));
		expect(read![4]).toBeGreaterThan(unread![4]);
	});

	it("leave link cards in a stack to the stack", () => {
		const thumbnail = sketch([
			{ id: "s", type: "stack", x: 0, y: 0 },
			{ id: "a", type: "link", x: 10, y: 10, url: "https://unpic.pics/", stack: "s" },
			{ id: "b", type: "sticky", x: 10, y: 10, color: "pink", stack: "s" },
		]);
		expect(thumbnail?.shapes.map((shape) => shape[0])).toEqual(["stack"]);
	});
});

describe("thumbnails of lists and mini cards", () => {
	const shapes = (display: "list" | "mini") => [
		{ id: "s", type: "section", x: 0, y: 0, w: 480, h: 900, color: "green", display },
		{ id: "a", type: "card", x: 40, y: 600, ref: "github.com/ascorbic/unpic#1", parent: "s" },
		{ id: "b", type: "sticky", x: 300, y: 600, color: "pink", text: "Docs", parent: "s" },
	];

	it("draw what's in a list as its rows, and the list as tall as they are", () => {
		const thumbnail = sketch(shapes("list"), () => "open");
		const kinds = thumbnail?.shapes.map((shape) => [shape[0], shape[5]]);
		expect(kinds).toEqual([
			["frame", "green"],
			["row", "open"],
			["row", "sticky:pink"],
		]);
		// Two rows, not the 900 it was given: wider than it's tall.
		expect(thumbnail!.width).toBeGreaterThan(thumbnail!.height);
	});

	it("draw a grid of mini cards as tiles", () => {
		const thumbnail = sketch(shapes("mini"));
		expect(thumbnail?.shapes.map((shape) => shape[0])).toEqual(["frame", "tile", "tile"]);
	});

	it("outline an empty one at its own size only when asked, as a template's", () => {
		const empty = [{ id: "s", type: "section", x: 0, y: 0, w: 480, h: 900, display: "list" }];
		// As the board draws it: as tall as its empty state, its placeholder rows outlined.
		const plain = sketch(empty);
		expect(plain?.shapes.map((shape) => [shape[0], shape[5]])).toEqual([
			["frame", ""],
			["row", "outline"],
			["row", "outline"],
			["row", "outline"],
		]);
		expect(plain!.width).toBeGreaterThan(plain!.height);
		const outlined = sketch(empty, undefined, { outlineEmpty: true });
		expect(outlined?.shapes.filter((shape) => shape[0] === "row")).toHaveLength(4);
		expect(outlined!.height).toBeGreaterThan(outlined!.width);
	});
});
