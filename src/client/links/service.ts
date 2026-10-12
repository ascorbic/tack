import { type LinkPreview, readPreview } from "../../shared/linkPreview.ts";

// Where link cards' previews and images come from: the Worker on a live
// board (src/server/links/routes.ts), or a stand-in in the playground and
// the public demo (play/links.ts), which never leave the browser.

export type UnfurlResult =
	| { kind: "preview"; preview: LinkPreview }
	/** Too many just now: try again from `retryAt`. */
	| { kind: "later"; retryAt: number }
	/** Not for this person (signed out, a viewer) or not possible: leave it as it is. */
	| { kind: "refused" };

export interface LinkService {
	/** Read what the page at `url` says about itself. Never throws. */
	unfurl: (url: string) => Promise<UnfurlResult>;
	/**
	 * Where to load an image a link card shows (its preview image or icon,
	 * a page's own address) from: never the page's host itself.
	 */
	imageSrc: (src: string) => string | null;
}

/** A live board's link service: the Worker reads pages and passes images on. */
export function liveLinks(boardId: string): LinkService {
	const base = `/api/boards/${encodeURIComponent(boardId)}`;
	return {
		async unfurl(url) {
			let response: Response;
			try {
				response = await fetch(`${base}/unfurl`, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ url }),
				});
			} catch {
				return { kind: "later", retryAt: Date.now() + 30_000 };
			}
			const body = (await response.json().catch(() => null)) as {
				preview?: unknown;
				retryAt?: unknown;
			} | null;
			if (response.status === 429) {
				const retryAt = typeof body?.retryAt === "number" ? body.retryAt : Date.now() + 60_000;
				return { kind: "later", retryAt };
			}
			if (response.status >= 500) return { kind: "later", retryAt: Date.now() + 60_000 };
			const preview = response.ok ? readPreview(body?.preview) : null;
			return preview ? { kind: "preview", preview } : { kind: "refused" };
		},
		imageSrc: (src) => `${base}/links/image?src=${encodeURIComponent(src)}`,
	};
}
