import { useEffect, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import {
	type LinkPreview,
	UNFURL_ORIGIN,
	linkUrl,
	needsUnfurl,
	readPreview,
} from "../../shared/linkPreview.ts";
import { shapesMap } from "../../shared/shapes.ts";
import type { LinkService } from "./service.ts";

// Reading link cards' pages. Every editor's client watches the board for
// link cards that need it (never read, or read more than a day ago) and asks
// its link service, a few at a time, then writes what came back onto the
// shape with `UNFURL_ORIGIN`: no one's edit, so not an undo step, and the
// same for everyone at once. A card being read for the first time shows a
// skeleton here (`useUnfurling`); refreshes are quiet. A card nobody can read
// (a viewer's board, a signed-out visitor) shows as a plain link instead.

const MAX_AT_ONCE = 3;

/** Link cards this client is reading for the first time, by shape id. */
const reading = new Set<string>();
const listeners = new Set<() => void>();

function changed(): void {
	for (const listener of listeners) listener();
}

/** Whether this client is reading a link card's page for the first time (its skeleton shows). */
export function useUnfurling(id: string): boolean {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => reading.has(id),
		() => false,
	);
}

/** Write a preview onto a link card, if it's still there and still for that address. */
export function writePreview(doc: Y.Doc, id: string, url: string, preview: LinkPreview): void {
	doc.transact(() => {
		const shape = shapesMap(doc).get(id);
		if (shape?.get("type") === "link" && shape.get("url") === url) shape.set("preview", preview);
	}, UNFURL_ORIGIN);
}

/**
 * Read the pages of link cards that need it, while `enabled` (an editor's
 * board with a link service). Each card is tried once per page load for each
 * preview it has, so a failure isn't asked about again and again; one that
 * was refused for now (rate limits) is tried again when it may be.
 */
export function useLinkUnfurling(doc: Y.Doc, service: LinkService | undefined, enabled: boolean) {
	useEffect(() => {
		if (!service || !enabled) return;
		const shapes = shapesMap(doc);
		const tried = new Set<string>();
		const queue: { id: string; url: string; first: boolean }[] = [];
		let running = 0;
		let disposed = false;
		let wakeAt = 0;
		let wake: ReturnType<typeof setTimeout> | null = null;
		let pending: ReturnType<typeof setTimeout> | null = null;

		const pump = () => {
			while (!disposed && running < MAX_AT_ONCE && queue.length > 0 && Date.now() >= wakeAt) {
				const next = queue.shift();
				if (!next) break;
				running++;
				void service.unfurl(next.url).then((result) => {
					running--;
					if (next.first) {
						reading.delete(next.id);
						changed();
					}
					if (disposed) return;
					if (result.kind === "preview") writePreview(doc, next.id, next.url, result.preview);
					else if (result.kind === "later") {
						// Ask again once it may: forget it was tried, and wait.
						tried.delete(attemptKey(next.id, next.url, shapes.get(next.id)?.get("preview")));
						wakeAt = Math.max(wakeAt, result.retryAt);
						if (wake) clearTimeout(wake);
						wake = setTimeout(scan, Math.max(0, wakeAt - Date.now()) + 50);
					}
					pump();
				});
			}
		};

		const scan = () => {
			pending = null;
			if (disposed) return;
			const now = Date.now();
			for (const [id, shape] of shapes) {
				if (shape.get("type") !== "link") continue;
				const raw = shape.get("url");
				const url = typeof raw === "string" ? linkUrl(raw) : null;
				if (!url || url !== raw) continue;
				const stored = shape.get("preview");
				const preview = readPreview(stored);
				if (!needsUnfurl(preview, now)) continue;
				const key = attemptKey(id, url, stored);
				if (tried.has(key)) continue;
				tried.add(key);
				const first = preview === null;
				if (first) reading.add(id);
				// Refreshes wait their turn behind cards with nothing to show yet.
				if (first) queue.unshift({ id, url, first });
				else queue.push({ id, url, first });
			}
			changed();
			pump();
		};

		const observer = () => {
			if (!pending) pending = setTimeout(scan, 40);
		};
		shapes.observeDeep(observer);
		scan();
		return () => {
			disposed = true;
			shapes.unobserveDeep(observer);
			if (pending) clearTimeout(pending);
			if (wake) clearTimeout(wake);
			for (const entry of queue) if (entry.first) reading.delete(entry.id);
			changed();
		};
	}, [doc, service, enabled]);
}

function attemptKey(id: string, url: string, preview: unknown): string {
	const at = readPreview(preview)?.fetchedAt ?? "";
	return `${id} ${url} ${at}`;
}
