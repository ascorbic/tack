import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { normaliseIssue } from "../src/server/forges/github.ts";
import { itemKey, parseKey, parseRef, repoKeyOf } from "../src/shared/refs.ts";
import { addShape, cardRefs, nextZ, topZ } from "../src/shared/shapes.ts";

describe("parseRef", () => {
	it("parses bare refs against the default host", () => {
		expect(parseRef("ascorbic/cirrus#123")).toEqual({
			forge: "github",
			host: "github.com",
			repo: "ascorbic/cirrus",
			item: "#123",
		});
	});

	it("parses GitHub issue and PR URLs", () => {
		expect(parseRef("https://github.com/ascorbic/unpic/pull/42/files")).toEqual({
			forge: "github",
			host: "github.com",
			repo: "ascorbic/unpic",
			item: "#42",
		});
	});

	it("parses canonical keys, including other forges", () => {
		expect(parseRef("fake.tack/stress/cards#7")).toEqual({
			forge: "fake",
			host: "fake.tack",
			repo: "stress/cards",
			item: "#7",
		});
	});

	it("takes URLs as people copy them: www, http, anchors, and the test forge's", () => {
		const unpic = { forge: "github", host: "github.com", repo: "ascorbic/unpic", item: "#42" };
		expect(parseRef("https://www.github.com/ascorbic/unpic/issues/42")).toEqual(unpic);
		expect(parseRef("http://github.com/ascorbic/unpic/pull/42")).toEqual(unpic);
		expect(parseRef("github.com/ascorbic/unpic/issues/42#issuecomment-1")).toEqual(unpic);
		const fake = { forge: "fake", host: "fake.tack", repo: "stress/cards", item: "#3" };
		expect(parseRef("https://fake.tack/stress/cards/issues/3")).toEqual(fake);
		// The test forge's own cards link like this.
		expect(parseRef("https://fake.tack/stress/cards/3")).toEqual(fake);
		// On GitHub a bare number is some other page.
		expect(parseRef("https://github.com/ascorbic/unpic/3")).toBeNull();
	});

	it("parses discussions, which share their repository's numbers with issues and pull requests", () => {
		const rfc = { forge: "github", host: "github.com", repo: "ascorbic/unpic", item: "#3" };
		expect(parseRef("https://github.com/ascorbic/unpic/discussions/3")).toEqual(rfc);
		expect(parseRef("github.com/ascorbic/unpic/discussions/3#discussioncomment-12")).toEqual(rfc);
		expect(parseRef("https://github.com/ascorbic/unpic/discussions/3?sort=top")).toEqual(rfc);
		// The test forge's discussions link the same way.
		expect(parseRef("https://fake.tack/acme/unpic/discussions/90001")).toEqual({
			forge: "fake",
			host: "fake.tack",
			repo: "acme/unpic",
			item: "#90001",
		});
		// A repository's discussions, or a category, aren't one discussion.
		expect(parseRef("https://github.com/ascorbic/unpic/discussions")).toBeNull();
		expect(parseRef("https://github.com/ascorbic/unpic/discussions/categories/ideas")).toBeNull();
		// Other forges have no discussions: their links stay links.
		expect(parseRef("https://gitlab.com/ascorbic/cirrus/-/discussions/3")).toBeNull();
		expect(parseRef("https://codeberg.org/ascorbic/emdash/discussions/3")).toBeNull();
		expect(parseRef("https://tangled.org/mk.gg/tack/discussions/3")).toBeNull();
	});

	it("rejects unknown hosts and junk", () => {
		expect(parseRef("https://example.com/a/b/issues/1")).toBeNull();
		expect(parseKey("gitlab.example.com/group/sub/project!12")).toBeNull();
		expect(parseRef("not a ref")).toBeNull();
	});
});

describe("item keys", () => {
	it("are lowercased and include the host", () => {
		expect(itemKey({ host: "github.com", repo: "Ascorbic/Unpic", item: "#1" })).toBe(
			"github.com/ascorbic/unpic#1",
		);
	});

	it("split into repository keys, with nested paths and forge-native refs", () => {
		expect(repoKeyOf("github.com/ascorbic/unpic#100")).toBe("github.com/ascorbic/unpic");
		expect(repoKeyOf("gitlab.com/group/sub/project!12")).toBe("gitlab.com/group/sub/project");
	});
});

describe("GitHub normalisation", () => {
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

	it("keeps when items were opened, closed and merged, where GitHub says", () => {
		expect(
			normaliseIssue(
				"a/b",
				{
					...base,
					state: "closed",
					created_at: "2025-12-01T00:00:00Z",
					closed_at: "2025-12-20T00:00:00Z",
					pull_request: { merged_at: "2025-12-20T00:00:00Z" },
				},
				true,
			),
		).toMatchObject({
			createdAt: "2025-12-01T00:00:00Z",
			closedAt: "2025-12-20T00:00:00Z",
			mergedAt: "2025-12-20T00:00:00Z",
		});
		const issue = normaliseIssue("a/b", { ...base, state: "open", closed_at: null });
		expect(issue.closedAt).toBeNull();
		expect("createdAt" in issue || "mergedAt" in issue).toBe(false);
	});

	it("produces canonical keys and treats issues-endpoint PRs as pulls", () => {
		const card = normaliseIssue("A/B", {
			...base,
			state: "open",
			pull_request: { merged_at: null },
		});
		expect(card).toMatchObject({
			key: "github.com/a/b#1",
			forge: "github",
			item: "#1",
			kind: "pull",
		});
	});
});

describe("cardRefs", () => {
	it("collects card keys and ignores stickies", () => {
		const doc = new Y.Doc();
		addShape(doc, "1", { type: "card", ref: "github.com/a/b#1", x: 0, y: 0, z: "a0" });
		addShape(doc, "2", { type: "card", ref: "github.com/a/b#1", x: 0, y: 0, z: "a1" });
		addShape(doc, "3", { type: "sticky", text: "hi", x: 0, y: 0, z: "a2" });
		expect([...cardRefs(doc)]).toEqual(["github.com/a/b#1"]);
	});
});

describe("stacking order", () => {
	it("puts new shapes above everything else", () => {
		const doc = new Y.Doc();
		addShape(doc, "1", { type: "sticky", x: 0, y: 0, z: "a0" });
		addShape(doc, "2", { type: "sticky", x: 0, y: 0, z: "a5" });
		expect(nextZ(doc) > "a5").toBe(true);
		expect(topZ(doc, "2")).toBeNull();
		expect(topZ(doc, "1")! > "a5").toBe(true);
	});

	it("ignores invalid keys instead of throwing", () => {
		const doc = new Y.Doc();
		addShape(doc, "1", { type: "sticky", x: 0, y: 0, z: "a1" });
		addShape(doc, "2", { type: "sticky", x: 0, y: 0, z: "b3" });
		expect(() => nextZ(doc)).not.toThrow();
		expect(nextZ(doc) > "a1").toBe(true);
	});
});
