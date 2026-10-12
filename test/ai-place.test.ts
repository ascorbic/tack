// AI's proposals on the client side (#64), pure: placing what was drafted
// (beside the selection, clear of everything, a decision linked to the
// selection's cards), proposed widgets' settings in words, and the
// playground's pretend model, whose widgets must check out like a real one's.

import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { checkWidget } from "../src/shared/ai.ts";
import { DECISION_LINKS, placeDecision, placeSummary, textSize } from "../src/shared/aiPlace.ts";
import { boxOf } from "../src/shared/sections.ts";
import { addShape, nextZ, readShape, shapesMap } from "../src/shared/shapes.ts";
import { addSection, readShapes } from "../src/shared/structure.ts";
import { describeConfig, leftOutInWords, widgetSuggestions } from "../src/client/ai/describe.ts";
import { draftDecision, proposeWidget, summarise } from "../src/shared/fakeBoardAi.ts";

function board(): { doc: Y.Doc; selected: string[] } {
	const doc = new Y.Doc();
	const selected: string[] = [];
	for (let i = 0; i < 3; i++) {
		const id = `s${i}`;
		addShape(doc, id, { type: "sticky", text: `Idea ${i}`, x: i * 220, y: 0, z: nextZ(doc) });
		selected.push(id);
	}
	for (let i = 0; i < 2; i++) {
		const id = `c${i}`;
		addShape(doc, id, {
			type: "card",
			ref: `github.com/acme/app#${i + 1}`,
			x: i * 300,
			y: 260,
			z: nextZ(doc),
		});
		selected.push(id);
	}
	// Something in the way, just right of the selection.
	addShape(doc, "blocker", { type: "sticky", text: "Here first", x: 720, y: 0, z: nextZ(doc) });
	return { doc, selected };
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
	a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("placing what the AI drafted", () => {
	it("puts a summary beside the selection as a text block, clear of other shapes", () => {
		const { doc, selected } = board();
		const placed = placeSummary(doc, "Ideas\n\nThree ideas.", selected, undefined, "summary");
		const shape = readShape(shapesMap(doc).get("summary")!);
		expect(shape).toMatchObject({ type: "text", text: "Ideas\n\nThree ideas.", size: "m" });
		expect(placed.box).toMatchObject({
			x: shape.x,
			y: shape.y,
			...textSize("Ideas\n\nThree ideas."),
		});
		for (const [id, other] of readShapes(doc)) {
			if (id !== "summary") expect(overlaps(placed.box, boxOf(id, other))).toBe(false);
		}
		expect(placed.box.x).toBeGreaterThan(600);
	});

	it("puts a decision beside them, proposed, connected to the cards it was drafted from", () => {
		const { doc, selected } = board();
		const author = { name: "Olive", color: "#123456" };
		const placed = placeDecision(
			doc,
			{ title: "Cache or rewrite?", text: "Search is slow." },
			selected,
			author,
			undefined,
			"decision",
		);
		expect(readShape(shapesMap(doc).get("decision")!)).toMatchObject({
			type: "decision",
			title: "Cache or rewrite?",
			text: "Search is slow.",
			status: "proposed",
			author,
		});
		expect(placed.connectors).toHaveLength(2);
		const ends = placed.connectors.map((id) => readShape(shapesMap(doc).get(id)!));
		expect(ends.map((c) => [c.from?.shape, c.to?.shape])).toEqual([
			["decision", "c0"],
			["decision", "c1"],
		]);
	});

	it("links the cards inside a selected section, at most a few", () => {
		const doc = new Y.Doc();
		for (let i = 0; i < DECISION_LINKS + 3; i++) {
			addShape(doc, `c${i}`, {
				type: "card",
				ref: `github.com/acme/app#${i + 1}`,
				x: 40 + (i % 4) * 300,
				y: 60 + Math.floor(i / 4) * 200,
				z: nextZ(doc),
			});
		}
		const section = addSection(doc, { x: 0, y: 0, w: 1260, h: 700 }, { title: "Search" });
		const placed = placeDecision(doc, { title: "Which?", text: "" }, [section]);
		expect(placed.connectors).toHaveLength(DECISION_LINKS);
	});
});

describe("proposals in words", () => {
	it("says what a widget's settings are, leaving out defaults", () => {
		expect(
			describeConfig("stale", {
				title: "Quiet",
				host: "github.com",
				q: "repo:acme/app is:open",
				days: 60,
				label: "stale",
			}),
		).toEqual([
			{ label: "Search", value: "repo:acme/app is:open", mono: true },
			{ label: "Quiet for", value: "60 days" },
		]);
		expect(leftOutInWords({ faceDown: 0, private: 0 })).toBeNull();
		expect(leftOutInWords({ faceDown: 2, private: 1 })).toBe(
			"Left out 2 face-down stickies and 1 private card",
		);
		expect(widgetSuggestions("acme/app")[0]).toBe("Open bugs in acme/app");
	});
});

describe("the playground's pretend AI", () => {
	const context = {
		today: "2026-10-11",
		host: "fake.tack",
		repos: ["ascorbic/cirrus"],
		sections: [],
		login: "you",
	};

	it("proposes a valid widget for each of its suggestions", () => {
		const kinds = widgetSuggestions("ascorbic/cirrus").map((prompt) => {
			const proposal = proposeWidget(prompt, context);
			const check = checkWidget(proposal, { host: "fake.tack" });
			expect(check.ok, prompt).toBe(true);
			return check.ok ? check.widget : null;
		});
		expect(kinds).toEqual(["list", "review", "timeline", "stale"]);
		for (const prompt of [
			"How is the 5.0 milestone going",
			"Release notes for ascorbic/cirrus",
			"What blocks what",
			"Docs issues assigned to me",
		]) {
			expect(checkWidget(proposeWidget(prompt, context), { host: "fake.tack" }).ok, prompt).toBe(
				true,
			);
		}
	});

	it("summarises and drafts from what it's given", () => {
		const items = [
			{ kind: "sticky" as const, text: "Search is slow", section: "Search", by: "Kai" },
			{ kind: "sticky" as const, text: "Cache search results?", section: "Search", by: "Jo" },
			{ kind: "card" as const, text: "acme/app#1 (open issue; bug) Search times out" },
		];
		expect(summarise(items).summary).toContain("search");
		const decision = draftDecision(items);
		expect(decision.title).toBe("Cache search results?");
		expect(decision.options.map((o) => o.name)).toEqual(["Search is slow", "Search times out"]);
	});
});
