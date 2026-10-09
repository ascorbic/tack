import type * as Y from "yjs";
import type { Card, MissingCard } from "./cards.ts";
import { withFallbacks } from "./connectors.ts";
import { type Rect, intersects } from "./geometry.ts";
import { addCardShape } from "./provenance.ts";
import { boxOf } from "./sections.ts";
import { type ConnectorEnd, readShape, shapesMap } from "./shapes.ts";
import { type NewConnector, addConnector, placeInSections, readShapes } from "./structure.ts";
import type { RelatedResult } from "./widgets.ts";

// Expand related (#42): lay out what's related to a card around it.
//
//                        parent (or, for a pull request, the issues it closes)
//                          │
//                          │           ┄┄ linked pull requests
//      blocked by ──▶   [ card ]   ──▶ blocking
//                    sub-issues, in rows
//
// Each group is a block (a row or a column) that starts next to the card and
// slides outward until it's clear of everything on the board, so nothing
// overlaps. Items already on the board aren't added again: they're connected
// where they are. Cards added this way were asked for by a person, so they
// carry no provenance (manual, see provenance.ts).
//
// Planning is pure (`planExpand`), so it's unit-tested; `applyExpand` writes
// the plan into the document. Call it inside `transactLocal` so the whole
// expansion is one undo step.

export type RelatedGroup =
	| "parent"
	| "closes"
	| "subIssues"
	| "blockedBy"
	| "blocking"
	| "linkedPulls";

/** In the order they're placed (and animate in). */
export const RELATED_GROUPS: readonly RelatedGroup[] = [
	"parent",
	"closes",
	"subIssues",
	"blockedBy",
	"blocking",
	"linkedPulls",
];

export const GROUP_LABEL: Record<RelatedGroup, { one: string; many: string }> = {
	parent: { one: "Parent", many: "Parent" },
	closes: { one: "Closes", many: "Closes" },
	subIssues: { one: "Sub-issue", many: "Sub-issues" },
	blockedBy: { one: "Blocked by", many: "Blocked by" },
	blocking: { one: "Blocking", many: "Blocking" },
	linkedPulls: { one: "Linked pull request", many: "Linked pull requests" },
};

/** The keys in each group, without the item itself or repeats. */
export function relatedGroups(result: RelatedResult): Record<RelatedGroup, string[]> {
	const clean = (keys: readonly string[] | undefined) =>
		[...new Set(keys ?? [])].filter((key) => key !== result.key);
	return {
		parent: clean(result.parent ? [result.parent] : []),
		closes: clean(result.closes),
		subIssues: clean(result.subIssues),
		blockedBy: clean(result.blockedBy),
		blocking: clean(result.blocking),
		linkedPulls: clean(result.linkedPulls),
	};
}

export const CARD_WIDTH = 252;

/**
 * About how tall a card will render, before it has: a head, two lines of
 * title and a foot, plus labels and a pull request's status where it has
 * them. Generous, so neighbours don't touch once it's measured.
 */
export function estimateCardHeight(card: Card | MissingCard | undefined): number {
	if (!card || "missing" in card) return 124;
	let height = 112;
	if (card.title.length > 64) height += 20;
	if (card.labels.length > 0) height += 30;
	if (card.pull) height += card.pull.detail === "full" ? 56 : 30;
	return height;
}

/** Space between the card and each group, and between cards in a group. */
const GAP = { row: 88, column: 128, between: 24 };
/** How far a block slides at a time, looking for a clear spot, and how often. */
const STEP = 32;
const TRIES = 40;
/** Clearance kept around other shapes. */
const MARGIN = 16;
/** Most sub-issues in a row. */
const PER_ROW = 4;

type Direction = "up" | "down" | "left" | "right";

const DIRECTION: Record<RelatedGroup, Direction> = {
	parent: "up",
	closes: "up",
	subIssues: "down",
	blockedBy: "left",
	blocking: "right",
	linkedPulls: "right",
};

/** One end of a planned connector: a shape on the board, or a card the plan adds. */
export type PlannedEnd = { shape: string } | { key: string };

export interface PlannedCard {
	key: string;
	group: RelatedGroup;
	box: Rect;
	/** Its place in the sequence, for staggering the entrance. */
	order: number;
}

export interface PlannedConnector {
	group: RelatedGroup;
	from: PlannedEnd;
	to: PlannedEnd;
	/** Where each end attaches, for tidy trees; floating otherwise. */
	fromAnchor?: { x: number; y: number };
	toAnchor?: { x: number; y: number };
	style: Omit<NewConnector, "from" | "to">;
}

export interface ExpandPlan {
	cards: PlannedCard[];
	connectors: PlannedConnector[];
	/** Related items already on the board, connected where they are. */
	existing: { key: string; shape: string; group: RelatedGroup }[];
}

export interface ExpandInput {
	source: { id: string; key: string; box: Rect };
	result: RelatedResult;
	/** Groups to bring in; every group by default. */
	groups?: ReadonlySet<RelatedGroup>;
	/** Cards already on the board: the first shape showing each key. */
	onBoard: ReadonlyMap<string, string>;
	/** Everything to keep clear of. */
	obstacles: readonly Rect[];
	/** Whether two shapes are already joined by a connector, either way round. */
	connected?: (a: string, b: string) => boolean;
	/** Card data for sizing new cards. */
	cards?: ReadonlyMap<string, Card | MissingCard>;
}

/** How a group's connectors look. Arrows run from blocker to blocked, parent to child. */
function connectorFor(
	group: RelatedGroup,
	source: PlannedEnd,
	other: PlannedEnd,
	tidy: boolean,
	closes: boolean,
): PlannedConnector {
	const down = { x: 0.5, y: 1 };
	const up = { x: 0.5, y: 0 };
	switch (group) {
		case "parent":
			return {
				group,
				from: other,
				to: source,
				...(tidy ? { fromAnchor: down, toAnchor: up } : {}),
				style: { route: tidy ? "elbow" : "curved" },
			};
		case "subIssues":
			return {
				group,
				from: source,
				to: other,
				...(tidy ? { fromAnchor: down, toAnchor: up } : {}),
				style: { route: tidy ? "elbow" : "curved" },
			};
		case "blockedBy":
			return { group, from: other, to: source, style: { color: "red", label: "blocks" } };
		case "blocking":
			return { group, from: source, to: other, style: { color: "red", label: "blocks" } };
		case "closes":
			return {
				group,
				from: source,
				to: other,
				style: { color: "purple", dash: true, label: "closes" },
			};
		case "linkedPulls":
			return {
				group,
				from: other,
				to: source,
				style: { color: "purple", dash: true, ...(closes ? { label: "closes" } : {}) },
			};
	}
}

/** Where each card in a block goes, relative to the block's own top-left. */
function arrange(
	sizes: { w: number; h: number }[],
	direction: Direction,
): { boxes: Rect[]; w: number; h: number } {
	const boxes: Rect[] = [];
	if (direction === "left" || direction === "right") {
		let y = 0;
		for (const size of sizes) {
			boxes.push({ x: 0, y, ...size });
			y += size.h + GAP.between;
		}
		const w = Math.max(0, ...sizes.map((s) => s.w));
		// Right-align a left column against the card.
		for (const box of boxes) box.x = direction === "left" ? w - box.w : 0;
		return { boxes, w, h: Math.max(0, y - GAP.between) };
	}
	// Rows, centred on each other: sub-issues wrap, parents sit in one row.
	const rows: { w: number; h: number }[][] = [];
	for (let i = 0; i < sizes.length; i += PER_ROW) rows.push(sizes.slice(i, i + PER_ROW));
	if (direction === "up") rows.reverse();
	const widths = rows.map(
		(row) => row.reduce((n, s) => n + s.w, 0) + GAP.between * (row.length - 1),
	);
	const w = Math.max(0, ...widths);
	let y = 0;
	const placed: Rect[][] = rows.map((row, r) => {
		let x = (w - (widths[r] ?? 0)) / 2;
		const height = Math.max(...row.map((s) => s.h));
		const out = row.map((size) => {
			// Rows above the card line up along their bottom edge, below along their top.
			const box = { x, y: direction === "up" ? y + height - size.h : y, ...size };
			x += size.w + GAP.between;
			return box;
		});
		y += height + GAP.between;
		return out;
	});
	if (direction === "up") placed.reverse();
	boxes.push(...placed.flat());
	return { boxes, w, h: Math.max(0, y - GAP.between) };
}

function padded(rect: Rect, by: number): Rect {
	return { x: rect.x - by, y: rect.y - by, w: rect.w + by * 2, h: rect.h + by * 2 };
}

/**
 * Work out where related items go and how they connect, without touching
 * the document.
 */
export function planExpand(input: ExpandInput): ExpandPlan {
	const { source, onBoard, connected = () => false } = input;
	const groups = relatedGroups(input.result);
	const plan: ExpandPlan = { cards: [], connectors: [], existing: [] };
	const blocked: Rect[] = [...input.obstacles.map((rect) => padded(rect, MARGIN)), source.box];
	const placed = new Map<string, PlannedEnd>();
	const cardOf = (key: string) =>
		input.cards?.get(key) ?? input.result.cards.find((card) => card.key === key);
	const self: PlannedEnd = { shape: source.id };

	// Linked pull requests share the right-hand column with what the card
	// blocks, above it: below, the sub-issues' row is in the way.
	let rightTop: number | null = null;

	for (const group of RELATED_GROUPS) {
		if (input.groups && !input.groups.has(group)) continue;
		const keys = groups[group];
		const direction = DIRECTION[group];
		const fresh: string[] = [];
		for (const key of keys) {
			if (key === source.key) continue;
			const shape = onBoard.get(key);
			if (shape && shape !== source.id) {
				if (!plan.existing.some((e) => e.key === key)) plan.existing.push({ key, shape, group });
			} else if (!placed.has(key)) {
				fresh.push(key);
			}
		}

		if (fresh.length > 0) {
			const sizes = fresh.map((key) => ({ w: CARD_WIDTH, h: estimateCardHeight(cardOf(key)) }));
			const block = arrange(sizes, direction);
			const box = source.box;
			const centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
			let origin: { x: number; y: number };
			if (direction === "up") origin = { x: centre.x - block.w / 2, y: box.y - GAP.row - block.h };
			else if (direction === "down")
				origin = { x: centre.x - block.w / 2, y: box.y + box.h + GAP.row };
			else if (direction === "left")
				origin = { x: box.x - GAP.column - block.w, y: centre.y - block.h / 2 };
			else {
				origin = {
					x: box.x + box.w + GAP.column,
					y: rightTop === null ? centre.y - block.h / 2 : rightTop - GAP.row / 2 - block.h,
				};
			}
			const step = {
				up: { x: 0, y: -STEP },
				down: { x: 0, y: STEP },
				left: { x: -STEP, y: 0 },
				right: { x: STEP, y: 0 },
			}[direction];
			const at = (k: number) =>
				block.boxes.map((b) => ({
					...b,
					x: Math.round(origin.x + b.x + step.x * k),
					y: Math.round(origin.y + b.y + step.y * k),
				}));
			let boxes = at(0);
			for (let k = 0; k < TRIES; k++) {
				const candidate = at(k);
				if (!candidate.some((b) => blocked.some((other) => intersects(b, other)))) {
					boxes = candidate;
					break;
				}
				if (k === TRIES - 1) boxes = candidate;
			}
			boxes.forEach((b, i) => {
				const key = fresh[i] as string;
				plan.cards.push({ key, group, box: b, order: plan.cards.length });
				placed.set(key, { key });
				blocked.push(padded(b, MARGIN));
			});
			if (direction === "right") rightTop = Math.min(...boxes.map((b) => b.y));
		}

		// Connect everything in the group, new or already there.
		for (const key of keys) {
			if (key === source.key) continue;
			const existing = onBoard.get(key);
			const end: PlannedEnd | undefined =
				existing && existing !== source.id ? { shape: existing } : placed.get(key);
			if (!end) continue;
			if ("shape" in end && connected(source.id, end.shape)) continue;
			const card = cardOf(key);
			const closes =
				group === "linkedPulls" &&
				!!card &&
				!("missing" in card) &&
				!!card.pull?.linked.some((link) => link.key === source.key);
			const tidy = "key" in end && plan.cards.some((c) => c.key === key && c.group === group);
			plan.connectors.push(connectorFor(group, self, end, tidy, closes));
		}
	}
	return plan;
}

/**
 * Write a plan into the document: new cards (with nothing recorded as their
 * provenance: a person asked for them), and connectors. Returns the new
 * shapes' ids. Call inside `transactLocal`, so it's one undo step.
 */
export function applyExpand(
	doc: Y.Doc,
	plan: ExpandPlan,
	sizeOf?: (id: string) => { w: number; h: number } | undefined,
): { cards: Map<string, string>; connectors: string[] } {
	const ids = new Map<string, string>();
	const connectors: string[] = [];
	doc.transact(() => {
		for (const card of plan.cards) {
			const id = crypto.randomUUID();
			ids.set(card.key, id);
			addCardShape(doc, id, { ref: card.key, x: card.box.x, y: card.box.y });
		}
		const planned = new Map(plan.cards.map((card) => [ids.get(card.key) as string, card.box]));
		const shapes = shapesMap(doc);
		const box = (id: string): Rect | undefined => {
			const known = planned.get(id);
			if (known) return known;
			const shape = shapes.get(id);
			return shape ? boxOf(id, readShape(shape), sizeOf) : undefined;
		};
		const end = (planEnd: PlannedEnd, anchor?: { x: number; y: number }): ConnectorEnd | null => {
			const shape = "shape" in planEnd ? planEnd.shape : ids.get(planEnd.key);
			if (!shape) return null;
			return { x: 0, y: 0, shape, ...(anchor ? { anchor } : {}) };
		};
		for (const planned of plan.connectors) {
			const from = end(planned.from, planned.fromAnchor);
			const to = end(planned.to, planned.toAnchor);
			if (!from || !to) continue;
			connectors.push(addConnector(doc, { ...withFallbacks(from, to, box), ...planned.style }));
		}
		placeInSections(doc, ids.values(), sizeOf);
	});
	return { cards: ids, connectors };
}

/**
 * What a plan has to work around on this board: the cards already on it
 * (by key), the boxes to keep clear of, and which shapes are connected.
 * Sections the card is in don't count as obstacles: new cards may join them.
 */
export function boardContext(
	doc: Y.Doc,
	sourceId: string,
	sizeOf?: (id: string) => { w: number; h: number } | undefined,
): Pick<ExpandInput, "onBoard" | "obstacles" | "connected"> & { box: Rect | null } {
	const shapes = readShapes(doc);
	const onBoard = new Map<string, string>();
	const obstacles: Rect[] = [];
	const pairs = new Set<string>();
	const source = shapes.get(sourceId);
	const sourceBox = source ? boxOf(sourceId, source, sizeOf) : null;
	for (const [id, shape] of shapes) {
		if (shape.type === "connector") {
			const a = shape.from?.shape;
			const b = shape.to?.shape;
			if (a && b) pairs.add(`${a}\n${b}`).add(`${b}\n${a}`);
			continue;
		}
		if (shape.type === "card" && shape.ref && !onBoard.has(shape.ref)) onBoard.set(shape.ref, id);
		if (id === sourceId) continue;
		const box = boxOf(id, shape, sizeOf);
		if (shape.type === "section" && sourceBox && contains(box, sourceBox)) continue;
		obstacles.push(box);
	}
	// The card's own key points at it, even if another card shows it first.
	if (source?.ref) onBoard.set(source.ref, sourceId);
	return {
		onBoard,
		obstacles,
		connected: (a, b) => pairs.has(`${a}\n${b}`),
		box: sourceBox,
	};
}

function contains(outer: Rect, inner: Rect): boolean {
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.w <= outer.x + outer.w &&
		inner.y + inner.h <= outer.y + outer.h
	);
}
