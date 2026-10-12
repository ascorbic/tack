// /llms.txt (https://llmstxt.org): the docs' index for language models and
// coding agents, in the sidebar's order, every page linked as its Markdown,
// with /setup.md first. And /llms-full.txt: every page in one file.
import { type Page, SITE, type SidebarGroup, markdownPath } from "./pages.ts";

export interface Index {
	title: string;
	description: string;
	groups: SidebarGroup[];
	pages: Map<string, Page>;
}

export function llmsTxt({ title, description, groups, pages }: Index): string {
	const entry = (label: string, path: string) => {
		const about = pages.get(path)?.description;
		return `- [${label}](${SITE}${markdownPath(path)})${about ? `: ${about}` : ""}`;
	};
	return [
		`# ${title}`,
		`> ${description}`,
		[
			"Tack is self-hosted: each instance is one Cloudflare Worker on its owner's Cloudflare account, with a GitHub App they own. There's no hosted Tack.",
			"Every page below is Markdown; its HTML is at the same address without `.md`. To set up an instance from a terminal, start with the first link.",
		].join(" "),
		"## Set up your own",
		`- [Set up Tack with a coding agent](${SITE}/setup.md): step-by-step instructions for a coding agent in the user's terminal: prerequisites, forking with \`gh\`, configuring and deploying with the \`cf\` CLI, and the browser steps only the user can do`,
		...groups.flatMap((group) => [
			`## ${group.label}`,
			group.links.map((link) => entry(link.label, link.path)).join("\n"),
		]),
		"## Optional",
		[
			`- [Complete documentation](${SITE}/llms-full.txt): every page above, in one file`,
			`- [Try Tack](${SITE}/try/): a board in the browser, with pretend people and a pretend GitHub, nothing to install`,
			"- [Source code](https://github.com/ascorbic/tack): the repository, with the Deploy to Cloudflare button",
		].join("\n"),
	]
		.join("\n\n")
		.concat("\n");
}

/** Every page, in the sidebar's order, after setup.md, each under a rule and its address. */
export function llmsFullTxt({ title, description, groups, pages }: Index, setup: string): string {
	const sections = [
		{ url: `${SITE}/setup.md`, markdown: setup },
		...groups.flatMap((group) =>
			group.links.flatMap((link) => {
				const page = pages.get(link.path);
				return page ? [{ url: `${SITE}${link.path}`, markdown: page.markdown }] : [];
			}),
		),
	];
	return [
		`# ${title}\n\n> ${description}\n`,
		...sections.map(({ url, markdown }) => `---\n\nSource: ${url}\n\n${markdown.trim()}\n`),
	].join("\n");
}
