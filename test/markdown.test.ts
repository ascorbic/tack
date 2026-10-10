import { describe, expect, it } from "vite-plus/test";
import { backlinkBody } from "../src/shared/backlinks.ts";
import { parseInline, safeUrl } from "../src/client/changes/inline.ts";

// The push sheet's preview of what a push writes (#70): inline Markdown,
// parsed into a tree the preview renders as React elements.

const text = (value: string) => ({ type: "text", text: value });

describe("parseInline", () => {
	it("reads a linked image as an image inside a link", () => {
		expect(
			parseInline("[![The board](https://t.example/snapshots/f00.png)](https://t.example/b/1)"),
		).toEqual([
			{
				type: "link",
				href: "https://t.example/b/1",
				children: [{ type: "image", src: "https://t.example/snapshots/f00.png", alt: "The board" }],
			},
		]);
	});

	it("reads a backlink comment with a snapshot", () => {
		const body = backlinkBody({
			boardUrl: "https://t.example/b/1/plan",
			boardTitle: "5.0 *planning*",
			snapshotUrl: "https://t.example/snapshots/f00.png",
		});
		const [line, snapshot] = body.split("\n\n").map((part) => parseInline(part));
		expect(line).toEqual([
			text("This is on "),
			{
				type: "link",
				href: "https://t.example/b/1/plan",
				// The escaped asterisks are literal, not emphasis.
				children: [{ type: "strong", children: [text("5.0 *planning*")] }],
			},
			text(" in Tack."),
		]);
		expect(snapshot).toEqual([
			{
				type: "link",
				href: "https://t.example/b/1/plan",
				children: [
					{
						type: "image",
						src: "https://t.example/snapshots/f00.png",
						alt: "The board around this item",
					},
				],
			},
		]);
	});

	it("reads images and links, with titles and text around them", () => {
		expect(
			parseInline('See ![a chart](https://x.dev/c.png "Chart") and [docs](https://x.dev/d).'),
		).toEqual([
			text("See "),
			{ type: "image", src: "https://x.dev/c.png", alt: "a chart", title: "Chart" },
			text(" and "),
			{ type: "link", href: "https://x.dev/d", children: [text("docs")] },
			text("."),
		]);
		expect(parseInline("[a (b)](https://x.dev/wiki/A_(b))")).toEqual([
			{ type: "link", href: "https://x.dev/wiki/A_(b)", children: [text("a (b)")] },
		]);
		expect(parseInline("<https://x.dev/a> and https://x.dev/b.")).toEqual([
			{ type: "link", href: "https://x.dev/a", children: [text("https://x.dev/a")] },
			text(" and "),
			{ type: "link", href: "https://x.dev/b", children: [text("https://x.dev/b")] },
			text("."),
		]);
	});

	it("doesn't link a link's label again", () => {
		expect(parseInline("[https://x.dev/a](https://x.dev/b)")).toEqual([
			{ type: "link", href: "https://x.dev/b", children: [text("https://x.dev/a")] },
		]);
	});

	it("keeps only http(s) URLs", () => {
		expect(parseInline("[click](javascript:alert(1))")).toEqual([
			{ type: "link", href: undefined, children: [text("click")] },
		]);
		expect(parseInline("![x](data:image/svg+xml,<svg>)")).toEqual([
			{ type: "image", src: undefined, alt: "x" },
		]);
		expect(parseInline("![x](data:image/png;base64,AAAA)")).toEqual([
			{ type: "image", src: undefined, alt: "x" },
		]);
		expect(parseInline("[![x](/rel.png)](//evil.example)")).toEqual([
			{ type: "link", href: undefined, children: [{ type: "image", src: undefined, alt: "x" }] },
		]);
		expect(safeUrl(" https://x.dev ")).toBe("https://x.dev");
		expect(safeUrl("HTTPS://x.dev")).toBe("HTTPS://x.dev");
		expect(safeUrl("https://")).toBeUndefined();
		expect(safeUrl("ftp://x.dev")).toBeUndefined();
		expect(safeUrl("blob:https://x.dev/1")).toBeUndefined();
	});

	it("leaves HTML as text", () => {
		expect(parseInline('<img src=x onerror="alert(1)"> <b>hi</b>')).toEqual([
			text('<img src=x onerror="alert(1)"> <b>hi</b>'),
		]);
	});

	it("reads code, emphasis, mentions and references", () => {
		expect(parseInline("**bold _and_ more** `a **b**` @octo-cat #12 a@b.dev x#3")).toEqual([
			{
				type: "strong",
				children: [text("bold "), { type: "em", children: [text("and")] }, text(" more")],
			},
			text(" "),
			{ type: "code", text: "a **b**" },
			text(" "),
			{ type: "mention", text: "@octo-cat" },
			text(" "),
			{ type: "ref", text: "#12" },
			text(" a@b.dev x#3"),
		]);
		expect(parseInline("snake_case_name")).toEqual([text("snake_case_name")]);
	});

	it("leaves unfinished syntax as it is", () => {
		expect(parseInline("[not a link] ![nor](an image *emphasis")).toEqual([
			text("[not a link] ![nor](an image *emphasis"),
		]);
	});
});
