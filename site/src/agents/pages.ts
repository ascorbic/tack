// The docs as Markdown, for coding agents: each built page's content turned
// back into Markdown (so generated parts, like the widget settings tables,
// are there too), and the sidebar's order, both read from Astro's build.
// site/scripts/agents.ts writes them beside the HTML.
import type { Element, ElementContent, Root, RootContent } from "hast";
import { fromHtml } from "hast-util-from-html";
import { matches, select, selectAll } from "hast-util-select";
import { toMdast } from "hast-util-to-mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";

export const SITE = "https://tack.social";

/** A page's path on the site, like `/self-hosting/deploy/`, as its Markdown's: `/self-hosting/deploy.md`. */
export function markdownPath(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed === "" ? "/index.md" : `${trimmed}.md`;
}

export interface Page {
	/** Its path on the site, like `/self-hosting/deploy/`. */
	path: string;
	title: string;
	description: string;
	/** The page's content as Markdown, under its title and description. */
	markdown: string;
}

export interface SidebarGroup {
	label: string;
	links: { label: string; path: string }[];
}

const text = (node: Element | Root | undefined): string => {
	if (!node) return "";
	let out = "";
	const walk = (child: Element | Root | RootContent | ElementContent) => {
		if (child.type === "text") out += child.value;
		else if ("children" in child) child.children.forEach(walk);
	};
	walk(node);
	return out.replace(/\s+/g, " ").trim();
};

/** Takes out every node `drop` matches, anywhere under `node`. */
function prune(node: Element | Root, drop: (child: Element) => boolean): void {
	node.children = node.children.filter(
		(child) => child.type !== "comment" && !(child.type === "element" && drop(child)),
	) as typeof node.children;
	for (const child of node.children) if (child.type === "element") prune(child, drop);
}

function element(tagName: string, children: ElementContent[], properties = {}): Element {
	return { type: "element", tagName, properties, children };
}

/** Swaps `node` for `replacement` in place, keeping the object (and so its place in its parent). */
function replace(node: Element, replacement: Element): void {
	Object.assign(node, replacement);
}

/**
 * Expressive Code's frames as plain fenced code: the code from the copy
 * button (which has it exactly, lines and all) and the language from `<pre>`.
 */
function plainCode(content: Element): void {
	for (const frame of selectAll(".expressive-code", content)) {
		const pre = select("pre", frame);
		const copy = select("button[data-code]", frame);
		const code = String(copy?.properties.dataCode ?? "").replaceAll("\u007f", "\n");
		const language = pre?.properties.dataLanguage;
		replace(
			frame,
			element("pre", [
				element(
					"code",
					[{ type: "text", value: code }],
					language ? { className: [`language-${String(language)}`] } : {},
				),
			]),
		);
	}
}

/** Starlight's asides as quotes, led by their title: "**Caution: Do setup straight away**". */
function plainAsides(content: Element): void {
	for (const aside of selectAll("aside.starlight-aside", content)) {
		const title = text(select(".starlight-aside__title", aside));
		const body = select(".starlight-aside__content", aside);
		replace(
			aside,
			element("blockquote", [
				element("p", [element("strong", [{ type: "text", value: title }])]),
				...(body?.children ?? []),
			]),
		);
	}
}

/**
 * The shortcuts tables' key combinations as one code span each, `Shift+Ctrl+Z`,
 * with "or" between them spaced as it reads (on the page, CSS spaces them).
 */
function plainKeys(content: Element): void {
	for (const combo of selectAll(".tk-combo", content)) {
		const keys = selectAll("kbd", combo).map((key) => text(key));
		replace(combo, element("code", [{ type: "text", value: keys.join("+") }]));
	}
	for (const or of selectAll(".tk-or", content)) {
		replace(or, element("span", [{ type: "text", value: ` ${text(or)} ` }]));
	}
}

/** Screenshots come in a light and a dark version: the light one is enough. */
const darkOnly = (node: Element) =>
	Array.isArray(node.properties.className) && node.properties.className.includes("light:sl-hidden");

/**
 * Links and images as absolute addresses, and links to other pages of the
 * docs as their Markdown (with any `#section`), so an agent reading one page
 * can follow its links the same way.
 */
function absoluteLinks(content: Element, path: string, isPage: (path: string) => boolean): void {
	for (const link of selectAll("a[href]", content)) {
		const href = String(link.properties.href);
		const url = new URL(href, `${SITE}${path}`);
		if (url.origin === SITE && isPage(url.pathname)) {
			link.properties.href = `${SITE}${markdownPath(url.pathname)}${url.hash}`;
		} else {
			link.properties.href = url.href;
		}
	}
	for (const image of selectAll("img[src]", content)) {
		image.properties.src = new URL(String(image.properties.src), `${SITE}${path}`).href;
	}
}

/**
 * A built page as Markdown: its title, its description, and its content
 * (the part of `<main>` that's the page's own), with what's only there for
 * the eye (heading anchors, icons, copy buttons) taken out.
 */
export function pageFromHtml(html: string, path: string, isPage: (path: string) => boolean): Page {
	const tree = fromHtml(html);
	const title = text(select("main h1", tree));
	const description = String(select('meta[name="description"]', tree)?.properties.content ?? "");
	const content = select(".sl-markdown-content", tree);
	if (!title || !content) throw new Error(`${path} has no title or no content`);

	plainCode(content);
	plainAsides(content);
	plainKeys(content);
	// "Copy prompt" (CopyPrompt.astro) as the prompt it copies.
	for (const control of selectAll("[data-tk-prompt]", content)) {
		const prompt = String(select("[data-prompt]", control)?.properties.dataPrompt ?? "");
		const code = element("code", [{ type: "text", value: prompt }], {
			className: ["language-text"],
		});
		replace(control, element("pre", [code]));
	}
	prune(
		content,
		(node) =>
			darkOnly(node) ||
			matches(
				".sl-anchor-link, .sr-only, [aria-hidden=true], [hidden], script, style, link, svg, button, template, textarea",
				node,
			),
	);
	absoluteLinks(content, path, isPage);

	const body = toMarkdown(toMdast(content), {
		extensions: [gfmToMarkdown()],
		bullet: "-",
		emphasis: "_",
		rule: "-",
	}).trim();
	const markdown = [`# ${title}`, description && `> ${description}`, body]
		.filter(Boolean)
		.join("\n\n");
	return { path, title, description, markdown: `${markdown}\n` };
}

export interface SiteMap {
	/** Every page's path, like `/self-hosting/deploy/`. */
	pages: Set<string>;
	/** Files that aren't pages: `/setup.md`, `/llms.txt`. */
	files: Set<string>;
	/** The ids on a page, which a `#section` must be one of. Without it, sections aren't checked. */
	ids?: (page: string) => Set<string>;
}

/**
 * Links in `markdown` to the site that lead nowhere: to a page or file that
 * isn't there, or to a `#section` that isn't on its page. A page's Markdown,
 * `/x.md`, is the page `/x/`. The demo and built assets aren't the docs', so
 * they're left alone.
 */
export function brokenLinks(markdown: string, site: SiteMap): string[] {
	const broken: string[] = [];
	const ids = new Map<string, Set<string>>();
	for (const [, href] of markdown.matchAll(/\]\((https:\/\/[^)\s]+)\)/g)) {
		const url = new URL(href!);
		if (url.origin !== SITE || /^\/(try|_astro)\//.test(url.pathname)) continue;
		if (site.files.has(url.pathname)) continue;
		const page = url.pathname.endsWith(".md") ? `${url.pathname.slice(0, -3)}/` : url.pathname;
		if (!site.pages.has(page)) {
			broken.push(href!);
		} else if (url.hash && site.ids) {
			if (!ids.has(page)) ids.set(page, site.ids(page));
			if (!ids.get(page)!.has(decodeURIComponent(url.hash.slice(1)))) {
				broken.push(`${href} (no such section)`);
			}
		}
	}
	return broken;
}

/**
 * The docs' sidebar, in order, from a built page: each group's label and
 * links (a group within a group adds its label to its links'), and links
 * outside any group as groups of their own.
 */
export function sidebarFromHtml(html: string): SidebarGroup[] {
	const tree = fromHtml(html);
	const top = select("#starlight__sidebar ul.top-level", tree);
	if (!top) throw new Error("No sidebar on this page");
	const groups: SidebarGroup[] = [];
	const linksIn = (list: Element, prefix: string): SidebarGroup["links"] =>
		list.children.flatMap((item) => {
			if (item.type !== "element" || item.tagName !== "li") return [];
			const details = select(":scope > details", item);
			if (details) {
				const label = text(select("summary .group-label", details));
				const nested = select(":scope > ul", details);
				return nested ? linksIn(nested, `${prefix}${label}: `) : [];
			}
			const link = select(":scope > a[href]", item);
			return link ? [{ label: `${prefix}${text(link)}`, path: String(link.properties.href) }] : [];
		});
	for (const item of top.children) {
		if (item.type !== "element" || item.tagName !== "li") continue;
		const details = select(":scope > details", item);
		const list = details && select(":scope > ul", details);
		if (details && list) {
			groups.push({
				label: text(select("summary .group-label", details)),
				links: linksIn(list, ""),
			});
		} else {
			const links = linksIn(element("ul", [item]), "");
			if (links[0]) groups.push({ label: links[0].label, links });
		}
	}
	return groups;
}
