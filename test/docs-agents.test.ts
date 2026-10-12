// The docs for coding agents (site/scripts/agents.ts): /setup.md, /llms.txt
// and each page as Markdown. setup.md is what an agent runs on someone's
// machine, so its commands, links and the app's words it quotes must all be
// real; the build checks the built site's links, and these check the rest.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { llmsTxt } from "../site/src/agents/llms.ts";
import {
	SITE,
	brokenLinks,
	markdownPath,
	pageFromHtml,
	sidebarFromHtml,
} from "../site/src/agents/pages.ts";
import { SETUP_PROMPT, SETUP_URL } from "../site/src/agents/prompt.ts";
import {
	AGENT_COMMANDS,
	SETUP_TEMPLATE,
	commandsIn,
	renderSetup,
	setupFacts,
	setupProblems,
} from "../site/src/agents/setup.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCS = path.join(ROOT, "site", "src", "content", "docs");
const DIST = path.join(ROOT, "site", "dist");

const docsFiles = readdirSync(DOCS, { recursive: true, encoding: "utf8" }).filter((file) =>
	/\.mdx?$/.test(file),
);
const sources = docsFiles.map((file) => readFileSync(path.join(DOCS, file), "utf8"));
/** The docs' pages, as the site has them: `self-hosting/deploy.mdx` is `/self-hosting/deploy/`. */
const docsPages = new Set(
	docsFiles.map((file) => {
		const slug = file.replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "");
		return slug ? `/${slug}/` : "/";
	}),
);
const facts = setupFacts(ROOT);
const setup = renderSetup(readFileSync(SETUP_TEMPLATE, "utf8"), facts);

describe("setup.md", () => {
	it("says what the repository says: Node.js, pnpm and the Worker's name", () => {
		const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
			engines: { node: string };
			packageManager: string;
		};
		expect(pkg.engines.node).toBe(`>=${facts.node}`);
		expect(pkg.packageManager).toBe(`pnpm@${facts.pnpm}`);
		expect(setup).toContain(`Node.js ${facts.node} or later`);
		expect(setup).toContain(`pnpm@${facts.pnpm}`);
		expect(setup).toContain(`\`${facts.name}\` unless they want another`);
		expect(setup).not.toMatch(/\{\{|\}\}/);
	});

	it("runs only the docs' own commands, real scripts, and settings that are there", () => {
		expect(setupProblems(setup, facts, sources)).toEqual([]);
		// And it would say so if not.
		const wrong = `${setup}\n\`\`\`sh\npnpm run deploy:everywhere\nwrangler deploy\n\`\`\`\n`;
		expect(setupProblems(wrong, facts, sources)).toEqual([
			"`pnpm run deploy:everywhere` is in neither the docs nor AGENT_COMMANDS",
			"`wrangler deploy` is in neither the docs nor AGENT_COMMANDS",
			"There's no `deploy:everywhere` script in package.json",
		]);
	});

	it("names only real cf commands", () => {
		const commands = new Set(
			[...setup.matchAll(/pnpm exec cf ((?:[a-z][a-z0-9-]*)(?: [a-z][a-z0-9-]*)*)/g)].map(
				([, command]) => command!,
			),
		);
		expect([...commands]).toEqual(
			expect.arrayContaining(["auth whoami", "auth login", "workers list", "o11y telemetry query"]),
		);
		const cf = path.join(ROOT, "node_modules", ".bin", "cf");
		for (const command of commands) {
			const help = execFileSync(cf, [...command.split(" "), "--help"], { encoding: "utf8" });
			// An unknown subcommand prints its parent's help instead.
			const heading = help.split("\n").find((line) => line.startsWith("cf "));
			expect(heading?.split(/\s+<|\s+\[/)[0], command).toBe(`cf ${command}`);
		}
	});

	it("never deploys with Wrangler, and keeps TACK_SECRET out of sight", () => {
		for (const command of commandsIn(setup))
			expect(command).not.toMatch(/wrangler (deploy|secret)/);
		expect(setup).not.toMatch(/cat \.env\.secrets/);
		expect(commandsIn(setup)).toContain("rm .env.secrets");
	});

	it("forks with gh when it can, and clones otherwise", () => {
		expect(commandsIn(setup)).toEqual(
			expect.arrayContaining([
				"gh repo fork ascorbic/tack --clone",
				"git clone https://github.com/<you>/tack.git",
				"gh repo sync <you>/tack",
			]),
		);
		expect(AGENT_COMMANDS).toContain("gh repo fork ascorbic/tack --clone");
	});

	it("stops for the user at each browser step", () => {
		const stops = setup.match(/stop and ask (the user|them)/gi) ?? [];
		expect(stops.length).toBeGreaterThanOrEqual(4);
		expect(setup).toMatch(/## 6\. The GitHub App: stop and ask the user/);
		expect(setup).toMatch(/Discussions: Read and write/);
	});

	it("links only to pages the docs have", () => {
		const links = [...setup.matchAll(/\]\((https:\/\/tack\.social[^)\s]*)\)/g)];
		expect(links.length).toBeGreaterThan(10);
		expect(brokenLinks(setup, { pages: docsPages, files: new Set(["/llms.txt"]) })).toEqual([]);
	});

	it("quotes the app as it is", () => {
		const app = ["src/client", "src/server"]
			.flatMap((dir) =>
				readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" })
					.filter((file) => /\.tsx?$/.test(file))
					.map((file) => readFileSync(path.join(ROOT, dir, file), "utf8")),
			)
			.join("\n");
		for (const words of [
			"Tack is ready",
			"All set",
			"Your GitHub App is ready.",
			"Installed. Cards from those repositories now update live.",
			"Tack needs a secret first",
			"This Tack is invite-only",
			"Waiting for the first",
			"Going elsewhere",
			'status: "unconfigured"',
			'status: "unavailable"',
			'status: "configured"',
			"GET /api/setup",
		]) {
			expect(app, words).toContain(words);
		}
		for (const status of ["unconfigured", "unavailable", "configured"]) {
			expect(setup).toContain(`"status":"${status}"`);
		}
	});
});

describe("the copy prompt", () => {
	it("points the agent at setup.md, and says when to stop", () => {
		expect(SETUP_URL).toBe(`${SITE}/setup.md`);
		expect(SETUP_PROMPT).toContain(SETUP_URL);
		expect(SETUP_PROMPT).toMatch(/`gh`/);
		expect(SETUP_PROMPT).toMatch(/stop and ask me/i);
		expect(SETUP_PROMPT.length).toBeLessThan(400);
	});
});

describe("the docs as Markdown", () => {
	const page = `<html><head><meta name="description" content="Run your own."></head><body>
		<nav><a href="/">Tack</a></nav>
		<main><h1 id="_top">Deploy Tack</h1><div class="sl-markdown-content">
		<div class="sl-heading-wrapper level-h2"><h2 id="secrets">Secrets</h2><a class="sl-anchor-link" href="#secrets"><span class="sr-only">Section titled “Secrets”</span></a></div>
		<p>See <a href="/self-hosting/github-app/#webhooks">Webhooks</a>, <a href="#secrets">above</a> and <a href="https://github.com/ascorbic/tack">GitHub</a>.</p>
		<div class="expressive-code"><figure class="frame is-terminal"><figcaption><span class="sr-only">Terminal window</span></figcaption><pre data-language="sh"><code><div class="ec-line"><div class="code"><span>pnpm</span> install</div></div></code></pre><div class="copy"><button data-code="pnpm install\u007fpnpm run deploy"></button></div></figure></div>
		<aside class="starlight-aside starlight-aside--caution"><p class="starlight-aside__title"><svg></svg>Do setup straight away</p><div class="starlight-aside__content"><p>Until then, it's open.</p></div></aside>
		<figure><img src="/_astro/a-light.webp" alt="A board" class="dark:sl-hidden"><img src="/_astro/a-dark.webp" alt="A board" class="light:sl-hidden"></figure>
		<table><thead><tr><th>Action</th><th>Keys</th></tr></thead><tbody><tr><td>Redo</td><td><span class="tk-combo"><kbd>Shift</kbd><kbd>Ctrl</kbd><kbd>Z</kbd></span><span class="tk-or">or</span><span class="tk-combo"><kbd>Ctrl</kbd><kbd>Y</kbd></span></td></tr></tbody></table>
		</div></main></body></html>`;
	const pages = new Set(["/self-hosting/deploy/", "/self-hosting/github-app/"]);
	const { title, description, markdown } = pageFromHtml(page, "/self-hosting/deploy/", (p) =>
		pages.has(p),
	);

	it("keeps the page's words, and leaves out what's only for the eye", () => {
		expect(title).toBe("Deploy Tack");
		expect(description).toBe("Run your own.");
		expect(markdown).toMatch(/^# Deploy Tack\n\n> Run your own\.\n\n## Secrets\n/);
		expect(markdown).not.toContain("Section titled");
		expect(markdown).not.toContain("Terminal window");
		expect(markdown).toContain("```sh\npnpm install\npnpm run deploy\n```");
		expect(markdown).toContain("> **Do setup straight away**\n>\n> Until then, it's open.");
		expect(markdown).toContain("`Shift+Ctrl+Z` or `Ctrl+Y`");
		expect(markdown).toContain("![A board](https://tack.social/_astro/a-light.webp)");
		expect(markdown).not.toContain("a-dark.webp");
	});

	it("links to other pages as their Markdown, and everything else as it is", () => {
		expect(markdown).toContain(
			"[Webhooks](https://tack.social/self-hosting/github-app.md#webhooks)",
		);
		expect(markdown).toContain("[above](https://tack.social/self-hosting/deploy.md#secrets)");
		expect(markdown).toContain("[GitHub](https://github.com/ascorbic/tack)");
		expect(markdownPath("/self-hosting/deploy/")).toBe("/self-hosting/deploy.md");
		expect(markdownPath("/")).toBe("/index.md");
	});

	it("finds links that lead nowhere", () => {
		const site = {
			pages,
			files: new Set(["/setup.md"]),
			ids: (p: string) => new Set(p === "/self-hosting/deploy/" ? ["secrets"] : ["webhooks"]),
		};
		expect(brokenLinks(markdown, site)).toEqual([]);
		expect(
			brokenLinks(
				[
					"[a](https://tack.social/setup.md)",
					"[b](https://tack.social/self-hosting/gone.md)",
					"[c](https://tack.social/self-hosting/deploy.md#nowhere)",
					"[d](https://tack.social/try/)",
					"[e](https://example.com/x)",
				].join(" "),
				site,
			),
		).toEqual([
			"https://tack.social/self-hosting/gone.md",
			"https://tack.social/self-hosting/deploy.md#nowhere (no such section)",
		]);
	});

	it("reads the sidebar's groups in order", () => {
		const sidebar = `<sl-sidebar-pane id="starlight__sidebar"><ul class="top-level">
			<li><details open><summary><span class="group-label"><span class="large">Start here</span></span></summary>
				<ul><li><a href="/start/introduction/"><span>What Tack is</span></a></li></ul></details></li>
			<li><a href="/templates/"><span>Templates</span></a></li>
			<li><details open><summary><span class="group-label"><span class="large">Self-hosting</span></span></summary>
				<ul><li><a href="/self-hosting/deploy/"><span>Deploy Tack</span></a></li></ul></details></li>
		</ul></sl-sidebar-pane>`;
		expect(sidebarFromHtml(sidebar)).toEqual([
			{ label: "Start here", links: [{ label: "What Tack is", path: "/start/introduction/" }] },
			{ label: "Templates", links: [{ label: "Templates", path: "/templates/" }] },
			{ label: "Self-hosting", links: [{ label: "Deploy Tack", path: "/self-hosting/deploy/" }] },
		]);
	});
});

describe("llms.txt", () => {
	it("leads with setup.md, then every page as Markdown, by group", () => {
		const text = llmsTxt({
			title: "Tack",
			description: "A whiteboard.",
			groups: [
				{ label: "Self-hosting", links: [{ label: "Deploy Tack", path: "/self-hosting/deploy/" }] },
			],
			pages: new Map([
				[
					"/self-hosting/deploy/",
					{
						path: "/self-hosting/deploy/",
						title: "Deploy Tack",
						description: "Run it.",
						markdown: "",
					},
				],
			]),
		});
		expect(text).toMatch(/^# Tack\n\n> A whiteboard\.\n/);
		const links = [...text.matchAll(/^- \[[^\]]+\]\(([^)]+)\)/gm)].map(([, href]) => href);
		expect(links[0]).toBe("https://tack.social/setup.md");
		expect(text).toContain(
			"## Self-hosting\n\n- [Deploy Tack](https://tack.social/self-hosting/deploy.md): Run it.",
		);
		expect(text).toContain("## Optional");
	});

	// After `pnpm --filter site build`: what it wrote, and where its links lead.
	it.skipIf(!existsSync(path.join(DIST, "llms.txt")))(
		"was built, with links to built pages",
		() => {
			const built = (file: string) => readFileSync(path.join(DIST, file), "utf8");
			const index = built("llms.txt");
			expect(built("setup.md")).toBe(setup);
			const links = [...index.matchAll(/\]\((https:\/\/tack\.social\/[^)\s]+)\)/g)].map(
				([, href]) => new URL(href!).pathname,
			);
			expect(links[0]).toBe("/setup.md");
			for (const link of links) {
				if (link === "/try/") continue;
				expect(existsSync(path.join(DIST, link)), link).toBe(true);
				if (link.endsWith(".md") && link !== "/setup.md") {
					expect(existsSync(path.join(DIST, link.slice(0, -3), "index.html")), link).toBe(true);
				}
			}
		},
	);
});
