import { useState } from "react";
import type {
	AccessUpdateResponse,
	InstallationSummary,
	Me,
	Person,
	SetupInfo,
} from "../../shared/auth.ts";
import { NotAllowedPage, SignInPage } from "../auth/AccessGate.tsx";
import { AccountMenu, SignInButton } from "../auth/AccountMenu.tsx";
import { personUser } from "../auth/me.ts";
import { AccessEditor, SetupView } from "../auth/SetupPage.tsx";
import { Avatar } from "../People.tsx";
import type { User } from "../presence.ts";
import { ThemeToggle } from "../ThemeToggle.tsx";

// Every sign-in, access and setup state, for iterating on them without a
// GitHub App. `/play/auth`.

const OCTOCAT: Person = {
	id: 583231,
	login: "octocat",
	name: "The Octocat",
	avatarUrl: "https://github.com/octocat.png?size=96",
};
const PRIYA: Person = { id: 4021, login: "priya-s", name: "Priya Shah", avatarUrl: "" };
const GUEST: User = { name: "Curious Otter", color: "#1f7a6b" };

const base: Me = { viewer: null, admin: false, allowed: true, signIn: "ready", devAuth: false };

const MENUS: { label: string; me: Me; user: User }[] = [
	{ label: "Admin", me: { ...base, viewer: OCTOCAT, admin: true }, user: personUser(OCTOCAT) },
	{ label: "Signed in, no avatar", me: { ...base, viewer: PRIYA }, user: personUser(PRIYA) },
	{ label: "Guest", me: base, user: GUEST },
	{ label: "Guest, before setup", me: { ...base, signIn: "unconfigured" }, user: GUEST },
	{ label: "Guest, on a preview", me: { ...base, signIn: "unavailable" }, user: GUEST },
	{
		label: "Guest, dev sign-in",
		me: { ...base, signIn: "unconfigured", devAuth: true },
		user: GUEST,
	},
];

const MANIFEST = {
	name: "Tack (localhost)",
	hook_attributes: { url: "http://localhost:5173/webhooks/github", active: false },
};

const ACCESS = {
	users: ["mallory", "trent"],
	orgs: ["acme"],
	admins: [OCTOCAT, PRIYA],
};

const APP = {
	name: "Tack (tack.example.com)",
	slug: "tack-example",
	htmlUrl: "https://github.com/apps/tack-example",
	installUrl: "https://github.com/apps/tack-example/installations/new",
};

const INSTALLATIONS: InstallationSummary[] = [
	{
		id: 1,
		account: "emdash-cms",
		accountType: "Organization",
		selection: "selected",
		suspended: false,
		writable: true,
		settingsUrl: "https://github.com/organizations/emdash-cms/settings/installations/1",
		repositories: [
			{ name: "emdash-cms/docs", private: false },
			{ name: "emdash-cms/emdash", private: false },
			{ name: "emdash-cms/roadmap", private: true },
		],
		more: 0,
	},
	{
		id: 2,
		account: "lovell",
		accountType: "User",
		selection: "selected",
		suspended: false,
		writable: false,
		settingsUrl: "https://github.com/settings/installations/2",
		repositories: [{ name: "lovell/sharp", private: false }],
		more: 0,
	},
	{
		id: 3,
		account: "acme",
		accountType: "Organization",
		selection: "all",
		suspended: true,
		writable: true,
		settingsUrl: null,
		repositories: [],
		more: 0,
	},
];

const installed = () => Promise.resolve(INSTALLATIONS);
const nowhere = () => Promise.resolve([]);
const unreachable = () => Promise.reject(new Error("GitHub is down"));

const SETUPS: {
	label: string;
	info: SetupInfo;
	params?: string;
	installations?: () => Promise<InstallationSummary[]>;
}[] = [
	{ label: "No TACK_SECRET", info: { status: "unavailable" } },
	{ label: "Fresh instance", info: { status: "unconfigured", state: "demo", manifest: MANIFEST } },
	{
		label: "Fresh instance, setup failed",
		info: { status: "unconfigured", state: "demo", manifest: MANIFEST },
		params: "error=state",
	},
	{
		label: "Just created",
		params: "created=1",
		installations: nowhere,
		info: {
			status: "configured",
			app: APP,
			viewer: OCTOCAT,
			admin: true,
			access: { users: [], orgs: [], admins: [OCTOCAT] },
		},
	},
	{
		label: "Installed: one read-only, one suspended",
		installations: installed,
		info: {
			status: "configured",
			app: APP,
			viewer: OCTOCAT,
			admin: true,
			access: { users: [], orgs: ["emdash-cms"], admins: [OCTOCAT] },
		},
	},
	{
		label: "Installed, GitHub unreachable",
		installations: unreachable,
		info: {
			status: "configured",
			app: APP,
			viewer: OCTOCAT,
			admin: true,
			access: { users: [], orgs: [], admins: [OCTOCAT] },
		},
	},
	{
		label: "Signed out",
		info: {
			status: "configured",
			app: {
				name: "Tack (tack.example.com)",
				slug: "tack-example",
				htmlUrl: "https://github.com/apps/tack-example",
				installUrl: "https://github.com/apps/tack-example/installations/new",
			},
			viewer: null,
			admin: false,
			access: null,
		},
	},
];

/** Saves after a beat; adding "ghost" as an admin fails like the server would. */
async function fakeSave(draft: {
	users: string[];
	orgs: string[];
	admins: string[];
}): Promise<AccessUpdateResponse> {
	await new Promise((resolve) => setTimeout(resolve, 700));
	if (draft.admins.length === 0) return { ok: false, error: "no_admins", logins: [] };
	if (draft.admins.includes("ghost")) {
		return { ok: false, error: "unknown_admins", logins: ["ghost"] };
	}
	const known = new Map(ACCESS.admins.map((admin) => [admin.login, admin]));
	return {
		ok: true,
		access: {
			users: [...draft.users].sort(),
			orgs: [...draft.orgs].sort(),
			admins: draft.admins.map(
				(login, i) => known.get(login) ?? { id: 9000 + i, login, name: null, avatarUrl: "" },
			),
		},
	};
}

export default function AuthGallery() {
	const [motion, setMotion] = useState(false);
	const [round, setRound] = useState(0);

	return (
		<div className="gallery" data-motion={motion ? "slow" : undefined}>
			<header className="gallery-head">
				<h1>Sign-in and setup</h1>
				<p>Every account, access and setup state. “Replay” re-runs the entrance animations.</p>
				<div className="gallery-actions">
					<button type="button" className="primary" onClick={() => setRound((r) => r + 1)}>
						Replay
					</button>
					<ThemeToggle labelled />
					<label className="play-toggle">
						<input type="checkbox" checked={motion} onChange={(e) => setMotion(e.target.checked)} />
						Slow motion
					</label>
					<a className="play-link" href="/play/cards">
						Card gallery
					</a>
					<a className="play-link" href="/play">
						← Playground
					</a>
				</div>
			</header>

			<section>
				<h2>Top bar</h2>
				<div className="gallery-grid auth-gallery-menus">
					{MENUS.map(({ label, me, user }) => (
						<figure key={`${label}-${round}`}>
							<header className="topbar auth-gallery-topbar">
								<span className="people">
									<AccountMenu me={me} user={user} open />
									<Avatar user={personUser(PRIYA)} />
								</span>
								<SignInButton me={me} />
							</header>
							<figcaption>{label}</figcaption>
						</figure>
					))}
				</div>
			</section>

			<section>
				<h2>Sign in and not allowed</h2>
				<div className="gallery-grid auth-gallery-pages">
					<Frame label="Sign in" round={round}>
						<SignInPage me={{ ...base, allowed: false }} />
					</Frame>
					<Frame label="Cancelled on GitHub" round={round}>
						<SignInPage me={{ ...base, allowed: false }} error="denied" />
					</Frame>
					<Frame label="Dev sign-in" round={round}>
						<SignInPage me={{ ...base, allowed: false, devAuth: true }} />
					</Frame>
					<Frame label="Not on the list" round={round}>
						<NotAllowedPage me={{ ...base, viewer: OCTOCAT, allowed: false }} />
					</Frame>
				</div>
			</section>

			<section>
				<h2>Setup</h2>
				<div className="gallery-grid auth-gallery-pages">
					{SETUPS.map(({ label, info, params, installations }) => (
						<Frame key={label} label={label} round={round}>
							<SetupView
								info={info}
								params={new URLSearchParams(params)}
								loadInstallations={installations}
							/>
						</Frame>
					))}
				</div>
			</section>

			<section>
				<h2>Access editor</h2>
				<p className="auth-note">Saving is simulated. Add “ghost” as an admin to see an error.</p>
				<div className="auth-card auth-gallery-editor" key={round}>
					<AccessEditor initial={ACCESS} save={fakeSave} />
				</div>
			</section>
		</div>
	);
}

function Frame({
	label,
	round,
	children,
}: {
	label: string;
	round: number;
	children: React.ReactNode;
}) {
	return (
		<figure>
			<div className="auth-gallery-frame" key={round}>
				{children}
			</div>
			<figcaption>{label}</figcaption>
		</figure>
	);
}
