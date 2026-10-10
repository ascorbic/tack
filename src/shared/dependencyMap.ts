import * as v from "valibot";
import { type Card, type MissingCard, isMissing } from "./cards.ts";
import type { Point, Rect } from "./geometry.ts";
import { DEFAULT_HOST } from "./refs.ts";
// Types only: the registry imports this, and related.ts reaches back to it.
import type { ExpandPlan, PlannedEnd } from "./related.ts";
import type {
	QueryContext,
	QueryError,
	QueryResult,
	RelatedResult,
	WidgetDefinition,
	WidgetQuery,
} from "./widgets.ts";

// The dependency map widget (#43): the blocked-by graph of a set of items
// (a search's results, or the cards in a section), from what's related to
// each (one `related` query per item, at most `limit`, cached by the runner
// like any other query). It's drawn as a small layered graph, left to right
// in the order work can happen: blockers before what they block. The
// longest chain of open work is the critical path; cycles are flagged, since
// nothing in one can ever start.
//
// Building the graph, laying it out and planning it onto the board are pure,
// so they're unit-tested.

export const DEPENDENCY_SOURCES = ["search", "section"] as const;
export type DependencySource = (typeof DEPENDENCY_SOURCES)[number];

export interface DependencyConfig {
	title: string;
	/** Where the items come from: a search, or the cards in a section. */
	source: DependencySource;
	host: string;
	q: string;
	/** A section's shape id. */
	section: string;
	/** At most this many items are asked about. */
	limit: number;
}

export const DEPENDENCY_LIMITS = { min: 5, max: 40, default: 20 };

const dependencySchema: v.GenericSchema<DependencyConfig> = v.object({
	title: v.fallback(v.pipe(v.string(), v.maxLength(120)), ""),
	source: v.fallback(v.picklist(DEPENDENCY_SOURCES), "search"),
	host: v.fallback(v.pipe(v.string(), v.minLength(1), v.maxLength(253)), DEFAULT_HOST),
	q: v.fallback(v.pipe(v.string(), v.maxLength(1000)), ""),
	section: v.fallback(v.pipe(v.string(), v.maxLength(100)), ""),
	limit: v.fallback(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(DEPENDENCY_LIMITS.min),
			v.maxValue(DEPENDENCY_LIMITS.max),
		),
		DEPENDENCY_LIMITS.default,
	),
});

/** The name each item's `related` query runs under. */
export function relatedName(key: string): string {
	return `related:${key}`;
}

function relatedQueries(keys: string[], limit: number): Record<string, WidgetQuery> {
	const chosen = [...new Set(keys)].slice(0, limit).sort();
	return Object.fromEntries(
		chosen.map((key): [string, WidgetQuery] => [relatedName(key), { kind: "related", key }]),
	);
}

export const dependencyWidget: WidgetDefinition<DependencyConfig> = {
	kind: "dependencies",
	title: "Dependency map",
	description:
		"What blocks what, for a search or a section's cards: the critical path, and cycles.",
	schema: dependencySchema,
	defaults: {
		title: "",
		source: "search",
		host: DEFAULT_HOST,
		q: "",
		section: "",
		limit: DEPENDENCY_LIMITS.default,
	},
	size: { w: 780, h: 440 },
	queries(config, context: QueryContext): Record<string, WidgetQuery> {
		if (config.source === "section") {
			return config.section ? relatedQueries(context.cardsIn(config.section), config.limit) : {};
		}
		const q = config.q.trim();
		if (!q) return {};
		return {
			items: {
				kind: "search",
				host: config.host,
				q,
				sort: "updated",
				order: "desc",
				limit: config.limit,
			},
		};
	},
	followUps(config, results) {
		if (config.source !== "search") return {};
		const items = results.items;
		if (items?.kind !== "search") return {};
		return relatedQueries(
			items.items.map((card) => card.key),
			config.limit,
		);
	},
	readsBoard: true,
	refresh: 600,
};

/**
 * The items a map is about, in the order it found them: a search's results,
 * or a section's cards (in reading order, as `QueryContext.cardsIn` gives
 * them), else whatever it asked about.
 */
export function dependencyMembers(
	config: Pick<DependencyConfig, "source" | "limit">,
	results: Record<string, QueryResult | QueryError>,
	inSection: string[] = [],
): string[] {
	if (config.source === "search") {
		const items = results.items;
		return items?.kind === "search"
			? items.items.slice(0, config.limit).map((card) => card.key)
			: [];
	}
	// What's in the section is what's asked about (some may still be on the way).
	if (inSection.length > 0) return [...new Set(inSection)].slice(0, config.limit);
	return Object.keys(results)
		.filter((name) => name.startsWith("related:"))
		.map((name) => name.slice("related:".length))
		.sort();
}

// --- The graph ------------------------------------------------------------------------

export interface DependencyNode {
	key: string;
	card: Card | MissingCard | null;
	/** One of the items the map is about (rather than a blocker outside them). */
	member: boolean;
	/** Still to do: open or draft (or unknown). */
	open: boolean;
	/** What it's related to couldn't be read. */
	unknown: boolean;
}

/** `from` blocks `to`. */
export interface DependencyEdge {
	from: string;
	to: string;
}

export interface DependencyGraph {
	nodes: Map<string, DependencyNode>;
	edges: DependencyEdge[];
	/** Members with no dependencies either way. */
	isolated: string[];
	/** Members whose relations couldn't be read. */
	unreadable: string[];
	/** Members still waiting for an answer. */
	pending: string[];
}

function isOpen(card: Card | MissingCard | null): boolean {
	return !card || isMissing(card) || card.state === "open" || card.state === "draft";
}

/**
 * The graph for `members`, from their `related` results. Blockers and
 * blocked items outside the set are included (one step out), so a chain
 * that leaves the set and comes back still reads.
 */
export function buildDependencyGraph(
	members: string[],
	results: Record<string, QueryResult | QueryError>,
	cardOf: (key: string) => Card | MissingCard | null | undefined = () => null,
): DependencyGraph {
	const cards = new Map<string, Card | MissingCard>();
	const items = results.items;
	if (items?.kind === "search") for (const card of items.items) cards.set(card.key, card);
	for (const result of Object.values(results)) {
		if (result.kind === "related") for (const card of result.cards) cards.set(card.key, card);
	}
	const lookup = (key: string) => cards.get(key) ?? cardOf(key) ?? null;
	const memberSet = new Set(members);
	const nodes = new Map<string, DependencyNode>();
	const node = (key: string) => {
		let known = nodes.get(key);
		if (!known) {
			const card = lookup(key);
			known = { key, card, member: memberSet.has(key), open: isOpen(card), unknown: false };
			nodes.set(key, known);
		}
		return known;
	};
	const edges = new Map<string, DependencyEdge>();
	const edge = (from: string, to: string) => {
		if (from === to) return;
		edges.set(`${from}\n${to}`, { from, to });
		node(from);
		node(to);
	};
	const unreadable: string[] = [];
	const pending: string[] = [];
	for (const key of members) {
		node(key);
		const result = results[relatedName(key)] as RelatedResult | QueryError | undefined;
		if (!result) {
			pending.push(key);
			continue;
		}
		if (result.kind !== "related") {
			unreadable.push(key);
			(nodes.get(key) as DependencyNode).unknown = true;
			continue;
		}
		for (const blocker of result.blockedBy) edge(blocker, key);
		for (const blocked of result.blocking) edge(key, blocked);
	}
	const linked = new Set<string>();
	for (const { from, to } of edges.values()) linked.add(from).add(to);
	return {
		nodes,
		edges: [...edges.values()],
		isolated: members.filter((key) => !linked.has(key)),
		unreadable,
		pending,
	};
}

// --- Layout ------------------------------------------------------------------------------

export interface PlacedNode {
	key: string;
	layer: number;
	/** Its place in its layer, top to bottom. */
	row: number;
	x: number;
	y: number;
	/** Part of a cycle: none of it can ever start. */
	cycle: boolean;
	/** On the critical path: the longest chain of open work. */
	critical: boolean;
	/** Open, and nothing open blocks it: work can start. */
	ready: boolean;
}

export interface PlacedEdge extends DependencyEdge {
	critical: boolean;
	/** Within a cycle. */
	cycle: boolean;
	/** Points backwards (or within a layer), as edges in a cycle must. */
	back: boolean;
}

export interface DependencyLayout {
	nodes: PlacedNode[];
	edges: PlacedEdge[];
	width: number;
	height: number;
	layers: number;
	/** Each cycle's items. */
	cycles: string[][];
	/** The critical path, first blocker first. Empty when there's no chain of open work. */
	critical: string[];
}

export interface LayoutSize {
	node: { w: number; h: number };
	gap: { x: number; y: number };
}

export const MAP_SIZE: LayoutSize = { node: { w: 160, h: 44 }, gap: { x: 50, y: 14 } };

/** Strongly connected groups (Tarjan), each a list of keys; singletons included. */
export function stronglyConnected(keys: string[], edges: DependencyEdge[]): string[][] {
	const next = new Map<string, string[]>(keys.map((key) => [key, []]));
	for (const { from, to } of edges) next.get(from)?.push(to);
	let index = 0;
	const indexOf = new Map<string, number>();
	const low = new Map<string, number>();
	const stack: string[] = [];
	const onStack = new Set<string>();
	const groups: string[][] = [];
	// Iterative, so long chains can't overflow the stack.
	for (const root of keys) {
		if (indexOf.has(root)) continue;
		const work: { key: string; i: number }[] = [{ key: root, i: 0 }];
		indexOf.set(root, index);
		low.set(root, index++);
		stack.push(root);
		onStack.add(root);
		while (work.length > 0) {
			const frame = work.at(-1) as { key: string; i: number };
			const out = next.get(frame.key) ?? [];
			if (frame.i < out.length) {
				const to = out[frame.i++] as string;
				if (!indexOf.has(to)) {
					indexOf.set(to, index);
					low.set(to, index++);
					stack.push(to);
					onStack.add(to);
					work.push({ key: to, i: 0 });
				} else if (onStack.has(to)) {
					low.set(frame.key, Math.min(low.get(frame.key) as number, indexOf.get(to) as number));
				}
				continue;
			}
			work.pop();
			const parent = work.at(-1);
			if (parent) {
				low.set(parent.key, Math.min(low.get(parent.key) as number, low.get(frame.key) as number));
			}
			if (low.get(frame.key) === indexOf.get(frame.key)) {
				const group: string[] = [];
				let member: string;
				do {
					member = stack.pop() as string;
					onStack.delete(member);
					group.push(member);
				} while (member !== frame.key);
				groups.push(group.reverse());
			}
		}
	}
	return groups;
}

/**
 * Lay the linked part of a graph out in layers, left to right: every item
 * is a layer after everything that blocks it (items in a cycle share one).
 * Within layers, items are ordered to keep edges short and uncrossed (a few
 * barycentre sweeps). Then the critical path: the chain with the most open
 * items, which is what decides how soon the last of them can be done.
 */
export function layoutDependencies(
	graph: DependencyGraph,
	size: LayoutSize = MAP_SIZE,
): DependencyLayout {
	// Members first, in their order, so the layout is stable as results arrive.
	const order: string[] = [];
	const seen = new Set<string>();
	const linked = new Set<string>();
	for (const { from, to } of graph.edges) linked.add(from).add(to);
	for (const key of graph.nodes.keys()) {
		if (linked.has(key) && !seen.has(key)) {
			seen.add(key);
			order.push(key);
		}
	}
	const groups = stronglyConnected(order, graph.edges);
	const groupOf = new Map<string, number>();
	groups.forEach((group, i) => {
		for (const key of group) groupOf.set(key, i);
	});
	const cycles = groups.filter((group) => group.length > 1);

	// The condensed graph is acyclic: layer it by longest path from its sources.
	const preds = new Map<number, Set<number>>(groups.map((_, i) => [i, new Set()]));
	const succs = new Map<number, Set<number>>(groups.map((_, i) => [i, new Set()]));
	for (const { from, to } of graph.edges) {
		const a = groupOf.get(from) as number;
		const b = groupOf.get(to) as number;
		if (a === b) continue;
		preds.get(b)?.add(a);
		succs.get(a)?.add(b);
	}
	const topo: number[] = [];
	const indegree = new Map([...preds].map(([g, p]) => [g, p.size]));
	const queue = groups.map((_, i) => i).filter((g) => indegree.get(g) === 0);
	while (queue.length > 0) {
		const g = queue.shift() as number;
		topo.push(g);
		for (const s of succs.get(g) ?? []) {
			const left = (indegree.get(s) as number) - 1;
			indegree.set(s, left);
			if (left === 0) queue.push(s);
		}
	}
	const layerOf = new Map<number, number>();
	for (const g of topo) {
		let layer = 0;
		for (const p of preds.get(g) ?? []) layer = Math.max(layer, (layerOf.get(p) as number) + 1);
		layerOf.set(g, layer);
	}
	const layerCount = Math.max(0, ...layerOf.values()) + (order.length > 0 ? 1 : 0);
	const layers: string[][] = Array.from({ length: layerCount }, () => []);
	for (const key of order) layers[layerOf.get(groupOf.get(key) as number) as number]?.push(key);

	// Order within layers: barycentres of neighbours, down then up, a few times.
	const into = new Map<string, string[]>();
	const outOf = new Map<string, string[]>();
	for (const { from, to } of graph.edges) {
		(into.get(to) ?? into.set(to, []).get(to))?.push(from);
		(outOf.get(from) ?? outOf.set(from, []).get(from))?.push(to);
	}
	const position = new Map<string, number>();
	const index = () => {
		for (const layer of layers) layer.forEach((key, i) => position.set(key, i));
	};
	index();
	const sweep = (layer: string[], neighbours: Map<string, string[]>) => {
		const weight = new Map<string, number>();
		layer.forEach((key, i) => {
			const around = (neighbours.get(key) ?? []).filter((k) => position.has(k));
			weight.set(
				key,
				around.length > 0
					? around.reduce((sum, k) => sum + (position.get(k) as number), 0) / around.length
					: i,
			);
		});
		layer.sort((a, b) => (weight.get(a) as number) - (weight.get(b) as number));
		layer.forEach((key, i) => position.set(key, i));
	};
	for (let pass = 0; pass < 4; pass++) {
		for (let i = 1; i < layers.length; i++) sweep(layers[i] as string[], into);
		for (let i = layers.length - 2; i >= 0; i--) sweep(layers[i] as string[], outOf);
	}
	index();

	// The critical path, over the condensed graph: most open items, then longest.
	const weightOf = (g: number) =>
		(groups[g] ?? []).reduce((sum, key) => sum + (graph.nodes.get(key)?.open ? 1 : 0) + 0.001, 0);
	const best = new Map<number, number>();
	const via = new Map<number, number | null>();
	for (const g of topo) {
		let top = 0;
		let from: number | null = null;
		for (const p of preds.get(g) ?? []) {
			const score = best.get(p) as number;
			if (score > top) [top, from] = [score, p];
		}
		best.set(g, top + weightOf(g));
		via.set(g, from);
	}
	let end: number | null = null;
	for (const [g, score] of best) if (end === null || score > (best.get(end) as number)) end = g;
	const path: number[] = [];
	for (let g = end; g !== null && g !== undefined; g = via.get(g) ?? null) path.unshift(g);
	const criticalKeys = path.flatMap((g) => groups[g] ?? []);
	const openOnPath = criticalKeys.filter((key) => graph.nodes.get(key)?.open).length;
	const critical = criticalKeys.length >= 2 && openOnPath >= 2 ? criticalKeys : [];
	const onPath = new Set(critical);
	const pathEdges = new Set<string>();
	for (let i = 1; i < path.length; i++) {
		for (const a of groups[path[i - 1] as number] ?? []) {
			for (const b of groups[path[i] as number] ?? []) pathEdges.add(`${a}\n${b}`);
		}
	}

	const tallest = Math.max(0, ...layers.map((layer) => layer.length));
	const rowStep = size.node.h + size.gap.y;
	const colStep = size.node.w + size.gap.x;
	const nodes: PlacedNode[] = [];
	layers.forEach((layer, l) => {
		const offset = ((tallest - layer.length) * rowStep) / 2;
		layer.forEach((key, row) => {
			const blockers = into.get(key) ?? [];
			const node = graph.nodes.get(key);
			nodes.push({
				key,
				layer: l,
				row,
				x: l * colStep,
				y: offset + row * rowStep,
				cycle: (groups[groupOf.get(key) as number]?.length ?? 0) > 1,
				critical: onPath.has(key),
				ready: Boolean(
					node?.open &&
					!node.unknown &&
					(groups[groupOf.get(key) as number]?.length ?? 0) === 1 &&
					blockers.every((b) => !graph.nodes.get(b)?.open),
				),
			});
		});
	});
	const layerOfKey = (key: string) => layerOf.get(groupOf.get(key) as number) as number;
	const edges: PlacedEdge[] = graph.edges.map((edge) => {
		const cycle = groupOf.get(edge.from) === groupOf.get(edge.to);
		return {
			...edge,
			cycle,
			back: layerOfKey(edge.to) <= layerOfKey(edge.from),
			critical: onPath.size > 0 && pathEdges.has(`${edge.from}\n${edge.to}`),
		};
	});
	return {
		nodes,
		edges,
		width: layerCount > 0 ? layerCount * colStep - size.gap.x : 0,
		height: tallest > 0 ? tallest * rowStep - size.gap.y : 0,
		layers: layerCount,
		cycles,
		critical,
	};
}

/**
 * An SVG path for an edge between two placed nodes: a smooth S from the
 * blocker's right edge to the blocked item's left, or, for edges pointing
 * back (in a cycle), a loop over the top.
 */
export function edgePath(from: Point, to: Point, node: { w: number; h: number }): string {
	const a = { x: from.x + node.w, y: from.y + node.h / 2 };
	const b = { x: to.x, y: to.y + node.h / 2 };
	if (b.x > a.x) {
		const bend = Math.max(24, (b.x - a.x) / 2);
		return `M${a.x} ${a.y} C${a.x + bend} ${a.y} ${b.x - bend} ${b.y} ${b.x} ${b.y}`;
	}
	if (Math.abs(from.x - to.x) < 1) {
		// The same layer (a cycle): a bow out to the left, side to side.
		const s = { x: from.x, y: from.y + node.h / 2 };
		const e = { x: to.x, y: to.y + node.h / 2 };
		const bow = 22 + Math.min(40, Math.abs(e.y - s.y) / 4);
		return `M${s.x} ${s.y} C${s.x - bow} ${s.y} ${e.x - bow} ${e.y} ${e.x} ${e.y}`;
	}
	// Backwards: leave from the top of the blocker, arrive at the top of the blocked.
	const top = Math.min(from.y, to.y) - 26;
	const s = { x: from.x + node.w / 2, y: from.y };
	const e = { x: to.x + node.w / 2, y: to.y };
	return `M${s.x} ${s.y} C${s.x} ${top} ${e.x} ${top} ${e.x} ${e.y}`;
}

// --- Onto the board ------------------------------------------------------------------------

/** A card's width on the board (as `CARD_WIDTH` in related.ts). */
const CARD_WIDTH = 252;
/** Where cards go when a map is laid out on the board: a column per layer. */
const BOARD_STEP = { x: CARD_WIDTH + 104, y: 172 };

/** The size of a whole map laid out as cards, to find room for it. */
export function boardSize(layout: DependencyLayout): { w: number; h: number } {
	const tallest = Math.max(1, ...layout.nodes.map((node) => node.row + 1));
	return {
		w: Math.max(1, layout.layers) * BOARD_STEP.x - (BOARD_STEP.x - CARD_WIDTH),
		h: tallest * BOARD_STEP.y,
	};
}

export interface BoardInput {
	/** Top-left of where the map's cards go. */
	at: Point;
	/** Items already on the board, by key: connected where they are. */
	onBoard: ReadonlyMap<string, string>;
	connected: (a: string, b: string) => boolean;
	/** Just these items (one clicked node), or everything. */
	only?: string[];
}

/**
 * The cards and connectors that put a map (or some of it) on the board: a
 * card for each item that isn't there yet, in the map's layers, and a red
 * “blocks” connector for every edge between items that will be on it.
 */
export function planDependencyBoard(layout: DependencyLayout, input: BoardInput): ExpandPlan {
	const plan: ExpandPlan = { cards: [], connectors: [], existing: [] };
	const wanted = input.only ? new Set(input.only) : null;
	const ends = new Map<string, PlannedEnd>();
	const pick = wanted ? layout.nodes.filter((node) => wanted.has(node.key)) : layout.nodes;
	const tallest = Math.max(1, ...layout.nodes.map((node) => node.row + 1));
	// A single item goes where it was asked to; a whole map keeps its shape.
	const minLayer = Math.min(...pick.map((node) => node.layer));
	const ordered = [...pick].sort((a, b) => a.layer - b.layer || a.row - b.row);
	ordered.forEach((node, order) => {
		const shape = input.onBoard.get(node.key);
		if (shape) {
			plan.existing.push({ key: node.key, shape, group: "blockedBy" });
			ends.set(node.key, { shape });
			return;
		}
		const column = layout.nodes.filter((n) => n.layer === node.layer).length;
		const offset = wanted ? 0 : ((tallest - column) * BOARD_STEP.y) / 2;
		const box: Rect = {
			x: input.at.x + (wanted ? 0 : (node.layer - minLayer) * BOARD_STEP.x),
			y: input.at.y + (wanted ? order * BOARD_STEP.y : offset + node.row * BOARD_STEP.y),
			w: CARD_WIDTH,
			h: 124,
		};
		plan.cards.push({ key: node.key, group: "blockedBy", box, order });
		ends.set(node.key, { key: node.key });
	});
	// Edges between anything that will be on the board, the new and what's there.
	const endOf = (key: string): PlannedEnd | undefined => {
		const known = ends.get(key);
		if (known) return known;
		const shape = input.onBoard.get(key);
		return shape ? { shape } : undefined;
	};
	for (const edge of layout.edges) {
		if (wanted && !wanted.has(edge.from) && !wanted.has(edge.to)) continue;
		const from = endOf(edge.from);
		const to = endOf(edge.to);
		if (!from || !to) continue;
		if ("shape" in from && "shape" in to && input.connected(from.shape, to.shape)) continue;
		plan.connectors.push({
			group: "blockedBy",
			from,
			to,
			style: { color: "red", label: "blocks" },
		});
	}
	return plan;
}

/** What a map says in a line, for its footer and zoomed out. */
export function describeMap(graph: DependencyGraph, layout: DependencyLayout): string {
	const linked = layout.nodes.length;
	if (graph.nodes.size === 0) return "Nothing to map yet";
	if (linked === 0) return "Nothing here blocks anything";
	const parts = [
		`${layout.edges.length} ${layout.edges.length === 1 ? "dependency" : "dependencies"}`,
	];
	if (layout.cycles.length > 0) {
		parts.push(`${layout.cycles.length} ${layout.cycles.length === 1 ? "cycle" : "cycles"}`);
	}
	if (layout.critical.length > 0) parts.push(`critical path of ${layout.critical.length}`);
	return parts.join(" · ");
}

/** The map's title: its own, or what it maps. */
export function dependencyTitle(
	config: Pick<DependencyConfig, "title" | "source" | "q">,
	sectionTitle?: string | null,
): string {
	if (config.title.trim()) return config.title.trim();
	if (config.source === "section") {
		return sectionTitle ? `Dependencies in ${sectionTitle}` : "Dependency map";
	}
	return config.q.trim() ? "Dependencies" : "New dependency map";
}
