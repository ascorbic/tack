// Weekly digests (#68): what happened on a board in a week, posted as a
// GitHub Discussion in a repository its owner chooses (as the app) and
// emailed to members who ask for it. Pure: the schedule (a weekday and an
// hour in the owner's time zone, and which week a digest is for), the
// digest itself, built from what "since you were here" keeps (the change
// log, card history and the push audit log, see src/server/since.ts), and
// the words: a title, and the Discussion post's Markdown. The server sends
// them (src/server/digests.ts); the board's menu previews the next one.
//
// What goes in is decided by whoever builds the input, per audience: a
// Discussion only gets cards from repositories known to be public (or the
// Discussion's own repository), an email only what its reader can read.

import { daysBetween, describeDue, dueState } from "./actionItems.ts";
import { quote } from "./commands.ts";
import { statusOf } from "./decisions.ts";
import { parseRepoKey } from "./refs.ts";
import type { ShapeProps } from "./shapes.ts";
import {
	type Actor,
	type CardActivity,
	type EditEntry,
	type PushDigest,
	actorName,
	describeCardActivity,
	describeEdits,
	editsByPerson,
} from "./since.ts";

// --- Settings ----------------------------------------------------------------------

/** 0 is Sunday, as `Date.getDay()`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAY_NAMES = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
] as const;

/** What the owner chose. */
export interface DigestSettings {
	/** Post it as a Discussion: the repository's key (`github.com/owner/name`) and the category. */
	discussion: { repo: string; category: string } | null;
	/** Email it to members who ask for it (and confirm their address). */
	email: boolean;
	weekday: Weekday;
	/** The hour it goes out, 0–23, in `timeZone`. */
	hour: number;
	/** The owner's time zone (IANA), for the weekday and hour, and for what "overdue" means. */
	timeZone: string;
}

export const DEFAULT_DIGEST: Omit<DigestSettings, "timeZone"> = {
	discussion: null,
	email: true,
	weekday: 1,
	hour: 9,
};

/** `PUT /api/boards/:id/digest` */
export type DigestRequest = DigestSettings;

/** How one digest went out, to one place. */
export interface DigestRun {
	/** The week it covered (`weekKey`), e.g. `2026-W41`. */
	week: string;
	/** `discussion`, or `email` (all of them, summed up). */
	channel: "discussion" | "email";
	/** `quiet`: nothing happened, so nothing was sent. */
	status: "sent" | "failed" | "quiet";
	/** When, ms since the epoch. */
	at: number;
	/** The Discussion. */
	url?: string;
	/** Emails sent, and how many failed. */
	sent?: number;
	failed?: number;
	/** Why it failed, in words. */
	error?: string;
}

/** Someone's own email subscription to a board's digest. */
export interface DigestSubscription {
	email: string;
	/** Until they follow the link in the confirmation email, nothing's sent. */
	confirmed: boolean;
}

/** `GET /api/boards/:id/digest` */
export interface DigestView {
	settings: DigestSettings | null;
	/** Who turned digests on. */
	by: { login: string; name?: string } | null;
	/** When the next digest goes out, ms since the epoch. */
	nextAt: number | null;
	/** The latest digests, newest first. */
	runs: DigestRun[];
	/** Whether the Discussion's repository is public, where known. */
	repoPublic: boolean | null;
	/** Whether this instance can send email at all (see the self-hosting docs). */
	emailAvailable: boolean;
	/** The owner: may change the settings. */
	canManage: boolean;
	/** How many people get it by email (confirmed), for the owner. */
	subscribers: number | null;
	/** Yours. */
	subscription: DigestSubscription | null;
	/**
	 * The next digest so far: as your email would say it, and as the
	 * Discussion would (for editors, once there's one to post).
	 */
	preview: { email: WeeklyDigest; discussion: WeeklyDigest | null; markdown: string | null };
}

/** `PUT /api/boards/:id/digest/subscription` */
export interface SubscribeRequest {
	email: string;
}

export type DigestError =
	| "sign_in_required"
	| "forbidden"
	| "owner_required"
	| "not_found"
	| "invalid"
	| "invalid_repo"
	| "invalid_category"
	| "discussions_off"
	| "not_installed"
	| "no_access"
	| "unreachable"
	| "email_unavailable"
	| "email_off"
	| "invalid_email"
	| "too_soon"
	| "expired";

/** Words for why something about digests couldn't be done. */
export function describeDigestError(
	error: DigestError | "offline",
	repo = "that repository",
): string {
	switch (error) {
		case "sign_in_required":
			return "Sign in with GitHub to get this board’s digest.";
		case "forbidden":
			return "You can’t get this board’s digest.";
		case "owner_required":
			return "Only the board’s owner can change its digest.";
		case "not_found":
			return "Couldn’t find this board.";
		case "invalid":
			return "That didn’t work. Check the settings and try again.";
		case "invalid_repo":
			return "That doesn’t look like a repository. Use owner/name.";
		case "invalid_category":
			return `${repo} has no Discussion category by that name.`;
		case "discussions_off":
			return `Discussions are turned off in ${repo}.`;
		case "not_installed":
			return `The Tack app isn’t installed on ${repo}.`;
		case "no_access":
			return `You can’t write to ${repo}.`;
		case "unreachable":
			return "Couldn’t reach GitHub. Try again in a moment.";
		case "email_unavailable":
			return "This Tack can’t send email yet: its owner needs to set it up.";
		case "email_off":
			return "The board’s owner hasn’t turned on email digests.";
		case "invalid_email":
			return "That doesn’t look like an email address.";
		case "too_soon":
			return "We just sent a confirmation email. Give it a few minutes before asking again.";
		case "expired":
			return "That link has expired, or was already used. Ask for a new one from the board.";
		case "offline":
			return "Couldn’t reach Tack. Check your connection and try again.";
	}
}

/** A plausible email address: one @, something on each side, a dot in the domain, no spaces. */
export function validEmail(email: string): boolean {
	return email.length <= 254 && /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:.]+$/.test(email);
}

/** An address shown back with most of it hidden: `p•••@example.com`. */
export function maskEmail(email: string): string {
	const at = email.lastIndexOf("@");
	if (at < 1) return "•••";
	return `${email[0]}•••${email.slice(at)}`;
}

// --- Time ------------------------------------------------------------------------

/** Whether a time zone name is one this runtime knows. */
export function validTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
}

const formatters = new Map<string, Intl.DateTimeFormat>();

interface ZonedParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

/** A moment's calendar date and time in a time zone. */
export function zonedParts(at: number, timeZone: string): ZonedParts {
	let format = formatters.get(timeZone);
	if (!format) {
		format = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		});
		formatters.set(timeZone, format);
	}
	const parts: Record<string, number> = {};
	for (const part of format.formatToParts(new Date(at))) {
		if (part.type !== "literal") parts[part.type] = Number(part.value);
	}
	return {
		year: parts.year ?? 1970,
		month: parts.month ?? 1,
		day: parts.day ?? 1,
		hour: (parts.hour ?? 0) % 24,
		minute: parts.minute ?? 0,
		second: parts.second ?? 0,
	};
}

/** A moment's calendar date in a time zone, `YYYY-MM-DD`. */
export function zonedDate(at: number, timeZone: string): string {
	const { year, month, day } = zonedParts(at, timeZone);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${year}-${pad(month)}-${pad(day)}`;
}

/** The moment it's `hour`:00 on a calendar date in a time zone (the first, if the clocks go back). */
export function zonedTime(date: string, hour: number, timeZone: string): number {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const wall = Date.UTC(y, m - 1, d, hour);
	// The zone's offset at a guess, then again at the answer, for the days the clocks change.
	let at = wall;
	for (let i = 0; i < 3; i++) {
		const p = zonedParts(at, timeZone);
		const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
		const next = at - (seen - wall);
		if (next === at) break;
		at = next;
	}
	return at;
}

function addDays(date: string, days: number): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** When the next digest goes out after `after`: the next chosen weekday, at the chosen hour, there. */
export function nextDigestAt(
	settings: Pick<DigestSettings, "weekday" | "hour" | "timeZone">,
	after: number,
): number {
	const today = zonedDate(after, settings.timeZone);
	for (let i = 0; i <= 8; i++) {
		const date = addDays(today, i);
		if (weekdayOf(date) !== settings.weekday) continue;
		const at = zonedTime(date, settings.hour, settings.timeZone);
		if (at > after) return at;
	}
	// Unreachable: a weekday comes round within eight days.
	return after + WEEK_MS;
}

export const WEEK_MS = 7 * 24 * 60 * 60_000;

/**
 * Which week a digest sent at `at` is for, as an ISO week (`2026-W41`) in
 * the owner's time zone: at most one digest goes to each place per week,
 * whatever retries, restarts or changes of day happen in it.
 */
export function weekKey(at: number, timeZone: string): string {
	const date = zonedDate(at, timeZone);
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const day = new Date(Date.UTC(y, m - 1, d));
	// The Thursday of this week decides its year.
	const weekday = day.getUTCDay() || 7;
	day.setUTCDate(day.getUTCDate() + 4 - weekday);
	const year = day.getUTCFullYear();
	const week = Math.ceil(((day.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
	return `${year}-W${String(week).padStart(2, "0")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A week in words: "6–12 Oct", "29 Sep – 5 Oct", with the year when asked. */
export function describeRange(from: number, to: number, timeZone: string, year = false): string {
	const a = zonedParts(from, timeZone);
	// The last day it covers: just before `to`.
	const b = zonedParts(Math.max(from, to - 1), timeZone);
	const end = `${b.day} ${MONTHS[b.month - 1]}${year ? ` ${b.year}` : ""}`;
	if (a.year === b.year && a.month === b.month) {
		return a.day === b.day ? end : `${a.day}–${end}`;
	}
	const start = `${a.day} ${MONTHS[a.month - 1]}${year && a.year !== b.year ? ` ${a.year}` : ""}`;
	return `${start} – ${end}`;
}

/** When a digest goes out, in words: "Mondays at 9:00 (Europe/London)". */
export function describeSchedule(settings: Pick<DigestSettings, "weekday" | "hour" | "timeZone">) {
	return `${WEEKDAY_NAMES[settings.weekday]}s at ${settings.hour}:00 (${settings.timeZone.replace(/_/g, " ")})`;
}

// --- The digest --------------------------------------------------------------------

export interface DigestPerson {
	name: string;
	login?: string;
	/** "added 4 stickies and a section, moved 2 cards" */
	summary: string;
	count: number;
}

export interface DigestDecision {
	id: string;
	title: string;
	/** Who decided it, by name. */
	by?: string;
	at: number;
}

export interface DigestAction {
	id: string;
	text: string;
	/** The owner's login. */
	owner?: string;
	/** Due, `YYYY-MM-DD`, and in words ("3 days late"). */
	due?: string;
	dueWords?: string;
	/** The issue it's linked to. */
	ref?: string;
}

export interface DigestItem {
	key: string;
	/** `acme/widgets#12` */
	ref: string;
	title: string;
	url: string;
	kind: "issue" | "pull";
	/** What happened, in words: "merged", "3 new comments". */
	activity: string[];
}

export interface DigestPush {
	by: string;
	at: number;
	applied: number;
	failed: number;
	summaries: string[];
}

/** A week of a board, for one audience. */
export interface WeeklyDigest {
	board: { id: string; title: string; url: string };
	/** The week it covers, ms since the epoch, and the zone it's told in. */
	from: number;
	to: number;
	timeZone: string;
	decisions: DigestDecision[];
	actions: { opened: DigestAction[]; done: DigestAction[]; overdue: DigestAction[] };
	items: DigestItem[];
	pushes: DigestPush[];
	/** Who did what on the board, most active first. */
	people: DigestPerson[];
	/** Edits beyond what the change log could list. */
	moreEdits: number;
}

/** What a digest is built from, already narrowed to what its audience may see. */
export interface DigestInput {
	board: { id: string; title: string; url: string };
	from: number;
	to: number;
	timeZone: string;
	/** Edits since `from` (the change log keeps the latest of each kind per shape). */
	edits: EditEntry[];
	more: number;
	shapes: ReadonlyMap<string, ShapeProps>;
	/** Card activity since `from`, only for cards this audience may read. */
	cards: CardActivity[];
	/** A card on the board, if this audience may read it. */
	card: (
		key: string,
	) => { title: string; url: string; kind: "issue" | "pull"; state: string } | null;
	pushes: PushDigest[];
}

/** At most this many of each list: a digest is a summary, the board has the rest. */
export const DIGEST_LIMITS = { decisions: 10, actions: 10, items: 25, pushes: 10, people: 12 };

const inRange = (at: number, input: { from: number; to: number }) =>
	at > input.from && at <= input.to;

function refOf(key: string): string {
	const parsed = parseRepoKey(key.replace(/[#!]\d+$/, ""));
	const item = /[#!]\d+$/.exec(key)?.[0] ?? "";
	return `${parsed?.repo ?? key.replace(/[#!]\d+$/, "")}${item}`;
}

function actionOf(
	id: string,
	shape: ShapeProps,
	today: string,
	done: boolean,
	/** The linked issue, only if this audience may read it: its key names the repository. */
	readable: boolean,
): DigestAction {
	const due = shape.due && shape.due.length === 10 ? shape.due : undefined;
	return {
		id,
		text: (shape.text ?? "").trim() || "Untitled action item",
		...(shape.owner?.login ? { owner: shape.owner.login } : {}),
		...(due ? { due, dueWords: describeDue(due, today, done) } : {}),
		...(shape.ref && readable ? { ref: refOf(shape.ref) } : {}),
	};
}

/** The week, from what the board kept: decisions, action items, GitHub, pushes and edits. */
export function buildWeeklyDigest(input: DigestInput): WeeklyDigest {
	const { shapes } = input;
	const today = zonedDate(input.to, input.timeZone);

	const decisions: DigestDecision[] = [];
	for (const [id, shape] of shapes) {
		if (shape.type !== "decision" || statusOf(shape) !== "decided" || !shape.decidedAt) continue;
		const at = Date.parse(shape.decidedAt);
		if (!Number.isFinite(at) || !inRange(at, input)) continue;
		decisions.push({
			id,
			title: (shape.title ?? "").trim() || "Untitled decision",
			...(shape.decidedBy?.name ? { by: shape.decidedBy.name } : {}),
			at,
		});
	}
	decisions.sort((a, b) => a.at - b.at);

	// Linked action items are done when their issue closes.
	const closedKeys = new Set(
		input.cards
			.filter((activity) => activity.kind === "closed" || activity.kind === "merged")
			.map((activity) => activity.key),
	);
	const addedActions = new Set(
		input.edits
			.filter((edit) => edit.kind === "added" && edit.type === "action")
			.map((edit) => edit.shape),
	);
	const opened: DigestAction[] = [];
	const done: DigestAction[] = [];
	const overdue: DigestAction[] = [];
	for (const [id, shape] of shapes) {
		if (shape.type !== "action") continue;
		const linked = typeof shape.ref === "string";
		const card = linked && shape.ref ? input.card(shape.ref) : null;
		const isDone = linked
			? card !== null && (card.state === "closed" || card.state === "merged")
			: Boolean(shape.done);
		const doneThisWeek = linked
			? shape.ref !== undefined && closedKeys.has(shape.ref)
			: Boolean(shape.done && inRange(Date.parse(shape.done), input));
		if (addedActions.has(id)) opened.push(actionOf(id, shape, today, isDone, card !== null));
		if (isDone && doneThisWeek) done.push(actionOf(id, shape, today, true, card !== null));
		if (!isDone && dueState(shape.due, today) === "overdue") {
			overdue.push(actionOf(id, shape, today, false, card !== null));
		}
	}
	overdue.sort((a, b) => daysBetween(b.due ?? today, a.due ?? today));

	const byItem = new Map<string, CardActivity[]>();
	for (const activity of input.cards) {
		let list = byItem.get(activity.key);
		if (!list) byItem.set(activity.key, (list = []));
		list.push(activity);
	}
	const items: DigestItem[] = [];
	for (const [key, activity] of byItem) {
		const card = input.card(key);
		if (!card) continue;
		items.push({
			key,
			ref: refOf(key),
			title: card.title,
			url: card.url,
			kind: card.kind,
			activity: activity.sort((a, b) => a.at - b.at).map(describeCardActivity),
		});
	}
	// What finished first: merged and closed lead, then the busiest.
	const finished = (item: DigestItem) =>
		item.activity.some((words) => words === "merged" || words === "closed") ? 1 : 0;
	items.sort((a, b) => finished(b) - finished(a) || b.activity.length - a.activity.length);

	const pushes: DigestPush[] = input.pushes
		.filter((push) => inRange(push.at, input))
		.map((push) => ({
			by: push.by.name || push.by.login,
			at: push.at,
			applied: push.applied,
			failed: push.failed,
			summaries: push.summaries,
		}));

	const edits = input.edits.filter((edit) => inRange(edit.at, input));
	const people = editsByPerson(edits).map(({ by, edits }) => personOf(by, edits));

	return {
		board: input.board,
		from: input.from,
		to: input.to,
		timeZone: input.timeZone,
		decisions: decisions.slice(0, DIGEST_LIMITS.decisions),
		actions: {
			opened: opened.slice(0, DIGEST_LIMITS.actions),
			done: done.slice(0, DIGEST_LIMITS.actions),
			overdue: overdue.slice(0, DIGEST_LIMITS.actions),
		},
		items: items.slice(0, DIGEST_LIMITS.items),
		pushes: pushes.slice(0, DIGEST_LIMITS.pushes),
		people: people.slice(0, DIGEST_LIMITS.people),
		moreEdits:
			input.more +
			people.slice(DIGEST_LIMITS.people).reduce((sum, person) => sum + person.count, 0),
	};
}

function personOf(by: Actor, edits: EditEntry[]): DigestPerson {
	return {
		name: actorName(by),
		...(by.login ? { login: by.login } : {}),
		summary: describeEdits(edits),
		count: edits.length,
	};
}

/** Whether nothing happened: a quiet week sends nothing. */
export function isQuietWeek(digest: WeeklyDigest): boolean {
	return (
		digest.decisions.length === 0 &&
		digest.actions.opened.length === 0 &&
		digest.actions.done.length === 0 &&
		digest.items.length === 0 &&
		digest.pushes.length === 0 &&
		digest.people.length === 0 &&
		digest.moreEdits === 0
	);
}

/** The headline counts, for a subject line or a summary: "2 decisions, 3 action items done". */
export function digestHighlights(digest: WeeklyDigest): string[] {
	const out: string[] = [];
	const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
	if (digest.decisions.length > 0) out.push(n(digest.decisions.length, "decision", "decisions"));
	if (digest.actions.done.length > 0)
		out.push(`${n(digest.actions.done.length, "action item", "action items")} done`);
	if (digest.actions.overdue.length > 0) out.push(`${digest.actions.overdue.length} overdue`);
	const finished = digest.items.filter((item) =>
		item.activity.some((words) => words === "merged" || words === "closed"),
	).length;
	if (finished > 0) out.push(`${finished} closed on GitHub`);
	if (out.length === 0 && digest.people.length > 0)
		out.push(n(digest.people.length, "person busy", "people busy"));
	return out;
}

/** The Discussion's title and the email's subject: "Roadmap: the week of 6–12 Oct". */
export function digestTitle(digest: WeeklyDigest): string {
	return `${digest.board.title}: the week of ${describeRange(digest.from, digest.to, digest.timeZone)}`;
}

/**
 * The Discussion post. Everything people wrote is defused (`quote`): no
 * mentions, links or formatting, so a digest never notifies anyone. Items
 * are named, not linked, so the post doesn't add a reference to every
 * issue's timeline each week; the board's link is the way in.
 */
export function digestMarkdown(digest: WeeklyDigest, options: { schedule?: string } = {}): string {
	const lines: string[] = [];
	const range = describeRange(digest.from, digest.to, digest.timeZone, true);
	lines.push(
		`What happened on [**${quote(digest.board.title, 120)}**](${digest.board.url}), ${range}.`,
	);
	const highlights = digestHighlights(digest);
	if (highlights.length > 0) lines.push("", `${highlights.join(" · ")}`);

	const section = (title: string, rows: string[]) => {
		if (rows.length === 0) return;
		lines.push("", `### ${title}`, "", ...rows);
	};
	const owner = (action: DigestAction) => (action.owner ? ` (${quote(action.owner)})` : "");
	section(
		"Decisions",
		digest.decisions.map(
			(d) => `- **${quote(d.title, 120)}**${d.by ? `, decided by ${quote(d.by)}` : ""}`,
		),
	);
	section("Action items", [
		...digest.actions.done.map((a) => `- ✅ ${quote(a.text, 120)}${owner(a)}`),
		...digest.actions.opened
			.filter((a) => !digest.actions.done.some((d) => d.id === a.id))
			.map(
				(a) =>
					`- 🆕 ${quote(a.text, 120)}${owner(a)}${a.dueWords ? `, due ${quote(a.dueWords)}` : ""}`,
			),
		...digest.actions.overdue.map(
			(a) => `- ⏰ ${quote(a.text, 120)}${owner(a)}${a.dueWords ? `, ${quote(a.dueWords)}` : ""}`,
		),
	]);
	section(
		"On GitHub",
		digest.items.map(
			(item) => `- ${quote(item.ref)} ${quote(item.title, 100)}: ${item.activity.join(", ")}`,
		),
	);
	section(
		"Pushed from the board",
		digest.pushes.map((push) => {
			const total = push.applied + push.failed;
			const what = `${total} change${total === 1 ? "" : "s"}${push.failed > 0 ? ` (${push.failed} failed)` : ""}`;
			const some = push.summaries.map((s) => quote(s, 80)).join("; ");
			return `- ${quote(push.by)} pushed ${what}${some ? `: ${some}` : ""}`;
		}),
	);
	section("On the board", [
		...digest.people.map((person) => `- **${quote(person.name)}** ${person.summary}`),
		...(digest.moreEdits > 0 ? [`- …and ${digest.moreEdits} more changes`] : []),
	]);
	if (isQuietWeek(digest)) lines.push("", "A quiet week: nothing changed.");
	lines.push(
		"",
		"---",
		"",
		`_A weekly digest from Tack${options.schedule ? `, ${options.schedule}` : ""}._ [Open the board](${digest.board.url})`,
	);
	return lines.join("\n");
}
