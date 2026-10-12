import type * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { addShape, nextZ, shapesMap } from "../../shared/shapes.ts";
import { applyGrouping } from "../../shared/stackEdits.ts";
import { namingTexts, stackHash, stackMembers } from "../../shared/stacks.ts";
import { readShapes } from "../../shared/structure.ts";
import { addWidget } from "../../shared/widgetRegistry.ts";
import { cardStore } from "../cardStore.ts";
import { LABELS, PLANNING_CARDS, fixture } from "./fixtures.ts";
import { MILESTONE } from "./kindFixtures.ts";
import type { SimulatedBoard } from "./simulator.ts";
import { REPO, searchableCards } from "./widgets.ts";

// The landing page's first screenshot (`?scenario=hero`, site/scripts/screenshots.ts):
// most of what Tack is, on one screen at 1200 × 750. Live cards with labels
// and CI, a stack drawn as its card with a ✨ suggested name, a live list and
// a milestone over the fake repository, and stickies with who wrote them.
// Everything that matters sits left of x 1060, as the landing page lets the
// board run off its right edge and pins a sticky over the bottom left. Three
// of the people who wrote them are here with you (`heroPeople`).

const AUTHORS = {
	priya: { name: "Priya Shah", color: "#b4467a" },
	kai: { name: "Kai Andersen", color: "#1f7a6b" },
	tom: { name: "Tom Okafor", color: "#a35a12" },
	jo: { name: "Jo Rivera", color: "#5b5fc7" },
};

/** The issue in the stack: the other two are stickies. */
export const HERO_STACK_CARD: Card = fixture({
	item: "#433",
	title: "Unknown CDN should warn, not throw",
	labels: [LABELS.bug],
	comments: 5,
	visibility: "public",
});

/** The stack's suggested name. */
export const HERO_STACK_NAME = "Custom domain detection";

function sticky(
	doc: Y.Doc,
	text: string,
	color: string,
	author: keyof typeof AUTHORS,
	x: number,
	y: number,
): string {
	const id = crypto.randomUUID();
	addShape(doc, id, { type: "sticky", text, color, author: AUTHORS[author], x, y, z: nextZ(doc) });
	return id;
}

function card(doc: Y.Doc, item: Card, x: number, y: number): string {
	const id = crypto.randomUUID();
	addShape(doc, id, { type: "card", ref: item.key, x, y, z: nextZ(doc) });
	return id;
}

export function seedHero(doc: Y.Doc): void {
	const [, pull, issue] = PLANNING_CARDS as [Card, Card, Card];
	for (const item of [...PLANNING_CARDS, ...searchableCards(), HERO_STACK_CARD]) {
		cardStore.set(item);
	}
	doc.transact(() => {
		// Live cards: an issue with labels, and a pull request with CI running and a review asked for.
		card(doc, issue, 32, 40);
		card(doc, pull, 32, 212);
		// A stack Group these made, its name a suggestion until someone keeps it.
		const theme = [
			sticky(doc, "CDN detection fails for custom domains", "pink", "kai", 320, 40),
			sticky(doc, "Need a fallback when the CDN isn’t recognised", "blue", "tom", 320, 40),
			card(doc, HERO_STACK_CARD, 320, 40),
		];
		const [stack = ""] = applyGrouping(doc, [
			{ name: HERO_STACK_NAME, ids: theme, at: { x: 316, y: 40 } },
		]);
		// Suggested from everything in it, the issue's title too, as the board's
		// server names it, so the playground's namer keeps it.
		const shapes = readShapes(doc);
		const texts = namingTexts(shapes, stackMembers(shapes).get(stack) ?? [], (ref) =>
			ref === HERO_STACK_CARD.key ? HERO_STACK_CARD.title : null,
		);
		shapesMap(doc)
			.get(stack)
			?.set("suggested", { title: HERO_STACK_NAME, hash: stackHash(texts) });
		// Stickies still to sort, with who wrote them.
		sticky(doc, "Docs before features", "yellow", "priya", 316, 262);
		sticky(doc, "Codemods for 5.0?", "green", "jo", 506, 276);
		// A live list and a milestone over the repository.
		const list = addWidget(
			doc,
			"list",
			{ x: 712, y: 40 },
			{
				title: "Open bugs",
				host: "fake.tack",
				q: `repo:${REPO} is:open label:bug`,
				sort: "updated",
				limit: 30,
			},
		);
		shapesMap(doc).get(list)?.set("w", 340);
		shapesMap(doc).get(list)?.set("h", 470);
		const milestone = addWidget(
			doc,
			"milestone",
			{ x: 1084, y: 40 },
			{ host: "fake.tack", repo: REPO, milestone: MILESTONE },
		);
		shapesMap(doc).get(milestone)?.set("h", 470);
	});
}

/**
 * A session in progress, held still for the screenshot: Kai at the stack,
 * Priya reading the list, Tom agreeing on a sticky in cursor chat, and Jo
 * off to the right at the milestone, so only in the top bar. Cursors point
 * beside titles, never over them.
 */
export function heroPeople(board: SimulatedBoard): void {
	const view = (x: number, y: number) => ({ x, y, width: 1280, height: 800 });
	board.join(AUTHORS.kai).pose({ x: 520, y: 206 }, view(-40, -60));
	board.join(AUTHORS.priya).pose({ x: 952, y: 414 }, view(300, -60));
	board.join(AUTHORS.tom).pose({ x: 400, y: 432 }, view(-40, 0), "+1, docs first");
	board.join(AUTHORS.jo).pose({ x: 1330, y: 300 }, view(700, -60));
}
