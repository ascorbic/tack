// Stickies to issues: six ideas boxed with a marquee, "Make 6 issues",
// staged, pushed, and each sticky landing as its issue's card. The camera
// leans in on the bar's button and the panel, then on one sticky as it
// turns into a card.

import type { Page } from "@playwright/test";
import { type Keyframe, WIDE, around, closeOn } from "./camera.ts";
import type { Recorder, Recording } from "./capture.ts";
import type { Clip } from "./clip.ts";

const NOTES: { text: string; color: string; author: string }[] = [
	{ text: "Blurhash placeholders for every provider", color: "yellow", author: "priya" },
	{ text: "A provider playground", color: "pink", author: "kai" },
	{ text: "Codemods for 5.0", color: "blue", author: "tom" },
	{ text: "Detect the CDN from custom domains", color: "green", author: "kai" },
	{ text: "One docs page per provider", color: "purple", author: "priya" },
	{ text: "Benchmarks in CI", color: "yellow", author: "tom" },
];

type AppImport = <T>(path: string) => Promise<T>;
type Shapes = typeof import("../../../src/shared/shapes.ts");
type Provenance = typeof import("../../../src/shared/provenance.ts");
type Fixtures = typeof import("../../../src/client/play/fixtures.ts");
type Push = typeof import("../../../src/client/play/push.ts");

/** The sticky the camera watches turn into a card: one that lands after the push sheet's closed. */
const HERO = "One docs page per provider";

async function seed(page: Page): Promise<void> {
	await page.evaluate(async (notes) => {
		const { tackPlayground, tackCards, tackPush, clipImport } = window as unknown as {
			tackPlayground: { doc: import("yjs").Doc };
			tackCards: { set(card: unknown): void };
			tackPush: { pace: number };
			clipImport: AppImport;
		};
		const { addShape, nextZ } = await clipImport<Shapes>("/src/shared/shapes.ts");
		const { addCardShape } = await clipImport<Provenance>("/src/shared/provenance.ts");
		const { fixture, LABELS } = await clipImport<Fixtures>("/src/client/play/fixtures.ts");
		const { numberFrom } = await clipImport<Push>("/src/client/play/push.ts");
		const doc = tackPlayground.doc;
		const people: Record<string, { name: string; color: string }> = {
			priya: { name: "Priya Shah", color: "#b4467a" },
			kai: { name: "Kai Andersen", color: "#1f7a6b" },
			tom: { name: "Tom Okafor", color: "#a35a12" },
		};
		// The pretend forge answers a little faster than GitHub would, so the clip stays short.
		tackPush.pace = 0.6;
		numberFrom(431);
		const existing = [
			fixture({
				repo: "ascorbic/unpic",
				item: "#428",
				title: "Responsive images for the Astro component",
				labels: [LABELS.enhancement],
				comments: 5,
				reactions: 9,
			}),
			fixture({
				repo: "ascorbic/unpic",
				item: "#429",
				title: "CDN detection misses preview deploy URLs",
				labels: [LABELS.bug],
				comments: 3,
				reactions: 2,
			}),
		];
		for (const card of existing) tackCards.set(card);
		doc.transact(() => {
			addShape(doc, "clip-title", {
				type: "text",
				text: "unpic 5.0 ideas",
				size: "l",
				x: 0,
				y: -86,
				z: nextZ(doc),
			});
			notes.forEach((note, i) => {
				addShape(doc, `clip-sticky-${i}`, {
					type: "sticky",
					text: note.text,
					color: note.color,
					author: people[note.author],
					x: (i % 3) * 206 + ((i * 37) % 9) - 4,
					y: Math.floor(i / 3) * 206 + ((i * 53) % 9) - 4,
					z: nextZ(doc),
				});
			});
			existing.forEach((card, i) =>
				addCardShape(doc, `clip-card-${i}`, { ref: card.key, x: 680, y: i * 150 }),
			);
		});
	}, NOTES);
}

async function play(rec: Recorder): Promise<void> {
	const { page } = rec;
	const stickies = page.locator(".react-flow__node-sticky");
	const first = await rec.box("first", stickies.first());
	const last = await rec.box("last", stickies.last());
	// Resting in the space under the stickies, at the start and the end.
	const home = { x: first.x + 60, y: last.y + last.h + 80 };
	await rec.place(home);
	await rec.wait(0.5);

	// Box the six stickies.
	await rec.moveTo({ x: first.x - 24, y: first.y - 20 }, 0.6);
	await rec.drag({ x: last.x + last.w + 16, y: last.y + last.h + 16 }, 0.8);
	const make = page.getByRole("button", { name: "Make issues from stickies" });
	await rec.until(make);
	rec.mark("selected");
	await rec.wait(0.25);
	await rec.box("make", make);

	// Make 6 issues: the panel, then stage them.
	await rec.moveTo(await rec.centre(make, { x: -14 }), 0.55);
	rec.mark("make");
	await rec.click();
	const panel = page.getByRole("dialog", { name: "Make issues from stickies" });
	const stage = panel.getByRole("button", { name: /^Stage \d+ issues/ });
	await rec.until(stage);
	await rec.wait(0.45);
	await rec.box("panel", panel);
	await rec.moveTo(await rec.centre(stage, { x: -10 }), 0.5);
	await rec.click();
	rec.mark("staged");
	await page.keyboard.press("Escape");
	await rec.wait(0.45);

	// Pushed from Changes: review, push, and close the sheet while it carries on.
	const changes = page.getByRole("button", { name: /^Changes/ });
	await rec.moveTo(await rec.centre(changes, { x: -6 }), 0.8);
	await rec.click();
	const review = page.getByRole("button", { name: /^Review and push/ });
	await rec.until(review);
	await rec.wait(0.15);
	await rec.moveTo(await rec.centre(review), 0.4);
	await rec.click();
	const push = page.getByRole("button", { name: /^Push \d+ changes/ });
	await rec.until(push);
	await rec.wait(0.3);
	await rec.moveTo(await rec.centre(push, { x: -16 }), 0.45);
	await rec.click();
	rec.mark("pushed");
	// The footer's Close, not the corner's ×.
	const close = page
		.getByRole("button", { name: "Close", exact: true })
		.filter({ hasText: "Close" });
	await rec.until(close);
	await rec.wait(0.2);
	await rec.moveTo(await rec.centre(close), 0.4);
	await rec.click();
	rec.mark("closed");
	// And the changes panel, which follows along, out of the way (Escape, once
	// the sheet's gone and its focus is back in the panel).
	await rec.wait(0.2);
	await page.keyboard.press("Escape");

	// The stickies land as cards, one by one, while the pointer drifts back to where it started.
	await rec.moveTo(home, 1.2);
	const hero = page.locator(".react-flow__node-card", { hasText: HERO });
	await rec.until(hero);
	rec.mark("hero");
	const cards = page.locator(".react-flow__node-card");
	while ((await cards.count()) < 2 + NOTES.length) await rec.tick();
	await rec.wait(0.3);
	await rec.box("hero", hero);
	rec.mark("end");
	// The camera's back out by 0.8s, before the last 0.6s dissolve into the first frame.
	await rec.wait(1.5);
}

/** Lean in on the bar's button and the panel, back out for the push, then in on one card as it lands. */
function camera({ marks, boxes }: Recording): Keyframe[] {
	const m = (name: string) => marks[name] ?? 0;
	const panel = around([boxes.make!, boxes.panel!], { margin: 24 });
	// The new card a little below the middle, leaving the toast for the staging under the frame.
	const hero = boxes.hero!;
	const landing = closeOn({ x: hero.x + hero.w / 2, y: hero.y + hero.h / 2 - 60 }, 1.8);
	return [
		{ t: 0, ...WIDE },
		{ t: m("selected"), ...WIDE },
		{ t: m("make"), ...closeOn(boxes.make!, 2) },
		{ t: m("make") + 0.6, ...panel },
		{ t: m("staged") + 0.15, ...panel },
		{ t: m("staged") + 1, ...WIDE },
		{ t: m("closed"), ...WIDE },
		{ t: Math.max(m("hero") - 0.2, m("closed") + 0.8), ...landing },
		{ t: m("end"), ...landing },
		{ t: m("end") + 0.8, ...WIDE },
	];
}

export const clip: Clip = {
	name: "stickies-to-issues",
	setup: {
		url: "/play?scenario=empty",
		title: "unpic 5.0 planning",
		you: { name: "Jo Rivera", color: "#5b5fc7" },
		retext: [[/the test forge/gi, "GitHub"]],
	},
	seed,
	play,
	camera,
};
