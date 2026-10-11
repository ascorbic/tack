// Whether GitHub's webhooks reach this instance, for the setup page's
// checks (#55): read from the app's webhook settings and its delivery log on
// GitHub, so it needs nothing recorded as deliveries arrive, and it sees the
// ones that never did.

import type { WebhookDelivery, WebhookHealth } from "../../shared/auth.ts";

/** A delivery as `GET /app/hook/deliveries` lists it. */
export interface HookDelivery {
	id: number;
	guid: string;
	delivered_at: string;
	redelivery: boolean;
	status_code: number;
	event: string;
}

/** The app's webhook settings, as `GET /app/hook/config` has them. */
export interface HookConfig {
	url?: string | null;
	content_type?: string;
}

/** Deliveries to read: enough to count recent failures. */
export const DELIVERIES_READ = 50;

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/i;

/** Where an instance at `origin` takes GitHub's webhooks. */
export function webhookUrl(origin: string): string {
	return `${origin.replace(/\/+$/, "")}/webhooks/github`;
}

/** Whether GitHub can't reach an instance at this origin (it's on this machine). */
export function isLocalOrigin(origin: string): boolean {
	try {
		return LOCAL.test(new URL(origin).hostname);
	} catch {
		return false;
	}
}

function sameUrl(a: string, b: string): boolean {
	try {
		const x = new URL(a);
		const y = new URL(b);
		return (
			x.protocol === y.protocol &&
			x.host.toLowerCase() === y.host.toLowerCase() &&
			x.pathname.replace(/\/+$/, "") === y.pathname.replace(/\/+$/, "")
		);
	} catch {
		return false;
	}
}

const arrived = (status: number) => status >= 200 && status < 300;

function reasonFor(status: number): WebhookHealth["reason"] {
	if (status === 0) return "unreachable";
	if (status === 401 || status === 403) return "rejected";
	return "error";
}

/**
 * How the webhook is doing at `origin`, given the app's settings (null when
 * GitHub couldn't be asked) and its deliveries, newest first.
 */
export function assessWebhooks(
	origin: string,
	config: HookConfig | null,
	deliveries: readonly HookDelivery[] | null,
): WebhookHealth {
	const expected = webhookUrl(origin);
	const url = config?.url || null;
	const latest = deliveries?.[0];
	const last: WebhookDelivery | null = latest
		? {
				event: latest.event,
				at: latest.delivered_at,
				status: latest.status_code,
				redelivery: latest.redelivery,
			}
		: null;
	const failed = deliveries?.filter((delivery) => !arrived(delivery.status_code)).length ?? 0;
	const base = { url, expected, last, failed };

	if (isLocalOrigin(origin)) return { ...base, state: "local" };
	if (!config || !deliveries) return { ...base, state: "unknown" };
	if (!url || !sameUrl(url, expected)) return { ...base, state: "elsewhere" };
	if (!latest) return { ...base, state: "waiting" };
	if (arrived(latest.status_code)) return { ...base, state: "ok" };
	return { ...base, state: "failing", reason: reasonFor(latest.status_code) };
}
