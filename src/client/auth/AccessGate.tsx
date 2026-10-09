import { type ReactNode, useEffect } from "react";
import type { Me } from "../../shared/auth.ts";
import { Avatar } from "../People.tsx";
import { BrandMark } from "../BrandMark.tsx";
import { DevSignIn } from "./AccountMenu.tsx";
import "./auth.css";
import { GitHubMark } from "./GitHubMark.tsx";
import { personUser, signInHref, signOut, useMe } from "./me.ts";

/**
 * Shows its children to anyone who may use this instance, and a sign-in or
 * "not allowed" page to everyone else. Until the GitHub App is set up (and
 * on Previews), everyone may.
 */
export function AccessGate({ children }: { children: (me: Me) => ReactNode }) {
	const state = useMe();
	if (state.status === "loading") return <div className="auth-page" aria-busy="true" />;
	const { me } = state;
	if (me.allowed) return children(me);
	return me.viewer ? <NotAllowedPage me={me} /> : <SignInPage me={me} />;
}

const ERRORS: Record<string, string> = {
	denied: "You cancelled on GitHub. No harm done: try again whenever you’re ready.",
	state: "That sign-in took too long or started in another tab. Please try again.",
	unavailable: "Sign-in isn’t available on this instance: it has no TACK_SECRET.",
	not_configured: "Sign-in isn’t set up yet.",
};

/** The page at `/signin`, where failed sign-ins land too. */
export function SignInRoute() {
	const state = useMe();
	const params = new URLSearchParams(location.search);
	const returnTo = params.get("return_to") ?? "/";
	const signedIn = state.status === "ready" && state.me.viewer && state.me.allowed;

	useEffect(() => {
		if (signedIn && !params.has("error")) location.replace(returnTo);
	});

	if (state.status === "loading") return <div className="auth-page" aria-busy="true" />;
	if (state.me.viewer && !state.me.allowed) return <NotAllowedPage me={state.me} />;
	return <SignInPage me={state.me} error={params.get("error")} returnTo={returnTo} />;
}

export function SignInPage({
	me,
	error = null,
	returnTo,
}: {
	me: Me;
	error?: string | null;
	returnTo?: string;
}) {
	const message = error ? (ERRORS[error] ?? `GitHub sign-in didn’t work (${error}).`) : null;
	return (
		<AuthPage>
			<h1>Sign in to Tack</h1>
			<p className="auth-lead">
				Tack uses your GitHub account. You’ll see what GitHub lets you see, and nothing changes on
				GitHub until you push it.
			</p>
			{message && (
				<p className="auth-alert" role="alert">
					{message}
				</p>
			)}
			{me.signIn === "ready" && (
				<a className="auth-button primary" href={signInHref(returnTo)}>
					<GitHubMark size={18} />
					Continue with GitHub
				</a>
			)}
			{me.signIn === "unconfigured" && (
				<>
					<p className="auth-note">This instance doesn’t have its GitHub App yet.</p>
					<a className="auth-button primary" href="/setup">
						Set up Tack
					</a>
				</>
			)}
			{me.signIn === "unavailable" && (
				<p className="auth-note">
					Sign-in needs a <code>TACK_SECRET</code>, which this instance (perhaps a preview) doesn’t
					have.
				</p>
			)}
			{me.devAuth && <DevSignIn returnTo={returnTo} />}
		</AuthPage>
	);
}

export function NotAllowedPage({ me }: { me: Me }) {
	if (!me.viewer) return null;
	return (
		<AuthPage>
			<div className="auth-knock" aria-hidden="true">
				<Avatar user={personUser(me.viewer)} />
				<span className="auth-knock-lock">
					<svg width="14" height="14" viewBox="0 0 14 14">
						<rect x="2.5" y="6" width="9" height="6.5" rx="1.6" />
						<path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6" fill="none" />
					</svg>
				</span>
			</div>
			<h1>This Tack is invite-only</h1>
			<p className="auth-lead">
				You’re signed in as <strong>@{me.viewer.login}</strong>, but this instance is only open to
				people its admins have added. Ask one of them to add you, or an organisation you’re in.
			</p>
			<div className="auth-actions">
				<a className="auth-button primary" href={signInHref()}>
					Check again
				</a>
				<button type="button" className="auth-button" onClick={() => void signOut()}>
					Sign out
				</button>
			</div>
			<p className="auth-note">
				Added to an organisation recently? “Check again” signs you in afresh, which rechecks your
				memberships.
			</p>
		</AuthPage>
	);
}

/** A centred card on the dotted canvas, with the Tack mark. */
export function AuthPage({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
	return (
		<main className="auth-page">
			<section className="auth-card" data-wide={wide}>
				<a className="brand auth-brand" href="/">
					<BrandMark size={30} />
					tack
				</a>
				{children}
			</section>
		</main>
	);
}
