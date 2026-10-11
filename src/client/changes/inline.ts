// Inline Markdown for previews (Markdown.tsx), parsed into a tree rather than
// HTML, so it's testable without a DOM and nothing in a body can become
// markup: code, emphasis, links, images and linked images (`[![alt](src)](href)`,
// as backlinks with a snapshot have), autolinks, backslash escapes, @mentions
// and #references. Only absolute http(s) URLs survive: anything else
// (javascript:, data:, relative paths) leaves a link without an href, and an
// image as its alt text.

export type Inline =
	| { type: "text"; text: string }
	| { type: "code"; text: string }
	| { type: "strong" | "em"; children: Inline[] }
	| { type: "link"; href?: string; title?: string; children: Inline[] }
	| { type: "image"; src?: string; alt: string; title?: string }
	| { type: "mention" | "ref"; text: string };

/** A link or image destination, `<...>` or bare (one level of parentheses), with an optional "title". */
const DEST = String.raw`\(\s*(?:<([^<>\n]*)>|((?:[^\s()\\]|\\.|\([^\s()]*\))*))(?:\s+"([^"\n]*)")?\s*\)`;
const IMAGE = String.raw`!\[((?:\\.|[^\]\n\\])*)\]` + DEST;
/** A link's label: text, or an image (for linked images). */
const LABEL = String.raw`((?:!\[(?:\\.|[^\]\n\\])*\]\([^)\n]*\)|\\.|[^\]\n\\])+)`;

interface Rule {
	/** Characters a match can start with, to skip trying the rest. */
	starts: string;
	re: RegExp;
	/** Makes a link, so it's not tried inside another one's label. */
	links?: boolean;
	build: (match: RegExpExecArray, inLink: boolean) => Inline;
}

/** Markdown's escapable characters: ASCII punctuation. */
const ESCAPABLE = /[!-/:-@[-`{-~]/;

function unescape(text: string): string {
	return text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/** A URL that's safe to link to or load: absolute http(s) only. */
export function safeUrl(url: string | undefined): string | undefined {
	const trimmed = url?.trim() ?? "";
	if (!/^https?:\/\//i.test(trimmed)) return undefined;
	try {
		const { protocol } = new URL(trimmed);
		return protocol === "http:" || protocol === "https:" ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A URL that's safe to load as an image: http(s), or a `blob:` URL this page
 * made itself (a backlink's snapshot drawn but not uploaded yet, as in the
 * playground), which can't reach anywhere else.
 */
export function safeImageUrl(
	url: string | undefined,
	origin = typeof location === "undefined" ? null : location.origin,
): string | undefined {
	const trimmed = url?.trim() ?? "";
	if (origin && origin !== "null" && trimmed.startsWith(`blob:${origin}/`)) return trimmed;
	return safeUrl(trimmed);
}

function image(match: RegExpExecArray): Inline {
	const [, alt = "", angled, bare, title] = match;
	return {
		type: "image",
		src: safeImageUrl(unescape(angled ?? bare ?? "")),
		alt: unescape(alt),
		...(title ? { title } : {}),
	};
}

const IMAGE_ONLY = new RegExp(`^${IMAGE}$`);

const RULES: Rule[] = [
	{
		starts: "`",
		re: /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/y,
		build: ([, , body = ""]) => ({
			type: "code",
			text: /^ .* $/.test(body) && body.trim() ? body.slice(1, -1) : body,
		}),
	},
	{
		starts: "*_",
		re: /\*\*(?=\S)((?:\\.|[^\\])*?(?:\\.|[^\s\\]))\*\*|__(?=\S)((?:\\.|[^\\])*?(?:\\.|[^\s\\]))__(?!\w)/y,
		build: ([, star, under], inLink) => ({
			type: "strong",
			children: parseInline(star ?? under ?? "", inLink),
		}),
	},
	{
		starts: "*_",
		re: /\*(?=[^*\s])((?:\\.|[^*\\])*?[^*\s\\])\*|(?<!\w)_(?=[^_\s])((?:\\.|[^_\\])*?[^_\s\\])_(?!\w)/y,
		build: ([, star, under], inLink) => ({
			type: "em",
			children: parseInline(star ?? under ?? "", inLink),
		}),
	},
	{ starts: "!", re: new RegExp(IMAGE, "y"), build: image },
	{
		starts: "[",
		links: true,
		re: new RegExp(String.raw`\[${LABEL}\]${DEST}`, "y"),
		build: ([, label = "", angled, bare, title]) => {
			const linked = IMAGE_ONLY.exec(label.trim());
			return {
				type: "link",
				href: safeUrl(unescape(angled ?? bare ?? "")),
				...(title ? { title } : {}),
				children: linked ? [image(linked)] : parseInline(label, true),
			};
		},
	},
	{
		starts: "<",
		links: true,
		re: /<(https?:\/\/[^\s<>]+)>/iy,
		build: ([, url = ""]) => ({
			type: "link",
			href: safeUrl(url),
			children: [{ type: "text", text: url }],
		}),
	},
	{
		starts: "hH",
		links: true,
		re: /(?<![\w/])https?:\/\/[^\s<]*[^\s<.,:;"')\]!?*_]/iy,
		build: ([url]) => ({
			type: "link",
			href: safeUrl(url),
			children: [{ type: "text", text: url }],
		}),
	},
	{
		starts: "@",
		re: /(?<![\w/`])@[a-z\d](?:[a-z\d-]{0,38})(?![\w-])/iy,
		build: ([text]) => ({ type: "mention", text }),
	},
	{
		starts: "#",
		re: /(?<![\w/&])#\d+(?!\w)/y,
		build: ([text]) => ({ type: "ref", text }),
	},
];

/** Parse a line (or paragraph) of inline Markdown. */
export function parseInline(text: string, inLink = false): Inline[] {
	const out: Inline[] = [];
	let buffer = "";
	const flush = () => {
		if (buffer) out.push({ type: "text", text: buffer });
		buffer = "";
	};
	let i = 0;
	outer: while (i < text.length) {
		const char = text[i] ?? "";
		if (char === "\\" && ESCAPABLE.test(text[i + 1] ?? "")) {
			buffer += text[i + 1];
			i += 2;
			continue;
		}
		for (const rule of RULES) {
			if (!rule.starts.includes(char) || (inLink && rule.links)) continue;
			rule.re.lastIndex = i;
			const match = rule.re.exec(text);
			if (!match) continue;
			flush();
			out.push(rule.build(match, inLink));
			i += match[0].length;
			continue outer;
		}
		buffer += char;
		i++;
	}
	flush();
	return out;
}
