import { type FormEvent, useEffect, useState } from "react";
import {
	type AccessSettings,
	type AccessUpdateResponse,
	type InstallationList,
	type Person,
	type SetupInfo,
	type WebhookHealth,
	manifestFormAction,
} from "../../shared/auth.ts";
import { Avatar } from "../People.tsx";
import { AuthPage } from "./AccessGate.tsx";
import { AiSuggestions } from "./AiSuggestions.tsx";
import { Installations } from "./Installations.tsx";
import { Checklist, SecretHelp, WebhookCheck } from "./SetupChecks.tsx";
import { type Loaded, configuredSteps, firstSteps, isReady } from "./setupChecks.ts";
import "./auth.css";
import { GitHubMark } from "./GitHubMark.tsx";
import { personUser, signInHref } from "./me.ts";

const SETUP_ERRORS: Record<string, string> = {
	state: "Setup took too long, or started in another tab. Please try again.",
	conversion_failed:
		"GitHub didn’t hand over the new app’s credentials. Try again; you can delete the half-made app from your GitHub settings.",
	in_progress: "Setup is already finishing in another tab.",
	already_configured: "This instance already has its GitHub App.",
};

/** `/setup`: create the GitHub App on a fresh instance, then manage access. */
export default function SetupPage() {
	const [info, setInfo] = useState<SetupInfo | null>(null);
	const [failed, setFailed] = useState(false);
	const [round, setRound] = useState(0);

	useEffect(() => {
		fetch("/api/setup", { headers: { accept: "application/json" } })
			.then((response) => response.json() as Promise<SetupInfo>)
			.then(setInfo)
			.catch(() => setFailed(true));
	}, [round]);

	const params = new URLSearchParams(location.search);
	if (failed) {
		return (
			<AuthPage>
				<h1>Couldn’t load setup</h1>
				<p className="auth-lead">Tack’s server didn’t answer. Refresh to try again.</p>
			</AuthPage>
		);
	}
	if (!info) return <div className="auth-page" aria-busy="true" />;
	return (
		<SetupView
			info={info}
			params={params}
			onRecheck={() => {
				setInfo(null);
				setRound((n) => n + 1);
			}}
		/>
	);
}

/** The setup page for a given state; the gallery renders this directly. */
export function SetupView({
	info,
	params,
	loadInstallations,
	loadWebhooks,
	onRecheck,
}: {
	info: SetupInfo;
	params: URLSearchParams;
	/** Where the app is installed (the gallery fakes it). */
	loadInstallations?: () => Promise<InstallationList>;
	/** Whether webhooks arrive (the gallery fakes it). */
	loadWebhooks?: () => Promise<WebhookHealth>;
	/** Ask the server for the page's state again. */
	onRecheck?: () => void;
}) {
	switch (info.status) {
		case "unavailable":
			return <NeedsSecret onRecheck={onRecheck} />;
		case "unconfigured":
			return <CreateApp info={info} error={params.get("error")} />;
		case "configured":
			return (
				<Configured
					info={info}
					params={params}
					loadInstallations={loadInstallations}
					loadWebhooks={loadWebhooks}
				/>
			);
	}
}

function NeedsSecret({ onRecheck }: { onRecheck?: () => void }) {
	return (
		<AuthPage wide>
			<h1>Tack needs a secret first</h1>
			<p className="auth-lead">
				Sign-in and setup are off until this Worker has a <code>TACK_SECRET</code>. Tack uses it to
				sign session cookies and encrypt the GitHub App’s credentials.
			</p>
			<Checklist steps={firstSteps("secret")} />
			<SecretHelp onCheck={onRecheck} />
			<p className="auth-note">Previews never get secrets, so boards there are guest-only.</p>
		</AuthPage>
	);
}

const PERMISSIONS = [
	["Metadata", "read, which GitHub requires"],
	["Issues and pull requests", "read and write, for pushing staged changes"],
	["Code", "read and write, for decision records (ADR pull requests)"],
	[
		"Discussions",
		"read and write, for discussions as cards (labels, closing) and decisions posted back",
	],
	["Checks, statuses, Actions runs", "read, for CI on cards"],
	["Organisation members", "read, for the access list"],
];

function CreateApp({
	info,
	error,
}: {
	info: Extract<SetupInfo, { status: "unconfigured" }>;
	error: string | null;
}) {
	const [owner, setOwner] = useState<"me" | "org">("me");
	const [org, setOrg] = useState("");
	const [name, setName] = useState(info.manifest.name);
	const local = !info.manifest.hook_attributes.active;
	const action = manifestFormAction(owner === "org" ? org.trim() : null, info.state);
	const ready = owner === "me" || org.trim().length > 0;

	return (
		<AuthPage wide>
			<h1>Set up Tack</h1>
			<p className="auth-lead">
				Tack talks to GitHub through a GitHub App that you own. GitHub fills in everything; you just
				confirm. Whoever creates it becomes this instance’s first admin.
			</p>
			<Checklist steps={firstSteps("app")} />
			{error && (
				<p className="auth-alert" role="alert">
					{SETUP_ERRORS[error] ?? `Setup didn’t finish (${error}).`}
				</p>
			)}
			<form id="setup-app" className="setup-form" method="post" action={action}>
				<input
					type="hidden"
					name="manifest"
					value={JSON.stringify({ ...info.manifest, name: name.trim() || info.manifest.name })}
				/>
				<fieldset className="setup-owner">
					<legend>Who owns the app?</legend>
					<div className="segmented" role="radiogroup">
						<label data-checked={owner === "me"}>
							<input
								type="radio"
								name="owner"
								checked={owner === "me"}
								onChange={() => setOwner("me")}
							/>
							My account
						</label>
						<label data-checked={owner === "org"}>
							<input
								type="radio"
								name="owner"
								checked={owner === "org"}
								onChange={() => setOwner("org")}
							/>
							An organisation
						</label>
					</div>
					{owner === "org" && (
						<input
							className="setup-input setup-reveal"
							aria-label="Organisation login"
							placeholder="organisation-login"
							value={org}
							onChange={(event) => setOrg(event.target.value)}
							autoComplete="off"
							spellCheck={false}
							autoFocus
						/>
					)}
				</fieldset>
				<label className="setup-field">
					<span>App name</span>
					<input
						className="setup-input"
						value={name}
						maxLength={34}
						onChange={(event) => setName(event.target.value)}
						spellCheck={false}
					/>
					<small>It has to be unique across GitHub.</small>
				</label>
				<div className="setup-permissions">
					<span>It will ask for</span>
					<ul>
						{PERMISSIONS.map(([what, why]) => (
							<li key={what}>
								<strong>{what}</strong> {why}
							</li>
						))}
					</ul>
				</div>
				{local && (
					<p className="auth-note">
						Running locally: GitHub can’t reach this machine, so the app’s webhooks start switched
						off. Cards still load; live updates need a public URL.
					</p>
				)}
				<button type="submit" className="auth-button primary" disabled={!ready}>
					<GitHubMark size={18} />
					Create GitHub App
				</button>
			</form>
		</AuthPage>
	);
}

function Configured({
	info,
	params,
	loadInstallations,
	loadWebhooks,
}: {
	info: Extract<SetupInfo, { status: "configured" }>;
	params: URLSearchParams;
	loadInstallations?: () => Promise<InstallationList>;
	loadWebhooks?: () => Promise<WebhookHealth>;
}) {
	const installed = params.get("installed");
	const [webhooks, setWebhooks] = useState<Loaded<WebhookHealth>>({ status: "loading" });
	const [installations, setInstallations] = useState<Loaded<InstallationList>>({
		status: "loading",
	});
	const [access, setAccess] = useState(info.access);
	const steps = configuredSteps(webhooks, installations, info.access && access);
	const ready = info.admin && isReady(steps);
	return (
		<AuthPage wide>
			{params.has("created") && (
				<div className="setup-celebrate" role="status">
					<span className="setup-celebrate-pin" aria-hidden="true" />
					<span>
						<strong>Your GitHub App is ready.</strong>{" "}
						{info.admin ? "You’re this instance’s admin. " : ""}Next, install it on the repositories
						you plan with.
					</span>
				</div>
			)}
			{installed && (
				<div className="setup-celebrate" role="status">
					<span className="setup-celebrate-pin" aria-hidden="true" />
					<span>
						{installed === "requested"
							? "Installation requested. An organisation owner needs to approve it on GitHub."
							: "Installed. Cards from those repositories now update live."}
					</span>
				</div>
			)}
			{ready ? (
				<div className="setup-ready" role="status">
					<h1 id="setup-app">Tack is ready</h1>
					<p className="auth-lead">
						Make a board and bring in issues from the repositories you installed it on. You can come
						back here any time to check webhooks, install on more repositories, or let other people
						in.
					</p>
					<div className="auth-actions">
						<a className="auth-button primary" href="/">
							Open your boards
						</a>
						<a className="auth-button" href="#setup-people">
							Let other people in
						</a>
					</div>
				</div>
			) : (
				<>
					<h1 id="setup-app">{info.app.name}</h1>
					<p className="auth-lead">
						This instance’s GitHub App. Install it on repositories to make their cards live (and
						private repositories visible); public repositories work without it.
					</p>
				</>
			)}
			{info.admin && <Checklist steps={steps} />}
			<div className="auth-actions">
				<a className={`auth-button${ready ? "" : " primary"}`} href={info.app.installUrl}>
					<GitHubMark size={18} />
					{ready ? "Install on more repositories" : "Install on repositories"}
				</a>
				<a className="auth-button" href={info.app.htmlUrl}>
					App settings
				</a>
			</div>

			{info.admin && (
				<WebhookCheck
					appSettingsUrl={info.app.htmlUrl}
					load={loadWebhooks}
					onChange={setWebhooks}
				/>
			)}
			{info.admin && (
				<Installations
					installUrl={info.app.installUrl}
					load={loadInstallations}
					onChange={setInstallations}
				/>
			)}

			<h2 id="setup-people">Who can use this instance</h2>
			<p className="auth-note">
				Optional. Admins can always sign in; add people or whole organisations to let them in too.
			</p>
			{!info.viewer && (
				<>
					<p className="auth-note">Sign in as an admin to manage access.</p>
					<a className="auth-button" href={signInHref()}>
						Sign in
					</a>
				</>
			)}
			{info.viewer && !info.admin && (
				<p className="auth-note">Only this instance’s admins can change who can use it.</p>
			)}
			{info.admin && info.access && <AccessEditor initial={info.access} onSaved={setAccess} />}
			{info.ai && <AiSuggestions status={info.ai} />}
		</AuthPage>
	);
}

interface Draft {
	admins: string[];
	users: string[];
	orgs: string[];
}

function draftFrom(access: AccessSettings): Draft {
	return {
		admins: access.admins.map((admin) => admin.login.toLowerCase()),
		users: access.users,
		orgs: access.orgs,
	};
}

export function AccessEditor({
	initial,
	save = saveAccess,
	onSaved,
}: {
	initial: AccessSettings;
	save?: (draft: Draft) => Promise<AccessUpdateResponse>;
	/** Told what was saved, for the setup checklist. */
	onSaved?: (access: AccessSettings) => void;
}) {
	const [saved, setSaved] = useState(initial);
	const [draft, setDraft] = useState(() => draftFrom(initial));
	const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
	const [error, setError] = useState("");
	const dirty = JSON.stringify(draft) !== JSON.stringify(draftFrom(saved));
	const people = new Map(saved.admins.map((admin) => [admin.login.toLowerCase(), admin]));

	const onSave = async () => {
		setStatus("saving");
		try {
			const result = await save(draft);
			if (result.ok) {
				setSaved(result.access);
				setDraft(draftFrom(result.access));
				setStatus("saved");
				onSaved?.(result.access);
			} else {
				setError(accessError(result));
				setStatus("failed");
			}
		} catch {
			setError("Couldn’t save. Check your connection and try again.");
			setStatus("failed");
		}
	};

	const edit = (key: keyof Draft) => (logins: string[]) => {
		setDraft((current) => ({ ...current, [key]: logins }));
		if (status !== "saving") setStatus("idle");
	};

	return (
		<div className="access-editor">
			<LoginList
				title="Admins"
				hint="Can change these settings. They need to have signed in once."
				logins={draft.admins}
				people={people}
				placeholder="Add an admin"
				onChange={edit("admins")}
			/>
			<LoginList
				title="People"
				hint="GitHub users who may sign in."
				logins={draft.users}
				placeholder="Add a GitHub username"
				onChange={edit("users")}
			/>
			<LoginList
				title="Organisations"
				hint="Members may sign in. Checked each time someone signs in."
				logins={draft.orgs}
				placeholder="Add an organisation"
				onChange={edit("orgs")}
			/>
			<div className="access-save" data-visible={dirty || status !== "idle"}>
				{status === "saved" && !dirty ? (
					<span className="access-saved">
						<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
							<path d="M3.5 8.5l3 3 6-7" />
						</svg>
						Saved
					</span>
				) : (
					<>
						{status === "failed" && (
							<span className="access-error" role="alert">
								{error}
							</span>
						)}
						<button
							type="button"
							className="auth-button"
							disabled={!dirty || status === "saving"}
							onClick={() => {
								setDraft(draftFrom(saved));
								setStatus("idle");
							}}
						>
							Discard
						</button>
						<button
							type="button"
							className="auth-button primary"
							disabled={!dirty || status === "saving"}
							onClick={() => void onSave()}
						>
							{status === "saving" ? "Saving…" : "Save changes"}
						</button>
					</>
				)}
			</div>
		</div>
	);
}

function accessError(result: Extract<AccessUpdateResponse, { ok: false }>): string {
	const logins = result.logins.map((login) => `@${login}`).join(", ");
	switch (result.error) {
		case "no_admins":
			return "Keep at least one admin.";
		case "unknown_admins":
			return `${logins} must sign in once before becoming an admin.`;
		case "invalid_login":
			return `${logins} ${result.logins.length === 1 ? "isn’t a GitHub login" : "aren’t GitHub logins"}.`;
	}
}

async function saveAccess(draft: Draft): Promise<AccessUpdateResponse> {
	const response = await fetch("/api/setup/access", {
		method: "PUT",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify(draft),
	});
	if (response.status !== 200 && response.status !== 422) throw new Error(`${response.status}`);
	return (await response.json()) as AccessUpdateResponse;
}

function LoginList({
	title,
	hint,
	logins,
	people,
	placeholder,
	onChange,
}: {
	title: string;
	hint: string;
	logins: string[];
	people?: Map<string, Person>;
	placeholder: string;
	onChange: (logins: string[]) => void;
}) {
	const [input, setInput] = useState("");
	const [fresh, setFresh] = useState<string | null>(null);

	const add = (event: FormEvent) => {
		event.preventDefault();
		const added = input
			.split(/[\s,]+/)
			.map((login) => login.replace(/^@/, "").toLowerCase())
			.filter((login) => login && !logins.includes(login));
		if (added.length > 0) {
			onChange([...logins, ...added]);
			setFresh(added.at(-1) ?? null);
		}
		setInput("");
	};

	return (
		<div className="login-list" role="group" aria-label={title}>
			<div className="login-list-head">
				<h3>{title}</h3>
				<p>{hint}</p>
			</div>
			<ul>
				{logins.map((login) => {
					const person = people?.get(login);
					return (
						<li key={login} className="login-chip" data-new={login === fresh}>
							{person && <Avatar user={personUser(person)} />}@{login}
							<button
								type="button"
								aria-label={`Remove ${login}`}
								onClick={() => onChange(logins.filter((other) => other !== login))}
							>
								<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
									<path d="M2 2l6 6M8 2l-6 6" />
								</svg>
							</button>
						</li>
					);
				})}
				<li className="login-add">
					<form onSubmit={add}>
						<input
							value={input}
							onChange={(event) => setInput(event.target.value)}
							placeholder={placeholder}
							aria-label={placeholder}
							autoComplete="off"
							spellCheck={false}
						/>
					</form>
				</li>
			</ul>
		</div>
	);
}
