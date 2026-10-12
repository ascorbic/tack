import type { ListSort } from "./display.ts";
import { DEFAULT_SECTIONS, DEFAULT_SKIP } from "./releaseDraft.ts";
import type { DistributiveOmit, PreparedPlan } from "./prepared.ts";
import type { RuleAction, RuleTrigger } from "./rules.ts";
import type { SectionColor } from "./sections.ts";
import type { TextSize } from "./shapes.ts";
import {
	TEMPLATE_VERSION,
	type TemplateContent,
	type TemplateInfo,
	type TemplateRepos,
	collectsActions,
	summarise,
	templateThumbnail,
} from "./templates.ts";

// The templates every Tack comes with (#53). Each is a board laid out the
// way the session it's for runs: sections to work in (as cards, or as lists
// and mini cards where what lands there is many and small), short prompts
// in text blocks, widgets and inboxes reading the repositories it's made with
// (see the placeholders in templates.ts), rules, and facilitation prepared to
// start from the Facilitate menu (prepared.ts). Prompts name what to press
// as the UI does ("Auto-stack", "Make parent issue").
//
// A template is a starting board, not a tour: each uses what its session
// needs. What only GitHub has (Discussions) is marked `forge: "discussions"`
// and placed at the end of a row or column, so a board on another forge
// that leaves it out has no hole in it. Lists and mini cards grow downwards
// as they fill, so nothing sits below them.
//
// Ids are `tack:{name}`, which saved templates' random ids can never be.
// Shape ids here only need to be unique within a template: boards made from
// one get fresh ids.

export interface BuiltInTemplate {
	id: string;
	title: string;
	description: string;
	/** Shown first and biggest in the picker. */
	featured?: boolean;
	repos: TemplateRepos | null;
	content: TemplateContent;
}

/** Writes a template's shapes in stacking order, sections first. */
class Layout {
	readonly shapes: TemplateContent["shapes"] = {};
	readonly rules: NonNullable<TemplateContent["rules"]> = {};
	readonly prepared: NonNullable<TemplateContent["prepared"]> = {};
	private z = 0;
	private order = 0;

	private add(id: string, props: Record<string, unknown>): string {
		this.shapes[id] = { ...props, z: `t${String(this.z++).padStart(4, "0")}` };
		return id;
	}

	section(
		id: string,
		box: { x: number; y: number; w: number; h: number },
		title: string,
		color: SectionColor,
		extra: Record<string, unknown> = {},
	): string {
		return this.add(id, { type: "section", ...box, title, color, parent: null, ...extra });
	}

	text(
		id: string,
		at: { x: number; y: number },
		text: string,
		size: TextSize = "s",
		parent: string | null = null,
	): string {
		return this.add(id, { type: "text", ...at, text, size, parent });
	}

	/**
	 * A section showing its contents as a list (or mini cards). A prompt in
	 * it would be a row, so its prompt is the section's own `prompt`, which
	 * its empty state says (with where to drop things) until something's in it.
	 */
	list(
		id: string,
		box: { x: number; y: number; w: number; h: number },
		title: string,
		color: SectionColor,
		{ mini = false, sort, prompt }: { mini?: boolean; sort?: ListSort; prompt?: string } = {},
	): string {
		return this.section(id, box, title, color, {
			display: mini ? "mini" : "list",
			...(sort ? { sort } : {}),
			...(prompt ? { prompt } : {}),
		});
	}

	/** A prompt inside a section, at its top left. */
	prompt(section: string, text: string): string {
		const box = this.shapes[section] as { x: number; y: number };
		return this.text(`${section}:prompt`, { x: box.x + 24, y: box.y + 20 }, text, "m", section);
	}

	widget(
		id: string,
		widget: string,
		box: { x: number; y: number; w: number; h: number },
		config: Record<string, unknown>,
		extra: Record<string, unknown> = {},
	): string {
		return this.add(id, { type: "widget", widget, ...box, config, parent: null, ...extra });
	}

	rule(id: string, trigger: RuleTrigger, action: RuleAction, name: string): void {
		this.rules[id] = { trigger, action, name };
	}

	/** The board's title, and a line or two under it on what it's for. */
	heading(title: string, lede: string): void {
		this.text("title", { x: 0, y: -250 }, title, "xl");
		this.text("lede", { x: 4, y: -160 }, lede, "m");
	}

	step(id: string, step: DistributiveOmit<PreparedPlan, "order">): void {
		this.prepared[id] = { ...step, order: this.order++ } as PreparedPlan;
	}

	content(): TemplateContent {
		return {
			version: TEMPLATE_VERSION,
			shapes: this.shapes,
			...(Object.keys(this.rules).length ? { rules: this.rules } : {}),
			...(Object.keys(this.prepared).length ? { prepared: this.prepared } : {}),
		};
	}
}

const HOST = "{{host}}";

/** A search across the repositories the board was made with. */
const across = (rest: string) => `{{repos}} ${rest}`.trim();

function search(q: string) {
	return { kind: "search", host: HOST, q, sort: "created", order: "desc", limit: 50 } as const;
}

/** Only on forges with Discussions (templates.ts). */
const DISCUSSIONS = { forge: "discussions" } as const;

/** What a lede ends with: where the prepared steps are. */
const READY = "Each step is ready to start from the Facilitate menu.";

// --- Planning session --------------------------------------------------------------

/**
 * Planning as the Astro project runs it in FigJam, with what Tack adds:
 * everyone writes ideas on their own (silent mode), Auto-stack sorts them
 * into named themes, everyone dot-votes, and winning stacks become parent
 * issues with their stickies as sub-issues, beside decisions written back
 * as records. The lists bring in what people already asked for.
 */
function planning(): BuiltInTemplate {
	const t = new Layout();
	t.heading(
		"Planning session",
		`Bring ideas, stack them into themes, vote, and turn the winners into issues.\n${READY}`,
	);

	const ideas = t.section("ideas", { x: 0, y: 0, w: 1200, h: 900 }, "Ideas", "yellow");
	t.prompt(
		ideas,
		"One idea per sticky: the problem, and who has it.\nDrag in anything from the lists →",
	);
	t.widget(
		"wanted",
		"list",
		{ x: 1260, y: 0, w: 420, h: 430 },
		{
			title: "Most wanted issues",
			host: HOST,
			q: across("is:issue is:open"),
			sort: "reactions",
			limit: 30,
		},
	);
	t.widget(
		"discussions",
		"list",
		{ x: 1260, y: 470, w: 420, h: 430 },
		{
			title: "Top discussions",
			host: HOST,
			q: across("is:discussion is:open"),
			sort: "top",
			limit: 30,
		},
		DISCUSSIONS,
	);

	const decisions = t.section("decisions", { x: 0, y: 980, w: 560, h: 440 }, "Decisions", "purple");
	t.prompt(decisions, "Record what we decide (D), and connect\nwhat it settles. Then Write back.");
	const next = t.section("next", { x: 620, y: 980, w: 580, h: 440 }, "Next steps", "green");
	t.prompt(
		next,
		"A winning stack? Make parent issue.\nA sticky? Make issue (⌥I). Someone’s on it?\nAn action item (A). Then push from Changes.",
	);
	const parking = t.section("parking", { x: 1260, y: 980, w: 420, h: 440 }, "Parking lot", "grey");
	t.prompt(parking, "Not this time.\nIt’s still here next time.");

	t.step("write", {
		kind: "silent",
		section: ideas,
		minutes: 10,
		label: "Write ideas on your own",
	});
	t.step("stack", { kind: "timer", minutes: 10, label: "Reveal, then Auto-stack" });
	t.step("discuss", { kind: "timer", minutes: 15, label: "Discuss the themes" });
	t.step("vote", {
		kind: "vote",
		scope: ideas,
		dots: 5,
		hidden: true,
		reactions: true,
		title: "What should we do this cycle?",
		minutes: 5,
		label: "Dot vote: five each",
	});
	t.step("decide", { kind: "timer", minutes: 15, label: "Make issues of the winners" });

	return {
		id: "tack:planning",
		title: "Planning session",
		description:
			"Write ideas on your own, Auto-stack them into themes, dot-vote, and turn the winners into parent issues and decisions.",
		featured: true,
		repos: { min: 0, max: 6, hint: "Its lists show their most wanted issues and discussions" },
		content: t.content(),
	};
}

// --- Retro ------------------------------------------------------------------------------

/**
 * Last time's actions first (carried over as the board's made), then one
 * round of silent writing across all three columns (they're inside one
 * section, which silent mode covers), a reveal, Auto-stack, a vote on what
 * to fix, and new action items.
 */
function retro(): BuiltInTemplate {
	const t = new Layout();
	t.heading("Retro", `Look back together, then decide what to change.\n${READY}`);

	const back = t.section("back", { x: 0, y: 0, w: 1900, h: 860 }, "Looking back", "grey");
	t.prompt(back, "Write on your own: stickies stay face down until the reveal.");
	const column = (id: string, x: number, title: string, color: SectionColor, prompt: string) => {
		const section = t.section(id, { x, y: 140, w: 580, h: 680 }, title, color, { parent: back });
		t.prompt(section, prompt);
		return section;
	};
	column(
		"well",
		40,
		"Went well",
		"green",
		"What helped us? One thing per sticky.\nAgree? Stamp it (M).",
	);
	const improve = column(
		"improve",
		660,
		"To improve",
		"orange",
		"What got in our way,\nand what did it cost us?",
	);
	column("try", 1280, "Ideas to try", "purple", "What could we try next time?");

	const actions = t.section("actions", { x: 0, y: 940, w: 1900, h: 420 }, "Actions", "blue");
	t.prompt(
		actions,
		"What will we change? One action item each (A), with an owner and a due date.\nOpen ones from last time land here: tick what’s done.",
	);

	t.step("last", { kind: "timer", minutes: 5, label: "Check last time’s actions" });
	t.step("write", { kind: "silent", section: back, minutes: 8, label: "Write on your own" });
	t.step("stack", { kind: "timer", minutes: 5, label: "Reveal, then Auto-stack" });
	t.step("vote", {
		kind: "vote",
		scope: improve,
		dots: 3,
		hidden: true,
		title: "What should we fix first?",
		minutes: 3,
		label: "Dot vote: what to fix first",
	});
	t.step("agree", { kind: "timer", minutes: 10, label: "Agree actions, with owners" });

	return {
		id: "tack:retro",
		title: "Retro",
		description:
			"Went well, to improve and ideas, written on your own and Auto-stacked, a vote on what to fix, and last retro’s open actions brought along.",
		repos: null,
		content: t.content(),
	};
}

// --- Triage -------------------------------------------------------------------------

/**
 * What's new waits in an inbox (and on GitHub, a list of questions nobody's
 * answered), to sort into priorities: the urgent ones as cards, the rest as
 * lists that grow as they fill. Rules place security issues and the pull
 * requests that fix what's here.
 */
function triage(): BuiltInTemplate {
	const t = new Layout();
	t.heading(
		"Triage",
		"Sort what’s new: label it (⌥L), set a milestone (⌥M) or close it (⌥C),\nthen push it all at once from Changes.",
	);
	t.section("incoming", { x: 0, y: 0, w: 580, h: 420 }, "Incoming", "grey", {
		inbox: { query: search(across("is:issue is:open no:label")) },
	});
	t.prompt(
		"incoming",
		"New issues without a label wait in its tray.\nDrag each into a priority, or dismiss it.",
	);
	// A list rather than a second inbox: its tray would need the room
	// Incoming's has. Drag a question out into a priority, as a card.
	t.widget(
		"questions",
		"list",
		{ x: 0, y: 480, w: 580, h: 420 },
		{
			title: "Unanswered questions",
			host: HOST,
			q: across("is:discussion is:open is:unanswered"),
			sort: "created",
			limit: 30,
		},
		DISCUSSIONS,
	);

	const p0 = t.section("p0", { x: 640, y: 0, w: 580, h: 420 }, "P0 · Drop everything", "red");
	t.prompt(p0, "Broken for many people, or a security hole.");
	const p1 = t.section("p1", { x: 1280, y: 0, w: 580, h: 420 }, "P1 · This cycle", "orange");
	t.prompt(p1, "Important, and we’ll get to it soon.");
	t.list("info", { x: 640, y: 480, w: 580, h: 420 }, "Needs more info", "yellow", {
		prompt: "Waiting on the reporter: steps, a version, a log.",
	});
	t.list("p2", { x: 1280, y: 480, w: 580, h: 420 }, "P2 · Backlog", "blue", {
		prompt: "Worth doing, when there’s time.",
	});

	t.widget(
		"quiet",
		"stale",
		{ x: 1920, y: 0, w: 400, h: 900 },
		{
			title: "Gone quiet",
			host: HOST,
			q: across("is:issue is:open"),
			days: 60,
			label: "stale",
			limit: 50,
		},
	);

	t.rule(
		"security",
		{ kind: "matches", query: search(across("is:issue is:open label:security")) },
		{ kind: "section", section: p0 },
		"Security issues go to P0",
	);
	t.rule(
		"pulls",
		{ kind: "pull-links", closesOnly: true },
		{ kind: "beside-linked" },
		"Pull requests join the issues they fix",
	);
	t.step("triage", { kind: "timer", minutes: 25, label: "Sort what’s new" });

	return {
		id: "tack:triage",
		title: "Triage",
		description:
			"An inbox of new issues, unanswered questions, priorities to sort them into, and rules that place security issues and the pull requests that fix things.",
		repos: { min: 1, max: 6, hint: "Repositories to triage" },
		content: t.content(),
	};
}

// --- Release planning ------------------------------------------------------------------------

/**
 * What's in the release, as cards whose blockers are connected so the map
 * finds the critical path; what's next, as mini cards; and the release's
 * milestone, draft notes and review queue. The milestone widget flags what's
 * gone quiet, so there's no stale finder.
 */
function release(): BuiltInTemplate {
	const t = new Layout();
	t.heading(
		"Release planning",
		"What’s in, what’s next, and what could stop us.\nPick the release’s milestone on its widget to start.",
	);
	const now = t.section("now", { x: 0, y: 0, w: 1000, h: 640 }, "Now · this release", "green");
	t.prompt(
		now,
		"Committed for this release. Connect a blocker to what\nit blocks (X), then Blocked by (⌥B), and push.",
	);
	t.widget(
		"deps",
		"dependencies",
		{ x: 1060, y: 0, w: 780, h: 640 },
		{ title: "What blocks what", source: "section", host: HOST, q: "", section: now, limit: 20 },
	);
	t.widget(
		"milestone",
		"milestone",
		{ x: 1900, y: 0, w: 420, h: 640 },
		{ title: "", host: HOST, repo: "{{repo}}", milestone: "", staleDays: 14 },
	);
	t.list("next", { x: 0, y: 720, w: 1000, h: 440 }, "Next", "blue", {
		mini: true,
		prompt: "What waits for the release after this one.",
	});
	t.widget(
		"review",
		"review",
		{ x: 1060, y: 720, w: 780, h: 580 },
		{
			title: "Waiting for review",
			host: HOST,
			scope: "repo",
			team: "",
			repo: "{{repo}}",
			drafts: false,
			limit: 30,
		},
	);
	t.widget(
		"draft",
		"release",
		{ x: 1900, y: 720, w: 420, h: 580 },
		{
			title: "",
			host: HOST,
			repo: "{{repo}}",
			sections: DEFAULT_SECTIONS,
			skip: DEFAULT_SKIP,
			contributors: true,
		},
	);
	t.rule(
		"pulls",
		{ kind: "pull-links", closesOnly: true },
		{ kind: "beside-linked" },
		"Pull requests join the issues they fix",
	);
	t.step("risks", { kind: "timer", minutes: 10, label: "What’s at risk?" });
	t.step("unblock", { kind: "timer", minutes: 10, label: "Unblock the critical path" });
	t.step("move", { kind: "timer", minutes: 10, label: "Move the rest to Next" });

	return {
		id: "tack:release",
		title: "Release planning",
		description:
			"Now and Next, the release’s milestone and draft notes, what’s waiting for review, and a map of what blocks what.",
		repos: { min: 1, max: 1, hint: "The repository you’re releasing" },
		content: t.content(),
	};
}

// --- Roadmap -----------------------------------------------------------------------------

/**
 * Now, Next and Later as lists, under what shipped lately and a map of what
 * blocks Now. The vote on what moves up stays open for days, so everyone
 * gets a say wherever they are.
 */
function roadmap(): BuiltInTemplate {
	const t = new Layout();
	t.heading(
		"Roadmap",
		"Now, Next, Later: the further out, the less certain.\nMove things left as plans firm up.",
	);
	t.widget(
		"shipped",
		"timeline",
		{ x: 0, y: 0, w: 1020, h: 440 },
		{
			title: "Shipped lately",
			host: HOST,
			q: across("is:pr"),
			event: "merged",
			range: "1m",
			from: "",
			to: "",
			limit: 100,
		},
	);
	const now = t.list("now", { x: 0, y: 520, w: 580, h: 640 }, "Now · in progress", "green", {
		sort: { by: "state" },
		prompt: "What’s being built now, open work first.",
	});
	t.widget(
		"deps",
		"dependencies",
		{ x: 1080, y: 0, w: 780, h: 440 },
		{ title: "What blocks Now", source: "section", host: HOST, q: "", section: now, limit: 20 },
	);
	t.list("next", { x: 640, y: 520, w: 580, h: 640 }, "Next · planned", "blue", {
		prompt: "Planned, and roughly scoped.",
	});
	const later = t.list(
		"later",
		{ x: 1280, y: 520, w: 580, h: 640 },
		"Later · worth doing",
		"purple",
		{ prompt: "Ideas worth keeping. Vote on what moves up." },
	);
	t.step("vote", {
		kind: "vote",
		scope: later,
		dots: 3,
		hidden: false,
		title: "What should move into Next?",
		days: 3,
		label: "Vote: what moves into Next?",
	});

	return {
		id: "tack:roadmap",
		title: "Roadmap",
		description:
			"Now, Next and Later as lists, what shipped lately, a map of what blocks Now, and a vote over three days on what moves up.",
		repos: { min: 0, max: 6, hint: "Its timeline shows what they shipped lately" },
		content: t.content(),
	};
}

// --- Incident review ----------------------------------------------------------------------

/**
 * Blameless: what happened, in order (people's stickies, and GitHub's own
 * record of the week), then impact, contributing causes written on your
 * own, Auto-stacked and voted on, what went well, and what follows:
 * decisions written back as records, and action items.
 */
function incident(): BuiltInTemplate {
	const t = new Layout();
	t.heading(
		"Incident review",
		`Blameless: we’re here to understand the system, not to find someone at fault.\n${READY}`,
	);
	const happened = t.section(
		"happened",
		{ x: 0, y: 0, w: 1860, h: 320 },
		"What happened, when",
		"grey",
	);
	t.prompt(
		happened,
		"Stickies left to right, oldest first: when it started,\nwhen we noticed, what we tried, when it was fixed.",
	);
	t.widget(
		"timeline",
		"timeline",
		{ x: 0, y: 380, w: 1860, h: 300 },
		{
			title: "On GitHub that week",
			host: HOST,
			q: across(""),
			event: "updated",
			range: "1w",
			from: "",
			to: "",
			limit: 100,
		},
	);
	t.section("impact", { x: 0, y: 800, w: 580, h: 520 }, "Impact", "red");
	t.prompt("impact", "Who was affected, how badly,\nand for how long?");
	const causes = t.section(
		"causes",
		{ x: 640, y: 800, w: 580, h: 520 },
		"Contributing causes",
		"orange",
	);
	t.prompt(causes, "Ask “why?” until you reach the system.\nMany causes, no culprits.");
	t.section("well", { x: 1280, y: 800, w: 580, h: 520 }, "What went well", "green");
	t.prompt("well", "What limited the damage?\nKeep doing it.");

	t.section("decisions", { x: 0, y: 1400, w: 900, h: 420 }, "Decisions", "purple");
	t.prompt("decisions", "What we’ll change for good (D).\nDecided? Write it back as a record.");
	t.section("actions", { x: 960, y: 1400, w: 900, h: 420 }, "Actions", "blue");
	t.prompt(
		"actions",
		"Prevent, detect, mitigate: an action item each (A),\nwith an owner and a due date. Its Issue chip tracks it.",
	);

	t.step("walk", { kind: "timer", minutes: 10, label: "Walk through what happened" });
	t.step("causes", {
		kind: "silent",
		section: causes,
		minutes: 7,
		label: "Write causes on your own",
	});
	t.step("stack", { kind: "timer", minutes: 5, label: "Reveal, then Auto-stack" });
	t.step("vote", {
		kind: "vote",
		scope: causes,
		dots: 3,
		hidden: true,
		title: "Which causes matter most?",
		minutes: 3,
		label: "Dot vote: causes that matter",
	});
	t.step("agree", { kind: "timer", minutes: 15, label: "Decide, and agree actions" });

	return {
		id: "tack:incident",
		title: "Incident review",
		description:
			"What happened and when, then impact and causes, Auto-stacked and voted on, and the decisions and action items that follow. Run blameless.",
		repos: { min: 0, max: 6, hint: "Where the incident’s issues and pull requests are" },
		content: t.content(),
	};
}

/** Every built-in template, in the picker's order. */
export const BUILT_IN_TEMPLATES: readonly BuiltInTemplate[] = [
	planning(),
	retro(),
	triage(),
	release(),
	roadmap(),
	incident(),
];

/** A built-in template by id. */
export function builtInTemplate(id: string): BuiltInTemplate | null {
	return BUILT_IN_TEMPLATES.find((template) => template.id === id) ?? null;
}

/** A built-in template as the picker shows it. */
export function builtInInfo(template: BuiltInTemplate): TemplateInfo {
	return {
		id: template.id,
		title: template.title,
		description: template.description,
		builtIn: true,
		...(template.featured ? { featured: true } : {}),
		repos: template.repos,
		summary: summarise(template.content),
		thumbnail: templateThumbnail(template.content),
		collectsActions: collectsActions(template.content),
	};
}
