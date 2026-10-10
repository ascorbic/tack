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
// way the session it's for runs: sections to work in, short prompts in text
// blocks, widgets and inboxes reading the repositories it's made with (see
// the placeholders in templates.ts), rules, and facilitation prepared to
// start from the Facilitate menu (prepared.ts).
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

	/** A prompt inside a section, at its top left. */
	prompt(section: string, text: string): string {
		const box = this.shapes[section] as { x: number; y: number };
		return this.text(`${section}:prompt`, { x: box.x + 24, y: box.y + 22 }, text, "s", section);
	}

	widget(
		id: string,
		widget: string,
		box: { x: number; y: number; w: number; h: number },
		config: Record<string, unknown>,
		parent: string | null = null,
	): string {
		return this.add(id, { type: "widget", widget, ...box, config, parent });
	}

	rule(id: string, trigger: RuleTrigger, action: RuleAction, name: string): void {
		this.rules[id] = { trigger, action, name };
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

// --- Planning session --------------------------------------------------------------

/**
 * Planning as the Astro project runs it in FigJam: everyone proposes on
 * stickies (signed, so it's clear whose is whose), proposals are clustered
 * into themes and discussed in comments, dot-voted, and the winners become
 * issues, with decisions recorded and written back as ADRs.
 */
function planning(): BuiltInTemplate {
	const t = new Layout();
	t.text("title", { x: 0, y: -300 }, "Planning session", "xl");
	t.text("lede", { x: 4, y: -206 }, "Propose, cluster, discuss, vote, decide.", "m");

	const howTo = t.section("how", { x: -600, y: 0, w: 540, h: 860 }, "How we’ll run it", "grey");
	t.text(
		"how:steps",
		{ x: -576, y: 24 },
		[
			"1 · Propose · 10 min, on your own",
			"One sticky per proposal in Proposals. Say what the",
			"problem is and who has it. Your name is on it.",
			"",
			"2 · Cluster · 10 min, together",
			"Drag related proposals into a theme, then rename",
			"the theme to say what joins them.",
			"",
			"3 · Discuss · 15 min",
			"Comment on a proposal (B) with questions.",
			"Whoever proposed it answers in the thread.",
			"",
			"4 · Vote · 5 min",
			"Five dots each, on proposals, not themes.",
			"👍 on GitHub counts too.",
			"",
			"5 · Decide · 15 min",
			"Turn the winners into issues (select, then ⌥I),",
			"record what we decided (D), and write each",
			"decision back as an ADR from its menu.",
			"",
			"Facilitator: everything’s ready to start",
			"from the Facilitate menu, step by step.",
		].join("\n"),
		"s",
		howTo,
	);

	const proposals = t.section("proposals", { x: 0, y: 0, w: 900, h: 860 }, "Proposals", "yellow");
	t.prompt(
		proposals,
		"One proposal per sticky: the problem, and who has it.\nKeep it short; the discussion happens in comments.",
	);

	const theme = (id: string, x: number, y: number, color: SectionColor) => {
		const section = t.section(id, { x, y, w: 540, h: 400 }, "Theme: rename me", color);
		t.prompt(
			section,
			"Drag related proposals here, then rename\nthe theme to say what joins them.",
		);
		return section;
	};
	theme("theme-a", 960, 0, "purple");
	theme("theme-b", 1540, 0, "blue");
	theme("theme-c", 960, 460, "green");
	const parking = t.section("parking", { x: 1540, y: 460, w: 540, h: 400 }, "Parking lot", "grey");
	t.prompt(parking, "Good ideas that aren’t for this cycle.\nThey’re still here next time.");

	t.widget(
		"wanted",
		"list",
		{ x: 2140, y: 0, w: 380, h: 860 },
		{
			title: "Most wanted on GitHub",
			host: HOST,
			q: across("is:issue is:open"),
			sort: "reactions",
			limit: 30,
		},
	);

	const decisions = t.section("decisions", { x: 0, y: 940, w: 900, h: 480 }, "Decisions", "purple");
	t.prompt(
		decisions,
		"Record what we decided (D) and connect the proposals it settles.\nOnce it’s decided, write it back as an ADR from its menu.",
	);
	const next = t.section(
		"next",
		{ x: 960, y: 940, w: 1120, h: 480 },
		"Next up: issues and actions",
		"green",
	);
	t.prompt(
		next,
		"Winners become issues: select them and press ⌥I.\nAnything else someone will do is an action item (A), with an owner and a due date.",
	);

	t.step("propose", {
		kind: "silent",
		section: proposals,
		minutes: 10,
		label: "Propose, on your own",
	});
	t.step("cluster", { kind: "timer", minutes: 10, label: "Cluster into themes" });
	t.step("discuss", { kind: "timer", minutes: 15, label: "Discuss in comments" });
	t.step("vote", {
		kind: "vote",
		scope: null,
		dots: 5,
		hidden: true,
		reactions: true,
		title: "What should we do this cycle?",
		minutes: 5,
		label: "Dot vote: five each",
	});
	t.step("decide", { kind: "timer", minutes: 15, label: "Decide and write back" });

	return {
		id: "tack:planning",
		title: "Planning session",
		description:
			"Everyone proposes, then cluster into themes, discuss in comments, dot-vote, and turn the winners into issues and ADRs.",
		featured: true,
		repos: { min: 0, max: 6, hint: "Its list shows their most wanted issues" },
		content: t.content(),
	};
}

// --- Retro ------------------------------------------------------------------------------

function retro(): BuiltInTemplate {
	const t = new Layout();
	t.text("title", { x: 0, y: -240 }, "Retro", "xl");
	t.text(
		"lede",
		{ x: 4, y: -146 },
		"Look back together, then decide what to change.\nWrite on your own first, reveal, then vote on what to fix.",
		"s",
	);
	const well = t.section("well", { x: 0, y: 0, w: 580, h: 680 }, "Went well", "green");
	t.prompt(well, "What helped us this time?\nOne thing per sticky.");
	const improve = t.section("improve", { x: 640, y: 0, w: 580, h: 680 }, "To improve", "orange");
	t.prompt(improve, "What got in our way?\nSay what happened, and what it cost us.");
	const actions = t.section("actions", { x: 1280, y: 0, w: 580, h: 680 }, "Actions", "blue");
	t.prompt(
		actions,
		"What will we change? One action item each (A),\nwith an owner and a due date. Open ones carry\nover to the next retro.",
	);

	t.step("well", { kind: "silent", section: well, minutes: 5, label: "Write: what went well" });
	t.step("improve", {
		kind: "silent",
		section: improve,
		minutes: 5,
		label: "Write: what to improve",
	});
	t.step("vote", {
		kind: "vote",
		scope: improve,
		dots: 3,
		hidden: true,
		title: "What should we fix first?",
		minutes: 3,
		label: "Dot vote on what to improve",
	});
	t.step("agree", { kind: "timer", minutes: 10, label: "Agree actions" });

	return {
		id: "tack:retro",
		title: "Retro",
		description:
			"Went well, to improve, actions. Silent writing and a dot vote are ready to start, and last retro’s open actions can come along.",
		repos: null,
		content: t.content(),
	};
}

// --- Triage -------------------------------------------------------------------------

function triage(): BuiltInTemplate {
	const t = new Layout();
	t.text("title", { x: 0, y: -240 }, "Triage", "xl");
	t.text(
		"lede",
		{ x: 4, y: -146 },
		"Sort what’s new into a priority. Select cards to label them (⌥L),\nset a milestone (⌥M) or close them, then push it all at once.",
		"s",
	);
	t.section("incoming", { x: 0, y: 0, w: 640, h: 900 }, "Incoming", "grey", {
		inbox: { query: search(across("is:issue is:open no:label")) },
	});
	t.prompt(
		"incoming",
		"New issues without a label wait in the tray →\nDrag each into a priority, or dismiss it.",
	);
	const p0 = t.section("p0", { x: 700, y: 0, w: 560, h: 420 }, "P0 · Drop everything", "red");
	t.prompt(p0, "Broken for many people, or a security hole.");
	const p1 = t.section("p1", { x: 1320, y: 0, w: 560, h: 420 }, "P1 · This cycle", "orange");
	t.prompt(p1, "Important, and we’ll get to it soon.");
	const p2 = t.section("p2", { x: 700, y: 480, w: 560, h: 420 }, "P2 · Backlog", "blue");
	t.prompt(p2, "Worth doing, when there’s time.");
	const info = t.section("info", { x: 1320, y: 480, w: 560, h: 420 }, "Needs more info", "yellow");
	t.prompt(info, "Ask for a reproduction, then check back.");

	t.widget(
		"quiet",
		"stale",
		{ x: 1940, y: 0, w: 400, h: 900 },
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
		{ kind: "pull-links" },
		{ kind: "beside-linked" },
		"Pull requests join the issues they mention",
	);
	t.step("triage", { kind: "timer", minutes: 25, label: "Triage" });

	return {
		id: "tack:triage",
		title: "Triage",
		description:
			"An inbox of unlabelled issues, sections per priority, and rules that place security issues and linked pull requests for you.",
		repos: { min: 1, max: 6, hint: "Repositories to triage" },
		content: t.content(),
	};
}

// --- Release planning ------------------------------------------------------------------------

function release(): BuiltInTemplate {
	const t = new Layout();
	t.text("title", { x: 0, y: -240 }, "Release planning", "xl");
	t.text(
		"lede",
		{ x: 4, y: -146 },
		"What’s in, what’s next, and what could stop us.\nPick the release’s milestone on the milestone widget to start.",
		"s",
	);
	const now = t.section("now", { x: 0, y: 0, w: 900, h: 640 }, "Now · this release", "green");
	t.prompt(
		now,
		"Committed for this release. Connect blockers (X)\nto see the critical path in the dependency map.",
	);
	const next = t.section("next", { x: 0, y: 700, w: 900, h: 460 }, "Next", "blue");
	t.prompt(next, "Ready to go once this ships.");

	t.widget(
		"deps",
		"dependencies",
		{ x: 960, y: 0, w: 700, h: 640 },
		{ title: "What blocks what", source: "section", host: HOST, q: "", section: now, limit: 20 },
	);
	t.widget(
		"pulls",
		"list",
		{ x: 960, y: 700, w: 700, h: 460 },
		{
			title: "Open pull requests",
			host: HOST,
			q: "repo:{{repo}} is:pr is:open",
			sort: "updated",
			limit: 30,
		},
	);
	t.widget(
		"milestone",
		"milestone",
		{ x: 1720, y: 0, w: 420, h: 520 },
		{ title: "", host: HOST, repo: "{{repo}}", milestone: "", staleDays: 14 },
	);
	t.widget(
		"draft",
		"release",
		{ x: 1720, y: 580, w: 420, h: 580 },
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
		{ kind: "pull-links" },
		{ kind: "beside-linked" },
		"Pull requests join the issues they mention",
	);

	return {
		id: "tack:release",
		title: "Release planning",
		description:
			"Now and Next, with the release’s milestone, a draft of its notes, open pull requests and a map of what blocks what.",
		repos: { min: 1, max: 1, hint: "The repository you’re releasing" },
		content: t.content(),
	};
}

// --- Roadmap -----------------------------------------------------------------------------

function roadmap(): BuiltInTemplate {
	const t = new Layout();
	t.text("title", { x: 0, y: -240 }, "Roadmap", "xl");
	t.text(
		"lede",
		{ x: 4, y: -146 },
		"Now, Next, Later: the further out, the less certain.\nMove things left as plans firm up.",
		"s",
	);
	const now = t.section("now", { x: 0, y: 0, w: 580, h: 820 }, "Now", "green");
	t.prompt(now, "Committed, and in progress.");
	const next = t.section("next", { x: 640, y: 0, w: 580, h: 820 }, "Next", "blue");
	t.prompt(next, "Planned, not started yet.");
	const later = t.section("later", { x: 1280, y: 0, w: 580, h: 820 }, "Later", "purple");
	t.prompt(later, "Worth doing; not planned yet.");
	t.widget(
		"shipped",
		"timeline",
		{ x: 0, y: 880, w: 1860, h: 320 },
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
	t.step("vote", {
		kind: "vote",
		scope: later,
		dots: 3,
		hidden: false,
		title: "What should move into Next?",
		label: "Vote on what moves into Next",
	});

	return {
		id: "tack:roadmap",
		title: "Roadmap",
		description: "Now, Next and Later, with a timeline of what shipped lately.",
		repos: { min: 0, max: 6, hint: "Its timeline shows what they shipped lately" },
		content: t.content(),
	};
}

// --- Incident review ----------------------------------------------------------------------

function incident(): BuiltInTemplate {
	const t = new Layout();
	t.text("title", { x: 0, y: -240 }, "Incident review", "xl");
	t.text(
		"lede",
		{ x: 4, y: -146 },
		"Blameless: we’re here to understand the system, not to find someone at fault.",
		"s",
	);
	t.widget(
		"timeline",
		"timeline",
		{ x: 0, y: 0, w: 1860, h: 320 },
		{
			title: "What happened, when",
			host: HOST,
			q: across(""),
			event: "updated",
			range: "1w",
			from: "",
			to: "",
			limit: 100,
		},
	);
	const impact = t.section("impact", { x: 0, y: 380, w: 580, h: 540 }, "Impact", "red");
	t.prompt(impact, "Who was affected, how badly, and for how long?");
	const causes = t.section(
		"causes",
		{ x: 640, y: 380, w: 580, h: 540 },
		"Contributing causes",
		"orange",
	);
	t.prompt(causes, "Ask “why?” until you reach the system.\nMany causes, no culprits.");
	const well = t.section("well", { x: 1280, y: 380, w: 580, h: 540 }, "What went well", "green");
	t.prompt(well, "What limited the damage? Keep doing it.");
	const actions = t.section("actions", { x: 0, y: 980, w: 1860, h: 400 }, "Actions", "blue");
	t.prompt(
		actions,
		"Prevent, detect, mitigate: one action item each (A), with an owner and a due date.\nStage them as issues so they’re tracked where the work happens.",
	);

	t.step("causes", {
		kind: "silent",
		section: causes,
		minutes: 7,
		label: "Write: contributing causes",
	});
	t.step("vote", {
		kind: "vote",
		scope: causes,
		dots: 3,
		hidden: true,
		title: "Which causes matter most?",
		minutes: 3,
		label: "Dot vote on causes",
	});
	t.step("agree", { kind: "timer", minutes: 15, label: "Agree actions" });

	return {
		id: "tack:incident",
		title: "Incident review",
		description:
			"A timeline of what happened, then impact, contributing causes, what went well and actions, run blameless.",
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
