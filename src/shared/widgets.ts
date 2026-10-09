import type * as v from "valibot";
import type { Card, MissingCard } from "./cards.ts";

// Widgets (docs/plan.md, M3): live views of forge data on the board.
//
// A widget is a shape (`type: "widget"`) with a `widget` kind and a `config`
// that the kind's Valibot schema validates. The config is in the document,
// so everyone sees the same widget; the data isn't. The server runs each
// widget's queries with the permissions of the person looking at it (their
// own token, or the app's for public data) and sends results on the board's
// custom-message channel, like card data. Two people can see different rows
// in the same list: private items only reach people who can read them.
//
// | key    | meaning                                           |
// | ------ | ------------------------------------------------- |
// | widget | the kind, e.g. `list`, `milestone`                |
// | config | the kind's config (JSON), validated by its schema |
// | w, h   | size                                              |
//
// Sections can be inbox frames (`query` on a section, see `InboxConfig`).

/** A forge search, in the forge's own query language (on GitHub: issue search). */
export interface SearchQuery {
	kind: "search";
	/** Forge host, e.g. `github.com`. */
	host: string;
	/**
	 * The search, e.g. `repo:emdash-cms/emdash is:open label:bug`. `@me`
	 * means the person looking at the widget.
	 */
	q: string;
	sort?: "updated" | "created" | "comments" | "reactions";
	order?: "asc" | "desc";
	/** At most this many results. Defaults to 50, at most 100. */
	limit?: number;
}

/** Items related to one item: sub-issues, parent, blocking and linked PRs. */
export interface RelatedQuery {
	kind: "related";
	/** The item's key, e.g. `github.com/owner/repo#12`. */
	key: string;
}

/** A repository's latest release, and what's merged since. */
export interface ReleaseQuery {
	kind: "release";
	/** Repository key, e.g. `github.com/owner/repo`. */
	repo: string;
}

export type WidgetQuery = SearchQuery | RelatedQuery | ReleaseQuery;

export interface SearchResult {
	kind: "search";
	/** Total matches, which may be more than `items`. */
	total: number;
	items: Card[];
	/** The forge gave up before finding every match (timeouts on GitHub). */
	incomplete?: boolean;
}

export interface RelatedResult {
	kind: "related";
	key: string;
	parent?: string;
	subIssues: string[];
	blockedBy: string[];
	blocking: string[];
	/** Pull requests that close or mention it. */
	linkedPulls: string[];
	/** Card data for every key above, where readable. */
	cards: (Card | MissingCard)[];
}

export interface ReleaseResult {
	kind: "release";
	repo: string;
	latest: { tag: string; name: string | null; publishedAt: string; url: string } | null;
	/** Pull requests merged into the default branch since the latest release. */
	mergedSince: Card[];
}

export type QueryResult = SearchResult | RelatedResult | ReleaseResult;

/** Why a query couldn't run for this viewer. */
export type QueryError = {
	kind: "error";
	reason: "signed_out" | "no_access" | "rate_limited" | "invalid" | "unsupported" | "error";
	message: string;
	retryAt?: number;
};

/**
 * A kind of widget. Definitions live in shared code so both the server (to
 * validate configs and work out queries) and the client (to render and
 * configure) use the same one.
 */
export interface WidgetDefinition<Config = unknown> {
	kind: string;
	title: string;
	/** One line for the widget picker. */
	description: string;
	schema: v.GenericSchema<Config>;
	defaults: Config;
	/** Initial size on the board. */
	size: { w: number; h: number };
	/** The queries to run for a config, by name. Run again whenever the config changes. */
	queries(config: Config): Record<string, WidgetQuery>;
	/** How often results go stale, in seconds, when no webhook says sooner. */
	refresh?: number;
}

/** Client to server, on the board's custom-message channel. */
export type WidgetRequest =
	/** Start or stop receiving a widget's data. Sent when it comes into view. */
	| { type: "widget-watch"; ids: string[] }
	| { type: "widget-unwatch"; ids: string[] }
	/** Run its queries again now. */
	| { type: "widget-refresh"; id: string };

/** Server to client. */
export type WidgetMessage = {
	type: "widget-data";
	/** The widget's shape id (or an inbox section's). */
	id: string;
	/** Results by query name, as the config's `queries` named them. */
	results: Record<string, QueryResult | QueryError>;
	/** When these results were fetched, ISO 8601. */
	at: string;
};

/**
 * Inbox frames: a section with a query. New matches land in its tray as
 * "new"; people sort them onto the board. Automation never rearranges what
 * people placed.
 */
export interface InboxConfig {
	query: SearchQuery;
}

/**
 * How a card arrived on the board. It decides what happens when the card
 * stops matching what brought it: a card someone placed stays; one an inbox
 * or rule added is marked as no longer matching (never removed silently).
 */
export type Provenance =
	| { via: "manual" }
	/** Dragged out of a list widget (`source` is the widget's id). */
	| { via: "list"; source: string }
	/** Sorted out of an inbox frame (`source` is the section's id). */
	| { via: "inbox"; source: string }
	/** Placed by a rule (`source` is the rule's id). */
	| { via: "rule"; source: string };
