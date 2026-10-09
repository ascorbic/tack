import type * as Y from "yjs";
import { type ShapeFont, type TextSize, addShape, nextZ } from "../../shared/shapes.ts";
import { addCard } from "../board.ts";
import { cardStore } from "../cardStore.ts";
import { fixture, LABELS, PLANNING_CARDS } from "./fixtures.ts";

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

function sticky(doc: Y.Doc, text: string, color: string, x: number, y: number, font?: ShapeFont) {
	const author = AUTHORS[nextAuthor++ % AUTHORS.length];
	addShape(doc, crypto.randomUUID(), {
		type: "sticky",
		text,
		color,
		font,
		author,
		x,
		y,
		z: nextZ(doc),
	});
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

export const SCENARIOS: Record<string, Scenario> = {
	planning: {
		name: "Planning",
		description: "A handful of cards and stickies, the everyday case.",
		seed(doc) {
			for (const card of PLANNING_CARDS) cardStore.set(card);
			doc.transact(() => {
				PLANNING_CARDS.forEach((card, i) => {
					addCard(doc, card.key, { x: 40 + (i % 3) * 290, y: 40 + Math.floor(i / 3) * 300 });
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
	empty: {
		name: "Empty",
		description: "A brand new board.",
		seed() {},
	},
};
