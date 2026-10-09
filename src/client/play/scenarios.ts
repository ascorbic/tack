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
import { seedDecisions } from "./decisions.ts";
import { ACCESS_GALLERY, fixture, LABELS, PLANNING_CARDS } from "./fixtures.ts";
import { seedWrites } from "./writes.ts";

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
	empty: {
		name: "Empty",
		description: "A brand new board.",
		seed() {},
	},
};
