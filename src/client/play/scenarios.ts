import type * as Y from "yjs";
import { withFallbacks } from "../../shared/connectors.ts";
import { boxOf } from "../../shared/sections.ts";
import {
	type ConnectorEnd,
	type ShapeFont,
	type TextSize,
	addShape,
	nextZ,
	readShape,
	shapesMap,
} from "../../shared/shapes.ts";
import { type NewConnector, addConnector, addSection } from "../../shared/structure.ts";
import { addCard } from "../board.ts";
import { cardStore } from "../cardStore.ts";
import { seedCommentsRetro } from "./asyncScenarios.ts";
import { seedInbox, seedRules } from "./automationScenarios.ts";
import { seedActionItems, seedTemplate } from "./actionItems.ts";
import { seedDecisions } from "./decisions.ts";
import { seedLists } from "./displayScenarios.ts";
import { seedLinks } from "./links.ts";
import type { SimulatedFacilitator } from "./facilitation.ts";
import { type SimulatedHistory, retroHistory } from "./history.ts";
import { facilitateSilent, seedRetro, seedSilent, seedVote } from "./facilitationScenarios.ts";
import type { Stager } from "../../shared/changes.ts";
import { ACCESS_GALLERY, DISCUSSIONS, fixture, LABELS, PLANNING_CARDS } from "./fixtures.ts";
import { seedRelated } from "./related.ts";
import { seedWrites } from "./writes.ts";
import { seedAi } from "./ai.ts";
import { UNPIC, PEOPLE, failChange, stageAs } from "./push.ts";
import { seedRoadmap } from "./roadmap.ts";
import { seedStacks } from "./stacks.ts";
import { seedDiscussions, seedTracking, seedWidgets } from "./widgets.ts";
import { seedCustom } from "./custom.ts";
import { heroPeople, seedHero } from "./hero.ts";
import { seedImages } from "./images.tsx";
import { seedVolunteers, volunteersPeople } from "./volunteers.ts";
import type { SimulatedBoard } from "./simulator.ts";

export interface Scenario {
	name: string;
	description: string;
	seed(doc: Y.Doc): void;
	/** After seeding, with the pretend facilitation server running (silent sessions, say). */
	facilitate?(facilitator: SimulatedFacilitator): void;
	/** After seeding, with the pretend history server recording: a past to look back on. */
	history?(history: SimulatedHistory): void;
	/** Once the board's up: who's already here with you, and where. */
	present?(board: SimulatedBoard): void;
}

// The people who wrote the seeded stickies.
const AUTHORS = [
	{ name: "Priya Shah", color: "#b4467a" },
	{ name: "Kai Andersen", color: "#1f7a6b" },
	{ name: "Tom Okafor", color: "#a35a12" },
	{ name: "Jo Rivera", color: "#5b5fc7" },
];
let nextAuthor = 0;

function sticky(
	doc: Y.Doc,
	text: string,
	color: string,
	x: number,
	y: number,
	font?: ShapeFont,
): string {
	const author = AUTHORS[nextAuthor++ % AUTHORS.length];
	const id = crypto.randomUUID();
	addShape(doc, id, {
		type: "sticky",
		text,
		color,
		font,
		author,
		x,
		y,
		z: nextZ(doc),
	});
	return id;
}

function text(doc: Y.Doc, value: string, size: TextSize, x: number, y: number, font?: ShapeFont) {
	addShape(doc, crypto.randomUUID(), {
		type: "text",
		text: value,
		size,
		font,
		x,
		y,
		z: nextZ(doc),
	});
}

// A silent brainstorm: four themes, a few people, and notes of every length,
// from a word to a paragraph, so shrink-to-fit gets a workout.
const BRAINSTORM: { theme: string; color: string; notes: string[] }[] = [
	{
		theme: "What hurts",
		color: "pink",
		notes: [
			"Docs",
			"Provider docs are hard to find, I end up reading source",
			"CDN detection fails for custom domains",
			"Breaking changes land without a migration guide",
			"Too many ways to do the same thing",
			"Every framework adapter has slightly different props and I can never remember which ones are supported where, so I keep a cheat sheet open in another tab",
			"Types!",
			"Slow CI",
		],
	},
	{
		theme: "Ideas",
		color: "yellow",
		notes: [
			"A provider playground",
			"Auto-detect from the URL, always",
			"Codemods for 5.0",
			"One docs page per provider, generated from the source",
			"Ship a CLI?",
			"Internationalisation",
			"Make the default export do the right thing for 90% of people",
			"Office hours",
		],
	},
	{
		theme: "Questions",
		color: "blue",
		notes: [
			"Who maintains the Tidewell provider now?",
			"Do we still need Node 18?",
			"Is AVIF worth the CPU?",
			"How do other libraries version their providers?",
			"Why?",
			"What would make you recommend unpic to a friend? Honestly — and what would stop you?",
			"Sponsors?",
		],
	},
	{
		theme: "Let's do it",
		color: "green",
		notes: [
			"Drop Node 18",
			"Fallback when the CDN isn’t recognised",
			"Credit contributors in release notes",
			"Write the migration guide first, then the code",
			"Yes",
			"Pair on the web component",
			"Ship 5.0 beta by the end of the month",
		],
	},
];

function card(doc: Y.Doc, key: string, x: number, y: number): string {
	const id = crypto.randomUUID();
	addShape(doc, id, { type: "card", ref: key, x, y, z: nextZ(doc), parent: null });
	return id;
}

/** Connect two ends, with fallbacks worked out from nominal sizes. */
function connect(
	doc: Y.Doc,
	from: ConnectorEnd,
	to: ConnectorEnd,
	style: Omit<NewConnector, "from" | "to"> = {},
): string {
	const box = (id: string) => {
		const shape = shapesMap(doc).get(id);
		return shape ? boxOf(id, readShape(shape)) : undefined;
	};
	return addConnector(doc, { ...withFallbacks(from, to, box), ...style });
}

const bound = (shape: string, anchor?: { x: number; y: number }): ConnectorEnd => ({
	x: 0,
	y: 0,
	shape,
	anchor,
});

/**
 * A board mid-session: a few people have staged changes of every kind on
 * stickies and cards, one change failed last time, and one is left out.
 */
function seedPush(doc: Y.Doc): void {
	const upstream = ACCESS_GALLERY[0]?.card;
	const cards = [...PLANNING_CARDS, ...(upstream ? [upstream] : [])];
	for (const fixtureCard of cards) cardStore.set(fixtureCard);
	const ids = new Map<string, string>();
	doc.transact(() => {
		PLANNING_CARDS.forEach((fixtureCard, i) => {
			ids.set(
				fixtureCard.item,
				card(doc, fixtureCard.key, 40 + (i % 3) * 300, 70 + Math.floor(i / 3) * 330),
			);
		});
		if (upstream) ids.set("upstream", card(doc, upstream.key, 40, 740));
	});
	const shape = (item: string) => ids.get(item) ?? "";
	const key = (item: string) => `${UNPIC}${item}`;
	nextAuthor = 0;
	const errors = sticky(doc, "Better errors when the CDN isn’t recognised", "yellow", 980, 90);
	const guide = sticky(doc, "Write the 5.0 migration guide first", "green", 1200, 110);
	const idea = sticky(doc, "A provider playground?", "blue", 990, 400, "hand");
	sticky(doc, "Who owns the CDN list?", "pink", 1210, 420);

	const { priya, kai, tom, jo } = PEOPLE as Record<string, Stager>;
	if (!priya || !kai || !tom || !jo) return;
	stageAs(
		doc,
		{
			kind: "issue.create",
			repo: UNPIC,
			title: "Better errors when the CDN isn’t recognised",
			body: "When `detect()` can’t match a URL to a provider, it silently falls back to the default and drops every transform.\n\n**Instead**, warn once with the URL and a link to the provider list:\n\n- say which URL didn’t match\n- suggest the closest provider\n- [ ] add a test for custom domains\n\nCame out of the 5.0 planning session. cc @kai",
			labels: ["enhancement", "provider"],
		},
		priya,
		{ shapes: [errors], effect: { kind: "replace", shapes: [errors] }, minutesAgo: 14 },
	);
	const migration = stageAs(
		doc,
		{
			kind: "issue.create",
			repo: UNPIC,
			title: "Write the 5.0 migration guide",
			body: "Before the code: what changes, why, and a codemod where we can.",
			labels: ["docs"],
			assignees: ["jo"],
			milestone: "5.0",
		},
		kai,
		{ shapes: [guide], effect: { kind: "replace", shapes: [guide] }, minutesAgo: 12 },
	);
	stageAs(
		doc,
		{ kind: "item.subIssue", parent: { key: key("#412") }, child: { pending: migration } },
		kai,
		{ shapes: [shape("#412"), guide], minutesAgo: 11 },
	);
	stageAs(
		doc,
		{
			kind: "item.labels",
			target: { key: key("#412") },
			add: ["needs review"],
			remove: ["enhancement"],
		},
		tom,
		{ shapes: [shape("#412")], minutesAgo: 9 },
	);
	stageAs(
		doc,
		{ kind: "item.state", target: { key: key("#377") }, state: "closed", reason: "completed" },
		jo,
		{ shapes: [shape("#377")], minutesAgo: 8 },
	);
	stageAs(
		doc,
		{
			kind: "item.comment",
			target: { key: key("#418") },
			// A backlink with a snapshot, as a linked image (the favicon stands in).
			body: [
				"We agreed to land this for **5.0** once CI is green. @kai can you take the review?",
				`This is on [**Planning**](${location.origin}/play) in Tack.`,
				`[![The board around this item](${location.origin}/favicon.svg)](${location.origin}/play)`,
			].join("\n\n"),
		},
		priya,
		{ shapes: [shape("#418")], minutesAgo: 7 },
	);
	stageAs(
		doc,
		{ kind: "item.blockedBy", target: { key: key("#423") }, blockedBy: { key: key("#418") } },
		tom,
		{ shapes: [shape("#423"), shape("#418")], minutesAgo: 6 },
	);
	stageAs(doc, { kind: "item.assignees", target: { key: key("#423") }, add: ["priya"] }, jo, {
		shapes: [shape("#423")],
		minutesAgo: 5,
	});
	const milestone = stageAs(
		doc,
		{ kind: "item.milestone", target: { key: key("#409") }, milestone: "5.0" },
		kai,
		{ shapes: [shape("#409")], minutesAgo: 30 },
	);
	failChange(doc, milestone, "Milestone “5.0” is closed on acme/unpic");
	stageAs(
		doc,
		{
			kind: "pr.create",
			repo: UNPIC,
			title: "Decision: drop Node 18 in 5.0",
			body: "Records the decision from the planning board, so the reasoning lives next to the code.",
			branch: "tack/decision-drop-node-18",
			files: [
				{
					path: "docs/decisions/0007-drop-node-18.md",
					content:
						"# Drop Node 18 in 5.0\n\nStatus: decided\n\n## Context\n\nNode 18 is out of support, and three dependencies already need 20.\n\n## Decision\n\n5.0 needs Node 20 or later.\n",
				},
			],
		},
		jo,
		{ shapes: [idea], minutesAgo: 3 },
	);
	if (upstream) {
		stageAs(doc, { kind: "item.labels", target: { key: upstream.key }, add: ["question"] }, tom, {
			shapes: [shape("upstream")],
			minutesAgo: 2,
		});
	}
}

export const SCENARIOS: Record<string, Scenario> = {
	history: {
		name: "History: a retro, three days on",
		description:
			"Three days of a retro behind it: open History (⌘⌥⇧H) to scrub and play it back, see who changed what, filter to a section, and bring back the sticky Kai deleted or the parking lot Priya cleared.",
		seed() {},
		history: (history) => history.past(retroHistory()),
	},
	retro: {
		name: "Facilitation: a retro",
		description:
			"A retro to run: start a timer, spotlight, stamp (M) and emote (E), and have people join to high-five.",
		seed: seedRetro,
	},
	silent: {
		name: "Silent mode",
		description:
			"“What hurts” is in silent mode: others’ stickies lie face down, yours only you can read. Reveal it from the section’s header.",
		seed: seedSilent,
		facilitate: facilitateSilent,
	},
	vote: {
		name: "Dot voting",
		description:
			"A vote on “Next quarter” closes in two days, with 👍 on GitHub counting; “Release name” voted already.",
		seed: seedVote,
	},
	planning: {
		name: "Planning",
		description:
			"A handful of cards and stickies, the everyday case, with two not-live cards from a public upstream repo, and the RFC discussion the provider work came from.",
		seed(doc) {
			// Two cards from an upstream repo without the app: not live until it's installed.
			const upstream = ACCESS_GALLERY.slice(0, 2).map((entry) => entry.card);
			// The RFC the provider work comes from, and the question it answers.
			const [rfc, question] = DISCUSSIONS;
			for (const card of [...PLANNING_CARDS, ...upstream, ...DISCUSSIONS]) cardStore.set(card);
			doc.transact(() => {
				PLANNING_CARDS.forEach((card, i) => {
					addCard(doc, card.key, { x: 40 + (i % 3) * 290, y: 40 + Math.floor(i / 3) * 300 });
				});
				upstream.forEach((card, i) => {
					addCard(doc, card.key, { x: 40 + i * 290, y: 640 });
				});
				// Under the draft Pictura provider, the RFC's first plugin.
				if (rfc) addCard(doc, rfc.key, { x: 620, y: 640 });
				if (question) addCard(doc, question.key, { x: 960, y: 520 });
				sticky(doc, "Provider docs are hard to find, I end up reading source", "yellow", 960, 40);
				sticky(doc, "CDN detection fails for custom domains", "pink", 1150, 60);
				sticky(doc, "Need a fallback when the CDN isn’t recognised", "blue", 970, 250);
				sticky(doc, "Release notes are thin, contributors don’t get credit", "green", 1160, 270);
			});
		},
	},
	triage: {
		name: "Triage",
		description: "Lots of fresh issues, ready for live updates.",
		seed(doc) {
			const titles = [
				"srcset width off by one at 2x density",
				"Web component warns during SSR build",
				"Type error with exactOptionalPropertyTypes",
				"Support fit=cover in the Brightloom provider",
				"Tidewell provider drops the crop parameter",
				"Add width and height to the Larkspur docs example",
				"Images flicker when the layout changes",
				"Unknown CDN should warn, not throw",
				"Investigate AVIF quality defaults",
			];
			const cards = titles.map((title, i) =>
				fixture({
					title,
					labels:
						i % 3 === 0
							? [LABELS.bug]
							: i % 3 === 1
								? [LABELS.enhancement]
								: [LABELS.docs, LABELS.goodFirst],
					comments: (i * 7) % 13,
				}),
			);
			for (const card of cards) cardStore.set(card);
			doc.transact(() => {
				cards.forEach((card, i) => {
					addCard(doc, card.key, { x: 40 + (i % 3) * 290, y: 40 + Math.floor(i / 3) * 210 });
				});
			});
		},
	},
	stress: {
		name: "500 cards",
		description: "Performance: zoom out to see compact cards.",
		seed(doc) {
			const columns = 23;
			const cards = Array.from({ length: 500 }, (_, i) =>
				fixture({
					title: `Synthetic card ${i + 1}: a reasonably long title so it wraps`,
					state: (["open", "open", "closed", "merged", "draft"] as const)[i % 5],
					kind: i % 5 >= 3 ? "pull" : "issue",
					labels: [LABELS.bug, LABELS.enhancement, LABELS.docs].slice(0, (i % 3) + 1),
					comments: i % 17,
				}),
			);
			for (const card of cards) cardStore.set(card);
			doc.transact(() => {
				cards.forEach((card, i) => {
					addCard(doc, card.key, { x: (i % columns) * 280, y: Math.floor(i / columns) * 220 });
				});
			});
		},
	},
	brainstorm: {
		name: "Brainstorm",
		description: "A silent brainstorm: 30 stickies of every length, headings and fonts.",
		seed(doc) {
			doc.transact(() => {
				text(doc, "unpic 5.0 brainstorm", "xl", 0, -150);
				text(
					doc,
					"Ten minutes, no talking. One idea per sticky.\nThen we group and vote.",
					"s",
					4,
					-72,
				);
				BRAINSTORM.forEach(({ theme, color, notes }, column) => {
					const x = column * 420;
					text(doc, theme, "l", x, 10, column === 3 ? "hand" : undefined);
					notes.forEach((note, i) => {
						const hand = (column + i) % 4 === 0;
						sticky(
							doc,
							note,
							color,
							x + (i % 2) * 196 + ((i * 37) % 11) - 5,
							80 + Math.floor(i / 2) * 196 + ((i * 53) % 13) - 6,
							hand ? "hand" : undefined,
						);
					});
				});
				text(doc, "← add yours anywhere", "m", 1680, 120, "hand");
			});
		},
	},
	arrange: {
		name: "Arrange",
		description:
			"A messy cluster to tidy: drag to snap, select a few to align or tidy up, then copy, paste and undo.",
		seed(doc) {
			const cards = PLANNING_CARDS.slice(0, 4);
			// Discussions too, so a pasted `/discussions/` link has a card to show.
			for (const card of [...cards, ...DISCUSSIONS]) cardStore.set(card);
			doc.transact(() => {
				cards.forEach((card, i) => {
					addCard(doc, card.key, { x: 60 + i * 300 + ((i * 37) % 50), y: 60 + ((i * 53) % 70) });
				});
				const notes = [
					["Ship the web component first", "yellow"],
					["Docs before features", "pink"],
					["Who owns the CDN list?", "blue"],
					["Benchmark AVIF vs WebP", "green"],
					["Cut scope for 5.0", "purple"],
					["Ask Kai about the Larkspur example", "yellow"],
				] as const;
				notes.forEach(([note, color], i) => {
					const x = 80 + (i % 3) * 215 + ((i * 29) % 40);
					const y = 340 + Math.floor(i / 3) * 210 + ((i * 41) % 36);
					sticky(doc, note, color, x, y);
				});
			});
		},
	},
	sections: {
		name: "Now / Next / Later",
		description: "Sections holding cards, and stickies to sort into them.",
		seed(doc) {
			for (const fixtureCard of PLANNING_CARDS) cardStore.set(fixtureCard);
			const columns = [
				{ title: "Now", color: "green" },
				{ title: "Next", color: "blue" },
				{ title: "Later", color: "purple" },
			] as const;
			doc.transact(() => {
				columns.forEach(({ title, color }, i) => {
					const x = 40 + i * 340;
					PLANNING_CARDS.slice(i * 2, i * 2 + 2).forEach((fixtureCard, j) => {
						card(doc, fixtureCard.key, x + 34, 90 + j * 170);
					});
					addSection(doc, { x, y: 40, w: 320, h: 620 }, { title, color });
				});
				sticky(doc, "Ship the new provider docs", "yellow", 1120, 60);
				sticky(doc, "Revisit AVIF defaults", "pink", 1140, 280);
				sticky(doc, "Ask about a 5.1 freeze", "green", 1320, 120);
			});
		},
	},
	stacks: {
		name: "Stacks: theming a planning session",
		description:
			"Drag a sticky onto another and hold: they become a stack, named ✨ from what they say. Click a stack to spread it out (Esc gathers it), drag one out to take it back, or select a few stickies (or the whole section) and Auto-stack them.",
		seed: seedStacks,
	},
	lists: {
		name: "Lists and mini cards",
		description:
			"“Now” is a list and the backlog mini cards: hover a row for its card, drag to reorder or out onto the board, and switch modes from a selected section’s header.",
		seed: seedLists,
	},
	links: {
		name: "Link cards",
		description:
			"Web pages as cards with their previews: with an image, with only an icon or a title, one that couldn’t be read, one Tack won’t read, and one read as you watch. Paste or drop any address to add one (put [fail] in it to see it fail); words around an address keep it a sticky.",
		seed: seedLinks,
	},
	connectors: {
		name: "Connectors",
		description: "Bound, loose and labelled connectors in each style.",
		seed(doc) {
			const [first, second, third, fourth] = PLANNING_CARDS;
			for (const fixtureCard of PLANNING_CARDS) cardStore.set(fixtureCard);
			if (!first || !second || !third || !fourth) return;
			doc.transact(() => {
				const a = card(doc, first.key, 60, 80);
				const b = card(doc, second.key, 480, 80);
				const c = card(doc, third.key, 480, 380);
				const d = card(doc, fourth.key, 900, 380);
				const note = sticky(doc, "Why not both?", "yellow", 120, 420);
				connect(doc, bound(a), bound(b), { label: "blocks" });
				connect(doc, bound(b, { x: 0.5, y: 1 }), bound(c, { x: 0.5, y: 0 }), { route: "elbow" });
				connect(doc, bound(c), bound(d), {
					route: "straight",
					arrow: "both",
					dash: true,
					color: "blue",
				});
				connect(doc, bound(note, { x: 1, y: 0.5 }), bound(c), { color: "orange", label: "see" });
				connect(doc, { x: 980, y: 120 }, { x: 1180, y: 250 }, { color: "red", label: "loose" });
			});
		},
	},
	decisions: {
		name: "Decisions",
		description:
			"A decision in every state: vote on one, decide it (D for a new one), then write it back as an ADR or a Discussion and push.",
		seed(doc) {
			seedDecisions(doc);
		},
	},
	ai: {
		name: "AI",
		description:
			"A pretend AI that answers in your browser: W then describe a widget to see one proposed and previewed; select the Retro section (or a few stickies) and press ⌥⇧S to summarise, or ⌥⇧D to draft a decision from the search discussion.",
		seed: seedAi,
	},
	writes: {
		name: "Write back",
		description:
			"Select stickies, a section, cards or the arrow to stage issues, sub-issues, blocked-by, triage and backlinks. “Node 20 cleanup” is already under #412: make it a parent issue to see.",
		seed: seedWrites,
	},
	push: {
		name: "Pushing to GitHub",
		description:
			"Changes staged by a few people, on stickies and cards: open Changes in the top bar, then review and push. One failed last time; one is left out.",
		seed: seedPush,
	},
	volunteers: {
		name: "Volunteers",
		description:
			"Hands up for the work: hover a card or a sticky and ✋ to volunteer. Select #412 and Assign volunteers, or the stickies and Make issue, then push. Jo puts a hand up as you watch.",
		seed: seedVolunteers,
		present: volunteersPeople,
	},
	related: {
		name: "Related and provenance",
		description:
			"Select “Drop Node 18 support” and Expand related (⌥E) to lay out its web around it. On the left, cards an inbox, a rule and a list brought: one no longer matches.",
		seed: seedRelated,
	},
	inbox: {
		name: "Triage inbox",
		description:
			"A section bound to a search: new matches wait in its tray. Drag them into place or dismiss them, then have new issues arrive.",
		seed: seedInbox,
	},
	rules: {
		name: "Rules",
		description:
			"Two rules: pull requests land beside the issues they close, and new bugs go into a section. Open Rules, then fire some webhooks.",
		seed: seedRules,
	},
	widgets: {
		name: "Widgets",
		description:
			"Live lists of a fake repository: drag rows out as cards, hover to find them, drop cards on a list to stage what makes them match, then push.",
		seed: seedWidgets,
	},
	discussions: {
		name: "Discussions lists",
		description:
			"Lists of a fake repository's discussions: its most upvoted ideas, unanswered questions and announcements. Edit one to try Discussions mode (category, answered, open or closed, labels, Top), or switch “Open bugs” over to it.",
		seed: seedDiscussions,
	},
	roadmap: {
		name: "Timeline, release and dependencies",
		description:
			"A timeline of what's been opened, the next release's draft notes, and the 5.0 launch's dependency map: hover, drag items out as cards, click a cluster or an item, copy the notes.",
		seed: seedRoadmap,
	},
	tracking: {
		name: "Review queue, milestone, stale",
		description:
			"A review queue (yours, and a team's), a milestone's progress and risks, and a stale finder whose quick actions stage changes. Zoom out to read them from afar.",
		seed: seedTracking,
	},
	custom: {
		name: "Custom widgets",
		description:
			"Custom widgets over a fake repository: a burndown, a label cloud, contributors, and a sandbox check that tries every way out. Select one to use it; its code button opens the editor with a live preview and examples.",
		seed: seedCustom,
	},
	comments: {
		name: "Comments",
		description:
			"A retro with threads on cards, stickies, a section and the board, one resolved and one mentioning you. Press B to comment; open the Comments panel for the rest.",
		seed: seedCommentsRetro,
	},
	since: {
		name: "Since you were here",
		description:
			"You've been away three days: people added, moved and edited things, GitHub closed and merged cards, someone pushed and mentioned you. Highlights fade once you've looked.",
		seed: seedCommentsRetro,
	},
	digest: {
		name: "Weekly digest",
		description:
			"A week on a retro: a decision made, action items done, new and late, GitHub closing and merging cards, a push. The Weekly digest previews what goes out as a Discussion and by email.",
		seed: seedCommentsRetro,
	},
	actions: {
		name: "Action items",
		description:
			"Action items in every state: due later, soon, today and overdue, done, linked to an open and a closed issue, staged as a new issue, carried over. Tick them, pick owners and due dates (A for a new one).",
		seed: seedActionItems,
	},
	"template-planning": {
		name: "Template: Planning session",
		description:
			"A board made from the Planning session template. The Facilitate menu has each step ready to start.",
		seed: seedTemplate("tack:planning"),
	},
	"template-retro": {
		name: "Template: Retro",
		description: "A board made from the Retro template, with silent writing and a dot vote ready.",
		seed: seedTemplate("tack:retro"),
	},
	"template-triage": {
		name: "Template: Triage",
		description:
			"A board made from the Triage template: an inbox of unlabelled issues, priorities and rules.",
		seed: seedTemplate("tack:triage"),
	},
	"template-release": {
		name: "Template: Release planning",
		description: "A board made from the Release planning template, about the fake repository.",
		seed: seedTemplate("tack:release"),
	},
	"template-roadmap": {
		name: "Template: Roadmap",
		description: "A board made from the Roadmap template: Now, Next, Later and what shipped.",
		seed: seedTemplate("tack:roadmap"),
	},
	"template-incident": {
		name: "Template: Incident review",
		description: "A board made from the Incident review template.",
		seed: seedTemplate("tack:incident"),
	},
	hero: {
		name: "Landing page",
		description:
			"The landing page's first screenshot: live cards with CI, a stack with a ✨ suggested name, a live list, a milestone and stickies, on one screen at 1200 × 750, with three people at work on it.",
		seed: seedHero,
		present: heroPeople,
	},
	images: {
		name: "Images: a moodboard",
		description:
			"Tack’s mark with its caption, a pasted chart, one image someone’s uploading, one whose upload was abandoned and one whose file is gone. Paste, drop or pick your own (⇧⌘K): they stay in this page.",
		seed: seedImages,
	},
	empty: {
		name: "Empty",
		description: "A brand new board.",
		seed() {},
	},
};
