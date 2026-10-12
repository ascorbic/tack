// Board images (#57): what a board, or a part of it, looks like to someone
// who isn't signed in, as a plain description the server draws with Satori
// (src/server/embeds/). Pure, so the scene is unit-tested in Node and the
// client can build the same addresses and snippets it copies.
//
// The privacy rules live here, in one place, and the server only ever draws
// a scene:
//
// - Cards come in as an anonymous viewer gets them (`visibleCard(entry,
//   false)`): anything from a repository that isn't known to be public is a
//   bare placeholder by then, and is drawn as "Private item", without even
//   its repository's name.
// - Stickies in silent mode have no text in the document until the reveal,
//   so they're drawn face down. Nothing else silent mode, dot votes or
//   comments keep is in the scene at all: no ballots, stamps, dots, pins or
//   threads, and no names of who wrote what.
// - Widgets are drawn as their frame and title, never their results (a
//   signed-in viewer's widget can search private repositories).
// - Staged changes, rules and history aren't drawn.
// - Link cards are drawn from the preview in the document, which is board
//   content like a sticky's text, but never with their images: the server
//   fetches nothing to draw, so where a picture would be is the site's tint.

import type { Card, CardKind, CardState, MissingCard } from "./cards.ts";
import { arrowHead, arrowTrim, readConnector, resolveEnds, routeConnector } from "./connectors.ts";
import { layoutDisplays } from "./display.ts";
import type { Point, Rect } from "./geometry.ts";
import { LINK_CARD, linkHost, linkHue, linkLabel, readPreview } from "./linkPreview.ts";
import { parseKey } from "./refs.ts";
import { NOMINAL_SIZE, readStructure } from "./sections.ts";
import type { ShapeProps } from "./shapes.ts";
import { parseSession } from "./silent.ts";
import {
	countMembers,
	excerptCount,
	nameLines,
	nameState,
	stackMembers,
	stackName,
	stackSize,
	UNTITLED_STACK,
} from "./stacks.ts";
import { textSize } from "./thumbnail.ts";
import { widgetDefinition, widgetSize } from "./widgetRegistry.ts";

export type EmbedTheme = "light" | "dark";
export type EmbedFormat = "svg" | "png";

/** What part of the board an image shows: all of it, a section (which it follows), or a fixed area. */
export type EmbedRegion =
	| { kind: "board" }
	| { kind: "section"; id: string }
	| { kind: "rect"; rect: Rect };

export interface EmbedOptions {
	region: EmbedRegion;
	theme: EmbedTheme;
	/** Width of the image in pixels; null picks one from the region. */
	width: number | null;
}

/** Limits on what an image may ask for. */
export const EMBED = {
	minWidth: 240,
	maxWidth: 2400,
	/** The tallest image drawn: taller regions are drawn narrower. */
	maxHeight: 2400,
	/** The width picked when none is asked for, at most. */
	defaultWidth: 1200,
	/** A fixed area is at most this big a side, in board units. */
	maxSide: 40_000,
	/** Space around the whole board, and around a section, in board units. */
	pad: 48,
	sectionPad: 24,
	/** Shapes drawn, at most: beyond this the largest are kept. */
	maxItems: 900,
} as const;

/** Link previews: the size social sites expect. */
export const OG_SIZE = { width: 1200, height: 630 } as const;

const DEFAULT_OPTIONS: EmbedOptions = { region: { kind: "board" }, theme: "light", width: null };

const SHAPE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Read an image's options from its address. Anything malformed is an error
 * (null) rather than quietly something else, so a typo in a README shows a
 * broken image instead of the wrong one.
 */
export function parseEmbedQuery(params: URLSearchParams): EmbedOptions | null {
	const options: EmbedOptions = { ...DEFAULT_OPTIONS };
	const theme = params.get("theme");
	if (theme !== null) {
		if (theme !== "light" && theme !== "dark") return null;
		options.theme = theme;
	}
	const width = params.get("width");
	if (width !== null) {
		const n = Number(width);
		if (!Number.isInteger(n) || n < EMBED.minWidth || n > EMBED.maxWidth) return null;
		options.width = n;
	}
	const section = params.get("section");
	const box = ["x", "y", "w", "h"].map((key) => params.get(key));
	if (section !== null) {
		if (!SHAPE_ID.test(section) || box.some((value) => value !== null)) return null;
		options.region = { kind: "section", id: section };
	} else if (box.some((value) => value !== null)) {
		const [x, y, w, h] = box.map((value) => (value === null ? Number.NaN : Number(value)));
		if (![x, y, w, h].every((n) => Number.isInteger(n))) return null;
		const rect = { x: x as number, y: y as number, w: w as number, h: h as number };
		if (rect.w < 16 || rect.h < 16 || rect.w > EMBED.maxSide || rect.h > EMBED.maxSide) return null;
		if (Math.abs(rect.x) > 1e7 || Math.abs(rect.y) > 1e7) return null;
		options.region = { kind: "rect", rect };
	}
	return options;
}

/** The query string for options, canonical (stable order, defaults left out), without `?`. */
export function embedQuery(options: Partial<EmbedOptions>): string {
	const params = new URLSearchParams();
	const region = options.region ?? DEFAULT_OPTIONS.region;
	if (region.kind === "section") params.set("section", region.id);
	if (region.kind === "rect") {
		const r = roundRect(region.rect);
		params.set("x", String(r.x));
		params.set("y", String(r.y));
		params.set("w", String(r.w));
		params.set("h", String(r.h));
	}
	if (options.theme && options.theme !== "light") params.set("theme", options.theme);
	if (options.width) params.set("width", String(options.width));
	return params.toString();
}

/** A fixed area as whole board units, at least 16 a side. */
export function roundRect(rect: Rect): Rect {
	const x = Math.round(rect.x);
	const y = Math.round(rect.y);
	return {
		x,
		y,
		w: Math.min(EMBED.maxSide, Math.max(16, Math.round(rect.x + rect.w) - x)),
		h: Math.min(EMBED.maxSide, Math.max(16, Math.round(rect.y + rect.h) - y)),
	};
}

/** An image's path: `/embed/{board}.svg?…`. */
export function embedPath(board: string, format: EmbedFormat, options: Partial<EmbedOptions>) {
	const query = embedQuery(options);
	return `/embed/${encodeURIComponent(board)}.${format}${query ? `?${query}` : ""}`;
}

/** A board's link preview image: `/og/{board}.png`. */
export function ogPath(board: string, version?: string): string {
	return `/og/${encodeURIComponent(board)}.png${version ? `?v=${encodeURIComponent(version)}` : ""}`;
}

export type SnippetFormat = "markdown" | "html";
/** One theme, or both: a `<picture>` that follows the reader's light or dark mode. */
export type SnippetTheme = EmbedTheme | "auto";

/**
 * What "Copy embed" copies: the image, linking to the board. `auto` gives
 * both themes in a `<picture>`, which GitHub honours for READMEs (HTML
 * either way, as Markdown has no way to say it).
 */
export function embedSnippet(input: {
	origin: string;
	board: string;
	/** The board's own link. */
	link: string;
	title: string;
	format: SnippetFormat;
	theme: SnippetTheme;
	region: EmbedRegion;
	image: EmbedFormat;
	width?: number | null;
}): string {
	const src = (theme: EmbedTheme) =>
		`${input.origin}${embedPath(input.board, input.image, {
			region: input.region,
			theme,
			width: input.width ?? null,
		})}`;
	const alt = `${input.title} on Tack`;
	if (input.theme === "auto") {
		return [
			`<a href="${escapeAttr(input.link)}">`,
			"  <picture>",
			`    <source media="(prefers-color-scheme: dark)" srcset="${escapeAttr(src("dark"))}">`,
			`    <img alt="${escapeAttr(alt)}" src="${escapeAttr(src("light"))}">`,
			"  </picture>",
			"</a>",
		].join("\n");
	}
	if (input.format === "html") {
		return `<a href="${escapeAttr(input.link)}"><img alt="${escapeAttr(alt)}" src="${escapeAttr(src(input.theme))}"></a>`;
	}
	return `[![${escapeMarkdown(alt)}](${src(input.theme)})](${input.link})`;
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeMarkdown(value: string): string {
	return value.replace(/([\\[\]])/g, "\\$1");
}

// --- The scene ------------------------------------------------------------------------

/** What a card shows in an image. */
export type SceneCard =
	| {
			status: "ok";
			/** `repo#123`: the repository's own name and the item. */
			ref: string;
			kind: CardKind;
			/** Discussions: an answer has been chosen. */
			answered?: boolean;
			/** Discussions: the category's name. */
			category?: string;
			title: string;
			state: CardState;
			labels: { name: string; color: string }[];
			checks: "passing" | "failing" | "pending" | null;
			comments: number;
	  }
	/** From a repository that isn't public: nothing about it at all. */
	| { status: "private" }
	/** Couldn't be loaded, or not yet: the key, which the public document has anyway. */
	| { status: "missing"; ref: string };

export type SceneItem =
	| {
			kind: "section";
			id: string;
			rect: Rect;
			title: string;
			color: string;
			silent: boolean;
			/** Showing a list or grid: drawn as a panel with its rows. */
			display: boolean;
	  }
	| {
			kind: "sticky";
			id: string;
			rect: Rect;
			color: string;
			/** Null when it's face down (silent mode). */
			text: string | null;
			font: "sans" | "hand";
	  }
	| { kind: "text"; id: string; rect: Rect; text: string; size: number; font: "sans" | "hand" }
	| { kind: "card"; id: string; rect: Rect; card: SceneCard }
	| {
			kind: "decision";
			id: string;
			rect: Rect;
			title: string;
			text: string;
			status: "proposed" | "decided" | "superseded";
	  }
	| {
			kind: "action";
			id: string;
			rect: Rect;
			text: string;
			done: boolean;
			owner: string | null;
			due: string | null;
	  }
	| { kind: "widget"; id: string; rect: Rect; label: string; title: string }
	| SceneLink
	| {
			kind: "stack";
			id: string;
			rect: Rect;
			/** Its name, or "Untitled stack". */
			name: string;
			/** The name's a suggestion (✨), not a person's. */
			suggested: boolean;
			count: number;
			/** Its first few members, a line each. */
			rows: StackRow[];
			/** How many more there are than rows. */
			more: number;
			/** The colours of the papers peeking out behind it: sticky colours, or "card". */
			papers: string[];
	  }
	| {
			kind: "connector";
			id: string;
			/** SVG path data, in board units. */
			d: string;
			heads: string[];
			color: string;
			dash: boolean;
			width: number;
			label: string;
			labelAt: Point | null;
	  }
	| {
			kind: "row";
			id: string;
			rect: Rect;
			mode: "row" | "mini" | "group";
			/** What it says: a card's title, a sticky's text, a group's name. */
			text: string;
			/** `repo#123` for cards, the host for link cards. */
			ref: string | null;
			/** A card's state, a sticky's colour, or a section's colour for groups. */
			tone: string;
			face: "card" | "sticky" | "private" | "hidden" | "group" | "other";
	  };

/**
 * A link card (links.ts): what its preview says, with the picture drawn as
 * the site's tint and initial.
 */
export interface SceneLink {
	kind: "link";
	id: string;
	rect: Rect;
	/** The page's title, or its address without the scheme. */
	title: string;
	description: string | null;
	/** The site's name, or its host. */
	site: string;
	/** The host, under the title: only when `site` is a name rather than the host. */
	host: string | null;
	/** The site's initial for its tile, or null for a bare address (drawn as a globe). */
	initial: string | null;
	/** The site's hue for its tint, or null for a page that couldn't be read (drawn neutral). */
	hue: number | null;
	/** Couldn't be read, or won't be: a quiet line where the description would be. */
	note: string | null;
	/** The page has a preview image: the tint is as tall as the image would be. */
	image: boolean;
}

/** One member of a stack, in a line. */
export type StackRow =
	| { face: "sticky"; tone: string; text: string }
	/** Face down in silent mode: its colour, nothing else. */
	| { face: "hidden"; tone: string }
	| { face: "card"; card: SceneCard }
	| { face: "link"; title: string; initial: string | null; hue: number | null };

export interface Scene {
	/** The part of the board drawn, in board units. */
	frame: Rect;
	/** In drawing order: sections, then connectors, then everything else by stacking order. */
	items: SceneItem[];
	/** Nothing on the board (or in the region). */
	empty: boolean;
	/** The region asked for isn't there: a section that's gone. */
	missing: boolean;
}

/** What's on a board, for a link preview's description. */
export interface BoardCounts {
	cards: number;
	stickies: number;
	links: number;
	sections: number;
	decisions: number;
	/** Public repositories cards come from, busiest first. */
	repos: string[];
}

type Entry = Card | MissingCard;

const STICKY_COLORS = new Set(["yellow", "pink", "blue", "green", "purple"]);
const SECTION_COLORS = new Set(["grey", "red", "orange", "yellow", "green", "blue", "purple"]);
const TEXT_PX: Record<string, number> = { s: 14, m: 20, l: 34, xl: 56 };
const CONNECTOR_WIDTH = 2;

/**
 * Lay out what an image of a board shows. `cards` must already be as an
 * anonymous viewer sees them: the scene trusts them, and only draws public
 * cards' details.
 */
export function buildScene(
	shapes: ReadonlyMap<string, ShapeProps>,
	cards: ReadonlyMap<string, Entry>,
	region: EmbedRegion,
): Scene {
	const structure = readStructure(shapes);
	const cardOf = (ref: string) => {
		const entry = cards.get(ref);
		return entry && !("missing" in entry) ? entry : undefined;
	};
	const layout = layoutDisplays(shapes, structure, { cardOf });

	// Every shape's box as drawn: a list's rows where the list puts them.
	const boxes = new Map<string, Rect>();
	for (const [id, shape] of shapes) {
		const box = shapeBox(shape, layout.slots.get(id)?.rect, layout.sections.get(id)?.box);
		if (box) boxes.set(id, box);
	}
	// A stack (#73) draws as its theme card, as big as what it shows; its
	// members aren't drawn on their own, and connectors to them end at it.
	const stacks = stackMembers(shapes);
	const stacked = new Set<string>();
	for (const [stack, members] of stacks) {
		const shape = shapes.get(stack);
		const box = boxes.get(stack);
		if (!shape || !box) continue;
		const rect = layout.slots.has(stack)
			? box
			: {
					x: box.x,
					y: box.y,
					...stackSize(members.length, nameLines(stackName(shape) ?? UNTITLED_STACK)),
				};
		boxes.set(stack, rect);
		for (const id of members) {
			stacked.add(id);
			boxes.set(id, rect);
		}
	}

	const items: SceneItem[] = [];
	const zOf = (id: string) => (typeof shapes.get(id)?.z === "string" ? shapes.get(id)!.z : "");
	const ordered = [...shapes.keys()].sort((a, b) => {
		const za = zOf(a);
		const zb = zOf(b);
		return za < zb ? -1 : za > zb ? 1 : a < b ? -1 : 1;
	});
	const depth = structure.depth;

	// Sections first, outermost first, so what's inside always draws over them.
	const sections = ordered
		.filter((id) => shapes.get(id)?.type === "section" && !layout.slots.has(id))
		.sort((a, b) => (depth.get(a) ?? 0) - (depth.get(b) ?? 0));
	for (const id of sections) {
		const shape = shapes.get(id)!;
		const rect = boxes.get(id);
		if (!rect) continue;
		items.push({
			kind: "section",
			id,
			rect,
			title: clean(shape.title ?? ""),
			color: SECTION_COLORS.has(shape.color ?? "") ? shape.color! : "grey",
			silent: parseSession(shape.silent) !== null,
			display: layout.sections.has(id),
		});
	}

	for (const id of ordered) {
		const shape = shapes.get(id)!;
		if (shape.type !== "connector") continue;
		const connector = readConnector(shape);
		if (!connector) continue;
		const { start, end } = resolveEnds(connector.from, connector.to, (shapeId) =>
			boxes.get(shapeId),
		);
		const trim = arrowTrim(CONNECTOR_WIDTH);
		const atStart = connector.arrow === "both";
		const atEnd = connector.arrow !== "none";
		const route = routeConnector(start, end, connector.route, {
			start: atStart ? trim : 0,
			end: atEnd ? trim : 0,
		});
		const heads: string[] = [];
		if (atEnd) heads.push(arrowHead(end.point, route.endAngle, CONNECTOR_WIDTH));
		if (atStart) heads.push(arrowHead(start.point, route.startAngle + Math.PI, CONNECTOR_WIDTH));
		const label = clean(connector.label);
		items.push({
			kind: "connector",
			id,
			d: route.d,
			heads,
			color: connector.color,
			dash: connector.dash,
			width: CONNECTOR_WIDTH,
			label,
			labelAt: label ? route.middle : null,
		});
	}

	for (const id of ordered) {
		const shape = shapes.get(id)!;
		const rect = boxes.get(id);
		if (!rect || shape.type === "connector" || stacked.has(id)) continue;
		const slot = layout.slots.get(id);
		if (slot) {
			const held = (stacks.get(id) ?? []).map((member) => shapes.get(member)?.type);
			items.push(rowItem(id, shape, slot.kind, rect, cards, held));
			continue;
		}
		const item =
			shape.type === "stack"
				? stackItem(id, shape, rect, stacks.get(id) ?? [], shapes, cards)
				: shapeItem(id, shape, rect, cards);
		if (item) items.push(item);
	}

	// Where the image looks.
	let frame: Rect | null;
	let missing = false;
	if (region.kind === "rect") {
		frame = region.rect;
	} else if (region.kind === "section") {
		const box = boxes.get(region.id);
		if (!box || shapes.get(region.id)?.type !== "section") {
			missing = true;
			frame = null;
		} else {
			// Its title too, above it.
			const item = items.find((candidate) => candidate.id === region.id);
			frame = inflate(item ? itemBounds(item) : box, EMBED.sectionPad);
		}
	} else {
		frame = boundsOfItems(items);
		frame = frame ? inflate(frame, EMBED.pad) : null;
	}
	if (!frame) {
		return { frame: { x: 0, y: 0, w: 960, h: 540 }, items: [], empty: true, missing };
	}

	const visible = items.filter((item) => intersects(itemBounds(item), frame!));
	const kept = visible.length > EMBED.maxItems ? keepLargest(visible) : visible;
	return {
		frame,
		items: kept,
		empty: kept.every((item) => item.kind === "connector"),
		missing,
	};
}

/** Widen a frame to an aspect ratio, about its centre (for link previews' fixed size). */
export function fitAspect(frame: Rect, aspect: number): Rect {
	const current = frame.w / frame.h;
	if (current > aspect) {
		const h = frame.w / aspect;
		return { x: frame.x, y: frame.y - (h - frame.h) / 2, w: frame.w, h };
	}
	const w = frame.h * aspect;
	return { x: frame.x - (w - frame.w) / 2, y: frame.y, w, h: frame.h };
}

/** How much of a link preview's height the board takes, above its title. */
const PREVIEW_BOARD_SHARE = 0.6;

/**
 * A link preview's frame: the board fitted into the top of the image, with
 * room below for the title, which is drawn over the ground.
 */
export function previewFrame(frame: Rect): Rect {
	const share = PREVIEW_BOARD_SHARE;
	const fitted = fitAspect(frame, OG_SIZE.width / (OG_SIZE.height * share));
	return { ...fitted, h: fitted.h / share };
}

/** The image's size in pixels for a frame: the width asked for, else a natural one, within limits. */
export function imageSize(frame: Rect, width: number | null): { width: number; height: number } {
	let w = width ?? Math.min(EMBED.defaultWidth, Math.max(EMBED.minWidth, Math.round(frame.w)));
	let h = Math.round((w * frame.h) / frame.w);
	if (h > EMBED.maxHeight) {
		h = EMBED.maxHeight;
		w = Math.max(1, Math.round((h * frame.w) / frame.h));
	}
	return { width: Math.max(1, w), height: Math.max(1, h) };
}

/** Count what's on a board, for a link preview: only public repositories are named. */
export function countBoard(
	shapes: ReadonlyMap<string, ShapeProps>,
	cards: ReadonlyMap<string, Entry>,
): BoardCounts {
	const counts: BoardCounts = {
		cards: 0,
		stickies: 0,
		links: 0,
		sections: 0,
		decisions: 0,
		repos: [],
	};
	const repos = new Map<string, number>();
	for (const shape of shapes.values()) {
		if (shape.type === "card") {
			counts.cards++;
			const entry = shape.ref ? cards.get(shape.ref) : undefined;
			if (entry && !("missing" in entry) && entry.visibility === "public") {
				repos.set(entry.repo, (repos.get(entry.repo) ?? 0) + 1);
			}
		} else if (shape.type === "sticky") counts.stickies++;
		else if (shape.type === "link") counts.links++;
		else if (shape.type === "section") counts.sections++;
		else if (shape.type === "decision") counts.decisions++;
	}
	counts.repos = [...repos.entries()]
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
		.map(([repo]) => repo);
	return counts;
}

/** A link preview's description, from what's on the board. */
export function describeBoard(counts: BoardCounts): string {
	const parts: string[] = [];
	const n = (count: number, one: string, many: string) =>
		count > 0 ? `${count} ${count === 1 ? one : many}` : null;
	for (const part of [
		n(counts.cards, "card", "cards"),
		n(counts.stickies, "sticky", "stickies"),
		n(counts.links, "link", "links"),
		n(counts.decisions, "decision", "decisions"),
		n(counts.sections, "section", "sections"),
	]) {
		if (part) parts.push(part);
	}
	const what = parts.length === 0 ? "An empty board" : `A board with ${listOf(parts)}`;
	const repos = counts.repos.slice(0, 3);
	const from =
		repos.length === 0
			? ""
			: ` from ${listOf(repos)}${counts.repos.length > repos.length ? " and more" : ""}`;
	return `${what}${from}, on Tack.`;
}

function listOf(parts: string[]): string {
	if (parts.length <= 1) return parts.join("");
	return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// --- Shapes ---------------------------------------------------------------------------

function shapeBox(shape: ShapeProps, slot: Rect | undefined, list: Rect | undefined): Rect | null {
	if (!isNum(shape.x) || !isNum(shape.y)) return null;
	if (slot) return slot;
	if (list) return list;
	switch (shape.type) {
		case "section":
			return {
				x: shape.x,
				y: shape.y,
				w: positive(shape.w) ?? 640,
				h: positive(shape.h) ?? 440,
			};
		case "widget":
			return { x: shape.x, y: shape.y, ...widgetSize(shape) };
		case "text": {
			const size = textSize(shape as unknown as Record<string, unknown>);
			return { x: shape.x, y: shape.y, w: size.width, h: size.height };
		}
		case "connector":
			return null;
		case "link":
			return { x: shape.x, y: shape.y, w: LINK_CARD.w, h: linkHeight(linkFace(shape)) };
		default: {
			const size = NOMINAL_SIZE[shape.type];
			return size ? { x: shape.x, y: shape.y, w: size.w, h: size.h } : null;
		}
	}
}

function shapeItem(
	id: string,
	shape: ShapeProps,
	rect: Rect,
	cards: ReadonlyMap<string, Entry>,
): SceneItem | null {
	switch (shape.type) {
		case "sticky": {
			const faceDown = faceDownSticky(shape);
			return {
				kind: "sticky",
				id,
				rect,
				color: STICKY_COLORS.has(shape.color ?? "") ? shape.color! : "yellow",
				// Face down: its text isn't in the document anyway, but never draw it.
				text: faceDown ? null : clean(shape.text ?? ""),
				font: shape.font === "hand" ? "hand" : "sans",
			};
		}
		case "text":
			return {
				kind: "text",
				id,
				rect,
				text: clean(shape.text ?? ""),
				size: TEXT_PX[shape.size ?? "m"] ?? 20,
				font: shape.font === "hand" ? "hand" : "sans",
			};
		case "card":
			return { kind: "card", id, rect, card: sceneCard(shape.ref, cards) };
		case "link":
			return { kind: "link", id, rect, ...linkFace(shape) };
		case "decision":
			return {
				kind: "decision",
				id,
				rect,
				title: clean(shape.title ?? ""),
				text: clean(shape.text ?? ""),
				status:
					shape.status === "decided" || shape.status === "superseded" ? shape.status : "proposed",
			};
		case "action": {
			const linked = shape.ref ? cards.get(shape.ref) : undefined;
			const done = shape.ref
				? Boolean(
						linked &&
						!("missing" in linked) &&
						(linked.state === "closed" || linked.state === "merged"),
					)
				: Boolean(shape.done);
			const owner = (shape as { owner?: { login?: unknown } }).owner?.login;
			const due = (shape as { due?: unknown }).due;
			return {
				kind: "action",
				id,
				rect,
				text: clean(shape.text ?? ""),
				done,
				owner: typeof owner === "string" ? owner : null,
				due: typeof due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null,
			};
		}
		case "widget": {
			const definition = widgetDefinition(shape.widget);
			const config = (shape as { config?: { title?: unknown } }).config;
			const title = typeof config?.title === "string" && config.title ? config.title : "";
			return {
				kind: "widget",
				id,
				rect,
				label: definition?.title ?? "Widget",
				title: clean(title || definition?.title || "Widget"),
			};
		}
		default:
			return null;
	}
}

/** A stack's theme card: its name, count, and its first few members a line each. */
function stackItem(
	id: string,
	shape: ShapeProps,
	rect: Rect,
	members: readonly string[],
	shapes: ReadonlyMap<string, ShapeProps>,
	cards: ReadonlyMap<string, Entry>,
): SceneItem {
	const rows = members.slice(0, excerptCount(members.length)).map((member): StackRow => {
		const props = shapes.get(member);
		if (props?.type === "card") return { face: "card", card: sceneCard(props.ref, cards) };
		if (props?.type === "link") {
			const { title, initial, hue } = linkFace(props);
			return { face: "link", title, initial, hue };
		}
		const tone = STICKY_COLORS.has(props?.color ?? "") ? props!.color! : "yellow";
		if (!props || faceDownSticky(props)) return { face: "hidden", tone };
		return { face: "sticky", tone, text: clean(props.text ?? "") };
	});
	const paper = (member: string | undefined) => {
		const props = member ? shapes.get(member) : undefined;
		if (!props) return null;
		if (props.type === "card" || props.type === "link") return "card";
		return STICKY_COLORS.has(props.color ?? "") ? props.color! : "yellow";
	};
	return {
		kind: "stack",
		id,
		rect,
		name: clean(stackName(shape) ?? UNTITLED_STACK),
		suggested: nameState(shape) === "suggested",
		count: members.length,
		rows,
		more: members.length - rows.length,
		papers: [paper(members[1]), paper(members[2])].filter((tone): tone is string => !!tone),
	};
}

function rowItem(
	id: string,
	shape: ShapeProps,
	mode: "row" | "mini" | "group",
	rect: Rect,
	cards: ReadonlyMap<string, Entry>,
	/** A stack's members' types, to say what it holds. */
	held: readonly (ShapeProps["type"] | undefined)[] = [],
): SceneItem {
	const base = { kind: "row" as const, id, rect, mode };
	if (shape.type === "stack") {
		// A stack's row: its name, and what it holds (#73).
		const name = clean(stackName(shape) ?? UNTITLED_STACK);
		return { ...base, text: `${name} · ${countMembers(held)}`, ref: null, tone: "", face: "other" };
	}
	if (mode === "group" || shape.type === "section") {
		return {
			...base,
			text: clean(shape.title ?? ""),
			ref: null,
			tone: shape.color ?? "grey",
			face: "group",
		};
	}
	if (shape.type === "card") {
		const card = sceneCard(shape.ref, cards);
		if (card.status === "private") {
			return { ...base, text: "Private item", ref: null, tone: "closed", face: "private" };
		}
		if (card.status === "missing") {
			return { ...base, text: card.ref, ref: null, tone: "closed", face: "card" };
		}
		return { ...base, text: card.title, ref: card.ref, tone: card.state, face: "card" };
	}
	if (shape.type === "link") {
		// Its title, with the host where a card's `repo#123` goes.
		const host = typeof shape.url === "string" ? clean(linkHost(shape.url)) : "";
		return { ...base, text: linkFace(shape).title, ref: host || null, tone: "", face: "other" };
	}
	if (shape.type === "sticky") {
		const faceDown = faceDownSticky(shape);
		return {
			...base,
			text: faceDown ? "" : clean(shape.text ?? ""),
			ref: null,
			tone: STICKY_COLORS.has(shape.color ?? "") ? shape.color! : "yellow",
			face: faceDown ? "hidden" : "sticky",
		};
	}
	const text =
		shape.type === "decision" ? (shape.title ?? "") : shape.type === "widget" ? "" : shape.text;
	return { ...base, text: clean(text ?? ""), ref: null, tone: "", face: "other" };
}

/** What a link card shows, worded as the board's `LinkView` words it. */
function linkFace(shape: ShapeProps): Omit<SceneLink, "kind" | "id" | "rect"> {
	const url = typeof shape.url === "string" ? shape.url : "";
	const preview = readPreview(shape.preview);
	const host = linkHost(url);
	const unread = preview?.status === "failed" || preview?.status === "blocked";
	const description = clean(preview?.description ?? "");
	const named = clean(preview?.siteName ?? "");
	return {
		title: clean(preview?.title ?? "") || clean(linkLabel(url)) || clean(host),
		description: description || null,
		site: named || clean(host),
		host: named ? clean(host) || null : null,
		// A bare address has no name to take a letter from.
		initial: /^[\d.:[\]]*$/.test(host)
			? null
			: (/[a-z0-9]/i.exec(host)?.[0]?.toUpperCase() ?? null),
		hue: unread || !url ? null : linkHue(url),
		note:
			description || !unread
				? null
				: preview?.status === "blocked"
					? "Tack doesn’t read previews from this address."
					: "No preview: the page couldn’t be read.",
		image: !!preview?.image,
	};
}

/** The tint where a link card has no image: as tall as the board's `.link-media.link-tint`. */
export const LINK_BAND = 72;

/**
 * A link card's height, from its words, since nothing's measured on the
 * server: the picture (or the band), the site's row, the title (up to three
 * lines), the description (three) or the note, and the host. Line lengths
 * are guesses at the board's type in its 224px column, a little short, as
 * words wrap before the edge.
 */
export function linkHeight(
	face: Pick<SceneLink, "title" | "description" | "note" | "host" | "image">,
): number {
	const lines = (value: string, perLine: number, max: number) =>
		Math.min(max, Math.max(1, Math.ceil(value.length / perLine)));
	const media = face.image ? Math.round(LINK_CARD.w / 1.91) : LINK_BAND;
	let body = 10 + 20 + 6 + lines(face.title, 28, 3) * 14 * 1.35;
	if (face.description) body += 4 + lines(face.description, 34, 3) * 12.5 * 1.42;
	else if (face.note) body += 4 + lines(face.note, 40, 2) * 12 * 1.4;
	if (face.host) body += 9 + 11 * 1.3;
	// The picture's rule, the body's padding below, and the card's border.
	return Math.ceil(media + 1 + body + 13 + 2);
}

/**
 * Whether a sticky is face down: made in a silent session that hasn't been
 * revealed. Any mark at all counts, so a malformed one never shows text.
 */
function faceDownSticky(shape: ShapeProps): boolean {
	return shape.silent !== undefined && shape.silent !== null && shape.silent !== "";
}

function sceneCard(ref: string | undefined, cards: ReadonlyMap<string, Entry>): SceneCard {
	const entry = ref ? cards.get(ref) : undefined;
	const parsed = ref ? parseKey(ref) : null;
	const short = parsed ? `${parsed.repo.split("/").pop()}${parsed.item}` : (ref ?? "");
	if (!entry) return { status: "missing", ref: short };
	if ("missing" in entry) {
		return entry.reason === "private" ? { status: "private" } : { status: "missing", ref: short };
	}
	// Belt and braces: the cards passed in are already filtered, but a card
	// that isn't known to be public is never drawn, whatever it says.
	if (entry.visibility !== "public") return { status: "private" };
	const checks = entry.pull?.checks?.state;
	return {
		status: "ok",
		ref: `${entry.repo.split("/").pop()}${entry.item}`,
		kind: entry.kind,
		...(entry.discussion
			? {
					answered: entry.discussion.answered,
					...(entry.discussion.category.name
						? { category: clean(entry.discussion.category.name) }
						: {}),
				}
			: {}),
		title: clean(entry.title),
		state: entry.state,
		labels: entry.labels
			.slice(0, 3)
			.map((label) => ({ name: clean(label.name), color: label.color })),
		checks: checks === "passing" || checks === "failing" || checks === "pending" ? checks : null,
		comments: entry.comments,
	};
}

// --- Geometry -------------------------------------------------------------------------

/** Room above a section for its title, which sits outside it. */
const SECTION_TITLE_ROOM = 34;

function itemBounds(item: SceneItem): Rect {
	if (item.kind === "section" && item.title) {
		const { x, y, w, h } = item.rect;
		return { x, y: y - SECTION_TITLE_ROOM, w, h: h + SECTION_TITLE_ROOM };
	}
	if (item.kind !== "connector") return item.rect;
	// Connectors: the bounds of the numbers in their path, generously.
	const numbers = item.d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
	const xs = numbers.filter((_, i) => i % 2 === 0);
	const ys = numbers.filter((_, i) => i % 2 === 1);
	if (xs.length === 0 || ys.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
	const minX = Math.min(...xs);
	const minY = Math.min(...ys);
	return {
		x: minX - 8,
		y: minY - 8,
		w: Math.max(...xs) - minX + 16,
		h: Math.max(...ys) - minY + 16,
	};
}

function boundsOfItems(items: SceneItem[]): Rect | null {
	const rects = items.filter((item) => item.kind !== "connector").map(itemBounds);
	if (rects.length === 0) return null;
	const minX = Math.min(...rects.map((r) => r.x));
	const minY = Math.min(...rects.map((r) => r.y));
	const maxX = Math.max(...rects.map((r) => r.x + r.w));
	const maxY = Math.max(...rects.map((r) => r.y + r.h));
	return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function keepLargest(items: SceneItem[]): SceneItem[] {
	const area = (item: SceneItem) => {
		const r = itemBounds(item);
		return item.kind === "section" ? Number.POSITIVE_INFINITY : r.w * r.h;
	};
	const kept = new Set([...items].sort((a, b) => area(b) - area(a)).slice(0, EMBED.maxItems));
	return items.filter((item) => kept.has(item));
}

function inflate(rect: Rect, by: number): Rect {
	return { x: rect.x - by, y: rect.y - by, w: rect.w + by * 2, h: rect.h + by * 2 };
}

function intersects(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function isNum(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function positive(value: unknown): number | null {
	return isNum(value) && value > 0 ? value : null;
}

/**
 * Text as the image's fonts can draw it: Latin scripts. Common symbols
 * become their nearest ASCII, and anything else the fonts don't have
 * (emoji, other scripts) is left out rather than drawn as empty boxes.
 */
export function clean(text: string): string {
	let out = "";
	for (const char of text.normalize("NFC")) {
		const replaced = SUBSTITUTES[char];
		if (replaced !== undefined) {
			out += replaced;
			continue;
		}
		const code = char.codePointAt(0) ?? 0;
		if (code === 10) out += "\n";
		else if (code === 9) out += " ";
		else if (drawable(code)) out += char;
	}
	return out
		.replace(/[  ]{2,}/g, " ")
		.replace(/ +\n/g, "\n")
		.trim();
}

const SUBSTITUTES: Record<string, string> = {
	"→": "->",
	"←": "<-",
	"⇒": "=>",
	"↔": "<->",
	"✓": "v",
	"✔": "v",
	"✗": "x",
	"✘": "x",
	"≥": ">=",
	"≤": "<=",
	"≠": "!=",
};

function drawable(code: number): boolean {
	return (
		(code >= 0x20 && code <= 0x7e) ||
		(code >= 0xa0 && code <= 0x2ff) ||
		(code >= 0x1e00 && code <= 0x1eff) ||
		(code >= 0x2000 && code <= 0x2064 && code !== 0x200d) ||
		(code >= 0x20a0 && code <= 0x20c0) ||
		code === 0x2122 ||
		code === 0x2212
	);
}
