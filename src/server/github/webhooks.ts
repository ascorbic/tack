// GitHub webhook plumbing that belongs to the app rather than to cards:
// verifying signatures with the app's stored secret, and keeping track of
// installations.

import { verifySignature } from "../forges/hmac.ts";
import type { InstallationPayload } from "../instance.ts";
import { instance } from "../namespaces.ts";

// The app's webhook secret never changes once it's set, so each isolate
// fetches it once.
let stored: string | null = null;

async function storedSecret(env: Env): Promise<string | null> {
	if (!env.TACK_SECRET) return null;
	stored ??= await instance(env).webhookSecret();
	return stored;
}

/**
 * Check a delivery's signature against the app's stored webhook secret,
 * falling back to `GITHUB_WEBHOOK_SECRET` (for instances set up by hand).
 */
export async function verifyWebhook(
	env: Env,
	body: string,
	signature: string | null,
): Promise<"valid" | "invalid" | "unconfigured"> {
	const secrets = [await storedSecret(env), env.GITHUB_WEBHOOK_SECRET].filter(
		(secret): secret is string => Boolean(secret),
	);
	if (secrets.length === 0) return "unconfigured";
	for (const secret of secrets) {
		if (await verifySignature(secret, body, signature)) return "valid";
	}
	return "invalid";
}

export const INSTALLATION_EVENTS = new Set(["installation", "installation_repositories"]);

/**
 * An installation event, for the Instance to keep installations current.
 * Only bodies that are installation events count: the event name is an
 * unsigned header, and other events' payloads carry an `installation` too
 * (a replayed `issues` "deleted" mustn't uninstall anything). Each body
 * counts once (`digest`, see `digestOf`).
 */
export async function installationEvent(
	env: Env,
	event: string,
	body: string,
	digest: string,
): Promise<"processed" | "duplicate" | "ignored"> {
	if (!env.TACK_SECRET) return "ignored";
	const payload = JSON.parse(body) as InstallationPayload & { repository?: unknown };
	const fits =
		payload.installation?.account !== undefined &&
		payload.repository === undefined &&
		(event === "installation" ||
			Array.isArray(payload.repositories_added) ||
			Array.isArray(payload.repositories_removed));
	if (!fits) return "ignored";
	return instance(env).installationEvent(event, payload, digest);
}
