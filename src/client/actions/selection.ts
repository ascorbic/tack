import { useEffect, useMemo, useState } from "react";
import type { Card, MissingCard } from "../../shared/cards.ts";
import { repoKeyOf } from "../../shared/refs.ts";
import type { ShapeNode } from "../board.ts";
import { cardStore } from "../cardStore.ts";
import type { CommandId } from "../shortcuts.ts";

// What a selection can become: which actions apply, and to which shapes.

/** Shortcut commands for the selection actions (see shortcuts.ts). */
export type ActionCommand = Extract<
	CommandId,
	| "makeIssues"
	| "parentIssue"
	| "labels"
	| "milestone"
	| "assign"
	| "closeReopen"
	| "backlink"
	| "blockedBy"
	| "expandRelated"
	| "toActions"
	| "carryOver"
	| "stackThese"
	| "groupThese"
	| "unstack"
>;

/**
 * Shortcuts go to whichever action UI is showing: the selection's action
 * bar, or a connector's toolbar. Each registers what it handles.
 */
export class ActionRequests {
	private handlers = new Set<(id: ActionCommand) => boolean>();

	register(handler: (id: ActionCommand) => boolean): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	/** Open the action's UI; false if nothing showing can do it. */
	request(id: ActionCommand): boolean {
		for (const handler of this.handlers) if (handler(id)) return true;
		return false;
	}
}

type Entry = Card | MissingCard | undefined;

/** Live card data for these keys, re-rendering when any of them changes. */
export function useCards(keys: readonly string[]): Map<string, Entry> {
	const [version, setVersion] = useState(0);
	const joined = keys.join("\n");
	useEffect(() => {
		const list = joined ? joined.split("\n") : [];
		const stops = list.map((key) => cardStore.subscribe(key, () => setVersion((v) => v + 1)));
		return () => {
			for (const stop of stops) stop();
		};
	}, [joined]);
	return useMemo(() => {
		void version;
		const out = new Map<string, Entry>();
		for (const key of joined ? joined.split("\n") : []) out.set(key, cardStore.get(key));
		return out;
	}, [joined, version]);
}

export function isCard(entry: Entry): entry is Card {
	return !!entry && !("missing" in entry);
}

export interface SelectedCard {
	shape: string;
	key: string;
	card: Card;
}

export interface SelectionKinds {
	stickies: ShapeNode[];
	/** Every card shape selected, loaded or not. */
	cardNodes: ShapeNode[];
	/** Loaded cards. */
	cards: SelectedCard[];
	sections: ShapeNode[];
	/** Stacks of stickies (#73). */
	stacks: ShapeNode[];
	/** Text and anything else that can't take part. */
	others: ShapeNode[];
}

export function classify(nodes: readonly ShapeNode[], cards: Map<string, Entry>): SelectionKinds {
	const out: SelectionKinds = {
		stickies: [],
		cardNodes: [],
		cards: [],
		sections: [],
		stacks: [],
		others: [],
	};
	for (const node of nodes) {
		const shape = node.data.shape;
		if (shape.type === "sticky") out.stickies.push(node);
		else if (shape.type === "section") out.sections.push(node);
		else if (shape.type === "stack") out.stacks.push(node);
		else if (shape.type === "card" && shape.ref) {
			out.cardNodes.push(node);
			const card = cards.get(shape.ref);
			if (isCard(card)) out.cards.push({ shape: node.id, key: shape.ref, card });
		} else out.others.push(node);
	}
	return out;
}

/** The repositories of some cards, in order of first appearance. */
export function reposOf(cards: readonly SelectedCard[]): string[] {
	return [...new Set(cards.map((c) => repoKeyOf(c.key)))];
}

/** `acme/unpic` from `github.com/acme/unpic`. */
export function repoName(repo: string): string {
	const slash = repo.indexOf("/");
	return slash === -1 ? repo : repo.slice(slash + 1);
}

/** "an issue", "3 issues" */
export function count(n: number, one: string, many = `${one}s`): string {
	return n === 1 ? `${/^[aeiou]/.test(one) ? "an" : "a"} ${one}` : `${n} ${many}`;
}
