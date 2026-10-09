// Identity and setup types shared by the server's `/api/me` and `/api/setup`
// routes and the client.

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
	  };

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
