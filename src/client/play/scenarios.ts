import type * as Y from "yjs";
import { addShape, nextZ } from "../../shared/shapes.ts";
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

function sticky(doc: Y.Doc, text: string, color: string, x: number, y: number) {
	const author = AUTHORS[nextAuthor++ % AUTHORS.length];
	addShape(doc, crypto.randomUUID(), { type: "sticky", text, color, author, x, y, z: nextZ(doc) });
}

export const SCENARIOS: Record<string, Scenario> = {
	planning: {
		name: "Planning",
		description: "A handful of cards and stickies, the everyday case.",
		seed(doc) {
			for (const card of PLANNING_CARDS) cardStore.set(card);
			doc.transact(() => {
				PLANNING_CARDS.forEach((card, i) => {
					addCard(doc, card.key, { x: 40 + (i % 3) * 290, y: 40 + Math.floor(i / 3) * 230 });
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
	empty: {
		name: "Empty",
		description: "A brand new board.",
		seed() {},
	},
};
