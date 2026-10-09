import { log } from "../log.ts";
import { appJwt } from "./tokens.ts";

// GitHub doesn't retry failed webhook deliveries, so a cron asks it to. The
// app's delivery log says which deliveries failed; each one is redelivered a
// few times at most, and a delivery that eventually succeeded is left alone.
// Redeliveries reuse the delivery id, which `Repo` dedupes on. This needs no
// state of its own: the delivery log records every attempt.

const API = "https://api.github.com";

export interface RedeliveryOptions {
	/** Only deliveries this recent are considered. */
	windowMs?: number;
	/** Attempts per delivery, including the original, before giving up. */
	maxAttempts?: number;
	/** Pages of 100 deliveries to read, at most. */
	maxPages?: number;
	now?: number;
}

export type RedeliveryReport =
	| { status: "skipped"; reason: string }
	| { status: "done"; checked: number; failed: number; redelivered: string[]; gaveUp: string[] }
	| { status: "error"; reason: string };

interface HookDelivery {
	id: number;
	guid: string;
	delivered_at: string;
	redelivery: boolean;
	status_code: number;
	event: string;
}

/**
 * Redeliver recent webhook deliveries that failed, if a GitHub App is
 * configured. Logs the outcome as `github.redelivery`, or
 * `github.redelivery.failed`.
 */
export async function redeliverFailedWebhooks(
	env: Env,
	options?: RedeliveryOptions,
): Promise<RedeliveryReport> {
	let report: RedeliveryReport;
	try {
		const jwt = await appJwt(env);
		report = jwt
			? await redeliver(jwt, options)
			: { status: "skipped", reason: "no GitHub App configured" };
	} catch (error) {
		log.error("github.redelivery.failed", { error });
		return { status: "error", reason: String(error) };
	}
	if (report.status === "error") log.error("github.redelivery.failed", { reason: report.reason });
	else if (report.status === "skipped") log.info("github.redelivery", report);
	else {
		log.info("github.redelivery", {
			status: report.status,
			checked: report.checked,
			failed: report.failed,
			redelivered: report.redelivered.length,
			gaveUp: report.gaveUp.length,
		});
	}
	return report;
}

/**
 * Our endpoint failing (5xx) or GitHub not reaching it (0) is worth another
 * try. 4xx responses were deliberate rejections, such as bad signatures.
 */
function failed(delivery: HookDelivery): boolean {
	return delivery.status_code === 0 || delivery.status_code >= 500;
}

function succeeded(delivery: HookDelivery): boolean {
	return delivery.status_code >= 200 && delivery.status_code < 300;
}

export async function redeliver(
	jwt: string,
	{
		windowMs = 6 * 60 * 60_000,
		maxAttempts = 3,
		maxPages = 10,
		now = Date.now(),
	}: RedeliveryOptions = {},
): Promise<RedeliveryReport> {
	const headers = {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${jwt}`,
		"user-agent": "tack",
		"x-github-api-version": "2022-11-28",
	};
	const since = now - windowMs;

	// Newest first. Every attempt at a delivery shares its guid.
	const attempts = new Map<string, HookDelivery[]>();
	let url: string | null = `${API}/app/hook/deliveries?per_page=100`;
	for (let page = 0; url && page < maxPages; page++) {
		const response: Response = await fetch(url, { headers });
		if (!response.ok) {
			return { status: "error", reason: `listing deliveries: ${response.status}` };
		}
		const deliveries = await response.json<HookDelivery[]>();
		for (const delivery of deliveries) {
			if (Date.parse(delivery.delivered_at) < since) continue;
			let list = attempts.get(delivery.guid);
			if (!list) attempts.set(delivery.guid, (list = []));
			list.push(delivery);
		}
		const oldest = deliveries.at(-1);
		url = oldest && Date.parse(oldest.delivered_at) >= since ? nextLink(response) : null;
	}

	const redelivered: string[] = [];
	const gaveUp: string[] = [];
	let failedCount = 0;
	for (const [guid, list] of attempts) {
		const latest = list[0];
		if (!latest || list.some(succeeded) || !failed(latest)) continue;
		failedCount++;
		if (list.length >= maxAttempts) {
			gaveUp.push(guid);
			continue;
		}
		const response = await fetch(`${API}/app/hook/deliveries/${latest.id}/attempts`, {
			method: "POST",
			headers,
		});
		if (response.ok) redelivered.push(guid);
		else {
			log.warn("github.redelivery.failed", {
				guid,
				delivery: latest.id,
				event: latest.event,
				status: response.status,
			});
		}
	}

	return {
		status: "done",
		checked: attempts.size,
		failed: failedCount,
		redelivered,
		gaveUp,
	};
}

function nextLink(response: Response): string | null {
	const link = response.headers.get("link") ?? "";
	return /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
}
