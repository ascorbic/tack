import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	actionIssue,
	actionState,
	actionsSection,
	addActionItem,
	addDays,
	carryable,
	daysBetween,
	describeDue,
	duePresets,
	dueState,
	isDate,
	linkActionItem,
	linkActionItems,
	placeCarried,
	setActionDone,
	stageActionIssue,
	stageActionState,
	stagedIssueOf,
	stagedStateOf,
	stickiesToActions,
	unlinkActionItem,
	updateActionItem,
} from "../src/shared/actionItems.ts";
import { changesMap, listChanges } from "../src/shared/changes.ts";
import { repairBoard } from "../src/shared/repair.ts";
import { addShape, cardRefs, readShape, shapesMap } from "../src/shared/shapes.ts";
import { addConnector, addSection, readShapes } from "../src/shared/structure.ts";
import { card } from "./card-fixture.ts";

const PRIYA = { login: "priya", name: "Priya Shah", avatarUrl: "https://example.com/p.png" };
const STAGER = { name: "Priya Shah", login: "priya" };
const KEY = "github.com/acme/widgets#12";

function board() {
	const doc = new Y.Doc();
	addActionItem(doc, "a", {
		x: 0,
		y: 0,
		text: "Write the migration guide\nCover the config changes",
	});
	const get = () => readShape(shapesMap(doc).get("a") as Y.Map<unknown>);
	return { doc, get };
}

describe("due dates", () => {
	it("checks calendar dates", () => {
		expect(isDate("2026-10-18")).toBe(true);
		expect(isDate("2026-02-30")).toBe(false);
		expect(isDate("18/10/2026")).toBe(false);
		expect(isDate(undefined)).toBe(false);
	});

	it("counts days, across months and years", () => {
		expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
		expect(daysBetween("2026-10-10", "2026-10-18")).toBe(8);
		expect(daysBetween("2026-10-10", "2026-10-07")).toBe(-3);
	});

	it("says how soon something's due, unless it's done", () => {
		const today = "2026-10-10";
		expect(dueState(undefined, today)).toBe("none");
		expect(dueState("2026-10-09", today)).toBe("overdue");
		expect(dueState("2026-10-10", today)).toBe("today");
		expect(dueState("2026-10-13", today)).toBe("soon");
		expect(dueState("2026-10-14", today)).toBe("later");
		expect(dueState("2026-10-09", today, true)).toBe("none");
	});

	it("describes due dates relative to today", () => {
		// 10 October 2026 is a Saturday.
		const today = "2026-10-10";
		expect(describeDue("2026-10-10", today)).toBe("Today");
		expect(describeDue("2026-10-11", today)).toBe("Tomorrow");
		expect(describeDue("2026-10-09", today)).toBe("Yesterday");
		expect(describeDue("2026-10-06", today)).toBe("4 days late");
		expect(describeDue("2026-10-14", today)).toBe("Wed");
		expect(describeDue("2026-10-30", today)).toBe("30 Oct");
		expect(describeDue("2027-01-04", today)).toBe("4 Jan 2027");
		expect(describeDue("2026-10-06", today, true)).toBe("6 Oct");
	});

	it("offers quick picks without repeats", () => {
		const presets = duePresets("2026-10-10");
		expect(presets.map((p) => p.label)).toEqual([
			"Today",
			"Tomorrow",
			"Friday",
			"Next week",
			"In 2 weeks",
		]);
		expect(presets.find((p) => p.label === "Friday")?.date).toBe("2026-10-16");
		expect(presets.find((p) => p.label === "Next week")?.date).toBe("2026-10-12");
		// On a Friday, "Friday" is next week's.
		expect(duePresets("2026-10-16").find((p) => p.date === "2026-10-23")?.label).toBe(
			"Next Friday",
		);
	});
});

describe("action items", () => {
	it("are their own shapes, with an owner and due date", () => {
		const { doc, get } = board();
		updateActionItem(doc, "a", { owner: { ...PRIYA, login: "@priya" }, due: "2026-10-18" });
		expect(get()).toMatchObject({ type: "action", owner: PRIYA, due: "2026-10-18" });
		updateActionItem(doc, "a", { due: "not a date" });
		expect(get().due).toBe("2026-10-18");
		updateActionItem(doc, "a", { owner: null, due: null });
		expect(get().owner).toBeUndefined();
		expect(get().due).toBeUndefined();
	});

	it("take their status from the board until they're linked, then from the issue", () => {
		const { doc, get } = board();
		expect(actionState(get(), undefined)).toEqual({ status: "open", from: "board" });
		setActionDone(doc, "a", true, "2026-10-10T12:00:00Z");
		expect(actionState(get(), undefined)).toEqual({ status: "done", from: "board" });

		linkActionItem(doc, "a", KEY);
		expect(get().done).toBeUndefined();
		expect(cardRefs(doc).has(KEY)).toBe(true);
		expect(actionState(get(), undefined)).toEqual({ status: "open", from: "unknown" });
		expect(actionState(get(), card({ state: "open" }))).toEqual({ status: "open", from: "issue" });
		expect(actionState(get(), card({ state: "closed", stateReason: "completed" }))).toEqual({
			status: "done",
			from: "issue",
			reason: "completed",
		});
		// Ticking a linked item on the board does nothing: the issue decides.
		setActionDone(doc, "a", true);
		expect(get().done).toBeUndefined();

		unlinkActionItem(doc, "a", true);
		expect(get().ref).toBeUndefined();
		expect(actionState(get(), undefined).status).toBe("done");
	});

	it("stage an issue assigned to their owner, which links them once it's made", () => {
		const { doc, get } = board();
		updateActionItem(doc, "a", { owner: PRIYA, due: "2026-10-18" });
		const id = stageActionIssue(doc, "a", "github.com/acme/widgets", STAGER, {
			boardUrl: "https://tack.example/b/x/retro",
			boardTitle: "Retro [Oct]",
			extras: { labels: ["docs"] },
		});
		expect(id).not.toBeNull();
		const change = listChanges(doc)[0];
		expect(change?.op).toMatchObject({
			kind: "issue.create",
			repo: "github.com/acme/widgets",
			title: "Write the migration guide",
			labels: ["docs"],
			assignees: ["priya"],
		});
		const body = (change?.op as { body?: string } | undefined)?.body ?? "";
		expect(body).toContain("Cover the config changes");
		expect(body).toContain("**Due** 2026-10-18 · **Owner** @priya");
		expect(body).toContain("[Retro Oct](https://tack.example/b/x/retro)");
		expect(change?.effect).toEqual({ kind: "link", shapes: ["a"] });
		expect(get().issue).toBe(id);
		expect(stagedIssueOf(doc, get())?.id).toBe(id);
		// Only one at a time.
		expect(stageActionIssue(doc, "a", "github.com/acme/widgets", STAGER)).toBeNull();

		expect(linkActionItems(doc, ["a", "gone"], "github.com/acme/widgets#100")).toBe(1);
		expect(get().ref).toBe("github.com/acme/widgets#100");
		expect(linkActionItems(doc, ["a"], "github.com/acme/widgets#100")).toBe(0);
	});

	it("say nothing as an issue when there's nothing written", () => {
		expect(actionIssue({ text: "  " })).toBeNull();
		const doc = new Y.Doc();
		addActionItem(doc, "e", { x: 0, y: 0 });
		expect(stageActionIssue(doc, "e", "github.com/acme/widgets", STAGER)).toBeNull();
	});

	it("unstage their issue when they're linked to one that exists", () => {
		const { doc, get } = board();
		stageActionIssue(doc, "a", "github.com/acme/widgets", STAGER);
		linkActionItem(doc, "a", KEY);
		expect(changesMap(doc).size).toBe(0);
		expect(get().issue).toBeUndefined();
		expect(get().ref).toBe(KEY);
	});

	it("stage closing their issue when ticked, and take it back when unticked", () => {
		const { doc } = board();
		linkActionItem(doc, "a", KEY);
		expect(stageActionState(doc, "a", true, STAGER)).toMatchObject({ state: "closed" });
		expect(stagedStateOf(doc, KEY)?.op).toEqual({
			kind: "item.state",
			target: { key: KEY },
			state: "closed",
			reason: "completed",
		});
		expect(stageActionState(doc, "a", false, STAGER)).toBeNull();
		expect(changesMap(doc).size).toBe(0);
		expect(stageActionState(doc, "a", false, STAGER)).toMatchObject({ state: "open" });
		// Not linked: nothing to stage.
		addActionItem(doc, "b", { x: 0, y: 0, text: "Loose" });
		expect(stageActionState(doc, "b", true, STAGER)).toBeNull();
	});

	it("are made from stickies in place, keeping their connectors", () => {
		const doc = new Y.Doc();
		addSection(doc, { x: 0, y: 0, w: 600, h: 400 }, { id: "s", title: "Actions" });
		addShape(doc, "sticky", {
			type: "sticky",
			x: 40,
			y: 60,
			z: "a5",
			text: "Ship it",
			author: { name: "Kai", color: "#1f7a6b" },
		});
		addShape(doc, "card", { type: "card", ref: KEY, x: 800, y: 0, z: "a6" });
		addConnector(doc, { from: { x: 0, y: 0, shape: "sticky" }, to: { x: 0, y: 0, shape: "card" } });
		const [id] = stickiesToActions(doc, ["sticky", "card"]);
		const shapes = readShapes(doc);
		expect(shapes.has("sticky")).toBe(false);
		expect(shapes.get(id as string)).toMatchObject({
			type: "action",
			text: "Ship it",
			x: 40,
			y: 60,
			z: "a5",
			parent: "s",
			author: { name: "Kai" },
		});
		const connector = [...shapes.values()].find((shape) => shape.type === "connector");
		expect(connector?.from?.shape).toBe(id);
	});

	it("are repaired when another client writes junk", () => {
		const doc = new Y.Doc();
		addShape(doc, "a", {
			type: "action",
			x: 0,
			y: 0,
			z: "a0",
			owner: { login: "not a login!" },
			due: "soon",
			done: true as unknown as string,
		});
		expect(repairBoard(doc).actions).toBe(1);
		const shape = readShape(shapesMap(doc).get("a") as Y.Map<unknown>);
		expect(shape.owner).toBeUndefined();
		expect(shape.due).toBeUndefined();
		expect(shape.done).toBeUndefined();
		expect(repairBoard(doc).actions).toBe(0);
	});
});

describe("carrying over", () => {
	function source() {
		const doc = new Y.Doc();
		addActionItem(doc, "late", {
			x: 0,
			y: 200,
			text: "Fix flaky CI",
			owner: PRIYA,
			due: "2026-10-01",
		});
		addActionItem(doc, "first", { x: 0, y: 0, text: "Write docs", ref: KEY });
		addActionItem(doc, "done", { x: 0, y: 100, text: "Done already" });
		setActionDone(doc, "done", true);
		addActionItem(doc, "closed", {
			x: 0,
			y: 300,
			text: "Closed issue",
			ref: "github.com/acme/widgets#13",
		});
		const cards = new Map([
			[KEY, card({ state: "open" })],
			["github.com/acme/widgets#13", card({ item: "#13", state: "closed" })],
		]);
		const items = carryable(readShapes(doc), (shape) =>
			actionState(shape, shape.ref ? cards.get(shape.ref) : undefined),
		);
		return { doc, items };
	}

	it("takes the open ones, in reading order, with owners, due dates and links", () => {
		const { items } = source();
		expect(items).toEqual([
			{ id: "first", text: "Write docs", ref: KEY },
			{ id: "late", text: "Fix flaky CI", owner: PRIYA, due: "2026-10-01" },
		]);
	});

	it("puts them into the board's actions section, remembering where they came from", () => {
		const { items } = source();
		const target = new Y.Doc();
		addSection(target, { x: 0, y: 0, w: 600, h: 500 }, { id: "well", title: "Went well" });
		addSection(target, { x: 700, y: 0, w: 600, h: 500 }, { id: "act", title: "Actions" });
		expect(actionsSection(readShapes(target))).toBe("act");
		const result = placeCarried(target, items, { board: "b1", title: "Retro, Sept" }, { at: "T" });
		expect(result.added).toHaveLength(2);
		expect(result.section).toBe("act");
		const placed = result.added.map((id) => readShapes(target).get(id));
		expect(placed[0]).toMatchObject({
			type: "action",
			parent: "act",
			ref: KEY,
			carried: { board: "b1", title: "Retro, Sept", shape: "first", at: "T" },
		});
		expect(placed[1]).toMatchObject({ owner: PRIYA, due: "2026-10-01", parent: "act" });
		expect(cardRefs(target).has(KEY)).toBe(true);

		// Carrying over again doesn't double up.
		const again = placeCarried(target, items, { board: "b1", title: "Retro, Sept" });
		expect(again).toEqual({ added: [], skipped: 2, section: null });
	});

	it("makes a section for them on boards without one", () => {
		const { items } = source();
		const target = new Y.Doc();
		addShape(target, "note", { type: "sticky", x: 0, y: 0, z: "a0", text: "Hi" });
		const result = placeCarried(target, items, { board: "b1", title: "Retro, Sept" });
		const section = readShapes(target).get(result.section as string);
		expect(section).toMatchObject({ type: "section", title: "Carried over from Retro, Sept" });
		expect(section?.x).toBeGreaterThan(176);
		for (const id of result.added) expect(readShapes(target).get(id)?.parent).toBe(result.section);
	});
});
