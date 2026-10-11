import type * as Y from "yjs";
import type { AiItem, AiLeftOut, AiTask, WidgetContext } from "../../shared/ai.ts";
import { collectItems, selectedCardKeys, widgetContext } from "../../shared/aiContext.ts";
import type { Card, MissingCard } from "../../shared/cards.ts";
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
		if (input.task === "widget") {
			return { ok: true, task: "widget", context: widgetContext(this.host.doc, input.login) };
		}
		await this.host.settled();
		const shapes = readShapes(this.host.doc);
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
}
