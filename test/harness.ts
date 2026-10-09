// Runs the built Worker in Miniflare, from Node. `global-setup.ts` builds it
// once per test run; each test file gets its own Miniflare instance.

import { Miniflare, type Request, type Response, convertV4MiniflareOptions } from "miniflare";
import { compatibilityDate, compatibilityFlags } from "../compatibility.ts";
import type { Board } from "../src/server/board.ts";
import type { Instance } from "../src/server/instance.ts";
import type { Repo } from "../src/server/repo.ts";

export const BUNDLE = ".cloudflare/output/v0/workers/default/bundle/index.js";

/** The `TACK_SECRET` test Workers run with, unless overridden. */
export const TACK_SECRET = "test-tack-secret";

export interface WorkerOptions {
	/** Extra bindings, or overrides (e.g. `{ TACK_SECRET: "" }` to run like a Preview). */
	bindings?: Record<string, string>;
	/** Turn on `/auth/dev` fake sign-in (`TACK_DEV_AUTH=1`), for `signIn()`. */
	devAuth?: boolean;
	/** Handles every outbound `fetch`, e.g. to fake GitHub (see `fake-github.ts`). */
	outboundService?: (request: Request) => Response | Promise<Response>;
	/** Keep Durable Object storage here, so a test can restart the Worker. */
	persist?: string;
}

export function startWorker(options: WorkerOptions = {}): Miniflare {
	return new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			scriptPath: BUNDLE,
			compatibilityDate,
			compatibilityFlags,
			durableObjects: {
				Board: { className: "Board", useSQLite: true },
				Repo: { className: "Repo", useSQLite: true },
				Instance: { className: "Instance", useSQLite: true },
			},
			bindings: {
				GITHUB_WEBHOOK_SECRET: "test-secret",
				GITHUB_TOKEN: "",
				TACK_SECRET,
				...(options.devAuth ? { TACK_DEV_AUTH: "1" } : {}),
				...options.bindings,
			},
			...(options.outboundService ? { outboundService: options.outboundService } : {}),
			...(options.persist ? { resourcePersistencePath: options.persist } : {}),
		}),
	);
}

/** An RPC stub for the `Repo` Durable Object with this name. */
export async function repoStub(mf: Miniflare, name: string) {
	const namespace = await mf.getDurableObjectNamespace("Repo");
	return namespace.get(namespace.idFromName(name)) as unknown as DurableObjectStub<Repo>;
}

/** An RPC stub for the singleton `Instance` Durable Object. */
export async function instanceStub(mf: Miniflare) {
	const namespace = await mf.getDurableObjectNamespace("Instance");
	return namespace.get(namespace.idFromName("instance")) as unknown as DurableObjectStub<Instance>;
}

/**
 * Sign in as a fake GitHub user through `/auth/dev` (start the Worker with
 * `{ devAuth: true }`), returning a `Cookie` header value to send with
 * requests. By default they're also added to the instance allowlist.
 */
export async function signIn(
	mf: Miniflare,
	login: string,
	options: { name?: string; admin?: boolean; allowed?: boolean; orgs?: string[] } = {},
): Promise<string> {
	const url = new URL("http://localhost/auth/dev");
	url.searchParams.set("login", login);
	if (options.name) url.searchParams.set("name", options.name);
	if (options.admin) url.searchParams.set("admin", "1");
	if (options.allowed ?? true) url.searchParams.set("allow", "1");
	if (options.orgs) url.searchParams.set("orgs", options.orgs.join(","));
	const response = await mf.dispatchFetch(url.toString(), { redirect: "manual" });
	const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
	if (response.status !== 302 || !cookie) {
		throw new Error(
			`Dev sign-in failed (${response.status}). Start the Worker with { devAuth: true }.`,
		);
	}
	return cookie;
}

/** An RPC stub for the `Board` Durable Object with this name, started. */
export async function boardStub(mf: Miniflare, name: string) {
	const namespace = await mf.getDurableObjectNamespace("Board");
	const stub = namespace.get(namespace.idFromName(name)) as unknown as DurableObjectStub<Board>;
	// partyserver starts a server (loading its document) on its first named call.
	await stub.setName(name);
	return stub;
}
