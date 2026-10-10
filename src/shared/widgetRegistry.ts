import * as v from "valibot";
import type * as Y from "yjs";
import type { Rect } from "./geometry.ts";
import { DEFAULT_HOST } from "./refs.ts";
import { parseSearch, searchScope } from "./search.ts";
import { type ShapeProps, addShape, nextZ, shapesMap } from "./shapes.ts";
import {
	MAX_FOLLOW_UPS,
	NO_BOARD,
	type QueryContext,
	type QueryError,
	type QueryResult,
	type SearchQuery,
	type WidgetDefinition,
	type WidgetQuery,
} from "./widgets.ts";

// The widget registry (#37): every kind of widget, by its `widget` key. Both
// the server (to work out which queries to run for a config) and the client
// (to render and configure) read definitions from here.
//
// A widget's config lives in the document, validated by its kind's schema
// whenever it's read: anything missing or malformed falls back to the
// default for that field, so a config written by an older (or newer) Tack
// still reads as something sensible.

// --- List (#38) ------------------------------------------------------------------

export const LIST_SORTS = ["updated", "created", "comments", "reactions"] as const;
export type ListSort = (typeof LIST_SORTS)[number];

export interface ListConfig {
	/** Shown in the header. Empty means the search itself names the list. */
	title: string;
	/** The forge to search. */
	host: string;
	/** The search, in the forge's query language. Empty: not set up yet. */
	q: string;
	sort: ListSort;
	/** At most this many rows. */
	limit: number;
}

export const LIST_LIMITS = { min: 5, max: 100, default: 30 };

const listSchema: v.GenericSchema<ListConfig> = v.object({
	title: v.fallback(v.pipe(v.string(), v.maxLength(120)), ""),
	host: v.fallback(v.pipe(v.string(), v.minLength(1), v.maxLength(253)), DEFAULT_HOST),
	q: v.fallback(v.pipe(v.string(), v.maxLength(1000)), ""),
	sort: v.fallback(v.picklist(LIST_SORTS), "updated"),
	limit: v.fallback(
		v.pipe(v.number(), v.integer(), v.minValue(LIST_LIMITS.min), v.maxValue(LIST_LIMITS.max)),
		LIST_LIMITS.default,
	),
});

export const listWidget: WidgetDefinition<ListConfig> = {
	kind: "list",
	title: "List",
	description: "Any search, kept live. Drag rows out as cards, or drop cards in to match.",
	schema: listSchema,
	defaults: { title: "", host: DEFAULT_HOST, q: "", sort: "updated", limit: LIST_LIMITS.default },
	size: { w: 360, h: 440 },
	queries(config): Record<string, WidgetQuery> {
		if (!config.q.trim()) return {};
		const query: SearchQuery = {
			kind: "search",
			host: config.host,
			q: config.q.trim(),
			sort: config.sort,
			order: "desc",
			limit: config.limit,
		};
		return { items: query };
	},
	// Webhooks keep repositories with the app fresh; this catches the rest
	// (and searches across owners, which no one repository's webhooks cover).
	refresh: 300,
};

/** Ready-made lists for the picker and the empty state. */
export const LIST_PRESETS: { label: string; title: string; q: (repo: string) => string }[] = [
	{ label: "Open bugs", title: "Open bugs", q: (repo) => `repo:${repo} is:open label:bug` },
	{
		label: "Needs triage",
		title: "Needs triage",
		q: (repo) => `repo:${repo} is:issue is:open no:label`,
	},
	{
		label: "Open pull requests",
		title: "Open pull requests",
		q: (repo) => `repo:${repo} is:pr is:open`,
	},
	{
		label: "Good first issues",
		title: "Good first issues",
		q: (repo) => `repo:${repo} is:open label:"good first issue"`,
	},
	{ label: "Assigned to me", title: "Assigned to me", q: () => "is:open assignee:@me" },
	{
		label: "My review queue",
		title: "Review queue",
		q: () => "is:pr is:open review-requested:@me",
	},
];

// --- The registry --------------------------------------------------------------

export const WIDGETS: Record<string, WidgetDefinition<never>> = {
	list: listWidget as unknown as WidgetDefinition<never>,
};

/** The definition for a kind, or null for kinds this version doesn't know. */
export function widgetDefinition(kind: unknown): WidgetDefinition<unknown> | null {
	if (typeof kind !== "string" || !Object.hasOwn(WIDGETS, kind)) return null;
	return WIDGETS[kind] as unknown as WidgetDefinition<unknown>;
}

/** A config as its kind reads it: validated, with defaults for anything missing or malformed. */
export function readConfig<Config>(definition: WidgetDefinition<Config>, raw: unknown): Config {
	const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const result = v.safeParse(definition.schema, input);
	return result.success ? result.output : definition.defaults;
}

/** A list widget's config, read from a shape. */
export function listConfig(shape: Pick<ShapeProps, "config">): ListConfig {
	return readConfig(listWidget, shape.config);
}

/** The queries a widget shape runs, by name. None for unknown kinds. */
export function widgetQueries(
	shape: Pick<ShapeProps, "widget" | "config">,
	context: QueryContext = NO_BOARD,
): Record<string, WidgetQuery> {
	const definition = widgetDefinition(shape.widget);
	if (!definition) return {};
	return definition.queries(readConfig(definition, shape.config), context);
}

/**
 * The queries a widget runs once its first ones have answered, by name: at
 * most `MAX_FOLLOW_UPS`, and never under a name its first queries use.
 */
export function widgetFollowUps(
	shape: Pick<ShapeProps, "widget" | "config">,
	results: Record<string, QueryResult | QueryError>,
): Record<string, WidgetQuery> {
	const definition = widgetDefinition(shape.widget);
	if (!definition?.followUps) return {};
	const entries = Object.entries(
		definition.followUps(readConfig(definition, shape.config), results),
	);
	return Object.fromEntries(
		entries.filter(([name]) => !Object.hasOwn(results, name)).slice(0, MAX_FOLLOW_UPS),
	);
}

/**
 * The repositories (`{host}/{owner}/{name}`) and owners a query reads, so
 * webhooks from them refresh it. Searches without a `repo:` or owner
 * qualifier only refresh on their definition's schedule.
 */
export function queryScope(query: WidgetQuery): { repos: string[]; owners: string[] } {
	switch (query.kind) {
		case "search": {
			const scope = searchScope(parseSearch(query.q));
			return {
				repos: scope.repos.map((repo) => `${query.host}/${repo}`.toLowerCase()),
				owners: scope.owners.map((owner) => `${query.host}/${owner}`.toLowerCase()),
			};
		}
		case "related": {
			const repo = query.key.replace(/[#!]\d+$/, "");
			return { repos: [repo.toLowerCase()], owners: [] };
		}
		case "release":
			return { repos: [query.repo.toLowerCase()], owners: [] };
	}
}

// --- Widget shapes -------------------------------------------------------------------

/** Widgets can't be resized smaller than this. */
export const WIDGET_MIN = { w: 260, h: 200 };

/** A widget shape's size, from the shape or its kind's default. */
export function widgetSize(shape: Pick<ShapeProps, "widget" | "w" | "h">): {
	w: number;
	h: number;
} {
	const fallback = widgetDefinition(shape.widget)?.size ?? listWidget.size;
	const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
	return {
		w: valid(shape.w) ? Math.max(shape.w, WIDGET_MIN.w) : fallback.w,
		h: valid(shape.h) ? Math.max(shape.h, WIDGET_MIN.h) : fallback.h,
	};
}

/**
 * Add a widget of a kind with its top-left at `at`, and return its id. Call
 * inside a local transaction (and `placeInSections` after, to put it in
 * whichever section it landed in).
 */
export function addWidget(
	doc: Y.Doc,
	kind: string,
	at: { x: number; y: number },
	config?: unknown,
	id: string = crypto.randomUUID(),
): string {
	const definition = widgetDefinition(kind);
	const size = definition?.size ?? listWidget.size;
	addShape(doc, id, {
		type: "widget",
		widget: kind,
		config: config ?? definition?.defaults ?? {},
		x: Math.round(at.x),
		y: Math.round(at.y),
		w: size.w,
		h: size.h,
		parent: null,
		z: nextZ(doc),
	});
	return id;
}

/** Merge changes into a widget's config, writing only what changed. */
export function updateWidgetConfig(doc: Y.Doc, id: string, changes: Record<string, unknown>): void {
	const shape = shapesMap(doc).get(id);
	if (!shape || shape.get("type") !== "widget") return;
	const before = shape.get("config");
	const current = before && typeof before === "object" ? (before as Record<string, unknown>) : {};
	const next = { ...current, ...changes };
	if (JSON.stringify(next) !== JSON.stringify(current)) shape.set("config", next);
}

/** Resize a widget, keeping it at least `WIDGET_MIN`. */
export function normaliseWidgetRect(rect: Rect): Rect {
	return {
		x: Math.round(rect.x),
		y: Math.round(rect.y),
		w: Math.round(Math.max(rect.w, WIDGET_MIN.w)),
		h: Math.round(Math.max(rect.h, WIDGET_MIN.h)),
	};
}
