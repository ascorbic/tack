// Runs the built Worker in Miniflare, from Node. `global-setup.ts` builds it
// once per test run; each test file gets its own Miniflare instance.

import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { compatibilityDate, compatibilityFlags } from "../compatibility.ts";
import type { Repo } from "../src/server/repo.ts";

export const BUNDLE = ".cloudflare/output/v0/workers/default/bundle/index.js";

export function startWorker(): Miniflare {
	return new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			scriptPath: BUNDLE,
			compatibilityDate,
			compatibilityFlags,
			durableObjects: {
				Board: { className: "Board", useSQLite: true },
				Repo: { className: "Repo", useSQLite: true },
			},
			bindings: { GITHUB_WEBHOOK_SECRET: "test-secret", GITHUB_TOKEN: "" },
		}),
	);
}

/** An RPC stub for the `Repo` Durable Object with this name. */
export async function repoStub(mf: Miniflare, name: string) {
	const namespace = await mf.getDurableObjectNamespace("Repo");
	return namespace.get(namespace.idFromName(name)) as unknown as DurableObjectStub<Repo>;
}
