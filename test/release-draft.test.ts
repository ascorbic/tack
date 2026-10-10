import { describe, expect, it } from "vite-plus/test";
import type { Card } from "../src/shared/cards.ts";
import {
	DEFAULT_SECTIONS,
	draftRelease,
	nextVersion,
	releaseMarkdown,
	releaseTitle,
	releaseWidget,
} from "../src/shared/releaseDraft.ts";
import { readConfig, widgetQueries } from "../src/shared/widgetRegistry.ts";
import type { ReleaseResult } from "../src/shared/widgets.ts";
import { card } from "./card-fixture.ts";

const label = (name: string) => ({ name, color: "cccccc" });
const pull = (n: number, title: string, labels: string[], author = "alice", day = n): Card =>
	card({
		item: `#${n}`,
		kind: "pull",
		state: "merged",
		title,
		labels: labels.map(label),
		author: { login: author, avatarUrl: `https://a/${author}` },
		mergedAt: `2026-09-${String(day).padStart(2, "0")}T12:00:00Z`,
	});

const result = (mergedSince: Card[], tag = "v1.4.0"): ReleaseResult => ({
	kind: "release",
	repo: "github.com/acme/widgets",
	latest: { tag, name: tag, publishedAt: "2026-09-01T00:00:00Z", url: "" },
	mergedSince,
});

const config = readConfig(releaseWidget, { repo: "acme/widgets" });

describe("release drafts", () => {
	it("ask for the repository's release, once it's set", () => {
		expect(widgetQueries({ widget: "release", config: { repo: "Acme/Widgets" } })).toEqual({
			release: { kind: "release", repo: "github.com/acme/widgets" },
		});
		expect(widgetQueries({ widget: "release", config: { repo: "not a repo" } })).toEqual({});
		expect(readConfig(releaseWidget, { sections: [] }).sections).toEqual(DEFAULT_SECTIONS);
		expect(releaseTitle({ title: "", repo: "acme/widgets" })).toBe("Next widgets release");
	});

	it("sort pull requests into sections by label, newest first, leaving out skipped ones", () => {
		const draft = draftRelease(
			result([
				pull(3, "Faster resizing", ["enhancement"]),
				pull(4, "Fix the wobble", ["Bug"], "bob"),
				pull(5, "Explain defaults", ["docs"]),
				pull(6, "Bump vite", ["dependencies"], "renovate[bot]"),
				pull(7, "Tidy the tests", [], "bob"),
				pull(8, "Smarter crops", ["feature", "bug"], "carol"),
			]),
			config,
		);
		expect(draft.sections.map((s) => [s.title, s.items.map((c) => c.item)])).toEqual([
			["Features", ["#8", "#3"]],
			["Fixes", ["#4"]],
			["Docs", ["#5"]],
			["Other", ["#7"]],
		]);
		expect(draft.skipped.map((c) => c.item)).toEqual(["#6"]);
		expect(draft.count).toBe(5);
		expect(draft.contributors.map((c) => [c.login, c.count])).toEqual([
			["alice", 2],
			["bob", 2],
			["carol", 1],
		]);
		expect(draft).toMatchObject({ bump: "minor", next: "v1.5.0" });
	});

	it("suggest the next version from what's in it", () => {
		const fixes = draftRelease(result([pull(4, "Fix", ["bug"])]), config);
		expect(fixes).toMatchObject({ bump: "patch", next: "v1.4.1" });
		const breaking = draftRelease(result([pull(4, "Drop Node 18", ["breaking"])]), config);
		expect(breaking).toMatchObject({ bump: "major", next: "v2.0.0" });
		expect(nextVersion("0.9.3", "major")).toBe("0.10.0");
		expect(nextVersion("release-2026.10", "minor")).toBeNull();
		expect(nextVersion("pkg@1.2.3-beta.1", "patch")).toBe("pkg@1.2.4");
	});

	it("put anything unmatched in Other, even without a catch-all section", () => {
		const draft = draftRelease(result([pull(9, "Misc", ["chore"])]), {
			sections: [{ title: "Fixes", labels: ["bug"] }],
			skip: [],
		});
		expect(draft.sections).toEqual([
			{ title: "Other", items: [expect.objectContaining({ item: "#9" })] },
		]);
	});

	it("write release notes in Markdown", () => {
		const merged = [
			pull(3, "Faster `resize`", ["enhancement"]),
			pull(4, "Fix the wobble", ["bug"], "bob"),
			{ ...pull(5, "Shared fix", ["bug"]), repo: "acme/core", key: "github.com/acme/core#5" },
		];
		const draft = draftRelease(result(merged), config);
		expect(releaseMarkdown(draft, result(merged), { contributors: true })).toBe(
			[
				"## What's changed",
				"",
				"### Features",
				"",
				"- Faster \\`resize\\` (#3) by @alice",
				"",
				"### Fixes",
				"",
				"- Shared fix (acme/core#5) by @alice",
				"- Fix the wobble (#4) by @bob",
				"",
				"### Contributors",
				"",
				"Thanks to @alice and @bob.",
				"",
				"**Full changelog**: https://github.com/acme/widgets/compare/v1.4.0...v1.5.0",
				"",
			].join("\n"),
		);
		const quiet = draftRelease(result([]), config);
		expect(releaseMarkdown(quiet, result([]), { contributors: true })).toBe(
			"Nothing's been merged since the last release.\n",
		);
	});
});
