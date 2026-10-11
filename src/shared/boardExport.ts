import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import * as v from "valibot";
import * as Y from "yjs";
import { isDate } from "./actionItems.ts";
import { type CreatedBoard, MAX_TITLE, type Visibility } from "./boards.ts";
import { type PreparedPlan, preparedMap, readPrepared, readStep } from "./prepared.ts";
import { parseKey } from "./refs.ts";
import { type RuleAction, type RuleTrigger, readRule, rulesMap } from "./rules.ts";
import { type ShapeType, shapesMap } from "./shapes.ts";

// A board as a file (#59): its shapes (cards, stickies, text, sections,
// connectors, decisions, widgets, action items), rules and prepared
// facilitation steps as plain, versioned JSON, to download, keep in a
// repository (backups.ts on the server writes it to an orphan branch) and
// import into a new board.
//
// It's the board's content, not its sessions or the people on it: what's
// left out is everything that's someone's own or only means something on
// this board right now.
//
// | left out                        | why                                          |
// | ------------------------------- | -------------------------------------------- |
// | comments, history, visits       | not in the document; people's own            |
// | votes on decisions, dot votes,  | who voted for what is theirs, and a session's |
// | stamps                          |                                              |
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
// Importing (`readBoardExport`, then `importBoard`) checks everything with
// Valibot, gives every shape, rule and step a fresh id (references remapped,
// dangling ones dropped), and restacks shapes in the file's order.

export const BOARD_EXPORT_FORMAT = "tack.board";
/** Bump when the format changes, and add a migration from the one before (`MIGRATIONS`). */
export const BOARD_EXPORT_VERSION = 1;
/** The most an export may weigh, as JSON, to import. */
export const BOARD_EXPORT_MAX_BYTES = 4 * 1024 * 1024;
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
	card: ["ref"],
	sticky: ["text", "color", "font", "author"],
	text: ["text", "color", "font", "size"],
	section: ["title", "color", "w", "h", "display", "sort", "inbox"],
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
}

/** A board's document as an export, and what was left out. */
export function exportBoard(
	doc: Y.Doc,
	{ title, now = new Date().toISOString(), includeCard = () => true }: ExportOptions,
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
		},
		omitted,
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
	v.object({ ...common, type: v.literal("card"), ref: ItemKey }),
	v.object({
		...common,
		type: v.literal("sticky"),
		text: v.optional(text(10_000)),
		color: v.optional(Color),
		font: v.optional(v.picklist(["sans", "hand"])),
		author: v.optional(Author),
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
]);

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
	prepared: v.optional(v.pipe(v.array(StepSchema), v.maxLength(200)), []),
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
		if (new TextEncoder().encode(input).byteLength > BOARD_EXPORT_MAX_BYTES) {
			return { ok: false, error: { reason: "too_large" } };
		}
		try {
			raw = JSON.parse(input);
		} catch {
			return { ok: false, error: { reason: "not_json" } };
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
			return "That’s too big to import: boards up to 4 MB can be.";
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
}

export function summariseExport(data: BoardExport): ExportSummary {
	const counts: Partial<Record<ShapeType, number>> = {};
	for (const shape of data.shapes) counts[shape.type] = (counts[shape.type] ?? 0) + 1;
	return {
		shapes: data.shapes.length,
		counts,
		rules: data.rules.length,
		prepared: data.prepared.length,
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
