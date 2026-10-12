// The docs for coding agents, written into Astro's build (dist/):
//
// - each page as Markdown beside its HTML: /self-hosting/deploy.md for
//   /self-hosting/deploy/ (src/agents/pages.ts)
// - /setup.md, how an agent sets up someone's own Tack (src/agents/setup.md)
// - /llms.txt, an index of the pages, and /llms-full.txt, all of them in one
//   file (src/agents/llms.ts)
//
// Then every link in them to the site must lead to a page that's there (and
// a `#section` to a heading on it), and every command in setup.md must be
// the docs' own, or the build fails. `public/_headers` serves them as
// Markdown and plain text.
//
// Runs after `astro build` and before scripts/try.ts.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { llmsFullTxt, llmsTxt } from "../src/agents/llms.ts";
import {
	type Page,
	brokenLinks,
	markdownPath,
	pageFromHtml,
	sidebarFromHtml,
} from "../src/agents/pages.ts";
import { SETUP_TEMPLATE, renderSetup, setupFacts, setupProblems } from "../src/agents/setup.ts";

const here = path.resolve(import.meta.dirname, "..");
const root = path.resolve(here, "..");
const dist = path.join(here, "dist");
const docs = path.join(here, "src", "content", "docs");
if (!existsSync(path.join(dist, "index.html"))) {
	throw new Error("No dist/index.html: run `astro build` first.");
}

/** Every page's path (`/self-hosting/deploy/`), but the landing page's, the demo's and Astro's own. */
function pagePaths(dir = dist, prefix = "/"): string[] {
	return readdirSync(path.join(dir), { withFileTypes: true }).flatMap((entry) => {
		if (!entry.isDirectory() || ["_astro", "pagefind", "try"].includes(entry.name)) return [];
		const here = `${prefix}${entry.name}/`;
		const child = path.join(dir, entry.name);
		return [
			...(existsSync(path.join(child, "index.html")) ? [here] : []),
			...pagePaths(child, here),
		];
	});
}

const htmlFor = (page: string) => path.join(dist, page, "index.html");
const paths = new Set(pagePaths());
const pages = new Map<string, Page>();
for (const page of paths) {
	pages.set(
		page,
		pageFromHtml(readFileSync(htmlFor(page), "utf8"), page, (p) => paths.has(p)),
	);
}
for (const page of pages.values()) {
	writeFileSync(path.join(dist, markdownPath(page.path)), page.markdown);
}

// The setup guide, checked against the docs' sources and the repository.
const sources = readdirSync(docs, { recursive: true, encoding: "utf8" })
	.filter((file) => /\.mdx?$/.test(file))
	.map((file) => readFileSync(path.join(docs, file), "utf8"));
const facts = setupFacts(root);
const setup = renderSetup(readFileSync(SETUP_TEMPLATE, "utf8"), facts);
const problems = setupProblems(setup, facts, sources);
if (problems.length > 0) {
	throw new Error(`src/agents/setup.md:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
}
writeFileSync(path.join(dist, "setup.md"), setup);

// The index, in the sidebar's order, from a page that has the sidebar.
const home = readFileSync(path.join(dist, "index.html"), "utf8");
const description = /<meta name="description" content="([^"]*)"/.exec(home)?.[1] ?? "";
const index = {
	title: "Tack",
	description: description
		.replaceAll("&#39;", "'")
		.replaceAll("&quot;", '"')
		.replaceAll("&amp;", "&"),
	groups: sidebarFromHtml(readFileSync(htmlFor("/start/introduction/"), "utf8")),
	pages,
};
for (const group of index.groups) {
	for (const link of group.links) {
		if (!paths.has(link.path))
			throw new Error(`The sidebar links to ${link.path}, which isn't a page`);
	}
}
writeFileSync(path.join(dist, "llms.txt"), llmsTxt(index));
writeFileSync(path.join(dist, "llms-full.txt"), llmsFullTxt(index, setup));

// Every link to the site, in everything written here, must lead somewhere.
const site = {
	pages: new Set([...paths, "/"]),
	files: new Set(
		["/setup.md", "/llms.txt", "/llms-full.txt"].filter((file) =>
			existsSync(path.join(dist, file)),
		),
	),
	ids: (page: string) =>
		new Set([...readFileSync(htmlFor(page), "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!)),
};
const broken = [
	...brokenLinks(setup, site).map((link) => `setup.md: ${link}`),
	...brokenLinks(readFileSync(path.join(dist, "llms.txt"), "utf8"), site).map(
		(link) => `llms.txt: ${link}`,
	),
	...[...pages.values()].flatMap((page) =>
		brokenLinks(page.markdown, site).map((link) => `${markdownPath(page.path)}: ${link}`),
	),
];
if (broken.length > 0) throw new Error(`Broken links for agents:\n  ${broken.join("\n  ")}`);

console.log(`Wrote ${pages.size} pages as Markdown, setup.md, llms.txt and llms-full.txt`);
