import type * as Y from "yjs";
import {
	type AiItem,
	type AiRequest,
	type AiResponse,
	type WidgetContext,
	aiError,
	checkWidget,
} from "../../shared/ai.ts";
import { collectItems, widgetContext } from "../../shared/aiContext.ts";
import { addShape, nextZ } from "../../shared/shapes.ts";
import { addSection, readShapes } from "../../shared/structure.ts";
import type { AiService } from "../ai/service.ts";
import { cardStore } from "../cardStore.ts";
import { REPO, type SimulatedWidgets, WIDGET_CARDS } from "./widgets.ts";

const VAULT_CARD = "fake.tack/acme/vault#7";

// AI in the playground (#64): a pretend model that answers in the browser,
// so asking for a widget, summarising and drafting decisions can all be
// tried without Workers AI. It reads a selection exactly as the board's
// server does (`collectItems`: face-down stickies and private placeholders
// are counted, never read), checks the widgets it proposes with the same
// `checkWidget`, and previews them over the playground's fake repository.
// What it writes is made up from keywords: it's for trying the flow, not
// the model. Modes slow it down or make it fail, to see every state.

export type PlayAiMode = "live" | "slow" | "unusable" | "rate_limited" | "failed";

/** How long the pretend model takes, by mode. */
const DELAY: Record<PlayAiMode, number> = {
	live: 1100,
	slow: 4500,
	unusable: 1400,
	rate_limited: 300,
	failed: 2000,
};

export class PlayAi implements AiService {
	readonly live = false;
	mode: PlayAiMode = "live";
	/** The playground's board and widgets, once it's running. */
	doc: Y.Doc | null = null;
	widgets: SimulatedWidgets | null = null;
	login: string | null = null;

	async ask(request: AiRequest, signal?: AbortSignal): Promise<AiResponse> {
		await wait(DELAY[this.mode] * (0.8 + Math.random() * 0.4), signal);
		if (this.mode === "rate_limited") {
			return aiError("rate_limited", { retryAt: Date.now() + 40_000 });
		}
		if (this.mode === "failed") return aiError("failed");
		if (this.mode === "unusable") return aiError("unusable");
		const doc = this.doc;
		if (!doc) return aiError("failed");
		if (request.task === "widget") {
			const proposal = proposeWidget(request.prompt, widgetContext(doc, this.login));
			const check = checkWidget(proposal, { host: proposal.host });
			if (!check.ok) return aiError("unusable");
			return {
				kind: "widget",
				widget: check.widget,
				config: check.config,
				explanation: check.explanation,
			};
		}
		const { items, leftOut } = collectItems(readShapes(doc), request.shapes, (key) => {
			const entry = cardStore.get(key);
			if (!entry) return null;
			if ("missing" in entry) return entry.reason === "private" ? "hidden" : null;
			return { card: entry };
		});
		if (items.length === 0) {
			return aiError("empty", {
				message:
					leftOut.faceDown > 0
						? "Those stickies are face down: reveal them first."
						: "There’s nothing written there yet.",
			});
		}
		const read = items.length;
		return request.task === "summary"
			? { kind: "summary", ...summarise(items), read, leftOut }
			: { kind: "decision", ...draftDecision(items, request.prompt), read, leftOut };
	}

	preview(id: string, widget: string, config: unknown): void {
		this.widgets?.preview(id, widget, config);
	}
}

/** The playground's AI, shared by its board and gallery. */
export const playAi = new PlayAi();

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		});
	});
}

// --- Widgets, from keywords ---------------------------------------------------------

const LABEL_WORDS: [RegExp, string][] = [
	[/\bbugs?\b/, "bug"],
	[/\bdocs?\b|documentation/, "docs"],
	[/good first|newcomer|beginner/, '"good first issue"'],
	[/\bproviders?\b/, "provider"],
	[/\bbreaking\b/, "breaking"],
	[/\bfeatures?\b|enhancement/, "enhancement"],
];

const RANGE_WORDS: [RegExp, string, number][] = [
	[/two weeks|2 weeks|fortnight/, "2w", 14],
	[/three months|3 months|quarter/, "3m", 90],
	[/month/, "1m", 30],
	[/week/, "1w", 7],
];

interface Proposal {
	host: string;
	explanation: string;
	widget: { kind: string; config: Record<string, unknown> };
}

/** A widget for some words, as a model might propose one. */
export function proposeWidget(prompt: string, context: WidgetContext): Proposal {
	const text = prompt.toLowerCase();
	const host = context.host;
	const named = /\b([\w.-]+\/[\w.-]+)\b/.exec(prompt)?.[1];
	const repo = named ?? context.repos[0] ?? "acme/imagekit";
	const range = RANGE_WORDS.find(([pattern]) => pattern.test(text));
	const title = clipTitle(prompt);
	const propose = (kind: string, config: Record<string, unknown>, explanation: string) => ({
		host,
		explanation,
		widget: { kind, config: { host, ...config } },
	});
	if (/\breviews?\b/.test(text)) {
		const mine = /\b(me|my|mine)\b/.test(text);
		return propose(
			"review",
			mine ? { title, scope: "me" } : { title, scope: "repo", repo },
			mine
				? "Pull requests waiting for your review, oldest first."
				: `Pull requests waiting for review in ${repo}, oldest first.`,
		);
	}
	if (/milestone|\bv?\d+\.\d+\b/.test(text)) {
		const milestone = /\bv?(\d+\.\d+(?:\.\d+)?)\b/.exec(prompt)?.[0] ?? "5.0";
		return propose(
			"milestone",
			{ title, repo, milestone },
			`How the ${milestone} milestone is going: done, open and what’s at risk.`,
		);
	}
	if (/release notes|changelog|next release|release/.test(text)) {
		return propose(
			"release",
			{ title, repo },
			`Release notes for ${repo}: what’s merged since its last release, by label.`,
		);
	}
	if (/block|depend/.test(text)) {
		return propose(
			"dependencies",
			{ title, source: "search", q: `repo:${repo} is:open` },
			`What blocks what among ${repo}’s open issues, with the critical path.`,
		);
	}
	if (/nobody|untouched|quiet|stale|forgotten|touched/.test(text)) {
		const days = range?.[2] ?? 30;
		return propose(
			"stale",
			{ title, q: `repo:${repo} is:open${labelQualifier(text)}`, days },
			`Open items in ${repo} nobody’s touched for ${days} days, grouped by how long.`,
		);
	}
	if (/merged|shipped|closed|over time|timeline|happened/.test(text) && range) {
		const merged = /merged|shipped/.test(text);
		return propose(
			"timeline",
			{
				title,
				q: `repo:${repo}${merged ? " is:pr" : ""}${labelQualifier(text)}`,
				event: merged ? "merged" : /closed/.test(text) ? "closed" : "updated",
				range: range[1],
			},
			`${merged ? "Pull requests merged" : "Activity"} in ${repo} over the last ${range[2]} days, on a timeline.`,
		);
	}
	const kind = /pull requests?|\bprs?\b/.test(text)
		? " is:pr"
		: /\bissues?\b/.test(text)
			? " is:issue"
			: "";
	const state = /\bclosed\b/.test(text) ? " is:closed" : " is:open";
	const mine = /assigned to me|\bmine\b|\bmy\b/.test(text) ? " assignee:@me" : "";
	const scope = mine && !named ? "" : `repo:${repo}`;
	const q = `${scope}${kind}${state}${mine}${labelQualifier(text)}`.trim();
	return propose(
		"list",
		{ title, q, sort: "updated" },
		`A live list of ${q}, most recently updated first.`,
	);
}

function labelQualifier(text: string): string {
	return LABEL_WORDS.filter(([pattern]) => pattern.test(text))
		.map(([, label]) => ` label:${label}`)
		.join("");
}

function clipTitle(prompt: string): string {
	const words = prompt.trim().replace(/[.?!]+$/, "");
	const title = words.charAt(0).toUpperCase() + words.slice(1);
	return title.length > 40 ? `${title.slice(0, 39).trimEnd()}…` : title;
}

// --- Summaries and decisions, from what's there ------------------------------------

const STOP = new Set(
	"a an and are as at be but by can do does for from has have how i if in into is it its just more no not of on or our so that the their them then there these they this to too up us was we what when which who why will with you your should would could get make need needs".split(
		" ",
	),
);

/** The words items use most, for a theme or two. */
function themes(items: readonly AiItem[], count = 3): string[] {
	const seen = new Map<string, number>();
	for (const item of items) {
		const words = new Set(
			said(item)
				.toLowerCase()
				.replace(/^section: /, "")
				.split(/[^a-z0-9’']+/)
				.filter((word) => word.length > 2 && !STOP.has(word)),
		);
		for (const word of words) seen.set(word, (seen.get(word) ?? 0) + 1);
	}
	return [...seen]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, count)
		.map(([word]) => word);
}

/** What an item says: a card's title, without the repository and state its line starts with. */
function said(item: AiItem): string {
	return item.kind === "card" ? item.text.replace(/^\S+[#!]\d+ \([^)]*\) /, "") : item.text;
}

function words(list: readonly string[]): string {
	if (list.length <= 1) return list[0] ?? "";
	return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

function clip(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** What the items say, made up from what they say most. */
export function summarise(items: readonly AiItem[]): {
	title: string;
	summary: string;
	points: string[];
} {
	const content = items.filter((item) => item.kind !== "section");
	const sections = [...new Set(content.map((item) => item.section).filter(Boolean))] as string[];
	const top = themes(content);
	const title = sections.length === 1 ? `${sections[0]}, summarised` : "What these say";
	const summary = [
		`${content.length} ${content.length === 1 ? "note" : "notes"}${sections.length > 1 ? ` across ${words(sections.map((s) => `“${s}”`))}` : ""}.`,
		top.length > 0 ? `They come back to ${words(top)} most.` : "",
	]
		.filter(Boolean)
		.join(" ");
	const points =
		sections.length > 1
			? sections.slice(0, 5).map((section) => {
					const inside = content.filter((item) => item.section === section);
					return `${section}: ${clip(inside[0] ? said(inside[0]) : "", 60)}${inside.length > 1 ? ` (and ${inside.length - 1} more)` : ""}`;
				})
			: content.slice(0, 4).map((item) => clip(said(item), 70));
	return { title, summary, points };
}

/** A decision drafted from the items: their question, and the first few as options. */
export function draftDecision(
	items: readonly AiItem[],
	about?: string,
): { title: string; context: string; options: { name: string; summary: string }[] } {
	const content = items.filter((item) => item.kind !== "section");
	const question = content.find((item) => item.text.trim().endsWith("?"));
	const top = themes(content, 2);
	const title = about?.trim()
		? clip(
				about.trim().replace(/^./, (c) => c.toUpperCase()),
				80,
			)
		: question
			? clip(question.text, 80)
			: top.length > 0
				? `What should we do about ${words(top)}?`
				: "What should we do next?";
	const options = content
		.filter((item) => item !== question)
		.slice(0, 3)
		.map((item) => ({
			name: clip(said(item).split("\n")[0] ?? said(item), 48),
			summary: item.by
				? `Raised by ${item.by}${item.section ? ` in “${item.section}”` : ""}.`
				: item.kind === "card"
					? "Already tracked on the forge."
					: "From the board.",
		}));
	const context = `${content.length} ${content.length === 1 ? "item raises" : "items raise"} this${top.length > 0 ? `, mostly about ${words(top)}` : ""}. The options below are the ones they suggest; edit them before the team decides.`;
	return { title, context, options };
}

// --- The scenario ------------------------------------------------------------------

const AUTHORS = [
	{ name: "Priya Shah", color: "#b4467a" },
	{ name: "Kai Andersen", color: "#1f7a6b" },
	{ name: "Tom Okafor", color: "#a35a12" },
	{ name: "Jo Rivera", color: "#5b5fc7" },
];

/**
 * A board to try AI on (`?scenario=ai`): a retro's worth of stickies and
 * cards to summarise (one card from a private repository you can't read,
 * which is left out), a discussion to draft a decision from, and room for
 * widgets over the fake repository.
 */
export function seedAi(doc: Y.Doc): void {
	for (const card of WIDGET_CARDS) cardStore.set(card);
	// A card from a repository you can't read: a placeholder, never read.
	cardStore.set({ key: VAULT_CARD, missing: true, reason: "private" });
	let author = 0;
	const sticky = (text: string, color: string, x: number, y: number) =>
		addShape(doc, crypto.randomUUID(), {
			type: "sticky",
			text,
			color,
			author: AUTHORS[author++ % AUTHORS.length],
			x,
			y,
			z: nextZ(doc),
		});
	const card = (ref: string, x: number, y: number) =>
		addShape(doc, crypto.randomUUID(), { type: "card", ref, x, y, z: nextZ(doc), parent: null });
	doc.transact(() => {
		sticky("Provider docs are hard to find", "pink", 70, 110);
		sticky("CI takes 20 minutes on every PR", "pink", 260, 110);
		sticky("Breaking changes landed without a migration guide", "pink", 450, 110);
		sticky("Generate one docs page per provider", "yellow", 70, 300);
		sticky("Cache the CDN detection", "yellow", 260, 300);
		sticky("Write the migration guide before the code", "yellow", 450, 300);
		card(`fake.tack/${REPO}#431`.toLowerCase(), 660, 110);
		card(`fake.tack/${REPO}#430`.toLowerCase(), 660, 300);
		card(VAULT_CARD, 660, 490);
		addSection(doc, { x: 40, y: 40, w: 920, h: 640 }, { title: "Retro", color: "red" });

		sticky("Search is slow on big repositories", "blue", 1080, 110);
		sticky("Should we rewrite the index or cache results?", "blue", 1270, 110);
		sticky("Rewrite the index: weeks of work, but fast for good", "green", 1080, 300);
		sticky("Cache results for a minute: quick, a little stale", "green", 1270, 300);
		sticky("Add filters first so people search less", "purple", 1460, 300);
		addSection(
			doc,
			{ x: 1050, y: 40, w: 640, h: 460 },
			{ title: "Search discussion", color: "blue" },
		);
	});
}
