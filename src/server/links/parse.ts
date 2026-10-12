// Reading what a page says about itself from its `<head>`: Open Graph,
// Twitter cards, the title, the description and the site's icon. Plain
// string scanning, so it runs anywhere (Node for the tests, the Worker) and
// costs the same on any page: it only ever sees the bytes `readCapped` kept.

import { LINK_LIMITS, cleanField } from "../../shared/linkPreview.ts";

export interface PageMeta {
	title?: string;
	description?: string;
	siteName?: string;
	/** Absolute http(s). */
	image?: string;
	/** Absolute http(s): the best icon the page names, else `/favicon.ico`. */
	icon?: string;
}

const NAMED: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	hellip: "…",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	laquo: "«",
	raquo: "»",
	middot: "·",
	bull: "•",
	copy: "©",
	reg: "®",
	trade: "™",
	euro: "€",
	pound: "£",
	times: "×",
};

/** Text with HTML's character references read: numeric, and the common named ones. */
export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, ref: string) => {
		if (ref[0] === "#") {
			const code =
				ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
			return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
				? String.fromCodePoint(code)
				: "�";
		}
		return NAMED[ref.toLowerCase()] ?? whole;
	});
}

/** A tag's attributes, names lowercased, values decoded. */
function attributes(source: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const match of source.matchAll(
		/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
	)) {
		const name = match[1]?.toLowerCase();
		if (!name || out.has(name)) continue;
		out.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
	}
	return out;
}

/** An absolute http(s) address from `value` against `base`, or undefined. */
function resolve(value: string | undefined, base: URL): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.length > LINK_LIMITS.url) return undefined;
	try {
		const url = new URL(trimmed, base);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

/** Just the page's head, without comments, scripts, styles or templates, which can hold tags that aren't. */
function headOf(html: string): string {
	const end = html.search(/<\/head\s*>|<body[\s>]/i);
	const head = end >= 0 ? html.slice(0, end) : html;
	return head
		.replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
		.replace(/<(script|style|template|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");
}

interface Icon {
	href: string;
	rel: string;
	size: number;
	type: string;
}

/** How good an icon is for a small badge drawn at 2×: crisp, and not huge. */
function iconScore(icon: Icon): number {
	const vector = icon.type.includes("svg") || /\.svg(?:$|[?#])/i.test(icon.href);
	const size = vector ? 64 : icon.size;
	let score = size === 0 ? 16 : size >= 32 && size <= 256 ? 100 - Math.abs(size - 64) / 4 : 40;
	if (icon.rel.includes("apple-touch-icon")) score -= 5;
	return score;
}

/**
 * What a page says about itself, from its HTML (or the start of it).
 * `pageUrl` is where it ended up, after redirects: relative addresses are
 * resolved against it, or against the page's `<base>`.
 */
export function parsePage(html: string, pageUrl: string): PageMeta {
	const page = new URL(pageUrl);
	const head = headOf(html);
	let base = page;
	const meta = new Map<string, string>();
	const icons: Icon[] = [];
	for (const match of head.matchAll(/<(meta|link|base)\b([^>]*)>/gi)) {
		const tag = match[1]?.toLowerCase();
		const attrs = attributes(match[2] ?? "");
		if (tag === "base") {
			const href = resolve(attrs.get("href"), page);
			if (href && base === page) base = new URL(href);
		} else if (tag === "meta") {
			const key = (attrs.get("property") ?? attrs.get("name") ?? attrs.get("itemprop"))
				?.toLowerCase()
				.trim();
			const content = attrs.get("content") ?? attrs.get("value");
			// The first of each wins, as Open Graph's own consumers read it.
			if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
		} else if (tag === "link") {
			const rel = (attrs.get("rel") ?? "").toLowerCase();
			const href = attrs.get("href");
			if (!href || !/(?:^|\s)(?:icon|apple-touch-icon(?:-precomposed)?)(?:\s|$)/.test(rel))
				continue;
			if (rel.includes("mask-icon")) continue;
			const sizes = attrs.get("sizes") ?? "";
			const size = Math.max(0, ...[...sizes.matchAll(/(\d+)x\d+/gi)].map((m) => Number(m[1])));
			icons.push({ href, rel, size, type: (attrs.get("type") ?? "").toLowerCase() });
		}
	}
	const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1];
	const first = (...keys: string[]) => {
		for (const key of keys) {
			const value = meta.get(key);
			if (value?.trim()) return value;
		}
		return undefined;
	};
	const title = cleanField(
		first("og:title", "twitter:title") ?? (titleTag ? decodeEntities(titleTag) : undefined),
		LINK_LIMITS.title,
	);
	const description = cleanField(
		first("og:description", "twitter:description", "description"),
		LINK_LIMITS.description,
	);
	const siteName = cleanField(
		first("og:site_name", "application-name", "apple-mobile-web-app-title"),
		LINK_LIMITS.siteName,
	);
	const image = resolve(
		first("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"),
		base,
	);
	const best = icons.sort((a, b) => iconScore(b) - iconScore(a))[0];
	const icon = resolve(best?.href, base) ?? new URL("/favicon.ico", page).href;
	return {
		...(title ? { title } : {}),
		...(description ? { description } : {}),
		...(siteName ? { siteName } : {}),
		...(image ? { image } : {}),
		icon,
	};
}

/**
 * The character set to read a page's bytes with: the response's
 * `content-type`, else what the page's first kilobytes say, else UTF-8.
 */
export function charsetOf(contentType: string | null, bytes: Uint8Array): string {
	const header = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType ?? "")?.[1];
	if (header) return header.toLowerCase();
	const start = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
	const declared =
		/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(start)?.[1] ??
		/<meta[^>]+content\s*=\s*["'][^"']*charset=([\w.:-]+)/i.exec(start)?.[1];
	return (declared ?? "utf-8").toLowerCase();
}

/** A page's bytes as text, in its own character set where the runtime knows it. */
export function decodePage(contentType: string | null, bytes: Uint8Array): string {
	const charset = charsetOf(contentType, bytes);
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return new TextDecoder().decode(bytes);
	}
}
