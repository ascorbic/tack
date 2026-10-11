// Writes wrangler.jsonc from cloudflare.config.ts, for the Deploy to
// Cloudflare button (#55), which only reads a Wrangler configuration file to
// see what a Worker needs. Nothing else reads it: `cf` and the Vite plugin
// use cloudflare.config.ts, and Tack has no Wrangler dependency.
//
//   node scripts/wrangler-config.ts          write wrangler.jsonc
//   node scripts/wrangler-config.ts --check  fail if it's out of date
//
// It's converted with the same @cloudflare/config the cf CLI uses (resolved
// through cf, so the two never drift apart). `test/wrangler-config.test.ts`
// fails when the committed file doesn't match cloudflare.config.ts.

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WRANGLER_CONFIG = join(ROOT, "wrangler.jsonc");

interface ConfigModule {
	loadAndParseConfig(
		path: string,
		context: { isPreview: boolean; mode: string },
	): Promise<{ result: { success: boolean; data?: unknown; error?: unknown } }>;
	convertToWranglerConfig(config: unknown): Record<string, unknown>;
}

/** @cloudflare/config as cf has it: looked up from cf's own directory, as Node would. */
async function configModule(): Promise<ConfigModule> {
	const cf = realpathSync(
		dirname(createRequire(join(ROOT, "package.json")).resolve("cf/package.json")),
	);
	for (let dir = cf; ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", "@cloudflare", "config");
		if (existsSync(join(candidate, "package.json"))) {
			const pkg = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as {
				exports: { ".": { import: string } };
			};
			return (await import(
				pathToFileURL(join(candidate, pkg.exports["."].import)).href
			)) as ConfigModule;
		}
		if (dirname(dir) === dir) throw new Error("Couldn't find @cloudflare/config beside cf");
	}
}

const HEADER = `// Generated from cloudflare.config.ts by \`node scripts/wrangler-config.ts\`:
// don't edit it by hand. It's here for the Deploy to Cloudflare button, which
// reads a Wrangler configuration to see what the Worker needs. Tack itself is
// built and deployed with the cf CLI (\`pnpm run deploy\`), from
// cloudflare.config.ts.
`;

/** wrangler.jsonc as it should be, for production. */
export async function wranglerConfig(): Promise<string> {
	const config = await configModule();
	const { result } = await config.loadAndParseConfig(join(ROOT, "cloudflare.config.ts"), {
		isPreview: false,
		mode: "production",
	});
	if (!result.success) {
		throw new Error(`cloudflare.config.ts is invalid: ${JSON.stringify(result.error)}`);
	}
	const wrangler = config.convertToWranglerConfig(result.data);
	// The converter gives an absolute entrypoint; the file is shared.
	if (typeof wrangler.main === "string") wrangler.main = relative(ROOT, wrangler.main);
	return `${HEADER}${JSON.stringify(wrangler, null, "\t")}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const expected = await wranglerConfig();
	if (process.argv.includes("--check")) {
		let current = "";
		try {
			current = readFileSync(WRANGLER_CONFIG, "utf8");
		} catch {}
		if (current !== expected) {
			console.error("wrangler.jsonc is out of date: run `node scripts/wrangler-config.ts`.");
			process.exit(1);
		}
	} else {
		writeFileSync(WRANGLER_CONFIG, expected);
		console.log(`Wrote ${relative(process.cwd(), WRANGLER_CONFIG)}`);
	}
}
