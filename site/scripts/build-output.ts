// Turns Astro's static build (dist/) and the demo's AI Worker into
// Cloudflare's Build Output (in .cloudflare/output/), so `cf deploy
// --prebuilt` can deploy them as one Worker with static assets, configured by
// cloudflare.config.ts.
//
// `cf build` would otherwise run its Astro autoconfiguration, which adds the
// Cloudflare adapter for server rendering. The docs are entirely static, so
// this writes the output itself: the site's files as the Worker's assets,
// and as its code only the demo's AI (src/demoAi/, `/try/api/*`), bundled
// into one module by `vp build --mode try-ai` at the repository's root.
import {
	cleanBuildOutputDir,
	getWorkerBundleDir,
	writeAssets,
	writeRootConfig,
	writeWorkerConfig,
} from "@cloudflare/build-output-utils";
import { loadAndParseConfig, registerConfigHooks } from "@cloudflare/config";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const repository = path.resolve(root, "..");
const dist = path.join(root, "dist");
if (!existsSync(path.join(dist, "index.html"))) {
	throw new Error("No dist/index.html: run `astro build` first.");
}

const context = { isPreview: false, mode: "production" };
registerConfigHooks();
const { result } = await loadAndParseConfig(path.join(root, "cloudflare.config.ts"), context);
if (!result.success) {
	throw new Error(`cloudflare.config.ts is invalid: ${result.error.message}`);
}
const { worker, containers: _containers, ...settings } = result.data;
if (!worker) throw new Error("cloudflare.config.ts declares no worker");

// The Worker's code: one module, with nothing to import but the runtime's.
execFileSync("pnpm", ["exec", "vp", "build", "--mode", "try-ai", "--logLevel", "warn"], {
	cwd: repository,
	stdio: "inherit",
});
const bundle = path.join(repository, "dist", "try-ai", "index.js");
if (!existsSync(bundle)) throw new Error("`vp build --mode try-ai` wrote no dist/try-ai/index.js");

await cleanBuildOutputDir(root);
await writeAssets({ root, sourceDirectory: dist });
const bundleDir = getWorkerBundleDir(root);
mkdirSync(bundleDir, { recursive: true });
cpSync(bundle, path.join(bundleDir, "index.js"));
await writeWorkerConfig({
	root,
	config: worker,
	manifest: { type: "complete", mainModule: "index.js", modules: { "index.js": { type: "esm" } } },
});
await writeRootConfig(root, settings, context);
console.log(`Wrote the Build Output for ${worker.name} to .cloudflare/output/`);
