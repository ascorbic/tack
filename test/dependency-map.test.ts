import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import type { Card } from "../src/shared/cards.ts";
import {
	MAP_SIZE,
	buildDependencyGraph,
	dependencyMembers,
	describeMap,
	edgePath,
	layoutDependencies,
	planDependencyBoard,
	relatedName,
	stronglyConnected,
} from "../src/shared/dependencyMap.ts";
import { addShape } from "../src/shared/shapes.ts";
import { addSection } from "../src/shared/structure.ts";
import { boardQueryContext } from "../src/shared/widgetContext.ts";
import { widgetFollowUps, widgetQueries } from "../src/shared/widgetRegistry.ts";
import type { QueryError, QueryResult, RelatedResult } from "../src/shared/widgets.ts";
import { card } from "./card-fixture.ts";

const key = (n: number) => `github.com/acme/widgets#${n}`;
const item = (n: number, state: Card["state"] = "open") =>
	card({ item: `#${n}`, state, title: `Item ${n}` });

/** `related` results from `[blocker, blocked]` pairs, as each member would see them. */
function related(
	members: number[],
	pairs: [number, number][],
	states: Record<number, Card["state"]> = {},
): Record<string, QueryResult | QueryError> {
	const results: Record<string, QueryResult | QueryError> = {};
	for (const n of members) {
		const blockedBy = pairs.filter(([, b]) => b === n).map(([a]) => a);
		const blocking = pairs.filter(([a]) => a === n).map(([, b]) => b);
		const result: RelatedResult = {
			kind: "related",
			key: key(n),
			subIssues: [],
			blockedBy: blockedBy.map(key),
			blocking: blocking.map(key),
			linkedPulls: [],
			cards: [...blockedBy, ...blocking].map((m) => item(m, states[m])),
		};
		results[relatedName(key(n))] = result;
	}
	return results;
}

describe("dependency map queries", () => {
	it("search, then ask what's related to each result, within the limit", () => {
		const shape = {
			widget: "dependencies",
			config: { q: "repo:acme/widgets is:open", limit: 5 },
		};
		expect(widgetQueries(shape)).toEqual({
			items: {
				kind: "search",
				host: "github.com",
				q: "repo:acme/widgets is:open",
				sort: "updated",
				order: "desc",
				limit: 5,
			},
		});
		const items = Array.from({ length: 7 }, (_, i) => item(i + 1));
		const followUps = widgetFollowUps(shape, {
			items: { kind: "search", total: 7, items },
		});
		expect(Object.keys(followUps)).toHaveLength(5);
		expect(followUps[relatedName(key(1))]).toEqual({ kind: "related", key: key(1) });
		// Nothing to follow up until the search answers.
		expect(widgetFollowUps(shape, {})).toEqual({});
	});

	it("ask about the cards in a section, whatever order they're in", () => {
		const doc = new Y.Doc();
		const section = addSection(doc, { x: 0, y: 0, w: 900, h: 500 }, { title: "Launch" });
		const place = (n: number, x: number, y: number, parent: string | null = section) =>
			addShape(doc, `c${n}`, { type: "card", ref: key(n), x, y, z: `a${n}`, parent });
		place(2, 300, 20);
		place(1, 20, 20);
		place(3, 20, 200);
		place(9, 1200, 0, null);
		const context = boardQueryContext(doc);
		expect(context.cardsIn(section)).toEqual([key(1), key(2), key(3)]);
		const queries = widgetQueries(
			{ widget: "dependencies", config: { source: "section", section } },
			context,
		);
		expect(Object.keys(queries)).toEqual([key(1), key(2), key(3)].map(relatedName));
		expect(
			widgetQueries(
				{ widget: "dependencies", config: { source: "section", section: "gone" } },
				context,
			),
		).toEqual({});
		expect(
			dependencyMembers({ source: "section", limit: 20 }, queries as never, [key(3), key(1)]),
		).toEqual([key(3), key(1), key(2)]);
	});
});

describe("dependency graphs", () => {
	it("connect blockers to what they block, one step outside the set too", () => {
		// 1 blocks 2, 2 blocks 3; 9 (outside) blocks 1; 4 has nothing.
		const results = related(
			[1, 2, 3, 4],
			[
				[9, 1],
				[1, 2],
				[2, 3],
			],
		);
		const graph = buildDependencyGraph([1, 2, 3, 4].map(key), results);
		expect(graph.edges).toHaveLength(3);
		expect(graph.nodes.get(key(9))).toMatchObject({ member: false, open: true });
		expect(graph.isolated).toEqual([key(4)]);
		expect(graph.pending).toEqual([]);
	});

	it("say which items couldn't be read, or haven't answered", () => {
		const results = related([1], [[1, 2]]);
		results[relatedName(key(2))] = { kind: "error", reason: "no_access", message: "no" };
		const graph = buildDependencyGraph([1, 2, 3].map(key), results);
		expect(graph.unreadable).toEqual([key(2)]);
		expect(graph.nodes.get(key(2))?.unknown).toBe(true);
		expect(graph.pending).toEqual([key(3)]);
	});

	it("find strongly connected groups", () => {
		expect(
			stronglyConnected(
				["a", "b", "c", "d"],
				[
					{ from: "a", to: "b" },
					{ from: "b", to: "c" },
					{ from: "c", to: "a" },
					{ from: "c", to: "d" },
				],
			).map((group) => group.sort()),
		).toEqual([["d"], ["a", "b", "c"]]);
	});
});

describe("dependency layouts", () => {
	it("layer blockers before what they block, and find the critical path", () => {
		// 1 → 2 → 4, 1 → 3, 5 → 4 (5 is closed), and 6 → 7, apart.
		const pairs: [number, number][] = [
			[1, 2],
			[2, 4],
			[1, 3],
			[5, 4],
			[6, 7],
		];
		const members = [1, 2, 3, 4, 5, 6, 7];
		const graph = buildDependencyGraph(
			members.map(key),
			related(members, pairs, { 5: "closed" }),
			(k) => (k === key(5) ? item(5, "closed") : null),
		);
		const layout = layoutDependencies(graph);
		const at = (n: number) => layout.nodes.find((node) => node.key === key(n));
		expect([1, 2, 3, 4, 5, 6, 7].map((n) => at(n)?.layer)).toEqual([0, 1, 1, 2, 0, 0, 1]);
		expect(layout.layers).toBe(3);
		expect(layout.critical).toEqual([key(1), key(2), key(4)]);
		expect(layout.edges.filter((e) => e.critical).map((e) => [e.from, e.to])).toEqual([
			[key(1), key(2)],
			[key(2), key(4)],
		]);
		// Ready: open with nothing open blocking it.
		expect(
			layout.nodes
				.filter((n) => n.ready)
				.map((n) => n.key)
				.sort(),
		).toEqual([key(1), key(6)]);
		expect(layout.cycles).toEqual([]);
		expect(layout.width).toBe(3 * (MAP_SIZE.node.w + MAP_SIZE.gap.x) - MAP_SIZE.gap.x);
		expect(describeMap(graph, layout)).toBe("5 dependencies · critical path of 3");
	});

	it("flag cycles, which never get a critical path through them", () => {
		const members = [1, 2, 3, 4];
		const graph = buildDependencyGraph(
			members.map(key),
			related(members, [
				[1, 2],
				[2, 3],
				[3, 1],
				[3, 4],
			]),
		);
		const layout = layoutDependencies(graph);
		expect(layout.cycles.map((cycle) => cycle.sort())).toEqual([[key(1), key(2), key(3)].sort()]);
		expect(layout.nodes.filter((n) => n.cycle)).toHaveLength(3);
		expect(layout.nodes.find((n) => n.key === key(4))?.layer).toBe(1);
		expect(layout.edges.filter((e) => e.back).length).toBeGreaterThan(0);
		expect(layout.nodes.some((n) => n.ready)).toBe(false);
		expect(describeMap(graph, layout)).toContain("1 cycle");
	});

	it("draw edges forwards as curves, and backwards over the top", () => {
		const node = { w: 100, h: 40 };
		expect(edgePath({ x: 0, y: 0 }, { x: 200, y: 0 }, node)).toBe("M100 20 C150 20 150 20 200 20");
		expect(edgePath({ x: 200, y: 50 }, { x: 0, y: 0 }, node)).toBe("M250 50 C250 -26 50 -26 50 0");
	});
});

describe("dependency maps on the board", () => {
	const members = [1, 2, 3];
	const graph = buildDependencyGraph(
		members.map(key),
		related(members, [
			[1, 2],
			[2, 3],
		]),
	);
	const layout = layoutDependencies(graph);

	it("plan cards in columns and blocks connectors, connecting what's already there", () => {
		const plan = planDependencyBoard(layout, {
			at: { x: 1000, y: 0 },
			onBoard: new Map([[key(2), "existing"]]),
			connected: () => false,
		});
		expect(plan.existing).toEqual([{ key: key(2), shape: "existing", group: "blockedBy" }]);
		expect(plan.cards.map((c) => [c.key, c.box.x])).toEqual([
			[key(1), 1000],
			[key(3), 1000 + 2 * (252 + 104)],
		]);
		expect(plan.connectors).toEqual([
			{
				group: "blockedBy",
				from: { key: key(1) },
				to: { shape: "existing" },
				style: { color: "red", label: "blocks" },
			},
			{
				group: "blockedBy",
				from: { shape: "existing" },
				to: { key: key(3) },
				style: { color: "red", label: "blocks" },
			},
		]);
	});

	it("put one item on the board, connected to its neighbours that are there", () => {
		const plan = planDependencyBoard(layout, {
			at: { x: 40, y: 40 },
			onBoard: new Map([[key(1), "one"]]),
			connected: () => false,
			only: [key(2)],
		});
		expect(plan.cards).toEqual([
			expect.objectContaining({ key: key(2), box: expect.objectContaining({ x: 40, y: 40 }) }),
		]);
		expect(plan.connectors.map((c) => [c.from, c.to])).toEqual([
			[{ shape: "one" }, { key: key(2) }],
		]);
		// The rest of the map, with two already there and connected: just the third.
		const again = planDependencyBoard(layout, {
			at: { x: 0, y: 0 },
			onBoard: new Map([
				[key(1), "one"],
				[key(2), "two"],
			]),
			connected: () => true,
		});
		expect(again.cards.map((c) => c.key)).toEqual([key(3)]);
		expect(again.connectors).toEqual([
			expect.objectContaining({ from: { shape: "two" }, to: { key: key(3) } }),
		]);
	});
});
