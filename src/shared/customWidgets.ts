import * as v from "valibot";
import { DEFAULT_HOST, forgeForHost } from "./refs.ts";
import type { QueryError, SearchQuery, WidgetDefinition } from "./widgets.ts";

// Custom widgets (#66): code someone on the board wrote, run in a sandboxed
// iframe, reading the board's data through a small, read-only API.
//
// - The code and its settings live in the widget's config, in the document,
//   like any other widget's. Anyone who can edit the board can change them.
// - It only runs on boards whose owner has turned custom widgets on (off by
//   default; the Directory keeps the switch, so editors can't flip it).
// - It runs in an iframe with `sandbox="allow-scripts"` and nothing else, so
//   its origin is opaque: no cookies, no storage, no access to the app, no
//   popups, forms or navigating the board. The frame's page (served by the
//   Worker at `SANDBOX_PATH`) has its own CSP that loads nothing from
//   anywhere (`connect-src 'none'`, images only `data:` and `blob:`), and the
//   app's `frame-src 'self'` stops it navigating itself somewhere else.
// - It talks to the board over `postMessage`, in the messages below, which
//   the board checks (`parseFrameMessage`), limits (`CUSTOM_LIMITS`) and
//   answers as the person looking: searches run through the widget runner
//   with their own access, cards are the ones the board already sent them.
//
// See docs/security-review.md for the threat model.

/** Where the Worker serves the sandbox's page. */
export const SANDBOX_PATH = "/sandbox/widget";

/** The protocol's version, carried on every message as `tack`. */
export const PROTOCOL = 1;

export const CUSTOM_LIMITS = {
	/** Characters of code. */
	code: 64_000,
	/** Characters of settings (JSON). */
	data: 8_000,
	title: 120,
	/** Searches one widget keeps live for one viewer; asking for more drops the oldest. */
	queries: 8,
	/** Characters in a search, as GitHub allows. */
	query: 256,
	/** Results per search. */
	searchResults: 100,
	/** Keys per `tack.cards()`. */
	cards: 100,
	/** Requests a widget may make a minute (searches, cards, avatars). */
	requestsPerMinute: 120,
	/** Requests waiting for an answer at once. */
	inFlight: 8,
	/** A request still unanswered after this fails. */
	requestMs: 20_000,
	/** The sandbox must load and run the code's first turn within this. */
	startMs: 8_000,
	/** The board checks the widget is still responsive this often... */
	pingMs: 2_000,
	/** ...and stops it after this long without an answer. */
	unresponsiveMs: 6_000,
	/** Characters of one log line or error. */
	logText: 2_000,
	/** Log lines kept for the editor's console. */
	logLines: 200,
	/** Avatars a widget may ask for. */
	avatars: 64,
} as const;

/**
 * How long one loop in a widget's code may keep the thread without a pause
 * before it's stopped (`guardLoops`, in the client; the guard itself is in
 * the sandbox's bootstrap, by this name).
 */
export const LOOP_MS = 1000;
export const LOOP_GUARD = "__tackLoop";

export interface CustomConfig {
	/** Shown in the header. */
	title: string;
	/** The widget's code: a module script, run once the sandbox starts. */
	code: string;
	/** Its settings, as JSON, read as `tack.config`. */
	data: string;
}

const customSchema: v.GenericSchema<CustomConfig> = v.object({
	title: v.fallback(v.pipe(v.string(), v.maxLength(CUSTOM_LIMITS.title)), ""),
	code: v.fallback(v.pipe(v.string(), v.maxLength(CUSTOM_LIMITS.code)), ""),
	data: v.fallback(v.pipe(v.string(), v.maxLength(CUSTOM_LIMITS.data)), "{}"),
});

export const CUSTOM_KIND = "custom";

export const customWidget: WidgetDefinition<CustomConfig> = {
	kind: CUSTOM_KIND,
	title: "Custom",
	description:
		"Your own code, in a sandbox, drawing the board’s data. Off unless the owner allows it.",
	schema: customSchema,
	defaults: { title: "", code: "", data: "{}" },
	size: { w: 400, h: 340 },
	// Its searches come from its code as it runs (`widget-query`), per viewer.
	queries: () => ({}),
	refresh: 300,
};

/** A custom widget's settings, parsed: `tack.config`. */
export function parseSettings(
	data: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
	if (!data.trim()) return { ok: true, value: {} };
	try {
		const value: unknown = JSON.parse(data);
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false, error: 'Settings must be a JSON object, like { "repo": "owner/name" }.' };
		}
		return { ok: true, value: value as Record<string, unknown> };
	} catch (error) {
		return { ok: false, error: `Settings aren’t valid JSON: ${(error as Error).message}` };
	}
}

// --- Searches ----------------------------------------------------------------------------

/** A search as a widget's code asks for it. */
export interface CustomSearch {
	q: string;
	host?: string;
	sort?: SearchQuery["sort"];
	order?: SearchQuery["order"];
	limit?: number;
}

const SORTS = ["updated", "created", "comments", "reactions", "top"] as const;

const SearchShape = v.object({
	q: v.pipe(v.string(), v.maxLength(CUSTOM_LIMITS.query * 4)),
	host: v.optional(v.pipe(v.string(), v.maxLength(253))),
	sort: v.optional(v.picklist(SORTS)),
	order: v.optional(v.picklist(["asc", "desc"])),
	limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))),
});

/** A widget's search as the runner runs it, or why it can't. */
export function customQueryOf(raw: unknown): SearchQuery | QueryError {
	const parsed = v.safeParse(SearchShape, raw);
	if (!parsed.success) return { kind: "error", reason: "invalid", message: "That isn't a search." };
	const {
		q: text,
		host = DEFAULT_HOST,
		sort = "updated",
		order = "desc",
		limit = 30,
	} = parsed.output;
	const q = text.trim();
	if (!q) return { kind: "error", reason: "invalid", message: "That search is empty." };
	if (q.length > CUSTOM_LIMITS.query) {
		return { kind: "error", reason: "invalid", message: "That search is too long." };
	}
	if (!forgeForHost(host)) {
		return { kind: "error", reason: "unsupported", message: `Tack can't search ${host}.` };
	}
	return {
		kind: "search",
		host: host.toLowerCase(),
		q,
		sort,
		order,
		limit: Math.min(limit, CUSTOM_LIMITS.searchResults),
	};
}

/**
 * The name a search goes by on the board's channel: the same search, asked
 * for twice, is one query.
 */
export function searchName(query: SearchQuery): string {
	const text = JSON.stringify([query.host, query.q, query.sort, query.order, query.limit]);
	// FNV-1a: short, stable, and only ever compared with itself.
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return `s${(hash >>> 0).toString(36)}`;
}

/** Names the board's channel accepts for a widget's searches. */
export const QUERY_NAME = /^[\w-]{1,32}$/;

/** Client to server: the searches a custom widget wants kept live for this connection. */
export interface CustomQueryRequest {
	type: "widget-query";
	/** The widget's shape id. */
	id: string;
	/** Every search it wants, by name. Replaces what it asked for before. */
	queries: Record<string, CustomSearch>;
}

// --- The sandbox's messages ----------------------------------------------------------------

/** What the sandbox may ask for. */
export type FrameRequest =
	| { method: "search"; query: CustomSearch }
	| { method: "cards"; keys: string[] }
	| { method: "avatar"; url: string; size: number };

/** Sandbox to board. Anything else is ignored. */
export type FrameMessage =
	/** The page is ready for its code. */
	| { type: "loaded" }
	/** The code ran its first turn. */
	| { type: "started" }
	| ({ type: "request"; id: number } & FrameRequest)
	| { type: "pong"; n: number }
	/** An uncaught error or rejection. */
	| { type: "error"; message: string }
	| { type: "log"; level: LogLevel; text: string };

export type LogLevel = "log" | "info" | "warn" | "error";

/** What the widget sees of the board's theme, as CSS custom properties. */
export interface FrameTheme {
	mode: "light" | "dark";
	/** Every duration's scale: 1, or near 0 with motion reduced. */
	motion: number;
	/** Token name (without `--`) to value. */
	tokens: Record<string, string>;
}

/** Board to sandbox. */
export type HostMessage =
	| {
			type: "init";
			code: string;
			config: Record<string, unknown>;
			widget: { id: string; title: string };
			theme: FrameTheme;
	  }
	| { type: "response"; id: number; ok: true; value: unknown }
	| { type: "response"; id: number; ok: false; error: { reason: string; message: string } }
	/** Something the widget read has changed: read it again. */
	| { type: "update" }
	| { type: "theme"; theme: FrameTheme }
	| { type: "ping"; n: number };

const text = (max: number) =>
	v.pipe(
		v.string(),
		v.transform((value) => (value.length > max ? `${value.slice(0, max)}…` : value)),
	);

const RequestId = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2 ** 31));

const FrameSchema = v.variant("type", [
	v.object({ type: v.literal("loaded") }),
	v.object({ type: v.literal("started") }),
	v.object({ type: v.literal("pong"), n: RequestId }),
	v.object({ type: v.literal("error"), message: text(CUSTOM_LIMITS.logText) }),
	v.object({
		type: v.literal("log"),
		level: v.picklist(["log", "info", "warn", "error"]),
		text: text(CUSTOM_LIMITS.logText),
	}),
	v.object({
		type: v.literal("request"),
		id: RequestId,
		method: v.literal("search"),
		query: v.looseObject({}),
	}),
	v.object({
		type: v.literal("request"),
		id: RequestId,
		method: v.literal("cards"),
		keys: v.array(v.pipe(v.string(), v.maxLength(400))),
	}),
	v.object({
		type: v.literal("request"),
		id: RequestId,
		method: v.literal("avatar"),
		url: v.pipe(v.string(), v.maxLength(400)),
		size: v.optional(v.pipe(v.number(), v.integer(), v.minValue(16), v.maxValue(256)), 64),
	}),
]);

/**
 * A message from a sandbox, checked: the protocol's version, a known type,
 * and fields of the right types and sizes. Null for anything else, which
 * the board ignores. (Searches' own contents are checked by `customQueryOf`.)
 */
export function parseFrameMessage(data: unknown): FrameMessage | null {
	if (!data || typeof data !== "object" || (data as { tack?: unknown }).tack !== PROTOCOL) {
		return null;
	}
	const parsed = v.safeParse(FrameSchema, data);
	if (!parsed.success) return null;
	const message = parsed.output as FrameMessage;
	if (message.type === "request" && message.method === "search") {
		return { ...message, query: message.query as unknown as CustomSearch };
	}
	return message;
}

/** Avatars a widget may ask for: GitHub's, by URL. */
export function avatarUrl(url: string, size: number): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" || parsed.hostname !== "avatars.githubusercontent.com") {
		return null;
	}
	if (parsed.username || parsed.password || parsed.port) return null;
	parsed.searchParams.set("s", String(Math.round(size)));
	return parsed.toString();
}
