import * as v from "valibot";
import type { Card } from "./cards.ts";
import { DEFAULT_HOST } from "./refs.ts";
import type { ReleaseResult, WidgetDefinition, WidgetQuery } from "./widgets.ts";

// The release draft widget (#43): a repository's latest release and the
// pull requests merged since, sorted into sections by label (Features,
// Fixes, Docs, Other; the mapping is configurable), who contributed, the
// version that comes next, and release notes in Markdown to copy. All pure,
// so the grouping and the notes are unit-tested.

export interface ReleaseSection {
	title: string;
	/** Labels that put a pull request here (any case). None: everything left over. */
	labels: string[];
}

export interface ReleaseConfig {
	title: string;
	host: string;
	/** `owner/name`. Empty: not set up yet. */
	repo: string;
	/** In order: a pull request goes in the first whose labels it has. */
	sections: ReleaseSection[];
	/** Pull requests with any of these labels are left out of the notes. */
	skip: string[];
	/** Thank contributors in the notes. */
	contributors: boolean;
}

export const DEFAULT_SECTIONS: ReleaseSection[] = [
	{ title: "Breaking changes", labels: ["breaking", "breaking change", "semver-major"] },
	{ title: "Features", labels: ["enhancement", "feature", "feat"] },
	{ title: "Fixes", labels: ["bug", "fix", "bugfix"] },
	{ title: "Docs", labels: ["docs", "documentation"] },
	{ title: "Other", labels: [] },
];

export const DEFAULT_SKIP = ["skip-changelog", "no-release-notes", "dependencies"];

const label = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(50));

const sectionSchema = v.object({
	title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60)),
	labels: v.pipe(v.array(label), v.maxLength(20)),
});

const releaseSchema: v.GenericSchema<ReleaseConfig> = v.object({
	title: v.fallback(v.pipe(v.string(), v.maxLength(120)), ""),
	host: v.fallback(v.pipe(v.string(), v.minLength(1), v.maxLength(253)), DEFAULT_HOST),
	repo: v.fallback(v.pipe(v.string(), v.trim(), v.maxLength(200)), ""),
	sections: v.fallback(
		v.pipe(v.array(sectionSchema), v.minLength(1), v.maxLength(12)),
		DEFAULT_SECTIONS,
	),
	skip: v.fallback(v.pipe(v.array(label), v.maxLength(20)), DEFAULT_SKIP),
	contributors: v.fallback(v.boolean(), true),
});

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export const releaseWidget: WidgetDefinition<ReleaseConfig> = {
	kind: "release",
	title: "Release draft",
	description: "What's merged since the last release, sorted into notes to copy.",
	schema: releaseSchema,
	defaults: {
		title: "",
		host: DEFAULT_HOST,
		repo: "",
		sections: DEFAULT_SECTIONS,
		skip: DEFAULT_SKIP,
		contributors: true,
	},
	size: { w: 400, h: 520 },
	queries(config): Record<string, WidgetQuery> {
		const repo = config.repo.trim().replace(/^\/+|\/+$/g, "");
		if (!REPO_RE.test(repo)) return {};
		return { release: { kind: "release", repo: `${config.host}/${repo}`.toLowerCase() } };
	},
	// Merges arrive by webhook; releases being published don't always.
	refresh: 600,
};

/** The widget's title: its own, or the repository's. */
export function releaseTitle(config: Pick<ReleaseConfig, "title" | "repo">): string {
	if (config.title.trim()) return config.title.trim();
	const name = config.repo.split("/").at(-1);
	return name ? `Next ${name} release` : "Release draft";
}

export type Bump = "major" | "minor" | "patch";

export interface Contributor {
	login: string;
	avatarUrl: string;
	/** Pull requests of theirs in the release. */
	count: number;
}

export interface ReleaseDraft {
	sections: { title: string; items: Card[] }[];
	/** Left out, by `skip` labels. */
	skipped: Card[];
	contributors: Contributor[];
	bump: Bump;
	/** The suggested tag, when the latest one reads as a version. */
	next: string | null;
	/** Pull requests in the notes. */
	count: number;
}

const lower = (s: string) => s.trim().toLowerCase();

/** Whether a label says a change breaks something. */
function breaking(name: string): boolean {
	return /breaking|semver[-:]?major|major/.test(lower(name));
}

/** Sort what's merged into sections, newest first in each, and work out what comes next. */
export function draftRelease(
	result: ReleaseResult,
	config: Pick<ReleaseConfig, "sections" | "skip">,
): ReleaseDraft {
	const skip = new Set(config.skip.map(lower));
	const sections = config.sections.map((section) => ({
		title: section.title,
		labels: new Set(section.labels.map(lower)),
		items: [] as Card[],
	}));
	const rest = sections.find((section) => section.labels.size === 0);
	const skipped: Card[] = [];
	const leftOver: Card[] = [];
	const newest = [...result.mergedSince].sort((a, b) =>
		(b.mergedAt ?? b.updatedAt).localeCompare(a.mergedAt ?? a.updatedAt),
	);
	for (const card of newest) {
		const names = card.labels.map((l) => lower(l.name));
		if (names.some((name) => skip.has(name))) {
			skipped.push(card);
			continue;
		}
		const home = sections.find(
			(section) => section.labels.size > 0 && names.some((name) => section.labels.has(name)),
		);
		if (home) home.items.push(card);
		else if (rest) rest.items.push(card);
		else leftOver.push(card);
	}
	const shown = sections.map(({ title, items }) => ({ title, items }));
	// No catch-all section: what's left over still goes somewhere.
	if (leftOver.length > 0) shown.push({ title: "Other", items: leftOver });

	const included = shown.flatMap((section) => section.items);
	const people = new Map<string, Contributor>();
	for (const card of included) {
		if (!card.author || card.author.login.endsWith("[bot]")) continue;
		const known = people.get(card.author.login);
		if (known) known.count++;
		else people.set(card.author.login, { ...card.author, count: 1 });
	}
	const contributors = [...people.values()].sort(
		(a, b) => b.count - a.count || a.login.localeCompare(b.login),
	);

	const looks = (section: (typeof sections)[number], pattern: RegExp) =>
		section.items.length > 0 &&
		(pattern.test(lower(section.title)) || [...section.labels].some((name) => pattern.test(name)));
	const bump: Bump =
		included.some((card) => card.labels.some((l) => breaking(l.name))) ||
		sections.some((section) => looks(section, /breaking/))
			? "major"
			: sections.some((section) => looks(section, /feat|enhance/))
				? "minor"
				: "patch";

	return {
		sections: shown.filter((section) => section.items.length > 0),
		skipped,
		contributors,
		bump,
		next: result.latest ? nextVersion(result.latest.tag, bump) : null,
		count: included.length,
	};
}

/**
 * The tag after `tag` for a bump, keeping its prefix (`v1.4.0` → `v1.5.0`).
 * Before 1.0, breaking changes bump the minor version, as is usual. Null if
 * the tag doesn't read as a version.
 */
export function nextVersion(tag: string, bump: Bump): string | null {
	const match = /^(.*?)(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(tag.trim());
	if (!match) return null;
	const [, prefix = "", ...parts] = match;
	let [major, minor, patch] = parts.map(Number) as [number, number, number];
	const effective = bump === "major" && major === 0 ? "minor" : bump;
	if (effective === "major") [major, minor, patch] = [major + 1, 0, 0];
	else if (effective === "minor") [minor, patch] = [minor + 1, 0];
	else patch += 1;
	return `${prefix}${major}.${minor}.${patch}`;
}

/** Release notes in Markdown, GitHub-flavoured, from a draft. */
export function releaseMarkdown(
	draft: ReleaseDraft,
	result: Pick<ReleaseResult, "repo" | "latest">,
	options: { contributors: boolean },
): string {
	const lines: string[] = [];
	if (draft.count === 0) {
		lines.push("Nothing's been merged since the last release.");
		return `${lines.join("\n")}\n`;
	}
	lines.push("## What's changed", "");
	const sameRepo = (card: Card) => `${card.host}/${card.repo}`.toLowerCase() === result.repo;
	for (const section of draft.sections) {
		lines.push(`### ${section.title}`, "");
		for (const card of section.items) {
			const ref = sameRepo(card) ? card.item : `${card.repo}${card.item}`;
			const by = card.author ? ` by @${card.author.login}` : "";
			lines.push(`- ${escapeMarkdown(card.title)} (${ref})${by}`);
		}
		lines.push("");
	}
	if (options.contributors && draft.contributors.length > 0) {
		lines.push("### Contributors", "");
		lines.push(`Thanks to ${sentence(draft.contributors.map((c) => `@${c.login}`))}.`, "");
	}
	const [host, owner, name] = result.repo.split("/");
	if (result.latest && host === "github.com" && owner && name) {
		const to = draft.next ?? "HEAD";
		lines.push(
			`**Full changelog**: https://github.com/${owner}/${name}/compare/${result.latest.tag}...${to}`,
			"",
		);
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

/** “a, b and c” */
export function sentence(items: string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Keep a title's own characters from turning into Markdown. */
function escapeMarkdown(text: string): string {
	return text.replace(/([\\`*_[\]<>])/g, "\\$1");
}
