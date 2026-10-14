import type * as Y from "yjs";
import { addShape, nextZ } from "../../shared/shapes.ts";
import { addSection } from "../../shared/structure.ts";
import { toggleVolunteer } from "../../shared/volunteers.ts";
import { cardStore } from "../cardStore.ts";
import { PLANNING_CARDS } from "./fixtures.ts";
import { PEOPLE } from "./push.ts";
import type { SimulatedBoard } from "./simulator.ts";

// Volunteering (`/play?scenario=volunteers`): a planning session where
// people have put their hands up for issues and stickies. Select a card
// with volunteers and Assign volunteers, or the stickies and Make issue,
// then push; Jo puts a hand up as you watch.

const person = (login: "priya" | "kai" | "tom" | "jo") => {
	const p = PEOPLE[login];
	return { login, name: p?.name ?? login, color: p?.color ?? "#5a5f66" };
};

/** Where Jo puts a hand up, once the board's up. */
let joins: string | null = null;

export function seedVolunteers(doc: Y.Doc): void {
	const cards = PLANNING_CARDS.slice(0, 3);
	for (const card of cards) cardStore.set(card);
	const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
	doc.transact(() => {
		const ids = cards.map((card, i) => {
			const id = crypto.randomUUID();
			addShape(doc, id, {
				type: "card",
				ref: card.key,
				x: 40 + i * 300,
				y: 80,
				z: nextZ(doc),
				parent: null,
			});
			return id;
		});
		const [node18, ci, domains] = ids;
		// Kai and Priya both want the Node 18 work; Tom's on CI.
		if (node18) {
			toggleVolunteer(doc, node18, person("kai"), at(12));
			toggleVolunteer(doc, node18, person("priya"), at(9));
		}
		if (ci) toggleVolunteer(doc, ci, person("tom"), at(6));
		joins = domains ?? null;

		const sticky = (text: string, color: string, x: number, y: number, author: string) => {
			const id = crypto.randomUUID();
			const by = person(author as "priya");
			addShape(doc, id, {
				type: "sticky",
				text,
				color,
				author: { name: by.name, color: by.color, login: by.login },
				x,
				y,
				z: nextZ(doc),
			});
			return id;
		};
		const guide = sticky("Write the 5.0 migration guide first", "green", 1050, 90, "priya");
		const playground = sticky("A provider playground", "pink", 1260, 110, "kai");
		toggleVolunteer(doc, guide, person("jo"), at(4));
		toggleVolunteer(doc, playground, person("kai"), at(3));
		toggleVolunteer(doc, playground, person("tom"), at(2));
		// Sections last: each takes in what's already on it.
		addSection(doc, { x: 0, y: 30, w: 960, h: 380 }, { title: "Up for grabs", color: "blue" });
		addSection(doc, { x: 1020, y: 30, w: 460, h: 380 }, { title: "New ideas", color: "yellow" });
	});
}

/** Jo, on the board, putting a hand up for the custom domains bug. */
export function volunteersPeople(board: SimulatedBoard): void {
	const jo = board.join({ ...person("jo") });
	const target = joins;
	const box = target ? board.box(target) : undefined;
	if (!target || !box) return;
	jo.pose(
		{ x: box.x + box.w - 24, y: box.y + box.h - 36 },
		{ x: -40, y: -60, width: 1440, height: 860 },
	);
	setTimeout(() => {
		jo.doc.transact(() => toggleVolunteer(jo.doc, target, person("jo")));
	}, 2400);
}
