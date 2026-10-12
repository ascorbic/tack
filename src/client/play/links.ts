import type * as Y from "yjs";
import { type LinkPreview, addLinkShape } from "../../shared/links.ts";
import { addShape, nextZ } from "../../shared/shapes.ts";
import { stackUp } from "../../shared/stackEdits.ts";
import { addSection } from "../../shared/structure.ts";
import type { LinkService } from "../links/service.ts";

// Link cards in the playground and the public demo, offline: a stand-in for
// the Worker's unfurler (src/server/links/) with canned pages for the owner's
// own sites, drawn here as SVG, so nothing ever leaves the browser (the
// demo's policy allows images from nowhere but itself and `data:`). Addresses
// with `[fail]` in them, or on a host that can't exist, couldn't be read;
// private addresses are refused, as the Worker refuses them; anything else is
// a page that says nothing about itself but its name.

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

function svg(body: string, w = 1200, h = 630): string {
	const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`;
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
}

const UNPIC_IMAGE = svg(`
	<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff6a3d"/><stop offset="1" stop-color="#ffb648"/></linearGradient></defs>
	<rect width="1200" height="630" fill="url(#g)"/>
	<g fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="6">
		<rect x="700" y="120" width="380" height="260" rx="22"/><rect x="760" y="190" width="380" height="260" rx="22"/><rect x="820" y="260" width="300" height="200" rx="22"/>
	</g>
	<circle cx="905" cy="330" r="34" fill="#fff" fill-opacity=".7"/>
	<path d="M840 440l90-110 70 80 40-40 80 70" fill="none" stroke="#fff" stroke-width="10" stroke-linejoin="round" stroke-opacity=".75"/>
	<text x="90" y="300" font-family="${SANS}" font-size="132" font-weight="800" fill="#fff" letter-spacing="-5">unpic</text>
	<text x="96" y="380" font-family="${SANS}" font-size="38" font-weight="500" fill="#fff" fill-opacity=".9">Responsive images, without the fuss</text>`);

const UNPIC_ICON = svg(
	`<rect width="64" height="64" rx="16" fill="#ff6a3d"/><text x="32" y="45" text-anchor="middle" font-family="${SANS}" font-size="40" font-weight="800" fill="#fff">u</text>`,
	64,
	64,
);

const EMDASH_IMAGE = svg(`
	<rect width="1200" height="630" fill="#15142b"/>
	<g opacity=".5"><circle cx="1040" cy="90" r="240" fill="#6d4aff" opacity=".35"/><circle cx="1120" cy="560" r="200" fill="#ff5fa2" opacity=".25"/></g>
	<rect x="90" y="250" width="300" height="34" rx="17" fill="#8f7bff"/>
	<text x="90" y="210" font-family="${SANS}" font-size="112" font-weight="800" fill="#fff" letter-spacing="-4">EmDash</text>
	<text x="90" y="370" font-family="${SANS}" font-size="40" font-weight="500" fill="#d7d2ff">The CMS that writes like you do</text>
	<text x="90" y="430" font-family="${SANS}" font-size="30" fill="#a59fd6">Content, components and collaboration, built on Astro</text>`);

const EMDASH_ICON = svg(
	`<rect width="64" height="64" rx="16" fill="#15142b"/><rect x="12" y="29" width="40" height="7" rx="3.5" fill="#8f7bff"/>`,
	64,
	64,
);

const TACK_IMAGE = svg(`
	<defs><pattern id="d" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="2" fill="#d3cfc5"/></pattern></defs>
	<rect width="1200" height="630" fill="#f4f3ef"/><rect width="1200" height="630" fill="url(#d)"/>
	<g transform="rotate(-4 860 300)"><rect x="700" y="150" width="300" height="300" rx="6" fill="#ffe58f"/><rect x="700" y="150" width="300" height="300" rx="6" fill="none" stroke="#000" stroke-opacity=".06"/>
	<text x="730" y="230" font-family="${SANS}" font-size="34" font-weight="600" fill="#3f444b">Plan the</text><text x="730" y="275" font-family="${SANS}" font-size="34" font-weight="600" fill="#3f444b">next release</text></g>
	<circle cx="850" cy="160" r="16" fill="#c2372b"/><circle cx="845" cy="155" r="5" fill="#fff" fill-opacity=".6"/>
	<g transform="rotate(3 600 420)"><rect x="470" y="360" width="260" height="130" rx="12" fill="#fff" stroke="#17191c" stroke-opacity=".1"/><circle cx="500" cy="392" r="9" fill="none" stroke="#1a6431" stroke-width="3"/><rect x="520" y="384" width="110" height="14" rx="7" fill="#e3f4e7"/><rect x="494" y="420" width="200" height="14" rx="7" fill="#ebe9e3"/><rect x="494" y="446" width="140" height="14" rx="7" fill="#ebe9e3"/></g>
	<text x="90" y="250" font-family="${SANS}" font-size="120" font-weight="800" fill="#17191c" letter-spacing="-4">Tack</text>
	<text x="94" y="320" font-family="${SANS}" font-size="36" font-weight="500" fill="#3f444b">A whiteboard for open source</text>
	<text x="94" y="366" font-family="${SANS}" font-size="36" font-weight="500" fill="#3f444b">planning, on your forge</text>`);

const TACK_ICON = svg(
	`<rect width="64" height="64" rx="16" fill="#3b4cca"/><circle cx="32" cy="26" r="13" fill="#fff"/><path d="M32 38v16" stroke="#fff" stroke-width="5" stroke-linecap="round"/>`,
	64,
	64,
);

const CIRRUS_IMAGE = svg(`
	<rect width="1200" height="630" fill="#ffffff"/>
	<rect y="600" width="1200" height="30" fill="#3b4cca"/>
	<text x="80" y="200" font-family="${SANS}" font-size="44" fill="#5a5f66">ascorbic/</text>
	<text x="80" y="300" font-family="${SANS}" font-size="104" font-weight="800" fill="#17191c" letter-spacing="-3">cirrus</text>
	<text x="80" y="380" font-family="${SANS}" font-size="34" fill="#3f444b">A tiny personal data server for the Atmosphere</text>
	<g font-family="${SANS}" font-size="28" fill="#5a5f66"><text x="80" y="520">★ 412</text><text x="260" y="520">⑂ 23</text><text x="420" y="520">● TypeScript</text></g>
	<g transform="translate(900 120)"><circle cx="110" cy="110" r="110" fill="#e8ecff"/><path d="M50 140c-22 0-34-16-34-32 0-18 14-32 32-32 4-26 26-44 52-44 24 0 44 16 50 38 22 0 40 18 40 40s-18 30-40 30z" fill="#fff" stroke="#3b4cca" stroke-width="6" stroke-linejoin="round"/></g>`);

const FORGE_ICON = svg(
	`<rect width="64" height="64" rx="32" fill="#17191c"/><circle cx="32" cy="32" r="12" fill="none" stroke="#fff" stroke-width="5"/>`,
	64,
	64,
);

/** Canned pages, by address (without a trailing slash), and the images they name. */
const PAGES: Record<string, Omit<LinkPreview, "status" | "fetchedAt">> = {
	"https://unpic.pics": {
		title: "Unpic: responsive images, without the fuss",
		description:
			"Drop-in image components for every framework and every image CDN. Unpic detects the CDN, builds the srcset and gets the sizes right, so your pages load faster.",
		siteName: "Unpic",
		image: "https://unpic.pics/og.png",
		icon: "https://unpic.pics/favicon.svg",
	},
	"https://unpic.pics/img/astro": {
		title: "Using Unpic with Astro",
		description:
			"The Image and Source components for Astro, with every CDN Unpic supports and local images too.",
		siteName: "Unpic",
		image: "https://unpic.pics/og.png",
		icon: "https://unpic.pics/favicon.svg",
	},
	"https://emdashcms.com": {
		title: "EmDash: the CMS that writes like you do",
		description:
			"Structured content, live previews and real-time collaboration, built on Astro and deployed anywhere.",
		siteName: "EmDash",
		image: "https://emdashcms.com/og.png",
		icon: "https://emdashcms.com/favicon.svg",
	},
	"https://emdashcms.com/docs/roadmap": {
		title: "Roadmap · EmDash",
		description:
			"What’s shipping next in EmDash: plugins, scheduled publishing and the media library.",
		siteName: "EmDash",
		image: "https://emdashcms.com/og.png",
		icon: "https://emdashcms.com/favicon.svg",
	},
	"https://tack.social": {
		title: "Tack: a whiteboard for open source planning",
		description:
			"Plan in public with your issues and pull requests on a live, collaborative board. Stage changes and push them back to your forge.",
		siteName: "Tack",
		image: "https://tack.social/og.png",
		icon: "https://tack.social/favicon.svg",
	},
	"https://tack.social/docs/boards/link-cards": {
		title: "Link cards",
		description:
			"Paste any web address onto a board and it becomes a card with the page’s preview: its image, title and description.",
		siteName: "Tack",
		icon: "https://tack.social/favicon.svg",
	},
	"https://github.com/ascorbic/cirrus": {
		title: "ascorbic/cirrus: a tiny personal data server for the Atmosphere",
		description:
			"A single-user AT Protocol PDS that runs on Cloudflare Workers. Contribute to ascorbic/cirrus by creating an account on GitHub.",
		siteName: "GitHub",
		image: "https://github.com/ascorbic/cirrus/og.png",
		icon: "https://github.com/favicon.svg",
	},
	// A page with nothing to say about itself but its title.
	"https://tack.social/changelog.txt": {
		title: "changelog.txt",
	},
};

/** The images canned pages name, drawn here. */
const IMAGES: Record<string, string> = {
	"https://unpic.pics/og.png": UNPIC_IMAGE,
	"https://unpic.pics/favicon.svg": UNPIC_ICON,
	"https://emdashcms.com/og.png": EMDASH_IMAGE,
	"https://emdashcms.com/favicon.svg": EMDASH_ICON,
	"https://tack.social/og.png": TACK_IMAGE,
	"https://tack.social/favicon.svg": TACK_ICON,
	"https://github.com/ascorbic/cirrus/og.png": CIRRUS_IMAGE,
	"https://github.com/favicon.svg": FORGE_ICON,
};

/** What the Worker would refuse, roughly: private and local addresses. */
function isPrivate(host: string): boolean {
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".internal") ||
		host.endsWith(".local") ||
		/^(127|10|0)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^\[/.test(host)
	);
}

/** What the playground's unfurler answers for `url`, at `now`. */
export function playPreview(url: string, now = Date.now()): LinkPreview {
	const fetchedAt = new Date(now).toISOString();
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { status: "failed", fetchedAt };
	}
	if (isPrivate(parsed.hostname)) return { status: "blocked", fetchedAt };
	if (
		url.includes("[fail]") ||
		url.includes("%5Bfail%5D") ||
		parsed.hostname.endsWith(".invalid")
	) {
		return { status: "failed", fetchedAt };
	}
	const key = `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "");
	const page = PAGES[key];
	if (page) return { status: "ok", ...page, fetchedAt };
	// Anything else: a page with only its title.
	const words = parsed.pathname.split("/").filter(Boolean).at(-1)?.replace(/[-_]+/g, " ");
	return {
		status: "ok",
		title: words ? words.charAt(0).toUpperCase() + words.slice(1) : parsed.hostname,
		fetchedAt,
	};
}

/** How long the pretend unfurler takes, so the skeleton's seen. */
let delayMs = 700;

/** For the playground's controls and tests: how long reading a page takes. */
export function setPlayLinkDelay(ms: number): void {
	delayMs = ms;
}

/** The playground's and the demo's link service: canned, in the browser. */
export const playLinks: LinkService = {
	async unfurl(url) {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		return { kind: "preview", preview: playPreview(url) };
	},
	imageSrc: (src) => IMAGES[src] ?? null,
};

/** A canned page's preview as if read a little while ago, for seeding boards. */
export function cannedPreview(url: string, ago = 2 * 3_600_000): LinkPreview {
	return playPreview(url, Date.now() - ago);
}

/** Add a link card, read already unless `fresh` (then it's read as the board opens). */
export function seedLink(
	doc: Y.Doc,
	url: string,
	at: { x: number; y: number },
	{ fresh = false, parent }: { fresh?: boolean; parent?: string } = {},
): string {
	const id = crypto.randomUUID();
	addLinkShape(doc, id, {
		url,
		x: at.x,
		y: at.y,
		...(fresh ? {} : { preview: cannedPreview(url) }),
		...(parent ? { parent } : {}),
	});
	return id;
}

/**
 * `?scenario=links`: link cards in every state, in a research section: pages
 * with a preview image, one with only an icon, one with nothing but a title,
 * one that couldn't be read, one Tack won't read, and one read as the board
 * opens. Beside it, a sticky with an address in its words (it stays a
 * sticky) and a stack holding a link card. Paste or drop an address to add
 * another (`[fail]` in it fails).
 */
export function seedLinks(doc: Y.Doc): void {
	doc.transact(() => {
		const section = addSection(
			doc,
			{ x: 40, y: 40, w: 1480, h: 760 },
			{ title: "Research", color: "blue" },
		);
		const at = (column: number, row: number) => ({ x: 80 + column * 284, y: 100 + row * 360 });
		const inside = { parent: section };
		seedLink(doc, "https://unpic.pics/", at(0, 0), inside);
		seedLink(doc, "https://emdashcms.com/", at(1, 0), inside);
		seedLink(doc, "https://tack.social/", at(2, 0), inside);
		seedLink(doc, "https://github.com/ascorbic/cirrus", at(3, 0), inside);
		seedLink(doc, "https://unpic.pics/img/astro", at(4, 0), { ...inside, fresh: true });
		seedLink(doc, "https://tack.social/docs/boards/link-cards", at(0, 1), inside);
		seedLink(doc, "https://tack.social/changelog.txt", at(1, 1), inside);
		seedLink(doc, "https://docs.emdashcms.invalid/guide", at(2, 1), inside);
		seedLink(doc, "http://192.168.1.20/admin", at(3, 1), inside);
		addShape(doc, crypto.randomUUID(), {
			type: "sticky",
			text: "Read https://tack.social/docs before Friday’s session",
			color: "yellow",
			author: { name: "Priya Shah", color: "#b4467a" },
			x: 1600,
			y: 60,
			z: nextZ(doc),
		});
		const note = crypto.randomUUID();
		addShape(doc, note, {
			type: "sticky",
			text: "Unpic’s docs need an Astro page",
			color: "pink",
			author: { name: "Kai Andersen", color: "#1f7a6b" },
			x: 1600,
			y: 320,
			z: nextZ(doc),
		});
		const link = seedLink(doc, "https://emdashcms.com/docs/roadmap", { x: 1820, y: 320 });
		stackUp(doc, note, [link]);
	});
}
