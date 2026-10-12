// /setup.md: how a coding agent sets up someone's own Tack (setup.md beside
// this file), with the facts that change (Node.js and pnpm versions, the
// Worker's name) read from the repository, and checks that keep it honest:
// its commands are the docs' own, its `pnpm run` scripts exist, and what it
// says to change in cloudflare.config.ts is there. Links are checked against
// the built site by scripts/agents.ts, and against the docs by the tests.
import { readFileSync } from "node:fs";
import path from "node:path";
import { SITE } from "./pages.ts";

export const SETUP_TEMPLATE = path.join(import.meta.dirname, "setup.md");

/**
 * Commands setup.md runs that the docs don't, because they're for an agent
 * finding its way: checking versions and logins, forking with `gh`, and
 * looking at the instance. Each is checked some other way (`cf` ones against
 * `cf --help` in the tests); a command that's in neither this list nor the
 * docs fails the build.
 */
export const AGENT_COMMANDS = [
	"node --version",
	"pnpm --version",
	"git --version",
	"gh --version",
	"gh repo fork ascorbic/tack --clone",
	"cd tack",
	"pnpm exec cf auth whoami",
	"rm .env.secrets",
	"curl -s https://<instance>/api/setup",
	"gh repo sync <you>/tack",
	"git pull",
	"git pull upstream main",
	"git push",
];

export interface SetupFacts {
	/** The oldest Node.js major version, from `engines.node`. */
	node: string;
	/** pnpm's exact version, from `packageManager`. */
	pnpm: string;
	/** The Worker's name, `NAME` in cloudflare.config.ts. */
	name: string;
	scripts: Record<string, string>;
	config: string;
}

/** What setup.md says that comes from the repository at `root`. */
export function setupFacts(root: string): SetupFacts {
	const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
		engines?: { node?: string };
		packageManager?: string;
		scripts?: Record<string, string>;
	};
	const config = readFileSync(path.join(root, "cloudflare.config.ts"), "utf8");
	const node = /^>=\s*(\d+)/.exec(pkg.engines?.node ?? "")?.[1];
	const pnpm = /^pnpm@(\d+\.\d+\.\d+)/.exec(pkg.packageManager ?? "")?.[1];
	const name = /^const NAME = "([^"]+)";$/m.exec(config)?.[1];
	if (!node) throw new Error('package.json has no `engines.node` like ">=22"');
	if (!pnpm) throw new Error('package.json has no `packageManager` like "pnpm@10.0.0"');
	if (!name) throw new Error('cloudflare.config.ts has no `const NAME = "…";`');
	return { node, pnpm, name, scripts: pkg.scripts ?? {}, config };
}

/** setup.md, its placeholders (`{{name}}`) filled in. */
export function renderSetup(template: string, facts: SetupFacts): string {
	const values: Record<string, string> = {
		site: SITE,
		node: facts.node,
		pnpm: facts.pnpm,
		pnpmMajor: facts.pnpm.split(".")[0]!,
		name: facts.name,
	};
	return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
		const value = values[key];
		if (value === undefined) throw new Error(`setup.md has an unknown placeholder, {{${key}}}`);
		return value;
	});
}

const FENCE = /^ *```[\w-]*\n([\s\S]*?)^ *```/gm;

/** Every command in a Markdown file's code blocks, one a line, without comments. */
export function commandsIn(markdown: string): string[] {
	return [...markdown.matchAll(FENCE)].flatMap(([, body]) =>
		body!
			.split("\n")
			.map((line) => line.replace(/(^|\s)#\s.*$/, "").trim())
			.filter(Boolean),
	);
}

/** Commands the docs give: in code blocks and in inline code, with `<placeholders>` matching anything. */
export function docsCommands(sources: string[]): RegExp[] {
	const lines = sources.flatMap((source) => [
		...commandsIn(source),
		...[...source.matchAll(/`([^`\n]+)`/g)].map(([, code]) => code!.trim()),
	]);
	return [...new Set(lines)].map(
		(line) =>
			new RegExp(
				`^${line
					.split(/(<[^>]+>)/)
					.map((part) =>
						part.startsWith("<") ? "\\S+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
					)
					.join("")}$`,
			),
	);
}

/** `{{site}}` links in setup.md, as paths on the site: `/self-hosting/deploy.md#secrets`. */
export function siteLinks(markdown: string): string[] {
	return [...markdown.matchAll(/\]\((https:\/\/[^)\s]+)\)/g)]
		.map(([, href]) => new URL(href!))
		.filter((url) => url.origin === SITE)
		.map((url) => `${url.pathname}${url.hash}`);
}

/** What's wrong with setup.md (rendered), as sentences: none, if it's right. */
export function setupProblems(markdown: string, facts: SetupFacts, docs: string[]): string[] {
	const problems: string[] = [];
	if (/\{\{\w+\}\}/.test(markdown)) problems.push("A placeholder wasn't filled in");

	const known = docsCommands(docs);
	for (const command of commandsIn(markdown)) {
		if (AGENT_COMMANDS.includes(command)) continue;
		if (!known.some((pattern) => pattern.test(command))) {
			problems.push(`\`${command}\` is in neither the docs nor AGENT_COMMANDS`);
		}
	}

	for (const [, script] of markdown.matchAll(/pnpm run ([\w:-]+)/g)) {
		if (!(script! in facts.scripts))
			problems.push(`There's no \`${script}\` script in package.json`);
	}

	// What it says to change in cloudflare.config.ts.
	if (!/^\s*TACK_AI: bindings\.text\(.*"on"\),$/m.test(facts.config)) {
		problems.push('cloudflare.config.ts has no `TACK_AI` line ending in `"on"` to turn off');
	}
	if (!/^const EMAIL_FROM = "";$/m.test(facts.config)) {
		problems.push('cloudflare.config.ts has no empty `const EMAIL_FROM = "";`');
	}
	return problems;
}
