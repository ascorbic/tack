import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { cardKey, normaliseIssue, parseRef } from "../src/shared/cards.ts";
import { addShape, cardRefs } from "../src/shared/shapes.ts";

describe("parseRef", () => {
	it("parses short refs and issue/PR URLs", () => {
		expect(parseRef("withastro/astro#123")).toEqual({
			owner: "withastro",
			repo: "astro",
			number: 123,
		});
		expect(parseRef("https://github.com/ascorbic/unpic/pull/42/files")).toEqual({
			owner: "ascorbic",
			repo: "unpic",
			number: 42,
		});
		expect(parseRef("https://example.com/a/b/issues/1")).toBeNull();
		expect(parseRef("not a ref")).toBeNull();
	});

	it("lowercases keys", () => {
		expect(cardKey({ owner: "Ascorbic", repo: "Unpic", number: 1 })).toBe("ascorbic/unpic#1");
	});
});

describe("normaliseIssue", () => {
	const base = {
		number: 1,
		title: "t",
		html_url: "https://github.com/a/b/pull/1",
		updated_at: "2026-01-01T00:00:00Z",
	};

	it("distinguishes draft, merged and closed pull requests", () => {
		expect(normaliseIssue("a/b", { ...base, state: "open", draft: true }, true).state).toBe(
			"draft",
		);
		expect(normaliseIssue("a/b", { ...base, state: "closed", merged_at: "x" }, true).state).toBe(
			"merged",
		);
		expect(normaliseIssue("a/b", { ...base, state: "closed" }, true).state).toBe("closed");
	});

	it("treats issues-endpoint PRs as pulls", () => {
		const card = normaliseIssue("a/b", {
			...base,
			state: "open",
			pull_request: { merged_at: null },
		});
		expect(card.kind).toBe("pull");
	});
});

describe("cardRefs", () => {
	it("collects card keys and ignores stickies", () => {
		const doc = new Y.Doc();
		addShape(doc, "1", { type: "card", ref: "a/b#1", x: 0, y: 0, z: "a0" });
		addShape(doc, "2", { type: "card", ref: "a/b#1", x: 0, y: 0, z: "a1" });
		addShape(doc, "3", { type: "sticky", text: "hi", x: 0, y: 0, z: "a2" });
		expect([...cardRefs(doc)]).toEqual(["a/b#1"]);
	});
});
