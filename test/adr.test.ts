import { describe, expect, it } from "vite-plus/test";
import {
	type AdrInput,
	adrMarkdown,
	adrPath,
	detectRecordDir,
	recordDir,
	discussionMarkdown,
	itemUrl,
	nextAdrNumber,
	recordNumber,
	slugify,
	stagedRecordPaths,
	writeBackOperation,
} from "../src/shared/adr.ts";
import type { PendingChange } from "../src/shared/changes.ts";

const DECISION: AdrInput = {
	title: "Drop Node 18 in 5.0",
	status: "decided",
	date: "2026-10-09",
	context: "Node 18 is end-of-life, and keeping it in CI costs us a runner per job.",
	decision: "We drop Node 18 in 5.0 and require Node 20.",
	consequences: "Users on Node 18 stay on 4.x.\nThe engines field changes.",
	links: [
		{
			key: "github.com/acme/imagekit#412",
			title: "Drop Node 18 support",
			url: "https://github.com/acme/imagekit/issues/412",
		},
		{ key: "github.com/acme/imagekit#418", url: "https://github.com/acme/imagekit/pull/418" },
	],
	boardUrl: "https://tack.example/b/abc/planning",
	votes: { agree: 4, disagree: 1 },
};

describe("the ADR template", () => {
	it("writes a numbered record with every section, its links and the board", () => {
		expect(adrMarkdown({ ...DECISION, number: 7 })).toBe(`# 7. Drop Node 18 in 5.0

Date: 2026-10-09

## Status

Accepted on 2026-10-09 (4 agree, 1 disagree)

## Context

Node 18 is end-of-life, and keeping it in CI costs us a runner per job.

## Decision

We drop Node 18 in 5.0 and require Node 20.

## Consequences

Users on Node 18 stay on 4.x.
The engines field changes.

## Links

- [acme/imagekit#412: Drop Node 18 support](https://github.com/acme/imagekit/issues/412)
- [acme/imagekit#418](https://github.com/acme/imagekit/pull/418)
- Decided on [the Tack board](https://tack.example/b/abc/planning)
`);
	});

	it("fills empty sections with a placeholder, and leaves out links when there are none", () => {
		const md = adrMarkdown({
			title: "  Use   tabs ",
			status: "proposed",
			date: "2026-10-09",
			context: "",
			decision: " ",
			consequences: "",
		});
		expect(md).toContain("# Use tabs\n");
		expect(md).toContain("## Status\n\nProposed\n");
		expect(md).toContain("## Context\n\n_No context recorded._");
		expect(md).toContain("## Decision\n\n_No decision recorded._");
		expect(md).toContain("## Consequences\n\n_None recorded yet._");
		expect(md).not.toContain("## Links");
		expect(md.endsWith("\n")).toBe(true);
	});

	it("names what superseded a record", () => {
		const md = adrMarkdown({
			...DECISION,
			status: "superseded",
			supersededBy: { title: "Drop Node 20 [too]", url: "https://example.com/adr/9" },
		});
		expect(md).toContain(
			"## Status\n\nSuperseded by [Drop Node 20 \\[too\\]](https://example.com/adr/9)",
		);
	});

	it("escapes brackets in linked titles", () => {
		const md = adrMarkdown({
			...DECISION,
			links: [{ key: "github.com/a/b#1", title: "[RFC] Thing", url: "https://x/1" }],
		});
		expect(md).toContain("- [a/b#1: \\[RFC\\] Thing](https://x/1)");
	});

	it("leaves the title out of a Discussion post's body", () => {
		const md = discussionMarkdown(DECISION);
		expect(md.startsWith("Date: 2026-10-09\n\n## Status")).toBe(true);
		expect(md).not.toMatch(/^# /m);
		expect(md).toContain("## Decision");
	});
});

describe("record numbers and paths", () => {
	it("slugs titles into lowercase ASCII words", () => {
		expect(slugify("Drop Node 18 in 5.0")).toBe("drop-node-18-in-5-0");
		expect(slugify("Ünïcödé — café’s déjà vu!")).toBe("unicode-cafes-deja-vu");
		expect(slugify("   ")).toBe("decision");
		expect(slugify("🚀")).toBe("decision");
	});

	it("cuts long slugs at a word boundary", () => {
		const slug = slugify("Adopt a single image pipeline for every framework adapter we ship", 30);
		expect(slug).toBe("adopt-a-single-image-pipeline");
		expect(slug.length).toBeLessThanOrEqual(30);
		expect(slugify("a".repeat(80), 20)).toBe("a".repeat(20));
	});

	it("reads numbers from file names and paths", () => {
		expect(recordNumber("0007-drop-node.md")).toBe(7);
		expect(recordNumber("docs/decisions/0012_use-tabs.md")).toBe(12);
		expect(recordNumber("README.md")).toBeNull();
		expect(recordNumber("template.md")).toBeNull();
	});

	it("numbers the next record after the highest in the directory", () => {
		expect(nextAdrNumber([])).toBe(1);
		expect(nextAdrNumber(["README.md", "template.md"])).toBe(1);
		expect(nextAdrNumber(["0001-record.md", "0003-b.md", "0002-a.md", "README.md"])).toBe(4);
		// Gaps aren't reused: the number only ever goes up.
		expect(nextAdrNumber(["0001-a.md", "0009-b.md"])).toBe(10);
	});

	it("skips numbers claimed by records staged on the board", () => {
		const existing = ["0001-a.md", "0002-b.md"];
		expect(nextAdrNumber(existing, ["docs/decisions/0003-c.md"])).toBe(4);
	});

	it("builds the path under docs/decisions", () => {
		expect(adrPath(7, "Drop Node 18 in 5.0")).toBe("docs/decisions/0007-drop-node-18-in-5-0.md");
		expect(adrPath(12345, "x")).toBe("docs/decisions/12345-x.md");
	});

	it("puts records where the repository keeps them", () => {
		expect(adrPath(4, "Use ESM", "docs/adr")).toBe("docs/adr/0004-use-esm.md");
		expect(recordDir(" /docs/adr/ ")).toBe("docs/adr");
		expect(recordDir("adr")).toBe("adr");
		expect(recordDir("docs//adr")).toBe("docs/adr");
		for (const bad of ["", "../x", "docs/../x", ".git/x", "a/./b", "a\\b"]) {
			expect(recordDir(bad)).toBeNull();
		}
		const listings = new Map([
			["docs/decisions", []],
			["docs/adr", ["README.md"]],
			["adr", ["0001-record-architecture-decisions.md", "template.md"]],
		]);
		expect(detectRecordDir(listings)).toBe("adr");
		expect(detectRecordDir(new Map())).toBe("docs/decisions");
		expect(
			writeBackOperation(DECISION, { kind: "pr", repo: "github.com/a/b", number: 2, dir: "adr" }),
		).toMatchObject({ files: [{ path: expect.stringMatching(/^adr\/0002-/) }] });
	});

	it("finds staged records per repository, ignoring failed ones", () => {
		const change = (
			repo: string,
			path: string,
			status: PendingChange["status"],
		): PendingChange => ({
			id: path,
			status,
			stagedAt: "2026-10-09T00:00:00Z",
			stagedBy: { name: "Priya" },
			op: {
				kind: "pr.create",
				repo,
				title: "",
				body: "",
				branch: "b",
				files: [{ path, content: "" }],
			},
		});
		const changes: PendingChange[] = [
			change("github.com/acme/a", "docs/decisions/0003-x.md", "staged"),
			change("github.com/acme/a", "docs/decisions/0004-y.md", "applied"),
			change("github.com/acme/a", "docs/decisions/0005-z.md", "failed"),
			change("github.com/acme/a", "src/other.md", "staged"),
			change("github.com/acme/b", "docs/decisions/0009-w.md", "staged"),
			{
				id: "issue",
				status: "staged",
				stagedAt: "2026-10-09T00:00:00Z",
				stagedBy: { name: "Kai" },
				op: { kind: "issue.create", repo: "github.com/acme/a", title: "t" },
			},
		];
		expect(stagedRecordPaths(changes, "github.com/acme/a")).toEqual([
			"docs/decisions/0003-x.md",
			"docs/decisions/0004-y.md",
		]);
		expect(stagedRecordPaths(changes, "github.com/acme/a", "src")).toEqual(["src/other.md"]);
	});
});

describe("write-back operations", () => {
	it("opens a pull request adding the record on its own branch", () => {
		const op = writeBackOperation(DECISION, {
			kind: "pr",
			repo: "github.com/acme/imagekit",
			number: 7,
		});
		expect(op).toMatchObject({
			kind: "pr.create",
			repo: "github.com/acme/imagekit",
			title: "ADR 0007: Drop Node 18 in 5.0",
			branch: "tack/adr-0007-drop-node-18-in-5-0",
		});
		if (op.kind !== "pr.create") throw new Error("not a PR");
		expect(op.files).toHaveLength(1);
		expect(op.files[0]?.path).toBe("docs/decisions/0007-drop-node-18-in-5-0.md");
		expect(op.files[0]?.content.startsWith("# 7. Drop Node 18 in 5.0\n")).toBe(true);
		expect(op.body).toContain("[the Tack board](https://tack.example/b/abc/planning)");
		expect(op.body).toContain("Linked: acme/imagekit#412, acme/imagekit#418");
	});

	it("posts a Discussion in the chosen category", () => {
		const op = writeBackOperation(DECISION, {
			kind: "discussion",
			repo: "github.com/acme/imagekit",
			category: "Decisions",
		});
		expect(op).toEqual({
			kind: "discussion.create",
			repo: "github.com/acme/imagekit",
			category: "Decisions",
			title: "Decision: Drop Node 18 in 5.0",
			body: discussionMarkdown(DECISION),
		});
	});

	it("links items on GitHub when their card's URL isn't known", () => {
		expect(itemUrl("github.com/acme/imagekit#412")).toBe(
			"https://github.com/acme/imagekit/issues/412",
		);
		expect(itemUrl("fake.tack/acme/imagekit#412")).toBeUndefined();
	});
});
