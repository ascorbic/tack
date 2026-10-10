import type * as Y from "yjs";
import {
	type NewActionItem,
	addActionItem,
	addDays,
	localDate,
	setActionDone,
	stageActionIssue,
} from "../../shared/actionItems.ts";
import { builtInTemplate } from "../../shared/builtInTemplates.ts";
import { addShape, nextZ } from "../../shared/shapes.ts";
import { addSection, placeInSections } from "../../shared/structure.ts";
import { instantiateTemplate } from "../../shared/templates.ts";
import { cardStore } from "../cardStore.ts";
import { clock } from "../clock.ts";
import { fixture } from "./fixtures.ts";
import { IMAGEKIT, PEOPLE } from "./push.ts";

// Action items in the playground (#52): one in every state, on a retro's
// actions, and a board made from each built-in template (#53).

const OWNERS = {
	priya: { login: "priya", name: "Priya Shah" },
	kai: { login: "kai", name: "Kai Andersen" },
	tom: { login: "tom", name: "Tom Okafor" },
	jo: { login: "jo", name: "Jo Rivera" },
};

/** Cards the linked action items follow: one open, one closed. */
export const ACTION_CARDS = [
	fixture({ item: "#501", title: "Document the new resize options" }),
	fixture({
		item: "#502",
		title: "Cache provider lookups",
		state: "closed",
		stateReason: "completed",
	}),
];

export function seedActionItems(doc: Y.Doc): void {
	// Seeding runs while the playground renders: only add what isn't there, so
	// nothing already showing a card is told about it mid-render.
	for (const card of ACTION_CARDS) if (!cardStore.get(card.key)) cardStore.set(card);
	const today = localDate(clock.now());
	const at = (days: number) => addDays(today, days);

	addShape(doc, crypto.randomUUID(), {
		type: "text",
		text: "Retro, October",
		size: "xl",
		x: 0,
		y: -170,
		z: nextZ(doc),
	});
	addShape(doc, crypto.randomUUID(), {
		type: "text",
		text: "Tick them off, give them owners and due dates, link them to issues.\nSelect some and Carry over (⌥O) to take the open ones to the next retro.",
		size: "s",
		x: 4,
		y: -84,
		z: nextZ(doc),
	});
	addSection(doc, { x: 0, y: 0, w: 700, h: 580 }, { title: "Actions", color: "blue" });
	const ids: string[] = [];
	const item = (x: number, y: number, props: Omit<NewActionItem, "x" | "y">) => {
		const id = crypto.randomUUID();
		addActionItem(doc, id, { x, y, ...props });
		ids.push(id);
		return id;
	};
	item(28, 40, { text: "Write up the caching plan", owner: OWNERS.priya, due: at(9) });
	item(348, 40, { text: "Pair on the flaky upload test", owner: OWNERS.kai, due: at(2) });
	item(28, 170, {
		text: "Send the release notes to the newsletter",
		owner: OWNERS.tom,
		due: at(0),
	});
	item(348, 170, { text: "Rotate the CDN keys", owner: OWNERS.jo, due: at(-3) });
	const done = item(28, 300, {
		text: "Book the venue for the meetup",
		owner: OWNERS.priya,
		due: at(-1),
	});
	setActionDone(doc, done, true);
	item(348, 300, {
		text: "Document the new resize options",
		owner: OWNERS.kai,
		ref: ACTION_CARDS[0]?.key,
		due: at(5),
	});
	item(28, 430, { text: "Cache provider lookups", owner: OWNERS.tom, ref: ACTION_CARDS[1]?.key });
	const staged = item(348, 430, {
		text: "Add a size budget to CI\nFail the build when the bundle grows by more than 5%",
		owner: OWNERS.jo,
		due: at(12),
	});
	stageActionIssue(doc, staged, IMAGEKIT, PEOPLE.priya ?? { name: "Priya" });
	item(760, 40, {
		text: "Ask upstream about AVIF support",
		owner: OWNERS.kai,
		due: at(-8),
		carried: {
			board: "retro-september",
			title: "Retro, September",
			shape: "x",
			at: new Date(clock.now() - 30 * 86_400_000).toISOString(),
		},
	});
	item(760, 170, { text: "" });
	placeInSections(doc, ids);

	// Stickies, to turn into action items (select them: Make action items, ⌥⇧A).
	for (const [i, text] of ["Retire the old docs site", "Thank the translators"].entries()) {
		addShape(doc, crypto.randomUUID(), {
			type: "sticky",
			text,
			color: "yellow",
			author: { name: "Priya Shah", color: "#b4467a" },
			x: 760 + i * 196,
			y: 330,
			z: nextZ(doc),
		});
	}
}

/** A board made from a built-in template, about the playground's fake repository. */
export function seedTemplate(id: string) {
	return (doc: Y.Doc) => {
		const template = builtInTemplate(id);
		if (!template) return;
		instantiateTemplate(doc, template.content, {
			repos: template.repos ? [IMAGEKIT] : [],
			by: { name: "Priya Shah", login: "priya", color: "#b4467a" },
		});
	};
}
