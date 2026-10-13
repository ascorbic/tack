// Multiplayer: three people on a small cirrus board, one thing each, in
// turn. Ana drags a card into place, Ben writes a sticky, and Cleo draws
// an arrow from one card to another, which snaps onto it. They're real
// people to the board (the playground's simulated presence: their drags,
// typing and connector are what anyone else would see), with the clip's
// own named pointers in place of the board's cursors so they move on the
// frame clock. The camera leans in for Ana and Ben, then back out for
// Cleo and the end, with all three's work in view.

import type { Page } from "@playwright/test";
import { type Keyframe, around } from "./camera.ts";
import type { Box, Recorder, Recording } from "./capture.ts";
import type { Clip } from "./clip.ts";
import type { Point } from "./cursor.ts";
import { Crowd, boardToPage } from "./others.ts";

type AppImport = <T>(path: string) => Promise<T>;
type Shapes = typeof import("../../../src/shared/shapes.ts");
type Provenance = typeof import("../../../src/shared/provenance.ts");
type Fixtures = typeof import("../../../src/client/play/fixtures.ts");
type BoardHelpers = typeof import("../../../src/client/board.ts");
type Structure = typeof import("../../../src/shared/structure.ts");
type Connectors = typeof import("../../../src/shared/connectors.ts");
type Sim = import("../../../src/client/play/simulator.ts").SimulatedBoard;
type Person = import("../../../src/client/play/simulator.ts").RemotePerson;

const PEOPLE = {
	ana: { name: "Ana Ruiz", color: "#c2410c" },
	ben: { name: "Ben Adeyemi", color: "#2563eb" },
	cleo: { name: "Cleo Park", color: "#0f766e" },
} as const;
type Who = keyof typeof PEOPLE;

/** Where things are on the board. */
const AT = {
	queue: { x: 0, y: 0 },
	retry: { x: 0, y: 240 },
	plan: { x: 300, y: 0 },
	/** Ana's card, off to one side, and where she puts it. */
	banner: { x: 580, y: 190 },
	bannerTo: { x: 300, y: 240 },
	/** Ben's sticky. */
	sticky: { x: 300, y: 400 },
};

const BEN_WRITES = "Needs a design pass";

/** Everyone's handles in the page, for the clip to drive. */
interface Handles {
	tackPlayground: Sim;
	clipPeople: Record<Who, Person>;
	clipIds: Record<"queue" | "retry" | "banner" | "plan", string>;
	clipImport: AppImport;
}

async function seed(page: Page): Promise<void> {
	await page.evaluate(
		async ({ at, people }) => {
			const w = window as unknown as Handles & {
				tackCards: { set(card: unknown): void };
			};
			const { addShape, nextZ } = await w.clipImport<Shapes>("/src/shared/shapes.ts");
			const { addCardShape } = await w.clipImport<Provenance>("/src/shared/provenance.ts");
			const { fixture, LABELS } = await w.clipImport<Fixtures>("/src/client/play/fixtures.ts");
			const doc = w.tackPlayground.doc;
			const repo = "ascorbic/cirrus";
			const cards = {
				queue: fixture({
					repo,
					item: "#118",
					title: "Queue posts while offline",
					labels: [LABELS.enhancement],
					comments: 4,
					reactions: 7,
				}),
				retry: fixture({
					repo,
					item: "#121",
					title: "Retry failed image uploads",
					labels: [LABELS.bug],
					comments: 2,
					reactions: 3,
				}),
				banner: fixture({
					repo,
					item: "#124",
					title: "Warn when a draft changes on two devices",
					labels: [LABELS.enhancement],
					comments: 1,
				}),
			};
			for (const card of Object.values(cards)) w.tackCards.set(card);
			const ids = {
				queue: "clip-queue",
				retry: "clip-retry",
				banner: "clip-banner",
				plan: "clip-plan",
			};
			doc.transact(() => {
				addCardShape(doc, ids.queue, { ref: cards.queue.key, ...at.queue });
				addCardShape(doc, ids.retry, { ref: cards.retry.key, ...at.retry });
				addCardShape(doc, ids.banner, { ref: cards.banner.key, ...at.banner });
				addShape(doc, ids.plan, {
					type: "sticky",
					text: "0.4 is the offline release",
					color: "yellow",
					author: people.cleo,
					...at.plan,
					z: nextZ(doc),
				});
			});
			const joined = Object.fromEntries(
				Object.entries(people).map(([who, user]) => [who, w.tackPlayground.join({ ...user })]),
			);
			Object.assign(window, { clipPeople: joined, clipIds: ids });
		},
		{ at: AT, people: PEOPLE },
	);
	// The clip draws everyone's pointers itself, on its own clock; and the wide shot is the board,
	// without the tool dock and zoom buttons peeking in at its foot.
	await page.addStyleTag({
		content: `.cursors-layer, .toasts, .toolbar[aria-label="Tools"], [aria-label="Zoom"] {
			visibility: hidden !important;
		}`,
	});
	await page.clock.runFor(2000);
}

/** Someone's presence, as the board hears it: what they're dragging or drawing. */
function present(page: Page, who: Who, state: Record<string, unknown>): Promise<void> {
	return page.evaluate(
		({ who, state }) => {
			const person = (window as unknown as Handles).clipPeople[who as Who];
			person.awareness.setLocalState({ ...person.awareness.getLocalState(), ...state });
		},
		{ who, state },
	);
}

async function play(rec: Recorder): Promise<void> {
	const { page } = rec;
	const crowd = new Crowd(rec);
	const toPage = await boardToPage(page);
	const one = toPage({ x: 1, y: 0 });
	const origin = toPage({ x: 0, y: 0 });
	const zoom = one.x - origin.x;
	const toBoard = (p: Point) => ({ x: (p.x - origin.x) / zoom, y: (p.y - origin.y) / zoom });
	const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
	const ids = await page.evaluate(() => (window as unknown as Handles).clipIds);

	const queue = await rec.box("queue", node(ids.queue));
	const retry = await rec.box("retry", node(ids.retry));
	await rec.box("plan", node(ids.plan));
	const banner = await rec.box("banner", node(ids.banner));
	const size = (b: Box) => ({ w: b.w / zoom, h: b.h / zoom });
	// Where Ana's card and Ben's sticky will be, for the camera.
	const bannerTo = toPage(AT.bannerTo);
	rec.boxes.bannerTo = { ...bannerTo, w: banner.w, h: banner.h };
	const sticky = toPage(AT.sticky);
	rec.boxes.sticky = { ...sticky, w: 176 * zoom, h: 176 * zoom };

	const ana = crowd.join("Ana", PEOPLE.ana.color, toPage({ x: 760, y: 420 }));
	const ben = crowd.join("Ben", PEOPLE.ben.color, toPage({ x: 580, y: 520 }));
	const cleo = crowd.join("Cleo", PEOPLE.cleo.color, toPage({ x: 70, y: 450 }));

	// The board, still.
	await crowd.wait(1.2);
	rec.mark("lean");

	// Ana takes the loose card and puts it beside the one it belongs with.
	// By its lower right, where her name doesn't cover the title.
	const offset = { x: size(banner).w * 0.8, y: size(banner).h * 0.78 };
	const grab = { x: banner.x + offset.x * zoom, y: banner.y + offset.y * zoom };
	await crowd.moveTo(ana, grab, { seconds: 1 });
	await crowd.wait(0.35);
	await crowd.press(ana);
	const id = ids.banner;
	rec.mark("drag");
	await crowd.moveTo(
		ana,
		{ x: bannerTo.x + offset.x * zoom, y: bannerTo.y + offset.y * zoom },
		{
			seconds: 1.05,
			follow: async (at) => {
				const b = toBoard(at);
				await present(page, "ana", { drags: { [id]: { x: b.x - offset.x, y: b.y - offset.y } } });
			},
		},
	);
	await page.evaluate(
		async ({ id, to }) => {
			const w = window as unknown as Handles;
			const { moveShape } = await w.clipImport<BoardHelpers>("/src/client/board.ts");
			const person = w.clipPeople.ana;
			moveShape(person.doc, id, to);
			person.awareness.setLocalStateField("drags", {});
		},
		{ id, to: AT.bannerTo },
	);
	await crowd.release(ana);
	rec.mark("moved");
	await crowd.wait(1.3);

	// Ben writes a sticky, a letter at a time.
	const corner = toPage({ x: AT.sticky.x + 148, y: AT.sticky.y + 150 });
	await crowd.moveTo(ben, corner, { seconds: 0.95 });
	await crowd.wait(0.3);
	let note = "";
	await crowd.click(ben, async () => {
		note = await page.evaluate(
			async ({ at, user }) => {
				const w = window as unknown as Handles;
				const { addSticky } = await w.clipImport<BoardHelpers>("/src/client/board.ts");
				return addSticky(w.clipPeople.ben.doc, at, { color: "blue", author: user, mine: false });
			},
			// A new sticky is placed by its middle.
			{ at: { x: AT.sticky.x + 88, y: AT.sticky.y + 88 }, user: PEOPLE.ben },
		);
	});
	rec.mark("typing");
	for (let i = 1; i <= BEN_WRITES.length; i++) {
		await page.evaluate(
			async ({ note, text }) => {
				const w = window as unknown as Handles;
				const { shapesMap } = await w.clipImport<Shapes>("/src/shared/shapes.ts");
				shapesMap(w.clipPeople.ben.doc).get(note)?.set("text", text);
			},
			{ note, text: BEN_WRITES.slice(0, i) },
		);
		await crowd.wait(BEN_WRITES[i - 1] === " " ? 0.1 : 0.065);
	}
	rec.mark("typed");
	await crowd.wait(1.3);

	// Cleo draws an arrow from one card to the other, and it snaps on.
	rec.mark("wide");
	const from = { x: queue.x + queue.w / 2, y: queue.y + queue.h / 2 };
	// Ending by the card's lower right, clear of its title; the arrow snaps to its edge.
	const to = { x: retry.x + retry.w * 0.78, y: retry.y + retry.h * 0.8 };
	await crowd.moveTo(cleo, from, { seconds: 1 });
	await crowd.wait(0.3);
	await crowd.press(cleo);
	rec.mark("draw");
	const r = toBoard({ x: retry.x, y: retry.y });
	const rs = size(retry);
	await crowd.moveTo(cleo, to, {
		seconds: 0.95,
		follow: async (at) => {
			const p = toBoard(at);
			const inside = p.x >= r.x && p.x <= r.x + rs.w && p.y >= r.y && p.y <= r.y + rs.h;
			await present(page, "cleo", {
				cursor: p,
				connecting: {
					from: { x: 0, y: 0, shape: ids.queue },
					to: inside ? { ...p, shape: ids.retry } : p,
				},
			});
		},
	});
	await page.evaluate(async () => {
		const w = window as unknown as Handles;
		const { addConnector } = await w.clipImport<Structure>("/src/shared/structure.ts");
		const { withFallbacks } = await w.clipImport<Connectors>("/src/shared/connectors.ts");
		const person = w.clipPeople.cleo;
		const ends = withFallbacks(
			{ x: 0, y: 0, shape: w.clipIds.queue },
			{ x: 0, y: 0, shape: w.clipIds.retry },
			(id) => w.tackPlayground.box(id),
		);
		person.doc.transact(() => addConnector(person.doc, { ...ends, label: "blocks" }));
		person.awareness.setLocalStateField("connecting", null);
	});
	await crowd.release(cleo);
	rec.mark("drawn");
	// All three's work, then dissolve back to the start.
	await crowd.wait(2.9);
}

/** Wide, in on Ana's and Ben's corner, then back out for Cleo's arrow and the end. */
function camera({ marks, boxes }: Recording): Keyframe[] {
	const b = (name: string) => boxes[name]!;
	// The board as it is, short of the page's edge (where the crop would show a seam).
	const wide = around([b("queue"), b("retry"), b("plan"), b("banner")], { margin: 32 });
	const corner = around([b("plan"), b("banner"), b("bannerTo"), b("sticky")], {
		margin: 30,
		max: 3,
	});
	const end = around([b("queue"), b("retry"), b("plan"), b("bannerTo"), b("sticky")], {
		margin: 44,
		max: 3,
	});
	return [
		{ t: 0, ...wide },
		{ t: marks.lean!, ...wide },
		{ t: marks.lean! + 1, ...corner },
		{ t: marks.wide!, ...corner },
		{ t: marks.wide! + 1.05, ...end },
	];
}

export const clip: Clip = {
	name: "multiplayer",
	setup: {
		url: "/play?scenario=empty",
		title: "cirrus 0.4",
		you: { name: "Jo Rivera", color: "#5b5fc7" },
	},
	seed,
	// A step out from the fit, so the wide shot is clear of the top bar and the tool dock.
	framed: (page) => page.keyboard.press("Minus"),
	play,
	camera,
};
