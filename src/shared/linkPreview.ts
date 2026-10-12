import type { ShapeProps } from "./shapes.ts";

// What a link card says (links.ts): its preview, read and checked, and the
// words and colours made from it. No imports beyond types, so anything may
// use it (a11y, stacks, AI, embeds) without pulling in the document code.

/** A link card's shape keys, beside the usual x, y, z, parent, order and stack. */
export interface LinkShapeProps {
	type: "link";
	/** The page's address, http(s), as pasted (normalised by `linkUrl`). */
	url: string;
	/** What the page says about itself, once it's been read (`LinkPreview`). */
	preview?: LinkPreview;
}

/** How reading a page went. */
export type LinkStatus =
	/** Read: whatever it said about itself (which may be nothing). */
	| "ok"
	/** It couldn't be read: it didn't answer, failed, or isn't a page. */
	| "failed"
	/** Tack won't read it: a private address, an odd port, credentials in it. */
	| "blocked";

/** What a page says about itself (Open Graph, Twitter cards, its `<head>`), as stored on the shape. */
export interface LinkPreview {
	status: LinkStatus;
	/** `og:title`, `twitter:title`, then `<title>`. */
	title?: string;
	/** `og:description`, `twitter:description`, then `meta description`. */
	description?: string;
	/** `og:site_name`, or the application's name. */
	siteName?: string;
	/** The preview image's own address, absolute http(s): loaded through the instance. */
	image?: string;
	/** The site's icon, absolute http(s): loaded through the instance. */
	icon?: string;
	/** When it was read, ISO 8601. */
	fetchedAt: string;
}

/** The transaction origin a preview is written with: not undoable, as it's no one's edit. */
export const UNFURL_ORIGIN = "unfurl";

/** How long fields may be, in characters, and how long an address. */
export const LINK_LIMITS = {
	url: 2048,
	title: 300,
	description: 600,
	siteName: 100,
} as const;

/** A preview older than this is read again, quietly, by the next editor to look. */
export const LINK_STALE_MS = 24 * 3_600_000;
/** A page that couldn't be read is tried again after this. */
export const LINK_RETRY_MS = 3_600_000;

/** At most this many link cards from one paste. */
export const MAX_PASTED_LINKS = 20;

/** The room to leave for a link card that hasn't been measured: one with a preview image. */
export const LINK_CARD = { w: 252, h: 296 } as const;

/**
 * A bare web address, normalised, or null if `text` is anything else: words
 * around it, more than one, another scheme, or something that won't parse.
 * `www.example.com/page` is read as https. Hosts must look like hosts (a dot,
 * or `localhost`, which is refused later rather than turned into a sticky).
 */
export function linkUrl(text: string): string | null {
	let candidate = text.trim();
	if (!candidate || /\s/.test(candidate) || candidate.length > LINK_LIMITS.url) return null;
	// Pasted from Markdown or an email: `<https://…>`.
	if (candidate.startsWith("<") && candidate.endsWith(">")) candidate = candidate.slice(1, -1);
	if (/^www\./i.test(candidate)) candidate = `https://${candidate}`;
	if (!/^https?:\/\//i.test(candidate)) return null;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	const host = url.hostname;
	if (!host || (!host.includes(".") && !host.startsWith("[") && host !== "localhost")) return null;
	return url.href.length <= LINK_LIMITS.url ? url.href : null;
}

/** The host to show for an address, without `www.`: `unpic.pics`. */
export function linkHost(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

/** An address to show when there's no title: the host and path, without the scheme or a lone `/`. */
export function linkLabel(url: string): string {
	try {
		const parsed = new URL(url);
		const path = `${parsed.pathname}${parsed.search}`.replace(/\/$/, "");
		return `${parsed.hostname.replace(/^www\./, "")}${path}`;
	} catch {
		return url;
	}
}

/** An absolute http(s) address, or undefined. */
function httpUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > LINK_LIMITS.url) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

/** One line of plain text, trimmed and cut to `max` characters, or undefined if empty. */
export function cleanField(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return undefined;
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const STATUSES = new Set<LinkStatus>(["ok", "failed", "blocked"]);

/**
 * A preview from the document (which any editor's client may have written)
 * or an answer, read field by field: anything that isn't what this code
 * writes is left out, and the whole is null without a status and a time.
 */
export function readPreview(value: unknown): LinkPreview | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (typeof raw.status !== "string" || !STATUSES.has(raw.status as LinkStatus)) return null;
	if (typeof raw.fetchedAt !== "string" || Number.isNaN(Date.parse(raw.fetchedAt))) return null;
	const preview: LinkPreview = { status: raw.status as LinkStatus, fetchedAt: raw.fetchedAt };
	const title = cleanField(raw.title, LINK_LIMITS.title);
	const description = cleanField(raw.description, LINK_LIMITS.description);
	const siteName = cleanField(raw.siteName, LINK_LIMITS.siteName);
	const image = httpUrl(raw.image);
	const icon = httpUrl(raw.icon);
	if (title) preview.title = title;
	if (description) preview.description = description;
	if (siteName) preview.siteName = siteName;
	if (image) preview.image = image;
	if (icon) preview.icon = icon;
	return preview;
}

/** Whether a link card's preview should be read (again): never read, a day old, or failed an hour ago. */
export function needsUnfurl(preview: LinkPreview | null, now = Date.now()): boolean {
	if (!preview) return true;
	const age = now - Date.parse(preview.fetchedAt);
	if (!(age >= 0)) return false;
	return age > (preview.status === "failed" ? LINK_RETRY_MS : LINK_STALE_MS);
}

/** The images a link card loads through the instance: its preview image and icon. */
export function linkAssets(shape: Pick<ShapeProps, "type" | "preview">): string[] {
	if (shape.type !== "link") return [];
	const preview = readPreview(shape.preview);
	return [preview?.image, preview?.icon].filter((src): src is string => !!src);
}

/**
 * A link card in words, for what reads the board as text (AI, stack names,
 * screen readers): its title, then its description, then where it is.
 */
export function linkText(shape: Pick<ShapeProps, "url" | "preview">): {
	title: string;
	description?: string;
	host: string;
} {
	const url = typeof shape.url === "string" ? shape.url : "";
	const preview = readPreview(shape.preview);
	return {
		title: preview?.title ?? linkLabel(url),
		...(preview?.description ? { description: preview.description } : {}),
		host: preview?.siteName ?? linkHost(url),
	};
}

/** A hue for a site, the same everywhere: the tint behind a card without an image. */
export function linkHue(url: string): number {
	const host = linkHost(url);
	let hash = 2166136261;
	for (let i = 0; i < host.length; i++) {
		hash ^= host.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0) % 360;
}
