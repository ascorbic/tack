import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import * as v from "valibot";
import * as Y from "yjs";
import { isDate } from "./actionItems.ts";
import { type CreatedBoard, MAX_TITLE, type Visibility } from "./boards.ts";
import { type Card, type CardKind, type CardState, type MissingCard, isMissing } from "./cards.ts";
import { type CommentAuthor, type CommentThread, liveMessages } from "./comments.ts";
import { readVotes as readDecisionVotes, tally } from "./decisions.ts";
import { closedAt, readVotes, tallyVote, turnout } from "./dotvotes.ts";
import { type StampEmoji, stampCounts, stampsMap } from "./facilitation.ts";
import { IMAGE_HASH, IMAGE_LIMITS, IMAGE_TYPES, type ImageType, isImageHash } from "./images.ts";
import { type PreparedPlan, preparedMap, readPrepared, readStep } from "./prepared.ts";
import { LINK_LIMITS, linkUrl, readPreview } from "./linkPreview.ts";
import { parseKey } from "./refs.ts";
import {
	type RuleAction,
	type RuleTrigger,
	readRule,
	rulesMap,
	scopeRepos,
	setScopeRepos,
} from "./rules.ts";
import { type ShapeType, shapesMap } from "./shapes.ts";
import { isStackable } from "./stacks.ts";
import { TEMPLATE_REPOS_MAX, cleanRepos } from "./templates.ts";
import { readVolunteers, volunteersMap } from "./volunteers.ts";

// A board as a file (#59): its shapes (cards, stickies, text, sections,
// connectors, decisions, widgets, action items, stacks, images), rules and
// prepared facilitation steps as plain, versioned JSON, to download, keep in
// a repository (backups.ts on the server writes it to an orphan branch) and
// import into a new board.
//
// Image shapes name their file by its hash. A file downloaded from the
// board's menu carries the files too, in `images` (base64), which the
// browser uploads to the new board when it's imported. Backups leave them
// out (a repository's no place for them): a board imported from a backup
// shows its images as missing.
//
// It's the board's content, not its sessions or the people on it: what's
// left out is everything that's someone's own or only means something on
// this board right now.
//
// | left out                        | why                                          |
// | ------------------------------- | -------------------------------------------- |
// | comments, history, visits       | not in the document; people's own            |
// | votes on decisions, dot votes,  | who voted for what is theirs, and a session's |
// | stamps, volunteers              |                                              |
// | face-down stickies              | silent mode's hidden text is its author's    |
// | staged changes, write-backs     | pending, and only mean something here        |
// | provenance, inbox dismissals,   | this board's automation state                |
// | carried-over links              |                                              |
// | cards you can't read            | `includeCard`: an exporter's private cards   |
// |                                 | stay out of a file they may share            |
//
// Every property is copied by name (`KEEP`), so a property added to shapes
// later stays out of exports until it's added here on purpose.
//
// A download may also carry what people did on the board, when the exporter
// asks (`activity`): dot votes' results, decisions' votes, stamps, hands up,
// comments and the items its cards show, for reading the board somewhere
// else. It's only ever about shapes in the file, and says no more than the
// board shows anyone who can open it: a hidden vote never names who voted,
// and gives no results until it closes. Backups never carry it. Importing
// drops it unread, and it doesn't count towards what an import may weigh.
//
// Importing (`readBoardExport`, then `importBoard`) checks everything with
// Valibot, gives every shape, rule and step a fresh id (references remapped,
// dangling ones dropped), and restacks shapes in the file's order.

export const BOARD_EXPORT_FORMAT = "tack.board";
/** Bump when the format changes, and add a migration from the one before (`MIGRATIONS`). */
export const BOARD_EXPORT_VERSION = 1;
/** The most an export may weigh, as JSON, to import, besides its images' files. */
export const BOARD_EXPORT_MAX_BYTES = 4 * 1024 * 1024;
/** The most a file may weigh with its images: all a board may hold, as base64. */
export const BOARD_EXPORT_MAX_FILE_BYTES =
	BOARD_EXPORT_MAX_BYTES + Math.ceil((IMAGE_LIMITS.boardBytes * 4) / 3) + 1024 * 1024;
/** The most shapes an import may have. */
export const BOARD_EXPORT_MAX_SHAPES = 10_000;

/** Transaction origin for writing an import into a new board: how it starts, so never undoable. */
export const IMPORT_ORIGIN = "import";

/** A shape in an export: its id, type and position, and the properties `KEEP` lists for its type. */
export interface ExportedShape {
	id: string;
	type: ShapeType;
	x: number;
	y: number;
	[key: string]: unknown;
}

export interface ExportedRule {
	id: string;
	trigger: RuleTrigger;
	action: RuleAction;
	enabled: boolean;
	name?: string;
}

export type ExportedStep = PreparedPlan & { id: string };

export interface BoardExport {
	format: typeof BOARD_EXPORT_FORMAT;
	version: typeof BOARD_EXPORT_VERSION;
	title: string;
	/** ISO 8601. */
	exportedAt: string;
	/** Bottom of the stack first. */
	shapes: ExportedShape[];
	rules: ExportedRule[];
	prepared: ExportedStep[];
	/**
	 * The repositories the board was made for (from a template), whose items
	 * its rules may place: `github.com/owner/name`. Absent if there are none.
	 */
	repos?: string[];
	/**
	 * The files image shapes show, when the exporter included them (a
	 * download does; backups don't). Never sent to the server: the browser
	 * uploads them to the board an import makes (`splitImages`).
	 */
	images?: ExportedImage[];
	/** What people did on the board, when the exporter asked for it. Never imported. */
	activity?: ExportedActivity;
}

/** What people did on a board, about the shapes in its export (by their ids). */
export interface ExportedActivity {
	/** Dot votes, oldest first. */
	votes: ExportedVote[];
	/** Decisions' agree and disagree votes, for decisions anyone's voted on. */
	decisions: { shape: string; agree: ExportedPerson[]; disagree: ExportedPerson[] }[];
	/** Stamps, by shape and kind, in the order people stamped. */
	stamps: { shape: string; emoji: StampEmoji; people: ExportedPerson[] }[];
	/** Hands up, by shape, in the order people put them up. */
	volunteers: { shape: string; people: ExportedPerson[] }[];
	/** Comment threads still showing, oldest first. */
	comments: ExportedThread[];
	/** What the cards (and decisions' and action items' links) show, as the exporter saw it. */
	items: ExportedItem[];
}

export interface ExportedPerson {
	name: string;
	login?: string;
}

export interface ExportedVote {
	id: string;
	title?: string;
	/** The section it covers, or null for the whole board. */
	scope: string | null;
	/** Dots per person. */
	dots: number;
	hidden: boolean;
	/** Whether 👍 reactions on cards' items counted as votes. */
	reactions: boolean;
	startedAt: string;
	endsAt?: string;
	/** When it closed; absent while it's open. */
	closedAt?: string;
	/** How many people have put dots down. */
	voters: number;
	/** Most votes first. Absent while a hidden vote is open. */
	results?: ExportedResult[];
}

export interface ExportedResult {
	shape: string;
	/** 1 for the most votes; shapes tied share a rank. */
	rank: number;
	dots: number;
	reactions: number;
	total: number;
	/** Who put dots on it: never for a hidden vote. */
	by?: (ExportedPerson & { dots: number })[];
	/** Whose 👍 counted, where known: never for a hidden vote. */
	reactors?: string[];
}

export interface ExportedThread {
	id: string;
	/** The shape it's pinned to; absent for a pin on the canvas. */
	shape?: string;
	x: number;
	y: number;
	resolved?: { by: ExportedPerson; at: string };
	messages: { author: ExportedPerson; body: string; at: string; editedAt?: string }[];
}

export interface ExportedItem {
	key: string;
	kind: CardKind;
	title: string;
	state: CardState;
	stateReason?: string;
	url: string;
	labels: string[];
	assignees: string[];
	author?: string;
	comments: number;
	reactions: number;
	thumbsUp?: number;
	milestone?: string;
	/** Discussions: their category, upvotes and whether they're answered. */
	category?: string;
	upvotes?: number;
	answered?: boolean;
	updatedAt: string;
}

/** An image file in an export. */
export interface ExportedImage {
	/** The hex SHA-256 of its bytes, which image shapes name it by. */
	hash: string;
	type: ImageType;
	/** Its bytes, base64. */
	data: string;
}

/** What an export left out, to say so. */
export interface ExportOmissions {
	/** Cards (and links on decisions and action items) from repositories the exporter can't read. */
	cards: number;
	/** Stickies still face down in silent mode. */
	faceDown: number;
}

/** Properties copied for each type, beyond `id`, `type`, `x`, `y`, `parent` and `order`. */
const KEEP: Record<ShapeType, readonly string[]> = {
	card: ["ref", "stack"],
	sticky: ["text", "color", "font", "author", "stack"],
	text: ["text", "color", "font", "size"],
	section: ["title", "color", "w", "h", "display", "sort", "prompt", "inbox"],
	connector: ["from", "to", "label", "route", "arrow", "dash", "color"],
	decision: [
		"title",
		"text",
		"status",
		"outcome",
		"consequences",
		"ref",
		"decidedAt",
		"decidedBy",
		"supersededBy",
		"author",
	],
	widget: ["widget", "config", "w", "h"],
	action: ["text", "owner", "due", "done", "ref", "author"],
	// A suggested name is the board's content as much as a person's (stacks.ts).
	stack: ["title", "suggested"],
	// A link's preview is what anyone who opens the address sees (links.ts).
	link: ["url", "preview", "stack"],
	// Its file by hash; one still uploading isn't exported at all.
	image: ["image", "mime", "iw", "ih", "w", "h", "alt", "caption"],
};

const SHAPE_TYPES = Object.keys(KEEP) as ShapeType[];

function isShapeType(value: unknown): value is ShapeType {
	return typeof value === "string" && (SHAPE_TYPES as string[]).includes(value);
}

export interface ExportOptions {
	title: string;
	now?: string;
	/**
	 * Whether a card's item may go in the file (by item key). The client
	 * leaves out what the exporter can't read; backups, what isn't public.
	 * Cards it refuses are left out; decisions and action items lose the link.
	 */
	includeCard?: (key: string) => boolean;
	/** Carry what people did on the board too (`ExportedActivity`). */
	activity?: {
		/** The items cards show, as the exporter sees them. */
		cards: (key: string) => Card | MissingCard | undefined;
		/** The board's comment threads, which aren't in the document. */
		threads: Iterable<CommentThread>;
	};
}

/** A board's document as an export, and what was left out. */
export function exportBoard(
	doc: Y.Doc,
	{ title, now = new Date().toISOString(), includeCard = () => true, activity }: ExportOptions,
): { data: BoardExport; omitted: ExportOmissions } {
	const omitted: ExportOmissions = { cards: 0, faceDown: 0 };
	const entries: { id: string; z: string; props: Record<string, unknown> }[] = [];
	for (const [id, map] of shapesMap(doc)) {
		const props = map.toJSON() as Record<string, unknown>;
		const type = props.type;
		if (!isShapeType(type)) continue;
		if (type === "sticky" && props.silent !== undefined) {
			omitted.faceDown++;
			continue;
		}
		const ref = typeof props.ref === "string" ? props.ref : null;
		if (ref && !includeCard(ref)) {
			omitted.cards++;
			if (type === "card") continue;
			delete props.ref;
		}
		if (type === "card" && !ref) continue;
		if (type === "image" && !isImageHash(props.image)) continue;
		entries.push({ id, z: typeof props.z === "string" ? props.z : "", props });
	}
	const kept = new Set(entries.map((entry) => entry.id));
	entries.sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : a.id.localeCompare(b.id)));

	const shapes: ExportedShape[] = [];
	for (const { id, props } of entries) {
		const type = props.type as ShapeType;
		const shape: ExportedShape = {
			id,
			type,
			x: Number(props.x) || 0,
			y: Number(props.y) || 0,
		};
		if (type !== "connector") {
			shape.parent =
				typeof props.parent === "string" && kept.has(props.parent) ? props.parent : null;
			if (typeof props.order === "string") shape.order = props.order;
		}
		for (const key of KEEP[type]) {
			if (props[key] !== undefined) shape[key] = props[key];
		}
		if (type === "connector") {
			// An end on a shape that was left out stays where it was drawn.
			for (const end of ["from", "to"] as const) {
				const value = shape[end] as { shape?: unknown; anchor?: unknown } | undefined;
				if (value && typeof value.shape === "string" && !kept.has(value.shape)) {
					const { shape: _shape, anchor: _anchor, ...loose } = value;
					shape[end] = loose;
				}
			}
		}
		if (type === "decision" && typeof shape.supersededBy === "string") {
			if (!kept.has(shape.supersededBy)) delete shape.supersededBy;
		}
		if (isStackable(type) && shape.stack !== undefined) {
			if (typeof shape.stack !== "string" || !kept.has(shape.stack)) delete shape.stack;
		}
		shapes.push(shape);
	}

	const rules: ExportedRule[] = [];
	for (const [id, map] of rulesMap(doc)) {
		const rule = readRule(map);
		if (!rule) continue;
		if (rule.action.kind === "section" && !kept.has(rule.action.section)) continue;
		rules.push({
			id,
			trigger: rule.trigger,
			action: rule.action,
			enabled: rule.enabled,
			...(rule.name ? { name: rule.name } : {}),
		});
	}

	const prepared: ExportedStep[] = readPrepared(doc).flatMap((step) => {
		const { startedAt: _at, startedBy: _by, ...plain } = step;
		const section =
			plain.kind === "silent" ? plain.section : plain.kind === "vote" ? plain.scope : null;
		return section !== null && !kept.has(section) ? [] : [plain as ExportedStep];
	});

	return {
		data: {
			format: BOARD_EXPORT_FORMAT,
			version: BOARD_EXPORT_VERSION,
			title,
			exportedAt: now,
			shapes,
			rules,
			prepared,
			...(scopeRepos(doc).length ? { repos: scopeRepos(doc) } : {}),
			...(activity
				? { activity: exportActivity(doc, shapes, { ...activity, includeCard, now }) }
				: {}),
		},
		omitted,
	};
}

function person({ name, login }: { name: string; login?: string }): ExportedPerson {
	return login ? { name, login } : { name };
}

function commenter(author: CommentAuthor): ExportedPerson {
	return { name: author.name ?? author.login, login: author.login };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** What people did on the board, about the shapes an export kept. */
function exportActivity(
	doc: Y.Doc,
	shapes: readonly ExportedShape[],
	{
		cards,
		threads,
		includeCard,
		now,
	}: NonNullable<ExportOptions["activity"]> & {
		includeCard: (key: string) => boolean;
		now: string;
	},
): ExportedActivity {
	// Where each shape is in the file, to list what's about them in the same order.
	const at = new Map(shapes.map((shape, i) => [shape.id, i]));
	const kept = new Set(at.keys());
	const byShape = (a: { shape: string }, b: { shape: string }) =>
		(at.get(a.shape) ?? 0) - (at.get(b.shape) ?? 0);
	// The tally reads only items the exporter may: anyone else's 👍s aren't theirs to count.
	const readable = (key: string) => (includeCard(key) ? cards(key) : undefined);

	const votes = readVotes(doc).map((vote): ExportedVote => {
		const closed = closedAt(vote, Date.parse(now));
		const out: ExportedVote = {
			id: vote.id,
			...(vote.title ? { title: vote.title } : {}),
			scope: vote.scope,
			dots: vote.dots,
			hidden: vote.hidden,
			reactions: vote.reactions,
			startedAt: vote.startedAt,
			...(vote.endsAt ? { endsAt: vote.endsAt } : {}),
			...(closed ? { closedAt: closed } : {}),
			voters: turnout(vote).voters,
		};
		if (vote.hidden && !closed) return out;
		out.results = tallyVote(vote, doc, readable)
			.filter((row) => kept.has(row.shape))
			.map((row) => ({
				shape: row.shape,
				rank: row.rank,
				dots: row.dots,
				reactions: row.reactions,
				total: row.total,
				...(vote.hidden
					? {}
					: {
							by: row.dotters.map((dotter) => ({ ...person(dotter), dots: dotter.dots })),
							reactors: row.reactors,
						}),
			}));
		return out;
	});

	const decisions: ExportedActivity["decisions"] = [];
	const items: ExportedItem[] = [];
	const seen = new Set<string>();
	for (const shape of shapes) {
		if (shape.type === "decision") {
			const votes = shapesMap(doc).get(shape.id)?.get("votes");
			const { agree, disagree, total } = tally(readDecisionVotes(votes));
			if (total > 0) {
				decisions.push({
					shape: shape.id,
					agree: agree.map(person),
					disagree: disagree.map(person),
				});
			}
		}
		// Shapes in the file keep only refs the exporter may read.
		const ref = typeof shape.ref === "string" ? shape.ref : null;
		if (!ref || seen.has(ref)) continue;
		seen.add(ref);
		const card = cards(ref);
		if (card && !isMissing(card)) items.push(exportItem(card));
	}

	const stamps: ExportedActivity["stamps"] = [];
	for (const [shape, counts] of stampCounts(stampsMap(doc).entries(), null)) {
		if (!kept.has(shape)) continue;
		for (const count of counts) {
			stamps.push({ shape, emoji: count.emoji, people: count.people.map(person) });
		}
	}
	stamps.sort(byShape);

	const volunteers: ExportedActivity["volunteers"] = [];
	for (const [shape, people] of readVolunteers(volunteersMap(doc).entries())) {
		if (kept.has(shape)) volunteers.push({ shape, people: people.map(person) });
	}
	volunteers.sort(byShape);

	const ids = new Set(shapesMap(doc).keys());
	const comments: ExportedThread[] = [];
	for (const thread of [...threads].sort((a, b) => a.createdAt - b.createdAt)) {
		const messages = liveMessages(thread);
		if (messages.length === 0) continue;
		const { shape, x, y } = thread.anchor;
		// On a shape the file left out (a card the exporter can't read, a face-down sticky):
		// the thread's about it. A shape that's been deleted leaves a pin on the canvas.
		if (shape && ids.has(shape) && !kept.has(shape)) continue;
		comments.push({
			id: thread.id,
			...(shape && kept.has(shape) ? { shape } : {}),
			x,
			y,
			...(thread.resolved
				? { resolved: { by: commenter(thread.resolved.by), at: iso(thread.resolved.at) } }
				: {}),
			messages: messages.map((message) => ({
				author: commenter(message.author),
				body: message.body,
				at: iso(message.at),
				...(message.editedAt ? { editedAt: iso(message.editedAt) } : {}),
			})),
		});
	}

	return { votes, decisions, stamps, volunteers, comments, items };
}

function exportItem(card: Card): ExportedItem {
	const discussion = card.discussion;
	return {
		key: card.key,
		kind: card.kind,
		title: card.title,
		state: card.state,
		...(card.stateReason ? { stateReason: card.stateReason } : {}),
		url: card.url,
		labels: card.labels.map((label) => label.name),
		assignees: card.assignees.map((assignee) => assignee.login),
		...(card.author ? { author: card.author.login } : {}),
		comments: card.comments,
		reactions: card.reactions,
		...(card.thumbsUp ? { thumbsUp: card.thumbsUp.count } : {}),
		...(card.milestone ? { milestone: card.milestone.title } : {}),
		...(discussion
			? {
					category: discussion.category.name,
					...(discussion.upvotes !== undefined ? { upvotes: discussion.upvotes } : {}),
					answered: discussion.answered,
				}
			: {}),
		updatedAt: card.updatedAt,
	};
}

/** An export as a file's text: tabs, one property per line, so it diffs well in git. */
export function serialiseExport(data: BoardExport): string {
	return `${JSON.stringify(data, null, "\t")}\n`;
}

/** A file name for an export: `planning-session-2026-10-11.json`. */
export function exportFileName(title: string, extension: string, now = new Date()): string {
	const slug =
		title
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60)
			.replace(/-+$/, "") || "board";
	return `${slug}-${now.toISOString().slice(0, 10)}.${extension}`;
}

// --- Reading an export -------------------------------------------------------------------

const text = (max: number) => v.pipe(v.string(), v.maxLength(max));
const coordinate = v.pipe(v.number(), v.finite(), v.minValue(-1e7), v.maxValue(1e7));
const extent = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1e6));
const ShapeId = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const ItemKey = v.pipe(
	v.string(),
	v.maxLength(400),
	v.check((key) => parseKey(key) !== null, "Not an item key"),
);
const Instant = text(40);
const ImageHash = v.pipe(v.string(), v.regex(IMAGE_HASH));
const Color = text(32);
const Author = v.object({ name: text(200), color: text(64), login: v.optional(text(100)) });
const Point = v.object({ x: coordinate, y: coordinate });
const End = v.object({
	x: coordinate,
	y: coordinate,
	shape: v.optional(ShapeId),
	anchor: v.optional(Point),
});
const Query = v.object({
	kind: v.literal("search"),
	host: text(253),
	q: text(2000),
	sort: v.optional(v.picklist(["updated", "created", "comments", "reactions"])),
	order: v.optional(v.picklist(["asc", "desc"])),
	limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
});

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
/** Widget settings: any JSON (each kind reads its own through its schema, with defaults). */
const JsonValue: v.GenericSchema<Json> = v.lazy(() =>
	v.union([
		v.pipe(v.string(), v.maxLength(10_000)),
		v.pipe(v.number(), v.finite()),
		v.boolean(),
		v.null(),
		v.pipe(v.array(JsonValue), v.maxLength(500)),
		v.record(v.pipe(v.string(), v.maxLength(100)), JsonValue),
	]),
);

const common = {
	id: ShapeId,
	x: coordinate,
	y: coordinate,
	parent: v.optional(v.nullable(ShapeId)),
	order: v.optional(text(64)),
};

const ShapeSchema = v.variant("type", [
	v.object({ ...common, type: v.literal("card"), ref: ItemKey, stack: v.optional(ShapeId) }),
	v.object({
		...common,
		type: v.literal("sticky"),
		text: v.optional(text(10_000)),
		color: v.optional(Color),
		font: v.optional(v.picklist(["sans", "hand"])),
		author: v.optional(Author),
		stack: v.optional(ShapeId),
	}),
	v.object({
		...common,
		type: v.literal("text"),
		text: v.optional(text(20_000)),
		color: v.optional(Color),
		font: v.optional(v.picklist(["sans", "hand"])),
		size: v.optional(v.picklist(["s", "m", "l", "xl"])),
	}),
	v.object({
		...common,
		type: v.literal("section"),
		title: v.optional(text(400)),
		color: v.optional(Color),
		w: extent,
		h: extent,
		display: v.optional(v.picklist(["cards", "list", "mini"])),
		sort: v.optional(
			v.object({ by: v.picklist(["state", "number", "title"]), desc: v.optional(v.boolean()) }),
		),
		prompt: v.optional(text(400)),
		inbox: v.optional(v.object({ query: Query })),
	}),
	v.object({
		...common,
		type: v.literal("connector"),
		from: End,
		to: End,
		label: v.optional(text(400)),
		route: v.optional(v.picklist(["curved", "straight", "elbow"])),
		arrow: v.optional(v.picklist(["end", "both", "none"])),
		dash: v.optional(v.boolean()),
		color: v.optional(Color),
	}),
	v.object({
		...common,
		type: v.literal("decision"),
		title: v.optional(text(400)),
		text: v.optional(text(20_000)),
		status: v.optional(v.picklist(["proposed", "decided", "superseded"])),
		outcome: v.optional(text(10_000)),
		consequences: v.optional(text(10_000)),
		ref: v.optional(ItemKey),
		decidedAt: v.optional(Instant),
		decidedBy: v.optional(Author),
		supersededBy: v.optional(ShapeId),
		author: v.optional(Author),
	}),
	v.object({
		...common,
		type: v.literal("widget"),
		widget: text(64),
		config: v.optional(JsonValue),
		w: extent,
		h: extent,
	}),
	v.object({
		...common,
		type: v.literal("action"),
		text: v.optional(text(10_000)),
		owner: v.optional(
			v.object({
				login: text(100),
				name: v.optional(v.nullable(text(200))),
				avatarUrl: v.optional(text(500)),
			}),
		),
		due: v.optional(
			v.pipe(
				v.string(),
				v.check((value: string) => isDate(value), "Not a date"),
			),
		),
		done: v.optional(Instant),
		ref: v.optional(ItemKey),
		author: v.optional(Author),
	}),
	v.object({
		...common,
		type: v.literal("stack"),
		title: v.optional(text(400)),
		suggested: v.optional(v.object({ title: text(200), hash: text(64) })),
	}),
	v.object({
		...common,
		type: v.literal("link"),
		url: v.pipe(
			v.string(),
			v.maxLength(LINK_LIMITS.url),
			v.check((url: string) => linkUrl(url) !== null, "Not a web address"),
		),
		// Read again field by field as the document's previews are (`readPreview`).
		preview: v.optional(
			v.pipe(
				v.looseObject({ status: v.picklist(["ok", "failed", "blocked"]), fetchedAt: Instant }),
				v.transform((value) => readPreview(value) ?? undefined),
			),
		),
		stack: v.optional(ShapeId),
	}),
	v.object({
		...common,
		type: v.literal("image"),
		image: ImageHash,
		mime: v.optional(v.picklist(IMAGE_TYPES)),
		iw: v.optional(extent),
		ih: v.optional(extent),
		w: extent,
		h: extent,
		alt: v.optional(text(IMAGE_LIMITS.alt)),
		caption: v.optional(v.boolean()),
	}),
]);

/** An image file, base64: no bigger than a board stores (a third more, as base64). */
const ImageSchema = v.object({
	hash: ImageHash,
	type: v.picklist(IMAGE_TYPES),
	data: v.pipe(
		v.string(),
		v.maxLength(Math.ceil(IMAGE_LIMITS.bytes / 3) * 4),
		v.regex(/^[A-Za-z0-9+/]*={0,2}$/),
	),
});

const RuleSchema = v.object({
	id: ShapeId,
	trigger: v.variant("kind", [
		v.object({ kind: v.literal("pull-links"), closesOnly: v.optional(v.boolean()) }),
		v.object({ kind: v.literal("matches"), query: Query }),
	]),
	action: v.variant("kind", [
		v.object({ kind: v.literal("beside-linked") }),
		v.object({ kind: v.literal("section"), section: ShapeId }),
	]),
	enabled: v.optional(v.boolean()),
	name: v.optional(text(200)),
});

/** Steps are read again by `readStep` as they're written, as the document's are. */
const StepSchema = v.looseObject({
	id: ShapeId,
	kind: v.picklist(["timer", "silent", "vote"]),
});

const ExportSchema = v.object({
	format: v.literal(BOARD_EXPORT_FORMAT),
	version: v.literal(BOARD_EXPORT_VERSION),
	title: v.optional(text(MAX_TITLE * 4), ""),
	exportedAt: v.optional(Instant),
	shapes: v.pipe(v.array(ShapeSchema), v.maxLength(BOARD_EXPORT_MAX_SHAPES)),
	rules: v.optional(v.pipe(v.array(RuleSchema), v.maxLength(500)), []),
	repos: v.optional(
		v.pipe(v.array(v.pipe(v.string(), v.maxLength(300))), v.maxLength(TEMPLATE_REPOS_MAX)),
	),
	prepared: v.optional(v.pipe(v.array(StepSchema), v.maxLength(200)), []),
	images: v.optional(v.pipe(v.array(ImageSchema), v.maxLength(IMAGE_LIMITS.boardCount))),
});

/** `POST /api/boards/import`: a new board from an export. */
export interface ImportBoardRequest {
	board: BoardExport;
	/** Defaults to the export's own title. */
	title?: string;
	visibility?: Visibility;
}

/** What `POST /api/boards/import` answers: the new board, and what was imported into it. */
export interface ImportedBoard extends CreatedBoard {
	/** Null if the board was made but laying it out failed (it's logged). */
	imported: ImportResult | null;
}

/** Why a file couldn't be read as a board. */
export type ImportError =
	| { reason: "not_json" }
	| { reason: "not_tack" }
	| { reason: "newer"; version: number }
	| { reason: "too_large" }
	| { reason: "invalid"; where: string; message: string };

export type ReadResult = { ok: true; data: BoardExport } | { ok: false; error: ImportError };

/**
 * Migrations from each version to the next, for files from older Tacks:
 * `MIGRATIONS[n]` turns version n into n + 1. None yet.
 */
const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {};

/** An export from a file's text, or from JSON already parsed, checked throughout. */
export function readBoardExport(input: unknown): ReadResult {
	let raw: unknown = input;
	if (typeof input === "string") {
		const bytes = new TextEncoder().encode(input).byteLength;
		if (bytes > BOARD_EXPORT_MAX_FILE_BYTES) return { ok: false, error: { reason: "too_large" } };
		try {
			raw = JSON.parse(input);
		} catch {
			return { ok: false, error: { reason: "not_json" } };
		}
		// Past the limit only with images and activity, which are weighed apart (activity's dropped).
		if (bytes > BOARD_EXPORT_MAX_BYTES) {
			const {
				images: _images,
				activity: _activity,
				...rest
			} = (raw ?? {}) as Record<string, unknown>;
			if (new TextEncoder().encode(JSON.stringify(rest)).byteLength > BOARD_EXPORT_MAX_BYTES) {
				return { ok: false, error: { reason: "too_large" } };
			}
		}
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, error: { reason: "not_tack" } };
	}
	let record = raw as Record<string, unknown>;
	if (record.format !== BOARD_EXPORT_FORMAT) return { ok: false, error: { reason: "not_tack" } };
	let version = record.version;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
		return { ok: false, error: { reason: "invalid", where: "version", message: "Not a version" } };
	}
	if (version > BOARD_EXPORT_VERSION) return { ok: false, error: { reason: "newer", version } };
	while (version < BOARD_EXPORT_VERSION) {
		const migrate = MIGRATIONS[version];
		if (!migrate) return { ok: false, error: { reason: "not_tack" } };
		record = { ...migrate(record), version: ++version };
	}
	const parsed = v.safeParse(ExportSchema, record);
	if (!parsed.success) {
		const issue = parsed.issues[0];
		return {
			ok: false,
			error: {
				reason: "invalid",
				where: issue ? (v.getDotPath(issue) ?? "") : "",
				message: issue?.message ?? "",
			},
		};
	}
	const ids = new Set<string>();
	for (const shape of parsed.output.shapes) {
		if (ids.has(shape.id)) {
			return {
				ok: false,
				error: { reason: "invalid", where: "shapes", message: `Two shapes are called ${shape.id}` },
			};
		}
		ids.add(shape.id);
	}
	return { ok: true, data: parsed.output as unknown as BoardExport };
}

/**
 * An export's image files apart from the rest, which is what goes to the
 * server: the browser uploads the files to the board it makes.
 */
export function splitImages(data: BoardExport): { board: BoardExport; images: ExportedImage[] } {
	const { images = [], ...board } = data;
	return { board, images };
}

/** Why an import failed, in words. */
export function describeImportError(error: ImportError): string {
	switch (error.reason) {
		case "not_json":
			return "That isn’t JSON. Export the board from Tack’s board menu, then try that file.";
		case "not_tack":
			return "That’s JSON, but not a board exported from Tack.";
		case "newer":
			return `That was exported by a newer version of Tack (format ${error.version}). Update this Tack, then try again.`;
		case "too_large":
			return "That’s too big to import: boards up to 4 MB can be, besides their images.";
		case "invalid":
			return `Something in it isn’t right${error.where ? ` (at ${error.where})` : ""}: ${error.message}.`;
	}
}

/** What's in an export, counted, for the importer to see before making a board. */
export interface ExportSummary {
	shapes: number;
	counts: Partial<Record<ShapeType, number>>;
	rules: number;
	prepared: number;
	/** What people did, counted, when the export carries it: stamps and hands up by person. */
	activity?: { votes: number; stamps: number; volunteers: number; comments: number; items: number };
}

export function summariseExport(data: BoardExport): ExportSummary {
	const counts: Partial<Record<ShapeType, number>> = {};
	for (const shape of data.shapes) counts[shape.type] = (counts[shape.type] ?? 0) + 1;
	const { activity } = data;
	const people = (groups: readonly { people: readonly unknown[] }[]) =>
		groups.reduce((n, group) => n + group.people.length, 0);
	return {
		shapes: data.shapes.length,
		counts,
		rules: data.rules.length,
		prepared: data.prepared.length,
		...(activity
			? {
					activity: {
						votes: activity.votes.length,
						stamps: people(activity.stamps),
						volunteers: people(activity.volunteers),
						comments: activity.comments.length,
						items: activity.items.length,
					},
				}
			: {}),
	};
}

// --- Importing ---------------------------------------------------------------------------

export interface ImportOptions {
	/** Who's importing, for its rules. */
	by: { name: string; color?: string; login?: string };
	now?: string;
	/** Fresh ids; tests pass a counter. */
	newId?: () => string;
}

export interface ImportResult {
	shapes: number;
	rules: number;
	prepared: number;
}

function validOrder(order: unknown): order is string {
	if (typeof order !== "string") return false;
	try {
		generateKeyBetween(order, null);
		return true;
	} catch {
		return false;
	}
}

/**
 * Write an export into a document (an empty one: a new board), with fresh
 * ids throughout and references between shapes remapped; references to
 * shapes that aren't in it are dropped. One transaction with
 * `IMPORT_ORIGIN`: it's how the board starts, so there's nothing to undo.
 */
export function importBoard(
	doc: Y.Doc,
	data: BoardExport,
	{ by, now = new Date().toISOString(), newId = () => crypto.randomUUID() }: ImportOptions,
): ImportResult {
	const ids = new Map<string, string>();
	const types = new Map<string, ShapeType>();
	for (const shape of data.shapes) {
		ids.set(shape.id, newId());
		types.set(shape.id, shape.type);
	}
	const sectionId = (old: unknown) =>
		typeof old === "string" && types.get(old) === "section" ? (ids.get(old) ?? null) : null;
	const zs = data.shapes.length ? generateNKeysBetween(null, null, data.shapes.length) : [];
	const result: ImportResult = { shapes: 0, rules: 0, prepared: 0 };

	doc.transact(() => {
		const shapes = shapesMap(doc);
		data.shapes.forEach((shape, i) => {
			const { id: oldId, type, ...props } = shape;
			const map = new Y.Map<unknown>();
			map.set("type", type);
			for (const [key, value] of Object.entries(props)) {
				if (value === undefined || key === "parent" || key === "order") continue;
				if (!KEEP[type].includes(key) && key !== "x" && key !== "y") continue;
				map.set(key, structuredClone(value));
			}
			map.set("z", zs[i]);
			if (type !== "connector") {
				map.set("parent", sectionId(props.parent));
				if (validOrder(props.order)) map.set("order", props.order);
			} else {
				map.set("x", 0);
				map.set("y", 0);
				for (const end of ["from", "to"] as const) {
					const value = structuredClone(props[end]) as { shape?: string; anchor?: unknown };
					const target = value.shape ? ids.get(value.shape) : undefined;
					if (target) value.shape = target;
					else {
						delete value.shape;
						delete value.anchor;
					}
					map.set(end, value);
				}
			}
			if (type === "decision") {
				const superseded = props.supersededBy;
				if (typeof superseded === "string") {
					const target = types.get(superseded) === "decision" ? ids.get(superseded) : undefined;
					if (target) map.set("supersededBy", target);
					else map.delete("supersededBy");
				}
				// Votes merge only in a map made with the decision.
				map.set("votes", new Y.Map());
			}
			if (type === "section" && props.inbox) map.set("dismissed", new Y.Map());
			if (isStackable(type) && props.stack !== undefined) {
				const old = typeof props.stack === "string" ? props.stack : "";
				const stack = types.get(old) === "stack" ? ids.get(old) : null;
				if (stack) map.set("stack", stack);
				else map.delete("stack");
			}
			shapes.set(ids.get(oldId) as string, map);
			result.shapes++;
		});

		for (const rule of data.rules) {
			const action =
				rule.action.kind === "section"
					? { kind: "section" as const, section: sectionId(rule.action.section) }
					: rule.action;
			if (action.kind === "section" && !action.section) continue;
			const id = newId();
			const map = new Y.Map<unknown>();
			map.set("id", id);
			map.set("trigger", structuredClone(rule.trigger));
			map.set("action", action);
			map.set("enabled", rule.enabled !== false);
			map.set("createdBy", {
				name: by.name,
				...(by.color ? { color: by.color } : {}),
				...(by.login ? { login: by.login } : {}),
			});
			map.set("createdAt", now);
			if (rule.name) map.set("name", rule.name);
			rulesMap(doc).set(id, map);
			if (readRule(rulesMap(doc).get(id))) result.rules++;
			else rulesMap(doc).delete(id);
		}

		// Rules may place items from the repositories it was made for, as on the board exported.
		setScopeRepos(doc, cleanRepos(data.repos), IMPORT_ORIGIN);

		const prepared = preparedMap(doc);
		for (const step of data.prepared) {
			const raw = structuredClone(step) as Record<string, unknown>;
			if (raw.kind === "silent") raw.section = sectionId(raw.section);
			// A vote over the whole board has no scope; one over a section needs it here.
			if (raw.kind === "vote" && raw.scope !== null && raw.scope !== undefined) {
				raw.scope = sectionId(raw.scope);
				if (raw.scope === null) continue;
			}
			const id = newId();
			const read = readStep(id, raw);
			if (!read) continue;
			const { id: _id, startedAt: _at, startedBy: _by, ...plain } = read;
			prepared.set(id, plain);
			result.prepared++;
		}
	}, IMPORT_ORIGIN);
	return result;
}
