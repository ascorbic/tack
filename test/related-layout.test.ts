import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { fakeRelated } from "../src/server/forges/fake.ts";
import type { Card } from "../src/shared/cards.ts";
import { type Rect, intersects } from "../src/shared/geometry.ts";
import { provenanceOf } from "../src/shared/provenance.ts";
import {
	applyExpand,
	boardContext,
	estimateCardHeight,
	planExpand,
	relatedGroups,
} from "../src/shared/related.ts";
import {
	LOCAL_ORIGIN,
	addShape,
	readShape,
	shapesMap,
	transactLocal,
} from "../src/shared/shapes.ts";
import { addConnector, addSection } from "../src/shared/structure.ts";

const REPO = "acme/app";
const key = (n: number) => `fake.tack/${REPO}#${n}`;
// Issue 12: parent 1, sub-issues 121, 122 and 125, blocked by 17, blocking 7, closed by 13.
const RESULT = fakeRelated(REPO, 12);
const SOURCE: Rect = { x: 1000, y: 1000, w: 252, h: 124 };

function plan(overrides: Partial<Parameters<typeof planExpand>[0]> = {}) {
	return planExpand({
		source: { id: "source", key: key(12), box: SOURCE },
		result: RESULT,
		onBoard: new Map([[key(12), "source"]]),
		obstacles: [],
		...overrides,
	});
}

const boxOf = (p: ReturnType<typeof plan>, n: number) => {
	const box = p.cards.find((c) => c.key === key(n))?.box;
	if (!box) throw new Error(`#${n} wasn't placed`);
	return box;
};

describe("planning an expansion", () => {
	it("puts the parent above, sub-issues below, blockers left, blocked right", () => {
		const p = plan();
		expect(p.cards.map((c) => c.key)).toEqual([1, 121, 122, 125, 17, 7, 13].map(key));
		expect(p.cards.map((c) => c.group)).toEqual([
			"parent",
			"subIssues",
			"subIssues",
			"subIssues",
			"blockedBy",
			"blocking",
			"linkedPulls",
		]);
		const parent = boxOf(p, 1);
		expect(parent.y + parent.h).toBeLessThan(SOURCE.y);
		expect(parent.x + parent.w / 2).toBe(SOURCE.x + SOURCE.w / 2);

		const subs = [121, 122, 125].map((n) => boxOf(p, n));
		for (const sub of subs) expect(sub.y).toBeGreaterThan(SOURCE.y + SOURCE.h);
		// One row, left to right, centred under the card.
		expect(new Set(subs.map((s) => s.y)).size).toBe(1);
		expect(subs[0]!.x).toBeLessThan(subs[1]!.x);
		const middle = (subs[0]!.x + subs[2]!.x + subs[2]!.w) / 2;
		expect(middle).toBe(SOURCE.x + SOURCE.w / 2);

		expect(boxOf(p, 17).x + boxOf(p, 17).w).toBeLessThan(SOURCE.x);
		expect(boxOf(p, 7).x).toBeGreaterThan(SOURCE.x + SOURCE.w);
		// Linked pull requests share the right column, above what it blocks.
		expect(boxOf(p, 13).x).toBe(boxOf(p, 7).x);
		expect(boxOf(p, 13).y + boxOf(p, 13).h).toBeLessThan(boxOf(p, 7).y);

		// Nothing overlaps anything.
		const boxes = [SOURCE, ...p.cards.map((c) => c.box)];
		for (const [i, a] of boxes.entries()) {
			for (const b of boxes.slice(i + 1)) expect(intersects(a, b)).toBe(false);
		}
	});

	it("connects each item the right way round, styled for what it means", () => {
		const p = plan();
		const of = (n: number) =>
			p.connectors.find(
				(c) => ("key" in c.from && c.from.key === key(n)) || ("key" in c.to && c.to.key === key(n)),
			);
		expect(of(1)).toMatchObject({
			from: { key: key(1) },
			to: { shape: "source" },
			style: { route: "elbow" },
			fromAnchor: { x: 0.5, y: 1 },
			toAnchor: { x: 0.5, y: 0 },
		});
		expect(of(121)).toMatchObject({ from: { shape: "source" }, to: { key: key(121) } });
		expect(of(17)).toMatchObject({
			from: { key: key(17) },
			to: { shape: "source" },
			style: { label: "blocks", color: "red" },
		});
		expect(of(7)).toMatchObject({ from: { shape: "source" }, to: { key: key(7) } });
		expect(of(13)).toMatchObject({
			from: { key: key(13) },
			style: { dash: true, color: "purple" },
		});
		expect(p.connectors).toHaveLength(7);
	});

	it("labels a pull request that closes the item", () => {
		const pull = RESULT.cards.find((c) => c.key === key(13)) as Card;
		const closing: Card = {
			...pull,
			pull: {
				detail: "full",
				head: null,
				checks: null,
				review: null,
				reviewers: [],
				mergeable: "unknown",
				linked: [{ key: key(12), item: "#12", repo: REPO, title: "", state: "open", url: "" }],
			},
		};
		const p = plan({
			result: { ...RESULT, cards: [...RESULT.cards, closing] },
			cards: new Map([[key(13), closing]]),
		});
		expect(p.connectors.find((c) => c.group === "linkedPulls")?.style.label).toBe("closes");
	});

	it("slides a group outward until it's clear of what's on the board", () => {
		const sticky: Rect = { x: SOURCE.x, y: SOURCE.y - 200, w: 260, h: 176 };
		const p = plan({ obstacles: [sticky] });
		const parent = boxOf(p, 1);
		expect(intersects(parent, sticky)).toBe(false);
		expect(parent.y + parent.h).toBeLessThan(sticky.y);
		// Still centred over the card.
		expect(parent.x + parent.w / 2).toBe(SOURCE.x + SOURCE.w / 2);
	});

	it("connects items already on the board instead of adding them again", () => {
		const p = plan({
			onBoard: new Map([
				[key(12), "source"],
				[key(1), "parent-card"],
				[key(17), "blocker-card"],
			]),
			connected: (a, b) => a === "source" && b === "blocker-card",
		});
		expect(p.cards.map((c) => c.key)).not.toContain(key(1));
		expect(p.existing.map((e) => e.key)).toEqual([key(1), key(17)]);
		// Joined to the parent where it is, with a floating curve; the blocker already was.
		expect(p.connectors.find((c) => c.group === "parent")).toMatchObject({
			from: { shape: "parent-card" },
			to: { shape: "source" },
			style: { route: "curved" },
		});
		expect(p.connectors.some((c) => "shape" in c.from && c.from.shape === "blocker-card")).toBe(
			false,
		);
	});

	it("brings in only the groups asked for", () => {
		const p = plan({ groups: new Set(["subIssues"]) });
		expect(p.cards.map((c) => c.group)).toEqual(["subIssues", "subIssues", "subIssues"]);
		expect(p.connectors).toHaveLength(3);
	});

	it("wraps many sub-issues into rows", () => {
		const many = { ...RESULT, subIssues: Array.from({ length: 9 }, (_, i) => key(500 + i)) };
		const p = plan({ result: many, groups: new Set(["subIssues"]) });
		expect(new Set(p.cards.map((c) => c.box.y)).size).toBe(3);
	});

	it("groups and sizes", () => {
		expect(
			relatedGroups({ ...RESULT, subIssues: [key(12), key(121), key(121)] }).subIssues,
		).toEqual([key(121)]);
		expect(estimateCardHeight(undefined)).toBe(124);
		const pull = RESULT.cards.find((c) => c.key === key(13)) as Card;
		expect(estimateCardHeight({ ...pull, labels: [] })).toBeLessThan(
			estimateCardHeight({ ...pull, labels: [{ name: "bug", color: "f00" }] }),
		);
	});
});

describe("applying an expansion", () => {
	function board() {
		const doc = new Y.Doc();
		addShape(doc, "source", { type: "card", ref: key(12), x: 100, y: 100, z: "a1" });
		addShape(doc, "parent-card", { type: "card", ref: key(1), x: 2000, y: 0, z: "a2" });
		addShape(doc, "note", { type: "sticky", text: "hi", x: 100, y: -150, z: "a3" });
		addSection(doc, { x: 0, y: 0, w: 600, h: 400 }, { title: "Here" });
		return doc;
	}

	it("adds cards and connectors as one undo step, placed by hand", () => {
		const doc = board();
		const context = boardContext(doc, "source");
		expect(context.onBoard.get(key(1))).toBe("parent-card");
		// The section the card is in isn't in the way; the sticky is.
		expect(context.obstacles).toHaveLength(2);

		const undo = new Y.UndoManager(shapesMap(doc), { trackedOrigins: new Set([LOCAL_ORIGIN]) });
		const p = planExpand({
			source: { id: "source", key: key(12), box: context.box! },
			result: RESULT,
			...context,
		});
		const before = shapesMap(doc).size;
		const added = transactLocal(doc, () => applyExpand(doc, p));
		expect(added.cards.size).toBe(6);
		expect(added.connectors).toHaveLength(7);
		expect(shapesMap(doc).size).toBe(before + 13);

		for (const id of added.cards.values()) {
			const shape = readShape(shapesMap(doc).get(id)!);
			expect(shape.type).toBe("card");
			expect(shape.provenance).toBeUndefined();
			expect(provenanceOf(shape)).toEqual({ via: "manual" });
		}
		const blocks = [...added.connectors]
			.map((id) => readShape(shapesMap(doc).get(id)!))
			.filter((c) => c.label === "blocks");
		expect(blocks).toHaveLength(2);
		expect(blocks.find((c) => c.to?.shape === "source")?.from?.shape).toBe(
			added.cards.get(key(17)),
		);
		// The existing parent card is connected where it is.
		expect(
			[...added.connectors].some(
				(id) => readShape(shapesMap(doc).get(id)!).from?.shape === "parent-card",
			),
		).toBe(true);

		undo.undo();
		expect(shapesMap(doc).size).toBe(before);
	});

	it("doesn't connect what's already connected", () => {
		const doc = board();
		addConnector(doc, {
			from: { x: 0, y: 0, shape: "parent-card" },
			to: { x: 0, y: 0, shape: "source" },
		});
		const context = boardContext(doc, "source");
		const p = planExpand({
			source: { id: "source", key: key(12), box: context.box! },
			result: RESULT,
			...context,
		});
		expect(p.connectors.filter((c) => c.group === "parent")).toHaveLength(0);
	});
});
