// Link cards' routes:
//
//   POST /api/boards/:id/unfurl              { url } → { preview: LinkPreview }
//   GET  /api/boards/:id/links/image?src=…   an image a link card on the board shows
//
// Unfurling is for signed-in editors of the board (they're the ones who can
// write the preview into it), rate limited per person and per board, and
// cached by address. Images are for anyone who can open the board, strangers
// on a public board included (they see the cards too), but only images a
// link card on that board shows, so the instance never fetches anything a
// board doesn't already name. Both fetch through `guardedFetch` (guard.ts):
// no private addresses, odd ports, credentials or unchecked redirects. See
// "Link cards" in docs/security-review.md.

import { getServerByName } from "partyserver";
import { BOARD_ID, canEdit } from "../../shared/boards.ts";
import { linkHost, linkUrl } from "../../shared/linkPreview.ts";
import { json } from "../auth/http.ts";
import type { Board } from "../board.ts";
import { visitorFor } from "../boards/http.ts";
import { log } from "../log.ts";
import { boards, directory } from "../namespaces.ts";
import { Budget, UNFURL_LIMITS } from "./budget.ts";
import { PreviewCache, type ResponseStore, cacheApiStore, imageKey } from "./cache.ts";
import { type FetchDeps, fetchImage, unfurl } from "./unfurl.ts";

/** Images are kept a week; one that couldn't be fetched isn't tried again for an hour. */
const IMAGE_TTL_S = 7 * 86_400;
const IMAGE_FAILED_TTL_S = 3_600;

const people = new Budget(UNFURL_LIMITS.person);
const boardBudget = new Budget(UNFURL_LIMITS.board);
const imageBudget = new Budget(UNFURL_LIMITS.images);
let previews: PreviewCache | null = null;

async function previewCache(): Promise<PreviewCache> {
	previews ??= new PreviewCache(await cacheApiStore());
	return previews;
}

/** Routes for link cards, or null if the request isn't for one. */
export async function handleLinks(
	request: Request,
	env: Env,
	ctx?: ExecutionContext,
	deps: FetchDeps = {},
): Promise<Response | null> {
	const url = new URL(request.url);
	const unfurlMatch = /^\/api\/boards\/([^/]+)\/unfurl$/.exec(url.pathname);
	if (unfurlMatch) return handleUnfurl(request, env, decode(unfurlMatch[1]), deps);
	const image = /^\/api\/boards\/([^/]+)\/links\/image$/.exec(url.pathname);
	if (image) return handleImage(request, env, ctx, decode(image[1]), deps);
	return null;
}

function decode(raw: string | undefined): string {
	try {
		return decodeURIComponent(raw ?? "");
	} catch {
		return "";
	}
}

async function handleUnfurl(
	request: Request,
	env: Env,
	board: string,
	deps: FetchDeps,
): Promise<Response> {
	if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });
	if (!BOARD_ID.test(board)) return json({ error: "not_found" }, { status: 404 });
	const visitor = await visitorFor(request, env);
	if (!visitor.user) {
		log.info("link.refused", { board, reason: "signed_out" });
		return json({ error: "sign_in_required" }, { status: 401 });
	}
	const info = await directory(env).get(visitor, board);
	if (!info.ok) {
		const status = { not_found: 404, sign_in_required: 401 }[info.error as string] ?? 403;
		return json({ error: info.error }, { status });
	}
	if (!canEdit(info.value.role) || info.value.archivedAt) {
		log.info("link.refused", { board, reason: "not_editor", login: visitor.user.login });
		return json({ error: "forbidden" }, { status: 403 });
	}
	const body = (await request.json().catch(() => null)) as { url?: unknown } | null;
	const target = typeof body?.url === "string" ? linkUrl(body.url) : null;
	if (!target) return json({ error: "invalid" }, { status: 400 });

	const cache = await previewCache();
	const cached = await cache.get(target);
	if (cached) {
		log.info("link.unfurled", {
			board,
			host: linkHost(target),
			status: cached.status,
			cached: true,
		});
		return json({ preview: cached });
	}
	const retryAt = people.take(`user:${visitor.user.id}`) ?? boardBudget.take(`board:${board}`);
	if (retryAt !== null) {
		log.info("link.refused", { board, reason: "rate_limited", login: visitor.user.login });
		return json(
			{ error: "rate_limited", retryAt },
			{ status: 429, headers: { "retry-after": String(Math.ceil((retryAt - Date.now()) / 1000)) } },
		);
	}
	const started = Date.now();
	const preview = await unfurl(target, deps);
	await cache.put(target, preview);
	log.info("link.unfurled", {
		board,
		host: linkHost(target),
		status: preview.status,
		cached: false,
		image: !!preview.image,
		ms: Date.now() - started,
	});
	return json({ preview });
}

function imageHeaders(type: string, length: number, maxAge: number): HeadersInit {
	return {
		"content-type": type,
		"content-length": String(length),
		// Only people who can open the board get here, so no shared caches.
		"cache-control": `private, max-age=${maxAge}`,
		"x-content-type-options": "nosniff",
		// An SVG opened on its own can't run anything, or reach anything.
		"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
		"content-disposition": "inline",
	};
}

function unavailable(maxAge = IMAGE_FAILED_TTL_S): Response {
	return new Response("Not found", {
		status: 404,
		headers: { "cache-control": `private, max-age=${maxAge}`, "content-type": "text/plain" },
	});
}

async function handleImage(
	request: Request,
	env: Env,
	ctx: ExecutionContext | undefined,
	board: string,
	deps: FetchDeps,
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return json({ error: "method_not_allowed" }, { status: 405 });
	}
	if (!BOARD_ID.test(board)) return json({ error: "not_found" }, { status: 404 });
	const src = new URL(request.url).searchParams.get("src") ?? "";
	const visitor = await visitorFor(request, env);
	const info = await directory(env).get(visitor, board);
	if (!info.ok) return json({ error: "not_found" }, { status: 404 });
	if (!/^https?:\/\//i.test(src) || src.length > 2048) {
		return json({ error: "invalid" }, { status: 400 });
	}
	let shown = false;
	try {
		const stub = await getServerByName<Env, Board>(boards(env), board);
		shown = src.length > 0 && (await stub.showsLinkAsset(src));
	} catch (error) {
		log.warn("link.image.failed", { board, reason: "board", error });
		return unavailable(60);
	}
	// Only what a link card here shows: this is never an open proxy.
	if (!shown) {
		log.info("link.image.refused", { board, reason: "not_on_board" });
		return json({ error: "not_found" }, { status: 404 });
	}

	const store: ResponseStore | null = await cacheApiStore();
	const key = imageKey(src);
	const cached = await store?.match(key).catch(() => undefined);
	if (cached) {
		if (cached.headers.get("x-tack-image") === "failed") return unavailable();
		const bytes = new Uint8Array(await cached.arrayBuffer());
		const type = cached.headers.get("content-type") ?? "application/octet-stream";
		return new Response(request.method === "HEAD" ? null : bytes, {
			headers: imageHeaders(type, bytes.byteLength, 86_400),
		});
	}
	const retryAt = imageBudget.take(`board:${board}`);
	if (retryAt !== null) {
		log.info("link.image.refused", { board, reason: "rate_limited" });
		return new Response("Too many images", {
			status: 429,
			headers: { "retry-after": String(Math.ceil((retryAt - Date.now()) / 1000)) },
		});
	}
	const result = await fetchImage(src, deps);
	const put = (response: Response) => {
		const saving = store?.put(key, response).catch(() => {});
		if (saving) ctx?.waitUntil(saving);
	};
	if (result.kind !== "ok") {
		log.info("link.image.failed", { board, host: linkHost(src), reason: result.kind });
		put(
			new Response(null, {
				headers: {
					"x-tack-image": "failed",
					"cache-control": `public, max-age=${IMAGE_FAILED_TTL_S}`,
				},
			}),
		);
		return unavailable();
	}
	log.info("link.image.fetched", {
		board,
		host: linkHost(src),
		type: result.type,
		bytes: result.bytes.byteLength,
	});
	put(
		new Response(result.bytes.slice(), {
			headers: {
				"content-type": result.type,
				"cache-control": `public, max-age=${IMAGE_TTL_S}`,
			},
		}),
	);
	return new Response(request.method === "HEAD" ? null : result.bytes, {
		headers: imageHeaders(result.type, result.bytes.byteLength, 86_400),
	});
}
