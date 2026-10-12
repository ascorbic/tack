import type { Card } from "../../../../shared/cards.ts";
import { addSection } from "../../../../shared/structure.ts";
import { addCard } from "../../../board.ts";
import { makeChecks, pullDetails, reviewer } from "../../../play/ci.ts";
import { LABELS, fixture } from "../../../play/fixtures.ts";
import { numberFrom } from "../../../play/push.ts";
import { type Loop, jitter, sticky } from "../loop.ts";

// Write back: Kai boxes three stickies, makes them issues, and pushes:
// the changes panel, the push sheet, and the stickies landing as issue
// cards with their numbers, on the demo's pretend forge.

const TACK = "ascorbic/tack";

const CARDS: Card[] = [
	fixture({
		repo: TACK,
		item: "#212",
		title: "Offline edits survive a refresh",
		labels: [LABELS.enhancement],
		comments: 8,
		reactions: 12,
		visibility: "public",
	}),
	fixture({
		repo: TACK,
		item: "#218",
		kind: "pull",
		title: "Faster minimap on boards with 900 shapes",
		labels: [LABELS.enhancement],
		comments: 4,
		visibility: "public",
		pull: pullDetails({
			checks: makeChecks({ passed: 9, pending: 2 }),
			reviewers: [reviewer("kai", "requested"), reviewer("priya", "approved")],
		}),
	}),
];

const NOTES: [string, string][] = [
	["Self-hosting docs skip the GitHub App step", "yellow"],
	["Keyboard shortcuts are hard to discover", "purple"],
	["A dark mode for embeds", "blue"],
];

/** Issues made here are numbered from this, every loop. */
const FIRST_NUMBER = 224;

export const pushLoop: Loop = {
	title: "Write back: stickies made issues and pushed",
	// Room on the left for the bar under the stickies, which is wider than they are.
	frame: { x: -110, y: -60, w: 1310, h: 819 },
	cards: CARDS,
	cast: ["kai", "jo"],
	seed(doc) {
		numberFrom(FIRST_NUMBER);
		doc.transact(() => {
			const section = addSection(
				doc,
				{ x: 0, y: 0, w: 1160, h: 330 },
				{ title: "Next up for 1.0", color: "green" },
			);
			NOTES.forEach(([text, color], i) => {
				const authors = ["priya", "tom", "jo"] as const;
				sticky(
					doc,
					text,
					color,
					{ x: 30 + i * 204 + jitter(i, 6), y: 70 + jitter(i + 2, 6) },
					authors[i]!,
					section,
				);
			});
			CARDS.forEach((card, i) => addCard(doc, card.key, { x: 640 + i * 262, y: 80 }));
		});
	},
	async play({ stage, people }) {
		const { kai, jo } = people;
		const { d } = stage;
		kai.place({ x: 700, y: 520 });
		jo.place({ x: 1040, y: 420 });
		await d.wait(300);

		// Three stickies, made issues.
		await kai.marquee({ x: 12, y: 50, w: 3 * 204 + 6, h: 216 }, 900);
		stage.select(NOTES.map(([text]) => stage.find(text)));
		const make = await stage.element(() => stage.button(/^Make \d+ issues/));
		if (!make) return;
		await d.wait(150);
		await kai.click(make, 600);
		const staging = await stage.element(() => stage.button(/^Stage \d+ issues/));
		if (!staging) return;
		await d.wait(500);
		await kai.click(staging, 700);
		stage.deselect();
		await d.wait(300);

		// Reviewed and pushed.
		stage.board.changes?.setPanelOpen(true);
		const review = await stage.element(() => stage.button(/^Review and push/));
		if (!review) return;
		await d.wait(300);
		await kai.click(review, 800);
		const push = await stage.element(() => stage.button(/^Push \d+ changes/));
		if (!push) return;
		await d.wait(500);
		await kai.click(push, 700);
		const done = await stage.element(() => stage.button("Done"), 10_000);
		if (!done) return;
		await d.wait(600);
		await kai.click(done, 700);
		stage.board.changes?.setPanelOpen(false);
		await d.wait(300);
		// The issues, numbered, where the stickies were.
		d.also(kai.moveTo({ x: 420, y: 360 }, 900));
		d.also(jo.moveTo({ x: 300, y: 250 }, 1100));
		await stage.look({ x: -20, y: -110, w: 900, h: 562 }, 1300);
		d.also(jo.say("🎉 on the board and on the forge", 1600));
	},
	hold: 2600,
};
