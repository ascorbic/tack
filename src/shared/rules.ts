import * as Y from "yjs";
import type { Card } from "./cards.ts";
import { keepInSection } from "./display.ts";
import type { ItemMention } from "./mentions.ts";
import { spotBelow, spotBeside, spotInSection } from "./placement.ts";
import { matchesQuery, unsupportedForRules } from "./search.ts";
import { repoKeyOf } from "./refs.ts";
import type { SizeOf } from "./sections.ts";
import { inboxSections } from "./inbox.ts";
import { addCardShape, updateMatches } from "./provenance.ts";
import { LOCAL_ORIGIN, type ShapeProps, cardRefs, shapesMap } from "./shapes.ts";
import { placeInSections, readShapes } from "./structure.ts";
import type { SearchQuery } from "./widgets.ts";

// Rules (#44): automation that places cards. A board's rules live in its
// document under `rules` (one Y.Map per rule, keyed by id), so everyone sees
// them and adding, pausing and deleting them are ordinary (undoable) edits.
// The server runs them on the webhook deliveries the board hears about (see
// src/server/rules.ts) and writes what they do with `RULE_ORIGIN`, which no
// client can undo: placed cards get provenance `{ via: "rule", source: id }`,
// each rule's `fired` and `lastAt` go up, and every action is logged in
// `ruleLog` (a Y.Array, newest last, the last `RULE_LOG_KEEP` kept).
//
// Rules only ever add cards, in free space (see placement.ts): they never
// move, change or remove anything people placed.
//
// Who can see what: rules run with the app's access, so they only place
// items from repositories that already have a card on the board. Someone
// who could add a card from a repository decided its items belong here;
// nothing else reaches the board by a rule, however public the board is.
// Card data still goes to each viewer as their own access allows (#10), and
// the log holds keys only, never titles.

/** The origin of the server's writes for rules: never undoable. */
export const RULE_ORIGIN = "rule";

/** Log entries kept in the document. */
export const RULE_LOG_KEEP = 60;

export type RuleTrigger =
	/** A pull request mentions (or, with `closesOnly`, closes) an item on the board. */
	| { kind: "pull-links"; closesOnly?: boolean }
	/** An item matching a query appears (opened, labelled, edited into matching). */
	| { kind: "matches"; query: SearchQuery };

export type RuleAction =
	/** Place it beside the item it links to. */
	| { kind: "beside-linked" }
	/** Add it to a section. */
	| { kind: "section"; section: string };

export interface RuleAuthor {
	name: string;
	color?: string;
	login?: string;
}

export interface Rule {
	id: string;
	trigger: RuleTrigger;
	action: RuleAction;
	enabled: boolean;
	createdBy: RuleAuthor;
	/** ISO 8601. */
	createdAt: string;
	/** A short name (`ruleName`), which the cards it places show. */
	name?: string;
	/** Set by the server: how many cards it has placed, and when it last did. */
	fired?: number;
	lastAt?: string;
}

export interface RuleLogEntry {
	id: string;
	rule: string;
	/** ISO 8601. */
	at: string;
	outcome: "placed" | "skipped";
	/** The item's key. */
	key: string;
	/** Placed beside this item. */
	near?: string;
	/** Placed in this section (or below it, if it was full). */
	section?: string;
	/** The card it placed. */
	shape?: string;
	/**
	 * Placed: `full` when the section had no room, so it went below. Skipped:
	 * `no_section` (deleted), `no_room` (nowhere free nearby).
	 */
	reason?: "full" | "no_section" | "no_room";
}

/**
 * A webhook delivery as a board hears it: the items it changed, under the
 * board's keys, and what each one's text refers to (see mentions.ts).
 */
export interface RepoActivity {
	delivery: string;
	event: string;
	action: string | null;
	/** Repository key, e.g. `github.com/acme/widgets`. */
	repo: string;
	cards: Card[];
	/** By card key: the items its text mentions or closes. */
	mentions: Record<string, ItemMention[]>;
}

export function rulesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
	return doc.getMap("rules");
}

export function ruleLog(doc: Y.Doc): Y.Array<RuleLogEntry> {
	return doc.getArray("ruleLog");
}

function isQuery(value: unknown): value is SearchQuery {
	const query = value as SearchQuery | undefined;
	return query?.kind === "search" && typeof query.q === "string" && typeof query.host === "string";
}

/** A rule as stored, or null if it's malformed (another client's bug, an old version). */
export function readRule(map: unknown): Rule | null {
	// Anything but a Y.Map isn't a rule this code wrote (and wouldn't merge).
	if (!(map instanceof Y.Map)) return null;
	const rule = map.toJSON() as Partial<Rule>;
	const trigger = rule.trigger as RuleTrigger | undefined;
	const action = rule.action as RuleAction | undefined;
	if (typeof rule.id !== "string" || !trigger || !action) return null;
	if (trigger.kind === "pull-links" ? action.kind !== "beside-linked" : trigger.kind !== "matches")
		return null;
	if (trigger.kind === "matches" && (!isQuery(trigger.query) || action.kind !== "section"))
		return null;
	if (action.kind === "section" && typeof action.section !== "string") return null;
	return {
		id: rule.id,
		trigger,
		action,
		enabled: rule.enabled !== false,
		createdBy: rule.createdBy ?? { name: "Someone" },
		createdAt: rule.createdAt ?? new Date(0).toISOString(),
		...(typeof rule.name === "string" ? { name: rule.name } : {}),
		...(typeof rule.fired === "number" ? { fired: rule.fired } : {}),
		...(typeof rule.lastAt === "string" ? { lastAt: rule.lastAt } : {}),
	};
}

/** Every rule on the board, oldest first. */
export function listRules(doc: Y.Doc): Rule[] {
	return [...rulesMap(doc).values()]
		.map(readRule)
		.filter((rule): rule is Rule => rule !== null)
		.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

export function readRuleLog(doc: Y.Doc): RuleLogEntry[] {
	return ruleLog(doc).toArray();
}

// Pausing every rule at once, for a live session: nothing lands on the board
// mid-discussion. The pause lives in the document (`rulesPause`: `paused`,
// written by whoever paused, and `held`, by the server), so everyone sees
// it. While paused, the server keeps the deliveries rules would have acted
// on, and runs them when the rules resume, so nothing is missed.

/** The origin of pausing and resuming: a session switch, not an undoable edit. */
export const RULES_PAUSE_ORIGIN = "rules-pause";

export interface RulesPause {
	by: RuleAuthor;
	/** ISO 8601. */
	at: string;
	/** Deliveries the server is holding for when the rules resume. */
	held: number;
}

export function rulesPauseMap(doc: Y.Doc): Y.Map<unknown> {
	return doc.getMap("rulesPause");
}

/** Whether rules are paused for the session, and by whom; null if they're running. */
export function readRulesPause(doc: Y.Doc): RulesPause | null {
	const map = rulesPauseMap(doc);
	const paused = map.get("paused") as { by?: RuleAuthor; at?: string } | undefined;
	if (!paused || typeof paused !== "object") return null;
	const held = map.get("held");
	return {
		by: paused.by ?? { name: "Someone" },
		at: typeof paused.at === "string" ? paused.at : new Date(0).toISOString(),
		held: typeof held === "number" && held > 0 ? held : 0,
	};
}

/** Pause every rule until someone resumes them. */
export function pauseRules(doc: Y.Doc, by: RuleAuthor, origin: unknown = RULES_PAUSE_ORIGIN): void {
	if (readRulesPause(doc)) return;
	doc.transact(
		() => rulesPauseMap(doc).set("paused", { by, at: new Date().toISOString() }),
		origin,
	);
}

/** Let rules run again: the server places what it held. */
export function resumeRules(doc: Y.Doc, origin: unknown = RULES_PAUSE_ORIGIN): void {
	if (!rulesPauseMap(doc).has("paused")) return;
	doc.transact(() => rulesPauseMap(doc).delete("paused"), origin);
}

/**
 * Why a rule can't be added, or null if it can: a query the server can't
 * check for itself, or a section that isn't there.
 */
export function ruleProblem(doc: Y.Doc, trigger: RuleTrigger, action: RuleAction): string | null {
	if (trigger.kind === "matches") {
		if (!trigger.query.q.trim()) return "Write a query for the items to add.";
		const problem = unsupportedForRules(trigger.query.q);
		if (problem) return problem;
	}
	if (action.kind === "section") {
		if (shapesMap(doc).get(action.section)?.get("type") !== "section") {
			return "Pick a section to add them to.";
		}
	}
	return null;
}

/** Add a rule, as an undoable local edit. Returns its id. */
export function addRule(
	doc: Y.Doc,
	trigger: RuleTrigger,
	action: RuleAction,
	createdBy: RuleAuthor,
	options: { id?: string; enabled?: boolean; origin?: unknown } = {},
): string {
	const id = options.id ?? crypto.randomUUID();
	doc.transact(() => {
		const rule = new Y.Map<unknown>();
		rule.set("id", id);
		rule.set("trigger", trigger);
		rule.set("action", action);
		rule.set("enabled", options.enabled ?? true);
		rule.set("createdBy", createdBy);
		rule.set("createdAt", new Date().toISOString());
		// What the cards it places say brought them (see provenance.ts).
		rule.set(
			"name",
			ruleName({ trigger, action }, (section) => sectionTitleIn(doc, section)),
		);
		rulesMap(doc).set(id, rule);
	}, options.origin ?? LOCAL_ORIGIN);
	return id;
}

export function setRuleEnabled(doc: Y.Doc, id: string, enabled: boolean): void {
	const rule = rulesMap(doc).get(id);
	if (!rule || rule.get("enabled") === enabled) return;
	doc.transact(() => rule.set("enabled", enabled), LOCAL_ORIGIN);
}

export function deleteRule(doc: Y.Doc, id: string): void {
	if (!rulesMap(doc).has(id)) return;
	doc.transact(() => rulesMap(doc).delete(id), LOCAL_ORIGIN);
}

/** What the engine remembers between deliveries: which items each rule has placed. */
export interface RuleMemory {
	placed(rule: string, key: string): boolean;
	remember(rule: string, key: string): void;
}

/** An in-memory `RuleMemory`, for tests and the playground. */
export function memoryOfRules(): RuleMemory {
	const placed = new Set<string>();
	return {
		placed: (rule, key) => placed.has(`${rule} ${key}`),
		remember: (rule, key) => void placed.add(`${rule} ${key}`),
	};
}

/** Actions after which an item counts as appearing. */
const IGNORED_ACTIONS = new Set(["deleted", "closed", "locked", "unlocked", "pinned", "unpinned"]);

/**
 * Run a board's rules on a delivery, writing what they do (cards, stats,
 * log) into the document in one transaction with `origin`. A rule places an
 * item at most once, ever: if someone removes it, it stays removed. Returns
 * the log entries written.
 */
export function runRules(
	doc: Y.Doc,
	activity: RepoActivity,
	memory: RuleMemory,
	options: { origin?: unknown; now?: Date; sizeOf?: SizeOf } = {},
): RuleLogEntry[] {
	const rules = listRules(doc).filter((rule) => rule.enabled);
	if (rules.length === 0 || activity.cards.length === 0) return [];
	if (activity.action && IGNORED_ACTIONS.has(activity.action)) {
		// A closed pull request can still have just been linked; anything else, no.
		if (activity.event !== "pull_request") return [];
	}
	const onBoard = cardRefs(doc);
	// Only items from repositories already on the board (see above).
	const boardRepos = new Set([...onBoard].map(repoKeyOf));
	const at = (options.now ?? new Date()).toISOString();
	const entries: RuleLogEntry[] = [];
	let shapes: Map<string, ShapeProps> | null = null;
	const current = () => (shapes ??= readShapes(doc));

	doc.transact(() => {
		for (const card of activity.cards) {
			if (!boardRepos.has(repoKeyOf(card.key))) continue;
			for (const rule of rules) {
				if (onBoard.has(card.key)) break;
				if (memory.placed(rule.id, card.key)) continue;
				const entry = applyRule(doc, rule, card, activity, onBoard, current(), at, options.sizeOf);
				if (!entry) continue;
				entries.push(entry);
				if (entry.outcome !== "placed" || !entry.shape) continue;
				memory.remember(rule.id, card.key);
				onBoard.add(card.key);
				shapes = null;
				const map = rulesMap(doc).get(rule.id);
				map?.set("fired", (rule.fired ?? 0) + 1);
				map?.set("lastAt", at);
				rule.fired = (rule.fired ?? 0) + 1;
			}
		}
		if (entries.length > 0) {
			const log = ruleLog(doc);
			log.push(entries);
			if (log.length > RULE_LOG_KEEP) log.delete(0, log.length - RULE_LOG_KEEP);
		}
	}, options.origin ?? RULE_ORIGIN);
	return entries;
}

function applyRule(
	doc: Y.Doc,
	rule: Rule,
	card: Card,
	activity: RepoActivity,
	onBoard: ReadonlySet<string>,
	shapes: Map<string, ShapeProps>,
	at: string,
	sizeOf?: SizeOf,
): RuleLogEntry | null {
	const base = { id: crypto.randomUUID(), rule: rule.id, at, key: card.key };
	if (rule.trigger.kind === "pull-links") {
		if (card.kind !== "pull") return null;
		const closesOnly = rule.trigger.closesOnly;
		const linked = (activity.mentions[card.key] ?? []).filter(
			(mention) => onBoard.has(mention.key) && (!closesOnly || mention.closes),
		);
		const first = linked[0];
		if (!first) return null;
		const anchor = [...shapes].find(
			([, shape]) => shape.type === "card" && shape.ref === first.key,
		)?.[0];
		if (!anchor) return null;
		const spot = spotBeside(shapes, anchor, undefined, sizeOf);
		if (!spot) return { ...base, outcome: "skipped", near: first.key, reason: "no_room" };
		const shape = place(doc, card.key, spot, rule.id);
		return { ...base, outcome: "placed", near: first.key, shape };
	}

	if (rule.action.kind !== "section") return null;
	if (matchesQuery(card, rule.trigger.query) !== true) return null;
	const section = rule.action.section;
	if (shapes.get(section)?.type !== "section") {
		// Say so once, not on every delivery.
		const last = [...ruleLog(doc).toArray()].reverse().find((entry) => entry.rule === rule.id);
		if (last?.reason === "no_section") return null;
		return { ...base, outcome: "skipped", section, reason: "no_section" };
	}
	const inside = spotInSection(shapes, section, undefined, sizeOf);
	const spot = inside ?? spotBelow(shapes, section, undefined, sizeOf);
	if (!spot) return { ...base, outcome: "skipped", section, reason: "no_room" };
	const shape = place(doc, card.key, spot, rule.id);
	// A section showing a list takes it, wherever the spot was (display.ts).
	if (inside) keepInSection(doc, shape, section, sizeOf);
	return { ...base, outcome: "placed", section, shape, ...(inside ? {} : { reason: "full" }) };
}

function place(doc: Y.Doc, key: string, at: { x: number; y: number }, rule: string): string {
	const id = crypto.randomUUID();
	addCardShape(doc, id, { ref: key, x: at.x, y: at.y }, { via: "rule", source: rule });
	placeInSections(doc, [id]);
	return id;
}

/**
 * Bring "no longer matches" marks up to date (see provenance.ts) for the
 * cards a delivery changed: each card an inbox or a matching rule brought is
 * checked against that inbox's or rule's query, with the delivery's data
 * (the app's view, the same for everyone). A card that can't answer the
 * query (`milestone:`, say) is left as it is. Never moves or removes a card.
 * Returns how many cards were marked or unmarked.
 */
export function refreshMatches(
	doc: Y.Doc,
	activity: Pick<RepoActivity, "cards">,
	origin: unknown = RULE_ORIGIN,
): number {
	if (activity.cards.length === 0) return 0;
	const sources = new Map<string, SearchQuery>(inboxSections(doc));
	for (const rule of listRules(doc)) {
		if (rule.trigger.kind === "matches") sources.set(rule.id, rule.trigger.query);
	}
	let changed = 0;
	doc.transact(() => {
		for (const [source, query] of sources) {
			const answers = new Map(
				activity.cards.map((card) => [card.key, matchesQuery(card, query) ?? undefined]),
			);
			const update = updateMatches(doc, source, (key) => answers.get(key), { origin });
			changed += update.marked.length + update.cleared.length;
		}
	}, origin);
	return changed;
}

/** A rule's short name, for the cards it places: "Pull requests beside their issues". */
export function ruleName(
	rule: Pick<Rule, "trigger" | "action">,
	sectionTitle?: (id: string) => string | null,
): string {
	if (rule.trigger.kind === "pull-links") {
		return rule.trigger.closesOnly
			? "Closing pull requests beside their issues"
			: "Pull requests beside their issues";
	}
	const title = rule.action.kind === "section" ? sectionTitle?.(rule.action.section) : null;
	return title ? `New matches into “${title}”` : "New matches into a section";
}

function sectionTitleIn(doc: Y.Doc, id: string): string | null {
	const title = shapesMap(doc).get(id)?.get("title");
	return typeof title === "string" && title.trim() ? title.trim() : null;
}

/** The short form of an item's key, as people write it: `#12`, or `owner/repo#12` from elsewhere. */
export function shortRef(key: string, from?: string): string {
	const match = /^[^/]+\/(.+?)([#!]\d+)$/.exec(key);
	if (!match) return key;
	const [, repo = "", item = ""] = match;
	return from && repoKeyOf(key) === from ? item : `${repo}${item}`;
}

/** A rule in words, for the rules panel: "When a pull request mentions a card here" / "place it beside the card". */
export function describeRule(
	rule: Pick<Rule, "trigger" | "action">,
	sectionTitle?: (id: string) => string | null,
): { when: string; does: string } {
	const when =
		rule.trigger.kind === "pull-links"
			? rule.trigger.closesOnly
				? "When a pull request closes a card on this board"
				: "When a pull request mentions a card on this board"
			: `When an item matching ${rule.trigger.query.q} appears`;
	const does =
		rule.action.kind === "beside-linked"
			? "place it beside that card"
			: `add it to ${quoteTitle(sectionTitle?.(rule.action.section))}`;
	return { when, does };
}

function quoteTitle(title: string | null | undefined): string {
	if (title === null) return "a deleted section";
	return title ? `“${title}”` : "an untitled section";
}
