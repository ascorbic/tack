import type * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { addCardShape } from "../../shared/provenance.ts";
import { addShape, nextZ, shapesMap } from "../../shared/shapes.ts";
import { addSection } from "../../shared/structure.ts";
import type { Provenance, QueryError, RelatedResult } from "../../shared/widgets.ts";
import { cardStore } from "../cardStore.ts";
import type { CardOrigin, CardUnmatched } from "../Provenance.tsx";
import { pullDetails, makeChecks, reviewer } from "./ci.ts";
import { LABELS, PLANNING_CARDS, fixture } from "./fixtures.ts";

// Expand related (#42) and provenance (#41) in the playground: a small web
// of issues and pull requests around "Drop Node 18 support", answered
// without a server, and cards an inbox, a rule and a list brought, one of
// which no longer matches.

const REPO = "acme/imagekit";
const key = (n: number, repo = REPO) => `fake.tack/${repo}#${n}`;

const node18 = PLANNING_CARDS.find((card) => card.item === "#412") as Card;
const removeCi = PLANNING_CARDS.find((card) => card.item === "#418") as Card;

export const RELATED_CARDS: Card[] = [
	node18,
	removeCi,
	fixture({
		item: "#400",
		title: "Ship unpic 5.0",
		labels: [LABELS.breaking],
		comments: 31,
		reactions: 48,
		visibility: "public",
	}),
	fixture({
		item: "#441",
		state: "closed",
		stateReason: "completed",
		title: "Remove Node 18 from the test matrix",
		visibility: "public",
	}),
	fixture({
		item: "#442",
		title: "Bump the engines field to Node 20",
		labels: [LABELS.goodFirst],
		visibility: "public",
	}),
	fixture({
		item: "#443",
		title: "Write the Node 20 migration notes",
		labels: [LABELS.docs],
		comments: 4,
		visibility: "public",
	}),
	fixture({
		repo: "acme/vault",
		item: "#8",
		title: "Sign the Node 20 release builds",
		visibility: "private",
	}),
	fixture({
		item: "#444",
		title: "Upgrade sharp to 0.34 first",
		labels: [LABELS.bug],
		comments: 7,
		visibility: "public",
	}),
	fixture({
		item: "#445",
		title: "Use native fetch everywhere",
		labels: [LABELS.enhancement],
		visibility: "public",
	}),
	fixture({
		item: "#446",
		title: "Drop the undici polyfill",
		visibility: "public",
	}),
	fixture({
		item: "#447",
		kind: "pull",
		state: "draft",
		title: "Try Node 22 in CI",
		comments: 2,
		visibility: "public",
		pull: pullDetails({
			checks: makeChecks({ passed: 5, pending: 2 }),
			review: null,
			reviewers: [reviewer("tom", "requested")],
		}),
	}),
	// What an inbox and a rule brought.
	fixture({
		item: "#450",
		title: "Images flicker when the layout changes",
		labels: [LABELS.bug],
		comments: 3,
		visibility: "public",
	}),
	fixture({
		item: "#451",
		state: "closed",
		stateReason: "completed",
		title: "Unknown CDN should warn, not throw",
		labels: [LABELS.provider],
		visibility: "public",
	}),
	fixture({
		item: "#452",
		kind: "pull",
		title: "Warn on unknown CDNs",
		visibility: "public",
		pull: pullDetails({ checks: makeChecks({ passed: 11 }), review: "approved" }),
	}),
	fixture({
		item: "#453",
		title: "Astro adapter warns during SSR build",
		labels: [LABELS.bug],
		visibility: "public",
	}),
];

// The web: [from, to] for each kind of link.
const PARENT: [child: number | string, parent: number][] = [
	[412, 400],
	[441, 412],
	[442, 412],
	[443, 412],
	[key(8, "acme/vault"), 412],
	[377, 400],
];
const BLOCKS: [blocker: number, blocked: number][] = [
	[444, 412],
	[412, 445],
	[412, 446],
];
const CLOSES: [pull: number, issue: number][] = [[418, 412]];
const MENTIONS: [pull: number, issue: number][] = [[447, 412]];

const asKey = (n: number | string) => (typeof n === "string" ? n : key(n));

/** What's related to an item in the playground's little web. */
export function relatedFor(itemKey: string): RelatedResult {
	const parent = PARENT.find(([child]) => asKey(child) === itemKey)?.[1];
	const result: RelatedResult = {
		kind: "related",
		key: itemKey,
		...(parent ? { parent: key(parent) } : {}),
		subIssues: PARENT.filter(([, p]) => key(p) === itemKey).map(([child]) => asKey(child)),
		blockedBy: BLOCKS.filter(([, b]) => key(b) === itemKey).map(([a]) => key(a)),
		blocking: BLOCKS.filter(([a]) => key(a) === itemKey).map(([, b]) => key(b)),
		linkedPulls: [...CLOSES, ...MENTIONS]
			.filter(([, issue]) => key(issue) === itemKey)
			.map(([pull]) => key(pull)),
		cards: [],
	};
	const closes = CLOSES.filter(([pull]) => key(pull) === itemKey).map(([, issue]) => key(issue));
	if (closes.length > 0) result.closes = closes;
	const keys = new Set([
		...(result.parent ? [result.parent] : []),
		...result.subIssues,
		...result.blockedBy,
		...result.blocking,
		...result.linkedPulls,
		...closes,
	]);
	result.cards = [...RELATED_CARDS, ...PLANNING_CARDS].filter((card) => keys.has(card.key));
	return result;
}

/** The playground's stand-in for the related route: a moment's latency, and a failure on cue. */
export async function playRelated(itemKey: string): Promise<RelatedResult | QueryError> {
	await new Promise((resolve) => setTimeout(resolve, 450));
	if (itemKey.endsWith("#453")) {
		return {
			kind: "error",
			reason: "rate_limited",
			message: "GitHub’s rate limit is used up for now.",
			retryAt: Date.now() + 60_000,
		};
	}
	return relatedFor(itemKey);
}

export function seedRelated(doc: Y.Doc): void {
	for (const card of RELATED_CARDS) cardStore.set(card);
	doc.transact(() => {
		// The card to expand, a question about it, and the
		// issue blocking it already on the board, off to one side.
		addCardShape(doc, "related-source", { ref: node18.key, x: 640, y: 400 });
		addShape(doc, crypto.randomUUID(), {
			type: "sticky",
			text: "Is 5.0 the right time for this?",
			color: "yellow",
			author: { name: "Kai Andersen", color: "#1f7a6b" },
			x: 360,
			y: 0,
			z: nextZ(doc),
		});
		addCardShape(doc, crypto.randomUUID(), { ref: key(444), x: 360, y: 180 });

		// An inbox's cards, one of which no longer matches; a rule's; a list's
		// whose list is gone. The inbox's section is drawn around them.
		const inbox = "related-inbox";
		doc.getMap("rules").set("rule-beside", { name: "PRs beside their issues" });
		const brought = (n: number, x: number, y: number, provenance: Provenance) => {
			const id = crypto.randomUUID();
			addCardShape(doc, id, { ref: key(n), x, y }, provenance);
			return id;
		};
		brought(450, 48, 100, { via: "inbox", source: inbox });
		const stale = brought(451, 48, 270, { via: "inbox", source: inbox });
		brought(452, 48, 470, { via: "rule", source: "rule-beside" });
		brought(453, 48, 640, { via: "list", source: "a-list-thats-gone" });
		shapesMap(doc)
			.get(stale)
			?.set("unmatched", new Date(Date.now() - 3_600_000).toISOString());
		addSection(
			doc,
			{ x: 24, y: 40, w: 300, h: 760 },
			{ title: "Triage", color: "orange", id: inbox },
		);
	});
}

const card = (n: number) => RELATED_CARDS.find((c) => c.key === key(n)) as Card;

/** Every provenance state a card can show, for the gallery. */
export const PROVENANCE_GALLERY: {
	label: string;
	card: Card;
	origin: CardOrigin;
	unmatched?: CardUnmatched;
}[] = [
	{
		label: "From an inbox",
		card: card(450),
		origin: { via: "inbox", label: "From the “Triage” inbox" },
	},
	{
		label: "From a list",
		card: card(453),
		origin: { via: "list", label: "From the “Bugs” list" },
	},
	{
		label: "Placed by a rule",
		card: card(452),
		origin: { via: "rule", label: "Placed by rule: PRs beside their issues" },
	},
	{
		label: "Added from a comment on GitHub",
		card: card(444),
		origin: {
			via: "comment",
			label: "Added from GitHub by @priya",
			href: "https://github.com/acme/widgets/issues/444#issuecomment-1",
		},
	},
	{
		label: "No longer matches: keep or remove",
		card: card(451),
		origin: { via: "inbox", label: "From the “Triage” inbox" },
		unmatched: {
			text: "No longer matches the “Triage” inbox",
			onKeep: () => {},
			onRemove: () => {},
		},
	},
	{
		label: "No longer matches, view only",
		card: card(445),
		origin: { via: "rule", label: "Placed by rule: Blocked work" },
		unmatched: { text: "No longer matches the rule “Blocked work”" },
	},
];
