import type { Card } from "../../../../shared/cards.ts";
import { inboxQuery, setInbox } from "../../../../shared/inbox.ts";
import { shapesMap } from "../../../../shared/shapes.ts";
import { addSection } from "../../../../shared/structure.ts";
import { addWidget } from "../../../../shared/widgetRegistry.ts";
import { cardStore } from "../../../cardStore.ts";
import { seedForge } from "../../../play/automation.ts";
import { LABELS, fixture } from "../../../play/fixtures.ts";
import { MILESTONE } from "../../../play/kindFixtures.ts";
import { KIND_CARDS, REPO, WIDGET_CARDS, addWidgetCard } from "../../../play/widgets.ts";
import type { Loop } from "../loop.ts";

// Widgets: a board that keeps itself current. A bug's opened and slides
// into the live list; Kai closes one of the milestone's issues and its ring
// ticks up; a new issue arrives in the triage inbox, and Priya takes it in.

const HOST = "fake.tack";
const TRIAGE = `repo:${REPO} is:issue is:open no:label`;

/** The bug opened while the loop plays. */
const NEW_BUG: Card = fixture({
	item: "#436",
	title: "Srcset skips the 2x width on narrow layouts",
	labels: [LABELS.bug],
	comments: 0,
	visibility: "public",
});

/** Waiting in the inbox already. */
const UNTRIAGED: Card[] = [
	fixture({ item: "#432", title: "Width is ignored when fill is set", comments: 2 }),
	fixture({ item: "#433", title: "Add an example for emdash", comments: 4 }),
];

/** The issue that arrives in the inbox while the loop plays. */
const ARRIVING: Card = fixture({
	item: "#437",
	title: "Support quality per breakpoint",
	comments: 1,
});

/** The milestone's issue Kai closes: open again at the start of each loop. */
const CLOSING = "#381";

function milestoneCard(): Card | undefined {
	return KIND_CARDS.find((card) => card.item === CLOSING && card.milestone?.title === MILESTONE);
}

const LIST = { x: 0, y: 0, w: 340, h: 500 };
const MILESTONE_AT = { x: 380, y: 0, h: 500 };
const SECTION = { x: 800, y: 0, w: 380, h: 500 };

export const widgetsLoop: Loop = {
	title: "Widgets: a live list, a milestone and an inbox keeping up",
	// All of it, the inbox's tray open beside its section.
	frame: { x: -40, y: -300, w: 1760, h: 1100 },
	cards: [],
	cast: ["priya", "kai"],
	reset() {
		// The forge as it was: no new bug, the milestone's issue open, and the
		// inbox's issue not opened yet.
		const at = WIDGET_CARDS.findIndex((card) => card.key === NEW_BUG.key);
		if (at >= 0) WIDGET_CARDS.splice(at, 1);
		const issue = milestoneCard();
		if (issue) cardStore.set(issue);
		seedForge(UNTRIAGED);
	},
	seed(doc) {
		doc.transact(() => {
			const list = addWidget(
				doc,
				"list",
				{ x: LIST.x, y: LIST.y },
				{
					title: "Open bugs",
					host: HOST,
					q: `repo:${REPO} is:open label:bug`,
					sort: "created",
					limit: 30,
				},
			);
			shapesMap(doc).get(list)?.set("w", LIST.w);
			shapesMap(doc).get(list)?.set("h", LIST.h);
			const milestone = addWidget(
				doc,
				"milestone",
				{ x: MILESTONE_AT.x, y: MILESTONE_AT.y },
				{ host: HOST, repo: REPO, milestone: MILESTONE },
			);
			shapesMap(doc).get(milestone)?.set("h", MILESTONE_AT.h);
			const inbox = addSection(doc, SECTION, { title: "Triage", color: "purple" });
			setInbox(doc, inbox, inboxQuery(TRIAGE, HOST));
		});
	},
	async play({ stage, people, services }) {
		const { d } = stage;
		const { priya, kai } = people;
		priya.place({ x: 1000, y: 620 });
		kai.place({ x: 600, y: 640 });
		await d.wait(700);

		// In on the list and the milestone.
		d.also(priya.moveTo({ x: 250, y: 560 }, 1200));
		d.also(kai.moveTo({ x: 640, y: 520 }, 1200));
		await stage.look({ x: -30, y: -60, w: 880, h: 550 }, 1100);

		// A bug's opened on the forge: the list has it a moment later.
		addWidgetCard({ ...NEW_BUG, updatedAt: new Date().toISOString() });
		await d.wait(500);
		await priya.moveTo({ x: 300, y: 80 }, 700);
		d.also(priya.say("👀 new bug", 1100));
		await d.wait(900);

		// Kai closes one of the milestone's issues: its ring ticks up.
		await kai.moveTo({ x: 470, y: 90 }, 700);
		const issue = milestoneCard();
		if (issue) {
			kai.press();
			cardStore.set({
				...issue,
				state: "closed",
				stateReason: "completed",
				closedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
		}
		d.also(kai.say("✅ breakpoints shipped", 1100));
		await d.wait(1500);

		// Over to triage: a new issue arrives, and Priya takes it in.
		d.also(priya.moveTo({ x: 1000, y: 380 }, 1200));
		await stage.look({ x: 760, y: -70, w: 800, h: 500 }, 1100);
		services.automation.deliver({ ...ARRIVING, updatedAt: new Date().toISOString() });
		const item = await stage.element(() =>
			[...document.querySelectorAll(".inbox-item")].find((el) =>
				el.textContent?.includes(ARRIVING.title),
			),
		);
		if (!item) return;
		await d.wait(700);
		await priya.click(item, 700);
		// A click on the tray's item takes it into the section; the director's
		// press is a key, which the item reads the same.
		item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await d.wait(500);
		stage.deselect();
		await priya.moveTo({ x: 1000, y: 330 }, 800);
	},
	hold: 2400,
};
