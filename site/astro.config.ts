import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

export default defineConfig({
	site: "https://tack.social",
	integrations: [
		starlight({
			title: "Tack",
			description:
				"Tack is a self-hosted, GitHub-native whiteboard for open source planning: live issue and pull request cards on a freeform board, with changes to GitHub staged and pushed deliberately.",
			favicon: "/favicon.svg",
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
