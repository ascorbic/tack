import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	type ChildInput,
	type KnownParent,
	defaultParentMode,
	moveSubIssueHere,
	readHierarchy,
	stageParentIssue,
} from "../src/shared/actions.ts";
import {
	type PendingChange,
	type Stager,
	changesMap,
	listChanges,
	retryCanWork,
} from "../src/shared/changes.ts";
import { addShape, transactLocal } from "../src/shared/shapes.ts";
import { indexChanges, summarize, summarizeBatch } from "../src/client/changes/describe.ts";

// Making a parent issue of something that already has one (a section that
// was made a parent issue in an earlier push, say): what's staged.

const PRIYA: Stager = { login: "priya", name: "Priya Shah" };
const REPO = "github.com/ascorbic/tack-sandbox";
const key = (n: number) => `${REPO}#${n}`;

function board() {
	const doc = new Y.Doc();
	transactLocal(doc, () => {
		addShape(doc, "section", {
			type: "section",
			title: "Resizing",
			x: 0,
			y: 0,
			w: 600,
			h: 400,
			z: "a0",
		});
	});
	return doc;
}

const cardChild = (shape: string, n: number): ChildInput => ({
	shape,
	card: { key: key(n), kind: "issue" },
});

/** Mark a staged change as the push engine would once it's applied. */
function applied(doc: Y.Doc, id: string, result?: { key: string }) {
	const change = changesMap(doc).get(id);
	change?.set("status", "applied");
	change?.set("updatedAt", "2026-10-10T10:00:00.000Z");
	if (result) change?.set("result", result);
}

const nothingKnown = () => undefined;
const subIssues = (doc: Y.Doc) =>
	listChanges(doc).filter((change) => change.op.kind === "item.subIssue");

/** The section made a parent issue (#4) of two stickies, pushed and applied. */
function pushedOnce(doc: Y.Doc) {
	const first = stageParentIssue(
		doc,
		{ repo: REPO, title: "Resizing", shapes: ["section"], near: ["section"] },
		[
			{ shape: "s5", sticky: "Wobble on resize" },
			{ shape: "s6", sticky: "Snap back after a drag" },
		],
		PRIYA,
	);
	for (const change of listChanges(doc)) {
		if (change.id === first.parent) applied(doc, change.id, { key: key(4) });
		else if (change.op.kind === "issue.create") {
			applied(doc, change.id, { key: key(change.op.title.startsWith("Wobble") ? 5 : 6) });
		} else applied(doc, change.id);
	}
	return first;
}

describe("reading what's already above a section", () => {
	it("knows a section this board already made a parent issue, and its sub-issues", () => {
		const doc = board();
		pushedOnce(doc);
		// The stickies are cards for #5 and #6 now, whose data may not say yet.
		const children = [cardChild("s5", 5), cardChild("s6", 6)];
		const hierarchy = readHierarchy(
			doc,
			{ section: "section", shapes: ["section"] },
			children,
			nothingKnown,
		);
		expect(hierarchy.existing).toMatchObject({
			target: { key: key(4) },
			label: "#4",
			title: "Resizing",
			via: "board",
		});
		expect([...hierarchy.parents.keys()]).toEqual(["s5", "s6"]);
		expect(hierarchy.parents.get("s5")?.target).toEqual({ key: key(4) });
		expect(defaultParentMode(hierarchy)).toBe("add");
	});

	it("knows from card data that every child shares a parent", () => {
		const doc = board();
		const known = (k: string): KnownParent | undefined =>
			k === key(5) || k === key(6) ? { key: key(4), title: "Resizing" } : { key: null };
		const children = [cardChild("c5", 5), cardChild("c6", 6), cardChild("c7", 7)];
		const hierarchy = readHierarchy(
			doc,
			{ section: "section", shapes: ["section"] },
			children,
			known,
		);
		expect(hierarchy.existing).toMatchObject({
			target: { key: key(4) },
			title: "Resizing",
			via: "children",
		});
		expect(hierarchy.parents.has("c7")).toBe(false);
	});

	it("knows a card connected down into the section is its parent", () => {
		const doc = board();
		transactLocal(doc, () => {
			addShape(doc, "parent", { type: "card", ref: key(4), x: 0, y: -200, z: "a1" });
			addShape(doc, "line", {
				type: "connector",
				x: 0,
				y: 0,
				from: { x: 0, y: 0, shape: "parent" },
				to: { x: 0, y: 0, shape: "section" },
				route: "elbow",
				z: "a2",
			});
		});
		const hierarchy = readHierarchy(
			doc,
			{ section: "section", shapes: ["section"] },
			[{ shape: "s1", sticky: "New idea" }],
			nothingKnown,
		);
		expect(hierarchy.existing).toMatchObject({ target: { key: key(4) }, via: "connector" });
	});

	it("has no existing parent when children are under different ones", () => {
		const doc = board();
		const known = (k: string): KnownParent | undefined => ({
			key: k === key(5) ? key(4) : key(9),
		});
		const hierarchy = readHierarchy(
			doc,
			{ section: "section", shapes: ["section"] },
			[cardChild("c5", 5), cardChild("c6", 6)],
			known,
		);
		expect(hierarchy.existing).toBeNull();
		expect(hierarchy.parents.size).toBe(2);
		expect(defaultParentMode(hierarchy)).toBe("skip");
	});

	it("takes the forge's word over an older push, and the push's over older card data", () => {
		const doc = board();
		pushedOnce(doc);
		const children = [cardChild("s5", 5)];
		const from = { section: "section", shapes: ["section"] };
		// Moved on GitHub since (the card was updated after the push).
		const later = () => ({ key: key(9), at: "2026-10-11T00:00:00.000Z" });
		expect(readHierarchy(doc, from, children, later).parents.get("s5")?.target).toEqual({
			key: key(9),
		});
		// Read before the push: the push is newer.
		const earlier = () => ({ key: null, at: "2026-10-01T00:00:00.000Z" });
		expect(readHierarchy(doc, from, children, earlier).parents.get("s5")?.target).toEqual({
			key: key(4),
		});
	});

	it("knows a parent staged for the section but not pushed yet", () => {
		const doc = board();
		const first = stageParentIssue(
			doc,
			{ repo: REPO, title: "Resizing", shapes: ["section"], near: ["section"] },
			[{ shape: "s5", sticky: "Wobble on resize" }],
			PRIYA,
		);
		const hierarchy = readHierarchy(
			doc,
			{ section: "section", shapes: ["section"] },
			[
				{ shape: "s5", sticky: "Wobble on resize" },
				{ shape: "s7", sticky: "Handles too small" },
			],
			nothingKnown,
		);
		expect(hierarchy.existing).toMatchObject({
			target: { pending: first.parent },
			label: "“Resizing”",
		});
		expect(hierarchy.parents.get("s5")).toMatchObject({ target: { pending: first.parent } });
	});
});

describe("making a parent issue of what already has one", () => {
	it("adds only what's new to the parent that's there, by default", () => {
		const doc = board();
		pushedOnce(doc);
		const before = listChanges(doc).length;
		const children: ChildInput[] = [
			cardChild("s5", 5),
			cardChild("s6", 6),
			{ shape: "s7", sticky: "Handles too small" },
		];
		const hierarchy = readHierarchy(
			doc,
			{ section: "section", shapes: ["section"] },
			children,
			nothingKnown,
		);
		const result = stageParentIssue(
			doc,
			{ repo: REPO, title: "Resizing", shapes: ["section"], near: ["section"] },
			children,
			PRIYA,
			{ hierarchy },
		);
		// No second "Resizing": #7 goes under #4, and #5 and #6 stay.
		expect(result.parent).toBeNull();
		expect(result.into).toEqual({ key: key(4) });
		expect(result.children).toBe(1);
		expect(result.skipped).toEqual([
			{ shape: "s5", reason: "already" },
			{ shape: "s6", reason: "already" },
		]);
		const added = listChanges(doc).slice(before);
		expect(added.map((change) => change.op.kind)).toEqual(["issue.create", "item.subIssue"]);
		expect(added[1]?.op).toEqual({
			kind: "item.subIssue",
			parent: { key: key(4) },
			child: { pending: added[0]?.id },
		});
		expect(
			listChanges(doc).filter(
				(change) => change.op.kind === "issue.create" && change.op.title === "Resizing",
			),
		).toHaveLength(1);
	});

	it("leaves out children under another parent when adding", () => {
		const doc = board();
		const known = (k: string): KnownParent => ({ key: k === key(8) ? key(2) : key(4) });
		const children = [cardChild("c5", 5), cardChild("c8", 8)];
		const hierarchy = readHierarchy(
			doc,
			{ section: "section", shapes: ["section"] },
			children,
			known,
		);
		// #5 under #4 and #8 under #2: no one parent, so nothing to add to.
		expect(hierarchy.existing).toBeNull();
		const result = stageParentIssue(
			doc,
			{ repo: REPO, title: "Resizing", shapes: ["section"] },
			children,
			PRIYA,
			{ hierarchy },
		);
		expect(result.children).toBe(0);
		expect(result.skipped.map((s) => s.reason)).toEqual(["parented", "parented"]);
	});

	it("makes a new parent and moves them, saying where from", () => {
		const doc = board();
		pushedOnce(doc);
		const children = [cardChild("s5", 5), cardChild("s6", 6)];
		const hierarchy = readHierarchy(
			doc,
			{ section: "section", shapes: ["section"] },
			children,
			nothingKnown,
		);
		const result = stageParentIssue(
			doc,
			{ repo: REPO, title: "Resizing and dragging", shapes: ["section"], near: ["section"] },
			children,
			PRIYA,
			{ hierarchy, mode: "move" },
		);
		expect(result.parent).not.toBeNull();
		expect(result.moved).toBe(2);
		const links = subIssues(doc).filter((change) => change.status === "staged");
		expect(links.map((change) => change.op)).toEqual([
			{
				kind: "item.subIssue",
				parent: { pending: result.parent },
				child: { key: key(5) },
				replaceParent: true,
				previousParent: key(4),
			},
			{
				kind: "item.subIssue",
				parent: { pending: result.parent },
				child: { key: key(6) },
				replaceParent: true,
				previousParent: key(4),
			},
		]);
		const index = indexChanges(listChanges(doc));
		expect(summarize(links[0]!.op, index)).toBe("Move #5 from #4 to “Resizing and dragging”");
		expect(summarizeBatch(links, index)).toBe(
			"2 sub-issues of “Resizing and dragging”, moving them all",
		);
	});

	it("makes a new parent without them", () => {
		const doc = board();
		pushedOnce(doc);
		const children: ChildInput[] = [cardChild("s5", 5), { shape: "s7", sticky: "Handles" }];
		const hierarchy = readHierarchy(
			doc,
			{ section: "section", shapes: ["section"] },
			children,
			nothingKnown,
		);
		const result = stageParentIssue(
			doc,
			{ repo: REPO, title: "Handles", shapes: ["section"] },
			children,
			PRIYA,
			{ hierarchy, mode: "skip" },
		);
		expect(result.children).toBe(1);
		expect(result.skipped).toEqual([{ shape: "s5", reason: "parented" }]);
	});

	it("re-points a link that's staged but not pushed, rather than moving it", () => {
		const doc = board();
		const first = stageParentIssue(
			doc,
			{ repo: REPO, title: "Resizing", shapes: ["section"], near: ["section"] },
			[cardChild("c5", 5)],
			PRIYA,
		);
		const children = [cardChild("c5", 5)];
		const hierarchy = readHierarchy(
			doc,
			{ section: "section", shapes: ["section"] },
			children,
			nothingKnown,
		);
		const second = stageParentIssue(
			doc,
			{ repo: REPO, title: "Something else", shapes: ["section"] },
			children,
			PRIYA,
			{ hierarchy, mode: "move" },
		);
		const links = subIssues(doc);
		expect(links).toHaveLength(1);
		expect(links[0]?.op).toEqual({
			kind: "item.subIssue",
			parent: { pending: second.parent },
			child: { key: key(5) },
		});
		expect(first.parent).not.toBe(second.parent);
	});

	it("is one undo step, as before", () => {
		const doc = board();
		pushedOnce(doc);
		const children = [cardChild("s5", 5), { shape: "s7", sticky: "Handles" } as ChildInput];
		const hierarchy = readHierarchy(
			doc,
			{ section: "section", shapes: ["section"] },
			children,
			nothingKnown,
		);
		const undo = new Y.UndoManager(changesMap(doc), { trackedOrigins: new Set(["local"]) });
		undo.clear();
		stageParentIssue(doc, { repo: REPO, title: "Resizing" }, children, PRIYA, { hierarchy });
		const staged = listChanges(doc).filter((change) => change.status === "staged").length;
		expect(staged).toBe(2);
		undo.undo();
		expect(listChanges(doc).filter((change) => change.status === "staged")).toHaveLength(0);
		undo.destroy();
	});
});

describe("a sub-issue refused for having a parent", () => {
	function refused(doc: Y.Doc): string {
		const result = stageParentIssue(doc, { repo: REPO, title: "New" }, [cardChild("c5", 5)], PRIYA);
		const link = subIssues(doc)[0] as PendingChange;
		applied(doc, result.parent as string, { key: key(8) });
		const change = changesMap(doc).get(link.id);
		change?.set("status", "failed");
		change?.set("error", "#5 already has a parent issue (#4), and an issue can only have one.");
		change?.set("problem", { code: "has_parent", parent: key(4) });
		return link.id;
	}

	it("can't be retried as it is, but can be moved here", () => {
		const doc = board();
		const id = refused(doc);
		const change = listChanges(doc).find((c) => c.id === id);
		expect(retryCanWork(change?.problem)).toBe(false);
		expect(moveSubIssueHere(doc, id)).toBe(true);
		const moved = listChanges(doc).find((c) => c.id === id);
		expect(moved?.op).toMatchObject({ replaceParent: true, previousParent: key(4) });
		expect(moved?.problem).toBeUndefined();
		// Moving twice does nothing more.
		expect(moveSubIssueHere(doc, id)).toBe(false);
	});

	it("leaves loops and limits to a retry once they're sorted out", () => {
		expect(retryCanWork({ code: "cycle" })).toBe(true);
		expect(retryCanWork({ code: "too_many" })).toBe(true);
		expect(retryCanWork({ code: "self" })).toBe(false);
		expect(retryCanWork(undefined)).toBe(true);
	});
});
