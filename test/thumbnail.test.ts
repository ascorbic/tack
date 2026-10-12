// Thumbnails' sketches of link cards: each a card tinted with its site's hue,
// neutral for a page that couldn't be read, and taller with a picture.

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
