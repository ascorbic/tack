import type * as Y from "yjs";
import type { Operation, PendingChange } from "./changes.ts";
import { type ShapeProps, readShape, shapesMap } from "./shapes.ts";

// Where a new issue came from: a line at the foot of an issue made from a
// sticky or a section, linking back to the board and the section it was
// in, and crediting whoever wrote the sticky, since GitHub shows whoever
// pushed as the issue's author. Whoever pushes chooses whether to add it (on
// by default, a switch in the push sheet); the push engine writes it with
// the rest of the issue, and the sheet previews the same words.

/** The board, as the credit line links to it. */
export interface CreditBoard {
	/** The board's own link, `https://tack.example.com/b/{id}/{slug}`. */
	url: string;
	title: string;
}

/** What a credit line says, before it's written as Markdown. */
export interface Credit {
	board: CreditBoard;
	/** The section it was in, or that became the parent issue. */
	section: string | null;
	/** "an idea by @priya", for an issue made from someone's sticky. */
	by: string | null;
}

/** Text for a Markdown link label: one line, nothing that could be markup. */
function plain(text: string): string {
	return text
		.replace(/[[\]\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[\\*_`~<>|]/g, (char) => `\\${char}`);
}

/** Who wrote a sticky: their GitHub login if they were signed in, or their name. */
function byline(shape: ShapeProps): string | null {
	const author = shape.author;
	if (!author) return null;
	if (author.login && /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(author.login)) {
		return `an idea by @${author.login}`;
	}
	const name = (author.name ?? "").replace(/\s+/g, " ").trim();
	return name ? `an idea by ${name}` : null;
}

/** A section's title, if `id` is a section with one. */
function sectionTitle(shapes: Y.Map<Y.Map<unknown>>, id: string | null | undefined): string | null {
	const raw = id ? shapes.get(id) : undefined;
	if (!raw) return null;
	const shape = readShape(raw);
	return shape.type === "section" && shape.title?.trim()
		? shape.title.replace(/\s+/g, " ").trim()
		: null;
}

/**
 * Where a new issue came from, or null if it wasn't made from the board's
 * own words: a sticky (`replace`), or a section or cluster that became a
 * parent issue (`place`).
 */
export function creditFor(
	doc: Y.Doc,
	change: Pick<PendingChange, "op" | "effect" | "shapes">,
	board: CreditBoard,
): Credit | null {
	if (change.op.kind !== "issue.create") return null;
	const shapes = shapesMap(doc);
	if (change.effect?.kind === "replace") {
		const raw = shapes.get(change.effect.shapes[0] ?? "");
		if (!raw) return null;
		const sticky = readShape(raw);
		if (sticky.type !== "sticky") return null;
		return { board, section: sectionTitle(shapes, sticky.parent), by: byline(sticky) };
	}
	if (change.effect?.kind === "place") {
		return { board, section: sectionTitle(shapes, change.shapes?.[0]), by: null };
	}
	return null;
}

/** "From [Planning](…) › Plugin API, an idea by @priya", small, at an issue's foot. */
export function creditMarkdown(credit: Credit): string {
	const title = plain(credit.board.title) || "a Tack board";
	const where = credit.section ? ` › ${plain(credit.section)}` : "";
	const by = credit.by ? `, ${plain(credit.by)}` : "";
	return `<sub>From [${title}](${credit.board.url})${where}${by}</sub>`;
}

/** The credit line for a new issue, as Markdown, or null if it has none. */
export function creditLine(
	doc: Y.Doc,
	change: Pick<PendingChange, "op" | "effect" | "shapes">,
	board: CreditBoard,
): string | null {
	const credit = creditFor(doc, change, board);
	return credit ? creditMarkdown(credit) : null;
}

/** A new issue's body with its credit line at the foot. */
export function withCredit(op: Operation, line: string | null): Operation {
	if (op.kind !== "issue.create" || !line) return op;
	const body = op.body?.trim();
	return { ...op, body: body ? `${body}\n\n${line}` : line };
}

/** Whether a board link is this board's, on this instance: the only kind a credit line may carry. */
export function isBoardUrl(url: string, origin: string, board: string): boolean {
	try {
		const parsed = new URL(url);
		const path = parsed.pathname.split("/");
		return (
			parsed.origin === origin &&
			path[1] === "b" &&
			decodeURIComponent(path[2] ?? "") === board &&
			path.length <= 4 &&
			/^[\w-]*$/.test(path[3] ?? "") &&
			!parsed.search &&
			!parsed.hash
		);
	} catch {
		return false;
	}
}
