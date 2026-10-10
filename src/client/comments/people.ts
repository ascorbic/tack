import { useEffect, useSyncExternalStore } from "react";
import type { Mentionable } from "../../shared/comments.ts";

// Who can be mentioned on this board: its members and recent visitors,
// from `GET /api/boards/:id/people`, loaded the first time someone writes a
// comment and kept for a minute. The playground swaps in its own people.

const TTL_MS = 60_000;

class PeopleSource {
	/** Where people come from. The live board points this at its route. */
	load: () => Promise<Mentionable[]> = async () => [];
	/** Your own login, left out of suggestions. */
	self: string | undefined;

	private people: Mentionable[] = [];
	private loadedAt = 0;
	private loading: Promise<void> | null = null;
	/** Bumped on reset, so a fetch for the old board doesn't land on the new one. */
	private generation = 0;
	private listeners = new Set<() => void>();

	/** Fetch people, unless they were fetched lately. */
	refresh(): void {
		if (this.loading || Date.now() - this.loadedAt < TTL_MS) return;
		const generation = this.generation;
		const loading = this.load()
			.then((people) => {
				if (generation !== this.generation) return;
				this.people = people;
				this.loadedAt = Date.now();
				for (const listener of this.listeners) listener();
			})
			.catch(() => {})
			.finally(() => {
				if (this.loading === loading) this.loading = null;
			});
		this.loading = loading;
	}

	/** Use these people from now on, e.g. a new board's. */
	reset(load: () => Promise<Mentionable[]>): void {
		this.generation++;
		this.loading = null;
		this.load = load;
		this.people = [];
		this.loadedAt = 0;
		for (const listener of this.listeners) listener();
		// Something is showing suggestions already: fetch the new people now.
		if (this.listeners.size > 0) this.refresh();
	}

	get = (): Mentionable[] => this.people;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
}

export const peopleSource = new PeopleSource();

/** People to suggest for mentions, not including you. */
export function useMentionable(): Mentionable[] {
	useEffect(() => peopleSource.refresh(), []);
	const people = useSyncExternalStore(peopleSource.subscribe, peopleSource.get);
	const self = peopleSource.self?.toLowerCase();
	return self ? people.filter((person) => person.login.toLowerCase() !== self) : people;
}

/** The live board's people, from its route. */
export function boardPeople(boardId: string): () => Promise<Mentionable[]> {
	return async () => {
		const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}/people`, {
			headers: { accept: "application/json" },
		});
		if (!response.ok) return [];
		const body = (await response.json()) as { people?: Mentionable[] };
		return body.people ?? [];
	};
}
