import type { Card } from "../../shared/cards.ts";
import { PEOPLE, makeChecks, pullDetails, reviewer } from "./ci.ts";
import { LABELS, fixture } from "./fixtures.ts";

// The fake repository's pull requests waiting for review, a milestone's
// worth of issues, and items that have gone quiet: for the review queue,
// milestone and stale finder (#43) in the playground and the gallery. Dates
// are relative to `now`, so the playground's are always fresh and the
// gallery's never change.

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** The reviewer who stands for whoever's looking, in the playground's searches. */
export const VIEWER_REVIEWER = "you";

/** The team reviews are asked of. */
export const TEAM = "acme/maintainers";

/** The milestone the fixtures are in. */
export const MILESTONE = "5.0";

const MORE_LABELS = {
	performance: { name: "performance", color: "f9d0c4" },
	blocked: { name: "status: blocked", color: "b60205" },
	large: { name: "size: L", color: "c5def5" },
	components: { name: "components", color: "41b883" },
};

const you = { login: VIEWER_REVIEWER, avatarUrl: "", state: "requested" as const };
const team = { login: TEAM.split("/")[1] ?? TEAM, avatarUrl: "", state: "requested" as const };

export function reviewCards(now: number): Card[] {
	const at = (ms: number) => new Date(now - ms).toISOString();
	const pull = (
		item: string,
		title: string,
		opened: number,
		size: [number, number, number],
		details: Parameters<typeof pullDetails>[0],
		overrides: Partial<Card> = {},
	) =>
		fixture({
			item,
			kind: "pull",
			title,
			createdAt: at(opened),
			updatedAt: at(Math.min(opened, 6 * HOUR)),
			author: PEOPLE.priya,
			pull: pullDetails({
				additions: size[0],
				deletions: size[1],
				changedFiles: size[2],
				...details,
			}),
			...overrides,
		});
	return [
		pull(
			"#467",
			"Drop the legacy URL parser",
			12 * DAY,
			[340, 910, 14],
			{
				review: "changes_requested",
				reviewers: [reviewer("jo", "changes_requested"), you],
			},
			{ author: PEOPLE.tom, labels: [LABELS.breaking] },
		),
		pull(
			"#455",
			"Add a Glint Images provider",
			9 * DAY,
			[612, 48, 11],
			{ reviewers: [you, team] },
			{ labels: [LABELS.provider] },
		),
		pull(
			"#457",
			"Preload the LCP image automatically",
			5 * DAY,
			[184, 22, 6],
			{
				checks: makeChecks({ passed: 10, failed: 1, failing: ["e2e (webkit)"] }),
				reviewers: [you, reviewer("jo", "commented")],
			},
			{ author: PEOPLE.kai, labels: [MORE_LABELS.performance] },
		),
		pull(
			"#461",
			"Move the docs site to emdash",
			3 * DAY,
			[2210, 1904, 63],
			{ checks: makeChecks({ passed: 6, pending: 5 }), reviewers: [you] },
			{ author: PEOPLE.jo, labels: [LABELS.docs] },
		),
		pull(
			"#459",
			"Fix srcset rounding at 1.5x density",
			2 * DAY,
			[12, 9, 2],
			{ reviewers: [team] },
			{ author: PEOPLE.tom },
		),
		pull(
			"#463",
			"Export the transformer types",
			20 * HOUR,
			[46, 10, 3],
			{ reviewers: [you] },
			{ author: PEOPLE.kai, labels: [LABELS.enhancement] },
		),
		pull(
			"#465",
			"Retry provider detection on timeouts",
			6 * HOUR,
			[88, 31, 4],
			{ checks: makeChecks({ passed: 4, pending: 8 }), reviewers: [team, you] },
			{ labels: [LABELS.provider] },
		),
		pull(
			"#469",
			"Bump pixelmill to 0.34",
			1 * DAY,
			[3, 3, 1],
			{ review: "approved", reviewers: [reviewer("kai", "approved")] },
			{ author: PEOPLE.jo },
		),
	];
}

export function milestoneCards(now: number): Card[] {
	const at = (ms: number) => new Date(now - ms).toISOString();
	const milestone = { title: MILESTONE, dueOn: new Date(now + 18 * DAY).toISOString() };
	const item = (
		n: number,
		title: string,
		opened: number,
		updated: number,
		overrides: Partial<Card> = {},
	) =>
		fixture({
			item: `#${n}`,
			title,
			createdAt: at(opened * DAY),
			updatedAt: at(updated * DAY),
			closedAt: null,
			milestone,
			...overrides,
		});
	const closed = (
		n: number,
		title: string,
		opened: number,
		done: number,
		labels = [LABELS.enhancement],
	) =>
		item(n, title, opened, done, {
			state: "closed",
			stateReason: "completed",
			closedAt: at(done * DAY),
			labels,
		});
	return [
		item(381, "Ship the new default breakpoints", 34, 2, {
			labels: [LABELS.enhancement],
			assignees: [PEOPLE.kai],
		}),
		item(383, "Rewrite provider detection", 38, 21, {
			labels: [LABELS.enhancement, MORE_LABELS.large],
			assignees: [PEOPLE.priya],
			comments: 17,
		}),
		item(385, "Remove the deprecated layout values", 30, 6, {
			labels: [LABELS.breaking, MORE_LABELS.blocked],
		}),
		item(387, "Publish ESM-only builds", 12, 1, {
			kind: "pull",
			author: PEOPLE.jo,
			labels: [LABELS.breaking],
			pull: pullDetails({ additions: 1400, deletions: 800, changedFiles: 41 }),
		}),
		item(389, "Write the upgrade guide for 5.0", 26, 16, { labels: [LABELS.docs] }),
		item(391, "Audit the default quality settings", 9, 3, {
			labels: [MORE_LABELS.performance],
			assignees: [PEOPLE.tom],
		}),
		closed(382, "Drop the UMD bundle", 40, 28, [LABELS.breaking]),
		closed(384, "Move tests to Vitest", 39, 24),
		closed(386, "Type the provider options", 36, 19),
		closed(388, "Remove the `unpic/legacy` entry point", 33, 15, [LABELS.breaking]),
		closed(390, "Respect the Save-Data header", 28, 11, [MORE_LABELS.performance]),
		closed(392, "Document the transformer API", 24, 8, [LABELS.docs]),
		closed(393, "Cache parsed URLs", 20, 6, [MORE_LABELS.performance]),
		closed(394, "Fix aspect ratio for portrait crops", 15, 4, [LABELS.bug]),
		closed(395, "New logo in the README", 9, 2, [LABELS.docs]),
		closed(396, "Lazy-load below the fold by default", 7, 0.5),
	];
}

export function staleCards(now: number): Card[] {
	const at = (days: number) => new Date(now - days * DAY - 3 * HOUR).toISOString();
	const item = (n: number, title: string, quiet: number, overrides: Partial<Card> = {}) =>
		fixture({
			item: `#${n}`,
			title,
			createdAt: at(quiet + 40),
			updatedAt: at(quiet),
			author: PEOPLE.jo,
			...overrides,
		});
	return [
		item(214, "Art direction with the picture element", 210, {
			labels: [LABELS.enhancement],
			assignees: [PEOPLE.tom],
			comments: 12,
			reactions: 8,
		}),
		item(233, "Memory use in the Node transformer", 140, { labels: [MORE_LABELS.performance] }),
		item(251, "WIP: a WebAssembly local transformer", 95, {
			kind: "pull",
			state: "draft",
			labels: [LABELS.provider],
			pull: pullDetails({
				additions: 820,
				deletions: 12,
				changedFiles: 9,
				checks: makeChecks({ passed: 3, failed: 2 }),
			}),
		}),
		item(262, "Explain cache headers for each CDN", 70, { labels: [LABELS.docs] }),
		item(287, "Pixfold: respect fit=facearea", 52, {
			labels: [LABELS.provider],
			assignees: [PEOPLE.priya],
			comments: 4,
		}),
		item(301, "A CLI for generating srcsets", 44, { labels: [LABELS.enhancement], reactions: 3 }),
		item(318, "Support fetchpriority on generated images", 35, {
			labels: [LABELS.enhancement],
			comments: 3,
		}),
		item(336, "The image component doesn't forward refs", 31, {
			labels: [MORE_LABELS.components],
			author: PEOPLE.kai,
		}),
	];
}

/** Everything above, for the playground's searches. */
export function kindCards(now: number): Card[] {
	return [...reviewCards(now), ...milestoneCards(now), ...staleCards(now)];
}
