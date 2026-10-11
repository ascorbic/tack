import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import type { Card } from "../src/shared/cards.ts";
import { listChanges } from "../src/shared/changes.ts";
import { addShape } from "../src/shared/shapes.ts";
import { planDrop, previewOf, stageDrop } from "../src/client/widgets/match.ts";

const card = (item: string, overrides: Partial<Card> = {}): Card => ({
	key: `fake.tack/acme/unpic${item}`,
	forge: "fake",
	host: "fake.tack",
	repo: "acme/unpic",
	item,
	kind: "issue",
	title: `Item ${item}`,
	state: "open",
	stateReason: null,
	labels: [],
	assignees: [],
	author: null,
	comments: 0,
	reactions: 0,
	url: "",
	updatedAt: "2026-10-01T00:00:00Z",
	...overrides,
});

function board(cards: Card[]) {
	const doc = new Y.Doc();
	const data = new Map(cards.map((c) => [c.key, c]));
	cards.forEach((c, i) =>
		addShape(doc, `s${i}`, { type: "card", ref: c.key, x: 0, y: 0, z: "a0" }),
	);
	return { doc, cardOf: (key: string) => data.get(key) };
}

const LIST = { q: "repo:acme/unpic is:open label:bug", host: "fake.tack" };

describe("drop to match", () => {
	it("plans and stages every dropped card's changes as one undo step", () => {
		const { doc, cardOf } = board([
			card("#1", { labels: [{ name: "docs", color: "000" }] }),
			card("#2", { state: "closed", stateReason: "completed" }),
		]);
		const plans = planDrop(doc, ["s0", "s1"], LIST, null, cardOf);
		expect(previewOf(plans)).toEqual({
			status: "changes",
			cards: 2,
			steps: [
				{ kind: "add-label", label: "bug" },
				{ kind: "open", label: "Reopen" },
			],
		});
		const undo = new Y.UndoManager(doc.getMap("changes"), { trackedOrigins: new Set(["local"]) });
		stageDrop(doc, plans, { name: "Kai", login: "kai" });
		expect(listChanges(doc).map((change) => [change.op, change.shapes])).toEqual([
			[{ kind: "item.labels", target: { key: "fake.tack/acme/unpic#1" }, add: ["bug"] }, ["s0"]],
			[{ kind: "item.labels", target: { key: "fake.tack/acme/unpic#2" }, add: ["bug"] }, ["s1"]],
			[{ kind: "item.state", target: { key: "fake.tack/acme/unpic#2" }, state: "open" }, ["s1"]],
		]);
		undo.undo();
		expect(listChanges(doc)).toEqual([]);
	});

	it("says when cards already match, or can't", () => {
		const { doc, cardOf } = board([
			card("#1", { labels: [{ name: "bug", color: "000" }] }),
			card("#2", { writable: false }),
		]);
		expect(previewOf(planDrop(doc, ["s0"], LIST, null, cardOf))).toEqual({
			status: "matches",
			cards: 1,
		});
		const unwritable = previewOf(planDrop(doc, ["s1"], LIST, null, cardOf));
		expect(unwritable?.status === "impossible" && unwritable.reason).toContain("isn't installed");
		const words = previewOf(planDrop(doc, ["s0"], { ...LIST, q: "flaky" }, null, cardOf));
		expect(words?.status === "impossible" && words.reason).toContain("“flaky”");
	});

	it("can't plan for cards that haven't loaded, or aren't cards", () => {
		const { doc } = board([card("#1")]);
		addShape(doc, "sticky", { type: "sticky", x: 0, y: 0, z: "a1", text: "hi" });
		const plans = planDrop(doc, ["s0", "sticky"], LIST, null, () => undefined);
		expect(plans).toHaveLength(1);
		expect(plans[0]?.plan.status).toBe("impossible");
	});
});
