import type * as Y from "yjs";
import { withFallbacks } from "../../shared/connectors.ts";
import { boxOf } from "../../shared/sections.ts";
import {
	type ConnectorEnd,
	type ShapeFont,
	type TextSize,
	addShape,
	nextZ,
	readShape,
	shapesMap,
} from "../../shared/shapes.ts";
import { type NewConnector, addConnector, addSection } from "../../shared/structure.ts";
import { addCard } from "../board.ts";
import { cardStore } from "../cardStore.ts";
import { seedInbox, seedRules } from "./automationScenarios.ts";
import { seedDecisions } from "./decisions.ts";
import type { Stager } from "../../shared/changes.ts";
import { ACCESS_GALLERY, fixture, LABELS, PLANNING_CARDS } from "./fixtures.ts";
import { seedRelated } from "./related.ts";
import { seedWrites } from "./writes.ts";
import { IMAGEKIT, PEOPLE, failChange, stageAs } from "./push.ts";

export interface Scenario {
	name: string;
	description: string;
	seed(doc: Y.Doc): void;
}

// The people who wrote the seeded stickies.
const AUTHORS = [
	{ name: "Priya Shah", color: "#b4467a" },
	{ name: "Kai Andersen", color: "#1f7a6b" },
	{ name: "Tom Okafor", color: "#a35a12" },
	{ name: "Jo Rivera", color: "#5b5fc7" },
];
let nextAuthor = 0;

function sticky(
	doc: Y.Doc,
	text: string,
	color: string,
	x: number,
	y: number,
	font?: ShapeFont,
): string {
	const author = AUTHORS[nextAuthor++ % AUTHORS.length];
	const id = crypto.randomUUID();
	addShape(doc, id, {
		type: "sticky",
		text,
		color,
		font,
		author,
		x,
		y,
		z: nextZ(doc),
	});
	return id;
}

function text(doc: Y.Doc, value: string, size: TextSize, x: number, y: number, font?: ShapeFont) {
	addShape(doc, crypto.randomUUID(), {
		type: "text",
		text: value,
		size,
		font,
		x,
		y,
		z: nextZ(doc),
	});
}

// A silent brainstorm: four themes, a few people, and notes of every length,
// from a word to a paragraph, so shrink-to-fit gets a workout.
const BRAINSTORM: { theme: string; color: string; notes: string[] }[] = [
	{
		theme: "What hurts",
		color: "pink",
		notes: [
			"Docs",
			"Provider docs are hard to find, I end up reading source",
			"CDN detection fails for custom domains",
			"Breaking changes land without a migration guide",
			"Too many ways to do the same thing",
			"Every framework adapter has slightly different props and I can never remember which ones are supported where, so I keep a cheat sheet open in another tab",
			"Types!",
			"Slow CI",
		],
	},
	{
		theme: "Ideas",
		color: "yellow",
		notes: [
			"A provider playground",
			"Auto-detect from the URL, always",
			"Codemods for 5.0",
			"One docs page per provider, generated from the source",
			"Ship a CLI?",
			"Internationalisation",
			"Make the default export do the right thing for 90% of people",
			"Office hours",
		],
	},
	{
		theme: "Questions",
		color: "blue",
		notes: [
			"Who maintains the Shopify provider now?",
			"Do we still need Node 18?",
			"Is AVIF worth the CPU?",
			"How do other libraries version their providers?",
			"Why?",
			"What would make you recommend unpic to a friend? Honestly — and what would stop you?",
			"Sponsors?",
		],
	},
	{
		theme: "Let's do it",
		color: "green",
		notes: [
			"Drop Node 18",
			"Fallback when the CDN isn’t recognised",
			"Credit contributors in release notes",
			"Write the migration guide first, then the code",
			"Yes",
			"Pair on the Astro adapter",
			"Ship 5.0 beta by the end of the month",
		],
	},
];

function card(doc: Y.Doc, key: string, x: number, y: number): string {
	const id = crypto.randomUUID();
	addShape(doc, id, { type: "card", ref: key, x, y, z: nextZ(doc), parent: null });
	return id;
}

/** Connect two ends, with fallbacks worked out from nominal sizes. */
function connect(
	doc: Y.Doc,
	from: ConnectorEnd,
	to: ConnectorEnd,
	style: Omit<NewConnector, "from" | "to"> = {},
): string {
	const box = (id: string) => {
		const shape = shapesMap(doc).get(id);
		return shape ? boxOf(id, readShape(shape)) : undefined;
	};
	return addConnector(doc, { ...withFallbacks(from, to, box), ...style });
}

const bound = (shape: string, anchor?: { x: number; y: number }): ConnectorEnd => ({
	x: 0,
	y: 0,
	shape,
	anchor,
});

/**
 * A board mid-session: a few people have staged changes of every kind on
 * stickies and cards, one change failed last time, and one is left out.
 */
function seedPush(doc: Y.Doc): void {
	const upstream = ACCESS_GALLERY[0]?.card;
	const cards = [...PLANNING_CARDS, ...(upstream ? [upstream] : [])];
	for (const fixtureCard of cards) cardStore.set(fixtureCard);
	const ids = new Map<string, string>();
	doc.transact(() => {
		PLANNING_CARDS.forEach((fixtureCard, i) => {
			ids.set(
				fixtureCard.item,
				card(doc, fixtureCard.key, 40 + (i % 3) * 300, 70 + Math.floor(i / 3) * 330),
			);
		});
		if (upstream) ids.set("upstream", card(doc, upstream.key, 40, 740));
	});
	const shape = (item: string) => ids.get(item) ?? "";
	const key = (item: string) => `${IMAGEKIT}${item}`;
	nextAuthor = 0;
	const errors = sticky(doc, "Better errors when the CDN isn’t recognised", "yellow", 980, 90);
	const guide = sticky(doc, "Write the 5.0 migration guide first", "green", 1200, 110);
	const idea = sticky(doc, "A provider playground?", "blue", 990, 400, "hand");
	sticky(doc, "Who owns the CDN list?", "pink", 1210, 420);

	const { priya, kai, tom, jo } = PEOPLE as Record<string, Stager>;
	if (!priya || !kai || !tom || !jo) return;
	stageAs(
		doc,
		{
			kind: "issue.create",
			repo: IMAGEKIT,
			title: "Better errors when the CDN isn’t recognised",
			body: "When `detect()` can’t match a URL to a provider, it silently falls back to the default and drops every transform.\n\n**Instead**, warn once with the URL and a link to the provider list:\n\n- say which URL didn’t match\n- suggest the closest provider\n- [ ] add a test for custom domains\n\nCame out of the 5.0 planning session. cc @kai",
			labels: ["enhancement", "provider"],
		},
		priya,
		{ shapes: [errors], effect: { kind: "replace", shapes: [errors] }, minutesAgo: 14 },
	);
	const migration = stageAs(
		doc,
		{
			kind: "issue.create",
			repo: IMAGEKIT,
			title: "Write the 5.0 migration guide",
			body: "Before the code: what changes, why, and a codemod where we can.",
			labels: ["docs"],
			assignees: ["jo"],
			milestone: "5.0",
		},
		kai,
		{ shapes: [guide], effect: { kind: "replace", shapes: [guide] }, minutesAgo: 12 },
	);
	stageAs(
		doc,
		{ kind: "item.subIssue", parent: { key: key("#412") }, child: { pending: migration } },
		kai,
		{ shapes: [shape("#412"), guide], minutesAgo: 11 },
	);
	stageAs(
		doc,
		{
			kind: "item.labels",
			target: { key: key("#412") },
			add: ["needs review"],
			remove: ["enhancement"],
		},
		tom,
		{ shapes: [shape("#412")], minutesAgo: 9 },
	);
	stageAs(
		doc,
		{ kind: "item.state", target: { key: key("#377") }, state: "closed", reason: "completed" },
		jo,
		{ shapes: [shape("#377")], minutesAgo: 8 },
	);
	stageAs(
		doc,
		{
			kind: "item.comment",
			target: { key: key("#418") },
			body: "We agreed to land this for **5.0** once CI is green. @kai can you take the review?\n\nTracked on the planning board.",
		},
		priya,
		{ shapes: [shape("#418")], minutesAgo: 7 },
	);
	stageAs(
		doc,
		{ kind: "item.blockedBy", target: { key: key("#423") }, blockedBy: { key: key("#418") } },
		tom,
		{ shapes: [shape("#423"), shape("#418")], minutesAgo: 6 },
	);
	stageAs(doc, { kind: "item.assignees", target: { key: key("#423") }, add: ["priya"] }, jo, {
		shapes: [shape("#423")],
		minutesAgo: 5,
	});
	const milestone = stageAs(
		doc,
		{ kind: "item.milestone", target: { key: key("#409") }, milestone: "5.0" },
		kai,
		{ shapes: [shape("#409")], minutesAgo: 30 },
	);
	failChange(doc, milestone, "Milestone “5.0” is closed on acme/imagekit");
	stageAs(
		doc,
		{
			kind: "pr.create",
			repo: IMAGEKIT,
			title: "Decision: drop Node 18 in 5.0",
			body: "Records the decision from the planning board, so the reasoning lives next to the code.",
			branch: "tack/decision-drop-node-18",
			files: [
				{
					path: "docs/decisions/0007-drop-node-18.md",
					content:
						"# Drop Node 18 in 5.0\n\nStatus: decided\n\n## Context\n\nNode 18 is out of support, and three dependencies already need 20.\n\n## Decision\n\n5.0 needs Node 20 or later.\n",
				},
			],
		},
		jo,
		{ shapes: [idea], minutesAgo: 3 },
	);
	if (upstream) {
		stageAs(doc, { kind: "item.labels", target: { key: upstream.key }, add: ["question"] }, tom, {
			shapes: [shape("upstream")],
			included: false,
			minutesAgo: 2,
		});
	}
}

export const SCENARIOS: Record<string, Scenario> = {
	planning: {
		name: "Planning",
		description:
			"A handful of cards and stickies, the everyday case, with two not-live cards from a public upstream repo.",
		seed(doc) {
			// Two cards from an upstream repo without the app: not live until it's installed.
			const upstream = ACCESS_GALLERY.slice(0, 2).map((entry) => entry.card);
			for (const card of [...PLANNING_CARDS, ...upstream]) cardStore.set(card);
			doc.transact(() => {
				PLANNING_CARDS.forEach((card, i) => {
					addCard(doc, card.key, { x: 40 + (i % 3) * 290, y: 40 + Math.floor(i / 3) * 300 });
				});
				upstream.forEach((card, i) => {
					addCard(doc, card.key, { x: 40 + i * 290, y: 640 });
				});
				sticky(doc, "Provider docs are hard to find, I end up reading source", "yellow", 960, 40);
				sticky(doc, "CDN detection fails for custom domains", "pink", 1150, 60);
				sticky(doc, "Need a fallback when the CDN isn’t recognised", "blue", 970, 250);
				sticky(doc, "Release notes are thin, contributors don’t get credit", "green", 1160, 270);
			});
		},
	},
	triage: {
		name: "Triage",
		description: "Lots of fresh issues, ready for live updates.",
		seed(doc) {
			const titles = [
				"srcset width off by one at 2x density",
				"Astro adapter warns during SSR build",
				"Type error with exactOptionalPropertyTypes",
				"Support fit=cover in the Contentful provider",
				"Shopify provider drops the crop parameter",
				"Add width and height to the Vercel docs example",
				"Images flicker when the layout changes",
				"Unknown CDN should warn, not throw",
				"Investigate AVIF quality defaults",
			];
			const cards = titles.map((title, i) =>
				fixture({
					title,
					labels:
						i % 3 === 0
							? [LABELS.bug]
							: i % 3 === 1
								? [LABELS.enhancement]
								: [LABELS.docs, LABELS.goodFirst],
					comments: (i * 7) % 13,
				}),
			);
			for (const card of cards) cardStore.set(card);
			doc.transact(() => {
				cards.forEach((card, i) => {
					addCard(doc, card.key, { x: 40 + (i % 3) * 290, y: 40 + Math.floor(i / 3) * 210 });
				});
			});
		},
	},
	stress: {
		name: "500 cards",
		description: "Performance: zoom out to see compact cards.",
		seed(doc) {
			const columns = 23;
			const cards = Array.from({ length: 500 }, (_, i) =>
				fixture({
					title: `Synthetic card ${i + 1}: a reasonably long title so it wraps`,
					state: (["open", "open", "closed", "merged", "draft"] as const)[i % 5],
					kind: i % 5 >= 3 ? "pull" : "issue",
					labels: [LABELS.bug, LABELS.enhancement, LABELS.docs].slice(0, (i % 3) + 1),
					comments: i % 17,
				}),
			);
			for (const card of cards) cardStore.set(card);
			doc.transact(() => {
				cards.forEach((card, i) => {
					addCard(doc, card.key, { x: (i % columns) * 280, y: Math.floor(i / columns) * 220 });
				});
			});
		},
	},
	brainstorm: {
		name: "Brainstorm",
		description: "A silent brainstorm: 30 stickies of every length, headings and fonts.",
		seed(doc) {
			doc.transact(() => {
				text(doc, "unpic 5.0 brainstorm", "xl", 0, -150);
				text(
					doc,
					"Ten minutes, no talking. One idea per sticky.\nThen we group and vote.",
					"s",
					4,
					-72,
				);
				BRAINSTORM.forEach(({ theme, color, notes }, column) => {
					const x = column * 420;
					text(doc, theme, "l", x, 10, column === 3 ? "hand" : undefined);
					notes.forEach((note, i) => {
						const hand = (column + i) % 4 === 0;
						sticky(
							doc,
							note,
							color,
							x + (i % 2) * 196 + ((i * 37) % 11) - 5,
							80 + Math.floor(i / 2) * 196 + ((i * 53) % 13) - 6,
							hand ? "hand" : undefined,
						);
					});
				});
				text(doc, "← add yours anywhere", "m", 1680, 120, "hand");
			});
		},
	},
	arrange: {
		name: "Arrange",
		description:
			"A messy cluster to tidy: drag to snap, select a few to align or tidy up, then copy, paste and undo.",
		seed(doc) {
			const cards = PLANNING_CARDS.slice(0, 4);
			for (const card of cards) cardStore.set(card);
			doc.transact(() => {
				cards.forEach((card, i) => {
					addCard(doc, card.key, { x: 60 + i * 300 + ((i * 37) % 50), y: 60 + ((i * 53) % 70) });
				});
				const notes = [
					["Ship the Astro adapter first", "yellow"],
					["Docs before features", "pink"],
					["Who owns the CDN list?", "blue"],
					["Benchmark AVIF vs WebP", "green"],
					["Cut scope for 5.0", "purple"],
					["Ask Kai about the Vercel example", "yellow"],
				] as const;
				notes.forEach(([note, color], i) => {
					const x = 80 + (i % 3) * 215 + ((i * 29) % 40);
					const y = 340 + Math.floor(i / 3) * 210 + ((i * 41) % 36);
					sticky(doc, note, color, x, y);
				});
			});
		},
	},
	sections: {
		name: "Now / Next / Later",
		description: "Sections holding cards, and stickies to sort into them.",
		seed(doc) {
			for (const fixtureCard of PLANNING_CARDS) cardStore.set(fixtureCard);
			const columns = [
				{ title: "Now", color: "green" },
				{ title: "Next", color: "blue" },
				{ title: "Later", color: "purple" },
			] as const;
			doc.transact(() => {
				columns.forEach(({ title, color }, i) => {
					const x = 40 + i * 340;
					PLANNING_CARDS.slice(i * 2, i * 2 + 2).forEach((fixtureCard, j) => {
						card(doc, fixtureCard.key, x + 34, 90 + j * 170);
					});
					addSection(doc, { x, y: 40, w: 320, h: 620 }, { title, color });
				});
				sticky(doc, "Ship the new provider docs", "yellow", 1120, 60);
				sticky(doc, "Revisit AVIF defaults", "pink", 1140, 280);
				sticky(doc, "Ask about a 5.1 freeze", "green", 1320, 120);
			});
		},
	},
	connectors: {
		name: "Connectors",
		description: "Bound, loose and labelled connectors in each style.",
		seed(doc) {
			const [first, second, third, fourth] = PLANNING_CARDS;
			for (const fixtureCard of PLANNING_CARDS) cardStore.set(fixtureCard);
			if (!first || !second || !third || !fourth) return;
			doc.transact(() => {
				const a = card(doc, first.key, 60, 80);
				const b = card(doc, second.key, 480, 80);
				const c = card(doc, third.key, 480, 380);
				const d = card(doc, fourth.key, 900, 380);
				const note = sticky(doc, "Why not both?", "yellow", 120, 420);
				connect(doc, bound(a), bound(b), { label: "blocks" });
				connect(doc, bound(b, { x: 0.5, y: 1 }), bound(c, { x: 0.5, y: 0 }), { route: "elbow" });
				connect(doc, bound(c), bound(d), {
					route: "straight",
					arrow: "both",
					dash: true,
					color: "blue",
				});
				connect(doc, bound(note, { x: 1, y: 0.5 }), bound(c), { color: "orange", label: "see" });
				connect(doc, { x: 980, y: 120 }, { x: 1180, y: 250 }, { color: "red", label: "loose" });
			});
		},
	},
	decisions: {
		name: "Decisions",
		description:
			"A decision in every state: vote on one, decide it (D for a new one), then write it back as an ADR or a Discussion and push.",
		seed(doc) {
			seedDecisions(doc);
		},
	},
	writes: {
		name: "Write back",
		description:
			"Select stickies, a section, cards or the arrow to stage issues, sub-issues, blocked-by, triage and backlinks.",
		seed: seedWrites,
	},
	push: {
		name: "Pushing to GitHub",
		description:
			"Changes staged by a few people, on stickies and cards: open Changes in the top bar, then review and push. One failed last time; one is left out.",
		seed: seedPush,
	},
	related: {
		name: "Related and provenance",
		description:
			"Select “Drop Node 18 support” and Expand related (⌥E) to lay out its web around it. On the left, cards an inbox, a rule and a list brought: one no longer matches.",
		seed: seedRelated,
	},
	inbox: {
		name: "Triage inbox",
		description:
			"A section bound to a search: new matches wait in its tray. Drag them into place or dismiss them, then have new issues arrive.",
		seed: seedInbox,
	},
	rules: {
		name: "Rules",
		description:
			"Two rules: pull requests land beside the issues they close, and new bugs go into a section. Open Rules, then fire some webhooks.",
		seed: seedRules,
	},
	empty: {
		name: "Empty",
		description: "A brand new board.",
		seed() {},
	},
};
