// Comments (#51) and "since you were here" (#46): the pure parts, shared by
// the board's server and its clients.

import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
	type CommentAuthor,
	type CommentThread,
	anchorAt,
	bodyParts,
	completeMention,
	filterThreads,
	isAnchor,
	isUnread,
	mentionAt,
	mentionedLogins,
	pinPosition,
	validMentions,
} from "../src/shared/comments.ts";
import { addShape, shapesMap } from "../src/shared/shapes.ts";
import {
	type Digest,
	cardActivity,
	commentDigest,
	describeEdits,
	editsByPerson,
	highlightsFor,
	shapeChanges,
} from "../src/shared/since.ts";

const ANA: CommentAuthor = { id: 1, login: "ana", name: "Ana", avatarUrl: "" };
const BO: CommentAuthor = { id: 2, login: "bo", name: null, avatarUrl: "" };

function thread(
	id: string,
	messages: [CommentAuthor, string, number][],
	resolved = false,
): CommentThread {
	const list = messages.map(([author, body, at], i) => ({
		id: `${id}-${i}`,
		author,
		body,
		at,
		mentions: mentionedLogins(body),
	}));
	return {
		id,
		anchor: { x: 0, y: 0 },
		createdAt: list[0]?.at ?? 0,
		updatedAt: list.at(-1)?.at ?? 0,
		resolved: resolved ? { by: ANA, at: 99 } : null,
		messages: list,
	};
}

describe("mentions", () => {
	it("finds logins after an @, but not in email addresses or paths", () => {
		expect(mentionedLogins("@ana and @Bo-Jo, cc @ana. mail me@ana.example or see a/@b")).toEqual([
			"ana",
			"bo-jo",
		]);
		expect(mentionedLogins("(@ana)")).toEqual(["ana"]);
		expect(validMentions("@ana @carl", ["ANA", "bo"])).toEqual(["ana"]);
	});

	it("splits a body around the mentions the server checked", () => {
		expect(bodyParts("Hi @ana, and @carl!", ["ana"])).toEqual([
			{ text: "Hi " },
			{ mention: "ana", text: "@ana" },
			{ text: ", and @carl!" },
		]);
		expect(bodyParts("plain")).toEqual([{ text: "plain" }]);
	});

	it("knows the mention being typed, and completes it", () => {
		expect(mentionAt("hello @an", 9)).toEqual({ query: "an", start: 6 });
		expect(mentionAt("hello @", 7)).toEqual({ query: "", start: 6 });
		expect(mentionAt("me@an", 5)).toBeNull();
		expect(mentionAt("hello @an there", 15)).toBeNull();
		expect(completeMention("hello @an", 9, "ana")).toEqual({ text: "hello @ana ", caret: 11 });
		// Completing in the middle replaces the rest of the partial login.
		expect(completeMention("hi @a there", 5, "ana")).toEqual({ text: "hi @ana there", caret: 8 });
	});
});

describe("threads", () => {
	it("is unread when someone else wrote since you last read it", () => {
		const t = thread("t1", [
			[ANA, "first", 10],
			[BO, "reply", 20],
		]);
		expect(isUnread(t, { id: 1, reads: {}, since: 5 })).toBe(true);
		expect(isUnread(t, { id: 1, reads: { t1: 25 }, since: 5 })).toBe(false);
		// Older than your first visit: read.
		expect(isUnread(t, { id: 1, reads: {}, since: 30 })).toBe(false);
		// Your own messages never make it unread.
		expect(isUnread(t, { id: 2, reads: { t1: 15 }, since: 0 })).toBe(false);
		expect(isUnread(t, { id: null, reads: {}, since: null })).toBe(false);
	});

	it("filters open, resolved and mentioning threads, newest first", () => {
		const threads = [
			thread("a", [[ANA, "hello", 1]]),
			thread("b", [[ANA, "hi @bo", 3]]),
			thread("c", [[BO, "done", 2]], true),
		];
		expect(filterThreads(threads, "open").map((t) => t.id)).toEqual(["b", "a"]);
		expect(filterThreads(threads, "resolved").map((t) => t.id)).toEqual(["c"]);
		expect(filterThreads(threads, "mentions", "Bo").map((t) => t.id)).toEqual(["b"]);
	});
});

describe("pins", () => {
	it("follow their shape, staying inside it if it shrinks", () => {
		const box = { x: 100, y: 100, w: 200, h: 100 };
		const anchor = anchorAt({ x: 150.4, y: 120 }, { id: "s", box });
		expect(anchor).toEqual({ x: 150, y: 120, shape: "s", dx: 50, dy: 20 });
		expect(pinPosition(anchor, { ...box, x: 400 })).toEqual({ x: 450, y: 120 });
		expect(pinPosition(anchor, { ...box, w: 30 })).toEqual({ x: 130, y: 120 });
		// Without its shape, where it was last.
		expect(pinPosition(anchor, undefined)).toEqual({ x: 150, y: 120 });
		expect(pinPosition({ x: 5, y: 6 }, box)).toEqual({ x: 5, y: 6 });
	});

	it("checks anchors from clients", () => {
		expect(isAnchor({ x: 1, y: 2 })).toBe(true);
		expect(isAnchor({ x: 1, y: 2, shape: "s", dx: 1, dy: 1 })).toBe(true);
		expect(isAnchor({ x: Number.NaN, y: 2 })).toBe(false);
		expect(isAnchor({ x: 1, y: 2, shape: "" })).toBe(false);
		expect(isAnchor({ x: 1e9, y: 2 })).toBe(false);
		expect(isAnchor(null)).toBe(false);
	});
});

describe("since you were here", () => {
	it("tells what a transaction did to shapes", () => {
		const doc = new Y.Doc();
		const shapes = shapesMap(doc);
		const seen: { changes: unknown[]; moved: string[] }[] = [];
		shapes.observeDeep((events) => seen.push(shapeChanges(events, shapes)));
		addShape(doc, "a", { type: "sticky", x: 0, y: 0, z: "a0", text: "" });
		doc.transact(() => {
			shapes.get("a")?.set("x", 10);
			shapes.get("a")?.set("parent", null);
		});
		shapes.get("a")?.set("z", "a1");
		shapes.get("a")?.set("text", "hello");
		shapes.delete("a");
		expect(seen.map((s) => s.changes).filter((c) => c.length > 0)).toEqual([
			[{ shape: "a", kind: "added" }],
			[{ shape: "a", kind: "moved" }],
			[{ shape: "a", kind: "changed" }],
			[{ shape: "a", kind: "removed" }],
		]);
		expect(seen[1]?.moved).toEqual(["a"]);
	});

	it("says what happened to a card between snapshots", () => {
		const before = { state: "open", comments: 2, ci: "pending", review: "review_required" };
		const later = [
			{ at: 10, snapshot: { ...before, comments: 3 } },
			{ at: 20, snapshot: { ...before, comments: 5, ci: "failing" } },
			{ at: 30, snapshot: { state: "merged", comments: 5, ci: "passing", review: "approved" } },
		];
		expect(cardActivity("k", before, later)).toEqual([
			{ key: "k", kind: "merged", at: 30 },
			{ key: "k", kind: "comments", at: 20, count: 3 },
			{ key: "k", kind: "ci_passing", at: 30 },
			{ key: "k", kind: "approved", at: 30 },
		]);
		expect(
			cardActivity("k", { ...before, state: "closed" }, [{ at: 5, snapshot: before }]),
		).toEqual([{ key: "k", kind: "reopened", at: 5 }]);
		expect(cardActivity("k", before, [])).toEqual([]);
	});

	it("highlights each shape once, the most telling way", () => {
		const by = { kind: "person" as const, id: 1, name: "Ana" };
		const digest: Digest = {
			since: 1,
			at: 100,
			more: 0,
			edits: [
				{ shape: "s1", kind: "moved", type: "sticky", at: 5, by },
				{ shape: "s1", kind: "changed", type: "sticky", at: 6, by },
				{ shape: "gone", kind: "removed", type: "sticky", at: 7, by },
				{ shape: "c1", kind: "moved", type: "card", at: 8, by },
			],
			cards: [{ key: "k", kind: "closed", at: 9 }],
			pushes: [],
		};
		const highlights = highlightsFor(
			digest,
			(id) => id !== "gone",
			(key) => (key === "k" ? ["c1"] : []),
		);
		expect(highlights).toEqual([
			{ shape: "c1", kind: "closed", at: 9 },
			{ shape: "s1", kind: "changed", at: 6, by: "Ana" },
		]);
	});

	it("describes people's edits in words", () => {
		const by = { kind: "person" as const, id: 1, name: "Ana" };
		const rule = { kind: "rule" as const };
		const edits = [
			{ shape: "a", kind: "added" as const, type: "sticky", at: 1, by },
			{ shape: "b", kind: "added" as const, type: "sticky", at: 2, by },
			{ shape: "c", kind: "added" as const, type: "section", at: 3, by },
			{ shape: "d", kind: "moved" as const, type: "card", at: 4, by },
			{ shape: "e", kind: "added" as const, type: "card", at: 5, by: rule },
		];
		const groups = editsByPerson(edits);
		expect(groups.map((g) => g.by.kind)).toEqual(["person", "rule"]);
		expect(describeEdits(groups[0]?.edits ?? [])).toBe(
			"added 2 stickies and 1 section, moved 1 card",
		);
	});

	it("collects new comments since a visit", () => {
		const threads = [
			thread("old", [[BO, "old", 1]]),
			thread("new", [[BO, "hey @ana", 20]]),
			thread("replied", [
				[ANA, "mine", 1],
				[BO, "reply", 30],
			]),
			thread("mine", [[ANA, "my own", 40]]),
		];
		const digest = commentDigest(threads, 10, { id: 1, login: "ana" });
		expect(digest.started.map((t) => t.id)).toEqual(["new"]);
		expect(digest.replied.map((t) => t.id)).toEqual(["replied"]);
		expect(digest.mentioned.map((t) => t.id)).toEqual(["new"]);
		expect(commentDigest(threads, null, { id: 1 }).started).toEqual([]);
	});
});
