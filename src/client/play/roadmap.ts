import type * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { itemKey } from "../../shared/refs.ts";
import { addShape, nextZ } from "../../shared/shapes.ts";
import { addSection } from "../../shared/structure.ts";
import { addWidget } from "../../shared/widgetRegistry.ts";
import type { RelatedResult, ReleaseResult } from "../../shared/widgets.ts";
import { PEOPLE, avatar, makeChecks, pullDetails } from "./ci.ts";
import { LABELS, fixture } from "./fixtures.ts";

// The playground's fake repository, for the timeline, release draft and
// dependency map (#43): when its items were opened, closed and merged, the
// pull requests merged since its latest release, and what blocks what
// (a chain to the 5.0 launch, a closed blocker, and a cycle). The simulated
// server (`widgets.ts`) answers `related` and `release` queries from here;
// searches, date qualifiers and all (`created:2026-09-01..2026-09-30`), go
// through the shared matcher, as on the fake forges.

const REPO = "acme/imagekit";
const DAY = 86_400_000;
/** Times are relative to when the playground loaded, so “the last two weeks” always has something in it. */
export const LOADED = Date.now();
const ago = (days: number) => new Date(LOADED - days * DAY).toISOString();
const key = (n: number) => itemKey({ host: "fake.tack", repo: REPO, item: `#${n}` });

const PEOPLE_MORE = {
	ana: { login: "ana", avatarUrl: avatar("ana", "#2f7d4f") },
	lee: { login: "lee", avatarUrl: avatar("lee", "#8a4fbf") },
	bot: { login: "renovate[bot]", avatarUrl: avatar("renovate", "#2d6cdf") },
};

/** When each of the repository's items was opened (days ago), and closed or merged. */
const TIMES: Record<number, { opened: number; closed?: number }> = {
	408: { opened: 41 },
	410: { opened: 36 },
	411: { opened: 33, closed: 26 },
	413: { opened: 31 },
	414: { opened: 29 },
	415: { opened: 28, closed: 9 },
	416: { opened: 25 },
	417: { opened: 22 },
	419: { opened: 19.4 },
	420: { opened: 19.2 },
	421: { opened: 19.1 },
	422: { opened: 15 },
	424: { opened: 12 },
	425: { opened: 10.5 },
	426: { opened: 8 },
	427: { opened: 6.2 },
	428: { opened: 5 },
	429: { opened: 3.1 },
	430: { opened: 1.4 },
	431: { opened: 0.4 },
};

/** Give the repository's cards their dates. */
export function stampTimes(cards: Card[]): void {
	for (const card of cards) {
		const times = TIMES[Number(card.item.slice(1))];
		if (!times || card.createdAt) continue;
		card.createdAt = ago(times.opened);
		const closed = card.state === "closed" || card.state === "merged";
		card.closedAt = closed ? ago(times.closed ?? times.opened / 2) : null;
		if (card.kind === "pull") card.mergedAt = card.state === "merged" ? card.closedAt : null;
	}
}

/** The latest release: 5.3.0, a little over three weeks ago. */
export const LATEST_RELEASE = {
	tag: "v5.3.0",
	name: "5.3.0",
	publishedAt: ago(23),
	url: `https://fake.tack/${REPO}/releases/v5.3.0`,
};

const merged = (
	n: number,
	title: string,
	labels: Card["labels"],
	author: { login: string; avatarUrl: string },
	days: number,
): Card =>
	fixture({
		item: `#${n}`,
		kind: "pull",
		state: "merged",
		title,
		labels,
		author,
		assignees: [author].filter((a) => !a.login.endsWith("[bot]")),
		updatedAt: ago(days),
		createdAt: ago(days + 3),
		closedAt: ago(days),
		mergedAt: ago(days),
		pull: pullDetails({ checks: makeChecks({ passed: 11 }), review: "approved" }),
	});

/** Pull requests merged since the latest release. */
export const RELEASE_PULLS: Card[] = [
	merged(447, "Respect the crop gravity on Bunny", [LABELS.bug, LABELS.provider], PEOPLE.kai, 0.6),
	merged(
		446,
		"Add an ImageKit provider",
		[LABELS.enhancement, LABELS.provider],
		PEOPLE_MORE.ana,
		1.2,
	),
	merged(
		445,
		"Bump vite from 6.2 to 6.3",
		[{ name: "dependencies", color: "0366d6" }],
		PEOPLE_MORE.bot,
		2,
	),
	merged(444, "Explain the default breakpoints", [LABELS.docs], PEOPLE.jo, 3.5),
	merged(443, "Fix double-encoded spaces in Contentful URLs", [LABELS.bug], PEOPLE.priya, 4.2),
	merged(442, "Serve AVIF to Safari 16.4 and later", [LABELS.enhancement], PEOPLE.tom, 6.4),
	merged(441, "Netlify: pass quality=auto through", [LABELS.bug], PEOPLE.kai, 8),
	merged(440, "Tidy the provider test fixtures", [], PEOPLE_MORE.lee, 9.5),
	merged(
		439,
		"A recipe for Astro's image service",
		[LABELS.docs, LABELS.goodFirst],
		PEOPLE_MORE.ana,
		12,
	),
	merged(
		438,
		"Detect custom domains from response headers",
		[LABELS.enhancement],
		PEOPLE.priya,
		15,
	),
	merged(437, "Keep the format when resizing Cloudinary URLs twice", [LABELS.bug], PEOPLE.kai, 19),
];

/** The repository's release, as the simulated server answers a `release` query. */
export function releaseOf(repo: string): ReleaseResult {
	return {
		kind: "release",
		repo,
		latest: LATEST_RELEASE,
		mergedSince: repo === `fake.tack/${REPO}` ? RELEASE_PULLS : [],
	};
}

/**
 * What blocks what, `[blocker, blocked]`: the 5.0 launch's chain (benchmarks,
 * then fewer options, then explaining the defaults, then the walkthrough),
 * format bugs in a row, a blocker that's done (#415), and a cycle among
 * three docs issues.
 */
export const BLOCKS: [number, number][] = [
	[425, 413],
	[413, 426],
	[426, 408],
	[431, 427],
	[427, 419],
	[419, 408],
	[415, 410],
	[410, 408],
	[414, 429],
	[429, 420],
	[420, 414],
];

/** What's related to an item, as the simulated server answers a `related` query. */
export function relatedOf(
	itemKeyOf: string,
	lookup: (key: string) => Card | undefined,
): RelatedResult {
	const n = Number(itemKeyOf.split("#")[1]);
	const blockedBy = BLOCKS.filter(([, b]) => b === n).map(([a]) => key(a));
	const blocking = BLOCKS.filter(([a]) => a === n).map(([, b]) => key(b));
	return {
		kind: "related",
		key: itemKeyOf,
		subIssues: [],
		blockedBy,
		blocking,
		linkedPulls: [],
		cards: [...blockedBy, ...blocking].flatMap((k) => {
			const card = lookup(k);
			return card ? [card] : [];
		}),
	};
}

/** A board with a timeline, a release draft, and a dependency map of a launch section. */
export function seedRoadmap(doc: Y.Doc): void {
	const host = "fake.tack";
	addWidget(
		doc,
		"timeline",
		{ x: 40, y: 40 },
		{
			title: "",
			host,
			q: `repo:${REPO}`,
			event: "created",
			range: "1m",
		},
	);
	addWidget(doc, "release", { x: 800, y: 40 }, { host, repo: REPO });
	const launch = addSection(
		doc,
		{ x: 40, y: 900, w: 1140, h: 560 },
		{ title: "5.0 launch", color: "blue" },
	);
	const cards = [425, 413, 426, 408, 431, 427, 419, 415, 410, 414, 429, 420];
	cards.forEach((n, i) => {
		addShape(doc, crypto.randomUUID(), {
			type: "card",
			ref: key(n),
			x: 70 + (i % 4) * 276,
			y: 950 + Math.floor(i / 4) * 170,
			z: nextZ(doc),
			parent: launch,
		});
	});
	addWidget(
		doc,
		"dependencies",
		{ x: 40, y: 400 },
		{
			title: "",
			source: "section",
			section: launch,
			limit: 20,
		},
	);
}
