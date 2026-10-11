import * as Y from "yjs";
import { placeDot, startVote } from "../../shared/dotvotes.ts";
import { toggleStamp } from "../../shared/facilitation.ts";
import { addShape, nextZ, shapesMap } from "../../shared/shapes.ts";
import { addSection } from "../../shared/structure.ts";
import { addCard } from "../board.ts";
import { cardStore } from "../cardStore.ts";
import { facilitation } from "../facilitation/store.ts";
import type { SimulatedFacilitator } from "./facilitation.ts";
import { LABELS, fixture } from "./fixtures.ts";

// Boards for facilitation (#50), silent mode (#49) and dot voting (#48) on
// /play: `?scenario=retro`, `?scenario=silent` and `?scenario=vote`.

/** Room above for the timer and vote bars, which float at the top of the canvas. */
const TOP = 150;
const LEFT = 40;

export const PRIYA = { name: "Priya Shah", color: "#b4467a", login: "priya" };
export const KAI = { name: "Kai Andersen", color: "#1f7a6b", login: "kai" };
export const TOM = { name: "Tom Okafor", color: "#a35a12", login: "tom" };
export const JO = { name: "Jo Rivera", color: "#5b5fc7" };

function note(
	doc: Y.Doc,
	text: string,
	color: string,
	x: number,
	y: number,
	parent: string | null,
	author: { name: string; color: string },
): string {
	const id = crypto.randomUUID();
	addShape(doc, id, {
		type: "sticky",
		text,
		color,
		author: { name: author.name, color: author.color },
		x: x + LEFT,
		y: y + TOP,
		z: nextZ(doc),
		parent,
	});
	return id;
}

/** Cards people reacted to on GitHub: their 👍 can count as votes. */
export const VOTE_CARDS = [
	fixture({
		item: "#512",
		title: "Responsive art direction with <picture>",
		labels: [LABELS.enhancement],
		thumbsUp: { count: 14, logins: ["priya", "sam", "lee", "ana"] },
		reactions: 16,
	}),
	fixture({
		item: "#498",
		title: "An emdash image plugin",
		labels: [LABELS.enhancement],
		thumbsUp: { count: 6, logins: ["kai", "dev"] },
		reactions: 6,
	}),
	fixture({
		item: "#477",
		title: "Blurhash placeholders",
		labels: [LABELS.enhancement, LABELS.goodFirst],
		thumbsUp: { count: 2, logins: ["tom", "zed"] },
		reactions: 3,
	}),
];

/** A retro: three columns of stickies, a few cards, and stamps already on some. */
export function seedRetro(doc: Y.Doc): void {
	for (const card of VOTE_CARDS) cardStore.set(card);
	doc.transact(() => {
		const went = addSection(
			doc,
			{ x: 0 + LEFT, y: TOP, w: 600, h: 520 },
			{ title: "Went well", color: "green" },
		);
		const improve = addSection(
			doc,
			{ x: 640 + LEFT, y: TOP, w: 600, h: 520 },
			{ title: "To improve", color: "red" },
		);
		addSection(
			doc,
			{ x: 1280 + LEFT, y: TOP, w: 640, h: 520 },
			{ title: "Ideas", color: "yellow" },
		);
		const a = note(doc, "The 5.0 beta landed on time", "green", 30, 60, went, PRIYA);
		note(doc, "Reviews were fast this month", "green", 220, 70, went, KAI);
		note(doc, "Docs site redesign 🎉", "green", 40, 270, went, TOM);
		const b = note(doc, "CI is flaky on Windows", "pink", 670, 60, improve, JO);
		note(doc, "Too many open PRs waiting on one reviewer", "pink", 860, 70, improve, PRIYA);
		note(doc, "Release notes still thin", "pink", 680, 270, improve, KAI);
		VOTE_CARDS.forEach((card, i) => {
			addCard(doc, card.key, {
				x: LEFT + 1310 + (i % 2) * 300,
				y: TOP + 60 + Math.floor(i / 2) * 200,
			});
		});
		toggleStamp(doc, a, "🎉", PRIYA);
		toggleStamp(doc, a, "🎉", KAI);
		toggleStamp(doc, a, "❤️", TOM);
		toggleStamp(doc, b, "➕", PRIYA);
		toggleStamp(doc, b, "➕", KAI);
		toggleStamp(doc, b, "👀", JO);
	});
}

/**
 * Silent mode under way: a section in silent mode (started by Priya, who's
 * stepped out), with others' stickies face down and two of yours.
 */
export function seedSilent(doc: Y.Doc): void {
	doc.transact(() => {
		addSection(doc, { x: 0 + LEFT, y: TOP, w: 820, h: 560 }, { title: "What hurts", color: "red" });
		addSection(
			doc,
			{ x: 880 + LEFT, y: TOP, w: 440, h: 560 },
			{ title: "Parking lot", color: "grey" },
		);
	});
}

export function facilitateSilent(f: SimulatedFacilitator): void {
	const doc = f.sim.doc;
	const section = [...shapesMap(doc).entries()].find(
		([, s]) => s.get("title") === "What hurts",
	)?.[0];
	if (!section) return;
	const priya = { id: "priya", author: "person:Priya Shah", canEdit: true, owner: false };
	f.hub.start(priya, section, PRIYA);
	const session = (shapesMap(doc).get(section)?.get("silent") as { id: string } | undefined)?.id;
	if (!session) return;
	const hidden: [typeof PRIYA | typeof KAI | typeof TOM, string][] = [
		[PRIYA, "Flaky tests make me rerun CI three times a day"],
		[PRIYA, "Nobody owns the Shopify provider"],
		[KAI, "The release checklist lives in someone’s head"],
		[KAI, "Hard to find which issues are good first issues"],
		[KAI, "Benchmarks drift and nobody notices"],
		[TOM, "Types are slow in big projects"],
	];
	hidden.forEach(([who, text], i) => {
		const id = crypto.randomUUID();
		doc.transact(() => {
			addShape(doc, id, {
				type: "sticky",
				color: "pink",
				author: { name: who.name, color: who.color },
				x: LEFT + 30 + (i % 4) * 196,
				y: TOP + 60 + Math.floor(i / 4) * 196,
				z: nextZ(doc),
				parent: section,
				silent: session,
			});
		});
		f.hub.text(
			{ id: who.name, author: `person:${who.name}`, canEdit: true, owner: false },
			id,
			text,
		);
	});
	// Two of your own, which only you can read.
	["Docs search finds the wrong page", "I never know when to cut a release"].forEach((text, i) => {
		const id = crypto.randomUUID();
		doc.transact(() => {
			addShape(doc, id, {
				type: "sticky",
				color: "yellow",
				author: { name: "You", color: "#3b4cca" },
				x: LEFT + 30 + ((i + 2) % 4) * 196,
				y: TOP + 256,
				z: nextZ(doc),
				parent: section,
				silent: session,
			});
		});
		facilitation.claim(id, text);
	});
}

/** Dot voting under way: an open vote on a section that ends in two days, and a closed one. */
export function seedVote(doc: Y.Doc): void {
	for (const card of VOTE_CARDS) cardStore.set(card);
	const now = Date.now();
	doc.transact(() => {
		const next = addSection(
			doc,
			{ x: 0 + LEFT, y: TOP, w: 960, h: 560 },
			{ title: "Next quarter", color: "blue" },
		);
		const names = addSection(
			doc,
			{ x: 1000 + LEFT, y: TOP, w: 440, h: 560 },
			{ title: "Release name", color: "purple" },
		);
		const cards = VOTE_CARDS.map((card, i) =>
			addCard(doc, card.key, { x: LEFT + 30 + (i % 3) * 300, y: TOP + 60 }),
		);
		const s1 = note(doc, "Fewer options, better defaults", "yellow", 30, 260, next, PRIYA);
		const s2 = note(doc, "A provider playground", "yellow", 230, 260, next, KAI);
		const s3 = note(doc, "Write the migration guide first", "yellow", 430, 260, next, TOM);
		const n1 = note(doc, "Pixel", "purple", 1030, 60, names, JO);
		const n2 = note(doc, "Aperture", "purple", 1230, 60, names, PRIYA);
		note(doc, "Lumen", "purple", 1030, 260, names, KAI);
		for (const id of cards) shapesMap(doc).get(id)?.set("parent", next);

		const open = startVote(doc, {
			scope: next,
			dots: 3,
			reactions: true,
			endsAt: new Date(now + 2 * 86_400_000 + 4 * 3_600_000).toISOString(),
			by: PRIYA,
		});
		const [c1, c2] = cards;
		if (c1 && c2) {
			placeDot(doc, open, PRIYA, c1);
			placeDot(doc, open, PRIYA, c1);
			placeDot(doc, open, PRIYA, s1);
			placeDot(doc, open, KAI, c2);
			placeDot(doc, open, KAI, s2);
			placeDot(doc, open, TOM, s3);
			placeDot(doc, open, TOM, s3);
			placeDot(doc, open, TOM, c1);
		}
		const closed = startVote(doc, { scope: names, dots: 1, hidden: true, by: KAI });
		placeDot(doc, closed, PRIYA, n1);
		placeDot(doc, closed, KAI, n2);
		placeDot(doc, closed, TOM, n1);
		placeDot(doc, closed, JO, n1);
		const vote = doc.getMap("dotVotes").get(closed);
		if (vote instanceof Y.Map) {
			vote.set("closedAt", new Date(now - 3_600_000).toISOString());
			vote.set("closedBy", { name: KAI.name, color: KAI.color });
		}
	});
}
