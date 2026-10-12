import type * as Y from "yjs";
import type { Card } from "../../../shared/cards.ts";
import type { Rect } from "../../../shared/geometry.ts";
import { addShape, nextZ } from "../../../shared/shapes.ts";
import type { SimulatedFacilitator } from "../../play/facilitation.ts";
import type { SimulatedWidgets } from "../../play/widgets.ts";
import type { SimulatedAutomation } from "../../play/automation.ts";
import type { Actor, Stage } from "./stage.ts";

// A live embed's loop: a board to start from, and what the people on it do,
// played by the director again and again. Seeding is deterministic (the
// same stickies in the same places), so every loop looks the same.

/** The landing page's features, each with its own embed. */
export const FEATURES = ["stacks", "push", "facilitation", "widgets"] as const;
export type Feature = (typeof FEATURES)[number];

export function isFeature(value: string | null | undefined): value is Feature {
	return FEATURES.includes(value as Feature);
}

/** Who plays the loops: the demo's own people. */
export const CAST = {
	priya: { name: "Priya Shah", color: "#b4467a", login: "priya" },
	kai: { name: "Kai Andersen", color: "#1f7a6b", login: "kai" },
	tom: { name: "Tom Okafor", color: "#a35a12", login: "tom" },
	jo: { name: "Jo Rivera", color: "#5b5fc7", login: "jo" },
} as const;
export type CastMember = keyof typeof CAST;

/** What a loop plays with, beyond the board. */
export interface Services {
	facilitator: SimulatedFacilitator;
	widgets: SimulatedWidgets;
	automation: SimulatedAutomation;
}

export interface LoopContext {
	stage: Stage;
	people: Record<CastMember, Actor>;
	services: Services;
}

export interface Loop {
	/** What the embed is called, for its frame's title. */
	title: string;
	/** The part of the board it shows, 16:10. */
	frame: Rect;
	/** The cards its board shows, in the card store before it's seeded. */
	cards: Card[];
	/** Who's on the board. */
	cast: CastMember[];
	seed(doc: Y.Doc): void;
	/** Put back what the loop changed outside the document (the pretend forge's items, a timer). */
	reset?(services: Services): void;
	/** Once the board's seeded, before anything plays (an inbox watching, say). */
	prepare?(context: LoopContext): Promise<void> | void;
	play(context: LoopContext): Promise<void>;
	/** How long the end holds before the loop starts again. */
	hold?: number;
}

const AUTHORS = {
	priya: { name: CAST.priya.name, color: CAST.priya.color },
	kai: { name: CAST.kai.name, color: CAST.kai.color },
	tom: { name: CAST.tom.name, color: CAST.tom.color },
	jo: { name: CAST.jo.name, color: CAST.jo.color },
};

/** A little untidy, as stickies are after people have been at them. */
export const jitter = (i: number, by = 8) => ((i * 37) % (by * 2 + 1)) - by;

export function sticky(
	doc: Y.Doc,
	text: string,
	color: string,
	at: { x: number; y: number },
	author: CastMember,
	parent: string | null = null,
): string {
	const id = crypto.randomUUID();
	addShape(doc, id, {
		type: "sticky",
		text,
		color,
		author: AUTHORS[author],
		x: at.x,
		y: at.y,
		z: nextZ(doc),
		parent,
	});
	return id;
}
