import type * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { inboxQuery, setInbox } from "../../shared/inbox.ts";
import { addRule } from "../../shared/rules.ts";
import { addShape, nextZ } from "../../shared/shapes.ts";
import { addSection } from "../../shared/structure.ts";
import { addCard } from "../board.ts";
import { cardStore } from "../cardStore.ts";
import { seedForge } from "./automation.ts";
import { LABELS, PLANNING_CARDS, fixture } from "./fixtures.ts";

// Scenarios for inbox frames and rules (M3): a triage board whose inbox
// fills itself, and a board with rules that place cards as webhooks arrive.

const REPO = "acme/unpic";
const HOST = "fake.tack";
const AUTHOR = { name: "Priya Shah", color: "#b4467a" };

/** Open, unlabelled issues: what the triage inbox collects. */
function untriaged(): Card[] {
	return [
		fixture({ item: "#501", title: "Width is ignored when `fill` is set", comments: 2 }),
		fixture({ item: "#502", title: "Brightloom provider drops focal point", comments: 0 }),
		fixture({ item: "#503", title: "Add an example for emdash", comments: 4 }),
		fixture({ item: "#504", title: "srcset has duplicate entries at 3x", comments: 1 }),
		fixture({ item: "#505", title: "Support `quality` per breakpoint", comments: 7 }),
	];
}

export const TRIAGE_QUERY = `repo:${REPO} is:issue is:open no:label`;

export function seedInbox(doc: Y.Doc): void {
	const sorted = fixture({
		item: "#498",
		title: "Glint Images: wrong default format",
		// Labelled since it was sorted: it no longer matches the inbox.
		labels: [LABELS.bug, LABELS.provider],
	});
	const triaged = fixture({ item: "#497", title: "Docs: the `unpic` CLI flags", labels: [] });
	const elsewhere = [
		fixture({ item: "#480", title: "Streaming SSR support", labels: [LABELS.enhancement] }),
		fixture({ item: "#470", title: "Old issue that is closed", state: "closed", labels: [] }),
	];
	seedForge([...untriaged(), sorted, triaged, ...elsewhere]);
	doc.transact(() => {
		const inbox = addSection(
			doc,
			{ x: 40, y: 80, w: 600, h: 420 },
			{ title: "Triage", color: "blue" },
		);
		setInbox(doc, inbox, inboxQuery(TRIAGE_QUERY, HOST), doc.clientID);
		addShape(doc, crypto.randomUUID(), {
			type: "card",
			ref: sorted.key,
			x: 74,
			y: 140,
			z: nextZ(doc),
			parent: inbox,
			provenance: { via: "inbox", source: inbox },
			// Someone labelled it since: the server marked it.
			unmatched: new Date(Date.now() - 3 * 3600_000).toISOString(),
		});
		addShape(doc, crypto.randomUUID(), {
			type: "card",
			ref: triaged.key,
			x: 356,
			y: 140,
			z: nextZ(doc),
			parent: inbox,
			provenance: { via: "inbox", source: inbox },
		});
		const columns = [
			{ title: "Bugs", color: "red" },
			{ title: "Docs", color: "green" },
			{ title: "Later", color: "purple" },
		] as const;
		columns.forEach(({ title, color }, i) => {
			addSection(doc, { x: 40 + i * 340, y: 640, w: 320, h: 460 }, { title, color });
		});
	});
}

export function seedRules(doc: Y.Doc): void {
	const cards = PLANNING_CARDS.filter((card) => card.kind === "issue").slice(0, 3);
	seedForge([...PLANNING_CARDS, ...untriaged()]);
	for (const card of PLANNING_CARDS) cardStore.set(card);
	doc.transact(() => {
		cards.forEach((card, i) => addCard(doc, card.key, { x: 40, y: 60 + i * 220 }));
		const bugs = addSection(
			doc,
			{ x: 760, y: 60, w: 600, h: 440 },
			{ title: "New bugs", color: "red" },
		);
		addRule(doc, { kind: "pull-links" }, { kind: "beside-linked" }, AUTHOR, {
			origin: doc.clientID,
		});
		addRule(
			doc,
			{ kind: "matches", query: inboxQuery(`repo:${REPO} is:issue is:open label:bug`, HOST) },
			{ kind: "section", section: bugs },
			AUTHOR,
			{ origin: doc.clientID },
		);
	});
}
