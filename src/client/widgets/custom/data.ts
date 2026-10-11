import { type Card, isMissing } from "../../../shared/cards.ts";
import { CUSTOM_LIMITS, searchName } from "../../../shared/customWidgets.ts";
import type { QueryError, SearchQuery, SearchResult } from "../../../shared/widgets.ts";
import { cardStore } from "../../cardStore.ts";
import { widgetStore } from "../store.ts";

// What a custom widget's code reads (#66), as the person looking may read
// it. Searches go to the board's server as the widget's searches
// (`widget-query`), which runs them through the widget runner with this
// person's access, keeps them live and sends their results with the
// widget's data. Cards are the ones the board already sent this person.
// Avatars are fetched here, by the app, from GitHub's avatar host only, and
// handed over as data URLs: the sandbox itself loads nothing.

export interface CustomDataSource {
	search(query: SearchQuery): Promise<SearchResult | QueryError>;
	/** Cards by key, as this person sees them: null for any they can't, or the board doesn't have. */
	cards(keys: string[]): (Card | null)[];
	/** An avatar from GitHub's avatar host, as a data URL. */
	avatar(url: string): Promise<string>;
	/** Called whenever something the widget searched for has new results. */
	subscribe(listener: () => void): () => void;
}

/**
 * A custom widget's searches on this page, shared by its frames (the widget
 * and its editor's preview): the union of what they've asked for, most
 * recently asked first, at most `CUSTOM_LIMITS.queries`.
 */
class CustomSearches {
	private asked = new Map<string, { query: SearchQuery; at: number }>();
	private waiting: { name: string; resolve: (result: SearchResult | QueryError) => void }[] = [];
	private listeners = new Set<() => void>();
	private seen = new Map<string, string>();
	private unsubscribe: () => void;
	users = 0;

	constructor(private id: string) {
		this.unsubscribe = widgetStore.subscribe(id, () => this.arrived());
	}

	search(query: SearchQuery): Promise<SearchResult | QueryError> {
		const name = searchName(query);
		const known = this.asked.has(name);
		this.asked.set(name, { query, at: Date.now() });
		const current = widgetStore.get(this.id)?.results[name];
		if (known && current && (current.kind === "search" || current.kind === "error")) {
			return Promise.resolve(current);
		}
		if (!known) this.send();
		return new Promise((resolve) => this.waiting.push({ name, resolve }));
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	destroy(): void {
		this.unsubscribe();
		widgetStore.query(this.id, {});
		for (const { resolve } of this.waiting.splice(0)) resolve(stopped());
	}

	private send(): void {
		const kept = [...this.asked.entries()]
			.sort((a, b) => b[1].at - a[1].at)
			.slice(0, CUSTOM_LIMITS.queries);
		this.asked = new Map(kept);
		widgetStore.query(
			this.id,
			Object.fromEntries(
				kept.map(([name, { query }]) => [
					name,
					{
						q: query.q,
						host: query.host,
						sort: query.sort,
						order: query.order,
						limit: query.limit,
					},
				]),
			),
		);
	}

	private arrived(): void {
		const results = widgetStore.get(this.id)?.results ?? {};
		this.waiting = this.waiting.filter(({ name, resolve }) => {
			const result = results[name];
			if (!result || (result.kind !== "search" && result.kind !== "error")) return true;
			resolve(result);
			return false;
		});
		// Something it read before has changed: it reads again.
		let changed = false;
		for (const name of this.asked.keys()) {
			const result = results[name];
			if (!result) continue;
			const json = JSON.stringify(result);
			const before = this.seen.get(name);
			this.seen.set(name, json);
			if (before !== undefined && before !== json) changed = true;
		}
		if (changed) for (const listener of this.listeners) listener();
	}
}

const searches = new Map<string, CustomSearches>();

/** The board's data, for a custom widget on it. Call the returned `release` when done. */
export function liveSource(id: string): CustomDataSource & { release(): void } {
	let shared = searches.get(id);
	if (!shared) searches.set(id, (shared = new CustomSearches(id)));
	shared.users++;
	const mine = shared;
	return {
		search: (query) =>
			widgetStore.canQuery()
				? mine.search(query)
				: Promise.resolve({
						kind: "error",
						reason: "unsupported",
						message: "Searches aren’t available here.",
					}),
		cards: boardCards,
		avatar: avatarData,
		subscribe: (listener) => mine.subscribe(listener),
		release: () => {
			mine.users--;
			if (mine.users > 0) return;
			mine.destroy();
			searches.delete(id);
		},
	};
}

/** Cards by key from the ones this person has been sent. */
export function boardCards(keys: string[]): (Card | null)[] {
	return keys.map((key) => {
		const entry = cardStore.get(key);
		return entry && !isMissing(entry) ? entry : null;
	});
}

const avatars = new Map<string, Promise<string>>();

/** An avatar as a data URL, fetched once per page. */
export function avatarData(url: string): Promise<string> {
	let found = avatars.get(url);
	if (!found) {
		found = fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" })
			.then((response) => {
				if (!response.ok) throw new Error(`The avatar couldn’t be loaded (${response.status}).`);
				const type = response.headers.get("content-type") ?? "";
				if (!/^image\/(png|jpeg|gif|webp)\b/.test(type)) throw new Error("That isn’t an image.");
				return response.blob();
			})
			.then(
				(blob) =>
					new Promise<string>((resolve, reject) => {
						const reader = new FileReader();
						reader.onload = () =>
							typeof reader.result === "string"
								? resolve(reader.result)
								: reject(new Error("The avatar couldn’t be read."));
						reader.onerror = () => reject(new Error("The avatar couldn’t be read."));
						reader.readAsDataURL(blob);
					}),
			);
		found.catch(() => avatars.delete(url));
		avatars.set(url, found);
	}
	return found;
}

function stopped(): QueryError {
	return { kind: "error", reason: "error", message: "The widget stopped before this answered." };
}
