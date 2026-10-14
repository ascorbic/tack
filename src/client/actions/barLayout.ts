// How every selection bar is laid out (ActionBar.tsx): which buttons are
// settings and which are actions, what each action says, which one is the
// main thing to do, and what goes in the "…" menu when the bar doesn't fit
// across the canvas. Pure, so it's unit-tested; BarParts.tsx measures and
// draws it.
//
// - **Settings** set a property of what's selected (a section's colour and
//   display, a card's labels, milestone and assignees): an icon, with a
//   tooltip. They never go in the "…" menu.
// - **Actions** do something to the board or the forge: an icon and a short
//   word, with the long name as the tooltip and accessible name. The first
//   that makes something (`PRIMARY`) is in the accent colour and never goes
//   in the menu; the rest are quiet, and the least important (`PRIORITY`'s
//   end) go in the menu first, whole, never losing their word to save room.

/** The bar's groups, in the order they're drawn, with a rule between each. */
export const GROUPS = ["settings", "facilitate", "actions", "ai"] as const;
export type BarGroup = (typeof GROUPS)[number];

/** What a button in the bar is, as far as laying it out goes. */
export interface BarItem {
	id: string;
	/** Its word; set here from `WORDS` unless it has its own (a count). */
	text?: string;
	/** Spelled out, but not the main thing to do: the quiet style. */
	quiet?: boolean;
}

/** A button laid out: its group, whether it's the main action, and how much it matters. */
export interface Arranged<T extends BarItem> {
	item: T;
	group: BarGroup;
	primary: boolean;
	/** Never in the "…" menu: a setting, or the main action. */
	pinned: boolean;
	/** Its place in `PRIORITY`: lower matters more. */
	rank: number;
}

const SETTINGS = new Set(["labels", "milestone", "assign"]);
const FACILITATE = new Set(["startSilent", "startVote", "makeInbox"]);
const AI = new Set(["summarise", "draftDecision"]);

/** Each action's word in the bar (its tooltip and accessible name say it in full). */
export const WORDS: Readonly<Record<string, string>> = {
	makeIssues: "Make issue",
	parentIssue: "Make parent issue",
	carryOver: "Carry over",
	toActions: "Action item",
	stackThese: "Stack",
	unstack: "Unstack",
	groupThese: "Auto-stack",
	fitSection: "Fit",
	expandRelated: "Related",
	assignVolunteers: "Assign volunteers",
	closeReopen: "Close…",
	backlink: "Backlink",
	blockedBy: "Blocked by",
	startSilent: "Silent",
	startVote: "Vote",
	makeInbox: "Inbox",
	summarise: "Summarise",
	draftDecision: "Decide",
};

/** What can be a bar's main action, the first of them in it. */
const PRIMARY = new Set(["makeIssues", "carryOver", "parentIssue", "expandRelated"]);

/**
 * Every action, the most important first: the end of the list goes in the
 * "…" menu first. Settings and the main action never do, wherever they are.
 */
export const PRIORITY: readonly string[] = [
	"makeIssues",
	"carryOver",
	"parentIssue",
	"expandRelated",
	// People put their hands up for these: what the session's for.
	"assignVolunteers",
	"stackThese",
	"unstack",
	"closeReopen",
	"startSilent",
	"startVote",
	"fitSection",
	"toActions",
	"blockedBy",
	"groupThese",
	"makeInbox",
	"backlink",
	"summarise",
	"draftDecision",
];

export function groupOf(id: string): BarGroup {
	if (SETTINGS.has(id)) return "settings";
	if (FACILITATE.has(id)) return "facilitate";
	if (AI.has(id)) return "ai";
	return "actions";
}

/**
 * A bar's buttons in the order they're drawn (by group, the main action
 * first in its own), with their words and emphasis.
 */
export function arrange<T extends BarItem>(items: readonly T[]): Arranged<T>[] {
	const primary = items.find((item) => PRIMARY.has(item.id))?.id;
	const laid = items.map((item): Arranged<T> => {
		const group = groupOf(item.id);
		const isPrimary = item.id === primary;
		const text = group === "settings" ? undefined : (item.text ?? WORDS[item.id]);
		const rank = PRIORITY.indexOf(item.id);
		return {
			item: { ...item, text, quiet: text !== undefined && !isPrimary },
			group,
			primary: isPrimary,
			pinned: group === "settings" || isPrimary,
			rank: rank < 0 ? PRIORITY.length : rank,
		};
	});
	const order = (a: Arranged<T>) => GROUPS.indexOf(a.group) * 2 + (a.primary ? 0 : 1);
	// Stable: within a group, the order they came in.
	return laid
		.map((entry, i) => ({ entry, i }))
		.sort((a, b) => order(a.entry) - order(b.entry) || a.i - b.i)
		.map(({ entry }) => entry);
}

/** A button as measured in the bar, everything showing. */
export interface Measured {
	key: string;
	group: BarGroup;
	/** Across, with the gap after it. */
	width: number;
	pinned: boolean;
	rank: number;
}

/**
 * Which buttons go in the "…" menu for the bar to fit within `limit`: the
 * least important first, whole, until it fits. The "…" button costs `more`;
 * a group left empty takes its rule with it (`divider`). Empty when it fits
 * as it is.
 */
export function overflowing({
	total,
	limit,
	items,
	divider,
	dividers,
	more,
}: {
	/** The bar across, everything showing. */
	total: number;
	limit: number;
	items: readonly Measured[];
	/** A rule between groups across, with its margins and gap. */
	divider: number;
	/** How many rules there are, everything showing. */
	dividers: number;
	more: number;
}): Set<string> {
	const hidden = new Set<string>();
	if (total <= limit) return hidden;
	const left = new Map<BarGroup, number>();
	for (const item of items) left.set(item.group, (left.get(item.group) ?? 0) + 1);
	const candidates = items
		.filter((item) => !item.pinned)
		.sort((a, b) => b.rank - a.rank || items.indexOf(b) - items.indexOf(a));
	let width = total + more;
	let rules = dividers;
	for (const item of candidates) {
		if (width <= limit) break;
		hidden.add(item.key);
		width -= item.width;
		const remaining = (left.get(item.group) ?? 1) - 1;
		left.set(item.group, remaining);
		if (remaining === 0 && rules > 0) {
			width -= divider;
			rules--;
		}
	}
	return hidden;
}
