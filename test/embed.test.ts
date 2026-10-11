// Board images (#57): addresses and snippets, the scene an image draws and
// what it leaves out, and drawing it with Satori (in Node, with the same
// WebAssembly and fonts the Worker bundles).

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import satori, { init } from "satori/standalone";
import { drawPreview, drawScene, stickyFontSize } from "../src/server/embeds/draw.ts";
import type { Card, MissingCard } from "../src/shared/cards.ts";
import {
	EMBED,
	OG_SIZE,
	type Scene,
	type SceneItem,
	buildScene,
	clean,
	countBoard,
	describeBoard,
	embedPath,
	embedQuery,
	embedSnippet,
	imageSize,
	parseEmbedQuery,
	previewFrame,
} from "../src/shared/embed.ts";
import type { ShapeProps } from "../src/shared/shapes.ts";

const PUBLIC_KEY = "github.com/withastro/astro#12";
const PRIVATE_KEY = "github.com/acme/secret#5";

function card(key: string, overrides: Partial<Card> = {}): Card {
	const [repo = "", item = ""] = key.replace("github.com/", "").split(/(?=#)/);
	return {
		key,
		forge: "github",
		host: "github.com",
		repo,
		item,
		kind: "issue",
		title: "Images break on Windows",
		state: "open",
		stateReason: null,
		labels: [{ name: "bug", color: "d73a4a" }],
		assignees: [],
		author: null,
		comments: 2,
		reactions: 0,
		url: `https://github.com/${repo}/issues/${item.slice(1)}`,
		updatedAt: "2026-10-01T00:00:00Z",
		visibility: "public",
		...overrides,
	};
}

const placeholder: MissingCard = { key: PRIVATE_KEY, missing: true, reason: "private" };

function board(): Map<string, ShapeProps> {
	return new Map<string, ShapeProps>([
		["s1", { type: "section", x: 0, y: 0, w: 900, h: 500, z: "a0", title: "Now", color: "blue" }],
		["c1", { type: "card", x: 40, y: 60, z: "a1", parent: "s1", ref: PUBLIC_KEY }],
		["c2", { type: "card", x: 320, y: 60, z: "a2", parent: "s1", ref: PRIVATE_KEY }],
		[
			"n1",
			{ type: "sticky", x: 40, y: 260, z: "a3", parent: "s1", text: "Ship it 🚀", color: "pink" },
		],
		// Face down: made in silent mode. Its text is never in the document,
		// but even if a client wrote some, an image mustn't show it.
		[
			"n2",
			{
				type: "sticky",
				x: 240,
				y: 260,
				z: "a4",
				parent: "s1",
				silent: "session",
				text: "Hidden thought",
			},
		],
		[
			"w1",
			{
				type: "widget",
				widget: "list",
				x: 1000,
				y: 0,
				z: "a5",
				w: 360,
				h: 440,
				config: { title: "Open bugs" },
			} as ShapeProps,
		],
		[
			"k1",
			{
				type: "connector",
				x: 0,
				y: 0,
				z: "a6",
				from: { x: 0, y: 0, shape: "c1" },
				to: { x: 0, y: 0, shape: "c2" },
				label: "blocks",
			} as ShapeProps,
		],
	]);
}

function cards(...entries: (Card | MissingCard)[]): Map<string, Card | MissingCard> {
	return new Map(entries.map((entry) => [entry.key, entry]));
}

const byId = (scene: Scene, id: string) => scene.items.find((item) => item.id === id);

describe("image addresses", () => {
	it("read the options from the query, and refuse anything malformed", () => {
		expect(parseEmbedQuery(new URLSearchParams())).toEqual({
			region: { kind: "board" },
			theme: "light",
			width: null,
		});
		expect(parseEmbedQuery(new URLSearchParams("section=abc&theme=dark&width=800"))).toEqual({
			region: { kind: "section", id: "abc" },
			theme: "dark",
			width: 800,
		});
		expect(parseEmbedQuery(new URLSearchParams("x=-10&y=20&w=300&h=200"))).toMatchObject({
			region: { kind: "rect", rect: { x: -10, y: 20, w: 300, h: 200 } },
		});
		for (const bad of [
			"theme=blue",
			"width=10",
			"width=99999",
			"width=1.5",
			"x=1&y=2&w=3",
			"x=1&y=2&w=10&h=10",
			"x=a&y=0&w=100&h=100",
			"section=a&x=0",
			"section=../../etc",
			`w=${EMBED.maxSide + 1}&h=100&x=0&y=0`,
		]) {
			expect(parseEmbedQuery(new URLSearchParams(bad)), bad).toBeNull();
		}
	});

	it("write canonical queries that read back the same", () => {
		const options = {
			region: { kind: "rect" as const, rect: { x: 10.4, y: -3.6, w: 400.2, h: 300 } },
			theme: "dark" as const,
			width: 640,
		};
		const query = embedQuery(options);
		expect(query).toBe("x=10&y=-4&w=401&h=300&theme=dark&width=640");
		expect(parseEmbedQuery(new URLSearchParams(query))).toEqual({
			...options,
			region: { kind: "rect", rect: { x: 10, y: -4, w: 401, h: 300 } },
		});
		expect(embedPath("abc", "svg", {})).toBe("/embed/abc.svg");
		expect(embedPath("abc", "png", { region: { kind: "section", id: "s1" } })).toBe(
			"/embed/abc.png?section=s1",
		);
	});

	it("copy as Markdown, HTML, or a picture that follows the reader's theme", () => {
		const base = {
			origin: "https://tack.example",
			board: "abc",
			link: "https://tack.example/b/abc/plans",
			title: 'Plans [Q4] "draft"',
			region: { kind: "board" as const },
			image: "svg" as const,
		};
		expect(embedSnippet({ ...base, format: "markdown", theme: "light" })).toBe(
			'[![Plans \\[Q4\\] "draft" on Tack](https://tack.example/embed/abc.svg)](https://tack.example/b/abc/plans)',
		);
		expect(embedSnippet({ ...base, format: "html", theme: "dark" })).toBe(
			'<a href="https://tack.example/b/abc/plans"><img alt="Plans [Q4] &quot;draft&quot; on Tack" src="https://tack.example/embed/abc.svg?theme=dark"></a>',
		);
		const picture = embedSnippet({ ...base, format: "markdown", theme: "auto" });
		expect(picture).toContain(
			'<source media="(prefers-color-scheme: dark)" srcset="https://tack.example/embed/abc.svg?theme=dark">',
		);
		expect(picture).toContain('src="https://tack.example/embed/abc.svg"');
	});
});

describe("the scene", () => {
	it("draws public cards, and private ones as nothing but a placeholder", () => {
		const scene = buildScene(board(), cards(card(PUBLIC_KEY), placeholder), { kind: "board" });
		expect(byId(scene, "c1")).toMatchObject({
			kind: "card",
			card: { status: "ok", ref: "astro#12", title: "Images break on Windows", state: "open" },
		});
		expect(byId(scene, "c2")).toMatchObject({ kind: "card", card: { status: "private" } });
		// Not even the repository's name.
		expect(JSON.stringify(scene)).not.toContain("secret");
	});

	it("never draws a card that isn't known to be public, whatever it's given", () => {
		const leaked = card(PRIVATE_KEY, { title: "Secret roadmap", visibility: "private" });
		const { visibility: _, ...unknown } = card(PRIVATE_KEY, { title: "Secret roadmap" });
		for (const entry of [leaked, unknown as Card]) {
			const scene = buildScene(board(), cards(card(PUBLIC_KEY), entry), { kind: "board" });
			expect(byId(scene, "c2")).toMatchObject({ card: { status: "private" } });
			expect(JSON.stringify(scene)).not.toContain("Secret roadmap");
		}
	});

	it("draws face-down stickies face down, and widgets without their results", () => {
		const scene = buildScene(board(), cards(card(PUBLIC_KEY), placeholder), { kind: "board" });
		expect(byId(scene, "n2")).toMatchObject({ kind: "sticky", text: null });
		expect(JSON.stringify(scene)).not.toContain("Hidden thought");
		expect(byId(scene, "n1")).toMatchObject({ kind: "sticky", text: "Ship it" });
		expect(byId(scene, "w1")).toEqual({
			kind: "widget",
			id: "w1",
			rect: { x: 1000, y: 0, w: 360, h: 440 },
			label: "List",
			title: "Open bugs",
		});
	});

	it("puts sections first and lines under shapes", () => {
		const scene = buildScene(board(), cards(card(PUBLIC_KEY), placeholder), { kind: "board" });
		const kinds = scene.items.map((item) => item.kind);
		expect(kinds[0]).toBe("section");
		expect(kinds.indexOf("connector")).toBeLessThan(kinds.indexOf("card"));
		const line = byId(scene, "k1") as Extract<SceneItem, { kind: "connector" }>;
		expect(line.d).toMatch(/^M/);
		expect(line.heads).toHaveLength(1);
		expect(line.label).toBe("blocks");
	});

	it("frames the whole board, a section, or an area", () => {
		const all = buildScene(board(), cards(), { kind: "board" });
		expect(all.frame).toEqual({
			x: -EMBED.pad,
			// The section's title sits 34 units above it.
			y: -34 - EMBED.pad,
			w: 1360 + EMBED.pad * 2,
			h: 534 + EMBED.pad * 2,
		});

		const section = buildScene(board(), cards(), { kind: "section", id: "s1" });
		expect(section.frame).toEqual({ x: -24, y: -58, w: 948, h: 582 });
		expect(byId(section, "w1")).toBeUndefined();

		const area = buildScene(board(), cards(), {
			kind: "rect",
			rect: { x: 1000, y: 0, w: 400, h: 400 },
		});
		expect(area.items.map((item) => item.id)).toEqual(["w1"]);

		const gone = buildScene(board(), cards(), { kind: "section", id: "nope" });
		expect(gone).toMatchObject({ missing: true, empty: true, items: [] });
		expect(buildScene(new Map(), cards(), { kind: "board" })).toMatchObject({ empty: true });
	});

	it("draws lists as rows, private items in them as placeholders", () => {
		const shapes = board();
		shapes.set("s1", { ...shapes.get("s1")!, display: "list" });
		const scene = buildScene(shapes, cards(card(PUBLIC_KEY), placeholder), {
			kind: "section",
			id: "s1",
		});
		expect(byId(scene, "c1")).toMatchObject({
			kind: "row",
			mode: "row",
			text: "Images break on Windows",
			ref: "astro#12",
			face: "card",
		});
		expect(byId(scene, "c2")).toMatchObject({
			kind: "row",
			text: "Private item",
			ref: null,
			face: "private",
		});
		expect(byId(scene, "n2")).toMatchObject({ kind: "row", text: "", face: "hidden" });
		expect(byId(scene, "s1")).toMatchObject({ kind: "section", display: true });
	});

	it("keeps text the fonts can draw", () => {
		expect(clean("Ship it 🚀 → café 日本  łódź")).toBe("Ship it -> café łódź");
		expect(clean("  two \n lines ")).toBe("two\n lines");
	});
});

describe("link previews", () => {
	it("describe what's on the board, naming only public repositories", () => {
		const shapes = board();
		const counts = countBoard(shapes, cards(card(PUBLIC_KEY), placeholder));
		expect(counts).toEqual({
			cards: 2,
			stickies: 2,
			sections: 1,
			decisions: 0,
			repos: ["withastro/astro"],
		});
		expect(describeBoard(counts)).toBe(
			"A board with 2 cards, 2 stickies and 1 section from withastro/astro, on Tack.",
		);
		expect(describeBoard(countBoard(new Map(), new Map()))).toBe("An empty board, on Tack.");
	});

	it("fit the board above the title, at 1200 × 630", () => {
		const frame = previewFrame({ x: 0, y: 0, w: 1000, h: 1000 });
		expect(frame.w / frame.h).toBeCloseTo(OG_SIZE.width / OG_SIZE.height);
		expect(frame.y).toBeCloseTo(0);
	});
});

describe("image sizes", () => {
	it("are the width asked for, or a natural one, never too tall", () => {
		expect(imageSize({ x: 0, y: 0, w: 800, h: 400 }, null)).toEqual({ width: 800, height: 400 });
		expect(imageSize({ x: 0, y: 0, w: 5000, h: 2500 }, null)).toEqual({ width: 1200, height: 600 });
		expect(imageSize({ x: 0, y: 0, w: 100, h: 100 }, null)).toEqual({ width: 240, height: 240 });
		expect(imageSize({ x: 0, y: 0, w: 500, h: 10_000 }, 1000)).toEqual({
			width: 120,
			height: 2400,
		});
	});

	it("fit sticky text to the paper", () => {
		expect(stickyFontSize("Hi", { w: 144, h: 144 })).toBe(24);
		expect(stickyFontSize("x".repeat(400), { w: 144, h: 144 })).toBe(12);
	});
});

describe("drawing", () => {
	const fonts = (
		[
			"geist-400",
			"geist-600",
			"geist-ext-400",
			"geist-ext-600",
			"shantell-400",
			"bricolage-700",
		] as const
	).map((name) => {
		const [family = "", weight = "400"] = name.split(/-(?=\d)/);
		const names: Record<string, string> = {
			geist: "Geist",
			"geist-ext": "GeistExt",
			shantell: "Shantell",
			bricolage: "Bricolage",
		};
		return {
			name: names[family] ?? family,
			data: readFileSync(`src/server/embeds/fonts/${name}.woff.bin`),
			weight: Number(weight) as 400 | 600 | 700,
			style: "normal" as const,
		};
	});

	beforeAll(async () => {
		await init(readFileSync("node_modules/satori/yoga.wasm"));
	});

	const render = (element: ReturnType<typeof drawScene>, width: number, height: number) =>
		satori(element as never, { width, height, fonts });

	it("draws every kind of shape, in both themes, close up and zoomed out", async () => {
		const shapes = board();
		shapes.set("d1", {
			type: "decision",
			x: 600,
			y: 260,
			z: "b0",
			title: "Use Satori",
			text: "Live images.",
			status: "decided",
		} as ShapeProps);
		shapes.set("a1", {
			type: "action",
			x: 600,
			y: 520,
			z: "b1",
			text: "Write docs",
			owner: { login: "ascorbic" },
			due: "2026-10-14",
		} as ShapeProps);
		shapes.set("t1", { type: "text", x: 0, y: -80, z: "b2", text: "Planning", size: "xl" });
		const scene = buildScene(
			shapes,
			cards(card(PUBLIC_KEY, { kind: "pull", state: "merged" }), placeholder),
			{ kind: "board" },
		);
		for (const theme of ["light", "dark"] as const) {
			for (const width of [1200, 300]) {
				const size = imageSize(scene.frame, width);
				const svg = await render(
					drawScene(scene, { theme, ...size, badge: "Plans" }),
					size.width,
					size.height,
				);
				expect(svg).toMatch(/^<svg width="\d+" height="\d+"/);
				expect(svg).not.toContain("Hidden thought");
			}
		}
		const preview = await render(
			drawPreview(
				{ ...scene, frame: previewFrame(scene.frame) },
				{ theme: "light", ...OG_SIZE, title: "Plans", subtitle: "A board" },
			),
			OG_SIZE.width,
			OG_SIZE.height,
		);
		expect(preview).toMatch(/^<svg width="1200" height="630"/);
	});

	it("draws an empty board, and a section that's gone, with a note", async () => {
		for (const scene of [
			buildScene(new Map(), new Map(), { kind: "board" }),
			buildScene(board(), new Map(), { kind: "section", id: "nope" }),
		]) {
			const size = imageSize(scene.frame, null);
			const svg = await render(
				drawScene(scene, { theme: "light", ...size, badge: "Plans" }),
				size.width,
				size.height,
			);
			expect(svg.length).toBeGreaterThan(1000);
		}
	});
});
