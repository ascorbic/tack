import { generateNKeysBetween } from "fractional-indexing";
import * as Y from "yjs";
import type { Person } from "./auth.ts";
import type { Thumbnail } from "./boards.ts";
import { readVotes as readDotVotes } from "./dotvotes.ts";
import { type PreparedPlan, preparedMap, readPrepared, readStep } from "./prepared.ts";
import { parseRepoKey } from "./refs.ts";
import { type Rule, type RuleAction, type RuleTrigger, readRule, rulesMap } from "./rules.ts";
import { parseSession } from "./silent.ts";
import { shapesMap } from "./shapes.ts";
import { sketch } from "./thumbnail.ts";

// Templates (#53): boards to start from. A template is a board's content as
// plain JSON (shapes, rules and prepared facilitation, see prepared.ts),
// with placeholders for the repositories it's about, filled in when a board
// is made from it, so its widgets, inboxes and rules point at the right
// repositories:
//
// | placeholder | becomes                                             |
// | ----------- | --------------------------------------------------- |
// | `{{repo}}`  | the first repository, `owner/name`                  |
// | `{{repoN}}` | the Nth (`{{repo2}}`, `{{repo3}}`…)                 |
// | `{{repos}}` | every repository, as search qualifiers: `repo:a/b repo:c/d` |
// | `{{host}}`  | the first repository's forge host, e.g. `github.com` |
//
// A placeholder with no repository to fill it empties the setting it's in
// (a widget's search, an inbox's query, a rule), which then reads as not set
// up yet; in text and titles just the placeholder goes.
//
// Built-in templates are in builtInTemplates.ts; templates saved from boards
// are kept per instance by the `Directory` (`extractTemplate` makes one). A
// board made from a template gets fresh ids for everything, and none of the
// last session's state: votes, ballots, silent sessions, inbox dismissals,
// provenance, staged changes.

export const TEMPLATE_VERSION = 1;

/** Transaction origin for writing a template into a new board: it's how the board starts, so never undoable. */
export const TEMPLATE_ORIGIN = "template";

/** The most a template's content may weigh, as JSON. */
export const TEMPLATE_MAX_BYTES = 512 * 1024;
export const TEMPLATE_TITLE_MAX = 80;
export const TEMPLATE_DESCRIPTION_MAX = 280;
/** Most repositories a template can be made with. */
export const TEMPLATE_REPOS_MAX = 6;

export interface TemplateRule {
	trigger: RuleTrigger;
	action: RuleAction;
	name?: string;
	enabled?: boolean;
}

export interface TemplateContent {
	version: typeof TEMPLATE_VERSION;
	/** Shapes by id, as plain properties. */
	shapes: Record<string, Record<string, unknown>>;
	rules?: Record<string, TemplateRule>;
	prepared?: Record<string, PreparedPlan>;
}

/** Which repositories a template asks for when a board is made from it. */
export interface TemplateRepos {
	/** At least this many (0: it works without). */
	min: number;
	max: number;
	/** Filled in to start with: a saved template's own repositories. */
	defaults?: string[];
	/** What they're for, e.g. "Where issues are triaged". */
	hint?: string;
}

/** What's in a template, counted, for its card in the picker. */
export interface TemplateSummary {
	sections: number;
	stickies: number;
	widgets: number;
	rules: number;
	prepared: number;
	actions: number;
	/** Widget kinds, in the order they appear. */
	widgetKinds: string[];
	/** Section titles, in reading order. */
	sectionTitles: string[];
}

/** A template as the "New board" picker shows it. */
export interface TemplateInfo {
	/** Built-ins are `tack:{name}`; saved ones have random ids. */
	id: string;
	title: string;
	description: string;
	builtIn: boolean;
	/** Shown first and biggest in the picker. */
	featured?: boolean;
	repos: TemplateRepos | null;
	summary: TemplateSummary;
	thumbnail: Thumbnail | null;
	/** Saved templates: who saved it, and when. */
	owner?: Person | null;
	createdAt?: number;
	/** Whether the viewer may delete it: whoever saved it, or an admin. */
	canDelete?: boolean;
	/** Whether the board made from it has somewhere to carry action items into. */
	collectsActions?: boolean;
}

/** `GET /api/templates`: templates saved on this instance, newest first. */
export interface TemplateList {
	templates: TemplateInfo[];
	/** Whether the viewer may save boards as templates. */
	canSave: boolean;
}

/** `POST /api/templates` */
export interface SaveTemplateRequest {
	board: string;
	title: string;
	description?: string;
	/** Keep stickies, cards, decisions and action items too, not just the board's structure. */
	keepContent?: boolean;
}

export type TemplateError =
	| "sign_in_required"
	| "forbidden"
	| "not_found"
	| "invalid"
	| "too_large"
	| "owner_required";

// --- Filling in repositories -------------------------------------------------------

const PLACEHOLDER = /\{\{\s*(repos|repo\d*|host)\s*\}\}/g;

/** Keys whose strings are words for people, where a missing repository just drops out. */
const PROSE = new Set(["text", "title", "label", "description", "name"]);

/** Keys that are never filled in: items' keys are exactly what they say. */
const LITERAL = new Set(["ref", "type", "id", "widget"]);

function fillString(value: string, repos: readonly string[], prose: boolean): string {
	let missing = false;
	const filled = value.replace(PLACEHOLDER, (_match, name: string) => {
		const keys = repos.map(parseRepoKey).filter((key) => key !== null);
		if (name === "host") {
			return keys[0]?.host ?? "github.com";
		}
		if (name === "repos") {
			if (keys.length === 0) missing = true;
			return keys.map((key) => `repo:${key.repo}`).join(" ");
		}
		const index = name === "repo" ? 0 : Number(name.slice(4)) - 1;
		const key = keys[index];
		if (!key) {
			missing = true;
			return "";
		}
		return key.repo;
	});
	if (!missing) return filled;
	return prose ? filled.replace(/\s{2,}/g, " ").trim() : "";
}

function fillValue(value: unknown, repos: readonly string[], key?: string): unknown {
	if (key !== undefined && LITERAL.has(key)) return value;
	if (typeof value === "string")
		return fillString(value, repos, key !== undefined && PROSE.has(key));
	if (Array.isArray(value)) return value.map((item) => fillValue(item, repos));
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillValue(v, repos, k)]));
	}
	return value;
}

/** Whether a template's content mentions repositories, so making a board from it asks for some. */
export function usesRepos(content: TemplateContent): boolean {
	return JSON.stringify(content).match(PLACEHOLDER) !== null;
}

/**
 * A template's content with its repositories filled in (repository keys,
 * `github.com/owner/name`, first one first). Settings left without a
 * repository are taken out: inboxes without a query, rules without one.
 */
export function fillTemplate(content: TemplateContent, repos: readonly string[]): TemplateContent {
	const shapes = fillValue(content.shapes, repos) as TemplateContent["shapes"];
	for (const shape of Object.values(shapes)) {
		const inbox = shape.inbox as { query?: { q?: unknown } } | undefined;
		if (inbox && !(typeof inbox.query?.q === "string" && inbox.query.q.trim())) delete shape.inbox;
	}
	const rules: Record<string, TemplateRule> = {};
	for (const [id, rule] of Object.entries(
		(fillValue(content.rules ?? {}, repos) as Record<string, TemplateRule>) ?? {},
	)) {
		if (rule.trigger.kind === "matches" && !rule.trigger.query.q.trim()) continue;
		rules[id] = rule;
	}
	return {
		version: TEMPLATE_VERSION,
		shapes,
		...(Object.keys(rules).length ? { rules } : {}),
		...(content.prepared ? { prepared: fillValue(content.prepared, repos) as never } : {}),
	};
}

// --- Making a board from a template ---------------------------------------------------

/** Properties that belong to a session, not a template: they're never carried in or out. */
const SESSION_KEYS: Record<string, readonly string[]> = {
	card: ["provenance", "unmatched"],
	decision: ["votes", "writeback", "ref", "decidedAt", "decidedBy", "supersededBy"],
	section: ["silent", "dismissed"],
	sticky: ["silent"],
	action: ["issue", "carried"],
};

/** Keys whose strings are never references to shapes, whatever a shape happens to be called. */
const NOT_REFERENCES = new Set([
	...PROSE,
	...LITERAL,
	"kind",
	"color",
	"font",
	"size",
	"route",
	"arrow",
	"status",
	"host",
	"q",
	"source",
	// A stack's suggested name and the hash of what it was made from.
	"suggested",
	// A stack the server couldn't name, and a hash of its members (which a
	// copy's new ids won't match, so it's looked at again).
	"unnameable",
]);

/** Strings that are a template's shape ids (connector ends, parents, sections), pointed at their copies. */
function remap(value: unknown, ids: ReadonlyMap<string, string>, key?: string): unknown {
	if (key !== undefined && NOT_REFERENCES.has(key)) return value;
	if (typeof value === "string") return ids.get(value) ?? value;
	if (Array.isArray(value)) return value.map((item) => remap(item, ids));
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, ids, k)]));
	}
	return value;
}

export interface InstantiateOptions {
	repos?: readonly string[];
	/** Who's making the board, for its rules. */
	by: { name: string; color?: string; login?: string };
	now?: string;
	/** Fresh ids; tests pass a counter. */
	newId?: () => string;
}

export interface InstantiateResult {
	shapes: number;
	rules: number;
	prepared: number;
}

/**
 * Write a template into a document, with its repositories filled in and
 * fresh ids throughout, stacked in the template's order. One transaction
 * with `TEMPLATE_ORIGIN`: it's how the board starts, so nothing to undo.
 */
export function instantiateTemplate(
	doc: Y.Doc,
	content: TemplateContent,
	{
		repos = [],
		by,
		now = new Date().toISOString(),
		newId = () => crypto.randomUUID(),
	}: InstantiateOptions,
): InstantiateResult {
	const filled = fillTemplate(content, repos);
	// References are to shapes; rules and steps only need ids of their own.
	const ids = new Map<string, string>();
	for (const id of Object.keys(filled.shapes)) ids.set(id, newId());

	const ordered = Object.entries(filled.shapes).sort(([, a], [, b]) => {
		const za = typeof a.z === "string" ? a.z : "";
		const zb = typeof b.z === "string" ? b.z : "";
		return za < zb ? -1 : za > zb ? 1 : 0;
	});
	const zs = ordered.length ? generateNKeysBetween(null, null, ordered.length) : [];
	const result: InstantiateResult = { shapes: 0, rules: 0, prepared: 0 };

	doc.transact(() => {
		const shapes = shapesMap(doc);
		ordered.forEach(([oldId, props], i) => {
			const type = typeof props.type === "string" ? props.type : "";
			if (!type || !Number.isFinite(Number(props.x)) || !Number.isFinite(Number(props.y))) return;
			const skip = SESSION_KEYS[type] ?? [];
			const shape = new Y.Map<unknown>();
			for (const [key, value] of Object.entries(props)) {
				if (key === "z" || value === undefined || skip.includes(key)) continue;
				shape.set(key, key === "type" ? value : remap(value, ids, key));
			}
			shape.set("z", zs[i]);
			// (A Y.Map can't be read until it's in the document: ask the props.)
			if (props.parent === undefined) shape.set("parent", null);
			// Nested maps that only merge if they're made with the shape.
			if (type === "decision") {
				shape.set("votes", new Y.Map());
				shape.set("status", "proposed");
			}
			if (type === "section" && props.inbox) shape.set("dismissed", new Y.Map());
			shapes.set(ids.get(oldId) as string, shape);
			result.shapes++;
		});

		for (const rule of Object.values(filled.rules ?? {})) {
			const id = newId();
			const remapped = remap(rule, ids) as TemplateRule;
			const map = new Y.Map<unknown>();
			map.set("id", id);
			map.set("trigger", remapped.trigger);
			map.set("action", remapped.action);
			map.set("enabled", remapped.enabled !== false);
			map.set("createdBy", {
				name: by.name,
				...(by.color ? { color: by.color } : {}),
				...(by.login ? { login: by.login } : {}),
			});
			map.set("createdAt", now);
			if (remapped.name) map.set("name", remapped.name);
			rulesMap(doc).set(id, map);
			// Only rules the server would read are kept.
			if (readRule(rulesMap(doc).get(id))) result.rules++;
			else rulesMap(doc).delete(id);
		}

		const prepared = preparedMap(doc);
		for (const step of Object.values(filled.prepared ?? {})) {
			const id = newId();
			const read = readStep(id, remap(step, ids));
			if (!read) continue;
			const { id: _id, startedAt: _at, startedBy: _by, ...plain } = read;
			prepared.set(id, plain);
			result.prepared++;
		}
	}, TEMPLATE_ORIGIN);
	return result;
}

// --- Saving a board as a template ------------------------------------------------------

/** Shapes that are a board's structure, kept in every template made from it. */
const STRUCTURE = new Set(["section", "text", "widget", "connector"]);

export interface ExtractOptions {
	/** Keep stickies, cards, decisions and action items too. */
	keepContent?: boolean;
}

export interface Extracted {
	content: TemplateContent;
	repos: TemplateRepos | null;
}

/**
 * A board as a template: its structure (sections, text, widgets, the
 * connectors between what's kept) and rules, and with `keepContent`
 * everything on it, without any session's state. Dot votes and silent
 * sections become prepared steps, ready to start again. The repositories
 * its widgets, inboxes and rules read become placeholders, defaulting to
 * those repositories (`parameterise`).
 */
export function extractTemplate(
	doc: Y.Doc,
	{ keepContent = false }: ExtractOptions = {},
): Extracted {
	const shapes: TemplateContent["shapes"] = {};
	const kept = new Set<string>();
	for (const [id, map] of shapesMap(doc)) {
		const type = map.get("type");
		if (typeof type !== "string" || type === "connector") continue;
		if (!keepContent && !STRUCTURE.has(type)) continue;
		kept.add(id);
	}
	for (const [id, map] of shapesMap(doc)) {
		const props = map.toJSON() as Record<string, unknown>;
		const type = props.type as string;
		if (type === "connector") {
			const ends = [props.from, props.to] as ({ shape?: unknown } | undefined)[];
			if (ends.some((end) => typeof end?.shape === "string" && !kept.has(end.shape))) continue;
		} else if (!kept.has(id)) {
			continue;
		}
		for (const key of SESSION_KEYS[type] ?? []) delete props[key];
		if (type === "action") delete props.done;
		if (typeof props.parent === "string" && !kept.has(props.parent)) props.parent = null;
		shapes[id] = props;
	}

	const rules: Record<string, TemplateRule> = {};
	for (const [id, map] of rulesMap(doc)) {
		const rule = readRule(map);
		if (!rule) continue;
		if (rule.action.kind === "section" && !kept.has(rule.action.section)) continue;
		rules[id] = {
			trigger: rule.trigger,
			action: rule.action,
			...(rule.name ? { name: rule.name } : {}),
			...(rule.enabled ? {} : { enabled: false }),
		};
	}

	const prepared: NonNullable<TemplateContent["prepared"]> = {};
	let order = 0;
	for (const step of readPrepared(doc)) {
		const { id, startedAt: _at, startedBy: _by, ...plain } = step;
		prepared[id] = { ...plain, order: order++ };
	}
	const covered = new Set(
		Object.values(prepared).map((step) =>
			step.kind === "silent"
				? `silent:${step.section}`
				: step.kind === "vote"
					? `vote:${step.scope}`
					: "",
		),
	);
	for (const [id, map] of shapesMap(doc)) {
		if (map.get("type") !== "section" || !kept.has(id)) continue;
		if (!parseSession(map.get("silent")) || covered.has(`silent:${id}`)) continue;
		prepared[`silent-${id}`] = { kind: "silent", section: id, label: "", order: order++ };
	}
	for (const vote of readDotVotes(doc)) {
		if ((vote.scope && !kept.has(vote.scope)) || covered.has(`vote:${vote.scope}`)) continue;
		covered.add(`vote:${vote.scope}`);
		prepared[`vote-${vote.id}`] = {
			kind: "vote",
			scope: vote.scope,
			dots: vote.dots,
			hidden: vote.hidden,
			...(vote.reactions ? { reactions: true } : {}),
			...(vote.title ? { title: vote.title } : {}),
			label: "",
			order: order++,
		};
	}

	return parameterise({
		version: TEMPLATE_VERSION,
		shapes,
		...(Object.keys(rules).length ? { rules } : {}),
		...(Object.keys(prepared).length ? { prepared } : {}),
	});
}

const REPO_QUALIFIER = /(^|\s)(-?)repo:("?)([\w.-]+\/[\w.-]+)\3/gi;

/** Where a template reads repositories: queries and repository fields, never text or cards. */
function eachSetting(
	content: TemplateContent,
	visit: (value: string, kind: "query" | "repo", host: string) => string,
): TemplateContent {
	const fix = (config: Record<string, unknown>, keys: { q?: string[]; repo?: string[] }) => {
		const host = typeof config.host === "string" ? config.host : "github.com";
		for (const key of keys.q ?? []) {
			if (typeof config[key] === "string")
				config[key] = visit(config[key] as string, "query", host);
		}
		for (const key of keys.repo ?? []) {
			if (typeof config[key] === "string") config[key] = visit(config[key] as string, "repo", host);
		}
	};
	const copy = structuredClone(content);
	for (const shape of Object.values(copy.shapes)) {
		if (shape.type === "widget" && shape.config && typeof shape.config === "object") {
			fix(shape.config as Record<string, unknown>, { q: ["q"], repo: ["repo"] });
		}
		const inbox = shape.inbox as { query?: Record<string, unknown> } | undefined;
		if (shape.type === "section" && inbox?.query) fix(inbox.query, { q: ["q"] });
	}
	for (const rule of Object.values(copy.rules ?? {})) {
		if (rule.trigger.kind === "matches") {
			fix(rule.trigger.query as unknown as Record<string, unknown>, { q: ["q"] });
		}
	}
	return copy;
}

/**
 * Turn the repositories a template's settings read into placeholders, most
 * used first (`{{repo}}`, `{{repo2}}`…), remembering them as the defaults.
 */
export function parameterise(content: TemplateContent): Extracted {
	const counts = new Map<string, number>();
	const note = (host: string, repo: string) => {
		const key = `${host}/${repo}`.toLowerCase();
		counts.set(key, (counts.get(key) ?? 0) + 1);
	};
	eachSetting(content, (value, kind, host) => {
		if (kind === "repo") {
			if (/^[\w.-]+\/[\w.-]+$/.test(value)) note(host, value);
		} else {
			for (const match of value.matchAll(REPO_QUALIFIER)) note(host, match[4] ?? "");
		}
		return value;
	});
	const repos = [...counts]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([key]) => key)
		.slice(0, TEMPLATE_REPOS_MAX);
	if (repos.length === 0) return { content, repos: null };
	const placeholder = (host: string, repo: string) => {
		const index = repos.indexOf(`${host}/${repo}`.toLowerCase());
		return index === -1 ? null : index === 0 ? "{{repo}}" : `{{repo${index + 1}}}`;
	};
	const parameterised = eachSetting(content, (value, kind, host) => {
		if (kind === "repo") return placeholder(host, value) ?? value;
		return value.replace(REPO_QUALIFIER, (match, space: string, not: string, _q, repo: string) => {
			const name = placeholder(host, repo);
			return name ? `${space}${not}repo:${name}` : match;
		});
	});
	return { content: parameterised, repos: { min: 0, max: repos.length, defaults: repos } };
}

// --- Describing a template -------------------------------------------------------------

/** What's in a template, for its card. */
export function summarise(content: TemplateContent): TemplateSummary {
	const summary: TemplateSummary = {
		sections: 0,
		stickies: 0,
		widgets: 0,
		rules: Object.keys(content.rules ?? {}).length,
		prepared: Object.keys(content.prepared ?? {}).length,
		actions: 0,
		widgetKinds: [],
		sectionTitles: [],
	};
	const sections: { title: string; x: number; y: number }[] = [];
	for (const shape of Object.values(content.shapes)) {
		switch (shape.type) {
			case "section":
				summary.sections++;
				sections.push({
					title: typeof shape.title === "string" ? shape.title : "",
					x: Number(shape.x) || 0,
					y: Number(shape.y) || 0,
				});
				break;
			case "sticky":
				summary.stickies++;
				break;
			case "action":
				summary.actions++;
				break;
			case "widget":
				summary.widgets++;
				if (typeof shape.widget === "string" && !summary.widgetKinds.includes(shape.widget)) {
					summary.widgetKinds.push(shape.widget);
				}
				break;
		}
	}
	summary.sectionTitles = sections
		.sort((a, b) => a.y - b.y || a.x - b.x)
		.map((section) => section.title)
		.filter(Boolean);
	return summary;
}

/** A template's sketch, for its card. Placeholders show as they are: nothing's filled in yet. */
export function templateThumbnail(content: TemplateContent): Thumbnail | null {
	return sketch(Object.entries(content.shapes).map(([id, shape]) => ({ ...shape, id })));
}

/** Whether a board made from this content has a section to carry action items into. */
export function collectsActions(content: TemplateContent): boolean {
	return Object.values(content.shapes).some(
		(shape) =>
			shape.type === "section" &&
			typeof shape.title === "string" &&
			/\b(actions?|action items?|follow[- ]?ups?|next steps|to ?dos?)\b/i.test(shape.title),
	);
}

/** A template's content from untrusted JSON (a saved template, a request), or null. */
export function readContent(value: unknown): TemplateContent | null {
	if (typeof value !== "object" || value === null) return null;
	const raw = value as Partial<TemplateContent>;
	if (raw.version !== TEMPLATE_VERSION) return null;
	if (typeof raw.shapes !== "object" || raw.shapes === null || Array.isArray(raw.shapes))
		return null;
	const shapes: TemplateContent["shapes"] = {};
	for (const [id, shape] of Object.entries(raw.shapes)) {
		if (typeof shape !== "object" || shape === null || Array.isArray(shape)) continue;
		if (typeof (shape as Record<string, unknown>).type !== "string") continue;
		shapes[id] = shape as Record<string, unknown>;
	}
	return {
		version: TEMPLATE_VERSION,
		shapes,
		...(raw.rules && typeof raw.rules === "object" ? { rules: raw.rules } : {}),
		...(raw.prepared && typeof raw.prepared === "object" ? { prepared: raw.prepared } : {}),
	};
}

/** Repositories given for a new board, tidied: valid keys only, no repeats, at most `TEMPLATE_REPOS_MAX`. */
export function cleanRepos(repos: readonly string[] | undefined): string[] {
	const out: string[] = [];
	for (const repo of repos ?? []) {
		const key = repo.trim().toLowerCase();
		if (!parseRepoKey(key) || out.includes(key)) continue;
		out.push(key);
	}
	return out.slice(0, TEMPLATE_REPOS_MAX);
}

/** Rules as `Rule`s, for describing a template's (`describeRule` wants them whole). */
export function templateRules(content: TemplateContent): Rule[] {
	return Object.entries(content.rules ?? {}).map(([id, rule]) => ({
		id,
		trigger: rule.trigger,
		action: rule.action,
		enabled: rule.enabled !== false,
		createdBy: { name: "Template" },
		createdAt: new Date(0).toISOString(),
		...(rule.name ? { name: rule.name } : {}),
	}));
}
