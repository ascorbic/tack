// Identity and setup types shared by the server's `/api/me` and `/api/setup`
// routes and the client.

import type { ForgeHost } from "./refs.ts";

export interface Person {
	/** GitHub user id (negative for dev sign-in users). */
	id: number;
	login: string;
	name: string | null;
	avatarUrl: string;
}

/**
 * Whether people can sign in: "ready"; "unconfigured" before the GitHub App
 * is set up; "unavailable" without `TACK_SECRET` (e.g. on Previews).
 */
export type SignInStatus = "ready" | "unconfigured" | "unavailable";

/** `GET /api/me` */
export interface Me {
	viewer: Person | null;
	admin: boolean;
	/** Whether this viewer may open boards. Everyone may until the app is set up. */
	allowed: boolean;
	signIn: SignInStatus;
	/** Whether `/auth/dev` fake sign-in is on (local development only). */
	devAuth: boolean;
	/**
	 * The forge hosts this instance serves besides GitHub (#65): the
	 * defaults and any it's configured with, for reading links to them.
	 * Absent for people who aren't allowed here (they keep the defaults).
	 */
	forges?: ForgeHost[];
}

/** Who may use the instance, besides its admins. Logins are lowercase. */
export interface AccessList {
	users: string[];
	orgs: string[];
}

export interface AccessSettings extends AccessList {
	admins: Person[];
}

/** The parts of a GitHub App manifest the setup page reads or edits. */
export interface AppManifest {
	name: string;
	hook_attributes: { url: string; active: boolean };
	[key: string]: unknown;
}

/** `GET /api/setup` */
export type SetupInfo =
	| { status: "unavailable" }
	| {
			status: "unconfigured";
			/** Echoed back by GitHub to `/setup/callback`. */
			state: string;
			/** The GitHub App manifest, to POST to GitHub. */
			manifest: AppManifest;
	  }
	| {
			status: "configured";
			app: { name: string; slug: string; htmlUrl: string; installUrl: string };
			viewer: Person | null;
			admin: boolean;
			/** Only for admins. */
			access: AccessSettings | null;
			/** AI suggestions (#73). */
			ai?: AiStatus;
	  };

/**
 * AI suggestions (#73): naming stacks and grouping stickies. On by default
 * with Workers AI (`TACK_AI` in cloudflare.config.ts, `workers-ai`); off when
 * it's set to `off`, unavailable when the Worker has no AI binding to ask.
 */
export interface AiStatus {
	state: "on" | "off" | "unavailable";
	/** What answers while it's on: Workers AI, or local development's stand-in. */
	provider: "workers-ai" | "fake" | null;
	/** The model it asks. */
	model: string;
}

/**
 * Where the GitHub App is installed, for the setup page
 * (`GET /api/setup/installations`, admins only): so nobody finds out
 * mid-session that a repository's cards can't be pushed.
 */
export interface InstallationSummary {
	id: number;
	account: string;
	accountType: "User" | "Organization";
	/** Every repository the account has (now and later), or the ones chosen. */
	selection: "all" | "selected";
	/** Suspended by the account: no updates, no writes. */
	suspended: boolean;
	/**
	 * Whether it may write issues and pull requests: the account accepted
	 * the permissions Tack asks for. Without that its cards update live
	 * but can't be pushed to.
	 */
	writable: boolean;
	/** Where the account manages it on GitHub. */
	settingsUrl: string | null;
	repositories: { name: string; private: boolean }[];
	/** How many more it covers than are listed. */
	more: number;
}

export interface InstallationList {
	installations: InstallationSummary[];
	/**
	 * Repositories Tack has looked for the app on (cards on boards, mostly)
	 * and found it isn't installed: newest first, at most `NOT_INSTALLED_LIMIT`.
	 * Public ones still work, read-only and not live. Absent from older servers.
	 */
	notInstalled?: string[];
}

/** How many uninstalled repositories `/api/setup/installations` lists. */
export const NOT_INSTALLED_LIMIT = 50;

/**
 * `GET /api/setup/webhooks` (admins only): whether GitHub's webhooks reach
 * this instance, from the app's webhook settings and delivery log on GitHub.
 *
 * - `ok`: the latest delivery arrived and Tack took it
 * - `waiting`: nothing delivered yet (GitHub sends one when something
 *   happens in a repository the app's installed on)
 * - `failing`: the latest delivery didn't arrive or was refused (`reason`)
 * - `elsewhere`: the app sends its webhooks to another address than this
 *   instance's (`url` versus `expected`)
 * - `local`: this instance is on this machine, where GitHub can't reach it
 * - `unknown`: GitHub couldn't be asked
 */
export interface WebhookHealth {
	state: "ok" | "waiting" | "failing" | "elsewhere" | "local" | "unknown";
	/** Where the app sends its webhooks, from its settings on GitHub. */
	url: string | null;
	/** Where this instance takes them. */
	expected: string;
	/** The newest delivery GitHub has a record of. */
	last: WebhookDelivery | null;
	/** How many of the recent deliveries never arrived or were refused, counting redeliveries. */
	failed: number;
	/** Why the latest one failed: GitHub couldn't connect, Tack refused it (signature), or Tack failed. */
	reason?: "unreachable" | "rejected" | "error";
}

export interface WebhookDelivery {
	/** The event, e.g. `issues`. */
	event: string;
	/** When GitHub sent it, ISO 8601. */
	at: string;
	/** What Tack answered; 0 when GitHub couldn't connect. */
	status: number;
	redelivery: boolean;
}

/** `PUT /api/setup/access` */
export interface AccessUpdateRequest {
	users: string[];
	orgs: string[];
	/** Logins; each must have signed in at least once. */
	admins: string[];
}

export type AccessUpdateResponse =
	| { ok: true; access: AccessSettings }
	| { ok: false; error: "invalid_login" | "unknown_admins" | "no_admins"; logins: string[] };

/** Where to POST the manifest to create the app: a personal account, or an organisation. */
export function manifestFormAction(org: string | null, state: string): string {
	const base = org
		? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
		: "https://github.com/settings/apps/new";
	return `${base}?state=${encodeURIComponent(state)}`;
}
