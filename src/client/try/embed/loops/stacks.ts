import type * as Y from "yjs";
import { stackUp } from "../../../../shared/stackEdits.ts";
import { shapesMap } from "../../../../shared/shapes.ts";
import { addSection } from "../../../../shared/structure.ts";
import { type Loop, jitter, sticky } from "../loop.ts";
import { hoverAsTarget } from "./gestures.ts";

// Stacks: Kai drags one sticky onto another, they become a stack, and it
// names itself (✨); then he draws a box round the rest, asks Tack to group
// them, and the proposed stacks show on the board before he makes them.

const CI_TARGET = "CI takes 25 minutes on a good day";
const CI_DROPPED = "Flaky e2e on the Windows runners";

/**
 * The rest, which the stand-in groups into docs and release notes. Each
 * theme's stack goes where its first sticky is, so the first of each is
 * far enough apart for the stacks not to overlap.
 */
const LOOSE: [string, string][] = [
	["Provider docs are hard to find", "yellow"],
	["No example for a custom image loader", "yellow"],
	["Release notes are thin", "green"],
	["Getting started guide skips the config file", "yellow"],
	["Changelog doesn't credit contributors", "green"],
	["Breaking changes buried in the changelog", "green"],
];

const COLUMN = 204;
const ROW = 224;
/** The loose stickies start a little further along, clear of where the first stack goes. */
const LOOSE_X = 28 + COLUMN + 44;

export const stacksLoop: Loop = {
	title: "Stacks: stickies stacked by hand and grouped into named themes",
	// Room under the stickies for Auto-stack to open below them, clear of its preview.
	frame: { x: -34, y: -58, w: 1570, h: 981 },
	cards: [],
	cast: ["kai", "priya"],
	seed(doc) {
		doc.transact(() => {
			const section = addSection(
				doc,
				{ x: 0, y: 0, w: 1502, h: 500 },
				{ title: "What should 1.0 fix?", color: "blue" },
			);
			sticky(doc, CI_TARGET, "pink", { x: 28, y: 64 }, "kai", section);
			sticky(doc, CI_DROPPED, "pink", { x: 34, y: 64 + ROW + 4 }, "tom", section);
			LOOSE.forEach(([text, color], i) => {
				const at = { x: LOOSE_X + i * COLUMN + jitter(i), y: 64 + jitter(i + 3, 6) };
				const authors = ["priya", "jo", "tom", "kai"] as const;
				sticky(doc, text, color, at, authors[i % authors.length]!, section);
			});
		});
	},
	async play({ stage, people }) {
		const { kai, priya } = people;
		const { d } = stage;
		kai.place({ x: 980, y: 420 });
		priya.place({ x: 760, y: 590 });
		await d.wait(300);

		// Stack two by hand: held over the other a moment, then let go.
		const target = stage.find(CI_TARGET);
		const dropped = stage.find(CI_DROPPED);
		const at = stage.box(target);
		if (!at) return;
		d.also(priya.moveTo({ x: 520, y: 520 }, 1600));
		await hoverAsTarget(stage, target, () =>
			kai.drag(dropped, { x: at.x + 14, y: at.y + 12 }, 1100),
		);
		kai.edit((doc) => stackUp(doc, target, [dropped]));
		// Named a moment later, from what's in it.
		await d.until(() => stackNamed(stage.doc));
		await d.wait(500);

		// The rest: a box round them, and Auto-stack.
		const ids = LOOSE.map(([text]) => stage.find(text));
		await kai.marquee({ x: LOOSE_X - 24, y: 44, w: 6 * COLUMN + 8, h: 214 }, 1000);
		stage.select(ids);
		const group = await stage.element(() => stage.button(/^Auto-stack: sort these/));
		if (!group) return;
		await d.wait(200);
		await kai.click(group, 600);
		const make = await stage.element(() => stage.button(/^Make (\d+ stacks|the stack)/));
		if (!make) return;
		// The proposal, previewed on the board: Kai looks it over.
		await kai.moveOnto(stage.find(LOOSE[1]![0]), 0.6, 0.45, 700);
		await kai.moveOnto(stage.find(LOOSE[4]![0]), 0.5, 0.5, 700);
		await kai.click(make, 700);
		stage.deselect();
		await d.wait(200);
		// In close, on the three themes and their names.
		d.also(kai.moveTo({ x: 820, y: 300 }, 1200));
		d.also(priya.moveTo({ x: 560, y: 250 }, 1200));
		await stage.look({ x: -20, y: -120, w: 1000, h: 625 }, 1300);
		d.also(priya.say("✨ tidy!", 1400));
	},
	hold: 2600,
};

/** A stack with a name suggested for it. */
function stackNamed(doc: Y.Doc): boolean {
	for (const shape of shapesMap(doc).values()) {
		if (shape.get("type") === "stack" && shape.get("suggested")) return true;
	}
	return false;
}
