// The setup page's checklist (#55), pure: each step of getting an instance
// ready (its secret, the GitHub App, webhooks, installations, who can use
// it) and how it stands, in words. Unit-tested in test/setup-checks.test.ts.

import type { AccessSettings, InstallationList, WebhookHealth } from "../../shared/auth.ts";
import { relativeTime } from "../boards/api.ts";

/**
 * How a step stands: `done`; `current`, the next thing to do; `warn`, done
 * but worth a look; `fail`, broken; `waiting`, being checked or waiting on
 * something outside Tack; `todo`, not reached yet.
 */
export type StepTone = "done" | "current" | "warn" | "fail" | "waiting" | "todo";

export interface SetupStep {
	id: "secret" | "app" | "webhooks" | "repositories" | "people";
	label: string;
	detail: string;
	tone: StepTone;
}

/** Something loaded from the server for a check, or on its way, or not. */
export type Loaded<T> =
	| { status: "loading" }
	| { status: "ready"; value: T }
	| { status: "failed" };

/** The first two steps, before an app exists (the rest come after it). */
export function firstSteps(stage: "secret" | "app"): SetupStep[] {
	return [
		stage === "secret"
			? { id: "secret", label: "Secret", detail: "Set TACK_SECRET", tone: "current" }
			: { id: "secret", label: "Secret", detail: "Set", tone: "done" },
		{
			id: "app",
			label: "GitHub App",
			detail: stage === "app" ? "Create it from here" : "Next",
			tone: stage === "app" ? "current" : "todo",
		},
		{ id: "webhooks", label: "Webhooks", detail: "After the app", tone: "todo" },
		{ id: "repositories", label: "Repositories", detail: "Install the app", tone: "todo" },
		{ id: "people", label: "People", detail: "Who can use it", tone: "todo" },
	];
}

/** Every step once the app exists, from what's been checked. */
export function configuredSteps(
	webhooks: Loaded<WebhookHealth>,
	installations: Loaded<InstallationList>,
	access: AccessSettings | null,
): SetupStep[] {
	return [
		{ id: "secret", label: "Secret", detail: "Set", tone: "done" },
		{ id: "app", label: "GitHub App", detail: "Created", tone: "done" },
		webhooksStep(webhooks),
		repositoriesStep(installations),
		peopleStep(access),
	];
}

function webhooksStep(webhooks: Loaded<WebhookHealth>): SetupStep {
	const step = { id: "webhooks", label: "Webhooks" } as const;
	if (webhooks.status === "loading") return { ...step, detail: "Checking…", tone: "waiting" };
	if (webhooks.status === "failed") return { ...step, detail: "Couldn’t check", tone: "warn" };
	const { tone, label } = describeWebhooks(webhooks.value);
	return {
		...step,
		detail: label,
		tone: tone === "ok" ? "done" : tone === "fail" ? "fail" : tone === "warn" ? "warn" : "waiting",
	};
}

function repositoriesStep(installations: Loaded<InstallationList>): SetupStep {
	const step = { id: "repositories", label: "Repositories" } as const;
	if (installations.status === "loading") return { ...step, detail: "Checking…", tone: "waiting" };
	if (installations.status === "failed") return { ...step, detail: "Couldn’t check", tone: "warn" };
	const { installations: list, notInstalled = [] } = installations.value;
	if (list.length === 0) return { ...step, detail: "Not installed yet", tone: "current" };
	const live = list.filter((i) => !i.suspended);
	const repositories = live.reduce((n, i) => n + i.repositories.length + i.more, 0);
	const stuck = list.filter((i) => i.suspended || !i.writable).length;
	const counted = live.some((i) => i.selection === "all")
		? `All of ${live.length === 1 ? live[0]!.account : `${live.length} accounts`}`
		: `${repositories} ${repositories === 1 ? "repository" : "repositories"}`;
	if (stuck > 0) {
		return { ...step, detail: `${count(stuck, "account")} to check`, tone: "warn" };
	}
	if (notInstalled.length > 0) {
		return { ...step, detail: `${notInstalled.length} on boards without it`, tone: "warn" };
	}
	return { ...step, detail: `${counted}, all live`, tone: "done" };
}

function peopleStep(access: AccessSettings | null): SetupStep {
	const step = { id: "people", label: "People" } as const;
	if (!access) return { ...step, detail: "Admins only", tone: "todo" };
	const parts = [
		count(access.admins.length, "admin"),
		access.users.length > 0 ? count(access.users.length, "person", "people") : null,
		access.orgs.length > 0 ? count(access.orgs.length, "org") : null,
	].filter(Boolean);
	if (access.users.length === 0 && access.orgs.length === 0) {
		// Optional: an instance just for its admins works as it is.
		return { ...step, detail: "Optional: only admins so far", tone: "todo" };
	}
	return { ...step, detail: parts.join(" · "), tone: "done" };
}

function count(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * Whether the instance is ready to use: the secret, the app, webhooks
 * arriving and the app installed somewhere. Who else can use it is optional.
 */
export function isReady(steps: readonly SetupStep[]): boolean {
	const tone = (id: SetupStep["id"]) => steps.find((step) => step.id === id)?.tone;
	return (
		tone("secret") === "done" &&
		tone("app") === "done" &&
		tone("webhooks") === "done" &&
		(tone("repositories") === "done" || tone("repositories") === "warn")
	);
}

/** The step to look at first: the first that isn't done. */
export function focusStep(steps: readonly SetupStep[]): SetupStep["id"] | null {
	return (
		steps.find((step) => step.tone === "fail" || step.tone === "current" || step.tone === "warn")
			?.id ?? null
	);
}

export interface WebhookWords {
	tone: "ok" | "warn" | "fail" | "wait" | "off";
	/** A few words, for the checklist and the status pill. */
	label: string;
	/** What's going on. */
	detail: string;
	/** What to do about it, if anything. */
	fix?: string;
	/** Whether the fix is in the app's settings on GitHub. */
	settings?: boolean;
}

/** Whether GitHub's webhooks reach the instance, in words. */
export function describeWebhooks(health: WebhookHealth, now = Date.now()): WebhookWords {
	const when = health.last ? relativeTime(Date.parse(health.last.at), now) : "";
	const event = health.last ? health.last.event.replaceAll("_", " ") : "";
	switch (health.state) {
		case "ok":
			return {
				tone: "ok",
				label: "Arriving",
				detail: `GitHub’s latest delivery (${event}, ${when}) reached Tack.${
					health.failed > 0
						? ` ${count(health.failed, "recent one")} didn’t; Tack asks GitHub to send ${health.failed === 1 ? "it" : "those"} again.`
						: ""
				}`,
			};
		case "waiting":
			return {
				tone: "wait",
				label: "Waiting for the first",
				detail:
					"Nothing’s been delivered yet. GitHub sends a delivery when something happens in a repository the app is installed on, such as an issue being opened.",
				fix: "If something has happened and nothing’s arrived, check the webhook is Active in the app’s settings.",
				settings: true,
			};
		case "failing":
			if (health.reason === "unreachable") {
				return {
					tone: "fail",
					label: "Not arriving",
					detail: `GitHub couldn’t reach ${health.url ?? health.expected} (${when}).`,
					fix: "Check this instance answers at that address: a custom domain that doesn’t resolve yet, or a Worker that isn’t deployed, look like this.",
				};
			}
			if (health.reason === "rejected") {
				return {
					tone: "fail",
					label: "Refused",
					detail: `Tack refused GitHub’s latest delivery (${when}): its signature didn’t match.`,
					fix: "The webhook secret in the app’s settings has to be the one Tack was set up with. If you changed it there, set the same value as the Worker’s GITHUB_WEBHOOK_SECRET.",
					settings: true,
				};
			}
			return {
				tone: "fail",
				label: "Failing",
				detail: `Tack answered GitHub’s latest delivery with an error (${health.last?.status ?? "?"}, ${when}).`,
				fix: "The Worker’s logs say why: look for webhook.failed events.",
			};
		case "elsewhere":
			return {
				tone: "warn",
				label: "Going elsewhere",
				detail: health.url
					? `The app sends its webhooks to ${health.url}, not to this instance (${health.expected}).`
					: `The app has no webhook address; this instance takes them at ${health.expected}.`,
				fix: "If this is the instance’s address now, change the Webhook URL in the app’s settings to match.",
				settings: true,
			};
		case "local":
			return {
				tone: "off",
				label: "Off while local",
				detail:
					"GitHub can’t reach an instance running on this machine, so the app’s webhooks start switched off. Cards still load; they update live once Tack has a public address.",
				fix: "To try a delivery locally, send one with scripts/send-webhook.ts.",
			};
		case "unknown":
			return {
				tone: "off",
				label: "Couldn’t check",
				detail: "GitHub didn’t say how deliveries are going. Try again in a moment.",
			};
	}
}

/** A new random secret, for `TACK_SECRET`: 32 bytes, base64. */
export function generateSecret(
	random: (bytes: Uint8Array<ArrayBuffer>) => void = (b) => crypto.getRandomValues(b),
): string {
	const bytes = new Uint8Array(32);
	random(bytes);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}
