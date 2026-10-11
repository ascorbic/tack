import type * as Y from "yjs";
import { addShape, nextZ } from "../../shared/shapes.ts";
import { addSection } from "../../shared/structure.ts";
import { cardStore } from "../cardStore.ts";
import { LABELS, PLANNING_CARDS, fixture } from "./fixtures.ts";

// Boards for comments (#51) and "since you were here" (#46): a retro, run
// over a few days by people in different time zones. Shapes have known ids
// so the playground can pin threads to them and have people change them.

export const RETRO = {
	well: "retro-well",
	improve: "retro-improve",
	actions: "retro-actions",
	docs: "retro-sticky-docs",
	ci: "retro-sticky-ci",
	pairing: "retro-sticky-pairing",
	release: "retro-sticky-release",
	flaky: "retro-sticky-flaky",
	node: "retro-card-node",
	matrix: "retro-card-matrix",
	cdn: "retro-card-cdn",
	pull: "retro-card-pull",
} as const;

const AUTHORS = {
	priya: { name: "Priya Shah", color: "#b4467a" },
	kai: { name: "Kai Andersen", color: "#1f7a6b" },
	tom: { name: "Tom Okafor", color: "#a35a12" },
	jo: { name: "Jo Rivera", color: "#5b5fc7" },
};

export const RETRO_PULL = fixture({
	item: "#433",
	kind: "pull",
	title: "Retry flaky image downloads in CI",
	labels: [LABELS.bug],
	comments: 3,
	pull: {
		detail: "full",
		head: "abc1234",
		checks: { state: "pending", passed: 8, failed: 0, pending: 3, skipped: 0, failing: [] },
		review: "review_required",
		reviewers: [],
		mergeable: "mergeable",
		linked: [],
	},
});

export function seedCommentsRetro(doc: Y.Doc): void {
	const [node, matrix, cdn] = PLANNING_CARDS;
	for (const card of [...PLANNING_CARDS, RETRO_PULL]) cardStore.set(card);
	doc.transact(() => {
		addSection(
			doc,
			{ x: 40, y: 60, w: 600, h: 470 },
			{ title: "Went well", color: "green", id: RETRO.well },
		);
		addSection(
			doc,
			{ x: 680, y: 60, w: 600, h: 470 },
			{ title: "To improve", color: "red", id: RETRO.improve },
		);
		addSection(
			doc,
			{ x: 40, y: 580, w: 1240, h: 330 },
			{ title: "Actions", color: "blue", id: RETRO.actions },
		);
		const sticky = (
			id: string,
			text: string,
			color: string,
			x: number,
			y: number,
			by: keyof typeof AUTHORS,
			parent: string,
		) =>
			addShape(doc, id, {
				type: "sticky",
				text,
				color,
				author: AUTHORS[by],
				x,
				y,
				z: nextZ(doc),
				parent,
			});
		sticky(
			RETRO.pairing,
			"Pairing on the web component was great",
			"green",
			80,
			120,
			"kai",
			RETRO.well,
		);
		sticky(
			RETRO.release,
			"Release notes credited everyone this time",
			"green",
			280,
			140,
			"priya",
			RETRO.well,
		);
		sticky(
			RETRO.docs,
			"Provider docs are still hard to find",
			"pink",
			720,
			120,
			"tom",
			RETRO.improve,
		);
		sticky(RETRO.ci, "CI takes 25 minutes on a good day", "pink", 920, 140, "jo", RETRO.improve);
		sticky(
			RETRO.flaky,
			"Flaky image downloads fail half our builds",
			"yellow",
			760,
			320,
			"kai",
			RETRO.improve,
		);
		const card = (id: string, ref: string | undefined, x: number, y: number, parent: string) =>
			ref && addShape(doc, id, { type: "card", ref, x, y, z: nextZ(doc), parent });
		card(RETRO.node, node?.key, 80, 640, RETRO.actions);
		card(RETRO.matrix, matrix?.key, 380, 640, RETRO.actions);
		card(RETRO.cdn, cdn?.key, 680, 640, RETRO.actions);
		card(RETRO.pull, RETRO_PULL.key, 980, 640, RETRO.actions);
	});
}
