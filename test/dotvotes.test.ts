import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import type { Card } from "../src/shared/cards.ts";
import {
	closeVote,
	dotsLeft,
	formatRemaining,
	isOpen,
	placeDot,
	readVotes,
	reactionVotes,
	removeDot,
	reopenVote,
	startVote,
	tallyVote,
	turnout,
	voteFor,
} from "../src/shared/dotvotes.ts";
import { addShape, readShape, shapesMap, type ShapeProps } from "../src/shared/shapes.ts";
import { card as cardFixture } from "./card-fixture.ts";

const PRIYA = { name: "Priya", color: "#b4467a", login: "priya" };
const KAI = { name: "Kai", color: "#1f7a6b", login: "kai" };
const GUEST = { name: "Curious Otter", color: "#3b4cca" };

function board() {
	const doc = new Y.Doc();
	addShape(doc, "ideas", { type: "section", x: 0, y: 0, w: 800, h: 600, z: "a0", title: "Ideas" });
	addShape(doc, "inner", {
		type: "section",
		x: 10,
		y: 10,
		w: 300,
		h: 300,
		z: "a1",
		parent: "ideas",
	});
	addShape(doc, "a", { type: "sticky", x: 20, y: 20, z: "a2", parent: "inner", text: "A" });
	addShape(doc, "b", { type: "sticky", x: 400, y: 20, z: "a3", parent: "ideas", text: "B" });
	addShape(doc, "c", {
		type: "card",
		x: 400,
		y: 300,
		z: "a4",
		parent: "ideas",
		ref: "github.com/acme/w#1",
	});
	addShape(doc, "out", { type: "sticky", x: 1000, y: 0, z: "a5", text: "Outside" });
	return doc;
}

function shapes(doc: Y.Doc): Map<string, ShapeProps> {
	return new Map([...shapesMap(doc)].map(([id, shape]) => [id, readShape(shape)]));
}

describe("dot votes", () => {
	it("limit dots per person, and merge people's ballots", () => {
		const a = board();
		const id = startVote(a, { scope: "ideas", dots: 2, by: PRIYA });
		const b = new Y.Doc();
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

		expect(placeDot(a, id, PRIYA, "a")).toBe(true);
		expect(placeDot(a, id, PRIYA, "a")).toBe(true);
		expect(placeDot(a, id, PRIYA, "b")).toBe(false);
		expect(placeDot(b, id, KAI, "b")).toBe(true);
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

		const [vote] = readVotes(b);
		expect(dotsLeft(vote!, PRIYA)).toBe(0);
		expect(dotsLeft(vote!, KAI)).toBe(1);
		expect(turnout(vote!)).toEqual({ voters: 2, dots: 3 });

		expect(removeDot(b, id, PRIYA, "a")).toBe(true);
		expect(removeDot(b, id, KAI, "a")).toBe(false);
		expect(dotsLeft(readVotes(b)[0]!, PRIYA)).toBe(1);
	});

	it("go to the innermost open vote around a shape", () => {
		const doc = board();
		const outer = startVote(doc, { scope: "ideas", by: PRIYA });
		const inner = startVote(doc, { scope: "inner", by: PRIYA });
		const all = startVote(doc, { scope: null, by: PRIYA });
		const now = Date.now();
		const votes = readVotes(doc);
		const s = shapes(doc);
		expect(voteFor(votes, s, "a", now)?.id).toBe(inner);
		expect(voteFor(votes, s, "b", now)?.id).toBe(outer);
		expect(voteFor(votes, s, "out", now)?.id).toBe(all);
		// Sections themselves aren't voted on.
		expect(voteFor(votes, s, "inner", now)).toBeNull();
		closeVote(doc, inner, PRIYA);
		expect(voteFor(readVotes(doc), s, "a", now)?.id).toBe(outer);
	});

	it("close when their window ends, and reopen", () => {
		const doc = board();
		const id = startVote(doc, { scope: null, by: PRIYA, endsAt: "2026-10-12T17:00:00Z" });
		const vote = () => readVotes(doc).find((v) => v.id === id)!;
		expect(isOpen(vote(), Date.parse("2026-10-12T16:59:59Z"))).toBe(true);
		expect(isOpen(vote(), Date.parse("2026-10-12T17:00:00Z"))).toBe(false);
		reopenVote(doc, id, "2026-10-14T17:00:00Z");
		expect(isOpen(vote(), Date.parse("2026-10-13T00:00:00Z"))).toBe(true);
		closeVote(doc, id, KAI, "2026-10-13T01:00:00Z");
		expect(vote()).toMatchObject({ closedAt: "2026-10-13T01:00:00Z", closedBy: { name: "Kai" } });
		expect(isOpen(vote(), Date.parse("2026-10-13T02:00:00Z"))).toBe(false);
		reopenVote(doc, id);
		expect(vote().endsAt).toBeUndefined();
		expect(isOpen(vote(), Date.parse("2030-01-01T00:00:00Z"))).toBe(true);
	});

	it("tally the winners, sharing ranks on ties", () => {
		const doc = board();
		const id = startVote(doc, { scope: "ideas", dots: 3, by: PRIYA });
		placeDot(doc, id, PRIYA, "a");
		placeDot(doc, id, PRIYA, "a");
		placeDot(doc, id, KAI, "b");
		placeDot(doc, id, KAI, "b");
		placeDot(doc, id, GUEST, "c");
		const rows = tallyVote(readVotes(doc)[0]!, doc);
		expect(rows.map((r) => [r.shape, r.total, r.rank])).toEqual([
			["a", 2, 1],
			["b", 2, 1],
			["c", 1, 3],
		]);
	});
});

describe("reactions as votes", () => {
	const card = (thumbsUp: Card["thumbsUp"]) => ({
		...cardFixture({ key: "github.com/acme/w#1" }),
		thumbsUp,
	});

	it("count each 👍, but not twice for someone who also voted here", () => {
		expect(
			reactionVotes({ count: 3, logins: ["priya", "jo", "tom"] }, [{ login: "Priya" }]),
		).toEqual({
			count: 2,
			logins: ["jo", "tom"],
		});
		// Reactors we can't name still count.
		expect(reactionVotes({ count: 5, logins: ["priya"] }, [{ login: "priya" }]).count).toBe(4);
		// A guest's dots can't be matched to anyone on GitHub.
		expect(reactionVotes({ count: 1, logins: ["jo"] }, [{}]).count).toBe(1);
		expect(reactionVotes(undefined, []).count).toBe(0);
	});

	it("join the tally when the vote counts them", () => {
		const doc = board();
		const id = startVote(doc, { scope: "ideas", by: PRIYA, reactions: true });
		placeDot(doc, id, PRIYA, "c");
		const lookup = () => card({ count: 3, logins: ["priya", "jo"] });
		const [row] = tallyVote(readVotes(doc)[0]!, doc, lookup);
		expect(row).toMatchObject({ shape: "c", dots: 1, reactions: 2, total: 3, reactors: ["jo"] });

		const off = startVote(doc, { scope: null, by: PRIYA });
		placeDot(doc, off, KAI, "c");
		const rows = tallyVote(
			readVotes(doc).find((v) => v.id === off)!,
			doc,
			lookup,
		);
		expect(rows[0]).toMatchObject({ dots: 1, reactions: 0, total: 1 });
	});
});

describe("formatRemaining", () => {
	it("rounds to the two biggest units", () => {
		expect(formatRemaining(2 * 86_400_000 + 4 * 3_600_000 + 5_000)).toBe("2d 4h");
		expect(formatRemaining(3 * 3_600_000 + 20 * 60_000)).toBe("3h 20m");
		expect(formatRemaining(12 * 60_000)).toBe("12m");
		// Under ten minutes it counts down by the second, like the timer.
		expect(formatRemaining(4 * 60_000 + 30_000)).toBe("4:30");
		expect(formatRemaining(44_100)).toBe("0:45");
		expect(formatRemaining(-1)).toBe("0s");
	});
});
