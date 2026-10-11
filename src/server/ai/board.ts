import type * as Y from "yjs";
import type { AiItem, AiLeftOut, AiTask, WidgetContext } from "../../shared/ai.ts";
import { collectItems, selectedCardKeys, widgetContext } from "../../shared/aiContext.ts";
import type { Card, MissingCard } from "../../shared/cards.ts";
import { parseKey } from "../../shared/refs.ts";
import type { ShapeProps } from "../../shared/shapes.ts";
import { readShapes } from "../../shared/structure.ts";
import { AiBudget } from "./limits.ts";

// A board's half of AI (#64), run by its `Board` object: counting requests
// against the board's budget, and reading what the model may read from the
// board's own document and cards, as the person asking may see them.

export interface AiPrepareInput {
	task: AiTask;
	/** Who's asking, for their share of the budget: `user:{id}` or `guest:{…}`. */
	who: string;
	userId: number | null;
	login: string | null;
	/** The shapes to read, for summaries and decisions. */
	shapes?: string[];
	/**
	 * Only cards from public repositories, whoever's asking: on a public
	 * board, what's drafted is public as soon as it's placed.
	 */
	publicOnly: boolean;
}

export type AiPrepared =
	| { ok: true; task: "widget"; context: WidgetContext }
	| { ok: true; task: "summary" | "decision"; items: AiItem[]; leftOut: AiLeftOut }
	| { ok: false; retryAt: number };

type Entry = Card | MissingCard;

export interface AiBoardHost {
	doc: Y.Doc;
	/** Cards the board knows, by key. */
	cards(keys: string[]): Entry[];
	/** Entries as a viewer may see them: private cards they can't read become placeholders. */
	visibleTo(userId: number | null, entries: Entry[]): Promise<Entry[]>;
	/** Wait a moment for a just-woken board's cards. */
	settled(): Promise<void>;
}

export class BoardAi {
	readonly budget = new AiBudget();

	constructor(private host: AiBoardHost) {}

	async prepare(input: AiPrepareInput): Promise<AiPrepared> {
		const spent = this.budget.spend(input.who);
		if (!spent.ok) return spent;
		await this.host.settled();
		const shapes = readShapes(this.host.doc);
		if (input.task === "widget") {
			const context = widgetContext(this.host.doc, input.login);
			const hidden = await this.hiddenRepos(shapes, input);
			const repos = context.repos.filter(
				(repo) => !hidden.has(`${context.host}/${repo}`.toLowerCase()),
			);
			return { ok: true, task: "widget", context: { ...context, repos } };
		}
		const ids = input.shapes ?? [];
		const entries = this.host.cards(selectedCardKeys(shapes, ids));
		const visible = new Map(
			(await this.host.visibleTo(input.userId, entries)).map((entry) => [entry.key, entry]),
		);
		const { items, leftOut } = collectItems(shapes, ids, (key) => {
			const entry = visible.get(key);
			if (!entry) return null;
			if ("missing" in entry) return entry.reason === "private" ? "hidden" : null;
			if (input.publicOnly && entry.visibility !== "public") return "hidden";
			return { card: entry };
		});
		return { ok: true, task: input.task, items, leftOut };
	}

	/**
	 * Repositories (`host/owner/name`, lowercase) the board's cards come from
	 * that the asker can't read (or, on a public board, that aren't public):
	 * a widget request isn't told their names, even though the document has
	 * them, since nothing the model's sent should be anything they couldn't
	 * read themselves.
	 */
	private async hiddenRepos(
		shapes: ReadonlyMap<string, ShapeProps>,
		input: AiPrepareInput,
	): Promise<Set<string>> {
		const keys = new Set<string>();
		for (const shape of shapes.values()) {
			if (shape.type === "card" && shape.ref) keys.add(shape.ref);
		}
		const entries = await this.host.visibleTo(input.userId, this.host.cards([...keys]));
		const hidden = new Set<string>();
		const readable = new Set<string>();
		for (const entry of entries) {
			const repo = repoOf(entry.key);
			if (!repo) continue;
			const isHidden =
				"missing" in entry
					? entry.reason === "private"
					: input.publicOnly && entry.visibility !== "public";
			(isHidden ? hidden : readable).add(repo);
		}
		for (const repo of readable) hidden.delete(repo);
		return hidden;
	}
}

/** An item key's repository, `host/owner/name`, lowercase. */
function repoOf(key: string): string | null {
	const parsed = parseKey(key);
	return parsed ? `${parsed.host}/${parsed.repo}`.toLowerCase() : null;
}
