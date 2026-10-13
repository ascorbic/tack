// Auto-stack: eighteen stickies from an unpic 5.0 retro, boxed with a
// marquee, and one click on the bar's Auto-stack. The board numbers each
// sticky with its proposed stack, in that stack's colour, then four named
// stacks spring in where they were (slowed a little through the frame clock,
// so you see them land). The camera leans in on the bar for the click, steps
// back to watch the stacks form, and then comes in close on their names.
//
// The Auto-stack panel itself stays out of sight (its proposal is made as
// it stands, from the clip), so the board is all there is to watch. Names
// come from the playground's stand-in model (src/shared/fakeStackAi.ts),
// which gives each sticky the first theme its words match, and each stack
// goes where its first sticky in reading order was: so each row-and-column
// below is placed for four stacks in a square, and the words chosen to
// match only their own theme.

import type { Page } from "@playwright/test";
import { type Keyframe, WIDE, around, closeOn } from "./camera.ts";
import type { Recorder, Recording } from "./capture.ts";
import type { Clip } from "./clip.ts";
import type { Point } from "./cursor.ts";
import { Crowd } from "./others.ts";

type Note = { text: string; color: string; author: string };

/** What people wrote, by where it is: five columns, four rows, a little scattered. */
const GRID: (Note | null)[][] = [
	[
		{ text: "A logo?", color: "blue", author: "tom" },
		{ text: "Provider docs are hard to find", color: "yellow", author: "priya" },
		{ text: "CI takes 25 minutes on a good day", color: "pink", author: "kai" },
		{ text: "No example for a custom transformer", color: "green", author: "tom" },
		{ text: "Flaky e2e on Windows", color: "yellow", author: "jo" },
	],
	[
		{ text: "Can't rerun one job", color: "green", author: "priya" },
		{ text: "Release notes are thin", color: "blue", author: "jo" },
		{ text: "Srcset generation is slow on big sites", color: "pink", author: "tom" },
		{ text: "Changelog skips breaking changes", color: "yellow", author: "kai" },
		{ text: "The README is out of date", color: "pink", author: "jo" },
	],
	[
		{ text: "Faster cold starts at the edge", color: "yellow", author: "kai" },
		{ text: "Breaking changes snuck into a minor version", color: "green", author: "priya" },
		{ text: "A migration guide for 4.x users", color: "blue", author: "kai" },
		{ text: "Snapshot tests break on every bump", color: "blue", author: "tom" },
		{ text: "Perf budget for the Astro component", color: "green", author: "priya" },
	],
	[
		null,
		{ text: "Which version added AVIF?", color: "pink", author: "priya" },
		{ text: "Dev server feels slow with 500 images", color: "yellow", author: "jo" },
		null,
		{ text: "Stickers for the conference!", color: "blue", author: "kai" },
	],
];

const PITCH = 226;

type AppImport = <T>(path: string) => Promise<T>;
type Shapes = typeof import("../../../src/shared/shapes.ts");

async function seed(page: Page): Promise<void> {
	await page.evaluate(
		async ({ grid, pitch }) => {
			const { tackPlayground, clipImport } = window as unknown as {
				tackPlayground: { doc: import("yjs").Doc };
				clipImport: AppImport;
			};
			const { addShape, nextZ } = await clipImport<Shapes>("/src/shared/shapes.ts");
			const doc = tackPlayground.doc;
			const people: Record<string, { name: string; color: string }> = {
				priya: { name: "Priya Shah", color: "#b4467a" },
				kai: { name: "Kai Andersen", color: "#1f7a6b" },
				tom: { name: "Tom Okafor", color: "#a35a12" },
				jo: { name: "Jo Rivera", color: "#5b5fc7" },
			};
			doc.transact(() => {
				addShape(doc, "clip-title", {
					type: "text",
					text: "Auto-stack",
					size: "l",
					x: 0,
					y: -96,
					z: nextZ(doc),
				});
				grid.forEach((row, r) =>
					row.forEach((note, c) => {
						if (!note) return;
						const i = r * 5 + c;
						addShape(doc, `clip-sticky-${i}`, {
							type: "sticky",
							text: note.text,
							color: note.color,
							author: people[note.author],
							// Scattered, as stickies are after everyone's had a go, but in rows.
							x: c * pitch + ((i * 37) % 27) - 13,
							y: r * pitch + ((i * 53) % 21) - 10,
							z: nextZ(doc),
						});
					}),
				);
			});
		},
		{ grid: GRID, pitch: PITCH },
	);
}

async function play(rec: Recorder): Promise<void> {
	const { page } = rec;
	// Auto-stack's panel answers and makes the stacks, out of sight: only the board shows.
	await page.addStyleTag({
		content: `.action-popover:has(.group-these) { visibility: hidden !important; }`,
	});
	const stickies = page.locator(".react-flow__node-sticky");
	const all = await Promise.all(
		Array.from({ length: await stickies.count() }, (_, i) =>
			rec.box(`sticky-${i}`, stickies.nth(i)),
		),
	);
	const left = Math.min(...all.map((b) => b.x));
	const top = Math.min(...all.map((b) => b.y));
	const right = Math.max(...all.map((b) => b.x + b.w));
	const bottom = Math.max(...all.map((b) => b.y + b.h));
	rec.boxes.stickies = { x: left, y: top, w: right - left, h: bottom - top };

	const crowd = new Crowd(rec);

	// The board, still, before anything moves.
	await rec.place({ x: right - 40, y: bottom + 34 });
	await rec.wait(1.2);

	// Box them all: from above the first to past the last.
	await glide(crowd, { x: left - 22, y: top - 18 }, 0.9);
	await rec.wait(0.2);
	await rec.drag({ x: right + 18, y: bottom + 16 }, 1);
	const button = page.getByRole("button", { name: /^Auto-stack: sort these/ });
	await rec.until(button);
	await rec.box("button", button);
	rec.mark("selected");
	// The camera leans in on the bar (1.1s) while the pointer makes its way there.
	await rec.wait(0.15);
	await glide(crowd, await rec.centre(button, { x: -8, y: 2 }), 1);
	await rec.wait(0.4);
	await rec.click();

	// The proposal, on the board: each stack's stickies numbered in its colour
	// (the panel's there, if hidden). The camera steps back once it's shown.
	const make = page.locator("form.group-these button[type=submit]");
	while ((await make.count()) === 0) await rec.tick();
	rec.mark("proposed");
	await rec.wait(0.3);
	// The pointer slips out of the way as the camera goes.
	await glide(crowd, { x: right + 10, y: bottom + 40 }, 1.1, { leaving: true });
	await rec.wait(0.3);

	// Make them: the stacks spring in, slower than life so you see them land.
	rec.speed = 0.35;
	rec.mark("made");
	await page.evaluate(() => {
		document.querySelector<HTMLFormElement>("form.group-these")?.requestSubmit();
	});
	// Nothing selected afterwards, so the stacks read as themselves.
	await rec.tick();
	await page.keyboard.press("Escape");
	await rec.wait(0.7);
	rec.speed = 1;
	const stacks = page.locator(".react-flow__node-stack");
	for (let i = 0; i < (await stacks.count()); i++) await rec.box(`stack-${i}`, stacks.nth(i));
	await rec.wait(1.8);
	rec.mark("closer");
	// In on their names (1.2s), a hold there, and the fade back to the start,
	// without the pointer.
	await rec.wait(1.2 + 1.8);
	rec.pointer.visible = false;
	await rec.wait(0.9);
}

/**
 * Your pointer, drawn along a path with the real mouse left behind, so
 * nothing it passes over lights up: the mouse follows when it gets there, or
 * `leaving`, goes straight to where it's headed.
 */
async function glide(
	crowd: Crowd,
	to: Point,
	seconds: number,
	{ leaving = false } = {},
): Promise<void> {
	const { page } = crowd.rec;
	if (leaving) await page.mouse.move(to.x, to.y);
	await crowd.moveTo(crowd.rec.pointer, to, { seconds });
	if (!leaving) await page.mouse.move(to.x, to.y);
}

/** Wide; in on the bar for the click; wide for the stacks forming; in close on their names. */
function camera({ marks, boxes }: Recording): Keyframe[] {
	const m = (name: string) => marks[name] ?? 0;
	const stacks = Object.entries(boxes)
		.filter(([name]) => name.startsWith("stack-"))
		.map(([, box]) => box);
	const bar = closeOn(boxes.button!, 2.2);
	const names = around(stacks, { margin: 28, max: 3.2 });
	return [
		{ t: 0, ...WIDE },
		{ t: m("selected") + 0.05, ...WIDE },
		{ t: m("selected") + 1.15, ...bar },
		{ t: m("proposed") + 0.3, ...bar },
		{ t: m("proposed") + 1.4, ...WIDE },
		{ t: m("closer"), ...WIDE },
		{ t: m("closer") + 1.2, ...names },
	];
}

export const clip: Clip = {
	name: "auto-stack",
	setup: {
		url: "/play?scenario=empty",
		title: "Auto-stack",
		you: { name: "Jo Rivera", color: "#5b5fc7" },
	},
	seed,
	play,
	camera,
	fade: 0.9,
};
