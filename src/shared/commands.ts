import type * as Y from "yjs";
import { BOARD_ID, boardIdFromPath } from "./boards.ts";
import { PLACE_GAP, PLACED_CARD, spotBelow, spotInSection, spotNear } from "./placement.ts";
import { addCardShape, provenanceOf } from "./provenance.ts";
import { displaySections, keepInSection } from "./display.ts";
import { boxOf, readStructure } from "./sections.ts";
import { type ShapeProps, cardRefs } from "./shapes.ts";
import { placeInSections, readShapes } from "./structure.ts";
import type { Provenance } from "./widgets.ts";

// Comment commands (#58), the pure half: mentioning the app in a comment on
// an issue or pull request (`@tack add to roadmap in Next up`) puts the item
// on a board. This file reads commands out of comments, finds the board
// (and section) they name, places the card, and words the reply. The server
// side, with the permission checks, is src/server/commands.ts.
//
// Replies are posted on the forge, where anyone who can read the item reads
// them, which may be everyone. So they never name a board or a section that
// isn't public unless the person asking named it themselves, and they never
// echo text that could mention someone or make a link.

/** What a comment asks for. `name` is the name it used for the app, without the `@`. */
export type Command =
	| { kind: "help"; name: string }
	| {
			kind: "add";
			name: string;
			/** The board, as written: a name, a slug, a link or an id. */
			board: string;
			/** The section to put it in, as written, if any. */
			section?: string;
			/**
			 * Everything after the verb, in case `in` was part of the board's
			 * name ("Plans in 2026"): tried when `board` finds nothing.
			 */
			whole: string;
	  };

/** How long a board or section name may be, as written. */
const MAX_NAME = 120;

/**
 * The names the app answers to, lowercase and without the `@`: its slug on
 * the forge, and any short aliases (`TACK_COMMAND_ALIAS`, comma-separated).
 */
export function commandNames(slug: string | null | undefined, aliases?: string | null): string[] {
	const names = [slug ?? "", ...(aliases ?? "").split(",")]
		.map((name) => name.trim().replace(/^@/, "").toLowerCase())
		.filter((name) => /^[a-z0-9][a-z0-9-]*$/.test(name));
	return [...new Set(names)];
}

/**
 * What a comment says, leaving out what it only quotes: code (fenced,
 * indented and inline), quoted replies (`> …`, so quoting an earlier
 * command doesn't run it again) and HTML comments.
 */
export function spokenLines(body: string): string[] {
	const lines: string[] = [];
	let fence: string | null = null;
	const text = body.replace(/<!--[\s\S]*?-->/g, "");
	for (const line of text.split(/\r?\n/)) {
		const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
			continue;
		}
		if (marker) {
			fence = marker;
			continue;
		}
		if (/^\s{0,3}>/.test(line) || /^( {4}|\t)/.test(line)) continue;
		lines.push(line.replace(/(`+)[\s\S]*?\1/g, " "));
	}
	return lines;
}

/** The first command in a comment that's addressed to one of `names`, or null. */
export function findCommand(body: string, names: readonly string[]): Command | null {
	if (names.length === 0) return null;
	const pattern = new RegExp(
		`(?:^|[^\\w@/.-])@(${names.map(escapeRegExp).join("|")})(?:\\[bot\\])?(?![\\w-])(.*)$`,
		"i",
	);
	for (const line of spokenLines(body)) {
		const match = pattern.exec(line);
		if (!match) continue;
		const command = parseCommand(match[2] ?? "", (match[1] ?? "").toLowerCase());
		if (command) return command;
	}
	return null;
}

/**
 * What follows the mention: `help`, or `add [to|on|onto] <board> [in|into
 * <section>]`. Anything else isn't a command (people mention apps in passing
 * too), so it's left alone.
 */
export function parseCommand(text: string, name: string): Command | null {
	const said = text
		.replace(/^[\s:,]+/, "")
		.replace(/^please\s+/i, "")
		.trim();
	if (/^(?:help|\?)(?:\W|$)/i.test(said)) return { kind: "help", name };
	// A sentence after it isn't part of it: "add to roadmap. Thanks!"
	const rest = said.replace(/[.!?](?:\s.*)?$/, "").trim();
	const add = /^(?:add|put|pin)(?:\s+(?:this|it))?(?:\s+(?:to|on|onto|in|into))?\s+(.+)$/i.exec(
		rest,
	);
	const target = add?.[1]?.trim();
	if (!target) return null;

	// A quoted board: `add to "Plans in 2026" in Next`.
	const quoted = /^(["“'‘`])(.+?)(["”'’`])(?:\s+(?:in|into)\s+(.+))?$/i.exec(target);
	if (quoted?.[2]) {
		const board = clean(quoted[2]);
		const section = quoted[4] ? cleanSection(quoted[4]) : "";
		if (!board) return null;
		return { kind: "add", name, board, ...(section ? { section } : {}), whole: board };
	}

	const whole = clean(target);
	if (!whole) return null;
	// The last ` in ` (or ` into `) splits off the section.
	const split = /^(.+)\s+(?:in|into)\s+(.+?)$/i.exec(target);
	const board = split?.[1] ? clean(split[1]) : "";
	const section = split?.[2] ? cleanSection(split[2]) : "";
	if (board && section) return { kind: "add", name, board, section, whole };
	return { kind: "add", name, board: whole, whole };
}

function clean(name: string): string {
	return name
		.trim()
		.replace(/^["“'‘`]+|["”'’`]+$/g, "")
		.replace(/[\s,;:]+$/, "")
		.trim()
		.slice(0, MAX_NAME);
}

/** "the Next up section" is "Next up". */
function cleanSection(name: string): string {
	const section = clean(name)
		.replace(/^(?:the\s+)?section\s+/i, "")
		.replace(/^the\s+(?=\S)/i, "")
		.replace(/\s+(?:section|column)$/i, "");
	return clean(section);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Finding boards and sections by name -----------------------------------------

/** Lowercase words, without accents or punctuation, for comparing names. */
export function normaliseName(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** How well `query` names something called `name`: 0 (not at all) to 100 (exactly). */
export function nameScore(query: string, name: string): number {
	const q = normaliseName(query);
	const n = normaliseName(name);
	if (!q || !n) return 0;
	if (q === n) return 100;
	if (n.startsWith(`${q} `)) return 80;
	const words = n.split(" ");
	if (q.split(" ").every((word) => words.some((w) => w.startsWith(word)))) return 60;
	if (n.includes(q)) return 50;
	// A typo or two, in names long enough for that to mean anything.
	const allowed = Math.floor(Math.max(q.length, n.length) / 6);
	if (allowed > 0 && Math.abs(q.length - n.length) <= allowed && distance(q, n) <= allowed) {
		return 40;
	}
	return 0;
}

/** Edit distance, counting two letters swapped as one edit (optimal string alignment). */
function distance(a: string, b: string): number {
	const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)];
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			const up = rows[i - 1] ?? [];
			let best = Math.min(
				(up[j] ?? 0) + 1,
				(row[j - 1] ?? 0) + 1,
				(up[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				best = Math.min(best, (rows[i - 2]?.[j - 2] ?? 0) + 1);
			}
			row[j] = best;
		}
		rows.push(row);
	}
	return rows[a.length]?.[b.length] ?? 0;
}

export type Match<T> =
	| { kind: "found"; value: T }
	| { kind: "ambiguous"; values: T[] }
	| { kind: "none" };

/**
 * The best match for `query` among `items`, by any of their names: the one
 * that scores highest, or every one tied for highest if that's more than one.
 */
export function bestMatch<T>(
	query: string,
	items: readonly T[],
	names: (item: T) => string[],
): Match<T> {
	let best = 0;
	let found: T[] = [];
	for (const item of items) {
		const score = Math.max(0, ...names(item).map((name) => nameScore(query, name)));
		if (score === 0 || score < best) continue;
		if (score > best) {
			best = score;
			found = [];
		}
		found.push(item);
	}
	const [first] = found;
	if (!first) return { kind: "none" };
	return found.length === 1
		? { kind: "found", value: first }
		: { kind: "ambiguous", values: found };
}

/** What a command needs to know about a board to find it. */
export interface BoardCandidate {
	id: string;
	slug: string;
	title: string;
	archived: boolean;
}

/**
 * The board a command names, among `boards`: by its link (`…/b/{id}/…`) or
 * id exactly, or else by title or slug, fuzzily. Archived boards are only
 * found by link or id.
 */
export function matchBoard<T extends BoardCandidate>(
	query: string,
	boards: readonly T[],
): Match<T> {
	const exact = boardIdIn(query);
	if (exact) {
		const board = boards.find((b) => b.id === exact);
		if (board) return { kind: "found", value: board };
		if (/^https?:\/\/|^\/b\//i.test(query.trim())) return { kind: "none" };
	}
	const names = (board: T) => [board.title, board.slug];
	const open = boards.filter((board) => !board.archived);
	const tried = bestMatch(query, open, names);
	if (tried.kind !== "none") return tried;
	// "the Roadmap board" is "Roadmap".
	const plain = query.replace(/^the\s+/i, "").replace(/\s+board$/i, "");
	const again = plain !== query ? bestMatch(plain, open, names) : tried;
	if (again.kind !== "none") return again;
	// An archived board by its exact name, so the reply can say it's archived.
	const archived = boards.filter(
		(board) => board.archived && names(board).some((name) => nameScore(query, name) === 100),
	);
	return archived.length === 1 && archived[0] ? { kind: "found", value: archived[0] } : again;
}

/** The board id in a link to a board, or the query itself if it could be an id. */
function boardIdIn(query: string): string | null {
	const text = query.trim();
	try {
		if (/^https?:\/\//i.test(text)) return boardIdFromPath(new URL(text).pathname);
	} catch {
		return null;
	}
	if (text.startsWith("/b/")) return boardIdFromPath(text);
	return BOARD_ID.test(text) ? text : null;
}

// --- Placing the card ------------------------------------------------------------

/** The server's writes for comment commands, so "since you were here" credits the person who asked. */
export interface CommandOrigin {
	kind: "command";
	by: { id: number; login: string };
}

export function isCommandOrigin(origin: unknown): origin is CommandOrigin {
	return (
		typeof origin === "object" &&
		origin !== null &&
		(origin as { kind?: unknown }).kind === "command" &&
		typeof (origin as { by?: { id?: unknown } }).by?.id === "number"
	);
}

export interface PlaceRequest {
	/** The item's key, e.g. `github.com/acme/widgets#12`. */
	key: string;
	/** A section, by name, as the comment wrote it. */
	section?: string;
	provenance: Extract<Provenance, { via: "comment" }>;
}

export type PlaceResult =
	| {
			status: "added";
			shape: string;
			/** The section it went in (or below, if it was `full`). */
			section: { id: string; title: string } | null;
			full: boolean;
	  }
	| { status: "already"; shape: string }
	/** No section by that name; `sections` are the board's section titles. */
	| { status: "no_section"; sections: string[] }
	| { status: "ambiguous_section"; sections: string[] }
	| { status: "no_room" };

/**
 * Put an item on a board for a comment command, in free space, in one
 * transaction with `origin`: into the section it names (or just below it,
 * if it's full); otherwise below the last card a comment brought, or beside
 * everything else on the board. Never moves anything, and never adds an
 * item that's already there.
 */
export function placeCommandCard(doc: Y.Doc, request: PlaceRequest, origin: unknown): PlaceResult {
	const shapes = readShapes(doc);
	const existing = [...shapes].find(
		([, shape]) => shape.type === "card" && shape.ref === request.key,
	);
	if (existing || cardRefs(doc).has(request.key)) {
		return { status: "already", shape: existing?.[0] ?? "" };
	}

	let section: { id: string; title: string } | null = null;
	let spot: { x: number; y: number } | null;
	let full = false;
	let listed = false;
	if (request.section) {
		const sections = sectionsOf(shapes);
		const match = bestMatch(request.section, sections, (s) => [s.title]);
		if (match.kind === "none") {
			return { status: "no_section", sections: sections.map((s) => s.title) };
		}
		if (match.kind === "ambiguous") {
			return { status: "ambiguous_section", sections: match.values.map((s) => s.title) };
		}
		section = match.value;
		const inside = spotInSection(shapes, section.id);
		spot = inside ?? spotBelow(shapes, section.id);
		// A section showing a list is never full: it grows (display.ts).
		listed = displaySections(shapes, readStructure(shapes)).has(section.id);
		full = !inside && !listed;
	} else {
		spot = spotNear(shapes, idealSpot(shapes));
	}
	if (!spot) return { status: "no_room" };

	const id = crypto.randomUUID();
	const at = spot;
	doc.transact(() => {
		addCardShape(doc, id, { ref: request.key, x: at.x, y: at.y }, request.provenance);
		placeInSections(doc, [id]);
		// Named a section showing a list: into it, wherever the spot was.
		if (section && listed) keepInSection(doc, id, section.id);
	}, origin);
	return { status: "added", shape: id, section, full };
}

function sectionsOf(shapes: ReadonlyMap<string, ShapeProps>): { id: string; title: string }[] {
	const sections: { id: string; title: string }[] = [];
	for (const [id, shape] of shapes) {
		const title =
			shape.type === "section" && typeof shape.title === "string" ? shape.title.trim() : "";
		if (title) sections.push({ id, title });
	}
	return sections;
}

/**
 * Where a card asked for without a section would ideally go: below the
 * last one a comment brought, so they gather in a column, or else to the
 * right of everything, level with the top.
 */
function idealSpot(shapes: ReadonlyMap<string, ShapeProps>): { x: number; y: number } {
	let last: { box: ReturnType<typeof boxOf>; z: string } | null = null;
	let bounds: { left: number; top: number; right: number } | null = null;
	for (const [id, shape] of shapes) {
		if (shape.type === "connector") continue;
		const box = boxOf(id, shape);
		bounds = bounds
			? {
					left: Math.min(bounds.left, box.x),
					top: Math.min(bounds.top, box.y),
					right: Math.max(bounds.right, box.x + box.w),
				}
			: { left: box.x, top: box.y, right: box.x + box.w };
		if (shape.type === "card" && provenanceOf(shape).via === "comment") {
			const z = typeof shape.z === "string" ? shape.z : "";
			if (!last || z > last.z) last = { box, z };
		}
	}
	if (last)
		return { x: last.box.x, y: last.box.y + Math.max(last.box.h, PLACED_CARD.h) + PLACE_GAP };
	if (!bounds) return { x: 0, y: 0 };
	return { x: bounds.right + PLACE_GAP * 3, y: bounds.top };
}

// --- Replies -----------------------------------------------------------------------

/** A board as a reply names it. */
export interface BoardLink {
	title: string;
	url: string;
	/** Only public boards are named in replies the person asking didn't name themselves. */
	public: boolean;
}

export type CommandOutcome =
	| {
			kind: "added";
			board: BoardLink;
			item: "issue" | "pull";
			section?: string | null;
			/** The section was full, so it went just below. */
			full?: boolean;
	  }
	| { kind: "already"; board: BoardLink; item: "issue" | "pull" }
	| { kind: "help"; name: string; item: "issue" | "pull" }
	/** Never signed in to this instance, so there's no knowing who they are on it. */
	| { kind: "unknown_user"; signIn: string }
	| { kind: "not_allowed" }
	| { kind: "not_found"; query: string }
	| { kind: "ambiguous"; query: string; boards: BoardLink[] }
	| { kind: "no_permission"; query: string }
	| { kind: "archived"; query: string }
	/**
	 * A private repository's item, and a board that could show it to someone
	 * who can't read the repository: it isn't private, someone on it can't
	 * read the repository, or someone's been invited who hasn't signed in.
	 */
	| { kind: "private_repo"; query: string; reason: "visibility" | "members" | "pending" }
	| { kind: "no_section"; board: BoardLink; query: string; section: string; sections: string[] }
	| {
			kind: "ambiguous_section";
			board: BoardLink;
			query: string;
			section: string;
			sections: string[];
	  }
	| { kind: "no_room"; board: BoardLink; query: string }
	| { kind: "failed" };

/** Whether an outcome is the command working (so the reaction says so). */
export function succeeded(outcome: CommandOutcome): boolean {
	return outcome.kind === "added" || outcome.kind === "already" || outcome.kind === "help";
}

/** Text from a comment or a board, made safe to put in a reply: no mentions, links or formatting. */
export function quote(text: string, max = 80): string {
	const short = text.length > max ? `${text.slice(0, max - 1)}…` : text;
	return (
		short
			.replace(/[\r\n]+/g, " ")
			.replace(/[\\`*_[\]()<>#|~!]/g, (char) => `\\${char}`)
			// A zero-width joiner after @ stops it mentioning anyone.
			.replace(/@/g, "@‍")
			.replace(/:\/\//g, ":‍//")
	);
}

function link(board: BoardLink): string {
	return `[**${quote(board.title, 120)}**](${board.url})`;
}

/** The board as a reply may name it: by name and link if it's public, else as the person wrote it. */
function named(board: BoardLink, query: string): string {
	return board.public ? link(board) : `“${quote(query)}”`;
}

const ITEM = { issue: "issue", pull: "pull request" } as const;

/** The reply to post for an outcome, in Markdown. */
export function commandReply(outcome: CommandOutcome): string {
	switch (outcome.kind) {
		case "added": {
			const where = outcome.section ? ` in “${quote(outcome.section)}”` : "";
			const full = outcome.full && outcome.section ? ` It was full, so this is just below it.` : "";
			return `📌 Added this ${ITEM[outcome.item]} to ${link(outcome.board)}${where}.${full}`;
		}
		case "already":
			return `👍 This ${ITEM[outcome.item]} is already on ${link(outcome.board)}.`;
		case "help":
			return [
				`👋 I can put this ${ITEM[outcome.item]} on a Tack board:`,
				"",
				`- \`@${outcome.name} add to <board>\` adds it to a board, by its name or its link`,
				`- \`@${outcome.name} add to <board> in <section>\` puts it straight into a section`,
				`- \`@${outcome.name} help\` shows this`,
				"",
				"You'll need to be able to edit the board, and to have signed in to Tack.",
			].join("\n");
		case "unknown_user":
			return `👋 I don't know you on Tack yet. [Sign in](${outcome.signIn}) once, then ask me again.`;
		case "not_allowed":
			return "🔒 You aren't on this Tack's access list yet, so I can't add anything for you. An admin can add you.";
		case "not_found":
			return `🤔 I couldn't find a board called “${quote(outcome.query)}” that you can edit. Its link always works: open the board and copy the address.`;
		case "ambiguous": {
			const shown = outcome.boards.filter((board) => board.public);
			const hidden = outcome.boards.length - shown.length;
			const which =
				shown.length === 0
					? ` (${hidden} of them, none public, so I won't name them here)`
					: `: ${shown.map(link).join(", ")}${hidden > 0 ? `, and ${hidden} more that ${hidden === 1 ? "isn't" : "aren't"} public, so I won't name ${hidden === 1 ? "it" : "them"} here` : ""}`;
			return `🤔 “${quote(outcome.query)}” could be more than one of your boards${which}. Say which with its full name or its link.`;
		}
		case "no_permission":
			return `🔒 You can see “${quote(outcome.query)}” but can't edit it, so I can't add to it. Its owner can make you an editor.`;
		case "archived":
			return `🗄️ “${quote(outcome.query)}” is archived, so nothing can be added to it.`;
		case "private_repo": {
			const why = {
				visibility: "it isn't a private board",
				members: "not everyone on it can read this repository",
				pending:
					"someone's been invited to it who hasn't signed in yet, so I can't check they can read this repository",
			}[outcome.reason];
			return `🔒 This repository is private, and I've left this off “${quote(outcome.query)}”: ${why}. Private items only go on private boards whose members can all read their repository.`;
		}
		case "no_section":
		case "ambiguous_section": {
			const lead =
				outcome.kind === "no_section"
					? `🤔 I couldn't find a section called “${quote(outcome.section)}” on ${named(outcome.board, outcome.query)}`
					: `🤔 “${quote(outcome.section)}” could be more than one section on ${named(outcome.board, outcome.query)}`;
			const sections = outcome.board.public ? outcome.sections.slice(0, 8) : [];
			const list =
				sections.length > 0
					? ` Its sections: ${sections.map((s) => `“${quote(s, 40)}”`).join(", ")}.`
					: "";
			return `${lead}, so I haven't added it.${list}`;
		}
		case "no_room":
			return `😅 There's no free space on ${named(outcome.board, outcome.query)} for this right now.`;
		case "failed":
			return "😕 Something went wrong, and I couldn't add this. Try again in a little while.";
	}
}
