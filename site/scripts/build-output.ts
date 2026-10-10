// Turns Astro's static build (dist/) into Cloudflare's Build Output (in
// .cloudflare/output/), so `cf deploy --prebuilt` can deploy it as a Worker
// with static assets and no code, configured by cloudflare.config.ts.
//
// `cf build` would otherwise run its Astro autoconfiguration, which adds the
// Cloudflare adapter for server rendering. The docs are entirely static, so
// this writes the assets-only output the Cloudflare Vite plugin writes for an
// assets-only Worker instead.
import {
	cleanBuildOutputDir,
	writeAssets,
	writeRootConfig,
	writeWorkerConfig,
} from "@cloudflare/build-output-utils";
import { loadAndParseConfig, registerConfigHooks } from "@cloudflare/config";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
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

await cleanBuildOutputDir(root);
await writeAssets({ root, sourceDirectory: dist });
await writeWorkerConfig({ root, config: worker });
await writeRootConfig(root, settings, context);
console.log(`Wrote the Build Output for ${worker.name} to .cloudflare/output/`);
