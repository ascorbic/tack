// The public demo at /try/ (#75): the app's playground built as a static page
// of its own (`vp build --mode try` at the repository's root, see the root
// vite.config.ts), copied into the docs site's build so the docs deploy
// publishes it. Its `_headers` rules (a Content-Security-Policy that lets it
// reach nothing but its own files) join the site's.
//
// Runs after `astro build` and before scripts/build-output.ts.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const site = path.resolve(import.meta.dirname, "..");
const root = path.resolve(site, "..");
const built = path.join(root, "dist", "try");
const dist = path.join(site, "dist");
const target = path.join(dist, "try");

if (!existsSync(path.join(dist, "index.html"))) {
	throw new Error("No dist/index.html: run `astro build` first.");
}

execFileSync("pnpm", ["exec", "vp", "build", "--mode", "try"], { cwd: root, stdio: "inherit" });
if (!existsSync(path.join(built, "index.html"))) {
	throw new Error(`The demo's build wrote no ${path.relative(root, built)}/index.html`);
}

rmSync(target, { recursive: true, force: true });
cpSync(built, target, { recursive: true });

// One `_headers` file for the whole site, at its root, with the demo's rules
// (which start with a comment saying so) in place of any from a run before.
const rules = readFileSync(path.join(target, "_headers"), "utf8");
rmSync(path.join(target, "_headers"));
const headers = path.join(dist, "_headers");
const marker = rules.split("\n")[0] ?? "";
const existing = existsSync(headers)
	? readFileSync(headers, "utf8").split(marker)[0]!.trimEnd()
	: "";
writeFileSync(headers, existing ? `${existing}\n\n${rules}` : rules);

console.log(`Copied the demo to ${path.relative(site, target)}/`);
