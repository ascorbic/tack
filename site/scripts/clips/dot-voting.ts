// Dot voting: a vote on what's next for unpic is already under way, with
// the dot tool on. The camera starts on the section and comes in close on
// the cards, and Kai, Priya and Tom (other people's pointers, with their
// names) and then you put dots on them, a calm beat apart, each landing in
// the card's corner, everyone stepping off the cards after. Then Priya,
// who's running it, closes the vote, and, still close, every card that got
// dots wears its place and its dots.
//
// The vote's started before recording (as the "vote" scenario's is, with
// the shared dotvotes.ts), so there's no dialog; its results panel, which
// opens by itself when a vote closes, stays out of sight.

import type { Page } from "@playwright/test";
import { type Keyframe, around } from "./camera.ts";
import type { Box, Recorder, Recording } from "./capture.ts";
import type { Clip } from "./clip.ts";
import type { Point, Pointer } from "./cursor.ts";
import { Crowd } from "./others.ts";

type AppImport = <T>(path: string) => Promise<T>;
type Shapes = typeof import("../../../src/shared/shapes.ts");
type Provenance = typeof import("../../../src/shared/provenance.ts");
type Structure = typeof import("../../../src/shared/structure.ts");
type DotVotes = typeof import("../../../src/shared/dotvotes.ts");
type Scenarios = typeof import("../../../src/client/play/facilitationScenarios.ts");

const PEOPLE = {
	priya: { name: "Priya Shah", color: "#b4467a" },
	kai: { name: "Kai Andersen", color: "#1f7a6b" },
	tom: { name: "Tom Okafor", color: "#a35a12" },
} as const;
type Who = keyof typeof PEOPLE;

/**
 * What's being voted on, in order on the board: the vote scenario's three
 * cards (fixtures for unpic), then two stickies. Ids are the clip's own.
 */
const ITEMS = ["card-0", "card-1", "card-2", "sticky-0", "sticky-1"] as const;
type Item = (typeof ITEMS)[number];

/**
 * Dots already on the board when the clip starts. With the clip's, everyone
 * spends their three, and the totals come out 4, 3, 2 and 1: four places.
 */
const BEFORE: [Who, Item][] = [
	["priya", "card-0"],
	["priya", "card-1"],
	["tom", "card-1"],
	["tom", "sticky-0"],
	["kai", "sticky-0"],
];

async function seed(page: Page): Promise<void> {
	await page.evaluate(
		async ({ people, before }) => {
			const { tackPlayground, tackCards, clipImport } = window as unknown as {
				tackPlayground: { doc: import("yjs").Doc };
				tackCards: { set(card: unknown): void };
				clipImport: AppImport;
			};
			const { addShape, nextZ, shapesMap } = await clipImport<Shapes>("/src/shared/shapes.ts");
			const { addCardShape } = await clipImport<Provenance>("/src/shared/provenance.ts");
			const { addSection } = await clipImport<Structure>("/src/shared/structure.ts");
			const { startVote, placeDot } = await clipImport<DotVotes>("/src/shared/dotvotes.ts");
			const { VOTE_CARDS } = await clipImport<Scenarios>(
				"/src/client/play/facilitationScenarios.ts",
			);
			const doc = tackPlayground.doc;
			for (const card of VOTE_CARDS) tackCards.set(card);
			doc.transact(() => {
				// Something above the section, so fitting the board leaves room
				// there for the vote's bar, which floats over the top of the canvas
				// (a desktop fit doesn't keep clear of it). Gone before recording.
				addShape(doc, "clip-spacer", {
					type: "text",
					text: "Dot voting",
					size: "l",
					x: 0,
					y: -150,
					z: nextZ(doc),
				});
				const section = addSection(
					doc,
					{ x: 0, y: 0, w: 560, h: 580 },
					{ title: "Dot voting", color: "blue" },
				);
				VOTE_CARDS.forEach((card, i) => {
					addCardShape(doc, `clip-card-${i}`, { ref: card.key, x: 30, y: 64 + i * 164 });
				});
				const notes: [string, string, { name: string; color: string }][] = [
					["Fewer options, better defaults", "yellow", people.priya],
					["Write the migration guide first", "green", people.tom],
				];
				notes.forEach(([text, color, author], i) => {
					addShape(doc, `clip-sticky-${i}`, {
						type: "sticky",
						text,
						color,
						author,
						x: 334,
						y: 74 + i * 214,
						z: nextZ(doc),
					});
				});
				for (const id of [0, 1, 2].map((i) => `clip-card-${i}`))
					shapesMap(doc).get(id)?.set("parent", section);
				for (const id of [0, 1].map((i) => `clip-sticky-${i}`))
					shapesMap(doc).get(id)?.set("parent", section);
				const vote = startVote(doc, {
					scope: section,
					dots: 3,
					reactions: false,
					by: people.priya,
				});
				for (const [who, item] of before)
					placeDot(doc, vote, people[who as keyof typeof people], `clip-${item}`);
				Object.assign(window, { clipVote: vote });
			});
		},
		{ people: PEOPLE, before: BEFORE },
	);
	// The dot tool on, as if you'd chosen Place dots a moment ago.
	await page.getByRole("button", { name: "Place dots" }).click();
	// And the mouse and focus away from it, so it doesn't look hovered.
	await page.mouse.move(900, 900);
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** A dot from someone else, as their own board would put it. */
function dot(page: Page, who: Who, item: Item): Promise<void> {
	return page.evaluate(
		async ({ person, id }) => {
			const { tackPlayground, clipImport, clipVote } = window as unknown as {
				tackPlayground: { doc: import("yjs").Doc };
				clipImport: AppImport;
				clipVote: string;
			};
			const { placeDot } = await clipImport<DotVotes>("/src/shared/dotvotes.ts");
			const doc = tackPlayground.doc;
			doc.transact(() => placeDot(doc, clipVote, person, id));
		},
		{ person: PEOPLE[who], id: `clip-${item}` },
	);
}

async function play(rec: Recorder): Promise<void> {
	const { page } = rec;
	// No results panel, and no tool dock or its hint peeking in at the foot of the frame.
	await page.addStyleTag({
		content: `.tally-panel, .toolbar-dock { visibility: hidden !important; }`,
	});
	await page.evaluate(async () => {
		const { tackPlayground } = window as unknown as { tackPlayground: { doc: import("yjs").Doc } };
		tackPlayground.doc.getMap("shapes").delete("clip-spacer");
		// Let React draw the board without it before the first frame.
		for (let i = 0; i < 3; i++) {
			await new Promise<void>((resolve) => {
				const channel = new MessageChannel();
				channel.port1.onmessage = () => resolve();
				channel.port2.postMessage(null);
			});
		}
	});
	const box = (item: Item) =>
		rec.box(item, page.locator(`.react-flow__node[data-id="clip-${item}"]`));
	const items = Object.fromEntries(
		await Promise.all(ITEMS.map(async (item) => [item, await box(item)] as const)),
	) as Record<Item, Box>;
	await rec.box("section", page.locator(".react-flow__node-section").first());
	await rec.box("header", page.locator(".section-header").first());
	// Where a pointer goes to dot something: a little in from its top right, where the dots land.
	const on = (item: Item, dx = 0, dy = 0): Point => ({
		x: items[item].x + items[item].w * 0.62 + dx,
		y: items[item].y + items[item].h * 0.38 + dy,
	});

	// Resting below the cards and stickies, where their names cover nothing: Kai under the
	// last card, Tom and Priya under the last sticky, you to Kai's left.
	const c0 = items["card-0"];
	const c2 = items["card-2"];
	const s1 = items["sticky-1"];
	const crowd = new Crowd(rec);
	// By first name: shorter labels, which fit the gaps between things.
	const person = (who: Who, at: Point) =>
		crowd.join(PEOPLE[who].name.split(" ")[0]!, PEOPLE[who].color, at);
	const park: Record<Who, Point> = {
		kai: { x: c2.x + c2.w * 0.62, y: c2.y + c2.h + 5 },
		tom: { x: s1.x + 18, y: s1.y + s1.h + 8 },
		priya: { x: s1.x + 108, y: s1.y + s1.h + 26 },
	};
	const priya = person("priya", park.priya);
	const kai = person("kai", park.kai);
	const tom = person("tom", park.tom);
	const rest = { x: c2.x + c2.w * 0.18, y: c2.y + c2.h + 14 };
	await rec.place(rest);
	/** Frames go by, with everyone on the move carrying on, until `time`. */
	const until = (time: number) => crowd.wait(Math.max(0, time - rec.t));
	const vote = (who: Pointer, name: Who, item: Item) =>
		crowd.click(who, () => dot(page, name, item));

	// The board, still, as everyone's pointers fade in; then the camera's in
	// close from 1.2s to 2.4s, and a dot lands every 0.8s or so from 3.4s,
	// yours last at 6.9s.
	await rec.appear();
	await until(1.2);
	rec.mark("in");
	await until(1.85);
	crowd.move(kai, on("card-0"), { seconds: 1.1 });
	await until(2.7);
	crowd.move(priya, on("sticky-0", 10), { seconds: 1.1 });
	await until(3.3);
	await vote(kai, "kai", "card-0");
	// Into the gap beside the card, his name between it and the sticky.
	crowd.move(kai, { x: c0.x + c0.w + 6, y: c0.y + c0.h - 2 }, { seconds: 0.8 });
	await until(3.55);
	crowd.move(tom, on("card-0", -40, 22), { seconds: 1.1 });
	await until(4.15);
	await vote(priya, "priya", "sticky-0");
	crowd.move(priya, park.priya, { seconds: 1.1 });
	await until(4.65);
	crowd.move(kai, on("card-0", 20, 14), { seconds: 0.8 });
	await until(4.9);
	await vote(tom, "tom", "card-0");
	crowd.move(tom, park.tom, { seconds: 1.1 });
	await until(5.3);
	// You: across to Blurhash placeholders while Kai goes back for another.
	const target = on("card-2", -30, 10);
	// Only the drawn pointer moves: the real mouse joins it for the click, so
	// nothing on the way lights up, and leaves straight after.
	crowd.move(rec.pointer, target, { seconds: 1.1 });
	await until(5.7);
	await vote(kai, "kai", "card-0");
	crowd.move(kai, park.kai, { seconds: 0.9 });
	// Everyone else is still by the time you click, as the recorder's click holds them.
	await until(6.8);
	await page.mouse.move(target.x, target.y);
	await rec.click();
	await page.mouse.move(rest.x, rest.y);
	// And back off the card.
	await crowd.moveTo(rec.pointer, rest, { seconds: 0.8 });
	// Every dot in: a beat to take them in, quite still.
	await crowd.wait(1.8);
	// Priya closes the vote, from her board: places and dots on every card.
	rec.mark("closed");
	await page.evaluate(async (by) => {
		const { tackPlayground, clipImport, clipVote } = window as unknown as {
			tackPlayground: { doc: import("yjs").Doc };
			clipImport: AppImport;
			clipVote: string;
		};
		const { closeVote } = await clipImport<DotVotes>("/src/shared/dotvotes.ts");
		const doc = tackPlayground.doc;
		doc.transact(() => closeVote(doc, clipVote, by, new Date().toISOString()));
	}, PEOPLE.priya);
	await rec.wait(0.4 + 1.9);
	// The fade back to the start, without the pointers.
	await rec.vanish();
	await rec.wait(0.9);
}

/**
 * The section, header and all; then in close on the cards for the dots,
 * staying there for their places: room above them for the dots and the
 * place badges on their top edges, and below for everyone's pointers.
 */
function camera({ marks, boxes }: Recording): Keyframe[] {
	const m = (name: string) => marks[name] ?? 0;
	const items = ITEMS.map((item) => boxes[item]!);
	const section = around([boxes.section!, boxes.header!], { margin: 24 });
	const left = Math.min(...items.map((b) => b.x)) - 18;
	const right = Math.max(...items.map((b) => b.x + b.w)) + 18;
	const top = Math.min(...items.map((b) => b.y)) - 26;
	const w = Math.max(right - left, Math.max(...items.map((b) => b.y + b.h)) + 56 - top);
	const close = { x: (left + right) / 2 - w / 2, y: top, w };
	return [
		{ t: 0, ...section },
		{ t: m("in"), ...section },
		{ t: m("in") + 1.2, ...close },
	];
}

export const clip: Clip = {
	name: "dot-voting",
	setup: {
		url: "/play?scenario=empty",
		title: "Dot voting",
		you: { name: "Jo Rivera", color: "#5b5fc7" },
	},
	seed,
	play,
	camera,
	fade: 0.9,
};
