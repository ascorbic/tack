// Public boards seen from outside Tack (#56, #57).
//
//   GET /embed/:id.svg?…   an image of a public board, or part of it, for READMEs
//   GET /embed/:id.png?…   the same as PNG
//   GET /og/:id.png        a public board's link preview image, 1200 × 630
//   GET /b/:id/:slug       the app, with a public board's title, description
//                          and preview image in its meta tags, for link previews
//
// Only public boards have any of this. Every other board, and boards that
// don't exist, get the same answer (404 for images, the plain app for
// pages), so nothing about a board that isn't public gets out, not even
// that it exists. Images draw what someone signed out would see: see
// src/shared/embed.ts for what that leaves out, and why.
//
// Images are drawn on the Worker (Satori, then resvg for PNG) from the
// board's document, its cards and its images' thumbnails (inlined as data
// URLs, so an SVG loads nothing), never in a browser. They're cached by
// what they show: the ETag is a hash of the drawn scene and the options,
// so an unchanged board answers `If-None-Match` with a 304 and a changed
// one is drawn afresh, and drawn images are kept in the Cache API under
// that hash. Browsers and image proxies (GitHub's camo) may reuse an
// image for a minute, then must ask again.

import { getServerByName } from "partyserver";
import { BOARD_ID, boardPath } from "../../shared/boards.ts";
import type { Card, MissingCard } from "../../shared/cards.ts";
import {
	type EmbedFormat,
	type EmbedOptions,
	OG_SIZE,
	type Scene,
	type SceneThumbs,
	buildScene,
	countBoard,
	describeBoard,
	imageSize,
	ogPath,
	parseEmbedQuery,
	previewFrame,
} from "../../shared/embed.ts";
import type { ShapeProps } from "../../shared/shapes.ts";
import type { Board } from "../board.ts";
import type { PublicBoard } from "../directory.ts";
import { log } from "../log.ts";
import { boards, directory } from "../namespaces.ts";
import { SVG_CSP } from "../securityHeaders.ts";
import { drawPreview, drawScene } from "./draw.ts";

/** Bump when drawing changes, so cached images and ETags from before are dropped. */
const RENDERER_VERSION = "6";

/** How long browsers and proxies may reuse an image before asking again. */
const IMAGE_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=600";

const TYPES: Record<EmbedFormat, string> = {
	svg: "image/svg+xml; charset=utf-8",
	png: "image/png",
};

type Entry = Card | MissingCard;

/** Routes for board images and link previews, or null if the request isn't for one. */
export async function handleEmbeds(
	request: Request,
	env: Env,
	ctx?: ExecutionContext,
): Promise<Response | null> {
	const url = new URL(request.url);
	const method = request.method;
	const embed = /^\/embed\/([^/]+)\.(svg|png)$/.exec(url.pathname);
	const og = /^\/og\/([^/]+)\.png$/.exec(url.pathname);
	const page = /^\/b\/([^/]+)(?:\/[^/]*)?\/?$/.exec(url.pathname);
	if (!embed && !og && !page) return null;
	if (method !== "GET" && method !== "HEAD") {
		return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
	}
	if (page) return boardPage(request, env, decode(page[1]));
	if (embed) {
		const options = parseEmbedQuery(url.searchParams);
		if (!options) return notFound("invalid");
		return image(request, env, ctx, {
			id: decode(embed[1]),
			format: embed[2] as EmbedFormat,
			kind: "embed",
			options,
		});
	}
	const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
	return image(request, env, ctx, {
		id: decode(og?.[1]),
		format: "png",
		kind: "og",
		options: { region: { kind: "board" }, theme, width: OG_SIZE.width },
	});
}

interface ImageRequest {
	id: string | null;
	format: EmbedFormat;
	kind: "embed" | "og";
	options: EmbedOptions;
}

async function image(
	request: Request,
	env: Env,
	ctx: ExecutionContext | undefined,
	asked: ImageRequest,
): Promise<Response> {
	const started = Date.now();
	const { id, format, kind, options } = asked;
	if (!id || !BOARD_ID.test(id)) return notFound("invalid");
	const board = await directory(env).publicBoard(id);
	if (!board) {
		// The same for private boards as for boards that don't exist.
		log.info("embed.refused", { board: id, kind, reason: "not_public" });
		return notFound("not_public");
	}

	let scene: Scene;
	let subtitle = "";
	try {
		const data = await boardData(env, id, { wait: true, images: true });
		scene = buildScene(data.shapes, data.cards, options.region, data.images);
		if (kind === "og") {
			scene = { ...scene, frame: previewFrame(scene.frame) };
			subtitle = describeBoard(countBoard(data.shapes, data.cards));
		}
	} catch (error) {
		log.error("embed.failed", { board: id, kind, stage: "data", error });
		return new Response("Couldn’t draw this board", {
			status: 503,
			headers: { "cache-control": "no-store", "retry-after": "30" },
		});
	}

	const size =
		kind === "og"
			? { width: OG_SIZE.width, height: OG_SIZE.height }
			: imageSize(scene.frame, options.width);
	const etag = `"${await hash({
		v: RENDERER_VERSION,
		kind,
		format,
		theme: options.theme,
		size,
		title: board.title,
		subtitle,
		scene: etagScene(scene),
	})}"`;
	const headers = new Headers({
		"content-type": TYPES[format],
		"cache-control": IMAGE_CACHE_CONTROL,
		etag,
		"access-control-allow-origin": "*",
		"x-content-type-options": "nosniff",
		// Satori's SVG has no scripts and links nowhere; its images are inline.
		"content-security-policy": SVG_CSP,
	});
	if (matches(request.headers.get("if-none-match"), etag)) {
		log.info("embed.served", { board: id, kind, format, status: 304, ms: Date.now() - started });
		return new Response(null, { status: 304, headers });
	}

	// Drawn before, by this isolate or another in this data centre.
	const cacheKey = new Request(
		`${new URL(request.url).origin}/__embed-cache/${encodeURIComponent(id)}/${etag.slice(1, -1)}.${format}`,
	);
	const cache = typeof caches === "undefined" ? null : await caches.open("tack-embeds");
	const hit = await cache?.match(cacheKey).catch(() => undefined);
	if (hit) {
		log.info("embed.served", {
			board: id,
			kind,
			format,
			status: 200,
			cached: true,
			ms: Date.now() - started,
		});
		return new Response(request.method === "HEAD" ? null : hit.body, { status: 200, headers });
	}

	let body: string | Uint8Array;
	try {
		// Loaded on first use: Satori and resvg are big, and most requests never draw.
		const { toPng, toSvg } = await import("./render.ts");
		const element =
			kind === "og"
				? drawPreview(scene, { theme: options.theme, ...size, title: board.title, subtitle })
				: drawScene(scene, { theme: options.theme, ...size, badge: board.title });
		const svg = await toSvg(element, size.width, size.height);
		body = format === "png" ? await toPng(svg) : svg;
	} catch (error) {
		log.error("embed.failed", { board: id, kind, format, stage: "draw", error });
		return new Response("Couldn’t draw this board", {
			status: 500,
			headers: { "cache-control": "no-store" },
		});
	}
	const bytes =
		typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
	log.info("embed.rendered", {
		board: id,
		kind,
		format,
		region: options.region.kind,
		shapes: scene.items.length,
		width: size.width,
		height: size.height,
		bytes,
		ms: Date.now() - started,
	});
	if (cache) {
		const stored = new Response(body, {
			headers: { "content-type": TYPES[format], "cache-control": "public, max-age=86400" },
		});
		const put = cache
			.put(cacheKey, stored)
			.catch((error: unknown) => log.warn("embed.cache.failed", { board: id, error }));
		if (ctx) ctx.waitUntil(put);
		else await put;
	}
	return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
}

/**
 * A scene as its ETag hashes it: images by their file's hash and whether
 * there's a thumbnail, not the thumbnail itself. A file's thumbnail never
 * changes once it's there, and hashing megabytes of data URLs on every
 * request (most of them answered 304) would cost more than the answer.
 */
function etagScene(scene: Scene): unknown {
	return {
		...scene,
		items: scene.items.map((item) =>
			item.kind === "image" ? { ...item, src: item.src !== null } : item,
		),
	};
}

/** A board's shapes, cards and image thumbnails, as someone signed out sees them. */
async function boardData(
	env: Env,
	id: string,
	options: { wait: boolean; images: boolean },
): Promise<{ shapes: Map<string, ShapeProps>; cards: Map<string, Entry>; images: SceneThumbs }> {
	const stub = await getServerByName<Env, Board>(boards(env), id);
	// The RPC types can't follow the document's open-ended shape properties.
	const data = await (stub.embedData(options) as unknown as ReturnType<Board["embedData"]>);
	return {
		shapes: new Map(data.shapes),
		cards: new Map(data.cards.map((card) => [card.key, card])),
		images: data.images ?? {},
	};
}

// --- Link previews --------------------------------------------------------------------

/**
 * The app's page, with a public board's title, description and preview
 * image in its meta tags, so a link pasted into Slack, Discord, GitHub or
 * a social site unfurls. Other boards get the page as it is.
 */
async function boardPage(request: Request, env: Env, id: string | null): Promise<Response> {
	const assets = (env as { ASSETS?: Fetcher }).ASSETS;
	if (!assets) return new Response("Not found", { status: 404 });
	const board =
		id && BOARD_ID.test(id)
			? await directory(env)
					.publicBoard(id)
					.catch(() => null)
			: null;
	if (!board) return assets.fetch(request);

	// Fetched unconditionally: the page is rewritten, so the assets' ETag no longer describes it.
	const plain = new Request(request.url, {
		method: "GET",
		headers: withoutConditionals(request.headers),
	});
	const response = await assets.fetch(plain);
	if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/html")) {
		return response;
	}
	let description = "A public board on Tack.";
	try {
		// Only what's on it, for the description: no thumbnails.
		const data = await boardData(env, board.id, { wait: false, images: false });
		description = describeBoard(countBoard(data.shapes, data.cards));
	} catch (error) {
		log.warn("embed.preview.failed", { board: board.id, error });
	}
	const origin = new URL(request.url).origin;
	const tags = previewTags(board, description, origin);
	const rewritten = new HTMLRewriter()
		.on("title", {
			element(element) {
				element.setInnerContent(`${board.title} · Tack`);
			},
		})
		.on("head", {
			element(element) {
				element.append(tags, { html: true });
			},
		})
		.transform(response);
	const headers = new Headers(rewritten.headers);
	headers.delete("etag");
	headers.delete("content-length");
	headers.set("cache-control", "no-cache");
	return new Response(request.method === "HEAD" ? null : rewritten.body, {
		status: rewritten.status,
		headers,
	});
}

/** The meta tags for a public board's link preview. */
export function previewTags(board: PublicBoard, description: string, origin: string): string {
	const url = `${origin}${boardPath(board)}`;
	const image = `${origin}${ogPath(board.id, board.updatedAt.toString(36))}`;
	const meta = (attr: "name" | "property", key: string, value: string) =>
		`<meta ${attr}="${key}" content="${escapeHtml(value)}" />`;
	return [
		meta("name", "description", description),
		meta("property", "og:type", "website"),
		meta("property", "og:site_name", "Tack"),
		meta("property", "og:title", board.title),
		meta("property", "og:description", description),
		meta("property", "og:url", url),
		meta("property", "og:image", image),
		meta("property", "og:image:width", String(OG_SIZE.width)),
		meta("property", "og:image:height", String(OG_SIZE.height)),
		meta("property", "og:image:alt", `${board.title}, a board on Tack`),
		meta("name", "twitter:card", "summary_large_image"),
		meta("name", "twitter:title", board.title),
		meta("name", "twitter:description", description),
		meta("name", "twitter:image", image),
		`<link rel="canonical" href="${escapeHtml(url)}" />`,
	].join("\n");
}

function withoutConditionals(headers: Headers): Headers {
	const out = new Headers(headers);
	out.delete("if-none-match");
	out.delete("if-modified-since");
	return out;
}

// --- Helpers --------------------------------------------------------------------------

function notFound(reason: string): Response {
	return new Response("Not found", {
		status: 404,
		headers: { "cache-control": "no-store", "x-tack-reason": reason },
	});
}

function matches(header: string | null, etag: string): boolean {
	if (!header) return false;
	return header
		.split(",")
		.map((value) => value.trim().replace(/^W\//, ""))
		.some((value) => value === etag || value === "*");
}

async function hash(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	let out = "";
	for (const byte of digest.slice(0, 16)) out += byte.toString(16).padStart(2, "0");
	return out;
}

function decode(value: string | undefined): string | null {
	if (value === undefined) return null;
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
