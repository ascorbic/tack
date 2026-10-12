// Reading a page for its link card, and fetching the images link cards show,
// both through `guardedFetch` (guard.ts). No Worker APIs here beyond `fetch`,
// so the tests run it in Node with fakes.

import type { LinkPreview } from "../../shared/linkPreview.ts";
import { cleanField, LINK_LIMITS } from "../../shared/linkPreview.ts";
import { type GuardOptions, type Resolver, guardedFetch, readCapped } from "./guard.ts";
import { decodePage, parsePage } from "./parse.ts";

/** How much of a page is read: its head is nearly always in the first few kilobytes. */
export const MAX_PAGE_BYTES = 512 * 1024;
/** The largest image the instance will pass on. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** SVG is text, and needn't be big. */
export const MAX_SVG_BYTES = 256 * 1024;

export interface FetchDeps {
	fetch?: typeof fetch;
	resolve?: Resolver;
	now?: () => number;
}

const HTML = /^(?:text\/html|application\/xhtml\+xml)\b/i;

/** The last part of an address's path, decoded, for a title when there's nothing better: `deck.pdf`. */
function fileName(url: string): string | undefined {
	try {
		const last = new URL(url).pathname.split("/").filter(Boolean).at(-1);
		return last ? cleanField(decodeURIComponent(last), LINK_LIMITS.title) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * What the page at `url` says about itself. Never throws: a page that
 * can't be read is `failed`, an address Tack won't fetch is `blocked`.
 */
export async function unfurl(url: string, deps: FetchDeps = {}): Promise<LinkPreview> {
	const fetchedAt = new Date(deps.now?.() ?? Date.now()).toISOString();
	const options: GuardOptions = {
		fetch: deps.fetch,
		resolve: deps.resolve,
		accept: "text/html,application/xhtml+xml;q=0.9,image/*;q=0.5,*/*;q=0.1",
	};
	const result = await guardedFetch(url, options);
	if (result.kind === "blocked") return { status: "blocked", fetchedAt };
	if (result.kind === "failed") return { status: "failed", fetchedAt };
	const { response } = result;
	const icon = new URL("/favicon.ico", result.url).href;
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		return { status: "failed", fetchedAt };
	}
	const type = response.headers.get("content-type") ?? "";
	if (HTML.test(type) || type === "") {
		const { bytes } = await readCapped(response, MAX_PAGE_BYTES);
		const meta = parsePage(decodePage(type || null, bytes), result.url);
		return { status: "ok", ...meta, fetchedAt };
	}
	await response.body?.cancel().catch(() => {});
	const title = fileName(result.url);
	// A link straight to an image is its own preview.
	if (/^image\//i.test(type)) {
		return { status: "ok", ...(title ? { title } : {}), image: result.url, icon, fetchedAt };
	}
	return { status: "ok", ...(title ? { title } : {}), icon, fetchedAt };
}

/** Image types the proxy passes on, by what their first bytes say they are. */
export type ImageType =
	| "image/png"
	| "image/jpeg"
	| "image/gif"
	| "image/webp"
	| "image/avif"
	| "image/x-icon"
	| "image/svg+xml";

/**
 * What an image really is, from its first bytes (never what the server
 * said: anything that isn't one of these isn't passed on, so nothing but an
 * image can come from the instance's origin this way).
 */
export function sniffImage(bytes: Uint8Array): ImageType | null {
	const at = (offset: number, ...values: number[]) =>
		values.every((value, i) => bytes[offset + i] === value);
	const ascii = (offset: number, text: string) =>
		at(offset, ...Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)));
	if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
	if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
	if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
	if (ascii(4, "ftyp") && (ascii(8, "avif") || ascii(8, "avis"))) return "image/avif";
	if (at(0, 0, 0, 1, 0) || at(0, 0, 0, 2, 0)) return "image/x-icon";
	const start = new TextDecoder().decode(bytes.subarray(0, 1024)).replace(/^﻿/, "").trimStart();
	if (
		/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(start)
	) {
		return "image/svg+xml";
	}
	return null;
}

export type ImageResult =
	| { kind: "ok"; bytes: Uint8Array; type: ImageType }
	| { kind: "blocked" | "failed" | "too_large" | "not_image" };

/** Fetch an image for a link card, checked as `unfurl` checks pages, and no bigger than `MAX_IMAGE_BYTES`. */
export async function fetchImage(src: string, deps: FetchDeps = {}): Promise<ImageResult> {
	const result = await guardedFetch(src, {
		fetch: deps.fetch,
		resolve: deps.resolve,
		accept: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8",
		totalMs: 10_000,
	});
	if (result.kind !== "ok") return { kind: result.kind };
	const { response } = result;
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		return { kind: "failed" };
	}
	const declared = (response.headers.get("content-type") ?? "").toLowerCase();
	if (
		declared &&
		!declared.startsWith("image/") &&
		!declared.startsWith("application/octet-stream")
	) {
		await response.body?.cancel().catch(() => {});
		return { kind: "not_image" };
	}
	const { bytes, truncated } = await readCapped(response, MAX_IMAGE_BYTES + 1);
	if (truncated || bytes.byteLength > MAX_IMAGE_BYTES) return { kind: "too_large" };
	const type = sniffImage(bytes);
	if (!type) return { kind: "not_image" };
	if (type === "image/svg+xml" && bytes.byteLength > MAX_SVG_BYTES) return { kind: "too_large" };
	return { kind: "ok", bytes, type };
}
