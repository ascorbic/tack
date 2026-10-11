import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { changesMap, unstageChanges } from "../src/shared/changes.ts";
import {
	addDecision,
	castVote,
	linkWrittenDecisions,
	linkedItems,
	otherDecisions,
	readVotes,
	setDecisionRecord,
	setDecisionStatus,
	stageWriteBack,
	statusOf,
	tally,
	voterKey,
	writeBackOf,
} from "../src/shared/decisions.ts";
import { repairBoard } from "../src/shared/repair.ts";
import { addShape, cardRefs, nextZ, readShape, shapesMap } from "../src/shared/shapes.ts";
import { addConnector, readShapes } from "../src/shared/structure.ts";

const PRIYA = { name: "Priya Shah", color: "#b4467a", login: "Priya" };
const KAI = { name: "Kai Andersen", color: "#1f7a6b", login: "kai" };
const GUEST = { name: "Guest", color: "#888888" };

function board() {
	const doc = new Y.Doc();
	addDecision(doc, "d", { x: 0, y: 0, title: "Drop Node 18", text: "It's EOL." });
	const get = () => readShape(shapesMap(doc).get("d") as Y.Map<unknown>);
	return { doc, get };
}

const sync = (a: Y.Doc, b: Y.Doc) => {
	Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
	Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
};

describe("the record", () => {
	it("keeps what's written for the record on the decision, and drops what says nothing", () => {
		const { doc, get } = board();
		setDecisionRecord(doc, "d", {
			text: "It's EOL, and CI is slow.",
			consequences: "Faster CI. Some users must upgrade.",
		});
		expect(get()).toMatchObject({
			text: "It's EOL, and CI is slow.",
			consequences: "Faster CI. Some users must upgrade.",
		});
		// An outcome that's just the title isn't kept; one that says more is.
		setDecisionRecord(doc, "d", { outcome: "Drop Node 18 " });
		expect(get().outcome).toBeUndefined();
		setDecisionRecord(doc, "d", { outcome: "Drop Node 18 in 5.0, with a codemod." });
		expect(get().outcome).toBe("Drop Node 18 in 5.0, with a codemod.");
		// Emptied consequences go; an emptied context is still the body.
		setDecisionRecord(doc, "d", { consequences: "  ", text: "" });
		expect(get().consequences).toBeUndefined();
		expect(get().text).toBe("");
		// Only decisions.
		addShape(doc, "s", { type: "sticky", x: 0, y: 0, z: nextZ(doc), text: "hi" });
		setDecisionRecord(doc, "s", { consequences: "no" });
		expect(readShape(shapesMap(doc).get("s") as Y.Map<unknown>).consequences).toBeUndefined();
	});
});

describe("votes", () => {
	it("keys voters by login, case-insensitively, or by name when signed out", () => {
		expect(voterKey(PRIYA)).toBe("@priya");
		expect(voterKey({ ...PRIYA, login: "PRIYA" })).toBe("@priya");
		expect(voterKey(GUEST)).toBe("~Guest");
	});

	it("counts one vote per person, and a changed mind replaces the old vote", () => {
		const { doc, get } = board();
		castVote(doc, "d", PRIYA, "agree");
		castVote(doc, "d", KAI, "disagree");
		castVote(doc, "d", KAI, "agree");
		castVote(doc, "d", GUEST, "disagree");
		const counts = tally(get().votes);
		expect(counts.total).toBe(3);
		expect(counts.agree.map((v) => v.name)).toEqual(["Priya Shah", "Kai Andersen"]);
		expect(counts.disagree.map((v) => v.name)).toEqual(["Guest"]);
		expect(get().votes?.["@kai"]).toMatchObject({ choice: "agree", login: "kai" });
	});

	it("withdraws a vote", () => {
		const { doc, get } = board();
		castVote(doc, "d", PRIYA, "agree");
		castVote(doc, "d", PRIYA, null);
		expect(tally(get().votes).total).toBe(0);
	});

	it("merges votes cast at the same time on different clients", () => {
		const alice = new Y.Doc();
		addDecision(alice, "d", { x: 0, y: 0, title: "t" });
		const bob = new Y.Doc();
		sync(alice, bob);
		castVote(alice, "d", PRIYA, "agree");
		castVote(bob, "d", KAI, "disagree");
		sync(alice, bob);
		for (const doc of [alice, bob]) {
			const counts = tally(readShape(shapesMap(doc).get("d") as Y.Map<unknown>).votes);
			expect([counts.agree.length, counts.disagree.length]).toEqual([1, 1]);
		}
	});

	it("only takes votes while a decision is proposed", () => {
		const { doc, get } = board();
		castVote(doc, "d", PRIYA, "agree");
		setDecisionStatus(doc, "d", "decided");
		castVote(doc, "d", KAI, "disagree");
		castVote(doc, "d", PRIYA, null);
		expect(tally(get().votes).agree).toHaveLength(1);
		expect(tally(get().votes).disagree).toHaveLength(0);
	});

	it("ignores malformed votes", () => {
		expect(
			readVotes({
				"@a": { choice: "agree", name: "A", at: "1" },
				"@b": { choice: "maybe", name: "B", at: "2" },
				"@c": "agree",
				"@d": null,
			}),
		).toEqual({ "@a": { choice: "agree", name: "A", at: "1" } });
		expect(readVotes(undefined)).toEqual({});
		expect(readVotes("nonsense")).toEqual({});
	});

	it("undoes a vote as the voter's own edit", () => {
		const { doc, get } = board();
		const undo = new Y.UndoManager(doc, { trackedOrigins: new Set(["local"]), captureTimeout: 0 });
		castVote(doc, "d", PRIYA, "agree");
		expect(tally(get().votes).total).toBe(1);
		undo.undo();
		expect(tally(get().votes).total).toBe(0);
	});
});

describe("status", () => {
	it("moves from proposed to decided, recording when and by whom, and back", () => {
		const { doc, get } = board();
		expect(statusOf(get())).toBe("proposed");
		setDecisionStatus(doc, "d", "decided", { by: { name: "Priya", color: "#b4467a" } });
		expect(get()).toMatchObject({ status: "decided", decidedBy: { name: "Priya" } });
		expect(get().decidedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
		setDecisionStatus(doc, "d", "proposed");
		expect(get().decidedAt).toBeUndefined();
		expect(get().decidedBy).toBeUndefined();
	});

	it("records what superseded a decision, and forgets it when reopened", () => {
		const { doc, get } = board();
		addDecision(doc, "next", { x: 400, y: 0, title: "Drop Node 20 too" });
		setDecisionStatus(doc, "d", "superseded", { supersededBy: "next" });
		expect(get()).toMatchObject({ status: "superseded", supersededBy: "next" });
		// A decision can't supersede itself.
		setDecisionStatus(doc, "d", "superseded", { supersededBy: "d" });
		expect(get().supersededBy).toBe("next");
		setDecisionStatus(doc, "d", "decided");
		expect(get().supersededBy).toBeUndefined();
	});

	it("reads unknown statuses as proposed", () => {
		expect(statusOf({ status: "maybe" as never })).toBe("proposed");
		expect(statusOf({})).toBe("proposed");
	});

	it("lists the other decisions on the board", () => {
		const { doc } = board();
		addDecision(doc, "next", { x: 400, y: 0, title: "Next" });
		addShape(doc, "s", { type: "sticky", text: "hi", x: 0, y: 0, z: nextZ(doc) });
		expect(otherDecisions(readShapes(doc), "d")).toEqual([
			{ id: "next", title: "Next", status: "proposed" },
		]);
	});
});

describe("linked items", () => {
	it("are the cards connected to the decision, either way round", () => {
		const { doc } = board();
		const card = (id: string, ref: string) =>
			addShape(doc, id, { type: "card", ref, x: 0, y: 0, z: nextZ(doc) });
		card("a", "github.com/acme/x#1");
		card("b", "github.com/acme/x#2");
		card("c", "github.com/acme/x#3");
		addShape(doc, "note", { type: "sticky", text: "hi", x: 0, y: 0, z: nextZ(doc) });
		addConnector(doc, { from: { x: 0, y: 0, shape: "d" }, to: { x: 0, y: 0, shape: "a" } });
		addConnector(doc, { from: { x: 0, y: 0, shape: "b" }, to: { x: 0, y: 0, shape: "d" } });
		// Twice to the same card, a sticky, a loose end, and a line elsewhere.
		addConnector(doc, { from: { x: 0, y: 0, shape: "d" }, to: { x: 0, y: 0, shape: "a" } });
		addConnector(doc, { from: { x: 0, y: 0, shape: "d" }, to: { x: 0, y: 0, shape: "note" } });
		addConnector(doc, { from: { x: 0, y: 0, shape: "d" }, to: { x: 5, y: 5 } });
		addConnector(doc, { from: { x: 0, y: 0, shape: "b" }, to: { x: 0, y: 0, shape: "c" } });
		expect(linkedItems(readShapes(doc), "d")).toEqual([
			"github.com/acme/x#1",
			"github.com/acme/x#2",
		]);
	});
});

describe("write-back", () => {
	const op = {
		kind: "pr.create" as const,
		repo: "github.com/acme/x",
		title: "ADR 0001: Drop Node 18",
		body: "",
		branch: "tack/adr-0001-drop-node-18",
		files: [{ path: "docs/decisions/0001-drop-node-18.md", content: "# 1. Drop Node 18\n" }],
	};

	it("stages the change and remembers it on the decision, as one undo step", () => {
		const { doc, get } = board();
		const undo = new Y.UndoManager(doc, { trackedOrigins: new Set(["local"]), captureTimeout: 0 });
		const id = stageWriteBack(doc, "d", op, { name: "Priya" });
		expect(id).toBeTruthy();
		expect(get().writeback).toBe(id);
		expect(writeBackOf(doc, get())).toMatchObject({ status: "staged", op, shapes: ["d"] });
		undo.undo();
		expect(get().writeback).toBeUndefined();
		expect(changesMap(doc).size).toBe(0);
	});

	it("is forgotten once unstaged, so it can be written back again", () => {
		const { doc, get } = board();
		const id = stageWriteBack(doc, "d", op, { name: "Priya" }) as string;
		unstageChanges(doc, [id]);
		expect(writeBackOf(doc, get())).toBeNull();
	});

	it("points the decision at its pull request once applied, so the board follows it", () => {
		const { doc, get } = board();
		const id = stageWriteBack(doc, "d", op, { name: "Priya" }) as string;
		expect(linkWrittenDecisions(doc)).toBe(0);
		const change = changesMap(doc).get(id) as Y.Map<unknown>;
		change.set("status", "sent");
		change.set("result", { key: "github.com/acme/x#88", url: "https://github.com/acme/x/pull/88" });
		expect(linkWrittenDecisions(doc)).toBe(0);
		change.set("status", "applied");
		expect(linkWrittenDecisions(doc)).toBe(1);
		expect(get().ref).toBe("github.com/acme/x#88");
		expect(cardRefs(doc).has("github.com/acme/x#88")).toBe(true);
		// Idempotent.
		expect(linkWrittenDecisions(doc)).toBe(0);
	});

	it("doesn't point decisions at Discussions, which aren't cards", () => {
		const { doc, get } = board();
		const id = stageWriteBack(
			doc,
			"d",
			{
				kind: "discussion.create",
				repo: "github.com/acme/x",
				category: "Ideas",
				title: "t",
				body: "b",
			},
			{ name: "Priya" },
		) as string;
		const change = changesMap(doc).get(id) as Y.Map<unknown>;
		change.set("status", "applied");
		change.set("result", {
			key: "github.com/acme/x#5",
			url: "https://github.com/acme/x/discussions/5",
		});
		expect(linkWrittenDecisions(doc)).toBe(0);
		expect(get().ref).toBeUndefined();
	});
});

describe("repair", () => {
	it("clears a supersededBy left pointing at a deleted decision", () => {
		const { doc, get } = board();
		addDecision(doc, "next", { x: 0, y: 0, title: "Next" });
		setDecisionStatus(doc, "d", "superseded", { supersededBy: "next" });
		shapesMap(doc).delete("next");
		expect(repairBoard(doc)).toMatchObject({ decisions: 1 });
		expect(get().supersededBy).toBeUndefined();
		expect(get().status).toBe("superseded");
		expect(repairBoard(doc).decisions).toBe(0);
	});

	it("rebuilds votes that aren't a Y.Map, keeping the valid ones", () => {
		const { doc, get } = board();
		shapesMap(doc)
			.get("d")
			?.set("votes", { "@kai": { choice: "agree", name: "Kai", at: "1" }, bad: 1 });
		expect(repairBoard(doc).decisions).toBe(1);
		expect(shapesMap(doc).get("d")?.get("votes")).toBeInstanceOf(Y.Map);
		expect(Object.keys(get().votes ?? {})).toEqual(["@kai"]);
	});
});
