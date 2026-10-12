import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

const site = "https://tack.social";
// The link preview image (scripts/og.ts), for every page.
const og = [
	{ property: "og:image", content: `${site}/og.png` },
	{ property: "og:image:width", content: "1200" },
	{ property: "og:image:height", content: "630" },
	{
		property: "og:image:alt",
		content:
			"Tack: plan on a board, push to GitHub. A board of live issue and pull request cards, a stack, a live list and stickies.",
	},
	{ name: "twitter:image", content: `${site}/og.png` },
];

export default defineConfig({
	site,
	integrations: [
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
