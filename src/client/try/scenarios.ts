import type * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { placeDot, startVote } from "../../shared/dotvotes.ts";
import { toggleStamp } from "../../shared/facilitation.ts";
import { type ShapeFont, type TextSize, addShape, nextZ } from "../../shared/shapes.ts";
import { addSection } from "../../shared/structure.ts";
import { addCard } from "../board.ts";
import { makeChecks, pullDetails, reviewer } from "../play/ci.ts";
import { LABELS, fixture } from "../play/fixtures.ts";

// The boards the public demo starts from (#75): a planning session, a retro
// and a triage, about the owner's own projects on the demo forge (`fake.tack`,
// which only exists in the browser). Each has two stickies the guide asks you
// to stack, and a dot vote open for its last steps.

export interface TryScenario {
	name: string;
	/** A line for the picker. */
	blurb: string;
	/** The cards it shows, put in the card store before the board is seeded or restored. */
	cards: Card[];
	seed(doc: Y.Doc): void;
	/** The guide's first step: drag the sticky saying `from` onto the one saying `onto`. */
	stack: { from: string; onto: string };
}

export const TACK = "ascorbic/tack";
export const UNPIC = "ascorbic/unpic";

export const PRIYA = { name: "Priya Shah", color: "#b4467a", login: "priya" };
export const KAI = { name: "Kai Andersen", color: "#1f7a6b", login: "kai" };
export const TOM = { name: "Tom Okafor", color: "#a35a12", login: "tom" };
export const JO = { name: "Jo Rivera", color: "#5b5fc7", login: "jo" };

type Author = typeof PRIYA;

const DAY = 86_400_000;

function sticky(
	doc: Y.Doc,
	text: string,
	color: string,
	at: { x: number; y: number },
	author: Author,
	parent: string | null = null,
	font?: ShapeFont,
): string {
	const id = crypto.randomUUID();
	addShape(doc, id, {
		type: "sticky",
		text,
		color,
		font,
		author: { name: author.name, color: author.color },
		x: at.x,
		y: at.y,
		z: nextZ(doc),
		parent,
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

/** A little untidy, as stickies are after people have been at them. */
const jitter = (i: number, by = 9) => ((i * 37) % (by * 2 + 1)) - by;

// Planning ------------------------------------------------------------------------

const PLANNING_CARDS: Card[] = [
	fixture({
		repo: TACK,
		item: "#212",
		title: "Offline edits survive a refresh",
		labels: [LABELS.enhancement],
		comments: 8,
		reactions: 12,
		thumbsUp: { count: 9, logins: ["priya", "jo"] },
	}),
	fixture({
		repo: TACK,
		item: "#218",
		kind: "pull",
		title: "Faster minimap on boards with 900 shapes",
		labels: [LABELS.enhancement],
		comments: 4,
		pull: pullDetails({
			checks: makeChecks({ passed: 9, pending: 2 }),
			reviewers: [reviewer("kai", "requested"), reviewer("priya", "approved")],
		}),
	}),
	fixture({
		repo: TACK,
		item: "#205",
		title: "Comment on a card and it shows up on GitHub",
		labels: [LABELS.enhancement],
		comments: 11,
		reactions: 7,
	}),
	fixture({
		repo: TACK,
		item: "#221",
		title: "Board embeds look blurry on high-density screens",
		labels: [LABELS.bug],
		comments: 3,
	}),
];

function seedPlanning(doc: Y.Doc): void {
	doc.transact(() => {
		text(doc, "Tack 1.0 planning", "xl", 0, -170);
		text(doc, "Sort the ideas, vote on what's next, push what we decide.", "s", 4, -92);
		const ideas = addSection(
			doc,
			{ x: 0, y: 0, w: 900, h: 620 },
			{ title: "What should 1.0 fix?", color: "blue" },
		);
		const notes: [string, string, Author][] = [
			["CI takes 20 minutes on a good day", "pink", KAI],
			["Flaky e2e tests on Safari", "pink", TOM],
			["Self-hosting docs skip the GitHub App step", "yellow", PRIYA],
			["Changelog doesn't credit contributors", "green", JO],
			["No guide for moving a board between instances", "yellow", KAI],
			["Release notes are thin", "green", PRIYA],
			["Keyboard shortcuts are hard to discover", "purple", TOM],
			["A dark mode for embeds?", "blue", JO],
		];
		notes.forEach(([note, color, author], i) => {
			const at = {
				x: 30 + (i % 4) * 215 + jitter(i),
				y: 64 + Math.floor(i / 4) * 265 + jitter(i + 3),
			};
			sticky(doc, note, color, at, author, ideas);
		});

		const next = addSection(
			doc,
			{ x: 980, y: 0, w: 640, h: 620 },
			{ title: "Next up", color: "green" },
		);
		const cards = PLANNING_CARDS.map((card, i) =>
			addCard(doc, card.key, { x: 1010 + (i % 2) * 300, y: 64 + Math.floor(i / 2) * 270 }),
		);
		const vote = startVote(doc, {
			scope: next,
			dots: 3,
			reactions: true,
			endsAt: new Date(Date.now() + 2 * DAY).toISOString(),
			by: PRIYA,
		});
		const [offline, minimap, comments] = cards;
		if (offline && minimap && comments) {
			placeDot(doc, vote, PRIYA, offline);
			placeDot(doc, vote, PRIYA, comments);
			placeDot(doc, vote, KAI, minimap);
			placeDot(doc, vote, KAI, offline);
		}
	});
}

// Retro ---------------------------------------------------------------------------

const RETRO_CARDS: Card[] = [
	fixture({
		repo: TACK,
		item: "#190",
		kind: "pull",
		state: "merged",
		title: "Stacks: drag a sticky onto another to group them",
		labels: [LABELS.enhancement],
		comments: 17,
		pull: pullDetails({
			checks: makeChecks({ passed: 12 }),
			review: "approved",
			reviewers: [reviewer("priya", "approved")],
		}),
	}),
	fixture({
		repo: TACK,
		item: "#197",
		state: "closed",
		stateReason: "completed",
		title: "History panel loses its place when you scroll",
		labels: [LABELS.bug],
		comments: 5,
	}),
];

function seedRetro(doc: Y.Doc): void {
	doc.transact(() => {
		text(doc, "Sprint 12 retro", "xl", 0, -170);
		text(doc, "Write it down, stack what's alike, vote on what to change.", "s", 4, -92);
		const columns = [
			{ title: "Went well", color: "green", x: 0 },
			{ title: "To improve", color: "red", x: 660 },
			{ title: "Ideas", color: "yellow", x: 1320 },
		] as const;
		const [went, improve, ideas] = columns.map(({ title, color, x }) =>
			addSection(doc, { x, y: 0, w: 620, h: 600 }, { title, color }),
		);
		if (!went || !improve || !ideas) return;
		const at = (column: number, i: number) => ({
			x: columns[column]!.x + 30 + (i % 3) * 196 + jitter(i + column),
			y: 64 + Math.floor(i / 3) * 250 + jitter(i + column + 2),
		});
		const shipped = sticky(
			doc,
			"Stacks shipped and people love them",
			"green",
			at(0, 0),
			PRIYA,
			went,
		);
		sticky(doc, "Reviews came back within a day", "green", at(0, 1), KAI, went);
		RETRO_CARDS.forEach((card, i) => addCard(doc, card.key, { x: 30 + i * 300, y: 330 }));

		sticky(doc, "We rerun CI three times a day", "pink", at(1, 0), JO, improve);
		sticky(doc, "Flaky e2e on the Windows runners", "pink", at(1, 1), TOM, improve);
		const reviewer = sticky(
			doc,
			"Too many pull requests wait on one reviewer",
			"pink",
			at(1, 2),
			PRIYA,
			improve,
		);
		sticky(doc, "Release notes written the night before", "pink", at(1, 3), KAI, improve);
		sticky(doc, "Nobody knew who owned the embeds bug", "pink", at(1, 4), JO, improve);

		sticky(doc, "Pair on reviews on Fridays", "yellow", at(2, 0), TOM, ideas);
		sticky(doc, "A rota for release notes", "yellow", at(2, 1), PRIYA, ideas);
		sticky(doc, "Demo something every sprint", "yellow", at(2, 2), KAI, ideas, "hand");

		toggleStamp(doc, shipped, "🎉", PRIYA);
		toggleStamp(doc, shipped, "🎉", KAI);
		toggleStamp(doc, shipped, "❤️", TOM);
		toggleStamp(doc, reviewer, "➕", JO);
		toggleStamp(doc, reviewer, "➕", KAI);

		const vote = startVote(doc, {
			scope: improve,
			dots: 3,
			endsAt: new Date(Date.now() + DAY).toISOString(),
			by: KAI,
		});
		placeDot(doc, vote, KAI, reviewer);
		placeDot(doc, vote, JO, reviewer);
	});
}

// Triage --------------------------------------------------------------------------

const TRIAGE: { item: string; title: string; labels: (typeof LABELS)[keyof typeof LABELS][] }[] = [
	{ item: "#601", title: "srcset widths off by one at 2x density", labels: [LABELS.bug] },
	{ item: "#604", title: "Astro component warns during the SSR build", labels: [LABELS.bug] },
	{ item: "#607", title: "Support fit=cover for every provider", labels: [LABELS.enhancement] },
	{ item: "#609", title: "Type error with exactOptionalPropertyTypes", labels: [] },
	{ item: "#612", title: "Images flicker when the layout changes", labels: [] },
	{ item: "#615", title: "An unknown CDN should warn, not throw", labels: [LABELS.enhancement] },
];

const TRIAGE_CARDS: Card[] = TRIAGE.map(({ item, title, labels }, i) =>
	fixture({ repo: UNPIC, item, title, labels, comments: (i * 7) % 11, reactions: (i * 5) % 9 }),
);

function seedTriage(doc: Y.Doc): void {
	doc.transact(() => {
		text(doc, "unpic triage", "xl", 0, -170);
		text(doc, "New this week: what's a bug, what's next, and what we heard.", "s", 4, -92);
		const inbox = addSection(
			doc,
			{ x: 0, y: 0, w: 940, h: 600 },
			{ title: "New this week", color: "purple" },
		);
		const cards = TRIAGE_CARDS.map((card, i) =>
			addCard(doc, card.key, { x: 30 + (i % 3) * 300, y: 64 + Math.floor(i / 3) * 270 }),
		);
		const heard = addSection(
			doc,
			{ x: 1020, y: 0, w: 460, h: 600 },
			{ title: "From the community call", color: "yellow" },
		);
		sticky(
			doc,
			"The Astro docs example is out of date",
			"yellow",
			{ x: 1050, y: 64 },
			PRIYA,
			heard,
		);
		sticky(
			doc,
			"README doesn't mention the Astro component",
			"yellow",
			{ x: 1252, y: 70 },
			KAI,
			heard,
		);
		sticky(doc, "Benchmarks against next/image?", "blue", { x: 1056, y: 318 }, TOM, heard);
		sticky(doc, "Who maintains the Shopify provider?", "pink", { x: 1250, y: 312 }, JO, heard);

		const vote = startVote(doc, {
			scope: inbox,
			dots: 3,
			endsAt: new Date(Date.now() + DAY).toISOString(),
			by: TOM,
		});
		const [first, second] = cards;
		if (first && second) {
			placeDot(doc, vote, TOM, first);
			placeDot(doc, vote, PRIYA, second);
			placeDot(doc, vote, PRIYA, first);
		}
	});
}

export const TRY_SCENARIOS = {
	planning: {
		name: "Planning session",
		blurb: "Tack 1.0: sort the ideas and vote on what's next",
		cards: PLANNING_CARDS,
		seed: seedPlanning,
		stack: { from: "Flaky e2e tests on Safari", onto: "CI takes 20 minutes on a good day" },
	},
	retro: {
		name: "Retro",
		blurb: "Sprint 12: what went well, what to change",
		cards: RETRO_CARDS,
		seed: seedRetro,
		stack: { from: "Flaky e2e on the Windows runners", onto: "We rerun CI three times a day" },
	},
	triage: {
		name: "Triage",
		blurb: "unpic: this week's new issues, and what people asked for",
		cards: TRIAGE_CARDS,
		seed: seedTriage,
		stack: {
			from: "README doesn't mention the Astro component",
			onto: "The Astro docs example is out of date",
		},
	},
} satisfies Record<string, TryScenario>;

export type TryScenarioId = keyof typeof TRY_SCENARIOS;

export function isScenario(id: string | null | undefined): id is TryScenarioId {
	return Boolean(id && Object.hasOwn(TRY_SCENARIOS, id));
}
