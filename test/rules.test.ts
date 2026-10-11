import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { intersects } from "../src/shared/geometry.ts";
import { PLACED_CARD, spotBeside, spotInSection } from "../src/shared/placement.ts";
import {
	RULE_LOG_KEEP,
	type RepoActivity,
	addRule,
	describeRule,
	listRules,
	memoryOfRules,
	pauseRules,
	readRuleLog,
	readRulesPause,
	resumeRules,
	ruleProblem,
	rulesPauseMap,
	runRules,
	sameRule,
	setRuleEnabled,
	shortRef,
} from "../src/shared/rules.ts";
import { boxOf } from "../src/shared/sections.ts";
import { addShape, readShape, shapesMap } from "../src/shared/shapes.ts";
import { addSection, readShapes } from "../src/shared/structure.ts";
import { card } from "./card-fixture.ts";

const ME = { name: "Alice", login: "alice" };
const REPO = "github.com/acme/widgets";

function board() {
	const doc = new Y.Doc();
	addShape(doc, "issue", { type: "card", ref: `${REPO}#12`, x: 0, y: 0, z: "a0" });
	return doc;
}

function activity(overrides: Partial<RepoActivity> = {}): RepoActivity {
	return {
		delivery: crypto.randomUUID(),
		event: "pull_request",
		action: "opened",
		repo: REPO,
		cards: [],
		mentions: {},
		...overrides,
	};
}

const pull = card({ item: "#40", kind: "pull", title: "Stop the wobble" });
const pullActivity = (closes = true) =>
	activity({
		cards: [pull],
		mentions: { [pull.key]: [{ key: `${REPO}#12`, closes }] },
	});

function placed(doc: Y.Doc) {
	return [...shapesMap(doc)]
		.map(([id, shape]) => ({ id, ...readShape(shape) }))
		.filter((shape) => shape.provenance?.via === "rule");
}

describe("rules: a pull request beside what it links", () => {
	it("places the pull request beside the issue, in free space, with provenance", () => {
		const doc = board();
		const rule = addRule(doc, { kind: "pull-links" }, { kind: "beside-linked" }, ME);
		const entries = runRules(doc, pullActivity(), memoryOfRules());
		expect(entries).toMatchObject([{ rule, outcome: "placed", key: pull.key, near: `${REPO}#12` }]);
		const [shape] = placed(doc);
		expect(shape).toMatchObject({ ref: pull.key, provenance: { via: "rule", source: rule } });
		// To the right of the issue, not over it.
		expect(shape?.x).toBeGreaterThan(252);
		expect(shape?.y).toBe(0);
		expect(listRules(doc)[0]).toMatchObject({ fired: 1 });
		expect(readRuleLog(doc)).toHaveLength(1);
	});

	it("never moves what's there, finding room around it", () => {
		const doc = board();
		// Someone's sticky is where the card would go.
		addShape(doc, "sticky", { type: "sticky", text: "mine", x: 270, y: 0, z: "a1" });
		const before = readShape(shapesMap(doc).get("sticky")!);
		addRule(doc, { kind: "pull-links" }, { kind: "beside-linked" }, ME);
		runRules(doc, pullActivity(), memoryOfRules());
		expect(readShape(shapesMap(doc).get("sticky")!)).toEqual(before);
		const shapes = readShapes(doc);
		const [shape] = placed(doc);
		const box = { x: shape!.x, y: shape!.y, ...PLACED_CARD };
		for (const [id, other] of shapes) {
			if (id !== shape!.id) expect(intersects(box, boxOf(id, other))).toBe(false);
		}
	});

	it("with closesOnly, ignores a plain mention", () => {
		const doc = board();
		addRule(doc, { kind: "pull-links", closesOnly: true }, { kind: "beside-linked" }, ME);
		expect(runRules(doc, pullActivity(false), memoryOfRules())).toEqual([]);
		expect(runRules(doc, pullActivity(true), memoryOfRules())).toHaveLength(1);
	});

	it("places an item once, ever, and not when it's already on the board", () => {
		const doc = board();
		addRule(doc, { kind: "pull-links" }, { kind: "beside-linked" }, ME);
		const memory = memoryOfRules();
		runRules(doc, pullActivity(), memory);
		runRules(doc, pullActivity(), memory);
		expect(placed(doc)).toHaveLength(1);
		// Someone removes it: the rule doesn't put it back.
		const [shape] = placed(doc);
		shapesMap(doc).delete(shape!.id);
		expect(runRules(doc, pullActivity(), memory)).toEqual([]);
		// Already on the board (placed by hand): nothing to do.
		const other = board();
		addShape(other, "mine", { type: "card", ref: pull.key, x: 900, y: 900, z: "a2" });
		addRule(other, { kind: "pull-links" }, { kind: "beside-linked" }, ME);
		expect(runRules(other, pullActivity(), memoryOfRules())).toEqual([]);
	});

	it("ignores entries in the rules map that aren't rules", () => {
		const doc = board();
		doc.getMap("rules").set("junk", { name: "Not a Y.Map" });
		addRule(doc, { kind: "pull-links" }, { kind: "beside-linked" }, ME);
		expect(listRules(doc)).toHaveLength(1);
		expect(runRules(doc, pullActivity(), memoryOfRules())).toHaveLength(1);
	});

	it("does nothing while paused", () => {
		const doc = board();
		const rule = addRule(doc, { kind: "pull-links" }, { kind: "beside-linked" }, ME);
		setRuleEnabled(doc, rule, false);
		expect(runRules(doc, pullActivity(), memoryOfRules())).toEqual([]);
	});

	it("only places items from repositories already on the board", () => {
		const doc = board();
		addRule(doc, { kind: "pull-links" }, { kind: "beside-linked" }, ME);
		const secret = card({ repo: "acme/secret", item: "#1", kind: "pull" });
		const entries = runRules(
			doc,
			activity({
				repo: "github.com/acme/secret",
				cards: [secret],
				mentions: { [secret.key]: [{ key: `${REPO}#12`, closes: true }] },
			}),
			memoryOfRules(),
		);
		expect(entries).toEqual([]);
	});
});

describe("rules: matching items into a section", () => {
	function triage() {
		const doc = board();
		const section = addSection(doc, { x: 0, y: 300, w: 640, h: 440 }, { title: "Triage" });
		const rule = addRule(
			doc,
			{
				kind: "matches",
				query: { kind: "search", host: "github.com", q: "repo:acme/widgets is:issue label:bug" },
			},
			{ kind: "section", section },
			ME,
		);
		return { doc, section, rule };
	}
	const bug = (n: number) =>
		card({ item: `#${n}`, labels: [{ name: "bug", color: "f00" }], title: `Bug ${n}` });

	it("adds a matching item to the section, inside it", () => {
		const { doc, section, rule } = triage();
		const entries = runRules(
			doc,
			activity({ event: "issues", action: "labeled", cards: [bug(50)] }),
			memoryOfRules(),
		);
		expect(entries).toMatchObject([{ outcome: "placed", section, rule }]);
		const [shape] = placed(doc);
		expect(shape).toMatchObject({ parent: section, ref: bug(50).key });
	});

	it("leaves items that don't match", () => {
		const { doc } = triage();
		expect(
			runRules(doc, activity({ event: "issues", cards: [card({ item: "#51" })] }), memoryOfRules()),
		).toEqual([]);
	});

	it("fills the section, then goes below it when it's full", () => {
		const { doc, section } = triage();
		const memory = memoryOfRules();
		const outcomes = [];
		for (let n = 60; n < 72; n++) {
			outcomes.push(...runRules(doc, activity({ event: "issues", cards: [bug(n)] }), memory));
		}
		const inside = outcomes.filter((entry) => !entry.reason);
		const below = outcomes.filter((entry) => entry.reason === "full");
		expect(inside.length).toBeGreaterThanOrEqual(4);
		expect(below.length).toBeGreaterThan(0);
		// Nothing placed overlaps anything else.
		const shapes = readShapes(doc);
		const cards = placed(doc).map((shape) => ({ x: shape.x, y: shape.y, ...PLACED_CARD }));
		for (let i = 0; i < cards.length; i++) {
			for (let j = i + 1; j < cards.length; j++) {
				expect(intersects(cards[i]!, cards[j]!)).toBe(false);
			}
		}
		expect(shapes.get(section)?.w).toBe(640);
	});

	it("says once that its section was deleted", () => {
		const { doc, section } = triage();
		shapesMap(doc).delete(section);
		const memory = memoryOfRules();
		expect(runRules(doc, activity({ cards: [bug(80)] }), memory)).toMatchObject([
			{ outcome: "skipped", reason: "no_section" },
		]);
		expect(runRules(doc, activity({ cards: [bug(81)] }), memory)).toEqual([]);
	});

	it("keeps the log short", () => {
		const { doc } = triage();
		const memory = memoryOfRules();
		for (let n = 100; n < 100 + RULE_LOG_KEEP + 5; n++) {
			runRules(doc, activity({ cards: [bug(n)] }), memory);
		}
		expect(readRuleLog(doc)).toHaveLength(RULE_LOG_KEEP);
	});
});

describe("rules: checking and describing", () => {
	it("refuses queries it can't check, and missing sections", () => {
		const doc = board();
		const query = (q: string) => ({ kind: "search" as const, host: "github.com", q });
		expect(
			ruleProblem(
				doc,
				{ kind: "matches", query: query("repo:a/b milestone:v1") },
				{ kind: "section", section: "x" },
			),
		).toMatch(/milestone/);
		expect(
			ruleProblem(
				doc,
				{ kind: "matches", query: query("repo:a/b") },
				{ kind: "section", section: "x" },
			),
		).toMatch(/section/);
		expect(ruleProblem(doc, { kind: "pull-links" }, { kind: "beside-linked" })).toBeNull();
	});

	it("reads as a sentence", () => {
		expect(
			describeRule({ trigger: { kind: "pull-links" }, action: { kind: "beside-linked" } }),
		).toEqual({
			when: "When a pull request mentions a card on this board",
			does: "place it beside that card",
		});
		expect(
			describeRule(
				{
					trigger: {
						kind: "matches",
						query: { kind: "search", host: "github.com", q: "label:bug" },
					},
					action: { kind: "section", section: "s" },
				},
				() => "Triage",
			).does,
		).toBe("add it to “Triage”");
	});

	it("shortens keys the way people write them", () => {
		expect(shortRef(`${REPO}#12`, REPO)).toBe("#12");
		expect(shortRef("github.com/acme/gears#3", REPO)).toBe("acme/gears#3");
	});
});

describe("placement", () => {
	it("finds the first free spot in a section, reading order", () => {
		const doc = new Y.Doc();
		const section = addSection(doc, { x: 0, y: 0, w: 700, h: 400 }, {});
		addShape(doc, "a", { type: "card", ref: `${REPO}#1`, x: 24, y: 24, z: "a1", parent: section });
		const spot = spotInSection(readShapes(doc), section);
		expect(spot).not.toBeNull();
		expect(spot!.y).toBe(24);
		expect(spot!.x).toBeGreaterThan(24 + 252);
	});

	it("is null for a full section", () => {
		const doc = new Y.Doc();
		const section = addSection(doc, { x: 0, y: 0, w: 260, h: 160 }, {});
		expect(spotInSection(readShapes(doc), section)).toBeNull();
	});

	it("never straddles a section's edge", () => {
		const doc = new Y.Doc();
		addShape(doc, "issue", { type: "card", ref: `${REPO}#1`, x: 0, y: 0, z: "a1" });
		const section = addSection(doc, { x: 300, y: -100, w: 400, h: 400 }, {});
		const shapes = readShapes(doc);
		const spot = spotBeside(shapes, "issue")!;
		const box = { ...spot, ...PLACED_CARD };
		const sectionBox = boxOf(section, shapes.get(section)!);
		const inside =
			box.x >= sectionBox.x &&
			box.y >= sectionBox.y &&
			box.x + box.w <= sectionBox.x + sectionBox.w &&
			box.y + box.h <= sectionBox.y + sectionBox.h;
		expect(inside || !intersects(box, sectionBox)).toBe(true);
	});
});

describe("rules: the same rule twice", () => {
	const ME = { name: "Alice" };
	const query = (q: string) => ({ kind: "search" as const, host: "github.com", q });

	it("finds a rule doing the same thing, whatever order the search is written in", () => {
		const doc = new Y.Doc();
		const bugs = addSection(doc, { x: 0, y: 0, w: 600, h: 400 }, { title: "Bugs" });
		const other = addSection(doc, { x: 700, y: 0, w: 600, h: 400 }, { title: "Other" });
		const id = addRule(
			doc,
			{ kind: "matches", query: query("repo:a/b is:open label:bug") },
			{ kind: "section", section: bugs },
			ME,
		);
		const into = (section: string) => ({ kind: "section" as const, section });
		expect(
			sameRule(doc, { kind: "matches", query: query("label:bug  repo:a/b is:open") }, into(bugs))
				?.id,
		).toBe(id);
		// Into another section, or another search, it's a different rule.
		expect(
			sameRule(doc, { kind: "matches", query: query("repo:a/b is:open label:bug") }, into(other)),
		).toBeNull();
		expect(
			sameRule(doc, { kind: "matches", query: query("repo:a/b label:bug") }, into(bugs)),
		).toBeNull();
	});

	it("tells closing pull requests apart from mentioning ones", () => {
		const doc = new Y.Doc();
		addRule(doc, { kind: "pull-links" }, { kind: "beside-linked" }, ME);
		expect(sameRule(doc, { kind: "pull-links" }, { kind: "beside-linked" })).not.toBeNull();
		expect(
			sameRule(doc, { kind: "pull-links", closesOnly: true }, { kind: "beside-linked" }),
		).toBeNull();
	});
});

describe("rules: pausing for a session", () => {
	it("records who paused, and resuming clears it", () => {
		const doc = new Y.Doc();
		expect(readRulesPause(doc)).toBeNull();
		pauseRules(doc, { name: "Alice" });
		expect(readRulesPause(doc)).toMatchObject({ by: { name: "Alice" }, held: 0 });
		rulesPauseMap(doc).set("held", 3);
		expect(readRulesPause(doc)?.held).toBe(3);
		resumeRules(doc);
		expect(readRulesPause(doc)).toBeNull();
	});
});
