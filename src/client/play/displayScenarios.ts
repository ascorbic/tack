import type * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { withFallbacks } from "../../shared/connectors.ts";
import { setDisplay, setSort } from "../../shared/display.ts";
import { toggleStamp } from "../../shared/facilitation.ts";
import { boxOf } from "../../shared/sections.ts";
import { addShape, nextZ, readShape, shapesMap } from "../../shared/shapes.ts";
import { addConnector } from "../../shared/structure.ts";
import { cardStore } from "../cardStore.ts";
import { makeChecks, pullDetails } from "./ci.ts";
import { KAI, PRIYA, TOM } from "./facilitationScenarios.ts";
import { LABELS, PLANNING_CARDS, PULL_GALLERY, fixture } from "./fixtures.ts";
import { PEOPLE, stageAs } from "./push.ts";

// Sections as lists and mini cards (#72), on /play: `?scenario=lists`. A
// planning board: "Now" as a list (with a group inside it), the backlog as
// mini cards sorted by state, and ideas still as cards, to switch.

const AUTHORS = [
	{ name: "Priya Shah", color: "#b4467a" },
	{ name: "Kai Andersen", color: "#1f7a6b" },
	{ name: "Tom Okafor", color: "#a35a12" },
];

/** The backlog: a spread of states, with CI on the pull requests. */
export const BACKLOG: Card[] = [
	fixture({
		item: "#431",
		title: "AVIF quality defaults are too aggressive",
		labels: [LABELS.bug],
	}),
	fixture({
		item: "#433",
		title: "Support fit=cover in the Contentful provider",
		labels: [LABELS.enhancement, LABELS.provider],
	}),
	fixture({
		item: "#436",
		kind: "pull",
		title: "Contentful: map fit modes",
		labels: [LABELS.provider],
		pull: pullDetails({ checks: makeChecks({ passed: 3, pending: 5 }) }),
	}),
	fixture({
		item: "#440",
		title: "Images flicker when the layout changes",
		labels: [LABELS.bug, LABELS.goodFirst],
		state: "closed",
		stateReason: "completed",
	}),
	fixture({ item: "#441", title: "Document the priority prop", labels: [LABELS.docs] }),
	fixture({
		item: "#444",
		kind: "pull",
		title: "Faster srcset generation",
		state: "merged",
		pull: pullDetails({ checks: makeChecks({ passed: 12 }) }),
	}),
	fixture({
		item: "#447",
		title: "Shopify provider drops the crop parameter",
		labels: [LABELS.bug, LABELS.provider],
	}),
	fixture({
		item: "#450",
		kind: "pull",
		title: "Experimental Qwik adapter",
		state: "draft",
		pull: pullDetails({ checks: makeChecks({ passed: 2, failed: 1 }) }),
	}),
	fixture({
		item: "#452",
		title: "Unknown CDN should warn, not throw",
		labels: [LABELS.enhancement],
		state: "closed",
		stateReason: "not_planned",
	}),
	fixture({
		item: "#455",
		title: "Typo in the Astro guide",
		labels: [LABELS.docs, LABELS.goodFirst],
	}),
];

function section(
	doc: Y.Doc,
	title: string,
	color: string,
	x: number,
	y: number,
	w: number,
	h: number,
	parent: string | null = null,
): string {
	const id = crypto.randomUUID();
	addShape(doc, id, { type: "section", title, color, x, y, w, h, parent, z: nextZ(doc) });
	return id;
}

function card(doc: Y.Doc, key: string, x: number, y: number, parent: string | null): string {
	const id = crypto.randomUUID();
	addShape(doc, id, { type: "card", ref: key, x, y, parent, z: nextZ(doc) });
	return id;
}

let author = 0;
function sticky(
	doc: Y.Doc,
	text: string,
	color: string,
	x: number,
	y: number,
	parent: string | null,
): string {
	const id = crypto.randomUUID();
	addShape(doc, id, {
		type: "sticky",
		text,
		color,
		author: AUTHORS[author++ % AUTHORS.length],
		x,
		y,
		parent,
		z: nextZ(doc),
	});
	return id;
}

/** Cards in a free-form grid inside a section, as someone laid them out. */
function grid(
	doc: Y.Doc,
	cards: readonly Card[],
	parent: string,
	left: number,
	top: number,
	columns = 2,
): string[] {
	return cards.map((c, i) =>
		card(doc, c.key, left + (i % columns) * 290, top + Math.floor(i / columns) * 200, parent),
	);
}

export function seedLists(doc: Y.Doc): void {
	const ci = PULL_GALLERY.slice(0, 3).map((entry) => entry.card);
	for (const c of [...PLANNING_CARDS, ...BACKLOG, ...ci]) cardStore.set(c);
	const ids = new Map<string, string>();
	doc.transact(() => {
		// Now: a list, with what needs a decision grouped inside it.
		const now = section(doc, "Now", "green", 40, 140, 620, 1260);
		grid(doc, PLANNING_CARDS.slice(0, 6), now, 70, 180).forEach((id, i) =>
			ids.set(PLANNING_CARDS[i]?.item ?? "", id),
		);
		sticky(doc, "Pair on the Astro adapter", "yellow", 70, 790, now);
		sticky(doc, "Write the migration guide first", "pink", 360, 790, now);
		const decide = section(doc, "Needs a decision", "orange", 60, 1000, 580, 380, now);
		sticky(doc, "Drop the Gatsby adapter?", "blue", 80, 1040, decide);
		sticky(doc, "Is AVIF worth the CPU?", "purple", 280, 1040, decide);
		setDisplay(doc, [now], "list");

		// Backlog: mini cards, sorted by state.
		const backlog = section(doc, "Backlog", "blue", 760, 140, 640, 1100);
		grid(doc, [...BACKLOG, ...ci], backlog, 790, 180);
		setDisplay(doc, [backlog], "mini");
		setSort(doc, backlog, { by: "state" });

		// Ideas: still as cards, to switch to a list.
		const ideas = section(doc, "Ideas", "yellow", 1500, 140, 460, 440);
		sticky(doc, "A provider playground", "yellow", 1520, 180, ideas);
		sticky(doc, "Codemods for 5.0", "green", 1720, 180, ideas);
		sticky(doc, "Benchmarks in CI", "blue", 1520, 380, ideas);
		sticky(doc, "Office hours", "pink", 1720, 380, ideas);

		// A note outside, pointing at a row.
		const note = sticky(doc, "Ship this by Friday!", "yellow", 760, 1320, null);
		const target = ids.get("#412");
		if (target) {
			const box = (id: string) => {
				const shape = shapesMap(doc).get(id);
				return shape ? boxOf(id, readShape(shape)) : undefined;
			};
			addConnector(doc, {
				...withFallbacks({ x: 0, y: 0, shape: note }, { x: 0, y: 0, shape: target }, box),
				color: "orange",
				label: "deadline",
			});
		}

		// Stamps on a few rows.
		const first = ids.get("#412");
		const second = ids.get("#418");
		if (first) {
			toggleStamp(doc, first, "👍", PRIYA);
			toggleStamp(doc, first, "👍", KAI);
			toggleStamp(doc, first, "🔥", TOM);
		}
		if (second) toggleStamp(doc, second, "👀", KAI);
	});
	// A staged change, marked on its row.
	const staged = ids.get("#377");
	const stager = PEOPLE.tom;
	const key = PLANNING_CARDS[2]?.key;
	if (staged && stager && key) {
		stageAs(doc, { kind: "item.labels", target: { key }, add: ["needs review"] }, stager, {
			shapes: [staged],
			minutesAgo: 4,
		});
	}
}
