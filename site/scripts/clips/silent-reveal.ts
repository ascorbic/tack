// Silent reveal: a section in silent mode, where three people's stickies
// land face down one at a time, then the facilitator presses Reveal and
// they all turn over at once. The camera sits on the section throughout,
// and the turn is slowed a little so it reads.

import type { Page } from "@playwright/test";
import { type Keyframe, around } from "./camera.ts";
import type { Recorder, Recording } from "./capture.ts";
import type { Clip } from "./clip.ts";
import { Crowd, boardToPage } from "./others.ts";

type AppImport = <T>(path: string) => Promise<T>;
type Scenarios = typeof import("../../../src/client/play/facilitationScenarios.ts");
type Shapes = typeof import("../../../src/shared/shapes.ts");
type Structure = typeof import("../../../src/shared/structure.ts");

const PEOPLE = {
	priya: { name: "Priya Shah", color: "#b4467a" },
	kai: { name: "Kai Andersen", color: "#1f7a6b" },
	tom: { name: "Tom Okafor", color: "#a35a12" },
} as const;
type Who = keyof typeof PEOPLE;

/** The section, on the board: two by two stickies under its header, and room below for pointers. */
const SECTION = { x: 40, y: 150, w: 460, h: 540 };
const slot = (i: number) => ({
	x: SECTION.x + 30 + (i % 2) * 206,
	y: SECTION.y + 64 + Math.floor(i / 2) * 206,
});

/** Already there when the clip starts, then the three that land. */
const NOTES: { who: Who; text: string }[] = [
	{ who: "kai", text: "The release checklist lives in someone’s head" },
	{ who: "priya", text: "Flaky tests make me rerun CI three times a day" },
	{ who: "tom", text: "Types are slow in big projects" },
	{ who: "kai", text: "Benchmarks drift and nobody notices" },
];

async function seed(page: Page): Promise<void> {
	await page.evaluate(
		async ({ section, people, first }) => {
			const { tackPlayground, tackFacilitator, clipImport } = window as unknown as {
				tackPlayground: { doc: import("yjs").Doc };
				tackFacilitator: import("../../../src/client/play/facilitation.ts").SimulatedFacilitator;
				clipImport: AppImport;
			};
			const { seedSilent } = await clipImport<Scenarios>(
				"/src/client/play/facilitationScenarios.ts",
			);
			const { shapesMap, addShape, nextZ } = await clipImport<Shapes>("/src/shared/shapes.ts");
			const { removeShapes, resizeSection } = await clipImport<Structure>(
				"/src/shared/structure.ts",
			);
			const doc = tackPlayground.doc;
			const f = tackFacilitator;
			seedSilent(doc);
			const byTitle = (title: string) =>
				[...shapesMap(doc).entries()].find(([, s]) => s.get("title") === title)?.[0] ?? "";
			const hurts = byTitle("What hurts");
			// Just the one section, close enough to see the stickies' backs.
			removeShapes(doc, [byTitle("Parking lot")]);
			resizeSection(doc, hurts, section);
			// You started silent mode: you're the facilitator.
			f.hub.start({ id: "local", author: "you", canEdit: true, owner: true }, hurts, {
				name: "Jo Rivera",
				color: "#5b5fc7",
			});
			const session = (shapesMap(doc).get(hurts)?.get("silent") as { id: string }).id;
			/** Someone's sticky, face down for you: in the document without its words, which the server keeps. */
			const write = (
				who: { name: string; color: string },
				text: string,
				at: { x: number; y: number },
			) => {
				const id = crypto.randomUUID();
				doc.transact(() => {
					addShape(doc, id, {
						type: "sticky",
						color: "pink",
						author: { name: who.name, color: who.color },
						x: at.x,
						y: at.y,
						z: nextZ(doc),
						parent: hurts,
						silent: session,
					});
				});
				f.hub.text(
					{ id: who.name, author: `person:${who.name}`, canEdit: true, owner: false },
					id,
					text,
				);
			};
			write(people[first.who], first.text, first.at);
			Object.assign(window, {
				clipWrite: (who: string, text: string, at: { x: number; y: number }) =>
					write(people[who as keyof typeof people], text, at),
			});
		},
		{ section: SECTION, people: PEOPLE, first: { ...NOTES[0]!, at: slot(0) } },
	);
	// Let the toasts about starting silent mode come and go before recording.
	await page.clock.runFor(12_000);
}

async function play(rec: Recorder): Promise<void> {
	const { page } = rec;
	const crowd = new Crowd(rec);
	const toPage = await boardToPage(page);
	await rec.box("section", page.locator(".react-flow__node-section"));
	await rec.box("header", page.locator(".section-header"));

	// Everyone rests along the bottom of the section, under the stickies.
	const rest: Record<Who, { x: number; y: number }> = {
		tom: toPage({ x: SECTION.x + 40, y: SECTION.y + SECTION.h - 50 }),
		priya: toPage({ x: SECTION.x + 200, y: SECTION.y + SECTION.h - 62 }),
		kai: toPage({ x: SECTION.x + 340, y: SECTION.y + SECTION.h - 46 }),
	};
	const people = Object.fromEntries(
		(Object.keys(PEOPLE) as Who[]).map((who) => [
			who,
			crowd.join(PEOPLE[who].name.split(" ")[0]!, PEOPLE[who].color, rest[who]),
		]),
	) as Record<Who, ReturnType<Crowd["join"]>>;
	// You, the facilitator, up by the section's header.
	await rec.place(toPage({ x: SECTION.x + SECTION.w - 60, y: SECTION.y + 30 }));

	// The board, still.
	await crowd.wait(1.2);

	// One at a time, each lands face down with a beat of its own, and its
	// writer heads back while the next comes in.
	for (const [i, note] of NOTES.entries()) {
		if (i === 0) continue;
		const at = slot(i);
		const who = people[note.who];
		// Pointing at the sticky's lower right, clear of the initials on its back.
		await crowd.moveTo(who, toPage({ x: at.x + 132, y: at.y + 128 }), { seconds: 0.95 });
		await crowd.wait(0.25);
		await crowd.click(who, () =>
			page.evaluate(
				({ who, text, at }) =>
					(window as unknown as { clipWrite(w: string, t: string, a: unknown): void }).clipWrite(
						who,
						text,
						at,
					),
				{ who: note.who, text: note.text, at },
			),
		);
		rec.mark(`landed-${i}`);
		crowd.move(who, rest[note.who], { seconds: 1, delay: 0.5 });
		await crowd.wait(0.2);
	}
	await crowd.wait(0.3);
	rec.mark("landed");

	// The facilitator reveals.
	const reveal = page.getByRole("button", { name: /^Reveal \d+/ });
	await rec.box("reveal", reveal);
	await crowd.moveYou(await rec.centre(reveal, { x: -6, y: 3 }), { seconds: 1 });
	await crowd.wait(0.4);
	rec.mark("reveal");
	// A little slower than life, so you see each one turn.
	rec.speed = 0.6;
	await rec.click();
	await crowd.wait(1.8);
	rec.speed = 1;
	rec.mark("revealed");
	// Read them, then dissolve back to the start.
	await crowd.wait(3);
}

/** On the section, header and all, from the first frame to the last. */
function camera({ boxes }: Recording): Keyframe[] {
	return [{ t: 0, ...around([boxes.section!, boxes.header!], { margin: 36, max: 3 }) }];
}

/**
 * A step further out than the fit, so the section's header has room under
 * the top bar; and no toasts, which would only peek in at the frame's foot.
 */
async function framed(page: Page): Promise<void> {
	await page.keyboard.press("Minus");
	await page.addStyleTag({ content: ".toasts { visibility: hidden !important; }" });
}

export const clip: Clip = {
	name: "silent-reveal",
	setup: {
		url: "/play?scenario=empty",
		title: "unpic retro",
		you: { name: "Jo Rivera", color: "#5b5fc7" },
	},
	seed,
	framed,
	play,
	camera,
};
