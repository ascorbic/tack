// Asks AI Search to read the docs again: a sync job on the `tack-docs`
// instance (the docs' Ask, see "The docs' Ask" in AGENTS.md). The site's
// `deploy` runs it last, with `--after-deploy`.
//
// A sync can't start while one is running or just after one (AI Search's
// cooldown: 7020 `sync_in_cooldown`, a 429): then a sync is already reading
// the docs, or will on its schedule, so that's skipped, not a failure.
// Transient errors (5xx, the network) are tried again. After a deploy, a sync
// that still won't start only warns: the deploy itself has worked, and the
// instance syncs on its own every 6 hours anyway.
import { spawnSync } from "node:child_process";
import path from "node:path";

const site = path.resolve(import.meta.dirname, "..");
const afterDeploy = process.argv.includes("--after-deploy");
const ARGS = [
	"exec",
	"cf",
	"ai-search",
	"jobs",
	"create",
	"tack-docs",
	"--namespace",
	"default",
	"--description",
	afterDeploy ? "Docs deployed" : "Reindex",
];
const COOLDOWN = /7020|sync_in_cooldown|cooldown|\b429\b|too many requests/i;
const TRANSIENT =
	/\b5\d\d\b|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network|timed? ?out/i;
const WAITS = [5_000, 15_000];

function done(code: 0 | 1, message: string): never {
	(code === 0 ? console.log : console.error)(message);
	process.exit(code);
}

for (let attempt = 0; ; attempt++) {
	const run = spawnSync("pnpm", ARGS, { cwd: site, encoding: "utf8" });
	const output = `${run.stdout ?? ""}${run.stderr ?? ""}${run.error ? String(run.error) : ""}`;
	if (run.status === 0) {
		const id = /"id":\s*"([^"]+)"/.exec(output)?.[1];
		done(0, `AI Search is reading the docs again (sync job ${id ?? "started"}).`);
	}
	if (COOLDOWN.test(output)) {
		done(0, "AI Search is already syncing the docs (or just has): skipped starting another.");
	}
	const wait = WAITS[attempt];
	if (TRANSIENT.test(output) && wait !== undefined) {
		console.warn(`Couldn't start an AI Search sync (transient), trying again in ${wait / 1000}s…`);
		await new Promise((resolve) => setTimeout(resolve, wait));
		continue;
	}
	const advice =
		"Its own sync, every 6 hours, will pick up the changes; to start one now: " +
		"`CLOUDFLARE_ACCOUNT_ID=… pnpm --filter site run reindex`.";
	console.error(output.trim());
	if (afterDeploy)
		done(0, `Warning: the docs deployed, but AI Search's sync didn't start. ${advice}`);
	done(1, `AI Search's sync didn't start. ${advice}`);
}
