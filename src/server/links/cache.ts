// Caching what link cards fetch: previews for a day (an hour when a page
// couldn't be read), images for a week. Two tiers: a small map in the
// isolate's memory, then the Cache API (`tack-links`), which is per data
// centre. Keys are addresses, so a page on many boards is read once.

import {
	LINK_RETRY_MS,
	LINK_STALE_MS,
	type LinkPreview,
	readPreview,
} from "../../shared/linkPreview.ts";

/** Somewhere to keep responses by key: the Cache API, or a map in tests. */
export interface ResponseStore {
	match(key: string): Promise<Response | undefined>;
	put(key: string, response: Response): Promise<void>;
}

/** The Cache API's `tack-links` cache, or null where there isn't one. */
export async function cacheApiStore(): Promise<ResponseStore | null> {
	if (typeof caches === "undefined") return null;
	try {
		const cache = await caches.open("tack-links");
		return {
			match: (key) => cache.match(key),
			put: (key, response) => cache.put(key, response),
		};
	} catch {
		return null;
	}
}

/** Keys are made-up addresses, as the Cache API wants requests. */
const KEY_ORIGIN = "https://links.tack.invalid";

export function previewKey(url: string): string {
	return `${KEY_ORIGIN}/preview?u=${encodeURIComponent(url)}`;
}

export function imageKey(src: string): string {
	return `${KEY_ORIGIN}/image?u=${encodeURIComponent(src)}`;
}

/** How long a preview is kept: a day, or an hour if the page couldn't be read. */
export function previewTtl(preview: LinkPreview): number {
	return preview.status === "failed" ? LINK_RETRY_MS : LINK_STALE_MS;
}

const MEMORY_LIMIT = 500;

/**
 * Previews by address, kept in memory and in a `ResponseStore` until they
 * expire. `now` is injectable for tests.
 */
export class PreviewCache {
	private memory = new Map<string, { preview: LinkPreview; until: number }>();

	constructor(
		private store: ResponseStore | null,
		private now: () => number = Date.now,
	) {}

	async get(url: string): Promise<LinkPreview | null> {
		const kept = this.memory.get(url);
		if (kept) {
			if (kept.until > this.now()) return kept.preview;
			this.memory.delete(url);
		}
		const response = await this.store?.match(previewKey(url)).catch(() => undefined);
		if (!response) return null;
		const body = (await response.json().catch(() => null)) as {
			preview?: unknown;
			until?: number;
		} | null;
		const preview = readPreview(body?.preview);
		if (!preview || typeof body?.until !== "number" || body.until <= this.now()) return null;
		this.remember(url, preview, body.until);
		return preview;
	}

	async put(url: string, preview: LinkPreview): Promise<void> {
		const ttl = previewTtl(preview);
		const until = this.now() + ttl;
		this.remember(url, preview, until);
		await this.store
			?.put(
				previewKey(url),
				Response.json(
					{ preview, until },
					{ headers: { "cache-control": `public, max-age=${Math.round(ttl / 1000)}` } },
				),
			)
			.catch(() => {});
	}

	private remember(url: string, preview: LinkPreview, until: number): void {
		this.memory.delete(url);
		this.memory.set(url, { preview, until });
		while (this.memory.size > MEMORY_LIMIT) {
			const oldest = this.memory.keys().next().value;
			if (oldest === undefined) break;
			this.memory.delete(oldest);
		}
	}
}
