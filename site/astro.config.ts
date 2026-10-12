import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";
import { ASK_ENDPOINT } from "./src/ask/stream.ts";

const site = "https://tack.social";
// The link preview image (scripts/og.ts), for every page.
const og = [
	{ property: "og:image", content: `${site}/og.png` },
	{ property: "og:image:width", content: "1200" },
	{ property: "og:image:height", content: "630" },
	{
		property: "og:image:alt",
		content:
			"Tack: plan on a board, sync to GitHub. A board of live issue and pull request cards, a stack, a live list and stickies.",
	},
	{ name: "twitter:image", content: `${site}/og.png` },
];

// The docs' Ask (src/components/Ask.astro) calls AI Search's public endpoint,
// which only answers browsers on tack.social: on this machine, the dev and
// preview servers pass `/__ask/*` through to it.
const askProxy = {
	"/__ask": {
		target: ASK_ENDPOINT,
		changeOrigin: true,
		rewrite: (path: string) => path.replace(/^\/__ask/, ""),
	},
};

export default defineConfig({
	site,
	vite: { server: { proxy: askProxy }, preview: { proxy: askProxy } },
	integrations: [
		// Starlight's own sitemap, with every page's <lastmod> set to the build:
		// AI Search's crawler (the docs' "Ask" index, see AGENTS.md) re-reads a
		// page only when its <lastmod> is newer than its last sync, so a deploy
		// means every page is read again on the next sync.
		sitemap({ lastmod: new Date() }),
		starlight({
			title: "Tack",
			description:
				"Tack is an open source, self-hosted whiteboard for planning sessions on GitHub's own data: live issue and pull request cards on a shared board, with what you decide pushed back to GitHub as one reviewed batch.",
			favicon: "/favicon.svg",
			head: og.map((attrs) => ({ tag: "meta" as const, attrs })),
			social: [{ icon: "github", label: "GitHub", href: "https://github.com/ascorbic/tack" }],
			editLink: { baseUrl: "https://github.com/ascorbic/tack/edit/main/site/" },
			lastUpdated: true,
			customCss: [
				"@fontsource-variable/geist",
				"@fontsource-variable/geist-mono",
				"@fontsource-variable/bricolage-grotesque",
				"./src/styles/theme.css",
			],
			components: {
				Hero: "./src/components/Hero.astro",
				SiteTitle: "./src/components/SiteTitle.astro",
				Search: "./src/components/Search.astro",
			},
			expressiveCode: {
				themes: ["github-dark", "github-light"],
				styleOverrides: {
					borderRadius: "10px",
					codeFontFamily: "var(--tk-font-mono)",
					uiFontFamily: "var(--tk-font-ui)",
				},
			},
			sidebar: [
				{ label: "Start here", items: [{ autogenerate: { directory: "start" } }] },
				{ label: "Using boards", items: [{ autogenerate: { directory: "boards" } }] },
				{
					label: "Writing back to GitHub",
					items: [{ autogenerate: { directory: "writing-back" } }],
				},
				{ label: "Widgets", items: [{ autogenerate: { directory: "widgets" } }] },
				{ label: "Automation", items: [{ autogenerate: { directory: "automation" } }] },
				{ label: "Facilitation", items: [{ autogenerate: { directory: "facilitation" } }] },
				{ label: "Templates", link: "/templates/" },
				{ label: "Self-hosting", items: [{ autogenerate: { directory: "self-hosting" } }] },
				{ label: "Help", items: [{ autogenerate: { directory: "help" } }] },
			],
			// Broken links between pages fail the build. The demo at /try/ isn't
			// one of its pages: scripts/try.ts copies it in after Astro's build.
			plugins: [starlightLinksValidator({ exclude: ["/try/", "/try/**"] })],
		}),
	],
});
