import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { Me } from "../../shared/auth.ts";
import { Avatar } from "../People.tsx";
import type { User } from "../presence.ts";
import { ThemeMenuRow } from "../ThemeToggle.tsx";
import "./auth.css";
import { GitHubMark } from "./GitHubMark.tsx";
import { devSignInHref, signInHref, signOut } from "./me.ts";

/** "Sign in" in the top bar, for guests when sign-in is available. */
export function SignInButton({ me }: { me: Me }) {
	if (me.viewer || me.signIn !== "ready") return null;
	return (
		<a className="signin-button" href={signInHref()}>
			<GitHubMark />
			Sign in
		</a>
	);
}

/** Your avatar in the top bar, opening a menu: who you are, settings, sign out. */
export function AccountMenu({
	me,
	user,
	label = `${user.name} (you)`,
	open: initiallyOpen = false,
}: AccountMenuProps) {
	const [state, setState] = useState<"open" | "closing" | "closed">(
		initiallyOpen ? "open" : "closed",
	);
	const root = useRef<HTMLSpanElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const menuId = useId();

	const close = (focusTrigger = false) => {
		setState((current) => (current === "open" ? "closing" : current));
		if (focusTrigger) trigger.current?.focus();
	};

	useEffect(() => {
		if (state !== "open") return;
		const onPointer = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) close();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") close(true);
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		root.current?.querySelector<HTMLElement>("[role=menuitem], input")?.focus();
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [state]);

	return (
		<span className="account" ref={root}>
			<button
				ref={trigger}
				type="button"
				className="account-trigger"
				aria-haspopup="menu"
				aria-expanded={state === "open"}
				aria-controls={state === "closed" ? undefined : menuId}
				aria-label={me.viewer ? `Account: ${me.viewer.login}` : "You (guest)"}
				onClick={() => setState(state === "open" ? "closing" : "open")}
			>
				<Avatar user={user} label={label} />
			</button>
			{state !== "closed" && (
				<div
					id={menuId}
					className="account-menu"
					data-state={state}
					onAnimationEnd={() => {
						if (state === "closing") setState("closed");
					}}
				>
					<AccountMenuBody me={me} user={user} />
				</div>
			)}
		</span>
	);
}

interface AccountMenuProps {
	me: Me;
	user: User;
	/** Your avatar's tooltip, e.g. who's following you. */
	label?: string;
	/** Start open (for the gallery). */
	open?: boolean;
}

function AccountMenuBody({ me, user }: { me: Me; user: User }) {
	const [signingOut, setSigningOut] = useState(false);

	if (me.viewer) {
		return (
			<div className="account-menu-items" role="menu" aria-label="Account">
				<div className="account-who">
					<Avatar user={user} />
					<span>
						<strong>{me.viewer.name || me.viewer.login}</strong>
						<span className="account-login">@{me.viewer.login}</span>
					</span>
				</div>
				{me.admin && (
					<a className="account-item" role="menuitem" href="/setup">
						Instance settings
					</a>
				)}
				<ThemeMenuRow />
				<button
					type="button"
					className="account-item"
					role="menuitem"
					disabled={signingOut}
					onClick={() => {
						setSigningOut(true);
						void signOut();
					}}
				>
					{signingOut ? "Signing out…" : "Sign out"}
				</button>
			</div>
		);
	}

	return (
		<>
			<div className="account-menu-items" role="menu" aria-label="Account">
				<div className="account-who">
					<Avatar user={user} />
					<span>
						<strong>{user.name}</strong>
						<span className="account-login">Guest</span>
					</span>
				</div>
				{me.signIn === "ready" && (
					<a className="account-item account-item-github" role="menuitem" href={signInHref()}>
						<GitHubMark />
						Sign in with GitHub
					</a>
				)}
				{me.signIn === "unconfigured" && (
					<>
						<p className="account-note">Sign-in isn’t set up on this instance yet.</p>
						<a className="account-item" role="menuitem" href="/setup">
							Set up Tack
						</a>
					</>
				)}
				{me.signIn === "unavailable" && (
					<p className="account-note">
						Sign-in isn’t available here (this instance has no <code>TACK_SECRET</code>, as on
						previews). You can still use boards as a guest.
					</p>
				)}
				<ThemeMenuRow />
			</div>
			{me.devAuth && <DevSignIn />}
		</>
	);
}

/** Local development only: sign in as anyone, no GitHub needed. */
export function DevSignIn({ returnTo }: { returnTo?: string }) {
	const [login, setLogin] = useState("");
	const onSubmit = (event: FormEvent) => {
		event.preventDefault();
		if (login.trim()) location.href = devSignInHref(login.trim(), returnTo);
	};
	return (
		<form className="dev-signin" onSubmit={onSubmit}>
			<label>
				<span>Dev sign-in</span>
				<input
					value={login}
					onChange={(event) => setLogin(event.target.value)}
					placeholder="any-login"
					autoComplete="off"
					spellCheck={false}
				/>
			</label>
			<button type="submit" disabled={!login.trim()}>
				Go
			</button>
		</form>
	);
}
