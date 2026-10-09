import { useSyncExternalStore } from "react";
import type { Card, CardMessage, MissingCard } from "../shared/cards.ts";

type Entry = Card | MissingCard;

/**
 * Live card data, fed by the board's custom messages. Kept outside both the
 * Yjs document and React Flow's node data so a card update re-renders only
 * the cards that show it.
 */
class CardStore {
	private cards = new Map<string, Entry>();
	private listeners = new Map<string, Set<() => void>>();

	apply(message: CardMessage): void {
		if (message.type === "cards") for (const card of message.cards) this.set(card);
		else this.set(message.card);
	}

	set(card: Entry): void {
		this.cards.set(card.key, card);
		for (const listener of this.listeners.get(card.key) ?? []) listener();
	}

	get(key: string): Entry | undefined {
		return this.cards.get(key);
	}

	/**
	 * Ask the board to check this viewer's access to private repositories
	 * again (say, they were just added to one). Wired to the live board's
	 * connection; the playground swaps in its own.
	 */
	recheck: () => void = () => {};

	subscribe(key: string, listener: () => void): () => void {
		let set = this.listeners.get(key);
		if (!set) this.listeners.set(key, (set = new Set()));
		set.add(listener);
		return () => set.delete(listener);
	}
}

export const cardStore = new CardStore();

export function useCard(key: string): Entry | undefined {
	return useSyncExternalStore(
		(listener) => cardStore.subscribe(key, listener),
		() => cardStore.get(key),
	);
}
